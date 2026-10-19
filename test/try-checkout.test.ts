import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverRepos, repoPathOf } from '../src/server/git/repos';
import { listTryCheckouts, prepareTryCheckouts, removeTryCheckouts } from '../src/server/git/try-checkout';
import { purgeProject } from '../src/server/git/purge';
import { gitSync, makeMultiRepo, makeRepo } from './git-helpers';
import { autoClose, bootServer, state, ui, usePipePty } from './helpers';

vi.setConfig({ testTimeout: 60_000 });
usePipePty();
autoClose();

const reposOf = (root: string): { name: string; path: string }[] => discoverRepos(root).map((name) => ({ name, path: repoPathOf(root, name) }));
const worktreeCount = (repo: string): number => gitSync(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;

/** A commit on `project/<name>` as a merge would make it, without touching the user's checkout (plumbing on a separate index). */
function commitOnProjectBranch(repo: string, project: string, file: string, text: string): string {
  const branch = `project/${project}`;
  const env = { ...process.env, GIT_INDEX_FILE: join(repo, '.git', 'try-test-index') };
  const run = (args: string[], input?: string): string => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', ...(input !== undefined ? { input } : {}) }).trim();
  run(['read-tree', branch]);
  const blob = run(['hash-object', '-w', '--stdin'], text);
  run(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`]);
  const tree = run(['write-tree']);
  const commit = run(['-c', 'user.name=Tester', '-c', 'user.email=t@example.com', 'commit-tree', tree, '-p', branch, '-m', `merge ${file}`]);
  run(['update-ref', `refs/heads/${branch}`, commit]);
  return commit;
}

describe('prepareTryCheckouts', () => {
  it('makes one detached checkout per repo at the project branch tip, under .andromedaconsole/try, and leaves the user checkouts alone', async () => {
    const m = makeMultiRepo(['abc-be', 'abc-fe']);
    for (const r of Object.values(m.repos)) gitSync(r.repo, 'branch', 'project/shop', 'main');
    const tipFe = commitOnProjectBranch(m.repos['abc-fe']!.repo, 'shop', 'merged.txt', 'from a ticket\n');
    const out = await prepareTryCheckouts({ projectRoot: m.root, project: 'shop', repos: reposOf(m.root) });
    const tryDir = join(m.root, '.andromedaconsole', 'try');
    expect(out.map((c) => [c.repo, c.path])).toEqual([['abc-be', join(tryDir, 'abc-be')], ['abc-fe', join(tryDir, 'abc-fe')]]);
    expect(out[1]!.sha).toBe(tipFe);
    expect(out[0]!.sha).toBe(gitSync(m.repos['abc-be']!.repo, 'rev-parse', 'project/shop'));
    expect(readFileSync(join(tryDir, 'abc-fe', 'merged.txt'), 'utf8')).toBe('from a ticket\n'); // the project's committed files
    expect(gitSync(join(tryDir, 'abc-fe'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD'); // detached: no branch is held
    for (const r of Object.values(m.repos)) {
      expect(gitSync(r.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
      expect(existsSync(join(r.repo, 'merged.txt'))).toBe(false);
    }
    expect(await listTryCheckouts({ projectRoot: m.root, repos: reposOf(m.root) })).toEqual(out);
  });

  it('a second prepare after a new merge moves the same folder to the new tip', async () => {
    const { repo } = makeRepo();
    gitSync(repo, 'branch', 'project/shop', 'main');
    const first = await prepareTryCheckouts({ projectRoot: repo, project: 'shop', repos: reposOf(repo) });
    expect(first).toEqual([{ repo: '', path: join(repo, '.andromedaconsole', 'try', 'repo'), sha: gitSync(repo, 'rev-parse', 'main') }]);
    const count = worktreeCount(repo);
    const tip = commitOnProjectBranch(repo, 'shop', 'later.txt', 'later\n');
    const second = await prepareTryCheckouts({ projectRoot: repo, project: 'shop', repos: reposOf(repo) });
    expect(second).toEqual([{ ...first[0]!, sha: tip }]);
    expect(readFileSync(join(first[0]!.path, 'later.txt'), 'utf8')).toBe('later\n');
    expect(worktreeCount(repo)).toBe(count); // no new folder
    expect(gitSync(repo, 'status', '--porcelain')).toBe(''); // .andromedaconsole stays out of the user's status
  });

  it('a folder that is itself the repo gets try/repo', async () => {
    const { repo } = makeRepo();
    gitSync(repo, 'branch', 'project/shop', 'main');
    const out = await prepareTryCheckouts({ projectRoot: repo, project: 'shop', repos: [{ name: '', path: repo }] });
    expect(out[0]!.path).toBe(join(repo, '.andromedaconsole', 'try', 'repo'));
    expect(existsSync(join(out[0]!.path, 'README.md'))).toBe(true);
  });

  it('a repo with no project branch refuses the whole prepare, naming it, and nothing is created', async () => {
    const m = makeMultiRepo(['abc-be', 'abc-fe']);
    gitSync(m.repos['abc-fe']!.repo, 'branch', 'project/shop', 'main');
    await expect(prepareTryCheckouts({ projectRoot: m.root, project: 'shop', repos: reposOf(m.root) })).rejects.toMatchObject({ code: 'try.noProjectBranch', params: { repo: 'abc-be' } });
    expect(existsSync(join(m.root, '.andromedaconsole', 'try'))).toBe(false);
    expect(worktreeCount(m.repos['abc-fe']!.repo)).toBe(1);
  });
});

describe('removeTryCheckouts', () => {
  it('removes the folders and their worktree registrations, and is safe to repeat', async () => {
    const m = makeMultiRepo(['abc-be', 'abc-fe']);
    for (const r of Object.values(m.repos)) gitSync(r.repo, 'branch', 'project/shop', 'main');
    await prepareTryCheckouts({ projectRoot: m.root, project: 'shop', repos: reposOf(m.root) });
    await removeTryCheckouts({ projectRoot: m.root, repos: reposOf(m.root) });
    expect(existsSync(join(m.root, '.andromedaconsole', 'try'))).toBe(false);
    for (const r of Object.values(m.repos)) expect(worktreeCount(r.repo)).toBe(1);
    await removeTryCheckouts({ projectRoot: m.root, repos: reposOf(m.root) });
    expect(await listTryCheckouts({ projectRoot: m.root, repos: reposOf(m.root) })).toEqual([]);
    expect(gitSync(m.repos['abc-be']!.repo, 'rev-parse', '--verify', 'project/shop')).not.toBe(''); // the branch is the project's, not the try's
  });

  it('a purge of the project removes them too', async () => {
    const { repo } = makeRepo();
    gitSync(repo, 'branch', 'project/shop', 'main');
    await prepareTryCheckouts({ projectRoot: repo, project: 'shop', repos: reposOf(repo) });
    await purgeProject({ projectRoot: repo, project: 'shop', slugs: [], worktrees: [] });
    expect(worktreeCount(repo)).toBe(1);
    expect(existsSync(join(repo, '.andromedaconsole'))).toBe(false);
  });
});

describe('POST/DELETE /api/project/try', () => {
  it('a repo with no project branch is refused with its name', async () => {
    const { repo } = makeRepo();
    const s = await bootServer({ projectRoot: repo, projectName: 'shop' });
    const r = await ui(s, '/api/project/try', 'POST', {});
    expect([r.status, r.body.code, r.body.params]).toEqual([409, 'try.noProjectBranch', { repo: 'my repo' }]);
  });

  it('prepare answers the paths, the state carries them, and remove clears them', async () => {
    const { repo } = makeRepo();
    gitSync(repo, 'branch', 'project/shop', 'main');
    const s = await bootServer({ projectRoot: repo, projectName: 'shop' });
    expect((await state(s)).project.tryCheckouts).toBeUndefined();
    const made = await ui(s, '/api/project/try', 'POST', {});
    const want = [{ repo: '', path: join(repo, '.andromedaconsole', 'try', 'repo'), sha: gitSync(repo, 'rev-parse', 'main') }];
    expect([made.status, made.body]).toEqual([200, want]);
    expect((await state(s)).project.tryCheckouts).toEqual(want);
    const gone = await ui(s, '/api/project/try', 'DELETE');
    expect([gone.status, gone.body]).toEqual([200, []]);
    expect((await state(s)).project.tryCheckouts).toBeUndefined();
    expect(existsSync(join(repo, '.andromedaconsole', 'try'))).toBe(false);
  });

  it('a console that starts finds the checkouts git has registered (not only what it remembers)', async () => {
    const { repo } = makeRepo();
    gitSync(repo, 'branch', 'project/shop', 'main');
    const want = await prepareTryCheckouts({ projectRoot: repo, project: 'shop', repos: reposOf(repo) });
    const s = await bootServer({ projectRoot: repo, projectName: 'shop' });
    expect((await state(s)).project.tryCheckouts).toEqual(want);
  });

  it('a folder with no repository is refused', async () => {
    const s = await bootServer();
    const r = await ui(s, '/api/project/try', 'POST', {});
    expect([r.status, r.body.code]).toEqual([422, 'git.notRepo']);
  });
});
