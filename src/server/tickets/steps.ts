import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitStep } from '../git/commit';
import { git } from '../git/git';
import { pushBranch } from '../git/push';
import { findMarkers } from '../requests/markers';
import { boundedWait } from './bounded-wait';
import { validateChecklist, type ChecklistError, type Step } from './checklist';
import type { TicketStore } from './store';
import { runDirect, type TicketTestDeps } from './test-queue';
import { KeyedQueue } from '../keyed-queue';

export type StepRefusal =
  | 'out_of_order' | 'no_checklist' | 'no_worktree' | 'note_required' | 'secrets' | 'index_locked' | 'commit_failed'
  | 'validation_failed' | 'no_test_command' | 'docs_empty' | 'already_delivered'
  | 'pending_requests' | 'unanswered_requests' | 'request_unanswered' | 'todo_left' | 'todo_check_failed';

export type StepResult =
  | { status: 'closed'; n: number; total: number; sha?: string; delivered?: boolean; pushed?: boolean; pushNote?: string }
  | { status: 'refused'; code: StepRefusal; detail?: string; tail?: string; files?: string[]; timedOut?: boolean };

/** The bounded wait ended before the step did: the work goes on, ask again with the same step number. */
export type StepRunning = { status: 'running'; n: number; /** The step waits for the machine's test queue: the place of its run (1 = next). */ queue?: number };
interface StepJob { n: number; waiters: number; promise: Promise<StepResult> }

export type ChecklistSetResult =
  | { status: 'ok'; steps: Step[] }
  | { status: 'refused'; code: ChecklistError | 'no_worktree' | 'already_delivered'; detail: string };

export interface StepDeps extends TicketTestDeps {
  /** The per-ticket queue shared by every ticket service of the project; without it the service has its own. */
  queue?: KeyedQueue;
  tickets: TicketStore;
  /** The user switched the tests off for this project: the validation step closes without running anything. */
  testsDisabled?(): boolean;
  /** The place (1 = next) of this agent's validation in the test queue, when it waits. */
  queuePosition?(slug: string): number | undefined;
  secretPatterns(): string[];
  /** Tells the main session (inbox). */
  notifyMain(slug: string, text: string): void;
  /** Something visible changed (progress, blocked flag): the state is pushed to the UI. */
  changed(): void;
  /**
   * A step was closed (after the ticket was updated). `skipped`: closed with skip; `empty`: its commit changed no file. Neither is
   * progress for the loop handling.
   */
  stepClosed?(slug: string, o: { skipped: boolean; empty: boolean }): void;
  /** Open requests addressed to this session: what it still owes an answer to (SPEC 10). */
  debts?(slug: string): string[];
  /** Every request this session made, in any state: their `TODO-<id>` comments must be gone before the ticket is delivered. */
  requestIds?(slug: string): string[];
}

const MIN_STUDY_NOTE = 10;
const MIN_DOCS_NOTE = 10;
const MIN_SKIP_NOTE = 20;
/**
 * A request reaches its recipient as a prompt that enters only once the session is idle, so a refusal in a long turn can name an id whose
 * text the agent has not seen yet (seen in a real run: it answered "unknown" and the request went to the main).
 */
const UNSEEN_TEXT = ' If you have not seen the text of a request, it is waiting to be delivered: end your turn and it arrives as the next message; do not answer unknown for that reason.';
const refuse = (code: StepRefusal, extra: Omit<Extract<StepResult, { status: 'refused' }>, 'status' | 'code'> = {}): StepResult => ({ status: 'refused', code, ...extra });

/**
 * The ticket flow behind `checklist_set`, `step_done` and `report_blocked` (SPEC 8). The console, not the agent, commits, runs the
 * validation and pushes. Calls for one agent are serialised, so a repeated or concurrent `step_done` can never commit twice.
 */
export class StepService {
  private readonly queue: KeyedQueue;
  private readonly jobs = new Map<string, StepJob>();
  private readonly unclaimed = new Map<string, { n: number; result: StepResult }>();

  constructor(private readonly d: StepDeps) { this.queue = d.queue ?? new KeyedQueue(); }

