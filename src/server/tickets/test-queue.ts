import { runValidation, type ValidationResult } from './validate';
import { errorMessage } from '../../shared/guards';

/** What a test run gives back: a `cancelled` run never started or was stopped because its owner (an agent) is gone. */
export type TestRun = ValidationResult;
export type Runner = (o: { cwd: string; command: string; timeoutMs: number; signal?: AbortSignal }) => Promise<TestRun>;

/** What the services call: the console hands them the queue (or nothing in a test, then the command simply runs). */
export type TestRunner = (o: { cwd: string; command: string; timeoutMs: number; owner?: string; /** Stop the run when `owner` (an agent) is gone. */ watchOwner?: boolean }) => Promise<TestRun>;

/** No queue: the command runs at once (what the services do when nobody gave them one). */
export const runDirect: TestRunner = (o) => runValidation({ cwd: o.cwd, command: o.command, timeoutMs: o.timeoutMs });

export interface TestJob {
  cwd: string;
  command: string;
  /** Counted from the moment the run starts, never from the wait in the queue. */
  timeoutMs: number;
  /** A heavy run (the full suite) takes a slot of the queue; a fast one runs at once beside it. */
  heavy: boolean;
  /** What the UI shows for this run. */
  label: string;
  /** Whose run it is (an agent's slug, or a project): `position` answers for it. */
  owner?: string;
  /** False when the owner is gone: a waiting run is dropped and a running one is stopped. */
  ownerAlive?: () => boolean;
  /** Called with the position (1 = next) each time it changes while the run waits. */
  onWait?: (position: number) => void;
}

/** What the state shows: who is running and who waits (and their place). */
export interface QueueSnapshot {
  running: { label: string; owner?: string }[];
  waiting: { label: string; owner?: string; position: number }[];
}

interface Entry { job: TestJob; resolve(r: TestRun): void; ctl: AbortController; told?: number }

const FAILED = (e: unknown): TestRun => ({ ok: false, code: null, tail: errorMessage(e) });

/**
 * One queue of long test runs for the whole machine: two full suites at once slow each other down and make timing-sensitive tests
 * fail, so heavy runs go one at a time (`limit`), first come first served. A slot is always given back: when the run ends, fails,
 * times out (the runner's own timeout), or its owner is gone. Fast runs are not queued.
 */
export class TestQueue {
  private readonly waiting: Entry[] = [];
  private readonly running = new Set<Entry>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly runner: Runner;
  private readonly limit: () => number;
  private readonly changed: () => void;
  private readonly pollMs: number;

  constructor(o: { run?: Runner; limit?: () => number; changed?: () => void; pollMs?: number } = {}) {
    this.runner = o.run ?? runValidation;
    this.limit = o.limit ?? (() => 1);
    this.changed = o.changed ?? (() => {});
    this.pollMs = o.pollMs ?? 2000;
  }

  run(job: TestJob): Promise<TestRun> {
    return new Promise<TestRun>((resolve) => {
      const entry: Entry = { job, resolve, ctl: new AbortController() };
      if (!job.heavy) {
        void this.execute(entry, false);
        return;
      }
      this.waiting.push(entry);
      this.pump();
      this.watch();
    });
  }

  /** The place (1 = next) of the first waiting run of this owner; undefined when it does not wait. */
  position(owner: string): number | undefined {
    const i = this.waiting.findIndex((e) => e.job.owner === owner);
    return i < 0 ? undefined : i + 1;
  }

  snapshot(): QueueSnapshot {
    const who = (e: Entry) => ({ label: e.job.label, ...(e.job.owner !== undefined ? { owner: e.job.owner } : {}) });
    return { running: [...this.running].map(who), waiting: this.waiting.map((e, i) => ({ ...who(e), position: i + 1 })) };
  }

  private pump(): void {
    const limit = Math.max(1, Math.floor(this.limit()) || 1);
    while (this.running.size < limit && this.waiting.length > 0) {
      const entry = this.waiting.shift()!;
      this.running.add(entry);
      void this.execute(entry, true);
    }
    this.waiting.forEach((e, i) => {
      if (e.told === i + 1) return;
      e.told = i + 1;
      try { e.job.onWait?.(i + 1); } catch { /* a listener must not stop the queue */ }
    });
    this.changed();
  }

  private async execute(entry: Entry, slot: boolean): Promise<void> {
    let result: TestRun;
    try {
      const { job } = entry;
      result = await this.runner({ cwd: job.cwd, command: job.command, timeoutMs: job.timeoutMs, signal: entry.ctl.signal });
    } catch (e) {
      result = FAILED(e);
    } finally {
      if (slot) this.running.delete(entry);
    }
    entry.resolve(result);
    if (slot) { this.pump(); this.stopWatching(); }
  }

  /** Polls the owners while anything waits or runs: a dead owner must not keep the machine's only slot. */
  private watch(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.pollMs);
    this.timer.unref?.();
  }

  private stopWatching(): void {
    if (this.timer && this.waiting.length === 0 && this.running.size === 0) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private sweep(): void {
    const gone = (e: Entry): boolean => { try { return e.job.ownerAlive?.() === false; } catch { return false; } };
    for (const e of [...this.waiting]) {
      if (!gone(e)) continue;
      this.waiting.splice(this.waiting.indexOf(e), 1);
      e.resolve({ ok: false, code: null, tail: '', cancelled: true });
    }
    for (const e of this.running) if (gone(e)) e.ctl.abort();
    this.pump();
    this.stopWatching();
  }
}

/** What the ticket services (steps, review, recovery) need to find and run a project's tests. */
export interface TicketTestDeps {
  project: string;
  worktreeOf(slug: string): { worktree: string; branch: string } | undefined;
  /** The command for a run in `cwd`, the worktree it runs in (the detected command depends on that repository's files). */
  testCommand(cwd?: string): string | undefined;
  testTimeoutMs(): number;
  /** Runs a test command through the machine's test queue (default: straight away). */
  runTests?: TestRunner;
}
