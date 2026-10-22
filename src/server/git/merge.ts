import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { identityArgs } from './commit';
import { git } from './git';
import { KeyedQueue } from '../keyed-queue';
import { ensureProjectBranch, withRepoLock } from './worktree';
import { ignoreConsoleFolderAbove } from './console-folder';
import type { ChangedFile } from '../tickets/report';
import { errorMessage } from '../../shared/guards';
import { canonicalFolder } from '../canonical-path';

const fwd = (p: string): string => p.replace(/\\/g, '/');
const same = (a: string, b: string): boolean => fwd(canonicalFolder(a)).toLowerCase() === fwd(canonicalFolder(b)).toLowerCase();

/**
 * What a branch changed since it left its base (`base...head`, three dots: the merge base, not the base tip), with line counts;
 * a binary file has no counts. Renames are shown as a delete and an add, so every path is a real path.
 */
export async function changedFiles(cwd: string, base: string, head: string): Promise<ChangedFile[] | undefined> {
  const r = await git(cwd, ['diff', '--numstat', '--no-renames', '-z', `${base}...${head}`]);
  if (r.code !== 0) return undefined;
  const files: ChangedFile[] = [];
  for (const rec of r.stdout.split('\0')) {
    if (rec === '') continue;
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    files.push({ path: m[3]!, added: binary ? null : Number(m[1]), removed: binary ? null : Number(m[2]) });
  }
  return files;
}

const projectLocks = new KeyedQueue();

/**
 * One user of the console's `.project` worktree at a time: a merge (which stages, commits and runs the tests there) and a release
 * proposal (which runs the tests there) must not reset or clean it under each other.
 */
export function withProjectLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  return projectLocks.run(fwd(repo).toLowerCase(), fn);
}

/** The console's own worktree on the project branch, where tickets are merged. A leading dot can never be an agent's name. */
export const projectWorktreePath = (repo: string, dir?: string): string => {
  const earlier = join(dirname(repo), `${basename(repo)}.worktrees`, '.project');
  // An existing checkout in the earlier layout (a project started before the move) is kept; a new one goes under the project's .andromedaconsole.
  return dir === undefined || existsSync(earlier) ? earlier : join(dir, '.project');
};

export type ProjectWorktree = { ok: true; path: string } | { ok: false; code: 'project_branch_checked_out' | 'git_failed'; detail?: string };

/**
 * Makes sure `<project>/.andromedaconsole/worktrees/.project` (earlier projects: `<repo>.worktrees/.project`) is a clean checkout of `project/<project>`: created when missing, and any half-done merge left by
 * a crash is thrown away (the worktree is the console's own and its branch tip is committed state). Refuses when somebody else
 * (the user's checkout) has the project branch checked out, because a branch cannot be checked out twice.
 */
export async function ensureProjectWorktree(repo: string, project: string, dir?: string): Promise<ProjectWorktree> {
  try {
    await ensureProjectBranch(repo, project);
  } catch (e) {
    return { ok: false, code: 'git_failed', detail: errorMessage(e) };
  }
  return withRepoLock(repo, async () => {
    const branch = `project/${project}`;
    const path = projectWorktreePath(repo, dir);
    await git(repo, ['worktree', 'prune']); // a folder somebody deleted must not stay registered: that would block every merge
    const listed = await git(repo, ['worktree', 'list', '--porcelain']);
    if (listed.code !== 0) return { ok: false, code: 'git_failed', detail: listed.stderr.trim() } as const;
    const entries = listed.stdout.split(/\r?\n\r?\n/).map((block) => ({
      path: /^worktree (.+)$/m.exec(block)?.[1] ?? '', branch: /^branch (.+)$/m.exec(block)?.[1],
    }));
    if (entries.some((e) => e.branch === `refs/heads/${branch}` && !same(e.path, path))) return { ok: false, code: 'project_branch_checked_out' } as const;
    if (!entries.some((e) => same(e.path, path))) {
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
      await git(repo, ['worktree', 'prune']);
      const added = await git(repo, ['worktree', 'add', '-q', fwd(path), branch]);
      if (added.code !== 0) return { ok: false, code: /already (checked out|used)/i.test(added.stderr) ? 'project_branch_checked_out' : 'git_failed', detail: added.stderr.trim() } as const;
      ignoreConsoleFolderAbove(path); // the project's .andromedaconsole carries its own .gitignore
    }
    await git(path, ['merge', '--abort']); // fails when there is nothing to abort: fine
    await git(path, ['reset', '--hard', '-q']);
    await git(path, ['clean', '-fdq']);
    const head = await git(path, ['symbolic-ref', '-q', 'HEAD']);
    if (head.stdout.trim() !== `refs/heads/${branch}`) {
      const co = await git(path, ['checkout', '-q', branch]);
      if (co.code !== 0) return { ok: false, code: 'git_failed', detail: co.stderr.trim() } as const;
    }
    return { ok: true, path } as const;
  });
}