  checklistSet(slug: string, items: string[]): Promise<ChecklistSetResult> {
    return this.queue.run(slug, async () => {
      const wt = this.d.worktreeOf(slug);
      if (!wt) return { status: 'refused', code: 'no_worktree', detail: 'this agent has no worktree' };
      const ticket = this.d.tickets.get(slug);
      if (ticket && ticket.status !== 'in_progress') return { status: 'refused', code: 'already_delivered', detail: 'the ticket was already delivered' };
      const v = validateChecklist(items, ticket?.steps);
      if (!v.ok) return { status: 'refused', code: v.code, detail: v.detail };
      this.d.tickets.setChecklist(slug, v.steps);
      this.writeChecklistFile(slug, wt.worktree, v.steps);
      this.d.changed();
      return { status: 'ok', steps: v.steps };
    });
  }

  /**
   * Closes a step. With `waitMs` the call is bounded: the work (the validation can last tens of minutes) runs as a job that does not
   * depend on this call, and when the wait ends first the answer is `running`; asking again joins the job, and a result nobody was
   * waiting for is kept for the next call. Without `waitMs` it waits for the end, as before.
   */
  stepDone(slug: string, o: { n: number; note?: string; skip?: boolean }): Promise<StepResult>;
  stepDone(slug: string, o: { n: number; note?: string; skip?: boolean }, opts: { waitMs?: number }): Promise<StepResult | StepRunning>;
  async stepDone(slug: string, o: { n: number; note?: string; skip?: boolean }, opts: { waitMs?: number } = {}): Promise<StepResult | StepRunning> {
    const kept = this.unclaimed.get(slug);
    if (kept) {
      this.unclaimed.delete(slug);
      if (kept.n === o.n) return kept.result;
    }
    let job = this.jobs.get(slug);
    if (!job || job.n !== o.n || opts.waitMs === undefined) { // only a bounded call joins: the unbounded one keeps the serial semantics
      const started: StepJob = { n: o.n, waiters: 0, promise: undefined as unknown as Promise<StepResult> };
      started.promise = this.queue.run(slug, () => this.close(slug, o)).then(
        (r) => this.finishJob(slug, started, r),
        () => this.finishJob(slug, started, refuse('commit_failed', { detail: 'the step failed unexpectedly: try again' })),
      );
      this.jobs.set(slug, started);
      job = started;
    }
    job.waiters += 1;
    if (opts.waitMs === undefined) {
      try { return await job.promise; } finally { job.waiters -= 1; }
    }
    try {
      return await boundedWait(job.promise, opts.waitMs, (): StepRunning => {
        const queue = this.d.queuePosition?.(slug);
        return { status: 'running', n: o.n, ...(queue !== undefined ? { queue } : {}) };
      });
    } finally {
      job.waiters -= 1;
    }
  }

  private finishJob(slug: string, job: StepJob, result: StepResult): StepResult {
    if (this.jobs.get(slug) === job) this.jobs.delete(slug);
    if (job.waiters === 0) this.unclaimed.set(slug, { n: job.n, result });
    return result;
  }

  reportBlocked(slug: string, reason: string): void {
    this.d.tickets.block(slug, reason);
    this.d.notifyMain(slug, `Agent "${slug}" is blocked and waiting for you: ${reason}`);
    this.d.changed();
  }

  /** A question was sent for step `n` (SPEC 10): the step stays open and `step_done` goes past it until the answer arrives. */
  markWaiting(slug: string, n: number, w: { requestId: string; to: string }): Promise<{ ok: true } | { ok: false; detail: string }> {
    return this.queue.run(slug, async () => {
      const ticket = this.d.tickets.get(slug);
      if (!ticket || ticket.steps.length === 0) return { ok: false as const, detail: 'save a checklist first (checklist_set)' };
      const step = ticket.steps.find((s) => s.n === n);
      if (!step) return { ok: false as const, detail: `there is no step ${n}` };
      if (step.done) return { ok: false as const, detail: `step ${n} is already closed` };
      if (step.waitingOn) return { ok: false as const, detail: `step ${n} already waits for ${step.waitingOn.requestId}: a step waits for one request, so ask for everything in one message or wait for that answer` };
      if (n >= ticket.steps.length - 1) return { ok: false as const, detail: 'the validation and documentation steps cannot wait for an answer' };
      const updated = this.d.tickets.setWaiting(slug, n, w);
      const wt = this.d.worktreeOf(slug);
      if (wt) this.writeChecklistFile(slug, wt.worktree, updated.steps);
      this.d.changed();
      return { ok: true as const };
    });
  }

  /** The answer arrived: the step is workable again. Returns the step it was on; undefined when none waited for that request. */
  clearWaiting(slug: string, requestId: string): Promise<{ n: number; title: string } | undefined> {
    return this.queue.run(slug, async () => {
      if (!this.d.tickets.get(slug)) return undefined;
      const r = this.d.tickets.clearWaiting(slug, requestId);
      if (!r) return undefined;
      const wt = this.d.worktreeOf(slug);
      if (wt) this.writeChecklistFile(slug, wt.worktree, r.ticket.steps);
      this.d.changed();
      return { n: r.step.n, title: r.step.title };
    });
  }

