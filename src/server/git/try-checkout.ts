import { existsSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { git } from './git';
import { commonDir, excludeConsoleFolder, withRepoLock } from './worktree';
import { KeyedQueue } from '../keyed-queue';
import { canonicalFolder } from '../canonical-path';

/**
 * Try checkouts (SPEC 9): one checkout per repository of the project branch at its current tip, for the user to build and try (a docker compose
 * pointed at them, for example) without touching the user's own checkouts, where `git checkout project/<name>` is refused because the console's
 * `.project` worktree holds that branch. They are detached (no branch is held, so they never get in the way of a merge), live under
 * `<project>/.andromedaconsole/try/<repo>` (`try/repo` when the project folder is the repository) and are never used by the console itself.
 */
export interface TryCheckout { /** The repository's folder name; `''` for a project folder that is itself the repository. */ repo: string; path: string; sha: string }

export interface TryRepo { /** As `discoverRepos` names it: `''` is the project folder itself. */ name: string; path: string }

/** A refusal with a code the UI translates (`error.<code>`) and its parameters. */
export class TryError extends Error {
  constructor(public readonly code: string, public readonly params?: Record<string, string>) {
    super(code);
    this.name = 'TryError';
  }
}

const PROJECT = /^[A-Za-z0-9._-]+$/;
const fwd = (p: string): string => p.replace(/\\/g, '/');
const same = (a: string, b: string): boolean => fwd(canonicalFolder(a)).toLowerCase() === fwd(canonicalFolder(b)).toLowerCase();
const inside = (p: string, folder: string): boolean => fwd(canonicalFolder(p)).toLowerCase().startsWith(`${fwd(canonicalFolder(folder)).toLowerCase()}/`);

export const tryDirFor = (projectRoot: string): string => join(resolve(projectRoot), '.andromedaconsole', 'try');
const folderOf = (projectRoot: string, repo: TryRepo): string => join(tryDirFor(projectRoot), repo.name === '' ? 'repo' : repo.name);
/** How a refusal names a repository: its folder name (the project folder's own name when it is the repository). */
const shownName = (repo: TryRepo): string => (repo.name === '' ? basename(repo.path) : repo.name);

/** One prepare or remove at a time per project: a second click must not race the first on the same folders. */
const projectQueue = new KeyedQueue();
const projectKey = (projectRoot: string): string => fwd(resolve(projectRoot)).toLowerCase();

interface Registered { path: string; head?: string; detached: boolean }

async function registered(repo: string): Promise<Registered[]> {
  const listed = await git(repo, ['worktree', 'list', '--porcelain']);
  if (listed.code !== 0) throw new TryError('try.failed', { reason: listed.stderr.trim() });
  return listed.stdout.split(/\r?\n\r?\n/).flatMap((block) => {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    return path === undefined ? [] : [{ path, head: /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1], detached: /^detached$/m.test(block) }];
  });
}

/** Git looks for a repository in the folder itself and never above it. */
const ceilingAt = (path: string): Record<string, string> => ({ GIT_CEILING_DIRECTORIES: dirname(resolve(path)) });

/**
 * The git dir of the worktree in `path` when `path` is itself a worktree of `repo` (its top level is exactly `path` and it shares the repo's
 * common dir); undefined otherwise (a missing or broken `.git`, another repository).
 */
async function ownGitDir(repo: string, path: string): Promise<string | undefined> {
  const env = ceilingAt(path);
  const top = await git(path, ['rev-parse', '--show-toplevel'], { env });
  if (top.code !== 0 || !same(top.stdout.trim(), path)) return undefined;
  const dirs = await git(path, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { env });
  const [gitDir, common] = dirs.stdout.split(/\r?\n/).map((l) => l.trim());
  if (dirs.code !== 0 || !gitDir || !common) return undefined;
  try { if (!same(common, await commonDir(repo))) return undefined; } catch { return undefined; }
  return gitDir;
}

/** The try checkouts git has registered (read from git, so a restarted console finds them); `[]` when there is none. Never throws. */
export async function listTryCheckouts(o: { projectRoot: string; repos: TryRepo[] }): Promise<TryCheckout[]> {
  if (!existsSync(tryDirFor(o.projectRoot))) return []; // the usual case: no git call at all
  const out: TryCheckout[] = [];
  for (const repo of o.repos) {
    const path = folderOf(o.projectRoot, repo);
    let entries: Registered[];
    try { entries = await registered(repo.path); } catch { continue; }
    const hit = entries.find((e) => same(e.path, path));
    if (hit?.head !== undefined && existsSync(path)) out.push({ repo: repo.name, path, sha: hit.head });
  }
  return out;
}

/**
 * Makes or moves the try checkout of every repository to the tip of `project/<project>`. Everything is checked first: a repository without
 * the project branch, or a folder in the way that git does not know, refuses the whole call before anything is created.
 * A checkout that exists is moved with `git checkout --detach` (forced: it is the console's copy, what was changed inside it is thrown away).
 */
