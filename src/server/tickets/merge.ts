import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from '../../shared/guards';
import type { Translate } from '../../shared/i18n';
import type { AgentGit } from '../agents/registry';
import { git } from '../git/git';
import { worktreesDirFor } from '../git/worktree';
import { changedFiles, ensureProjectWorktree, keepProjectOutsideOwnWork, mergeIntoProject, resetTo, startMergeForAuthor, withProjectLock } from '../git/merge';
import { commonDir, removeWorktree } from '../git/worktree';
import { afterGate, ownWorkBase, type AfterRefusal } from './after-gate';
import { boundedWait } from './bounded-wait';
import { squashMessage } from './report';
import type { TicketStore } from './store';
import { runDirect, type TestRunner } from './test-queue';

export interface MergeDeps {
  tickets: TicketStore;
  /** The project folder: its state lives here. It is also the repository of an agent that has none of its own (a project folder that is a repo). */
  root: string;
  project: string;
  worktreeOf(slug: string): AgentGit | undefined;
  /** The command for a run in `cwd`: the repository's project worktree, where the merge is tested, of the ticket's repository `repo`. */
  testCommand(cwd?: string, repo?: string): string | undefined;
  /** The user switched the tests off for this project (the commit message then says so instead of "n/a"). */
  testsDisabled?(): boolean;
  testTimeoutMs(): number;
  /** Runs a test command through the machine's test queue (default: straight away). */
  runTests?: TestRunner;
  /** A ticket was merged into the project branch (the central full run batches after the merges). */
  merged?(slug: string): void;
  /** Project option: one commit per ticket (default) or the step commits behind a merge commit. */
  squash(): boolean;
  language(): { lang: string; t: Translate };
  authorAlive(slug: string): boolean;
  notifyMain(text: string): void;
  /** Written as coming from the main (P8). */
  notifyAuthor(slug: string, text: string): void;
  /** The ticket cannot go on by itself: put the decision in the user's queue. */
  needsUser(slug: string, reason: string): void;
  /** Ends the session of a ticket that is finished (merged), so its folder can be removed. */
  finishAgent(slug: string): Promise<void>;
}

/** What the cleanup after a merge could not remove (SPEC 9.7), in this order. */
export const CLEANUP_ITEMS = ['session', 'worktree', 'branch'] as const;
export type CleanupItem = typeof CLEANUP_ITEMS[number];