  private async close(slug: string, o: { n: number; note?: string; skip?: boolean }): Promise<StepResult> {
    const wt = this.d.worktreeOf(slug);
    if (!wt) return refuse('no_worktree', { detail: 'this agent has no worktree' });
    const ticket = this.d.tickets.get(slug);
    if (!ticket || ticket.steps.length === 0) return refuse('no_checklist', { detail: 'call checklist_set first' });
    if (ticket.status !== 'in_progress') return refuse('already_delivered', { detail: 'every step is closed and the branch was delivered' });
    // A step that waits for an answer is gone past: the agent works on the next one (SPEC 10).
    const next = ticket.steps.find((s) => !s.done && !s.waitingOn);
    if (!next || next.n !== o.n) return refuse('out_of_order', { detail: next ? `the next open step is ${next.n}` : 'every step is closed' });

    const total = ticket.steps.length;
    const note = (o.note ?? '').trim();
    const isValidation = o.n === total - 1;
    const isDocs = o.n === total;

    if (o.skip) {
      if (isValidation) return refuse('validation_failed', { detail: 'the validation step cannot be skipped' });
      if (note.length < MIN_SKIP_NOTE) return refuse('note_required', { detail: `skipping a step needs a written reason of at least ${MIN_SKIP_NOTE} characters` });
    } else if (o.n === 1 && note.length < MIN_STUDY_NOTE) {
      return refuse('note_required', { detail: 'step 1 needs a note with what you found (files, conventions, risks)' });
    }

    // Requests (SPEC 10): the last two steps cannot close with a question open, and a comment of an answered request cannot stay.
    const owed = this.d.debts?.(slug) ?? [];
    if (isValidation || isDocs) {
      const waiting = ticket.steps.filter((s) => s.waitingOn);
      if (waiting.length > 0) {
        return refuse('pending_requests', { detail: `these steps still wait for an answer: ${waiting.map((s) => `${s.n} (${s.waitingOn!.requestId})`).join(', ')}. Go on with the other steps; the console messages you when an answer arrives. If only waiting steps are left, end your turn.` });
      }
      if (owed.length > 0) return refuse('unanswered_requests', { detail: `answer these requests first with send_message: ${owed.join(', ')}.${UNSEEN_TEXT}` });
    }
    const owedHere = owed.filter((id) => next.title.includes(id));
    if (owedHere.length > 0) return refuse('request_unanswered', { detail: `${owedHere.join(', ')} is still open: reply with send_message (type answer or unknown) before closing this step.${UNSEEN_TEXT}` });
    const markerIds = isDocs ? (this.d.requestIds?.(slug) ?? []) : (next.resolved ?? []);
    if (markerIds.length > 0) {
      const hits = await findMarkers(wt.worktree, markerIds);
      if (hits === undefined) return refuse('todo_check_failed', { detail: 'the console could not search the worktree for the TODO comments: try again in a moment' });
      if (hits.length > 0) {
        return refuse('todo_left', {
          files: hits.map((h) => `${h.file}:${h.line}`),
          detail: `these comments are still in the code: ${[...new Set(hits.map((h) => h.id))].join(', ')}. Finish the code each one stands for and remove the comment`,
        });
      }
    }

    if (isValidation && this.d.testsDisabled?.() !== true) {
      const command = this.d.testCommand(wt.worktree)?.trim();
      if (!command) {
        const repo = ticket.repo;
        return refuse('no_test_command', {
          detail: repo
            ? `no test command was set for the project, and none was detected in the repository ${repo} (no pom.xml, build.gradle or package.json test script): ask the main to set one in the console options`
            : 'the project has no test command: ask the main to set it in the console options',
        });
      }
      const v = await (this.d.runTests ?? runDirect)({ cwd: wt.worktree, command, timeoutMs: this.d.testTimeoutMs(), owner: slug, watchOwner: true });
      if (!v.ok) return refuse('validation_failed', { tail: v.tail, ...(v.timedOut ? { timedOut: true, detail: 'the test command timed out and was stopped' } : v.cancelled ? { detail: 'the test run was cancelled' } : { detail: `the test command exited with code ${v.code}` }) });
    }

    if (isDocs && !o.skip && note.length < MIN_DOCS_NOTE) {
      const status = await git(wt.worktree, ['status', '--porcelain']);
      if (status.stdout.trim() === '') return refuse('docs_empty', { detail: `the documentation step needs a change, or a note of at least ${MIN_DOCS_NOTE} characters saying why none is needed` });
    }

    // A crash between the commit and the ticket update leaves the commit in git but the step open: adopt it instead of committing twice.
    const adopted = await this.existingCommit(wt.worktree, o.n, total, next.title, slug);
    const commit = adopted ?? await commitStep({
      worktree: wt.worktree, n: o.n, total, title: next.title, slug, project: this.d.project, secretPatterns: this.d.secretPatterns(),
    });
    if (!commit.ok) {
      if (commit.code === 'secrets') return refuse('secrets', { files: commit.files, detail: 'these files look like secrets and were left out: remove them or add them to .gitignore' });
      if (commit.code === 'index_locked') return refuse('index_locked', { detail: 'git is busy (index.lock): try again in a moment' });
      return refuse('commit_failed', { detail: commit.detail });
    }

    const updated = this.d.tickets.markDone(slug, o.n, { note: note || undefined, sha: commit.sha, skipped: o.skip });
    if (updated.blocked) this.d.tickets.unblock(slug);
    if (this.d.stepClosed) {
      const empty = await this.emptyCommit(wt.worktree);
      try { this.d.stepClosed(slug, { skipped: o.skip === true, empty }); } catch { /* the step is closed whatever the loop bookkeeping does */ }
    }
    this.writeChecklistFile(slug, wt.worktree, updated.steps);

    if (!isDocs) {
      this.d.changed();
      return { status: 'closed', n: o.n, total, sha: commit.sha };
    }
    const push = await pushBranch({ worktree: wt.worktree, branch: wt.branch });
    this.d.tickets.move(slug, 'delivered', { deliveredSha: commit.sha });
    const pushText = !push.ok ? `push failed (${push.detail})` : 'skipped' in push ? 'not pushed (no remote configured)' : 'pushed to origin';
    this.d.notifyMain(slug, `Ticket "${slug}" delivered: branch ${wt.branch}, ${total} commits, ${pushText}. Review is next.`);
    this.d.changed();
    return {
      status: 'closed', n: o.n, total, sha: commit.sha, delivered: true,
      pushed: push.ok && !('skipped' in push), ...(push.ok ? ('skipped' in push ? { pushNote: 'no_remote' } : {}) : { pushNote: push.detail }),
    };
  }

