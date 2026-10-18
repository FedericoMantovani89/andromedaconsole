import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectStore } from '../src/server/project-store';
import { autoClose, usePipePty, bootServer, mod, req, state, ui, until, type Running } from './helpers';
import { makeRepo, removeDir, type TestRepo } from './git-helpers';
import { worktreePathFor } from '../src/server/git/worktree';

vi.setConfig({ testTimeout: 60_000 });
const repos: TestRepo[] = [];
afterEach(() => { while (repos.length) removeDir(repos.pop()!.base); });
autoClose(); // after the folder removal: afterEach hooks run last-declared first, so the server (and its agents, whose folder is inside the repo) closes before the folder goes
usePipePty(); // this file never reads the terminal: its sessions run on plain pipes

const KNOWN = ['developer', 'reviewer', 'recovery'];
const newStore = (): ProjectStore => { const s = new ProjectStore(mkdtempSync(join(tmpdir(), 'pf-'))); s.init('shop-api'); return s; };
const put = (s: Running, body: unknown) => ui(s, '/api/project', 'PUT', body);
const spawn = (s: Running, name: string, extra: Record<string, unknown> = {}) =>
  mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name, profile: 'developer', goal: 'g', ...extra });

it('setFields stores, replaces and clears every field, and a bad one changes nothing', () => {
  const s = newStore();
  s.setFields({ buildCommand: ' make ', lintCommand: 'make lint', profiles: ['developer'], model: 'opus', agentTokens: 5000, maxActive: 2, docs: ['README.md'], secretPatterns: ['*.vault'] }, KNOWN);
  expect(s.project).toMatchObject({ buildCommand: 'make', lintCommand: 'make lint', profiles: ['developer'], model: 'opus', agentTokens: 5000, maxActive: 2, docs: ['README.md'], secretPatterns: ['*.vault'] });
  s.setFields({ model: 'haiku', docs: [], lintCommand: '' }, KNOWN);
  expect(s.project.model).toBe('haiku');
  expect(s.project.docs).toBeUndefined();
  expect(s.project.lintCommand).toBeUndefined();
  expect(s.project.buildCommand).toBe('make'); // not mentioned: kept
  const bad: Record<string, unknown>[] = [
    { buildCommand: 'a\nb' }, { buildCommand: 'x'.repeat(501) }, { profiles: ['nonsense'] }, { profiles: 'developer' }, { model: 'x&calc' },
    { agentTokens: 999 }, { agentTokens: 100_000_001 }, { agentTokens: 1.5 }, { maxActive: 0 }, { maxActive: 65 },
    { docs: Array.from({ length: 21 }, (_, i) => `f${i}.md`) }, { docs: ['x'.repeat(201)] }, { secretPatterns: [5] },
  ];
  const before = JSON.stringify(s.project);
  for (const b of bad) expect(() => s.setFields({ model: 'opus', ...b }, KNOWN), JSON.stringify(b)).toThrow(/project\.fieldInvalid/);
  expect(JSON.stringify(s.project)).toBe(before);
});

it('fields() is empty for a damaged project.json instead of throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'pf-'));
  mkdirSync(join(root, '.andromedaconsole'));
  writeFileSync(join(root, '.andromedaconsole', 'project.json'), '{nope');
  expect(new ProjectStore(root).fields()).toEqual({});
});

it('PUT /api/project sets and echoes the new fields, clears them, and validates before writing', async () => {
  const s = await bootServer();
  const r = await put(s, { buildCommand: 'make', model: 'opus', agentTokens: 5000, maxActive: 2, docs: ['README.md'], secretPatterns: ['*.vault'], lintCommand: 'make lint' });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ buildCommand: 'make', model: 'opus', agentTokens: 5000, maxActive: 2, docs: ['README.md'], secretPatterns: ['*.vault'], lintCommand: 'make lint' });
  expect((await put(s, { model: null, docs: [] })).body).toEqual({});
  expect((await put(s, { testCommand: 'npm test', maxActive: 3 })).body).toEqual({ testCommand: 'npm test', maxActive: 3 });
  const before = (await state(s)).project;
  for (const [body, field] of [[{ model: 'x y' }, 'model'], [{ profiles: ['nope'] }, 'profiles'], [{ agentTokens: 'many' }, 'agentTokens'], [{ lintCommand: 'a\nb' }, 'lintCommand']] as [unknown, string][]) {
    const bad = await put(s, { buildCommand: 'changed', ...(body as object) });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: 'project.fieldInvalid', params: { field } });
  }
  const range = await put(s, { maxActive: 0 });
  expect(range.status).toBe(422);
  expect(range.body).toEqual({ code: 'config.outOfRange', params: { path: 'project.maxActive', min: 1, max: 64 } });
  expect((await state(s)).project).toEqual(before);
  expect((await put(s, {})).status).toBe(400);
  expect((await req(s, '/api/project', { method: 'PUT', body: { maxActive: 2 } })).status).toBe(401);
});

