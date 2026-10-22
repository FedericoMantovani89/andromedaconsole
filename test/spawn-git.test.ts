import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { autoClose, bootServer, modEvent, mod, state, ui, until, type Running } from './helpers';
import { gitSync, makeRepo, type TestRepo, removeDir } from './git-helpers';
import { agentBranchFor, worktreePathFor as pathFor, worktreesDirFor } from '../src/server/git/worktree';

/** Where the server puts an agent's worktree: under the project's .andromedaconsole (the project folder is the repo here). */
const worktreePathFor = (repo: string, slug: string): string => pathFor(repo, slug, worktreesDirFor(repo, repo));

// Real git and real processes: slow on a busy machine, so these tests get a longer budget.
vi.setConfig({ testTimeout: 60_000 });

process.env.CONSOLE_TEST = '1'; // exposes /api/debug/snapshot
const repos: TestRepo[] = [];
const scratch: string[] = [];
// Registered before autoClose: hooks run in reverse order, so the servers (and their processes) stop first.
afterEach(() => {
  while (scratch.length) removeDir(scratch.pop()!);
  while (repos.length) removeDir(repos.pop()!.base);
});
autoClose();

async function boot(o: { commit?: boolean; remote?: boolean; afterWorktree?: (slug: string) => void; config?: Record<string, unknown> } = {}): Promise<{ s: Running; t: TestRepo }> {
  const t = makeRepo({ remote: o.remote ?? true, commit: o.commit });
  repos.push(t);
  const s = await bootServer({ projectRoot: t.repo, config: { git: { worktrees: true }, ...o.config }, afterWorktreeCreated: o.afterWorktree });
  return { s, t };
}
const spawnTool = (s: Running, name: string, goal = 'make it work') => mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name, profile: 'developer', goal });
const snapshot = async (s: Running, slug: string): Promise<string> => (await ui(s, `/api/debug/snapshot/${slug}`)).body.text;
const cwdOf = async (s: Running, slug: string): Promise<string> => {
  await until(async () => /CWD [^\r\n]+[\r\n]/.test(await snapshot(s, slug)));
  return /CWD ([^\r\n]+)[\r\n]/.exec(await snapshot(s, slug))![1]!.trim();
};
const branches = (repo: string): string[] => gitSync(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);

