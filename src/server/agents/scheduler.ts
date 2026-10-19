import type { AgentRegistry } from './registry';
import { effectiveLimits, type QuotaStep } from '../budget/quota';

export interface SpawnRequest {
  slug: string;
  profile: string;
  goal?: string;
  model?: string;
  source: 'main' | 'user';
  /** A reviewer of a delivered ticket: its folder is a detached checkout of that commit, read-only (SPEC 15.3). */
  review?: { ticket: string; sha: string };
  /** A recovery of a stopped ticket: a detached checkout of its WIP commit, read-only (SPEC 16.5). */
  recovery?: { ticket: string; sha: string };
  /** A replacement agent: its worktree checks out this EXISTING branch (the stopped agent's) instead of a new one (SPEC 16.5). */
  resumeBranch?: string;
  /**
   * A suspended agent resumed after a usage limit (SPEC 18.4): `claude --resume <sessionId>` in its EXISTING worktree, same slug,
   * no goal message (the session keeps its context). It waits for a slot like any other request and counts as active once started.
   */
  resume?: { sessionId: string; /** Why: `limit` (the default) after a usage limit; the others wake a dormant agent after a console restart (Phase 6A). */ reason?: 'limit' | 'user' | 'work' | 'main' };
  /** Token budget of this ticket; absent means the profile's `budget_tokens`, then `budget.agentTokens` (SPEC 16.2). */
  budget?: number;
  /** The git repository the agent works in, relative to the project folder (`''`: the project folder itself). `spawnAgent` fills it in. */
  repo?: string;
  /**
   * Another agent of the same repository this one depends on (`spawn_agent after`): the new branch starts from that agent's branch,
   * so its committed work is there, and this ticket is not reviewed or merged before that one is merged.
   */
  after?: string;
}

/** `ready` is present when the start is asynchronous (it creates a worktree first): it rejects if the start fails. */
export type RequestResult = { status: 'started'; ready?: Promise<void> } | { status: 'queued'; position: number };

export interface SchedulerOptions {
  registry: AgentRegistry;
  /** Read on every decision, so changing the limits takes effect without restarting anything (SPEC 16.7, 22.2). */
  limits: () => { global: number; perProject: number };
  /** Agents counting against the global limit across ALL projects (Phase 6C); absent: this project's own count (a single project). */
  globalActive?: () => number;
  /**
   * Actually starts the process. May throw, or return a promise that rejects. Either way the agent must count as active from the
   * synchronous part of the call (the registry state), so the next decision sees the slot as taken.
   */
  start: (r: SpawnRequest) => void | Promise<void>;
  /** The subscription quota's step, read on every decision: halve cuts the limits, freeze admits nobody (SPEC 18.2). */
  multiplier?: () => QuotaStep;
  /** A queued request whose start failed (it is dropped; the queue goes on). */
  onStartError?: (r: SpawnRequest, error: unknown) => void;
}

/**
 * Limit on active agents (SPEC 16.7). Over the limit a request does not fail: it waits in order and starts by itself when
 * a slot frees. Lowering the limit never stops a running agent; it only delays new ones.
 */
export class Scheduler {
  private readonly waiting: SpawnRequest[] = [];
  private closed = false;
  private releasing = false;

  constructor(private readonly o: SchedulerOptions) {
    // Every state change may free a slot (an agent went idle, waits for the user, or its process died).
    o.registry.on(() => this.release());
  }

  /** Shutdown: processes dying must not make the queue start new ones. */
  close(): void {
    this.closed = true;
    this.waiting.length = 0;
  }

  request(r: SpawnRequest): RequestResult {
    if (this.closed) throw new Error('the console is closing');
    if (this.waiting.length === 0 && this.hasRoom()) {
      const started = this.o.start(r); // an error here belongs to the caller (nothing was queued)
      return started instanceof Promise ? { status: 'started', ready: started } : { status: 'started' };
    }
    this.waiting.push(r);
    return { status: 'queued', position: this.waiting.length };
  }

  /** Starts as many queued requests, oldest first, as there is room for. Safe to call at any time and repeatedly. */
  release(): void {
    // A start changes the registry, whose listener calls release() again: that nested call must not start the next request before
    // this one has finished starting (oldest first). The outer loop goes on by itself.
    if (this.releasing) return;
    this.releasing = true;
    try {
      while (!this.closed && this.waiting.length > 0 && this.hasRoom()) {
        const next = this.waiting.shift()!;
        try {
          const started = this.o.start(next);
          if (started instanceof Promise) started.catch((error: unknown) => this.o.onStartError?.(next, error));
        } catch (error) {
          this.o.onStartError?.(next, error);
        }
      }
    } finally {
      this.releasing = false;
    }
  }

  queued(): SpawnRequest[] { return [...this.waiting]; }

  position(slug: string): number | undefined {
    const i = this.waiting.findIndex((r) => r.slug === slug);
    return i < 0 ? undefined : i + 1;
  }

  cancel(slug: string): void {
    const i = this.waiting.findIndex((r) => r.slug === slug);
    if (i >= 0) this.waiting.splice(i, 1);
  }

  /** The limits in force now: the configured ones under the subscription quota's step (SPEC 18.2). */
  effectiveLimits(): { global: number; perProject: number } {
    return effectiveLimits(this.o.limits(), this.o.multiplier?.() ?? 'none');
  }

  /** Agents counting against the limit right now. */
  activeCount(): number {
    return this.o.registry.list().filter((a) => this.o.registry.isActive(a.slug)).length;
  }

  private hasRoom(): boolean {
    const { global, perProject } = this.effectiveLimits();
    const active = this.o.registry.list().filter((a) => this.o.registry.isActive(a.slug)).length;
    return active < perProject && (this.o.globalActive ? this.o.globalActive() : active) < global;
  }
}
