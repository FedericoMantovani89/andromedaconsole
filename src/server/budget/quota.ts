import type { BudgetConfig } from '../config';
import { errorMessage } from '../../shared/guards';
import { MainTeller } from '../main-teller';

export interface RateLimit { kind: 'five_hour' | 'seven_day' | 'spend_limit'; percentUsed: number; resetsAt?: string }

const KINDS: readonly RateLimit['kind'][] = ['five_hour', 'seven_day', 'spend_limit'];
/** The windows that drive the steps and the sleep. */
const STEP_KINDS: readonly RateLimit['kind'][] = ['five_hour', 'seven_day'];

/**
 * The account's usage limits as the engine reports them (SPEC 18.1). Only valid data is kept; unknown is never "everything is fine":
 * an empty or fully invalid payload leaves the previous data in place, and nothing is ever filled with zero.
 */
export class QuotaState {
  private limits: RateLimit[] = [];
  private at: number | undefined;

  constructor(private readonly now: () => number = () => Date.now()) {}

  update(limits: unknown): void {
    if (!Array.isArray(limits)) return;
    const valid: RateLimit[] = [];
    for (const raw of limits) {
      if (typeof raw !== 'object' || raw === null) continue;
      const e = raw as { kind?: unknown; percentUsed?: unknown; resetsAt?: unknown };
      if (!KINDS.includes(e.kind as RateLimit['kind'])) continue;
      if (typeof e.percentUsed !== 'number' || !Number.isFinite(e.percentUsed) || e.percentUsed < 0) continue;
      const entry: RateLimit = { kind: e.kind as RateLimit['kind'], percentUsed: Math.min(e.percentUsed, 100) };
      if (typeof e.resetsAt === 'string' && Number.isFinite(Date.parse(e.resetsAt))) entry.resetsAt = e.resetsAt;
      valid.push(entry);
    }
    if (valid.length === 0) return;
    this.limits = valid;
    this.at = this.now();
  }

  /**
   * The most used of the subscription windows (`five_hour`, `seven_day`); undefined when nothing is known (shown as n/a). A
   * `spend_limit` (extra usage paid by the user) never drives the steps (SPEC 5.2): it stays in `all()` for display only.
   */
  worst(): { kind: RateLimit['kind']; percent: number; resetsAt?: string } | undefined {
    let best: RateLimit | undefined;
    for (const l of this.limits) if (STEP_KINDS.includes(l.kind) && (!best || l.percentUsed > best.percentUsed)) best = l;
    if (!best) return undefined;
    return { kind: best.kind, percent: best.percentUsed, ...(best.resetsAt !== undefined ? { resetsAt: best.resetsAt } : {}) };
  }

  all(): RateLimit[] { return this.limits.map((l) => ({ ...l })); }

  updatedAt(): number | undefined { return this.at; }
}

export type QuotaStep = 'none' | 'halve' | 'freeze' | 'stop';

const RANK: Record<QuotaStep, number> = { none: 0, halve: 1, freeze: 2, stop: 3 };

/** Unknown (undefined) never triggers a step; the UI shows n/a for it, never "ok". */
export const quotaStepFor = (percent: number | undefined, q: BudgetConfig['quota']): QuotaStep => {
  if (percent === undefined || !Number.isFinite(percent)) return 'none';
  if (percent >= q.stopPercent) return 'stop';
  if (percent >= q.freezePercent) return 'freeze';
  if (percent >= q.halvePercent) return 'halve';
  return 'none';
};

/** The active-agent limits under a step: halve rounds up (never to zero from a positive number); freeze and stop admit no new launch. */
export const effectiveLimits = (base: { global: number; perProject: number }, step: QuotaStep): { global: number; perProject: number } => {
  if (step === 'halve') return { global: Math.ceil(base.global / 2), perProject: Math.ceil(base.perProject / 2) };
  if (step === 'freeze' || step === 'stop') return { global: 0, perProject: 0 };
  return { ...base };
};

export interface QuotaDeps {
  state: QuotaState;
  config: () => BudgetConfig['quota'];
  tellMain(text: string): void;
  tellAgent(slug: string, text: string): void;
  /** Every live session. `priority`: lower stops first (the caller uses creation order reversed: older = higher number = stopped last). */
  agents(): { slug: string; role: 'main' | 'agent' | 'reviewer' | 'recovery'; priority: number }[];
  wipCommit(slug: string, reason: string): Promise<unknown>;
  restrict(slug: string, r: { reason: 'limit' }): void;
  /** Lifts the restrictions of reason `limit` held on a session (a stronger budget one stays; the caller checks the reason). */
  clearRestriction(slug: string): void;
  /** Moves the ticket to suspended_limit (only when it is being written) and ends the session in order. */
  suspendForLimit(slug: string): Promise<void>;
  /** The scheduler multiplier for the step. */
  applyLimits(step: QuotaStep): void;
  onLimitReached(resetsAt: string | undefined, kind: RateLimit['kind']): void;
  changed(): void;
}

/**
 * What the console does as the subscription's limits fill up (SPEC 18.2): halve the active agents at 70%, freeze launches at 85%,
 * stop everything in priority order at 95%. A step only ever moves on valid data: up when a reading is higher, down to the step a
 * lower reading says (unknown never lowers it). The main is never stopped nor restricted: the user has to be able to talk to it.
 */
export class QuotaService {
  private current: QuotaStep = 'none';
  private chain: Promise<unknown> = Promise.resolve();
  private readonly main = new MainTeller((text) => this.d.tellMain(text));
  private readonly reached = new Set<string>();
  private readonly toldFreeze = new Set<string>();

  constructor(private readonly d: QuotaDeps) {}

