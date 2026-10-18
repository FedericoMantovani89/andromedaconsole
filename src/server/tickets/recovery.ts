import { raisedLimit } from '../budget/answers';
import { budgetTokens, type Ledger } from '../budget/ledger';
import { git } from '../git/git';
import { canMove } from './flow';
import type { Ticket, TicketStore } from './store';
import { runDirect, type TicketTestDeps } from './test-queue';
import { KeyedQueue } from '../keyed-queue';
import { errorMessage } from '../../shared/guards';

export const MAX_RECOVERIES = 2;
export const REMEDIES = ['split', 'exclude_paths', 'change_model', 'remove_obstacle', 'raise_budget'] as const;
export type Remedy = (typeof REMEDIES)[number];
export interface RecoveryReport { verifiedSteps: number[]; diagnosis: string; remedy: Remedy; notes?: string }

export interface RecoveryFacts {
  checklist: { n: number; title: string; done: boolean; waitingOn?: { requestId: string; to: string } }[];
  commits: string[];
  diffStat: string;
  handover?: string;
  testsOk: boolean | undefined;
  testTail?: string;
  heaviestTurns: { turn: number; tokens: number; tools: string[] }[];
  repeatedTools: { tool: string; count: number }[];
  cause: 'budget' | 'loop';
}

/** A step line of the checklist as the recovery texts print it (a step waiting for an answer says so). */
const stepLine = (s: { n: number; title: string; done: boolean; waitingOn?: { requestId: string; to: string } }): string =>
  `  ${s.n}. [${s.done ? 'x' : ' '}] ${s.title}${s.waitingOn ? ` (waiting for ${s.waitingOn.requestId} (${s.waitingOn.to}))` : ''}`;

type SpawnResult = { ok: true } | { ok: false; code: string; detail?: string };

export interface RecoveryDeps extends TicketTestDeps {
  /** The per-ticket queue shared by every ticket service of the project; without it the service has its own. */
  queue?: KeyedQueue;
  tickets: TicketStore;
  ledger: Ledger;
  /** The project folder: with `project` it scopes the ledger (agent names repeat across projects). */
  root: string;
  /** Starts the read-only recovery session through the normal spawn flow, on a detached checkout of `sha`. */
  spawnRecovery(r: { slug: string; ticket: string; sha: string; goal: string; model?: string }): Promise<SpawnResult>;
  /** Starts the new agent that takes the ticket over: `from`'s worktree goes, the new one checks out `from`'s branch. */
  spawnReplacement(r: { slug: string; profile: string; goal: string; model?: string; budget?: number; from: string }): Promise<SpawnResult>;
  /** Every agent name already used in the project. */
  existingSlugs(): string[];
  notifyMain(text: string): void;
  /** Puts a decision in the user's queue (kind `decision`); `onAnswer` runs with the chosen option code. */
  askUser(q: { text: string; options: string[]; payload: unknown }, onAnswer: (answer: string) => void): void;
  /** The recovery has reported: end its session a moment later and remove its checkout. */
  endRecovery(slug: string): void;
  budget: { restart(slug: string, limit: number): void; usage(slug: string): { used: number; limit: number } | undefined };
  /** The profile of the agent that owned the ticket (the replacement gets the same one). */
  profileOf(ticket: string): string;
  /**
   * The handover note the stopped agent left in its worktree (`.andromedaconsole/handover.md`), read before its folder goes; undefined when it
   * wrote none. Absent: the ticket's recorded note is used as it is.
   */
  readHandover?(slug: string): string | undefined;
  /** The ticket record moved from `from` to `to` (a replacement, or its undo after a failed start): what names the agent follows. */
  renamed?(from: string, to: string): void;
  changed(): void;
}

export type StartRecoveryResult =
  | { ok: true; recovery: string; attempt: number }
  | { ok: false; code: 'not_stopped' | 'too_many' | 'no_worktree' | 'spawn_failed' | 'no_test_command'; detail?: string };
export type RecoveryReportResult =
  | { ok: true; ticket: string; outcome: 'restarted' | 'asked_user' | 'needs_user' }
  | { ok: false; code: 'not_recovery' | 'bad_request'; detail?: string };
