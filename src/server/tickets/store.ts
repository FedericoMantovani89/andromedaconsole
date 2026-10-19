import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { removeStaleTmp, writeJsonAtomic } from '../fs-atomic';
import { readJsonState, setAside, type StateReport } from '../json-file';
import type { Step } from './checklist';
import { parseAgentTests } from './agent-tests';
import { canMove, type TicketStatus } from './flow';
import { SLUG_RE } from '../../shared/slug';

export type { TicketStatus } from './flow';

export interface ReviewNote { severity: string; where?: string; text: string }
export interface Verdict { round: number; pass: boolean; reviewer: string; notes: ReviewNote[]; at: string }
export interface TestResult { ok: boolean; command: string; tail: string; sha: string; at: string }

/** What the agent said about the tests it ran itself (`step_done`): a claim, never checked by the console. */
export interface AgentTests { command: string; result: 'passed' | 'failed'; summary?: string }

export interface Ticket {
  slug: string;
  steps: Step[];
  status: TicketStatus;
  blocked: boolean;
  blockedReason?: string;
  updatedAt: string;
  /** What the main asked for (SPEC 15.2: the diff must answer it). */
  goal?: string;
  /** Review rounds that sent the ticket back to its author (0 until the first reopen). */
  round: number;
  verdicts: Verdict[];
  /** The console's own test run on the delivered commit. */
  tests?: TestResult;
  /** The last tests the agent reported running by hand (an unverified claim; shown apart from `tests`). */
  agentTests?: AgentTests;
  deliveredSha?: string;
  mergedSha?: string;
  reviewer?: string;
  /** Budget of this ticket (Phase 5). The usage is not stored here: the ledger is the record (n/a until its first turn). */
  budget?: { limit: number; step: 'ok' | 'alert' | 'limit' | 'stopped'; limitAt?: string };
  /** Recovery agents started for this ticket. */
  recoveries: number;
  stopCause?: 'budget' | 'loop' | 'limit';
  handover?: string;
  /** The repository the agent works in, relative to the project folder; absent means the project folder itself. */
  repo?: string;
  /** The agent this ticket was started after (`spawn_agent after`): it is not reviewed or merged before that agent's ticket is merged. */
  after?: string;
  /** The central full run on the merged project branch (`CentralRun`): the tip it passed on, or where it turned red and blamed this ticket. */
  central?: CentralMark;
}
export interface CentralMark { checkedTip?: string; red?: { tip: string; tests: string[]; at: string } }
export interface TicketProgress { done: number; total: number; blocked: boolean; status: TicketStatus }

const MAX_GOAL = 4000;
const REOPEN_FROM: TicketStatus[] = ['changes_requested', 'conflict', 'needs_user'];

/** One JSON file per agent under <repo>/.andromedaconsole/state/tickets/ (SPEC 23). */
export class TicketStore {
  private readonly dir: string;
  private swept = false;

  constructor(root: string, private readonly report?: StateReport) {
    this.dir = join(root, '.andromedaconsole', 'state', 'tickets');
  }

  private file(slug: string): string {
    if (!SLUG_RE.test(slug)) throw new Error('ticket.badSlug');
    return join(this.dir, `${slug}.json`);
  }

  get(slug: string): Ticket | undefined {
    const file = this.file(slug);
    const s = readJsonState(file, this.report);
    if (s.status !== 'ok') return undefined;
    const t = s.value as Ticket | null;
    if (typeof t !== 'object' || t === null || !Array.isArray(t.steps)) { setAside(file, this.report); return undefined; } // a damaged file must not take the console down
    if (t.slug !== slug) { const healed = { ...t, slug }; writeJsonAtomic(file, healed); return this.normalize(healed); } // a crash between the move and the rewrite of a rename
    return this.normalize(t);
  }

  private normalize(t: Ticket): Ticket {
    // Phase 3 files have no pipeline fields. A damaged agent claim reads as none: the report must not fail on it.
    const { agentTests: claim, ...rest } = t;
    const parsed = claim === undefined ? undefined : parseAgentTests(claim);
    return {
      ...rest, round: typeof t.round === 'number' ? t.round : 0, recoveries: typeof t.recoveries === 'number' ? t.recoveries : 0, verdicts: Array.isArray(t.verdicts) ? t.verdicts : [],
      ...(parsed?.ok ? { agentTests: parsed.tests } : {}),
    };
  }