  step(): QuotaStep { return this.current; }

  /** Never rejects; calls run one after the other so the stop sequence never overlaps with a newer reading. */
  onQuota(limits: unknown): Promise<void> {
    const run = this.chain.then(() => this.handle(limits));
    this.chain = run.catch(() => undefined);
    return run.catch((err) => { this.report('quota', err); });
  }

  private report(key: string, err: unknown): void {
    this.main.once(key, `Usage limit handling (${key}) failed: ${errorMessage(err)}`);
  }

  /** Runs one effect; a failure is told to the main once per name and the next effect still runs. */
  private async effect(key: string, fn: () => unknown): Promise<void> {
    try { await fn(); } catch (err) { this.report(key, err); }
  }

  private async handle(limits: unknown): Promise<void> {
    this.d.state.update(limits);
    const worst = this.d.state.worst();
    if (!worst) return; // nothing valid, now or before: unknown changes nothing
    const q = this.d.config();
    // The sleep starts with the stop (95%) when the reset time is known, for every window at or above it: at 95-99% a probe with no
    // time would burn the last few percent, so without a time only 100% starts it (the sleep then backs off). One notice per window
    // and reset: a later 100% reading of the same window and reset is not a new one. A spend limit never starts a sleep.
    for (const l of this.d.state.all()) {
      if (!STEP_KINDS.includes(l.kind)) continue;
      const due = l.percentUsed >= 100 || (l.percentUsed >= q.stopPercent && l.resetsAt !== undefined);
      if (!due) continue;
      const id = `${l.kind}|${l.resetsAt ?? ''}`;
      if (this.reached.has(id)) continue;
      this.reached.add(id);
      await this.effect('onLimitReached', () => this.d.onLimitReached(l.resetsAt, l.kind));
    }
    const target = quotaStepFor(worst.percent, q);
    if (RANK[target] > RANK[this.current]) {
      this.current = target;
      await this.raise(target, worst.percent, worst.kind);
    } else if (RANK[target] < RANK[this.current]) {
      // A lower valid reading brings the step down to where it says (a stop with the other window between 70% and 95% ends at
      // `halve`, not at `stop` forever).
      await this.lower(target, worst.percent);
    }
    await this.effect('changed', () => this.d.changed());
  }

  private async raise(step: QuotaStep, percent: number, kind: RateLimit['kind']): Promise<void> {
    const pct = Math.round(percent);
    await this.effect('applyLimits', () => this.d.applyLimits(step));
    if (step === 'halve') {
      await this.effect('tellMain', () => this.d.tellMain(`Usage limit (${kind}) at ${pct}%: the number of agents working at once is halved.`));
      return;
    }
    if (step === 'freeze') {
      await this.effect('tellMain', () => this.d.tellMain(`Usage limit (${kind}) at ${pct}%: no new agent starts. The running agents were told to close their step and commit.`));
      for (const a of this.d.agents()) {
        if (a.role !== 'agent' || this.toldFreeze.has(a.slug)) continue;
        this.toldFreeze.add(a.slug);
        await this.effect(`tellAgent ${a.slug}`, () => this.d.tellAgent(a.slug, 'The usage limit is close: close your current step now and commit (step_done), then keep to small safe work. Agents will be stopped soon.'));
      }
      return;
    }
    await this.effect('tellMain', () => this.d.tellMain(`Usage limit (${kind}) at ${pct}%: every agent is being stopped, in priority order. Their work is saved in WIP commits and they resume when the limit resets. You keep running.`));
    const stopping = this.d.agents().filter((a) => a.role !== 'main').sort((a, b) => a.priority - b.priority);
    for (const a of stopping) {
      // Restricted first, so the agent stops writing while its work is committed; then the commit; then the orderly close.
      await this.effect(`restrict ${a.slug}`, () => this.d.restrict(a.slug, { reason: 'limit' }));
      // A reviewer or a recovery has nothing of its own to save (detached, read-only): it is only ended. The caller commits only a
      // ticket being written (a delivered author's branch must not move).
      if (a.role === 'agent') {
        await this.effect(`wipCommit ${a.slug}`, async () => {
          const r = await this.d.wipCommit(a.slug, 'usage limit');
          if (typeof r === 'object' && r !== null && (r as { ok?: unknown }).ok === false) {
            throw new Error(`the WIP commit failed: ${String((r as { detail?: unknown }).detail ?? 'unknown')}`);
          }
        });
      }
      await this.effect(`suspend ${a.slug}`, () => this.d.suspendForLimit(a.slug));
    }
  }

  /** The step comes down to `to`. Restrictions and the freeze notices go only once launches are allowed again (none or halve). */
  private async lower(to: QuotaStep, percent: number): Promise<void> {
    this.current = to;
    const open = to === 'none' || to === 'halve';
    if (open) {
      this.toldFreeze.clear();
      for (const a of this.d.agents()) {
        if (a.role === 'main') continue;
        await this.effect(`clearRestriction ${a.slug}`, () => this.d.clearRestriction(a.slug));
      }
    }
    await this.effect('applyLimits', () => this.d.applyLimits(to));
    const pct = Math.round(percent);
    const resume = ' Tickets suspended for the limit can be resumed with mcp__andromeda-mcp__resume_agent.';
    const text = to === 'none'
      ? `Usage limit back below the first threshold (${pct}%): agents can start again as usual.${resume}`
      : to === 'halve'
        ? `Usage limit down to ${pct}%: agents can start again, half as many at once.${resume}`
        : `Usage limit down to ${pct}%: still no new agent starts.`;
    await this.effect('tellMain', () => this.d.tellMain(text));
  }
}
