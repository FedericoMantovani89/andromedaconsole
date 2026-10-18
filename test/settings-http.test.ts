import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { autoClose, usePipePty, bootServer, configFileOf, mod, req, state, ui, until, type Running } from './helpers';
import { makeRepo, type TestRepo, removeDir } from './git-helpers';

vi.setConfig({ testTimeout: 60_000 });

const repos: TestRepo[] = [];
afterEach(() => { while (repos.length) removeDir(repos.pop()!.base); });
autoClose();
usePipePty(); // this file never reads the terminal: its sessions run on plain pipes

const put = (s: Running, body: unknown) => ui(s, '/api/config', 'PUT', body);
const file = (s: Running): any => JSON.parse(readFileSync(configFileOf(s), 'utf8'));
const spawn = async (s: Running, name: string): Promise<void> => {
  expect((await mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name, profile: 'developer', goal: 'g' })).body.status).toBe('started');
};
const BYPASS = '--dangerously-skip-permissions';

it('saves the bypass switch and the guard mode, and keeps every other entry as written', async () => {
  const s = await bootServer({ config: { agents: { maxActiveGlobal: 2 }, claude: { command: ['claude', '--model', 'haiku'] }, futureThing: { a: 1 } } });
  const r = await put(s, { agents: { bypassPermissions: true }, guard: { mode: 'shadow' } });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ agents: { bypassPermissions: true }, guard: { mode: 'shadow' } });
  const f = file(s);
  expect(f.agents).toEqual({ maxActiveGlobal: 2, bypassPermissions: true });
  expect(f.guard).toEqual({ mode: 'shadow' });
  expect(f.claude).toEqual({ command: ['claude', '--model', 'haiku'] });
  expect(f.futureThing).toEqual({ a: 1 });
  expect(f.language).toBe('en');
});
it('language still works and can be sent together with the new settings', async () => {
  const s = await bootServer();
  expect((await put(s, { language: 'it', guard: { mode: 'enforce' } })).status).toBe(200);
  expect(file(s)).toMatchObject({ language: 'it', guard: { mode: 'enforce' } });
});
it('validates types and values, and a bad entry changes nothing (not even the good ones)', async () => {
  const s = await bootServer();
  const before = readFileSync(configFileOf(s), 'utf8');
  for (const [body, path] of [
    [{ agents: { bypassPermissions: 'yes' } }, 'agents.bypassPermissions'],
    [{ agents: { bypassPermissions: 1 } }, 'agents.bypassPermissions'],
    [{ agents: 'on' }, 'agents'],
    [{ guard: { mode: 'off' } }, 'guard.mode'],
    [{ guard: { mode: 5 } }, 'guard.mode'],
    [{ guard: 'shadow' }, 'guard'],
    [{ language: 'xx-nope', guard: { mode: 'shadow' } }, 'language'],
    [{ agents: { bypassPermissions: true }, guard: { mode: 'off' } }, 'guard.mode'],
  ] as [unknown, string][]) {
    const r = await put(s, body);
    expect(r.status, JSON.stringify(body)).toBe(422);
    expect(r.body).toMatchObject({ code: 'config.invalid', params: { path } });
  }
  expect((await put(s, {})).status).toBe(422);
  expect((await put(s, { somethingElse: true })).status).toBe(422);
  expect(readFileSync(configFileOf(s), 'utf8')).toBe(before);
  expect((await state(s)).settings).toMatchObject({ bypassPermissions: false, guardMode: 'enforce' });
});
it('never overwrites a config file it cannot read: 409 and the file is left as it was', async () => {
  const s = await bootServer();
  writeFileSync(configFileOf(s), '{not json');
  const r = await put(s, { agents: { bypassPermissions: true } });
  expect(r.status).toBe(409);
  expect(r.body.code).toBe('config.unreadable');
  expect(readFileSync(configFileOf(s), 'utf8')).toBe('{not json');
});
it('needs the UI token', async () => {
  const s = await bootServer();
  expect((await req(s, '/api/config', { method: 'PUT', body: { guard: { mode: 'shadow' } } })).status).toBe(401);
  expect((await mod(s, 'shop-api', '/api/config', 'PUT', { guard: { mode: 'shadow' } })).status).toBe(401);
});
it('the state shows the current settings, defaults first, and follows a change', async () => {
  const s = await bootServer();
  expect((await state(s)).settings).toEqual({ bypassPermissions: false, guardMode: 'enforce', worktrees: false });
  await put(s, { agents: { bypassPermissions: true }, guard: { mode: 'shadow' } });
  expect((await state(s)).settings).toEqual({ bypassPermissions: true, guardMode: 'shadow', worktrees: false });
});
it('the next session launched uses the new bypass value; running sessions keep theirs', async () => {
  const s = await bootServer();
  await spawn(s, 'first-job');
  expect(s.lastLaunchArgs('first-job')).not.toContain(BYPASS);
  await put(s, { agents: { bypassPermissions: true } });
  expect(s.lastLaunchArgs('first-job')).not.toContain(BYPASS);
  await spawn(s, 'second-job');
  expect(s.lastLaunchArgs('second-job')).toContain(BYPASS);
  await put(s, { agents: { bypassPermissions: false } });
  await spawn(s, 'third-job');
  expect(s.lastLaunchArgs('third-job')).not.toContain(BYPASS);
  expect(s.lastLaunchArgs('second-job')).toContain(BYPASS);
});
it('a launch that started before the change keeps the value it started with', async () => {
  const t = makeRepo({ remote: true });
  repos.push(t);
  let release!: () => void;
  const gate = new Promise<void>((ok) => { release = ok; });
  const s = await bootServer({ projectRoot: t.repo, config: { git: { worktrees: true } }, afterWorktreeCreated: () => gate });
  const spawning = mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name: 'slow-job', profile: 'developer', goal: 'g' });
  await until(async () => (await state(s)).agents.some((a: any) => a.slug === 'slow-job'));
  await put(s, { agents: { bypassPermissions: true } });
  release();
  expect((await spawning).body.status).toBe('started');
  expect(s.lastLaunchArgs('slow-job')).not.toContain(BYPASS);
});
it('the guard mode of a running session does not change under it; a session launched afterwards gets the new one', async () => {
  const s = await bootServer();
  await spawn(s, 'first-job');
  const force = (slug: string) => mod(s, slug, '/v1/guard', 'POST', { tool: 'Bash', input: { command: 'git push --force' } });
  expect((await force('first-job')).body.decision).toBe('deny');
  await put(s, { guard: { mode: 'shadow' } });
  expect((await force('first-job')).body.decision).toBe('deny'); // still enforcing: it was launched under enforce
  expect((await force('shop-api')).body.decision).toBe('deny'); // so is the main
  await spawn(s, 'second-job');
  expect((await force('second-job')).body.decision).toBe('allow'); // launched under shadow
  await put(s, { guard: { mode: 'enforce' } });
  expect((await force('second-job')).body.decision).toBe('allow');
  await spawn(s, 'third-job');
  expect((await force('third-job')).body.decision).toBe('deny');
});