export type RestartResult = { ok: true; agent: string } | { ok: false; code: 'not_stopped' | 'spawn_failed'; detail?: string };

type StopStatus = 'suspended_budget' | 'blocked';
const STOPPED: readonly string[] = ['suspended_budget', 'blocked'];
const MAX_SLUG = 40;
const MAX_DIAGNOSIS = 4000;
const MAX_NOTES = 4000;
const MAX_STEPS = 200;
const HEAVIEST = 5;
const REPEATED_OVER = 5;

const fit = (base: string, suffix: string): string => `${base.slice(0, MAX_SLUG - suffix.length).replace(/-+$/, '')}${suffix}`;

/** `recover-<ticket>`, then `-r2`, `-r3`... when taken; never longer than 40 characters and always a valid slug (like reviewer names). */
export function recoverySlugFor(ticket: string, taken: readonly string[]): string {
  const first = fit(`recover-${ticket}`, '');
  if (!taken.includes(first)) return first;
  for (let n = 2; ; n++) {
    const candidate = fit(`recover-${ticket}`, `-r${n}`);
    if (!taken.includes(candidate)) return candidate;
  }
}

/** The agent that takes a ticket over: the ticket's base name (without an earlier `-rN`) suffixed `-r2`, `-r3`... */
export function replacementSlugFor(ticket: string, taken: readonly string[]): string {
  const base = ticket.replace(/-r\d+$/, '');
  for (let n = 2; ; n++) {
    const candidate = fit(base, `-r${n}`);
    if (!taken.includes(candidate) && candidate !== ticket) return candidate;
  }
}

/**
 * Whether a replacement can start (SPEC 16.5: same branch). With worktrees on it needs the stopped agent's worktree, whose branch it
 * checks out: without it the new agent would start on a NEW branch while its prompt says "same branch", so it is refused. With
 * worktrees off agents share the project folder and there is nothing to check out.
 */
export function replacementCheckout(worktrees: boolean, old: { worktree: string; branch: string } | undefined): { ok: true } | { ok: false; code: 'no_worktree' } {
  return worktrees && !old ? { ok: false, code: 'no_worktree' } : { ok: true };
}

const causeOf = (t: Ticket): 'budget' | 'loop' =>
  t.stopCause === 'loop' ? 'loop' : t.stopCause === 'budget' ? 'budget' : t.status === 'blocked' ? 'loop' : 'budget';

/** What the console knows about a stopped ticket: git, its own test run on the WIP and the ledger. Nothing comes from a model. */
export async function recoveryFacts(d: Pick<RecoveryDeps, 'tickets' | 'ledger' | 'root' | 'project' | 'worktreeOf' | 'testCommand' | 'testTimeoutMs' | 'runTests'>, slug: string): Promise<RecoveryFacts> {
  const t = d.tickets.get(slug);
  if (!t) throw new Error('ticket.missing');
  const wt = d.worktreeOf(slug);
  if (!wt) throw new Error('no_worktree');
  const log = await git(wt.worktree, ['log', '-n', '50', '--format=%h %s', `project/${d.project}..HEAD`]);
  const stat = await git(wt.worktree, ['diff', '--stat', `project/${d.project}...HEAD`]);
  const command = d.testCommand()?.trim();
  const run = command ? await (d.runTests ?? runDirect)({ cwd: wt.worktree, command, timeoutMs: d.testTimeoutMs(), owner: slug }) : undefined;

  const entries = d.ledger.entries({ agent: slug, scope: { project: d.project, root: d.root } });
  const heaviestTurns = entries
    .map((e) => ({ turn: e.turn, tokens: budgetTokens(e), tools: [...new Set(e.tools)] }))
    .sort((a, b) => b.tokens - a.tokens || a.turn - b.turn)
    .slice(0, HEAVIEST);
  const seen = new Map<string, number>();
  for (const e of entries) for (const tool of new Set(e.tools)) seen.set(tool, (seen.get(tool) ?? 0) + 1);
  const repeatedTools = [...seen].filter(([, count]) => count > REPEATED_OVER).map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));

  return {
    checklist: t.steps.map((s) => ({ n: s.n, title: s.title, done: s.done, ...(s.waitingOn ? { waitingOn: s.waitingOn } : {}) })),
    commits: log.code === 0 ? log.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [],
    diffStat: stat.code === 0 ? stat.stdout.trim().slice(0, 4000) : '',
    ...(t.handover ? { handover: t.handover } : {}),
    testsOk: run?.ok,
    ...(run && !run.ok ? { testTail: run.tail.trim().slice(-1500) } : {}),
    heaviestTurns, repeatedTools, cause: causeOf(t),
  };
}