export type MergeResult =
  | { status: 'merged'; sha: string; cleanup?: { incomplete: CleanupItem[] } }
  | { status: 'conflict'; files: string[] }
  | { status: 'tests_failed'; tail: string }
  | { status: 'refused'; code: 'not_approved' | 'no_worktree' | 'author_moved' | 'project_branch_checked_out' | 'git_failed'; detail?: string }
  /** Started after another agent whose ticket is not merged yet (`spawn_agent after`): refused at once, no job is started. */
  | { status: 'refused'; code: AfterRefusal['code']; params: AfterRefusal['params']; detail: string }
  /** The bounded wait ended before the merge did: the merge goes on, ask again. */
  | { status: 'running' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `merge_ticket` (SPEC 15.4): one ticket at a time into the project branch. What is merged is exactly what was reviewed; a conflict or a
 * red test run after the merge always leaves the project branch where it was and sends the ticket back; nothing is ever forced.
 */
export class MergeService {
  private chain: Promise<unknown> = Promise.resolve();
  private active = 0;
  private readonly jobs = new Map<string, Promise<MergeResult>>();
  /** The last answer of each ticket's job and the ticket status it left behind: a repeated call gets it while that status holds. */
  private readonly outcomes = new Map<string, { result: MergeResult; status: string }>();

  constructor(private readonly d: MergeDeps) {}

  /**
   * Merges a ticket as a job detached from the call (git merge, the project's tests and the cleanup can outlast an HTTP request). With
   * `waitMs` the call answers `running` when the wait ends first; a repeated call joins the job, and a ticket already merged answers
   * `merged` with its sha from the ticket itself, without git (so it is also true after a restart).
   */
  mergeTicket(slug: string, opts: { waitMs?: number } = {}): Promise<MergeResult> {
    const job = this.jobs.get(slug) ?? this.answered(slug) ?? this.gated(slug);
    return opts.waitMs === undefined ? job : boundedWait(job, opts.waitMs, (): MergeResult => ({ status: 'running' }));
  }

  /**
   * A ticket started after another one waits for that one's merge (SPEC 15.4): the gate answers before any job starts, so a refusal
   * never queues behind other merges. While the gate is checked the call stands as the ticket's job, so a second call joins it.
   */
  private gated(slug: string): Promise<MergeResult> {
    const ticket = this.d.tickets.get(slug);
    if (ticket?.after === undefined) return this.start(slug);
    const pending: Promise<MergeResult> = afterGate(this.d, ticket).then(
      (refused): MergeResult | Promise<MergeResult> => {
        if (this.jobs.get(slug) === pending) this.jobs.delete(slug);
        return refused ? { status: 'refused', code: refused.code, params: refused.params, detail: refused.detail } : this.start(slug);
      },
      (e: unknown): MergeResult => {
        if (this.jobs.get(slug) === pending) this.jobs.delete(slug);
        return { status: 'refused', code: 'git_failed', detail: errorMessage(e) }; // the gate could not be checked: never merge past it
      },
    );
    this.jobs.set(slug, pending);
    return pending;
  }

  /** Merges asked for and not finished yet (running or waiting for their turn). */
  inFlight(): number { return this.active; }

  /** The answer the ticket already holds: merged, or the last job's answer while the ticket is still where that job left it. */
  private answered(slug: string): Promise<MergeResult> | undefined {
    const ticket = this.d.tickets.get(slug);
    const kept = this.outcomes.get(slug);
    if ((ticket?.status === 'merged' || ticket?.status === 'released') && ticket.mergedSha) { // a released ticket was merged first
      const same = kept?.result.status === 'merged' && kept.result.sha === ticket.mergedSha;
      return Promise.resolve(same ? kept.result : { status: 'merged', sha: ticket.mergedSha });
    }
    // An approved ticket is always merged again: a refusal (the author moved, git failed) may be gone by now.
    if (kept && ticket && ticket.status !== 'approved' && ticket.status === kept.status) return Promise.resolve(kept.result);
    this.outcomes.delete(slug);
    return undefined;
  }

  private start(slug: string): Promise<MergeResult> {
    const locked = () => withProjectLock(this.repoOf(this.d.worktreeOf(slug)), () => this.merge(slug));
    this.active += 1;
    const run = this.chain.then(locked, locked);
    this.chain = run.catch(() => undefined);
    const job = run
      .catch((e: unknown): MergeResult => ({ status: 'refused', code: 'git_failed', detail: errorMessage(e) })) // nobody may be waiting: never a stray rejection
      .then((result) => {
        this.jobs.delete(slug);
        this.active -= 1;
        const status = this.d.tickets.get(slug)?.status;
        if (status) this.outcomes.set(slug, { result, status });
        return result;
      });
    this.jobs.set(slug, job);
    return job;
  }

  /** The repository of an agent: its own when it has one, else the project folder. */
  private repoOf(a: { repo?: string } | undefined): string { return a?.repo ?? this.d.root; }

  private async merge(slug: string): Promise<MergeResult> {
    const ticket = this.d.tickets.get(slug);
    if (!ticket || ticket.status !== 'approved' || !ticket.deliveredSha) return { status: 'refused', code: 'not_approved' };
    const author = this.d.worktreeOf(slug);
    if (!author) return { status: 'refused', code: 'no_worktree' };
    const repo = this.repoOf(author);
    const tip = await git(repo, ['rev-parse', `refs/heads/${author.branch}`]);
    if (tip.code !== 0 || tip.stdout.trim() !== ticket.deliveredSha) {
      return { status: 'refused', code: 'author_moved', detail: `reviewed ${ticket.deliveredSha.slice(0, 7)}, the branch is at ${tip.stdout.trim().slice(0, 7)}` };
    }
    const project = await ensureProjectWorktree(repo, this.d.project, worktreesDirFor(this.d.root, repo));
    if (!project.ok) return { status: 'refused', code: project.code, detail: project.detail };
    const before = (await git(project.path, ['rev-parse', 'HEAD'])).stdout.trim();
    // A crash after the merge commit and before the ticket update leaves the ticket `approved` with its commit already on the project
    // branch: adopt that commit instead of merging the same work twice.
    const adopted = await this.alreadyMerged(project.path, slug);
    if (adopted) {
      // The tests of the merge may never have run (that is what a crash there looks like): run them before accepting it.
      const adoptedCommand = this.d.testCommand(project.path, ticket.repo)?.trim();
      if (adoptedCommand) {
        const run = await (this.d.runTests ?? runDirect)({ cwd: project.path, command: adoptedCommand, timeoutMs: this.d.testTimeoutMs(), owner: slug });
        if (!run.ok) {
          if ((await git(project.path, ['rev-parse', 'HEAD'])).stdout.trim() === adopted) await resetTo(project.path, `${adopted}^`);
          return this.testsFailed(slug, run.tail);
        }
      }
      return this.completeMerge(slug, author, adopted);
    }

    // A ticket started after another one: only its own commits count (the other agent's work came in through its own merge).
    const base = await ownWorkBase(repo, this.d.project, ticket, ticket.deliveredSha);
    const files = (await changedFiles(repo, base ?? `project/${this.d.project}`, ticket.deliveredSha)) ?? [];
    const { lang, t } = this.d.language();
    const message = squashMessage({
      slug, project: this.d.project, branch: author.branch, goal: ticket.goal, steps: ticket.steps, files, tests: ticket.tests, testsInhibited: this.d.testsDisabled?.() === true,
      verdicts: ticket.verdicts, lang, t,
    });
    const merged = await mergeIntoProject({ wt: project.path, sha: ticket.deliveredSha, message, squash: this.d.squash(), ...(base !== undefined ? { base } : {}) });
    if (!merged.ok) {
      if (merged.kind === 'conflict') return await this.conflict(slug, merged.files, author.worktree, base !== undefined ? { base, delivered: ticket.deliveredSha } : undefined);
      return { status: 'refused', code: 'git_failed', detail: merged.detail };
    }

    const command = this.d.testCommand(project.path, ticket.repo)?.trim();
    if (command) {
      const run = await (this.d.runTests ?? runDirect)({ cwd: project.path, command, timeoutMs: this.d.testTimeoutMs(), owner: slug });
      if (!run.ok) {
        await resetTo(project.path, before); // the merge turned the tests red: it never happened
        return this.testsFailed(slug, run.tail);
      }
    }
    return this.completeMerge(slug, author, merged.sha);
  }

  private async completeMerge(slug: string, author: AgentGit, sha: string): Promise<MergeResult> {
    this.d.tickets.move(slug, 'merged', { mergedSha: sha });
    try { this.d.merged?.(slug); } catch { /* the central run is a courtesy: the merge is done */ }
    const left = await this.cleanUp(slug, author);
    const what: Record<CleanupItem, string> = { session: 'the agent\'s session', worktree: `its folder ${author.worktree}`, branch: `its local branch ${author.branch}` };
    const leftText = left.length > 0 ? ` Not cleaned up: ${left.map((i) => what[i]).join(', ')}; the work is safe on the project branch.` : '';
    this.d.notifyMain(`Ticket "${slug}" was merged into project/${this.d.project} (${sha.slice(0, 7)}).${leftText} Next: merge the other approved tickets, then propose_release.`);
    return { status: 'merged', sha, ...(left.length > 0 ? { cleanup: { incomplete: left } } : {}) };
  }

  /** The console's own commit for this ticket (its `Ticket:` and `Agent:` trailers) if it is already on the project branch. */
  private async alreadyMerged(projectWorktree: string, slug: string): Promise<string | undefined> {
    const r = await git(projectWorktree, ['log', '-1', '--format=%H', '-E', `--grep=^Ticket: ${slug}$`, `--grep=^Agent: ${slug}$`, '--all-match']);
    const sha = r.stdout.trim();
    return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  }

  private async conflict(slug: string, files: string[], authorWorktree: string, own?: { base: string; delivered: string }): Promise<MergeResult> {
    this.d.tickets.move(slug, 'conflict');
    if (!this.d.authorAlive(slug)) {
      this.d.tickets.move(slug, 'needs_user');
      this.d.needsUser(slug, 'conflict_author_gone');
      this.d.notifyMain(`Ticket "${slug}" conflicts with the project branch in ${files.join(', ')} and its author is gone: a decision is in the user's queue.`);
      return { status: 'conflict', files };
    }
    // The console puts the author's folder in the conflict state; the author edits the files and closes its steps.
    const projectBranch = `project/${this.d.project}`;
    const unmerged = await startMergeForAuthor(authorWorktree, projectBranch);
    // A ticket started after another one: the files it never touched take the project branch's version, so the author edits only the
    // files it really shares with other work (never the other agent's files, nor a stale copy of them).
    const left = own ? await keepProjectOutsideOwnWork({ cwd: authorWorktree, projectBranch, ...own, unmerged }) : unmerged;
    const named = left.length > 0 ? left : files;
    const reopened = this.d.tickets.reopen(slug, { firstStep: 'Resolve merge conflicts' });
    this.d.notifyAuthor(slug, [
      `Message from the main about your ticket "${slug}": it is approved, but it conflicts with work already merged into the project branch, in:`,
      ...named.map((f) => `- ${f}`),
      'The console has started the merge in your folder: the conflict markers (<<<<<<<, =======, >>>>>>>) are in those files. Edit them so that both sides\' intent is kept, then close the steps in order with step_done.',
      `Your checklist has three new steps ("Resolve merge conflicts (round ${reopened.round})", "Validation (round ${reopened.round})", "Update documentation (round ${reopened.round})"). The console will deliver the branch again and it will be reviewed again.`,
    ].join('\n'));
    this.d.notifyMain(`Ticket "${slug}" conflicts with the project branch in ${files.join(', ')}: sent back to its author to resolve (rework ${reopened.round}). The project branch is unchanged.`);
    return { status: 'conflict', files };
  }

  private testsFailed(slug: string, tail: string): MergeResult {
    this.d.tickets.move(slug, 'changes_requested');
    if (!this.d.authorAlive(slug)) {
      this.d.tickets.move(slug, 'needs_user');
      this.d.needsUser(slug, 'merge_tests_failed_author_gone');
      this.d.notifyMain(`Merging ticket "${slug}" turned the tests red and its author is gone: undone, and a decision is in the user's queue.`);
      return { status: 'tests_failed', tail };
    }
    const reopened = this.d.tickets.reopen(slug);
    this.d.notifyAuthor(slug, [
      `Message from the main about your ticket "${slug}": it is approved, but when the console merged it into the project branch the tests failed, so the merge was undone. Output of the test command:`,
      tail.trim().slice(-1500),
      `Your checklist has three new steps ("Review fixes (round ${reopened.round})", "Validation (round ${reopened.round})", "Update documentation (round ${reopened.round})"). Fix the cause, close them in order with step_done, and the console will deliver the branch again.`,
    ].join('\n'));
    this.d.notifyMain(`Merging ticket "${slug}" turned the tests red: undone, project branch unchanged, ticket sent back to its author (rework ${reopened.round}).`);
    return { status: 'tests_failed', tail };
  }

  /** After the merge (SPEC 9.7): end the session, remove the worktree and the local branch; the remote branch stays. Returns what is left. */
  private async cleanUp(slug: string, author: AgentGit): Promise<CleanupItem[]> {
    const repo = this.repoOf(author);
    const left = new Set<CleanupItem>();
    try { await this.d.finishAgent(slug); } catch { left.add('session'); }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await removeWorktree(repo, author.worktree);
        break;
      } catch {
        if (attempt === 4) left.add('worktree'); // the folder may still be held for a moment by the process that just ended
        else await sleep(300);
      }
    }
    const branch = await git(repo, ['branch', '-D', author.branch]);
    if (branch.code !== 0 && (await git(repo, ['rev-parse', '-q', '--verify', `refs/heads/${author.branch}`])).code === 0) left.add('branch');
    try { rmSync(join(await commonDir(repo), 'console-hooks', slug), { recursive: true, force: true }); } catch { left.add('worktree'); } // the worktree's push hook
    return CLEANUP_ITEMS.filter((i) => left.has(i));
  }
}
