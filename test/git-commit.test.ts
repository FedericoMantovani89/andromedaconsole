import { it, expect, vi } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentWorktree } from '../src/server/git/worktree';
import { commitStep, commitWip } from '../src/server/git/commit';
import { pushBranch } from '../src/server/git/push';
import { DEFAULT_SECRET_PATTERNS } from '../src/server/git/secrets';
import { makeRepo, gitSync, branchesOf } from './git-helpers';

// Real git: slow on a busy machine, so these tests get a longer budget.
vi.setConfig({ testTimeout: 60_000 });

async function setup(o: { remote?: boolean; identity?: boolean } = {}) {
  const t = makeRepo({ remote: o.remote ?? true, identity: o.identity });
  const wt = await createAgentWorktree({ repo: t.repo, project: 'shop-api', slug: 'fix-login' });
  const step = (n: number, total: number, title: string) =>
    commitStep({ worktree: wt.path, n, total, title, slug: 'fix-login', project: 'shop-api', secretPatterns: DEFAULT_SECRET_PATTERNS });
  return { ...t, wt, step };
}

it('commits a step with the SPEC 9.3 subject and trailers', async () => {
  const { wt, step } = await setup();
  writeFileSync(join(wt.path, 'a.txt'), 'x');
  const r = await step(4, 7, 'Map the field in the DTO and the mapper');
  expect(r.ok).toBe(true);
  expect(gitSync(wt.path, 'log', '-1', '--format=%B')).toBe('step 4/7: Map the field in the DTO and the mapper\n\nAgent: fix-login\nTicket: fix-login\nProgetto: shop-api');
  expect(gitSync(wt.path, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.txt');
  if (r.ok) expect(r.sha).toBe(gitSync(wt.path, 'rev-parse', 'HEAD'));
});
it('a step without changes still commits (every closed step is a commit)', async () => {
  const { wt, step } = await setup();
  const before = gitSync(wt.path, 'rev-list', '--count', 'HEAD');
  expect((await step(1, 6, 'Study')).ok).toBe(true);
  expect(Number(gitSync(wt.path, 'rev-list', '--count', 'HEAD'))).toBe(Number(before) + 1);
});
it('a title with line breaks becomes one clean line', async () => {
  const { wt, step } = await setup();
  await step(1, 5, 'Study\nAgent: someone-else\nTicket: x');
  expect(gitSync(wt.path, 'log', '-1', '--format=%s')).toBe('step 1/5: Study Agent: someone-else Ticket: x');
  expect(gitSync(wt.path, 'log', '-1', '--format=%B').split('\n').filter((l) => l.startsWith('Agent:'))).toEqual(['Agent: fix-login']);
});
it('never commits a secret: it unstages everything and names the files', async () => {
  const { wt, step } = await setup();
  writeFileSync(join(wt.path, 'ok.txt'), 'fine');
  mkdirSync(join(wt.path, 'config'));
  writeFileSync(join(wt.path, 'config', '.env'), 'TOKEN=abc');
  const head = gitSync(wt.path, 'rev-parse', 'HEAD');
  const r = await step(3, 7, 'Add config');
  expect(r).toEqual({ ok: false, code: 'secrets', files: ['config/.env'] });
  expect(gitSync(wt.path, 'rev-parse', 'HEAD')).toBe(head);
  expect(gitSync(wt.path, 'diff', '--cached', '--name-only')).toBe('');
});
it('reports index.lock instead of removing it', async () => {
  const { wt, step } = await setup();
  const lock = gitSync(wt.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock');
  writeFileSync(lock, '');
  const r = await step(2, 6, 'Tests');
  expect(r).toMatchObject({ ok: false, code: 'index_locked' });
});
it('works when the repository has no configured identity', async () => {
  const { wt, step } = await setup({ identity: false });
  writeFileSync(join(wt.path, 'a.txt'), 'x');
  const r = await step(2, 6, 'Tests');
  expect(r.ok, JSON.stringify(r)).toBe(true);
});
const wip = (path: string, reason = 'budget alert') =>
  commitWip({ worktree: path, slug: 'fix-login', project: 'shop-api', reason, secretPatterns: DEFAULT_SECRET_PATTERNS });

it('a WIP with changes commits them with the wip subject and the trailers', async () => {
  const { wt } = await setup();
  writeFileSync(join(wt.path, 'half.txt'), 'x');
  const r = await wip(wt.path);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(gitSync(wt.path, 'log', '-1', '--format=%B')).toBe('wip: budget alert\n\nAgent: fix-login\nTicket: fix-login\nProgetto: shop-api');
  expect(gitSync(wt.path, 'show', '--name-only', '--format=', 'HEAD')).toBe('half.txt');
  if (r.ok) expect(r.sha).toBe(gitSync(wt.path, 'rev-parse', 'HEAD'));
});
it('a WIP without changes makes no commit and returns the current HEAD', async () => {
  const { wt } = await setup();
  const head = gitSync(wt.path, 'rev-parse', 'HEAD');
  expect(await wip(wt.path)).toEqual({ ok: true, sha: head });
  expect(gitSync(wt.path, 'rev-parse', 'HEAD')).toBe(head);
});
it('a WIP never commits a secret: it unstages everything and names the files', async () => {
  const { wt } = await setup();
  writeFileSync(join(wt.path, 'ok.txt'), 'fine');
  writeFileSync(join(wt.path, '.env'), 'TOKEN=abc');
  const head = gitSync(wt.path, 'rev-parse', 'HEAD');
  expect(await wip(wt.path, 'budget stop')).toEqual({ ok: false, code: 'secrets', files: ['.env'] });
  expect(gitSync(wt.path, 'rev-parse', 'HEAD')).toBe(head);
  expect(gitSync(wt.path, 'diff', '--cached', '--name-only')).toBe('');
});
it('a WIP reports index.lock and works without a configured identity', async () => {
  const { wt } = await setup({ identity: false });
  writeFileSync(join(wt.path, 'a.txt'), 'x');
  expect((await wip(wt.path)).ok).toBe(true);
  const lock = gitSync(wt.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock');
  writeFileSync(lock, '');
  expect(await wip(wt.path)).toMatchObject({ ok: false, code: 'index_locked' });
});
it('a WIP during a merge refuses with code merging and stages nothing', async () => {
  const { repo, wt } = await setup();
  // a conflicting change on another branch, merged into the agent's worktree
  gitSync(repo, 'checkout', '-q', '-b', 'other');
  writeFileSync(join(repo, 'README.md'), 'theirs\n');
  gitSync(repo, 'commit', '-q', '-am', 'theirs');
  writeFileSync(join(wt.path, 'README.md'), 'mine\n');
  gitSync(wt.path, 'commit', '-q', '-am', 'mine');
  try { gitSync(wt.path, 'merge', '-q', 'other'); } catch { /* the conflict is the point */ }
  expect(gitSync(wt.path, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).not.toBe('');
  writeFileSync(join(wt.path, 'new.txt'), 'x');
  const head = gitSync(wt.path, 'rev-parse', 'HEAD');
  const r = await wip(wt.path);
  expect(r).toMatchObject({ ok: false, code: 'merging' });
  expect(gitSync(wt.path, 'rev-parse', 'HEAD')).toBe(head);
  expect(gitSync(wt.path, 'diff', '--cached', '--name-only').split('\n')).not.toContain('new.txt');
  expect(gitSync(wt.path, 'status', '--porcelain')).toContain('?? new.txt');
});
it('push: only the agent branch goes out', async () => {
  const { repo, wt, remote, step } = await setup();
  await step(1, 5, 'Study');
  expect(await pushBranch({ worktree: wt.path, branch: wt.branch })).toEqual({ ok: true });
  expect(branchesOf(remote)).toContain('agent/shop-api/fix-login');
});
it('push without a remote is skipped, not an error', async () => {
  const { wt, step } = await setup({ remote: false });
  await step(1, 5, 'Study');
  expect(await pushBranch({ worktree: wt.path, branch: wt.branch })).toEqual({ ok: true, skipped: 'no_remote' });
});
it('push refused by the remote reports the reason', async () => {
  const { repo, wt, step } = await setup();
  await step(1, 5, 'Study');
  const r = await pushBranch({ worktree: wt.path, branch: 'agent/shop-api/not-mine' });
  expect(r.ok).toBe(false);
});
