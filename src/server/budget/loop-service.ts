import type { TicketStore } from '../tickets/store';
import type { LoopDetector, LoopFinding } from './loop-detector';
import type { TranscriptEvent } from '../claude-code/transcript';
import { KeyedQueue } from '../keyed-queue';
import { errorMessage } from '../../shared/guards';
import { MainTeller } from '../main-teller';

export interface LoopDeps {
  /** The per-ticket queue shared by every ticket service of the project; without it the service has its own. */
  queue?: KeyedQueue;
  detector: LoopDetector;
  tickets: TicketStore;
  tellAgent(slug: string, text: string): void;
  tellMain(text: string): void;
  restrict(slug: string, r: { reason: 'loop'; signature?: string }): void;
  /** Lifts the guard restriction of a loop; one held for the budget or the usage limit stays (the caller checks the reason). */
  clearRestriction(slug: string): void;
  wipCommit(slug: string, reason: string): Promise<{ ok: true } | { ok: false; detail: string }>;
  stop(slug: string): Promise<void>;
  workingSlugs(): string[];
  /** Any session but the main that is working (reviewers and recoveries too); the silence chip uses it. Absent: `workingSlugs`. */
  isWorking?(slug: string): boolean;
  /** The agent's process is still running (a silence is reported with it: a long tool, or a dead process). */
  processAlive(slug: string): boolean;
  changed(): void;
}

export type LoopLevel = 0 | 1 | 2 | 3;

/**
 * The three steps taken when the detector finds an agent going round in circles (SPEC 17.3): correct it, limit it, stop it.
 * Only a ticket being written (`in_progress`) is acted on. Silence and a long time without a step only warn the main.
 */
export class LoopService {
  private readonly levels = new Map<string, LoopLevel>();
  private readonly queue: KeyedQueue;
  private readonly main = new MainTeller((text) => this.d.tellMain(text));

  constructor(private readonly d: LoopDeps) { this.queue = d.queue ?? new KeyedQueue(); }

  /** The detector: `index.ts` tells it about every sign of life of an agent (silence). */
  get detector(): LoopDetector { return this.d.detector; }

  level(slug: string): LoopLevel { return this.levels.get(slug) ?? 0; }

  /** Minutes of silence of an agent that is working (a waiting agent is not silent, SPEC 17.2); undefined otherwise. */
  silentFor(slug: string): number | undefined {
    try { return (this.d.isWorking ? this.d.isWorking(slug) : this.d.workingSlugs().includes(slug)) ? this.d.detector.silentMinutes(slug) : undefined; } catch { return undefined; }
  }

  private inProgress(slug: string): boolean {
    try { return this.d.tickets.get(slug)?.status === 'in_progress'; } catch { return false; }
  }

  private tellMainSafe(text: string): void {
    try { this.d.tellMain(text); } catch { /* nothing more can be done */ }
  }

