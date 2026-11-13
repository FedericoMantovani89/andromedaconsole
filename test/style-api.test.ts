import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { autoClose, bootServer, configFileOf, mod, state, ui, until, usePipePty, type Running } from './helpers';
import { makeRepo, type TestRepo, removeDir, worktreePathFor } from './git-helpers';

vi.setConfig({ testTimeout: 90_000 });
process.env.CONSOLE_TEST = '1';

const repos: TestRepo[] = [];
afterEach(() => { while (repos.length) removeDir(repos.pop()!.base); });
autoClose();
usePipePty(); // no test here reads the terminal

const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];

async function boot(): Promise<{ s: Running; t: TestRepo; userStyle: string; projectStyle: string }> {
  const t = makeRepo({ remote: true });
  repos.push(t);
  const s = await bootServer({ projectRoot: t.repo, config: { git: { worktrees: true } } });
  s.setLimits({ global: 20, perProject: 20 });
  const file = join(t.repo, '.andromedaconsole', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), testCommand: 'node -e "process.exit(0)"', squash: true }));
  return { s, t, userStyle: join(configFileOf(s), '..', 'style'), projectStyle: join(t.repo, '.andromedaconsole', 'style') };
}
const tool = (s: Running, slug: string, name: string, body: unknown = {}) => mod(s, slug, `/v1/tools/${name}`, 'POST', body);
const put = (s: Running, name: string, body: unknown) => ui(s, `/api/style/${name}`, 'PUT', body);

it('lists the shipped profile and what is active', async () => {
  const { s } = await boot();
  const r = await ui(s, '/api/style');
  expect(r.status).toBe(200);
  expect(r.body.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'default', source: 'shipped', shipped: true, userFile: false, projectFile: false })]));
  expect(r.body.active).toEqual({ global: 'default', effective: 'default' });
  const one = await ui(s, '/api/style/default');
  expect(one.body.profile.limits).toEqual({ diff_lines: 250, files_touched: 8, file_lines: 600, comment_run_lines: 4, comment_ratio: 0.15 });
  expect(one.body.text).toContain('limits:');
});

it('saves a profile in the user folder, or the project folder, which wins; both come back in the list', async () => {
  const { s, userStyle, projectStyle } = await boot();
  const text = '---\nname: strict\ndescription: Diff piccole\nlimits:\n  diff_lines: 120\ncommands:\n  lint: npx eslint {files}\n---\nNiente commenti che spiegano il come.';
  expect((await put(s, 'strict', { scope: 'user', text })).status).toBe(200);
  expect(readFileSync(join(userStyle, 'strict.md'), 'utf8')).toBe(text);
  expect((await ui(s, '/api/style')).body.profiles.find((p: any) => p.name === 'strict')).toMatchObject({ source: 'user', userFile: true, projectFile: false, description: 'Diff piccole' });
  expect((await put(s, 'strict', { scope: 'project', text: text.replace('120', '60') })).status).toBe(200);
  expect(existsSync(join(projectStyle, 'strict.md'))).toBe(true);
  const one = await ui(s, '/api/style/strict');
  expect(one.body.profile).toMatchObject({ source: 'project', limits: { diff_lines: 60 }, commands: { lint: 'npx eslint {files}' } });
  expect(one.body.text).toContain('diff_lines: 60');
});

it('accepts an imported file saved by Notepad (BOM, CRLF) with a body in another language', async () => {
  const { s } = await boot();
  const text = '﻿---\r\nname: rigido\r\nlimits:\r\n  diff_lines: 100\r\n---\r\nÈ già così: funzioni piccole\r\n';
  expect((await put(s, 'rigido', { scope: 'user', text })).status).toBe(200);
  expect((await ui(s, '/api/style/rigido')).body.profile.conventions).toBe('È già così: funzioni piccole');
});