/** What the recovery agent is told first (English: it is a prompt, not interface text). */
export function recoveryGoal(i: { ticket: string; project: string; attempt: number; sha: string; goal?: string; facts: RecoveryFacts }): string {
  const f = i.facts;
  const tests = f.testsOk === undefined ? 'unknown (no test command, nothing was run)' : f.testsOk ? 'PASSED' : 'FAILED';
  const lines = [
    `Recover the ticket "${i.ticket}" of the project "${i.project}" (recovery attempt ${i.attempt} of ${MAX_RECOVERIES}). Its agent was stopped by ${f.cause === 'budget' ? 'its token budget (budget stop)' : 'the loop detector (a loop block)'}. You are read-only: change nothing, run nothing that writes.`,
    '',
    `Objective the main wrote for the stopped agent:\n${i.goal?.trim() ? i.goal.trim() : '(none recorded)'}`,
    '',
    'Facts from the console (git, its own test run and the token ledger; not from the stopped agent):',
    `- stop cause: ${f.cause}`,
    '- checklist:',
    ...(f.checklist.length > 0 ? f.checklist.map(stepLine) : ['  (no checklist)']),
    `- commits on the branch since project/${i.project}:`,
    ...(f.commits.length > 0 ? f.commits.map((c) => `  ${c}`) : ['  (none)']),
    `- changed files (git diff --stat project/${i.project}...HEAD):`,
    ...(f.diffStat ? f.diffStat.split(/\r?\n/).map((l) => `  ${l}`) : ['  (none)']),
    `- the tests, run by the console on the WIP commit ${i.sha.slice(0, 7)}: ${tests}`,
    ...(f.testTail ? ['  last lines of the test output:', ...f.testTail.split(/\r?\n/).map((l) => `  ${l}`)] : []),
    `- handover note of the stopped agent: ${f.handover?.trim() ? f.handover.trim() : '(none written)'}`,
    '- heaviest turns in the ledger (input + output + cache creation tokens):',
    ...(f.heaviestTurns.length > 0 ? f.heaviestTurns.map((h) => `  turn ${h.turn}: ${h.tokens} tokens, tools: ${h.tools.join(', ') || 'none'}`) : ['  (no turn recorded)']),
    `- tools used in more than ${REPEATED_OVER} turns:`,
    ...(f.repeatedTools.length > 0 ? f.repeatedTools.map((r) => `  ${r.tool}: ${r.count} turns`) : ['  (none)']),
    '',
    'Your three jobs:',
    `1. Verify. Your folder is a checkout of the WIP commit. Compare each closed step with the commits and the code (git log, git show, git diff project/${i.project}...HEAD). A step is verified only when its work is really there.`,
    '2. Diagnose. From the facts above find why the work stopped: a loop, files read again and again, tests failing over and over, a step too big, an ambiguous objective.',
    '3. Remedy. Choose exactly one: split (the remaining work in smaller steps), exclude_paths (heavy files or folders to keep away from), change_model, remove_obstacle (a blocker to remove first, for example a flaky test), raise_budget (only when the work is right but bigger than the budget: the user decides the spend).',
    '',
    'When you are done call mcp__console-mod__recovery_report (it is deferred: load it first with ToolSearch, query select:mcp__console-mod__recovery_report) with',
    '{ verified_steps, diagnosis, remedy, notes }. verified_steps are the numbers of the closed steps you verified; diagnosis says why it stopped; notes say what the next agent must do or avoid (paths, model, obstacle).',
    'Call it exactly once, then stop. The console starts the next agent itself.',
  ];
  return lines.join('\n');
}