it('the project profiles are what the picker shows and what spawn accepts; an internal spawn is exempt', async () => {
  const s = await bootServer();
  expect((await state(s)).profiles).toEqual(['developer', 'backend', 'frontend', 'dba']); // reviewer and recovery are started by the console, not picked
  expect((await ui(s, '/api/profiles/other-prof', 'PUT', { name: 'other-prof', description: 'd', model: '', budgetTokens: null, readOnly: false, body: 'B' })).status).toBe(200);
  expect((await state(s)).profiles).toEqual(['developer', 'backend', 'frontend', 'dba', 'other-prof']);
  expect((await put(s, { profiles: ['developer'] })).status).toBe(200);
  expect((await state(s)).profiles).toEqual(['developer']);
  const refused = await ui(s, '/api/agents', 'POST', { slug: 'ui-work', profile: 'other-prof' });
  expect(refused.status).toBe(422);
  expect(refused.body.code).toBe('profile.invalid');
  expect((await spawn(s, 'ui-work', { profile: 'other-prof' })).body).toMatchObject({ status: 'error', code: 'profile.invalid' });
  expect((await ui(s, '/api/agents', 'POST', { slug: 'api-work', profile: 'developer' })).status).toBe(201);
  await put(s, { profiles: [] }); // clears: everything is offered again
  expect((await state(s)).profiles).toEqual(['developer', 'backend', 'frontend', 'dba', 'other-prof']);
});

it('model: the request beats the project; the project is used when nothing else names one', async () => {
  const s = await bootServer();
  await put(s, { model: 'opus' });
  expect((await spawn(s, 'project-model')).body.status).toBe('started');
  const a = s.lastLaunchArgs('project-model')!;
  expect(a[a.indexOf('--model') + 1]).toBe('opus');
  expect((await spawn(s, 'request-model', { model: 'haiku' })).body.status).toBe('started');
  const b = s.lastLaunchArgs('request-model')!;
  expect(b[b.indexOf('--model') + 1]).toBe('haiku');
});

it('maxActive limits this project: the next agent waits in the queue', async () => {
  const s = await bootServer();
  await put(s, { maxActive: 1 });
  expect((await spawn(s, 'first-job')).body.status).toBe('started');
  expect((await spawn(s, 'second-job')).body.status).toBe('queued');
  expect((await state(s)).limits.max).toBe(1);
});

it('secretPatterns of the project are added to the global ones for the guard', async () => {
  const s = await bootServer();
  await spawn(s, 'first-job');
  const cat = () => mod(s, 'first-job', '/v1/guard', 'POST', { tool: 'Bash', input: { command: 'cat db.vault' } });
  expect((await cat()).body.decision).toBe('allow');
  await put(s, { secretPatterns: ['*.vault'] });
  expect((await cat()).body).toMatchObject({ decision: 'deny', rule: 'secret.file' });
  expect((await mod(s, 'first-job', '/v1/guard', 'POST', { tool: 'Bash', input: { command: 'cat .env' } })).body.decision).toBe('deny'); // the global ones stay
});

it('budget: the profile beats the project default, which beats the configured one', async () => {
  const t = makeRepo({ remote: true });
  repos.push(t);
  mkdirSync(join(t.repo, '.andromedaconsole', 'profiles'), { recursive: true });
  writeFileSync(join(t.repo, '.andromedaconsole', 'profiles', 'no-budget.md'), '---\nname: no-budget\ndescription: no budget of its own\n---\nBODY');
  const s = await bootServer({ projectRoot: t.repo, config: { git: { worktrees: true } } });
  await put(s, { agentTokens: 5000 });
  const limitOf = (slug: string): number => JSON.parse(readFileSync(join(t.repo, '.andromedaconsole', 'state', 'tickets', `${slug}.json`), 'utf8')).budget?.limit;
  expect((await spawn(s, 'project-default', { profile: 'no-budget' })).body.status).toBe('started');
  await until(() => { try { return limitOf('project-default') !== undefined; } catch { return false; } });
  expect(limitOf('project-default')).toBe(5000);
  expect((await spawn(s, 'profile-wins')).body.status).toBe('started'); // the shipped developer profile sets 400000
  await until(() => { try { return limitOf('profile-wins') !== undefined; } catch { return false; } });
  expect(limitOf('profile-wins')).toBe(400000);
  expect(worktreePathFor(t.repo, 'project-default')).toBeTruthy();
});

it('PUT /api/project switches the tests off and on, the state says so, and a wrong value changes nothing', async () => {
  const s = await bootServer();
  expect((await put(s, { testsDisabled: true })).body).toEqual({ testsDisabled: true });
  expect((await state(s)).project.testsDisabled).toBe(true);
  const bad = await put(s, { testsDisabled: 'yes' });
  expect([bad.status, bad.body.code]).toEqual([422, 'project.testsDisabledInvalid']);
  expect((await state(s)).project.testsDisabled).toBe(true);
  expect((await put(s, { testsDisabled: false })).body).toEqual({ testsDisabled: false });
  expect((await state(s)).project.testsDisabled).toBeUndefined(); // the field is taken away, not kept as false
  expect((await put(s, { testsDisabled: true, testCommand: 'npm test' })).status).toBe(200); // the command stays saved while they are off
  expect((await state(s)).project).toMatchObject({ testsDisabled: true, testCommand: 'npm test' });
});
