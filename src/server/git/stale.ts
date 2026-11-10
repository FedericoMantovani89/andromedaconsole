import { git } from './git';

const DAY_MS = 24 * 60 * 60_000;

export interface StaleCandidate { slug: string; worktree: string; lastActiveAt?: string; stale?: boolean }

export interface StaleDeps {
  enabled(): boolean;
  days(): number;
  now(): number;
  /** Registered agent worktrees whose ticket is not merged and whose process is not running. */
  candidates(): StaleCandidate[];
  /** Time of the latest commit in the worktree (ms); undefined when it cannot be read. */
  latestCommitMs(worktree: string): Promise<number | undefined>;
  /** Sets or clears the `stale` flag of the agent's record. */
  setStale(slug: string, stale: boolean): void;
  tellMain(text: string): void;
  changed(): void;
}

/** The latest commit time of a checkout, in ms. */
export async function latestCommitMs(worktree: string): Promise<number | undefined> {
  const r = await git(worktree, ['log', '-1', '--format=%ct']);
  const seconds = Number(r.stdout.trim());
  return r.code === 0 && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Finds worktrees nobody has touched for `git.staleWorktreeDays` (SPEC 9.9): marks the agent stale (a chip) and tells the main ONCE,
 * listing the ones that just became stale. The console only reports; removing a worktree is `worktree_cleanup`, asked by the main.
 */
export class StaleChecker {
  private running = false;

  constructor(private readonly d: StaleDeps) {}

  /** Runs one check. Returns the agents that just became stale. Never throws. */
  async check(): Promise<string[]> {
    if (!this.d.enabled() || this.running) return [];
    this.running = true;
    const fresh: { slug: string; days: number }[] = [];
    try {
      const limit = this.d.days() * DAY_MS;
      for (const c of this.d.candidates()) {
        const active = c.lastActiveAt !== undefined ? Date.parse(c.lastActiveAt) : Number.NaN;
        const commit = await this.d.latestCommitMs(c.worktree).catch(() => undefined);
        const times = [active, commit].filter((t): t is number => t !== undefined && Number.isFinite(t));
        if (times.length === 0) continue; // unknown is never stale
        const age = this.d.now() - Math.max(...times);
        if (age > limit) {
          if (!c.stale) { this.d.setStale(c.slug, true); fresh.push({ slug: c.slug, days: Math.floor(age / DAY_MS) }); }
        } else if (c.stale) {
          this.d.setStale(c.slug, false);
        }
      }
      if (fresh.length > 0) {
        this.d.tellMain(`These agent worktrees have not been touched for more than ${this.d.days()} days: ${fresh.map((f) => `${f.slug} (${f.days} days)`).join(', ')}. Ask the user what to do with each one. To free the disk space of one, call worktree_cleanup {name, action: "remove"} (deferred: load it first with ToolSearch, query select:mcp__andromeda-mcp__worktree_cleanup): the console saves the work, pushes the branch and only then removes the folder; the branch and the ticket stay.`);
        this.d.changed();
      }
    } catch { /* a check that fails is tried again at the next one */ } finally {
      this.running = false;
    }
    return fresh.map((f) => f.slug);
  }
}
