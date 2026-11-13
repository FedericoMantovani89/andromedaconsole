import type { AgentRegistry } from './registry';
import type { AgentPatch } from '../project-store';

export interface PersistDeps {
  registry: AgentRegistry;
  /** Merges a patch into the agent's record in `state/agents.json`. */
  updateAgent(slug: string, patch: AgentPatch): void;
  /** The main's session id goes to `state/main.json`. */
  writeMainSession(sessionId: string): void;
  mainSlug: string;
  now?: () => number;
  /** Minimum time between two writes for one slug (default 1 s). */
  minIntervalMs?: number;
}

/**
 * Keeps what a restart needs (Phase 6A) up to date from the registry's changes: session id, worktree, branch, folder, the last
 * state and the time of the last activity. At most one write per slug per interval: a change inside the interval is written once,
 * when the interval is over, with the values of that moment (`close()` writes what is still waiting).
 */
export class AgentPersister {
  private readonly lastWrite = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  private lastMainSession: string | undefined;

  constructor(private readonly d: PersistDeps) {}

  /** Registry listener. */
  onChange(slug: string): void {
    if (this.closed) return;
    const a = this.d.registry.get(slug);
    if (!a) return;
    // Reviewers, recoveries and auditors are never restored: nothing to remember of them.
    if (a.role === 'reviewer' || a.role === 'recovery' || a.role === 'auditor') return;
    if (slug === this.d.mainSlug) { this.saveMain(); return; }
    const now = (this.d.now ?? Date.now)();
    const wait = (this.d.minIntervalMs ?? 1000) - (now - (this.lastWrite.get(slug) ?? Number.NEGATIVE_INFINITY));
    if (wait <= 0) { this.write(slug); return; }
    if (this.timers.has(slug)) return;
    const timer = setTimeout(() => { this.timers.delete(slug); this.write(slug); }, wait);
    timer.unref?.();
    this.timers.set(slug, timer);
  }

  /** Writes what is waiting and stops: later changes (processes ending at shutdown) must not overwrite the last real state. */
  close(): void {
    if (this.closed) return;
    for (const [slug, timer] of this.timers) { clearTimeout(timer); this.write(slug); }
    this.timers.clear();
    this.closed = true;
  }

  private saveMain(): void {
    const id = this.d.registry.get(this.d.mainSlug)?.sessionId;
    if (id === undefined || id === this.lastMainSession) return;
    this.lastMainSession = id;
    try { this.d.writeMainSession(id); } catch { /* the next change tries again */ }
  }

  private write(slug: string): void {
    const a = this.d.registry.get(slug);
    if (!a) return;
    this.lastWrite.set(slug, (this.d.now ?? Date.now)());
    // A restored agent keeps its record as it was until it does something: `dormant` says nothing new, and rewriting its last state
    // would lose the crash information of the run before.
    if (a.state === 'dormant') return;
    const active = a.state === 'starting' || a.state === 'working';
    try {
      this.d.updateAgent(slug, {
        role: a.role,
        ...(a.sessionId !== undefined ? { sessionId: a.sessionId } : {}),
        ...(a.git ? { worktree: a.git.worktree, branch: a.git.branch, ...(a.git.repo !== undefined ? { repo: a.git.repo } : {}) } : {}),
        ...(a.cwd !== undefined ? { cwd: a.cwd } : {}),
        lastState: a.state,
        // Archived by the end of the session or by hand; any new work clears it (`undefined` removes the key).
        archived: a.archived ? true : undefined,
        archivedAt: a.archived ? a.archivedAt : undefined,
        // Only a state that shows the agent at work counts as activity (an exit or a queue slot does not).
        ...(active || a.state === 'idle' || a.state === 'waiting_user' ? { lastActiveAt: new Date((this.d.now ?? Date.now)()).toISOString() } : {}),
        // Any sign of work clears the stale mark.
        ...(active ? { stale: undefined } : {}),
      });
    } catch { /* the console must not stop for a state file */ }
  }
}