it('refuses a bad limit or command naming the key and the range, and writes nothing', async () => {
  const { s, userStyle } = await boot();
  const bad = await put(s, 'bad', { scope: 'user', text: '---\nname: bad\nlimits:\n  diff_lines: abc\n---\nx' });
  expect(bad.status).toBe(422);
  expect(bad.body).toEqual({ code: 'style.badLimit', params: { key: 'diff_lines', min: 0, max: 100000 } });
  expect((await put(s, 'bad', { scope: 'user', text: '---\nname: bad\nlimits:\n  comment_ratio: 3\n---\nx' })).body.params).toEqual({ key: 'comment_ratio', min: 0, max: 1 });
  expect((await put(s, 'bad', { scope: 'user', text: '---\nname: bad\ncommands:\n  deploy: x\n---\nx' })).body).toEqual({ code: 'style.badCommand', params: { key: 'deploy' } });
  expect(existsSync(join(userStyle, 'bad.md'))).toBe(false);
});

it('refuses a body that is not a scope and a text, and a name that could leave the folder', async () => {
  const { s, userStyle } = await boot();
  expect((await put(s, 'ok-name', { scope: 'elsewhere', text: 'x' })).body.code).toBe('style.badScope');
  expect((await put(s, 'ok-name', { scope: 'user' })).status).toBe(400);
  expect((await put(s, 'ok-name', { scope: 'user', text: 'x'.repeat(70_000) })).status).not.toBe(200);
  expect((await ui(s, '/api/style/..%2Fx', 'PUT', { scope: 'user', text: '---\nname: x\n---\nx' })).status).toBe(404);
  expect(existsSync(join(userStyle, '..', 'x.md'))).toBe(false);
});

it('deletes a copy of its own scope; a shipped profile has nothing to delete', async () => {
  const { s, userStyle } = await boot();
  await put(s, 'temp', { scope: 'user', text: '---\nname: temp\n---\nx' });
  expect((await ui(s, '/api/style/temp?scope=user', 'DELETE')).status).toBe(200);
  expect(existsSync(join(userStyle, 'temp.md'))).toBe(false);
  expect((await ui(s, '/api/style/temp?scope=user', 'DELETE')).body.code).toBe('style.notFound');
  expect((await ui(s, '/api/style/default?scope=user', 'DELETE')).body.code).toBe('style.notFound');
  expect((await ui(s, '/api/style/temp?scope=shipped', 'DELETE')).body.code).toBe('style.badScope');
});

it('duplicates the profile in force under a new name, and never over an existing one', async () => {
  const { s, userStyle } = await boot();
  const r = await ui(s, '/api/style/default/duplicate', 'POST', { to: 'my-default', scope: 'user' });
  expect(r.status).toBe(200);
  expect((await ui(s, '/api/style/my-default')).body.profile).toMatchObject({ name: 'my-default', source: 'user', limits: { diff_lines: 250 } });
  expect(existsSync(join(userStyle, 'my-default.md'))).toBe(true);
  expect((await ui(s, '/api/style/default/duplicate', 'POST', { to: 'my-default', scope: 'user' })).body.code).toBe('style.exists');
  expect((await ui(s, '/api/style/default/duplicate', 'POST', { to: 'Bad Name', scope: 'user' })).body.code).toBe('style.badName');
  expect((await ui(s, '/api/style/nope/duplicate', 'POST', { to: 'copy', scope: 'user' })).body.code).toBe('style.notFound');
});