const REMEDY_TEXT: Record<Remedy, string> = {
  split: 'split the remaining work into smaller steps (checklist_set with the closed steps unchanged) and close each one as soon as it is done',
  exclude_paths: 'keep away from the files and folders named in the notes: do not read or search them',
  change_model: 'the work did not suit the previous model (see the notes); the user chose to go on anyway: if you find the same difficulty, tell the main with report_blocked instead of insisting',
  remove_obstacle: 'first remove the obstacle named in the notes (for example a flaky test), then continue',
  raise_budget: 'the user raised the budget: the work was right, only bigger than the budget',
};

/** What the agent that takes a ticket over is told first: the handover (English: it is a prompt). */
export function replacementGoal(i: { from: string; project: string; ticket: Ticket; report?: RecoveryReport; limit?: number }): string {
  const t = i.ticket;
  const done = t.steps.filter((s) => s.done).map((s) => s.n);
  const lines = [
    `You take over the ticket "${i.from}" of the project "${i.project}". Its previous agent was stopped (${causeOf(t) === 'budget' ? 'token budget' : 'loop block'}); you are a new agent with a fresh context, on the same branch, with the same checklist and commits.`,
    '',
    `Objective:\n${t.goal?.trim() ? t.goal.trim() : '(none recorded)'}`,
    '',
    'Checklist (kept; the closed steps are already committed on your branch):',
    ...(t.steps.length > 0 ? t.steps.map(stepLine) : ['  (no checklist yet: study the code and save one with checklist_set)']),
    '',
    `Handover note of the previous agent: ${t.handover?.trim() ? t.handover.trim() : '(none written)'}`,
  ];
  if (i.report) {
    const r = i.report;
    const unverified = done.filter((n) => !r.verifiedSteps.includes(n));
    lines.push(
      '',
      'A read-only recovery agent examined the work:',
      `- diagnosis: ${r.diagnosis}`,
      `- remedy: ${r.remedy}: ${REMEDY_TEXT[r.remedy]}`,
      ...(r.notes ? [`- notes: ${r.notes}`] : []),
      `- closed steps it verified: ${r.verifiedSteps.length > 0 ? r.verifiedSteps.join(', ') : 'none'}`,
      ...(unverified.length > 0 ? [`- closed steps it could NOT verify: ${unverified.join(', ')}. Check them first and do what is missing as part of the next open step.`] : []),
    );
  }
  if (i.limit) lines.push('', `Your token budget is ${i.limit} tokens.`);
  lines.push(
    '',
    `How to go on: do not start over. Look at the commits (git log project/${i.project}..HEAD) and the code, then continue with the first open step and close each step with step_done as before (the console commits). You may call checklist_set to split the open steps into smaller ones; the closed steps must stay as they are.`,
    'Work in small steps and keep away from whatever consumed the previous budget.',
  );
  return lines.join('\n');
}

/** The parsed report, or `{ detail }`: the sentence that tells the agent which field to fix. */
function parseReport(body: unknown): RecoveryReport | { detail: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { detail: 'the report must be an object with verified_steps, diagnosis and remedy' };
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.verified_steps) || b.verified_steps.length > MAX_STEPS) return { detail: `verified_steps must be a list of at most ${MAX_STEPS} step numbers` };
  if (!b.verified_steps.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 1)) return { detail: 'verified_steps must contain whole step numbers of 1 or more' };
  if (typeof b.diagnosis !== 'string') return { detail: 'diagnosis is required' };
  const diagnosis = b.diagnosis.trim();
  if (diagnosis.length < 1 || diagnosis.length > MAX_DIAGNOSIS) return { detail: `diagnosis must be 1 to ${MAX_DIAGNOSIS} characters` };
  if (typeof b.remedy !== 'string' || !(REMEDIES as readonly string[]).includes(b.remedy)) return { detail: `remedy must be one of ${REMEDIES.join(', ')}` };
  if (b.notes !== undefined && typeof b.notes !== 'string') return { detail: 'notes must be text' };
  const notes = typeof b.notes === 'string' && b.notes.trim() !== '' ? b.notes.trim().slice(0, MAX_NOTES) : undefined;
  return { verifiedSteps: [...new Set(b.verified_steps as number[])].sort((x, y) => x - y), diagnosis, remedy: b.remedy as Remedy, ...(notes ? { notes } : {}) };
}