  /** Runs one effect; a failure is told to the main once per agent and the next effect still runs. */
  private async effect(slug: string, what: string, fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.main.once(slug, `Loop handling of "${slug}": the step "${what}" failed (${errorMessage(err)}).`);
    }
  }

  /** Never rejects. */
  onEvents(slug: string, events: TranscriptEvent[]): Promise<void> {
    return this.queue.run(slug, async () => {
      if (!this.inProgress(slug)) return;
      const findings = this.d.detector.feed(slug, events);
      const content = findings.filter((f) => !f.warnOnly);
      for (const f of findings) {
        if (f.warnOnly) await this.effect(slug, 'tellMain', () => this.d.tellMain(`Agent "${slug}": ${f.evidence}.`));
      }
      if (content.length === 0) return;
      // One step per batch: several signals seen together are one piece of evidence, not several escalations.
      const primary = content.find((f) => !f.coarse && f.signature !== undefined) ?? content[0]!;
      const evidence = content.map((f) => f.evidence).join('; ');
      const next = Math.min(this.level(slug) + 1, 3) as 1 | 2 | 3;
      this.levels.set(slug, next);
      if (next === 1) await this.correct(slug, evidence);
      else if (next === 2) await this.limit(slug, primary, evidence);
      else await this.stopNow(slug, evidence);
      await this.effect(slug, 'changed', () => this.d.changed());
    }).catch((err) => { this.reportOnce(slug, err); });
  }

  private reportOnce(slug: string, err: unknown): void {
    this.main.once(slug, `Loop handling of "${slug}" failed: ${errorMessage(err)}`);
  }

  private async correct(slug: string, evidence: string): Promise<void> {
    await this.effect(slug, 'tellAgent', () => this.d.tellAgent(slug, `Loop warning: ${evidence}. Change your approach, or call report_blocked with the reason if you cannot go on.`));
    await this.effect(slug, 'tellMain', () => this.d.tellMain(`Agent "${slug}" looks stuck in a loop (${evidence}). It was told to change approach or call report_blocked.`));
  }

  private async limit(slug: string, f: LoopFinding, evidence: string): Promise<void> {
    const restrict = !f.coarse && f.signature !== undefined;
    if (restrict) {
      await this.effect(slug, 'restrict', () => this.d.restrict(slug, { reason: 'loop', signature: f.signature }));
      await this.effect(slug, 'tellAgent', () => this.d.tellAgent(slug, `Loop warning, second time: ${evidence}. This call is now refused. Change your approach or call report_blocked; a third loop stops you.`));
    } else {
      await this.effect(slug, 'tellAgent', () => this.d.tellAgent(slug, `Loop warning, second time: ${evidence}. Stop repeating this: change your approach or call report_blocked now; a third loop stops you.`));
    }
    await this.effect(slug, 'tellMain', () => this.d.tellMain(`Agent "${slug}" is still looping (${evidence}). ${restrict ? 'The repeated call is now refused by the guard.' : 'It was warned again.'}`));
  }

  private async stopNow(slug: string, evidence: string): Promise<void> {
    let wip: { ok: true } | { ok: false; detail: string };
    try { wip = await this.d.wipCommit(slug, 'loop stop'); } catch (err) { wip = { ok: false, detail: errorMessage(err) }; }
    if (!wip.ok) await this.effect(slug, 'tellMain', () => this.d.tellMain(`The final WIP commit of "${slug}" failed (${wip.ok ? '' : wip.detail}); its worktree may hold uncommitted work.`));
    // Only a ticket still being written gets the loop as its cause: one the budget stopped meanwhile keeps its own.
    await this.effect(slug, 'ticket move', () => {
      if (!this.inProgress(slug)) return;
      this.d.tickets.setStopCause(slug, 'loop');
      this.d.tickets.move(slug, 'blocked');
    });
    await this.effect(slug, 'stop', () => this.d.stop(slug));
    await this.effect(slug, 'tellMain', () => this.d.tellMain(`"${slug}" was stopped on a loop (${evidence}). Call mcp__andromeda-mcp__start_recovery with name ${slug}.`));
  }

  /**
   * Time signals: notices to the main only, for agents that are working on a ticket being written. A silence is checked against
   * the process first (SPEC 17.1): a dead process is said so; a live one is probably running a long tool or waiting.
   */
  tick(): void {
    try {
      const slugs = this.d.workingSlugs().filter((s) => this.inProgress(s));
      for (const { slug, finding } of this.d.detector.tick(slugs)) {
        if (finding.signal === 'silence') {
          const alive = this.d.processAlive(slug);
          this.main.tell(alive
            ? `Agent "${slug}": ${finding.evidence}; its process is alive (probably a long tool or a wait). Nothing was done.`
            : `Agent "${slug}": ${finding.evidence}, and its process is no longer running.`);
        } else {
          this.main.tell(`Agent "${slug}": ${finding.evidence}.`);
        }
      }
    } catch (err) { this.reportOnce('all agents', err); }
  }

  /** The agent's process ended: its level, its failure notice and what the detector saw go with it. */
  forget(slug: string): void {
    this.d.detector.forget(slug);
    this.levels.delete(slug);
    this.main.reset(slug);
    this.queue.forget(slug);
  }

  /**
   * A step was closed. Level 0 again and a loop restriction goes (the callee never lifts a budget or limit one), but only for real
   * progress: a skipped step or one whose commit changed nothing leaves the loop handling where it is (otherwise checklist_set plus
   * an empty step would escape it).
   */
  onStepDone(slug: string, o: { skipped?: boolean; empty?: boolean } = {}): void {
    if (o.skipped || o.empty) return;
    this.levels.delete(slug);
    this.main.reset(slug);
    try { this.d.detector.onStepDone(slug); this.d.clearRestriction(slug); this.d.changed(); } catch (err) { this.reportOnce(slug, err); }
  }
}