it('the audit settings are in the options and the state: global in the config, the override in the project', async () => {
  const { s } = await boot();
  expect((await ui(s, '/api/options')).body.config.audit).toEqual({ level: 'metrics', autoModel: false, profile: 'default' });
  expect((await ui(s, '/api/config', 'PUT', { audit: { level: 'full', profile: 'strict' } })).status).toBe(200);
  expect((await ui(s, '/api/config', 'PUT', { audit: { level: 'loud' } })).status).toBe(422);
  expect((await ui(s, '/api/project', 'PUT', { auditLevel: 'off', auditAutoModel: true })).status).toBe(200);
  expect((await ui(s, '/api/project', 'PUT', { auditLevel: 'loud' })).body).toMatchObject({ code: 'project.fieldInvalid', params: { field: 'auditLevel' } });
  const st = await state(s);
  expect(st.project).toMatchObject({ auditLevel: 'off', auditAutoModel: true });
  expect((await ui(s, '/api/style')).body.active).toEqual({ global: 'strict', effective: 'strict' });
  await ui(s, '/api/project', 'PUT', { auditProfile: 'default' });
  expect((await ui(s, '/api/style')).body.active).toEqual({ global: 'strict', project: 'default', effective: 'default' });
});

async function deliverTicket(s: Running, t: TestRepo, slug = 'fix-login'): Promise<void> {
  expect((await tool(s, 'shop-api', 'spawn_agent', { name: slug, profile: 'developer', goal: 'Fix the login so negative ids are rejected' })).body.status).toBe('started');
  expect((await tool(s, slug, 'checklist_set', { items: ITEMS })).body.status).toBe('ok');
  const wt = worktreePathFor(t.repo, slug);
  writeFileSync(join(wt, 'math.js'), 'module.exports = {};\n');
  for (let n = 1; n <= 6; n++) {
    if (n === 6) writeFileSync(join(wt, 'README.md'), 'docs\n');
    expect((await tool(s, slug, 'step_done', { n, note: 'a decent note for this step' })).body.status).toBe('closed');
  }
}

it('a ticket\'s audit: nothing before it is measured, then the verdict in the state and the file; the button starts the model part', async () => {
  const { s, t } = await boot();
  await deliverTicket(s, t);
  expect((await ui(s, '/api/tickets/fix-login/audit')).body).toEqual({ audit: null });
  expect((await state(s)).agents.find((a: any) => a.slug === 'fix-login').ticket?.audit).toBeUndefined();

  await tool(s, 'shop-api', 'ticket_report', { name: 'fix-login' }); // measures the delivered commit
  const got = await ui(s, '/api/tickets/fix-login/audit');
  expect(got.body.audit).toMatchObject({ verdict: 'ready', level: 'metrics', modelRan: false });
  await until(async () => (await state(s)).agents.find((a: any) => a.slug === 'fix-login').ticket?.audit?.verdict === 'ready');
  expect((await state(s)).agents.find((a: any) => a.slug === 'fix-login').ticket.audit).toEqual({ verdict: 'ready', level: 'metrics', modelRan: false });

  const r = await ui(s, '/api/tickets/fix-login/audit', 'POST');
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ auditor: 'audit-fix-login' });
  expect((await ui(s, '/api/tickets/fix-login/audit', 'POST')).body.code).toBe('audit.already_running');
  expect((await ui(s, '/api/tickets/nobody/audit', 'POST')).body.code).toBe('audit.not_delivered');

  await ui(s, '/api/config', 'PUT', { audit: { level: 'off' } });
  await tool(s, 'audit-fix-login', 'audit_report', { notes: [{ severity: 'high', where: 'math.js:1', problem: 'p', fix: 'f' }] });
  expect((await ui(s, '/api/tickets/fix-login/audit', 'POST')).body.code).toBe('audit.level_off');
  await until(async () => (await state(s)).agents.find((a: any) => a.slug === 'fix-login').ticket?.audit?.modelRan === true);
  expect((await state(s)).agents.find((a: any) => a.slug === 'fix-login').ticket.audit).toMatchObject({ verdict: 'needs_changes', modelRan: true });
});

it('a ticket route with a slug that is not a valid name is refused, not left hanging', async () => {
  const { s } = await boot();
  for (const slug of ['-x', 'a--b', 'x-']) {
    expect((await ui(s, `/api/tickets/${slug}/audit`)).status, slug).toBe(422);
    expect((await ui(s, `/api/tickets/${slug}/audit`, 'POST')).body.code, slug).toBe('slug.format');
  }
});