/**
 * Recovery after a stop (SPEC 16.5): a read-only agent verifies, diagnoses and proposes a remedy; the console then restarts the
 * ticket with a NEW agent on the same branch (never `--resume`), at most twice. A spend is always the user's decision.
 * Everything that changes a ticket happens here, one call at a time per ticket.
 */
export class RecoveryService {
  private readonly queue: KeyedQueue;
  /** Running recoveries: session name -> the ticket and the status it was stopped in. In memory: a resumed console is Phase 6. */
  private readonly active = new Map<string, { ticket: string; stopStatus: StopStatus }>();

  constructor(private readonly d: RecoveryDeps) { this.queue = d.queue ?? new KeyedQueue(); }

  /** The ticket a recovery session works on, or undefined for any other session. */
  ticketOf(recovery: string): string | undefined { return this.active.get(recovery)?.ticket; }

  start(ticket: string): Promise<StartRecoveryResult> {
    return this.queue.run(ticket, async (): Promise<StartRecoveryResult> => {
      const t = this.d.tickets.get(ticket);
      if (!t || !STOPPED.includes(t.status)) return { ok: false, code: 'not_stopped' };
      if (t.recoveries >= MAX_RECOVERIES) {
        this.d.tickets.move(ticket, 'needs_user');
        this.d.notifyMain(`Ticket "${ticket}" was stopped again after ${MAX_RECOVERIES} recoveries: no further recovery is started. It now needs the user (needs_user); tell the user.`);
        this.d.changed();
        return { ok: false, code: 'too_many' };
      }
      const wt = this.d.worktreeOf(ticket);
      if (!wt) return { ok: false, code: 'no_worktree' };
      const head = await git(wt.worktree, ['rev-parse', 'HEAD']);
      if (head.code !== 0) return { ok: false, code: 'no_worktree', detail: head.stderr.trim() };
      const sha = head.stdout.trim();
      const facts = await recoveryFacts(this.d, ticket);
      const attempt = t.recoveries + 1;
      const slug = recoverySlugFor(ticket, this.d.existingSlugs());
      const goal = recoveryGoal({ ticket, project: this.d.project, attempt, sha, goal: t.goal, facts });
      // Recorded before the start, so a report can never arrive for a recovery the console does not know.
      this.active.set(slug, { ticket, stopStatus: t.status as StopStatus });
      const started = await this.d.spawnRecovery({ slug, ticket, sha, goal });
      if (!started.ok) {
        this.active.delete(slug);
        return { ok: false, code: 'spawn_failed', detail: started.detail ?? started.code };
      }
      this.d.tickets.addRecovery(ticket);
      this.d.tickets.move(ticket, 'recovering');
      this.d.changed();
      return { ok: true, recovery: slug, attempt };
    });
  }

  /** The recovery's one report (tool `recovery_report`). Accepted once, from the recovery session of a ticket that is recovering. */
  async report(slug: string, body: unknown): Promise<RecoveryReportResult> {
    const entry = this.active.get(slug);
    if (!entry) return { ok: false, code: 'not_recovery' };
    const report = parseReport(body);
    if ('detail' in report) return { ok: false, code: 'bad_request', detail: report.detail };
    let accepted = false;
    try {
      return await this.queue.run(entry.ticket, async (): Promise<RecoveryReportResult> => {
        const t = this.d.tickets.get(entry.ticket);
        if (this.active.get(slug) !== entry || !t || t.status !== 'recovering') return { ok: false, code: 'not_recovery' };
        this.active.delete(slug);
        accepted = true;
        return this.accept(slug, entry.ticket, t, report);
      });
    } finally {
      // The session ends a few seconds AFTER the work is done, never while it runs: a slow restart under load would otherwise
      // revoke the session before its report is even answered (the next call would be unauthorized, not refused).
      if (accepted) this.d.endRecovery(slug);
    }
  }

