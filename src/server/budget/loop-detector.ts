import { callSignature } from '../guard/rules';
import type { TranscriptEvent } from '../claude-code/transcript';

export type LoopSignal = 'same_call' | 'same_error' | 'compactions' | 'no_step' | 'silence';
export interface LoopFinding {
  signal: LoopSignal;
  evidence: string;
  /** For same_call: the signature the guard refuses at the `limit` step. */
  signature?: string;
  /** For same_call: the signature carries no discriminating key (Grep, WebFetch...), so restricting it would be too broad: warn instead. */
  coarse?: boolean;
  /** `no_step` and `silence` only warn. */
  warnOnly: boolean;
}
export interface LoopConfig { sameCall: number; sameError: number; compactions: number; stepMinutes: number; silenceMinutes: number }

const MINUTE = 60_000;
const ERROR_TAIL = 200;
const MAX_CALLS = 200;

interface SlugState {
  /** The run of identical calls going on now: its key and its length. */
  runKey: string | undefined;
  runLen: number;
  /** Occurrences of each error (originating call plus the last 200 characters of its text) since the last finished step. */
  errors: Map<string, number>;
  /** toolUseId -> full call key, the last MAX_CALLS calls (insertion order). */
  calls: Map<string, string>;
  /** Calls whose result has not arrived yet (toolUseId -> what and since when); the silence message names the oldest. */
  running: Map<string, { name: string; input: Record<string, unknown>; at: number }>;
  compacts: number;
  lastStepAt: number;
  lastEventAt: number;
  /** Time signals already told for the current period (they warn once per period). */
  fired: Set<LoopSignal>;
}