  /** The tip commit has the same tree as its parent (it changed no file). A root commit, or git failing, counts as not empty. */
  private async emptyCommit(worktree: string): Promise<boolean> {
    const trees = await git(worktree, ['rev-parse', 'HEAD^{tree}', 'HEAD~1^{tree}']);
    if (trees.code !== 0) return false;
    const [head, parent] = trees.stdout.trim().split(/\r?\n/);
    return head !== undefined && head !== '' && head === parent;
  }

  /** The console's own commit for this very step, if it is already the tip of the branch. */
  private async existingCommit(worktree: string, n: number, total: number, title: string, slug: string): Promise<{ ok: true; sha: string } | undefined> {
    const head = await git(worktree, ['log', '-1', '--format=%H%n%s%n%b']);
    if (head.code !== 0) return undefined;
    const [sha, subject, ...body] = head.stdout.split(/\r?\n/);
    const expected = `step ${n}/${total}: ${title.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
    return sha && subject === expected && body.join('\n').includes(`Agent: ${slug}`) ? { ok: true, sha } : undefined;
  }

  /** The checklist as a file in the worktree (SPEC 8.4): it survives a compaction of the agent's context. */
  private writeChecklistFile(slug: string, worktree: string, steps: Step[]): void {
    const lines = steps.map((s) => `- [${s.done ? 'x' : ' '}] ${s.n}. ${s.title}${s.skipped ? ' (skipped)' : ''}${s.waitingOn ? ` (waiting for ${s.waitingOn.requestId} (${s.waitingOn.to}))` : ''}${s.note ? ` — ${s.note.replace(/\s+/g, ' ')}` : ''}`);
    try {
      mkdirSync(join(worktree, '.andromedaconsole'), { recursive: true });
      writeFileSync(join(worktree, '.andromedaconsole', 'checklist.md'), `---\nticket: ${slug}\n---\n${lines.join('\n')}\n`, 'utf8');
    } catch { /* the ticket store is the record; the file is a convenience for the agent */ }
  }
}