export type MergeOutcome = { ok: true; sha: string } | { ok: false; kind: 'conflict'; files: string[] } | { ok: false; kind: 'failed'; detail: string };

/** Commits what a merge has staged, with a message the console wrote (through a file, so any text is safe). */
async function commitStaged(cwd: string, message: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  const dir = join(tmpdir(), 'andromedaconsole-merge'); // not in the repository: nothing of the console is left in its .git
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `merge-msg-${process.pid}-${Date.now()}.txt`);
  writeFileSync(file, message, 'utf8');
  try {
    const r = await git(cwd, [...(await identityArgs(cwd)), 'commit', '--allow-empty', '--no-verify', '-q', '-F', fwd(file)]);
    return r.code === 0 ? { ok: true } : { ok: false, detail: `${r.stderr}\n${r.stdout}`.trim() };
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * Merges `sha` into the branch checked out in `wt` (the console's project worktree): squashed into one commit, or kept behind a merge
 * commit. On a conflict nothing is forced: the worktree is put back exactly where it was and the conflicting files are returned.
 */
export async function mergeIntoProject(o: { wt: string; sha: string; message: string; squash: boolean; /** squash only what came after this commit (a dependent ticket) */ base?: string }): Promise<MergeOutcome> {
  const prevRes = await git(o.wt, ['rev-parse', 'HEAD']);
  if (prevRes.code !== 0) return { ok: false, kind: 'failed', detail: prevRes.stderr.trim() };
  const prev = prevRes.stdout.trim();
  if (o.squash && o.base !== undefined) return squashFromBase({ ...o, base: o.base, prev });
  const merged = await git(o.wt, ['merge', ...(o.squash ? ['--squash'] : ['--no-ff']), '--no-commit', o.sha]);
  if (merged.code !== 0) {
    const files = (await git(o.wt, ['diff', '--name-only', '--diff-filter=U'])).stdout.split(/\r?\n/).filter(Boolean);
    await git(o.wt, ['merge', '--abort']);
    await git(o.wt, ['reset', '--hard', '-q', prev]);
    return files.length > 0 ? { ok: false, kind: 'conflict', files } : { ok: false, kind: 'failed', detail: `${merged.stderr}\n${merged.stdout}`.trim() };
  }
  const committed = await commitStaged(o.wt, o.message);
  if (!committed.ok) {
    await git(o.wt, ['merge', '--abort']);
    await git(o.wt, ['reset', '--hard', '-q', prev]);
    return { ok: false, kind: 'failed', detail: committed.detail };
  }
  const tip = await git(o.wt, ['rev-parse', 'HEAD']);
  return { ok: true, sha: tip.stdout.trim() };
}

/**
 * The squash of a ticket started after another one (`spawn_agent after`): a three-way merge whose base is the commit the branch started
 * from, so only the ticket's own changes are applied; the other agent's commits came in through that agent's own (squash) merge, and its
 * later changes to the same files are no conflict. `git merge-tree --write-tree` (git 2.40 or later for `--merge-base`) computes it in
 * memory: on a conflict nothing in the worktree has changed. A clean result is checked out (`read-tree -m -u`) and committed.
 */
async function squashFromBase(o: { wt: string; sha: string; message: string; base: string; prev: string }): Promise<MergeOutcome> {
  // -z: names come raw, NUL-separated (without it git quotes a name that is not plain ASCII).
  const tree = await git(o.wt, ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', `--merge-base=${o.base}`, o.prev, o.sha]);
  const lines = nulList(tree.stdout);
  if (tree.code === 1 && lines.length > 1) return { ok: false, kind: 'conflict', files: [...new Set(lines.slice(1))] };
  if (tree.code === 129 || /unknown option|usage: git merge-tree/i.test(tree.stderr)) {
    const said = tree.stderr.trim().split(/\r?\n/)[0] ?? '';
    return { ok: false, kind: 'failed', detail: `merging a ticket started after another one needs git 2.40 or later (git merge-tree --merge-base); this git refused it: ${said}` };
  }
  if (tree.code !== 0 || !/^[0-9a-f]{40,64}$/.test(lines[0] ?? '')) return { ok: false, kind: 'failed', detail: `${tree.stderr}\n${tree.stdout}`.trim() };
  const undo = async (): Promise<void> => { await git(o.wt, ['reset', '--hard', '-q', o.prev]); await git(o.wt, ['clean', '-fdq']); };
  const read = await git(o.wt, ['read-tree', '-m', '-u', o.prev, lines[0]!]);
  if (read.code !== 0) { await undo(); return { ok: false, kind: 'failed', detail: read.stderr.trim() }; }
  const committed = await commitStaged(o.wt, o.message);
  if (!committed.ok) { await undo(); return { ok: false, kind: 'failed', detail: committed.detail }; }
  const tip = await git(o.wt, ['rev-parse', 'HEAD']);
  return { ok: true, sha: tip.stdout.trim() };
}

/** Puts the worktree back on a commit it was at before (used when the merged tests turn red). Only for the console's own worktree. */
export async function resetTo(wt: string, sha: string): Promise<void> {
  await git(wt, ['reset', '--hard', '-q', sha]);
  await git(wt, ['clean', '-fdq']);
}

/**
 * Starts the merge of the project branch into an author's branch, inside the author's worktree, and leaves it in the conflict state.
 * Agents may not run `git merge` (the guard refuses it), so the console prepares the conflict and the author only edits the files
 * and closes its steps: the next console commit concludes the merge.
 */
export async function startMergeForAuthor(cwd: string, projectBranch: string): Promise<string[]> {
  await git(cwd, ['merge', '--no-ff', '--no-commit', projectBranch]);
  return unmergedIn(cwd);
}

/** The files of a worktree that are in conflict (unmerged), raw names. */
export async function unmergedIn(cwd: string): Promise<string[]> {
  return nulList((await git(cwd, ['diff', '--name-only', '-z', '--diff-filter=U'])).stdout);
}

/** A `-z` list: NUL-separated names (a stray line break around an entry, as some git versions add, is dropped). */
function nulList(out: string): string[] {
  return [...new Set(out.split('\0').map((l) => l.replace(/^[\r\n]+|[\r\n]+$/g, '')).filter(Boolean))];
}

/**
 * The author side of a conflict for a ticket started after another one (`spawn_agent after`). The author's merge of the project branch
 * has the ordinary merge base, which predates the other agent's squash merge, so the other agent's files (changed again after this
 * branch started) conflict or come back stale. Every path this ticket did not change itself (`base..delivered`) is set to the project
 * branch's version (or removed when the project branch has none): only the files the ticket really shares with others stay in
 * conflict. Returns the files still unmerged.
 */
export async function keepProjectOutsideOwnWork(o: { cwd: string; projectBranch: string; base: string; delivered: string; unmerged: string[] }): Promise<string[]> {
  const own = new Set(nulList((await git(o.cwd, ['diff', '--name-only', '-z', '--no-renames', o.base, o.delivered])).stdout));
  const differing = nulList((await git(o.cwd, ['diff', '--name-only', '-z', '--no-renames', o.projectBranch])).stdout);
  const failed: string[] = [];
  for (const path of new Set([...o.unmerged, ...differing])) {
    if (own.has(path)) continue;
    const onProject = (await git(o.cwd, ['cat-file', '-e', `${o.projectBranch}:${path}`])).code === 0;
    const args = onProject ? ['--literal-pathspecs', 'checkout', o.projectBranch, '--', path] : ['--literal-pathspecs', 'rm', '-q', '-f', '--', path];
    // Git is flaky under load on Windows: one retry, and a path that still fails stays in the list instead of being left stale unnoticed.
    if ((await git(o.cwd, args)).code !== 0 && (await git(o.cwd, args)).code !== 0) failed.push(path);
  }
  return [...new Set([...(await unmergedIn(o.cwd)), ...failed])];
}