export function prepareTryCheckouts(o: { projectRoot: string; project: string; repos: TryRepo[] }): Promise<TryCheckout[]> {
  return projectQueue.run(projectKey(o.projectRoot), async () => {
    if (!PROJECT.test(o.project)) throw new TryError('try.failed', { reason: `invalid project name ${o.project}` });
    if (o.repos.length === 0) throw new TryError('git.notRepo');
    const branch = `refs/heads/project/${o.project}`;
    const plan: { repo: TryRepo; path: string; sha: string; exists: boolean }[] = [];
    for (const repo of o.repos) {
      const tip = await git(repo.path, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]);
      if (tip.code !== 0) throw new TryError('try.noProjectBranch', { repo: shownName(repo) });
      await git(repo.path, ['worktree', 'prune']); // a folder somebody deleted must not stay registered
      const path = folderOf(o.projectRoot, repo);
      const known = (await registered(repo.path)).some((e) => same(e.path, path));
      if (!known && existsSync(path)) throw new TryError('try.folderTaken', { path });
      plan.push({ repo, path, sha: tip.stdout.trim(), exists: known });
    }
    const out: TryCheckout[] = [];
    for (const step of plan) {
      await withRepoLock(step.repo.path, async () => {
        if (step.exists) {
          // A forced checkout must reach this folder's own worktree and nothing else: with its `.git` gone or broken git would walk up to
          // the user's checkout (a single-repo project keeps `try/repo` inside it) and force that one. Checked under the lock, right before.
          const gitDir = await ownGitDir(step.repo.path, step.path);
          if (gitDir === undefined) throw new TryError('try.folderTaken', { path: step.path });
          const moved = await git(step.path, [`--git-dir=${fwd(gitDir)}`, `--work-tree=${fwd(step.path)}`, 'checkout', '-q', '--force', '--detach', step.sha], { env: ceilingAt(step.path) });
          if (moved.code !== 0) throw new TryError('try.failed', { reason: moved.stderr.trim() });
        } else {
          mkdirSync(tryDirFor(o.projectRoot), { recursive: true });
          const added = await git(step.repo.path, ['worktree', 'add', '-q', '--detach', fwd(step.path), step.sha]);
          if (added.code !== 0) {
            // What a failed add left is undone through git, as `addWorktree` does, never by deleting the folder.
            await git(step.repo.path, ['worktree', 'remove', '--force', fwd(step.path)]);
            await git(step.repo.path, ['worktree', 'prune']);
            throw new TryError('try.failed', { reason: added.stderr.trim() });
          }
          await excludeConsoleFolder(step.repo.path).catch(() => undefined); // already done when the project opened; cosmetic otherwise
        }
      });
      out.push({ repo: step.repo.name, path: step.path, sha: step.sha });
    }
    return out;
  });
}

/**
 * A project's try checkouts as the state shows them: read from git when the project opens, then kept after each prepare and remove (also a
 * failed one, which may have done part of its work), so building the state never runs git.
 */
export class TryCheckoutService {
  private known: TryCheckout[] = [];
  constructor(private readonly d: { projectRoot: string; project: string; repos: () => TryRepo[] }) {}

  list(): TryCheckout[] { return this.known; }

  async refresh(): Promise<TryCheckout[]> {
    this.known = await listTryCheckouts({ projectRoot: this.d.projectRoot, repos: this.d.repos() });
    return this.known;
  }

  async prepare(): Promise<TryCheckout[]> {
    try {
      this.known = await prepareTryCheckouts({ projectRoot: this.d.projectRoot, project: this.d.project, repos: this.d.repos() });
      return this.known;
    } catch (e) {
      await this.refresh();
      throw e;
    }
  }

  async remove(): Promise<void> {
    try {
      await removeTryCheckouts({ projectRoot: this.d.projectRoot, repos: this.d.repos() });
    } finally {
      await this.refresh();
    }
  }
}

/**
 * Removes every try checkout through git (`git worktree remove`, then `prune`): a folder git cannot remove (a program still holds a file
 * in it) is reported, never deleted blindly. Safe to repeat.
 */
export function removeTryCheckouts(o: { projectRoot: string; repos: TryRepo[] }): Promise<void> {
  return projectQueue.run(projectKey(o.projectRoot), async () => {
    const dir = tryDirFor(o.projectRoot);
    if (!existsSync(dir)) return;
    for (const repo of o.repos) {
      await withRepoLock(repo.path, async () => {
        let entries: Registered[];
        try { entries = await registered(repo.path); } catch { return; } // not a repository any more: nothing of it to remove
        for (const e of entries.filter((x) => inside(x.path, dir))) {
          const removed = await git(repo.path, ['worktree', 'remove', '--force', fwd(e.path)]);
          if (removed.code !== 0) throw new TryError('try.removeFailed', { path: e.path, reason: removed.stderr.trim() });
        }
        await git(repo.path, ['worktree', 'prune']);
      });
    }
    try { if (readdirSync(dir).length === 0) rmdirSync(dir); } catch { /* not empty: something of the user's, left alone */ }
  });
}
