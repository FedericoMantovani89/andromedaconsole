import { it, expect } from 'vitest';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { ensureProjectBranch, createAgentWorktree, dropLegacyExclude, removeWorktree, GitError } from '../src/server/git/worktree';
import { git } from '../src/server/git/git';
import { makeRepo, gitSync } from './git-helpers';

it('creates the project branch from HEAD once, and is idempotent', async () => {
  const { repo } = makeRepo();
  const first = await ensureProjectBranch(repo, 'shop-api');
  expect(first).toEqual({ branch: 'project/shop-api', created: true });
  expect(gitSync(repo, 'rev-parse', 'project/shop-api')).toBe(gitSync(repo, 'rev-parse', 'HEAD'));
  expect(await ensureProjectBranch(repo, 'shop-api')).toEqual({ branch: 'project/shop-api', created: false });
});
it('refuses a repository without any commit', async () => {
  const { repo } = makeRepo({ commit: false });
  await expect(ensureProjectBranch(repo, 'shop-api')).rejects.toMatchObject({ code: 'git.noCommits' });
});
it('creates agent/<project>/<slug> from the project branch in a sibling folder, even when the repo path has a space', async () => {
  const { repo } = makeRepo();
  const wt = await createAgentWorktree({ repo, project: 'shop-api', slug: 'fix-login' });
  expect(wt.branch).toBe('agent/shop-api/fix-login');
  expect(wt.path).toBe(join(dirname(repo), `${basename(repo)}.worktrees`, 'fix-login'));
  expect(existsSync(join(wt.path, 'README.md'))).toBe(true);
  expect(gitSync(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent/shop-api/fix-login');
  expect(gitSync(wt.path, 'rev-parse', 'HEAD')).toBe(gitSync(repo, 'rev-parse', 'project/shop-api'));
});
it('ignores the .andromedaconsole folder of a worktree through a .gitignore inside it, and writes nothing in the repo exclude file', async () => {
  const { repo } = makeRepo();
  await createAgentWorktree({ repo, project: 'p-one', slug: 'a-job' });
  await createAgentWorktree({ repo, project: 'p-one', slug: 'b-job' });
  const exclude = join(repo, '.git', 'info', 'exclude');
  expect(existsSync(exclude) ? readFileSync(exclude, 'utf8') : '').not.toContain('.andromedaconsole');
  const wt = join(dirname(repo), `${basename(repo)}.worktrees`, 'a-job');
  expect(readFileSync(join(wt, '.andromedaconsole', '.gitignore'), 'utf8')).toBe('*\n');
  writeFileSync(join(wt, '.andromedaconsole', 'checklist.md'), 'x');
  expect(gitSync(wt, 'status', '--porcelain')).toBe('');
});
it('dropLegacyExclude takes the line of earlier versions away and keeps the rest of the file', async () => {
  const { repo } = makeRepo();
  const exclude = join(repo, '.git', 'info', 'exclude');
  mkdirSync(dirname(exclude), { recursive: true });
  writeFileSync(exclude, '# mine\n*.log\n.andromedaconsole/\n');
  await dropLegacyExclude(repo);
  expect(readFileSync(exclude, 'utf8')).toBe('# mine\n*.log\n');
  await dropLegacyExclude(repo); // again: nothing to do
  expect(readFileSync(exclude, 'utf8')).toBe('# mine\n*.log\n');
});
it('refuses an existing folder or branch and leaves nothing behind', async () => {
  const { repo } = makeRepo();
  const folder = join(dirname(repo), `${basename(repo)}.worktrees`, 'taken-job');
  mkdirSync(folder, { recursive: true });
  await expect(createAgentWorktree({ repo, project: 'p-one', slug: 'taken-job' })).rejects.toMatchObject({ code: 'git.worktreeExists' });
  expect(gitSync(repo, 'branch', '--list', 'agent/p-one/taken-job')).toBe('');
  await createAgentWorktree({ repo, project: 'p-one', slug: 'other-job' });
  await removeWorktree(repo, join(dirname(repo), `${basename(repo)}.worktrees`, 'other-job'));
  // the branch of the removed worktree still exists (the work is the branch), so the same name is refused
  await expect(createAgentWorktree({ repo, project: 'p-one', slug: 'other-job' })).rejects.toBeInstanceOf(GitError);
});
it('createAgentWorktree with an existing branch checks it out (a replacement agent continues the same work)', async () => {
  const { repo } = makeRepo();
  const first = await createAgentWorktree({ repo, project: 'p-one', slug: 'fix-x' });
  writeFileSync(join(first.path, 'wip.txt'), 'half\n');
  gitSync(first.path, 'add', '-A');
  gitSync(first.path, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'wip');
  const wip = gitSync(first.path, 'rev-parse', 'HEAD');
  // git refuses a second worktree on a branch that is checked out: the old one goes first
  await expect(createAgentWorktree({ repo, project: 'p-one', slug: 'fix-x-r2', branch: first.branch })).rejects.toBeInstanceOf(GitError);
  expect(existsSync(join(dirname(repo), `${basename(repo)}.worktrees`, 'fix-x-r2'))).toBe(false);
  expect(gitSync(repo, 'rev-parse', first.branch)).toBe(wip); // the failed attempt did not touch the branch
  await removeWorktree(repo, first.path);
  const next = await createAgentWorktree({ repo, project: 'p-one', slug: 'fix-x-r2', branch: first.branch });
  expect(next).toEqual({ path: join(dirname(repo), `${basename(repo)}.worktrees`, 'fix-x-r2'), branch: 'agent/p-one/fix-x' });
  expect(gitSync(next.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent/p-one/fix-x');
  expect(gitSync(next.path, 'rev-parse', 'HEAD')).toBe(wip);
  expect(readFileSync(join(next.path, 'wip.txt'), 'utf8')).toBe('half\n');
  expect(gitSync(repo, 'branch', '--list', 'agent/p-one/fix-x-r2')).toBe(''); // no branch of its own
});
it('createAgentWorktree with a branch that does not exist refuses and creates nothing', async () => {
  const { repo } = makeRepo();
  await expect(createAgentWorktree({ repo, project: 'p-one', slug: 'ghost-job', branch: 'agent/p-one/nobody' })).rejects.toMatchObject({ code: 'git.failed' });
  expect(existsSync(join(dirname(repo), `${basename(repo)}.worktrees`, 'ghost-job'))).toBe(false);
  expect(gitSync(repo, 'branch', '--list', 'agent/p-one/*')).toBe('');
});
it('removeWorktree takes the folder away and keeps the branch', async () => {
  const { repo } = makeRepo();
  const wt = await createAgentWorktree({ repo, project: 'p-one', slug: 'gone-job' });
  await removeWorktree(repo, wt.path);
  expect(existsSync(wt.path)).toBe(false);
  expect(gitSync(repo, 'branch', '--list', 'agent/p-one/gone-job')).toContain('agent/p-one/gone-job');
});
it('git() never throws and reports the exit code', async () => {
  const { repo } = makeRepo();
  const r = await git(repo, ['rev-parse', '--verify', 'refs/heads/nope']);
  expect(r.code).not.toBe(0);
  const ok = await git(repo, ['rev-parse', 'HEAD']);
  expect(ok.code).toBe(0);
  expect(ok.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
});

import { agentBranchFor, worktreePathFor, discardAgentWorktree, checkSpawnable } from '../src/server/git/worktree';

it('names the worktree and the branch in one place', () => {
  expect(agentBranchFor('shop-api', 'fix-login')).toBe('agent/shop-api/fix-login');
  const repo = join('D:', 'w', 'my repo');
  expect(worktreePathFor(repo, 'fix-login')).toBe(join(dirname(repo), 'my repo.worktrees', 'fix-login'));
});
it('checkSpawnable reports notRepo, noCommits and worktreeExists without creating anything', async () => {
  const empty = makeRepo({ commit: false });
  expect(await checkSpawnable({ repo: empty.repo, project: 'p-one', slug: 'a-job' })).toBe('git.noCommits');
  const plain = join(empty.base, 'plain');
  mkdirSync(plain);
  expect(await checkSpawnable({ repo: plain, project: 'p-one', slug: 'a-job' })).toBe('git.notRepo');
  const { repo } = makeRepo();
  expect(await checkSpawnable({ repo, project: 'p-one', slug: 'a-job' })).toBeUndefined();
  expect(gitSync(repo, 'branch', '--list', 'project/*')).toBe(''); // nothing was created
  await createAgentWorktree({ repo, project: 'p-one', slug: 'a-job' });
  expect(await checkSpawnable({ repo, project: 'p-one', slug: 'a-job' })).toBe('git.worktreeExists');
});
it('checkSpawnable sees a leftover branch and a leftover folder separately', async () => {
  const { repo } = makeRepo();
  gitSync(repo, 'branch', 'agent/p-one/only-branch');
  expect(await checkSpawnable({ repo, project: 'p-one', slug: 'only-branch' })).toBe('git.worktreeExists');
  mkdirSync(worktreePathFor(repo, 'only-folder'), { recursive: true });
  expect(await checkSpawnable({ repo, project: 'p-one', slug: 'only-folder' })).toBe('git.worktreeExists');
});
it('discardAgentWorktree removes folder, branch and the hook folder of earlier versions, and is safe to repeat', async () => {
  const { repo } = makeRepo();
  const wt = await createAgentWorktree({ repo, project: 'p-one', slug: 'a-job' });
  const hooks = join(repo, '.git', 'console-hooks', 'a-job'); // where earlier versions kept the script
  mkdirSync(hooks, { recursive: true });
  expect(existsSync(hooks)).toBe(true);
  await discardAgentWorktree({ repo, slug: 'a-job', branch: wt.branch, path: wt.path });
  expect(existsSync(wt.path)).toBe(false);
  expect(existsSync(hooks)).toBe(false);
  expect(gitSync(repo, 'branch', '--list', 'agent/*')).toBe('');
  await discardAgentWorktree({ repo, slug: 'a-job', branch: wt.branch, path: wt.path });
});

it('four agents started at the same moment on a fresh repository all get their worktree (review finding: project branch race)', async () => {
  const { repo } = makeRepo();
  const slugs = ['first-job', 'second-job', 'third-job', 'fourth-job'];
  const made = await Promise.all(slugs.map((slug) => createAgentWorktree({ repo, project: 'p-one', slug })));
  expect(made.map((m) => m.branch).sort()).toEqual(slugs.map((s) => `agent/p-one/${s}`).sort());
  expect(gitSync(repo, 'branch', '--list', 'project/*').trim()).toBe('project/p-one');
});
it('ensureProjectBranch called twice at once creates the branch once and reports success both times', async () => {
  const { repo } = makeRepo();
  const [a, b] = await Promise.all([ensureProjectBranch(repo, 'p-one'), ensureProjectBranch(repo, 'p-one')]);
  expect([a.branch, b.branch]).toEqual(['project/p-one', 'project/p-one']);
  expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
});