/** The full call: tool name plus the whole input, keys sorted. Finer than `callSignature`, which ignores most keys. */
const fullKey = (name: string, input: Record<string, unknown>): string =>
  JSON.stringify([name, Object.entries(input).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);

/** True when no key slot of the signature is filled (the signature would match every call of that tool). */
const isCoarse = (name: string, input: Record<string, unknown>): boolean => callSignature(name, input) === callSignature(name, {});

/** A threshold reached again: at n, 2n, 3n... (a persisting loop keeps escalating; a threshold below 1 never fires). */
const every = (count: number, n: number): boolean => n >= 1 && count >= n && count % n === 0;

/**
 * Looks for an agent going round in circles (SPEC 17.2). Pure: it reads what the transcript produced and a clock, and has no timers.
 * The content signals fire each time their threshold is reached again (5, 10, 15 identical calls...), so a loop that goes on is
 * escalated; the time signals warn once per period.
 */
export class LoopDetector {
  private readonly slugs = new Map<string, SlugState>();

  constructor(private readonly cfg: () => LoopConfig, private readonly now: () => number) {}

  private state(slug: string): SlugState {
    let s = this.slugs.get(slug);
    if (!s) {
      const t = this.now();
      s = { runKey: undefined, runLen: 0, errors: new Map(), calls: new Map(), running: new Map(), compacts: 0, lastStepAt: t, lastEventAt: t, fired: new Set() };
      this.slugs.set(slug, s);
    }
    return s;
  }

  feed(slug: string, events: TranscriptEvent[]): LoopFinding[] {
    const s = this.state(slug);
    const cfg = this.cfg();
    const out: LoopFinding[] = [];
    // Judged after every call and every result, not once per batch: one turn (one batch) often holds a different call followed by
    // a new run of identical ones, and that new run is a new loop.
    for (const e of events) {
      if (e.kind === 'tool_use') {
        const key = fullKey(e.name, e.input);
        s.calls.set(e.id, key);
        s.running.set(e.id, { name: e.name, input: e.input, at: this.now() });
        if (s.running.size > MAX_CALLS) {
          const first = s.running.keys().next();
          if (!first.done) s.running.delete(first.value);
        }
        if (s.calls.size > MAX_CALLS) {
          const oldest = s.calls.keys().next();
          if (!oldest.done) s.calls.delete(oldest.value);
        }
        if (key === s.runKey) s.runLen += 1;
        else { s.runKey = key; s.runLen = 1; }
        if (every(s.runLen, cfg.sameCall)) {
          out.push({
            signal: 'same_call', warnOnly: false, signature: callSignature(e.name, e.input), coarse: isCoarse(e.name, e.input),
            evidence: `${e.name} called ${s.runLen} times in a row with the same arguments`,
          });
        }
      } else if (e.kind === 'tool_result') {
        s.running.delete(e.toolUseId);
        // An error repeated anywhere since the last step counts, also with successful calls in between (edit, test fails the same
        // way, edit, test fails the same way...).
        if (!e.isError) continue;
        // Keyed on the originating call plus the TAIL of the text: a failing test run opens the same way whatever test fails.
        const text = e.text.slice(-ERROR_TAIL);
        const callKey = s.calls.get(e.toolUseId);
        const key = callKey === undefined ? text : `${callKey}|${text}`;
        const count = (s.errors.get(key) ?? 0) + 1;
        s.errors.set(key, count);
        if (every(count, cfg.sameError)) {
          out.push({ signal: 'same_error', warnOnly: false, evidence: `the same error ${count} times since the last finished step: ${text.slice(-80)}` });
        }
      } else if (e.kind === 'compact') {
        s.compacts += 1;
        if (every(s.compacts, cfg.compactions)) {
          out.push({ signal: 'compactions', warnOnly: false, evidence: `${s.compacts} context compactions without a finished step` });
        }
      }
    }
    return out;
  }

  onStepDone(slug: string): void {
    const s = this.state(slug);
    s.lastStepAt = this.now();
    s.compacts = 0;
    s.errors.clear();
    s.fired.delete('no_step');
  }

  /** Any sign of life from the agent (a mod event, a guard question, a console tool call) ends a silence. */
  onModEvent(slug: string): void {
    const s = this.state(slug);
    s.lastEventAt = this.now();
    s.fired.delete('silence');
  }

  tick(workingSlugs: string[]): { slug: string; finding: LoopFinding }[] {
    const cfg = this.cfg();
    const t = this.now();
    const out: { slug: string; finding: LoopFinding }[] = [];
    for (const slug of workingSlugs) {
      const s = this.state(slug);
      if (t - s.lastStepAt > cfg.stepMinutes * MINUTE && !s.fired.has('no_step')) {
        s.fired.add('no_step');
        out.push({ slug, finding: { signal: 'no_step', warnOnly: true, evidence: `no step finished for more than ${cfg.stepMinutes} minutes` } });
      }
      if (t - s.lastEventAt >= cfg.silenceMinutes * MINUTE && !s.fired.has('silence')) {
        s.fired.add('silence');
        const running = this.runningTool(slug);
        out.push({ slug, finding: { signal: 'silence', warnOnly: true, evidence: `no event from the agent for ${cfg.silenceMinutes} minutes${running ? `; still running ${running}` : ''}` } });
      }
    }
    return out;
  }

  /** The oldest call still waiting for its result, as "Bash: npm test (running for 7 minutes)"; undefined when none is. */
  runningTool(slug: string): string | undefined {
    const s = this.slugs.get(slug);
    const first = s?.running.values().next();
    if (!first || first.done) return undefined;
    const { name, input, at } = first.value;
    const detail = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : typeof input.description === 'string' ? input.description : '';
    const minutes = Math.floor((this.now() - at) / MINUTE);
    return `${name}${detail ? `: ${detail.replace(/\s+/g, ' ').slice(0, 120)}` : ''} (running for ${minutes} minute${minutes === 1 ? '' : 's'})`;
  }

  /** Whole minutes without any sign of life, once the silence threshold is reached; undefined before (the panel chip, SPEC 32.2). */
  silentMinutes(slug: string): number | undefined {
    const silent = this.now() - this.state(slug).lastEventAt;
    return silent >= this.cfg().silenceMinutes * MINUTE ? Math.floor(silent / MINUTE) : undefined;
  }

  /** Starts a signal's count again (all of them without `signal`). */
  reset(slug: string, signal?: LoopSignal): void {
    const s = this.slugs.get(slug);
    if (!s) return;
    if (signal === undefined || signal === 'same_call') { s.runKey = undefined; s.runLen = 0; }
    if (signal === undefined || signal === 'same_error') s.errors.clear();
    if (signal === undefined || signal === 'compactions') s.compacts = 0;
    if (signal === undefined) s.fired.clear();
    else s.fired.delete(signal);
  }

  forget(slug: string): void { this.slugs.delete(slug); }
}