it('PUT /api/project sets, shows and clears the test command', async () => {
  const s = await bootServer();
  expect((await state(s)).project.testCommand).toBeUndefined();
  const r = await ui(s, '/api/project', 'PUT', { testCommand: '  npx vitest run ' });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ testCommand: 'npx vitest run' });
  expect((await state(s)).project).toEqual({ name: 'shop-api', testCommand: 'npx vitest run', repos: [] }); // the folder is one repository: no repository rows
  expect((await ui(s, '/api/project', 'PUT', { testCommand: '' })).body).toEqual({});
  expect((await state(s)).project.testCommand).toBeUndefined();
});
it('PUT /api/project refuses a bad command with a user-facing code, and needs the UI token', async () => {
  const s = await bootServer();
  for (const testCommand of ['x'.repeat(501), 'a\nb', 5, null, ['a']]) {
    const r = await ui(s, '/api/project', 'PUT', { testCommand });
    expect(r.status, String(testCommand).slice(0, 10)).toBe(422);
    expect(r.body.code).toBe('project.testCommandInvalid');
  }
  expect((await ui(s, '/api/project', 'PUT', {})).status).toBe(400);
  expect((await req(s, '/api/project', { method: 'PUT', body: { testCommand: 'x' } })).status).toBe(401);
  expect((await mod(s, 'shop-api', '/api/project', 'PUT', { testCommand: 'x' })).status).toBe(401);
});

it('PUT /api/project sets and shows squash, alone or with the test command, and refuses anything else', async () => {
  const s = await bootServer();
  expect((await state(s)).project.squash).toBeUndefined();
  expect((await ui(s, '/api/project', 'PUT', { squash: false })).body).toEqual({ squash: false });
  expect((await state(s)).project).toMatchObject({ name: 'shop-api', squash: false });
  expect((await ui(s, '/api/project', 'PUT', { squash: true, testCommand: 'npm test' })).body).toEqual({ testCommand: 'npm test', squash: true });
  expect((await state(s)).project).toMatchObject({ squash: true, testCommand: 'npm test' });
  for (const squash of ['yes', 1, null, [true]]) {
    const r = await ui(s, '/api/project', 'PUT', { squash });
    expect(r.status, String(squash)).toBe(422);
    expect(r.body.code).toBe('project.squashInvalid');
  }
  expect((await ui(s, '/api/project', 'PUT', { somethingElse: 1 })).status).toBe(400);
  expect((await state(s)).project.squash).toBe(true); // refused calls changed nothing
});
it('a bad squash next to a good test command changes neither', async () => {
  const s = await bootServer();
  const r = await ui(s, '/api/project', 'PUT', { testCommand: 'npm test', squash: 'no' });
  expect(r.status).toBe(422);
  expect((await state(s)).project.testCommand).toBeUndefined();
});