  private async accept(slug: string, ticket: string, t: { budget?: { limit: number }; recoveries: number }, report: RecoveryReport): Promise<RecoveryReportResult> {
    {
      const summary = `Recovery of ticket "${ticket}" by ${slug}: diagnosis "${report.diagnosis.replace(/\s+/g, ' ').slice(0, 300)}", remedy ${report.remedy}.`;
      if (report.remedy === 'raise_budget') {
        const u = this.d.budget.usage(ticket);
        const limit = t.budget?.limit ?? u?.limit;
        const proposed = limit !== undefined ? raisedLimit(limit, u?.used ?? 0) : undefined;
        this.askUserToDecide(ticket, slug, report, {
          text: `The recovery of ticket "${ticket}" proposes to raise its token budget${proposed !== undefined ? ` to ${proposed} tokens` : ''} and restart it with a new agent. Approve the spend?`,
          options: ['approve', 'decline'],
          payload: { reason: 'recovery_raise', used: u?.used, limit, proposed },
          told: `${summary} A spend is the user's decision: the console asked the user to approve a raise of the budget. You will be told the answer.`,
        });
        return { ok: true, ticket, outcome: 'asked_user' };
      }
      if (report.remedy === 'change_model') {
        // Choosing a model is the user's call (out of scope for the console): a restart with the same model only if the user says so.
        this.askUserToDecide(ticket, slug, report, {
          text: `The recovery of ticket "${ticket}" says the work does not suit the model. Restart it with a new agent on the same model anyway, or leave it to you?`,
          options: ['restart', 'leave'],
          payload: { reason: 'recovery_change_model' },
          told: `${summary} Choosing a model is the user's decision: the console asked the user whether to restart the ticket with the same model or leave it. You will be told the answer.`,
        });
        return { ok: true, ticket, outcome: 'asked_user' };
      }
      const out = await this.replace(ticket, { report });
      this.d.notifyMain(out.ok
        ? `${summary} The console restarted the ticket with a new agent "${out.agent}" on the same branch (attempt ${t.recoveries} of ${MAX_RECOVERIES}).`
        : `${summary} The new agent could not be started (${out.code}${out.detail ? `: ${out.detail}` : ''}), so the ticket now needs the user (needs_user). Tell the user.`);
      return { ok: true, ticket, outcome: out.ok ? 'restarted' : 'needs_user' };
    }
  }

  /** Puts a decision of the recovery in the user's queue (with the diagnosis as notes) and tells the main; `userDecided` runs with the answer. */
  private askUserToDecide(
    ticket: string, recovery: string, report: RecoveryReport,
    o: { text: string; options: string[]; payload: Record<string, unknown>; told: string },
  ): void {
    this.d.askUser(
      {
        text: o.text,
        options: o.options,
        payload: {
          ticket, recovery, remedy: report.remedy, ...o.payload,
          notes: [{ severity: 'diagnosis', text: report.diagnosis }, ...(report.notes ? [{ severity: 'notes', text: report.notes }] : [])],
        },
      },
      (answer) => { void this.userDecided(ticket, answer, report); },
    );
    this.d.notifyMain(o.told);
    this.d.changed();
  }

  /**
   * The user answered a decision a recovery asked for (a raise of the budget, or a restart after `change_model`). Only a ticket still
   * waiting for that answer (recovering, no session) moves.
   */
  private userDecided(ticket: string, answer: string, report: RecoveryReport): Promise<void> {
    return this.queue.run(ticket, async () => {
      const t = this.d.tickets.get(ticket);
      if (!t || t.status !== 'recovering' || [...this.active.values()].some((a) => a.ticket === ticket)) return;
      if (report.remedy === 'change_model') {
        if (answer === 'restart') {
          const out = await this.replace(ticket, { report });
          this.d.notifyMain(out.ok
            ? `The user chose to restart ticket "${ticket}" with the same model: a new agent "${out.agent}" takes it over on the same branch.`
            : `The user chose to restart ticket "${ticket}", but the new agent could not be started (${out.code}${out.detail ? `: ${out.detail}` : ''}); the ticket now needs the user (needs_user).`);
        } else if (answer === 'leave') {
          this.d.tickets.move(ticket, 'needs_user');
          this.d.notifyMain(`The user left ticket "${ticket}" after its recovery suggested another model: it now waits for the user (needs_user).`);
          this.d.changed();
        }
        return;
      }
      if (answer === 'approve') {
        const u = this.d.budget.usage(ticket);
        const base = t.budget?.limit ?? u?.limit;
        const limit = base !== undefined ? raisedLimit(base, u?.used ?? 0) : undefined;
        const out = await this.replace(ticket, { report, limit });
        this.d.notifyMain(out.ok
          ? `The user approved raising the budget of ticket "${ticket}"${limit !== undefined ? ` to ${limit} tokens` : ''}: a new agent "${out.agent}" takes it over on the same branch.`
          : `The user approved raising the budget of ticket "${ticket}", but the new agent could not be started (${out.code}${out.detail ? `: ${out.detail}` : ''}); the ticket now needs the user (needs_user).`);
      } else if (answer === 'decline') {
        this.d.tickets.move(ticket, 'needs_user');
        this.d.notifyMain(`The user declined raising the budget of ticket "${ticket}": it now waits for the user (needs_user).`);
        this.d.changed();
      }
    });
  }

