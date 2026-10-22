import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { autoClose, bootServer, mod, state, ui, until, type Running } from './helpers';
import { gitSync, makeMultiRepo, removeDir, type MultiRepo } from './git-helpers';
import { agentBranchFor, worktreePathFor as pathFor, worktreesDirFor } from '../src/server/git/worktree';

vi.setConfig({ testTimeout: 60_000 });
process.env.CONSOLE_TEST = '1';
const made: MultiRepo[] = [];
afterEach(() => { while (made.length) removeDir(made.pop()!.base); });
autoClose();

let projectRoot = '';
/** Where the server puts an agent's worktree: `<project>/.andromedaconsole/worktrees/<repo>/<slug>`. */
const worktreePathFor = (repo: string, slug: string): string => pathFor(repo, slug, worktreesDirFor(projectRoot, repo));

async function boot(): Promise<{ s: Running; m: MultiRepo }> {
  const m = makeMultiRepo(['abc-fe', 'abc-be'], { remote: true });
  made.push(m);
  projectRoot = m.root;
  const s = await bootServer({ projectRoot: m.root, config: { git: { worktrees: true } } });
  return { s, m };
}
const spawn = (s: Running, name: string, repo?: string) => mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name, profile: 'developer', goal: 'audit it', ...(repo !== undefined ? { repo } : {}) });
const snapshot = async (s: Running, slug: string): Promise<string> => (await ui(s, `/api/debug/snapshot/${slug}`)).body.text;
const cwdOf = async (s: Running, slug: string): Promise<string> => {
  await until(async () => /CWD [^\r\n]+[\r\n]/.test(await snapshot(s, slug)));
  return /CWD ([^\r\n]+)[\r\n]/.exec(await snapshot(s, slug))![1]!.trim();
};

it('lists the repos in the state and is not "not a repo"', async () => {
  const { s } = await boot();
  const st = await state(s);
  expect(st.repos).toEqual(['abc-be', 'abc-fe']);
  expect(st.projectIsRepo).toBe(true);
});
it('several repos and no repo given: git.repoRequired listing them, and the name is not kept', async () => {
  const { s } = await boot();
  expect((await spawn(s, 'audit-privacy')).body).toMatchObject({ status: 'error', code: 'git.repoRequired', params: { repos: 'abc-be, abc-fe' } });
  expect((await state(s)).agents).toEqual([]);
});
it('an unknown repo is git.unknownRepo', async () => {
  const { s } = await boot();
  expect((await spawn(s, 'audit-privacy', '../abc-fe')).body).toMatchObject({ status: 'error', code: 'git.unknownRepo' });
});
it('an agent gets its worktree, branch and project branch in the chosen repo only, and starts inside it', async () => {
  const { s, m } = await boot();
  expect((await spawn(s, 'audit-privacy', 'abc-fe')).body).toEqual({ status: 'started', name: 'audit-privacy' });
  const fe = m.repos['abc-fe']!.repo;
  const be = m.repos['abc-be']!.repo;
  const wt = worktreePathFor(fe, 'audit-privacy');
  expect(existsSync(wt)).toBe(true);
  expect(gitSync(fe, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).toContain(agentBranchFor('shop-api', 'audit-privacy'));
  expect(gitSync(be, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).not.toContain('project/shop-api');
  expect((await cwdOf(s, 'audit-privacy')).toLowerCase()).toBe(wt.toLowerCase());
  expect(readFileSync(join(m.root, '.andromedaconsole', 'project.json'), 'utf8')).toContain('shop-api'); // project state stays in the project folder
  expect(existsSync(join(fe, '.andromedaconsole'))).toBe(false);
});
it('agents in both repos at once get their own worktrees (no race on refs or config)', async () => {
  const { s, m } = await boot();
  const out = await Promise.all([spawn(s, 'a-fe', 'abc-fe'), spawn(s, 'b-fe', 'abc-fe'), spawn(s, 'c-be', 'abc-be')]);
  expect(out.map((o) => o.body.status)).toEqual(['started', 'started', 'started']);
  expect(existsSync(worktreePathFor(m.repos['abc-fe']!.repo, 'a-fe'))).toBe(true);
  expect(existsSync(worktreePathFor(m.repos['abc-fe']!.repo, 'b-fe'))).toBe(true);
  expect(existsSync(worktreePathFor(m.repos['abc-be']!.repo, 'c-be'))).toBe(true);
});
it('the UI route takes a repo too', async () => {
  const { s } = await boot();
  const bad = await ui(s, '/api/agents', 'POST', { slug: 'x-job', profile: 'developer' });
  expect(bad.status).toBe(422);
  expect(bad.body.code).toBe('git.repoRequired');
  const ok = await ui(s, '/api/agents', 'POST', { slug: 'x-job', profile: 'developer', repo: 'abc-be' });
  expect(ok.status).toBe(201);
});
it('the ticket remembers the repo, and no git hook is put in any repo at start', async () => {
  const { s, m } = await boot();
  await spawn(s, 'audit-privacy', 'abc-fe');
  const ticket = JSON.parse(readFileSync(join(m.root, '.andromedaconsole', 'state', 'tickets', 'audit-privacy.json'), 'utf8'));
  expect(ticket.repo).toBe('abc-fe');
  for (const name of ['abc-fe', 'abc-be']) expect(existsSync(join(m.repos[name]!.repo, '.git', 'hooks', 'pre-push')), name).toBe(false);
});