it('starting an agent creates the project branch, its branch and the sibling worktree, writes its push hook and launches inside it', async () => {
  const { s, t } = await boot();
  expect((await spawnTool(s, 'fix-login')).body).toEqual({ status: 'started', name: 'fix-login' });
  const wt = worktreePathFor(t.repo, 'fix-login');
  expect(branches(t.repo)).toEqual(expect.arrayContaining(['project/shop-api', agentBranchFor('shop-api', 'fix-login')]));
  expect(existsSync(wt)).toBe(true);
  // the push hook is a script under the project's .andromedaconsole, reached through the session's environment: nothing in the repository's own config
  expect(existsSync(join(t.repo, '.andromedaconsole', 'state', 'hooks', 'fix-login', 'pre-push'))).toBe(true);
  expect(existsSync(join(t.repo, '.git', 'console-hooks'))).toBe(false);
  expect(readFileSync(join(wt, '.andromedaconsole', '.gitignore'), 'utf8')).toBe('*\n');
  expect((await cwdOf(s, 'fix-login')).toLowerCase()).toBe(wt.toLowerCase());
});
it('the prompt file tells the agent its branch, its folder and that the console commits', async () => {
  const { s, t } = await boot();
  await spawnTool(s, 'fix-login');
  const prompt = readFileSync(join(t.repo, '.andromedaconsole', 'state', 'prompts', 'agent-fix-login.md'), 'utf8');
  expect(prompt).toContain('agent/shop-api/fix-login');
  expect(prompt).toContain(worktreePathFor(t.repo, 'fix-login'));
  expect(prompt).toContain('mcp__console-mod__step_done');
  expect(prompt).toContain('mcp__console-mod__checklist_set');
  expect(prompt).toMatch(/never run git commit/i);
  // review finding: a fresh worktree has only tracked files, and the console validates in that same folder
  expect(prompt).toMatch(/install the dependencies/i);
  expect(prompt).toMatch(/only tracked files/i);
  expect(prompt).toMatch(/.env.example/);
});
it('a project folder that is not a repository is refused with git.notRepo, and worktrees:false still works there', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'plain-'));
  scratch.push(plain);
  const s = await bootServer({ projectRoot: plain, config: { git: { worktrees: true } } });
  expect((await spawnTool(s, 'fix-login')).body).toMatchObject({ status: 'error', code: 'git.notRepo' });
  const viaUi = await ui(s, '/api/agents', 'POST', { slug: 'fix-login', profile: 'developer' });
  expect(viaUi.status).toBe(422);
  expect(viaUi.body.code).toBe('git.notRepo');
  expect((await state(s)).agents).toEqual([]);
  const off = await bootServer({ projectRoot: plain, config: { git: { worktrees: false } } });
  expect((await spawnTool(off, 'fix-login')).body.status).toBe('started');
});
it('an empty repository is refused with git.noCommits and nothing is created', async () => {
  const { s, t } = await boot({ commit: false });
  expect((await spawnTool(s, 'fix-login')).body).toMatchObject({ status: 'error', code: 'git.noCommits' });
  expect(existsSync(worktreePathFor(t.repo, 'fix-login'))).toBe(false);
});
it('a clashing folder or branch is refused with git.worktreeExists and the name is not kept', async () => {
  const { s, t } = await boot();
  gitSync(t.repo, 'branch', 'agent/shop-api/fix-login');
  expect((await spawnTool(s, 'fix-login')).body).toMatchObject({ status: 'error', code: 'git.worktreeExists' });
  mkdirSync(worktreePathFor(t.repo, 'other-job'), { recursive: true });
  expect((await spawnTool(s, 'other-job')).body).toMatchObject({ status: 'error', code: 'git.worktreeExists' });
  expect((await state(s)).agents).toEqual([]);
  gitSync(t.repo, 'branch', '-D', 'agent/shop-api/fix-login');
  expect((await spawnTool(s, 'fix-login')).body.status).toBe('started'); // the name was released
});
it('a start that fails after the worktree exists leaves no worktree, branch, hook folder, token or process', async () => {
  let fail = true;
  const { s, t } = await boot({ afterWorktree: () => { if (fail) throw new Error('boom'); } });
  const r = await spawnTool(s, 'fix-login');
  expect(r.body).toMatchObject({ status: 'error', code: 'agent.spawnFailed' });
  expect(existsSync(worktreePathFor(t.repo, 'fix-login'))).toBe(false);
  expect(branches(t.repo)).not.toContain('agent/shop-api/fix-login');
  expect(existsSync(join(t.repo, '.git', 'console-hooks', 'fix-login'))).toBe(false);
  expect(s.sessionTokenFor('fix-login')).toBeUndefined();
  expect((await state(s)).agents).toEqual([]);
  fail = false;
  expect((await spawnTool(s, 'fix-login')).body.status).toBe('started'); // and the name can be used again
});
it('a queued agent gets its worktree only when its slot arrives', async () => {
  const { s, t } = await boot();
  s.setLimits({ global: 1, perProject: 1 });
  await spawnTool(s, 'first-job');
  expect((await spawnTool(s, 'second-job')).body.status).toBe('queued');
  expect(existsSync(worktreePathFor(t.repo, 'second-job'))).toBe(false);
  expect(branches(t.repo)).not.toContain('agent/shop-api/second-job');
  await modEvent(s, 'first-job', 'session.start');
  await modEvent(s, 'first-job', 'turn.start');
  await modEvent(s, 'first-job', 'turn.complete', { answer: 'done' });
  await until(() => existsSync(worktreePathFor(t.repo, 'second-job')));
  await until(async () => (await state(s)).agents.find((a: any) => a.slug === 'second-job')?.status === 'running');
  expect(branches(t.repo)).toContain('agent/shop-api/second-job');
});
it('two agents get separate worktrees and branches', async () => {
  const { s, t } = await boot();
  await spawnTool(s, 'first-job');
  await spawnTool(s, 'second-job');
  expect(worktreePathFor(t.repo, 'first-job')).not.toBe(worktreePathFor(t.repo, 'second-job'));
  expect(gitSync(worktreePathFor(t.repo, 'first-job'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent/shop-api/first-job');
  expect(gitSync(worktreePathFor(t.repo, 'second-job'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent/shop-api/second-job');
});
it('worktrees:false keeps the Phase 2 behaviour: the agent runs in the project folder and nothing is created', async () => {
  const { s, t } = await boot({ config: { git: { worktrees: false } } });
  await spawnTool(s, 'fix-login');
  expect(existsSync(worktreePathFor(t.repo, 'fix-login'))).toBe(false);
  expect(branches(t.repo)).toEqual(['main']);
  expect((await cwdOf(s, 'fix-login')).toLowerCase()).toBe(t.repo.toLowerCase());
});

it('keeps the console folder out of git status from the start, without touching the project\'s .gitignore', async () => {
  const { t } = await boot({ config: { git: { worktrees: false } } });
  expect(readFileSync(join(t.repo, '.andromedaconsole', '.gitignore'), 'utf8')).toBe('*\n'); // the folder carries its own rule
  const exclude = join(t.repo, '.git', 'info', 'exclude');
  expect(existsSync(exclude) ? readFileSync(exclude, 'utf8') : '').not.toContain('.andromedaconsole');
  expect(gitSync(t.repo, 'status', '--porcelain')).toBe('');
  expect(existsSync(join(t.repo, '.gitignore'))).toBe(false);
});

it('the budget defaults to config.budget.agentTokens, and a profile with console: budget_tokens wins over it', async () => {
  const { s, t } = await boot({ config: { budget: { agentTokens: 7000 } } });
  mkdirSync(join(t.repo, '.andromedaconsole', 'profiles'), { recursive: true });
  // The shipped profiles carry their own budget_tokens, so the default is seen through a project profile without one.
  writeFileSync(join(t.repo, '.andromedaconsole', 'profiles', 'plain.md'), '---\nname: plain\ndescription: no budget of its own\n---\nBODY');
  writeFileSync(join(t.repo, '.andromedaconsole', 'profiles', 'lean.md'), '---\nname: lean\ndescription: a lean profile\nconsole:\n  budget_tokens: 5000\n---\nBODY');
  expect((await mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name: 'first-job', profile: 'plain', goal: 'go' })).body.status).toBe('started');
  expect((await mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name: 'second-job', profile: 'lean', goal: 'go' })).body.status).toBe('started');
  // The state shows no usage before the first turn (n/a); the limit itself is on the ticket.
  const limitOf = (slug: string): number | undefined => {
    const file = join(t.repo, '.andromedaconsole', 'state', 'tickets', `${slug}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).budget?.limit : undefined;
  };
  await until(() => limitOf('first-job') !== undefined && limitOf('second-job') !== undefined);
  expect(limitOf('first-job')).toBe(7000);
  expect(limitOf('second-job')).toBe(5000);
});

it('the goal the main wrote is kept in the ticket (the review checks the diff against it)', async () => {
  const { s, t } = await boot();
  await spawnTool(s, 'fix-login', 'Fix the login timeout in AuthService');
  const file = join(t.repo, '.andromedaconsole', 'state', 'tickets', 'fix-login.json');
  await until(() => existsSync(file), 30_000);
  expect(JSON.parse(readFileSync(file, 'utf8')).goal).toBe('Fix the login timeout in AuthService');
});