  /** A stopped ticket restarted directly, without a recovery (the user raised its budget): a new agent on the same branch. */
  restart(ticket: string, o: { limit: number }): Promise<RestartResult> {
    return this.queue.run(ticket, async (): Promise<RestartResult> => {
      const t = this.d.tickets.get(ticket);
      if (!t || !STOPPED.includes(t.status)) return { ok: false, code: 'not_stopped' };
      return this.replace(ticket, { limit: o.limit });
    });
  }

  /**
   * The new agent takes the ticket over (SPEC 16.5): the ticket record moves to the new name and goes back to `in_progress` with a
   * fresh budget, then the agent is started on the old agent's branch. A start that fails moves the record back and hands the
   * ticket to the user. Runs inside the ticket's serial chain.
   */
  private async replace(from: string, o: { report?: RecoveryReport; limit?: number }): Promise<RestartResult> {
    // The note the stopped agent left in its worktree goes into the ticket (and so into the new agent's goal) before the folder goes.
    let handover: string | undefined;
    try { handover = this.d.readHandover?.(from); } catch { handover = undefined; }
    if (handover) this.d.tickets.setHandover(from, handover);
    const t = this.d.tickets.get(from)!;
    const previousBudget = t.budget;
    const previousStop = { blocked: t.blocked, ...(t.blockedReason !== undefined ? { blockedReason: t.blockedReason } : {}), ...(t.stopCause !== undefined ? { stopCause: t.stopCause } : {}) };
    const to = replacementSlugFor(from, this.d.existingSlugs());
    const limit = o.limit ?? t.budget?.limit;
    const goal = replacementGoal({ from, project: this.d.project, ticket: t, report: o.report, limit });
    const profile = this.d.profileOf(from);
    this.d.tickets.rename(from, to);
    this.d.renamed?.(from, to);
    this.d.tickets.restart(to);
    if (limit !== undefined) this.d.budget.restart(to, limit);
    let started: SpawnResult;
    try {
      started = await this.d.spawnReplacement({ slug: to, profile, goal, from, ...(limit !== undefined ? { budget: limit } : {}) });
    } catch (e) {
      started = { ok: false, code: 'spawn_failed', detail: errorMessage(e) };
    }
    if (!started.ok) {
      this.d.tickets.rename(to, from);
      this.d.renamed?.(to, from);
      if (limit !== undefined) this.d.tickets.setBudget(from, previousBudget); // restart() had replaced it: the ticket goes back as it was
      this.d.tickets.restoreStop(from, previousStop);
      this.d.tickets.move(from, 'needs_user');
      this.d.changed();
      return { ok: false, code: 'spawn_failed', detail: started.detail ?? started.code };
    }
    this.d.changed();
    return { ok: true, agent: to };
  }

  /** The recovery session ended without a report: the ticket waits again in the status it was stopped in, and the main is told. */
  abandon(slug: string): boolean {
    const entry = this.active.get(slug);
    if (!entry) return false;
    this.active.delete(slug);
    const t = this.d.tickets.get(entry.ticket);
    if (t?.status === 'recovering' && canMove('recovering', entry.stopStatus)) this.d.tickets.move(entry.ticket, entry.stopStatus);
    this.d.notifyMain(`The recovery ${slug} ended without a report, so ticket "${entry.ticket}" is ${entry.stopStatus} again (${this.d.tickets.get(entry.ticket)?.recoveries ?? 0} of ${MAX_RECOVERIES} recoveries used). Call start_recovery to try again, or tell the user.`);
    this.d.changed();
    return true;
  }
}