  /** Every ticket on disk (damaged files and files that are not tickets are skipped). */
  list(): Ticket[] {
    if (!existsSync(this.dir)) return [];
    if (!this.swept) { this.swept = true; removeStaleTmp(this.dir); } // a crash in the middle of a write leaves its temp file behind
    return readdirSync(this.dir)
      .map((f) => /^([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/.exec(f)?.[1])
      .filter((slug): slug is string => slug !== undefined)
      .map((slug) => this.get(slug))
      .filter((t): t is Ticket => t !== undefined);
  }

  private save(t: Ticket): Ticket {
    const next = { ...t, updatedAt: new Date().toISOString() };
    writeJsonAtomic(this.file(t.slug), next);
    return next;
  }

  private ensure(slug: string): Ticket {
    const t = this.get(slug);
    if (t) return t;
    // `get` sets a damaged file aside, which frees its name. If the file is still there the move failed: writing a new ticket would destroy it.
    if (existsSync(this.file(slug))) throw new Error('ticket.unreadable');
    return { slug, steps: [], status: 'in_progress', blocked: false, updatedAt: '', round: 0, recoveries: 0, verdicts: [] };
  }

  private existing(slug: string): Ticket {
    const t = this.get(slug);
    if (!t) throw new Error('ticket.missing');
    return t;
  }

  setChecklist(slug: string, steps: Step[]): Ticket {
    return this.save({ ...this.ensure(slug), steps });
  }

  setGoal(slug: string, goal: string): Ticket {
    return this.save({ ...this.ensure(slug), goal: goal.trim().slice(0, MAX_GOAL) });
  }

  setRepo(slug: string, repo: string): Ticket {
    return this.save({ ...this.ensure(slug), repo });
  }

  setAfter(slug: string, after: string): Ticket {
    return this.save({ ...this.ensure(slug), after });
  }

  setCentral(slug: string, central: CentralMark): Ticket {
    const t = this.existing(slug);
    return this.save({ ...t, central: { ...t.central, ...central } });
  }

  setTests(slug: string, tests: TestResult): Ticket {
    return this.save({ ...this.existing(slug), tests });
  }

  setAgentTests(slug: string, agentTests: AgentTests): Ticket {
    return this.save({ ...this.existing(slug), agentTests });
  }

  /** Closes the next open step that is not waiting for an answer. Anything else is refused, so a repeated or out-of-order `step_done` cannot double-commit. */
  markDone(slug: string, n: number, o: { note?: string; sha?: string; skipped?: boolean }): Ticket {
    const t = this.get(slug);
    if (!t || t.steps.length === 0) throw new Error('ticket.missing');
    const next = t.steps.find((s) => !s.done && !s.waitingOn);
    if (!next || next.n !== n) throw new Error('step.out_of_order');
    const closed: Step = { ...next, done: true };
    if (o.note !== undefined) closed.note = o.note;
    if (o.sha !== undefined) closed.sha = o.sha;
    if (o.skipped) closed.skipped = true;
    return this.save({ ...t, steps: t.steps.map((s) => (s.n === n ? closed : s)) });
  }

  /** A question was sent for step `n`: the step stays open but `markDone` goes past it until the answer arrives. */
  setWaiting(slug: string, n: number, w: { requestId: string; to: string }): Ticket {
    const t = this.existing(slug);
    if (!t.steps.some((s) => s.n === n)) throw new Error('step.missing');
    return this.save({ ...t, steps: t.steps.map((s) => (s.n === n ? { ...s, waitingOn: w } : s)) });
  }

  /** The answer arrived: the step is workable again and remembers the request (its comment must be removed before it closes). */
  clearWaiting(slug: string, requestId: string): { ticket: Ticket; step: Step } | undefined {
    const t = this.get(slug);
    const found = t?.steps.find((s) => s.waitingOn?.requestId === requestId);
    if (!t || !found) return undefined;
    const { waitingOn: _gone, ...rest } = found;
    const step: Step = { ...rest, resolved: [...(found.resolved ?? []), requestId] };
    const ticket = this.save({ ...t, steps: t.steps.map((s) => (s.n === found.n ? step : s)) });
    return { ticket, step };
  }

  block(slug: string, reason: string): Ticket {
    return this.save({ ...this.ensure(slug), blocked: true, blockedReason: reason });
  }

  unblock(slug: string): Ticket | undefined {
    const t = this.get(slug);
    if (!t) return undefined;
    const { blockedReason: _gone, ...rest } = t;
    return this.save({ ...rest, blocked: false });
  }

  /** The only way to change the status: it must be a legal step of the flow (`flow.ts`). */
  move(slug: string, to: TicketStatus, extra: { deliveredSha?: string; mergedSha?: string; reviewer?: string | undefined } = {}): Ticket {
    const t = this.existing(slug);
    if (!canMove(t.status, to)) throw new Error('ticket.badTransition');
    return this.save({ ...t, ...extra, status: to });
  }

  addVerdict(slug: string, v: { pass: boolean; reviewer: string; notes: ReviewNote[] }): Ticket {
    const t = this.existing(slug);
    return this.save({ ...t, verdicts: [...t.verdicts, { round: t.verdicts.length + 1, ...v, at: new Date().toISOString() }] });
  }

  /**
   * Gives the ticket back to its author: three steps are appended (fixes, validation, documentation), so the skeleton rules and the
   * delivery code of the first round apply unchanged, and the status returns to `in_progress`.
   */
  reopen(slug: string, o: { firstStep?: string } = {}): Ticket {
    const t = this.existing(slug);
    if (!REOPEN_FROM.includes(t.status) || !canMove(t.status, 'in_progress')) throw new Error('ticket.badTransition');
    const round = t.round + 1;
    const first = t.steps.length + 1;
    const added: Step[] = [`${o.firstStep ?? 'Review fixes'} (round ${round})`, `Validation (round ${round})`, `Update documentation (round ${round})`]
      .map((title, i) => ({ n: first + i, title, done: false }));
    // The agent's claim about its tests belongs to the round it was made in: the next report must not show it as current.
    const { blockedReason: _gone, agentTests: _claim, ...rest } = t;
    return this.save({ ...rest, blocked: false, status: 'in_progress', round, steps: [...t.steps, ...added] });
  }

  setBudget(slug: string, budget: Ticket['budget']): Ticket { return this.save({ ...this.existing(slug), budget }); }
  setStopCause(slug: string, stopCause: Ticket['stopCause']): Ticket { return this.save({ ...this.existing(slug), stopCause }); }
  addRecovery(slug: string): Ticket { const t = this.existing(slug); return this.save({ ...t, recoveries: t.recoveries + 1 }); }
  setHandover(slug: string, handover: string): Ticket { return this.save({ ...this.existing(slug), handover: handover.slice(0, 4000) }); }

  /** A new agent takes the ticket over after a stop (SPEC 16.5): same checklist and commits, back to `in_progress`. */
  restart(slug: string): Ticket {
    const t = this.existing(slug);
    if (!['suspended_budget', 'blocked', 'recovering', 'suspended_limit'].includes(t.status) || !canMove(t.status, 'in_progress')) throw new Error('ticket.badTransition');
    const { stopCause: _gone, blockedReason: _stale, agentTests: _claim, ...rest } = t; // the stopped agent's claim is not the new one's
    return this.save({ ...rest, status: 'in_progress', blocked: false });
  }

  /** Puts back the fields `restart` drops, for a replacement that never started (the ticket returns to the user as it was stopped). */
  restoreStop(slug: string, was: { blocked: boolean; blockedReason?: string; stopCause?: Ticket['stopCause'] }): Ticket {
    const { stopCause: _cause, blockedReason: _reason, ...rest } = this.existing(slug);
    return this.save({
      ...rest,
      blocked: was.blocked,
      ...(was.blockedReason !== undefined ? { blockedReason: was.blockedReason } : {}),
      ...(was.stopCause !== undefined ? { stopCause: was.stopCause } : {}),
    });
  }

  /**
   * Moves a ticket to another agent name (a replacement agent takes it over, SPEC 16.5): the record is copied whole (steps, goal,
   * recoveries, handover, budget, status) and then the old file is deleted. Refuses a missing source or a target that exists.
   */
  rename(from: string, to: string): Ticket {
    const t = this.existing(from);
    const target = this.file(to);
    if (existsSync(target)) throw new Error('ticket.exists');
    renameSync(this.file(from), target); // the file moves first (one atomic rename), then the slug inside it follows
    return this.save({ ...t, slug: to });
  }

  progress(slug: string): TicketProgress | undefined {
    const t = this.get(slug);
    if (!t) return undefined;
    return { done: t.steps.filter((s) => s.done).length, total: t.steps.length, blocked: t.blocked, status: t.status };
  }
}
