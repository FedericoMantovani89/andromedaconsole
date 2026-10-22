import { it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentWorktree } from '../src/server/git/worktree';
import { hooksDirFor, pushHookEnv } from '../src/server/git/hooks';
import { git } from '../src/server/git/git';
import { makeRepo, gitSync, branchesOf } from './git-helpers';

/** A worktree with its push hook, the way a session gets it: the script under the project's .andromedaconsole, git pointed at it by the environment. */
async function setup() {
  const t = makeRepo({ remote: true });
  const wt = await createAgentWorktree({ repo: t.repo, project: 'shop-api', slug: 'fix-login' });
  const env = pushHookEnv({ projectRoot: t.repo, branch: wt.branch, slug: 'fix-login', base: {} });
  const commit = (msg: string) => {
    writeFileSync(join(wt.path, `f-${Math.random().toString(36).slice(2)}.txt`), msg);
    gitSync(wt.path, 'add', '-A');
    gitSync(wt.path, '-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '-m', msg);
  };
  const push = (...args: string[]) => git(wt.path, ['push', ...args], { env });
  return { ...t, wt, env, commit, push };
}

it('allows the push of the agent\'s own branch', async () => {
  const { remote, commit, push } = await setup();
  commit('one');
  const r = await push('origin', 'HEAD');
  expect(r.code, r.stderr).toBe(0);
  expect(branchesOf(remote)).toContain('agent/shop-api/fix-login');
});
it('refuses any other ref (another branch name, main)', async () => {
  const { remote, commit, push } = await setup();
  commit('one');
  for (const ref of ['HEAD:refs/heads/other', 'HEAD:refs/heads/main', 'HEAD:refs/heads/project/shop-api']) {
    const r = await push('origin', ref);
    expect(r.code, ref).not.toBe(0);
    expect(r.stderr).toMatch(/refusing/);
  }
  expect(branchesOf(remote)).toEqual(['main']);
});
it('refuses --force and --force-with-lease after history was rewritten', async () => {
  const { wt, remote, commit, push } = await setup();
  commit('one');
  expect((await push('origin', 'HEAD')).code).toBe(0);
  gitSync(wt.path, '-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '--amend', '-q', '-m', 'rewritten');
  for (const flag of ['--force', '--force-with-lease']) {
    const r = await push(flag, 'origin', 'HEAD');
    expect(r.code, flag).not.toBe(0);
  }
  expect(gitSync(remote, 'log', '-1', '--format=%s', 'agent/shop-api/fix-login')).toBe('one');
});
it('refuses deleting a remote branch and pushing tags', async () => {
  const { wt, remote, commit, push } = await setup();
  commit('one');
  await push('origin', 'HEAD');
  expect((await push('origin', ':agent/shop-api/fix-login')).code).not.toBe(0);
  gitSync(wt.path, 'tag', 'v1');
  expect((await push('origin', 'v1')).code).not.toBe(0);
  expect(branchesOf(remote)).toEqual(['agent/shop-api/fix-login', 'main']);
});
it('does not touch the main worktree, nor a git command that runs without the session\'s environment', async () => {
  const { repo, wt, remote, commit } = await setup();
  commit('one');
  const r = await git(repo, ['push', 'origin', 'HEAD:refs/heads/free']);
  expect(r.code, r.stderr).toBe(0);
  expect((await git(wt.path, ['push', 'origin', 'HEAD:refs/heads/also-free'])).code).toBe(0); // the user's own terminal in the folder
  expect(branchesOf(remote)).toEqual(expect.arrayContaining(['free', 'also-free']));
});
it('puts nothing in the user\'s repository: the script is under .andromedaconsole, the repo config is untouched', async () => {
  const { repo, wt, env } = await setup();
  const script = join(hooksDirFor(repo, 'fix-login'), 'pre-push');
  expect(script).toBe(join(repo, '.andromedaconsole', 'state', 'hooks', 'fix-login', 'pre-push'));
  expect(readFileSync(script, 'utf8')).toContain('agent/shop-api/fix-login');
  expect(existsSync(join(repo, '.git', 'console-hooks'))).toBe(false);
  expect((await git(repo, ['config', '--local', '--get', 'extensions.worktreeConfig'])).code).not.toBe(0);
  expect((await git(wt.path, ['config', '--get', 'core.hooksPath'])).code).not.toBe(0);
  expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
});
it('is bound to that session only: another agent\'s environment names its own script', async () => {
  const { repo } = await setup();
  const a = pushHookEnv({ projectRoot: repo, branch: 'agent/shop-api/other-job', slug: 'other-job', base: {} });
  expect(a.GIT_CONFIG_VALUE_0).toContain('/hooks/other-job');
});
it('is added after a GIT_CONFIG_COUNT the user already set', async () => {
  const t = makeRepo();
  const env = pushHookEnv({ projectRoot: t.repo, branch: 'agent/p/a-job', slug: 'a-job', base: { GIT_CONFIG_COUNT: '2' } });
  expect(env).toMatchObject({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'core.hooksPath' });
  expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
  expect(pushHookEnv({ projectRoot: t.repo, branch: 'agent/p/a-job', slug: 'a-job', base: { GIT_CONFIG_COUNT: 'x' } }).GIT_CONFIG_COUNT).toBe('1');
});
it('rejects a branch name that could inject shell into the hook script', async () => {
  const t = makeRepo({ remote: true });
  expect(() => pushHookEnv({ projectRoot: t.repo, branch: 'x"; rm -rf /; "', slug: 'a-job' })).toThrow(/branch/);
  expect(() => pushHookEnv({ projectRoot: t.repo, branch: 'agent/p/a', slug: '../evil' })).toThrow(/slug/);
});
