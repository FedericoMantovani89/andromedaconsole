import { existsSync, mkdirSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { git } from './git';
import { KeyedQueue } from '../keyed-queue';
import { SLUG_RE } from '../../shared/slug';
import { errorMessage } from '../../shared/guards';

export class GitError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'GitError';
  }
}

const PROJECT = /^[A-Za-z0-9._-]+$/;
const fwd = (p: string): string => p.replace(/\\/g, '/');

/** The repository's common git dir (shared by every worktree), as an absolute path. */
export async function commonDir(repo: string): Promise<string> {
  const r = await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.code !== 0) throw new GitError('git.notRepo', r.stderr.trim());
  return r.stdout.trim();
}

const repoLocks = new KeyedQueue();

/**
 * One git-structure change at a time per repository (creating the project branch, adding a worktree, writing the repository config):
 * four agents launched at once would otherwise race on the same refs and config lock.
 */
export function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  return repoLocks.run(repo.replace(/\\/g, '/').toLowerCase(), fn);
}

/** The project branch `project/<project>` is where agents' work will land (merged in Phase 4); it starts at the current HEAD. */
export function ensureProjectBranch(repo: string, project: string): Promise<{ branch: string; created: boolean }> {
  return withRepoLock(repo, () => ensureProjectBranchUnlocked(repo, project));
}

async function ensureProjectBranchUnlocked(repo: string, project: string): Promise<{ branch: string; created: boolean }> {
  if (!PROJECT.test(project)) throw new GitError('git.badName', `invalid project name ${project}`);
  const branch = `project/${project}`;
  if ((await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) throw new GitError('git.noCommits');
  if ((await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) return { branch, created: false };
  const r = await git(repo, ['branch', branch, 'HEAD']);
  if (r.code !== 0) throw new GitError('git.failed', r.stderr.trim());
  return { branch, created: true };
}

/** Keeps the console's own folder out of every commit, without touching the project's .gitignore. */
export async function excludeConsoleFolder(repo: string): Promise<void> {
  const file = join(await commonDir(repo), 'info', 'exclude');
  mkdirSync(dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!text.split(/\r?\n/).some((l) => l.trim() === '.andromedaconsole/')) appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}.andromedaconsole/\n`);
}

export const agentBranchFor = (project: string, slug: string): string => `agent/${project}/${slug}`;

/**
 * The folder that holds a project's worktrees: `<project>/.andromedaconsole/worktrees`, one level deeper (`/<repo>`) when the project folder holds
 * several repositories. Everything the console makes for a project lives under its `.andromedaconsole`, so throwing the project away is one folder.
 */
export const worktreesDirFor = (projectRoot: string, repo: string): string => {
  const base = join(projectRoot, '.andromedaconsole', 'worktrees');
  return resolve(projectRoot).toLowerCase() === resolve(repo).toLowerCase() ? base : join(base, basename(repo));
};

/**
 * Where an agent's worktree goes: `<dir>/<slug>` (see `worktreesDirFor`). With no `dir` the earlier layout, `<repo>.worktrees/<slug>`,
 * a sibling of the repository: projects started before the move keep working, and so do callers that never pass one.
 */
export const worktreePathFor = (repo: string, slug: string, dir?: string): string =>
  dir !== undefined ? join(dir, slug) : join(dirname(repo), `${basename(repo)}.worktrees`, slug);

/** What would stop an agent from getting a worktree, found without creating anything. Undefined means it can be created. */
export async function checkSpawnable(o: { repo: string; project: string; slug: string; /** a reviewer: no branch of its own */ review?: boolean; dir?: string }): Promise<'git.notRepo' | 'git.noCommits' | 'git.worktreeExists' | undefined> {
  if ((await git(o.repo, ['rev-parse', '--git-dir'])).code !== 0) return 'git.notRepo';
  if ((await git(o.repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) return 'git.noCommits';
  if (existsSync(worktreePathFor(o.repo, o.slug, o.dir))) return 'git.worktreeExists';
  if (!o.review && (await git(o.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${agentBranchFor(o.project, o.slug)}`])).code === 0) return 'git.worktreeExists';
  return undefined;
}

/**
 * A checkout of one commit with no branch (`--detach`), in the same sibling folder as agent worktrees: where a reviewer reads the
 * delivered work (SPEC 15.3). With no branch there is nothing to commit to.
 */
export function createReviewWorktree(o: { repo: string; slug: string; sha: string; dir?: string }): Promise<{ path: string }> {
  return withRepoLock(o.repo, async () => {
    if (!SLUG_RE.test(o.slug)) throw new GitError('git.badName', `invalid slug ${o.slug}`);
    if (!/^[0-9a-f]{7,40}$/.test(o.sha)) throw new GitError('git.badName', `invalid commit ${o.sha}`);
    const path = worktreePathFor(o.repo, o.slug, o.dir);
    if (existsSync(path)) throw new GitError('git.worktreeExists', `folder ${path} already exists`);
    await addWorktree(o.repo, path, ['--detach', fwd(path), o.sha]);
    return { path };
  });
}

/** Undoes a worktree the console made for an agent that never got going: folder, branch and its hook folder. Safe to repeat. */
export async function discardAgentWorktree(o: { repo: string; slug: string; branch: string; path: string }): Promise<void> {
  await removeWorktree(o.repo, o.path);
  await git(o.repo, ['branch', '-D', o.branch]);
  try {
    rmSync(join(await commonDir(o.repo), 'console-hooks', o.slug), { recursive: true, force: true });
  } catch { /* nothing to remove */ }
}

/** `git worktree add` into `path` (whose parent folder is made first); a failure removes what it left, runs `undo` and throws. */
async function addWorktree(repo: string, path: string, args: string[], undo?: () => Promise<unknown>): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const added = await git(repo, ['worktree', 'add', '-q', ...args]);
  if (added.code === 0) return;
  await removeWorktree(repo, path);
  await undo?.();
  throw new GitError('git.failed', added.stderr.trim());
}

/** Keeps the console's folder out of the repository's status; when that fails the new worktree goes again (and `undo` runs). */
async function excludeOrRollback(repo: string, path: string, undo?: () => Promise<unknown>): Promise<void> {
  try {
    await excludeConsoleFolder(repo);
  } catch (e) {
    await removeWorktree(repo, path);
    await undo?.();
    throw new GitError('git.failed', errorMessage(e));
  }
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', fwd(path)]);
  // Node retries a folder that is still busy (EBUSY, EPERM, ENOTEMPTY: a handle that has not closed yet) before it gives up.
  if (existsSync(path)) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await git(repo, ['worktree', 'prune']);
}

/**
 * agent/<project>/<slug> from the project branch (or from `startPoint`), in <repo>.worktrees/<slug> (SPEC 9.2). Refuses an existing folder or branch;
 * anything it created is removed again if a later step fails.
 */
export function createAgentWorktree(o: { repo: string; project: string; slug: string; dir?: string; /** an existing branch to check out instead of a new one */ branch?: string; /** the branch the new one starts from (default the project branch) */ startPoint?: string }): Promise<{ path: string; branch: string }> {
  return withRepoLock(o.repo, () => (o.branch === undefined ? createAgentWorktreeUnlocked(o) : resumeBranchWorktreeUnlocked({ ...o, branch: o.branch })));
}

/**
 * A replacement agent continues a stopped one (SPEC 16.5): its own folder, the EXISTING branch of the stopped agent. Git refuses a
 * branch that another worktree has checked out, so the old worktree must be gone first. A failure removes the folder, never the branch.
 */
async function resumeBranchWorktreeUnlocked(o: { repo: string; project: string; slug: string; dir?: string; branch: string }): Promise<{ path: string; branch: string }> {
  if (!SLUG_RE.test(o.slug)) throw new GitError('git.badName', `invalid slug ${o.slug}`);
  if (!isBranchName(o.branch)) throw new GitError('git.badName', `invalid branch ${o.branch}`);
  const path = worktreePathFor(o.repo, o.slug, o.dir);
  if (existsSync(path)) throw new GitError('git.worktreeExists', `folder ${path} already exists`);
  if ((await git(o.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${o.branch}`])).code !== 0) throw new GitError('git.failed', `branch ${o.branch} does not exist`);
  await addWorktree(o.repo, path, [fwd(path), o.branch]);
  await excludeOrRollback(o.repo, path);
  return { path, branch: o.branch };
}

/** A branch name the console may pass to git as an argument (no option, no odd characters). */
const isBranchName = (b: string): boolean => /^[A-Za-z0-9._/-]+$/.test(b) && !b.startsWith('-');

async function createAgentWorktreeUnlocked(o: { repo: string; project: string; slug: string; dir?: string; startPoint?: string }): Promise<{ path: string; branch: string }> {
  if (!SLUG_RE.test(o.slug)) throw new GitError('git.badName', `invalid slug ${o.slug}`);
  if (o.startPoint !== undefined && !isBranchName(o.startPoint)) throw new GitError('git.badName', `invalid branch ${o.startPoint}`);
  const project = await ensureProjectBranchUnlocked(o.repo, o.project);
  // An agent started after another one (`spawn_agent after`) branches from that agent's branch, so it sees its committed work.
  const from = o.startPoint ?? project.branch;
  if (o.startPoint !== undefined && (await git(o.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${o.startPoint}`])).code !== 0) {
    throw new GitError('git.failed', `branch ${o.startPoint} does not exist`);
  }
  const branch = agentBranchFor(o.project, o.slug);
  const path = worktreePathFor(o.repo, o.slug, o.dir);
  if (existsSync(path)) throw new GitError('git.worktreeExists', `folder ${path} already exists`);
  if ((await git(o.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) {
    throw new GitError('git.worktreeExists', `branch ${branch} already exists`);
  }
  const undo = (): Promise<unknown> => git(o.repo, ['branch', '-D', branch]);
  await addWorktree(o.repo, path, ['-b', branch, fwd(path), from], undo);
  await excludeOrRollback(o.repo, path, undo);
  return { path, branch };
}
