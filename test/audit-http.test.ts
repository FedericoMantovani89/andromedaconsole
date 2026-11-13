import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { autoClose, bootServer, mod, ui, until, usePipePty, type Running } from './helpers';
import { gitSync, makeRepo, type TestRepo, removeDir, worktreePathFor } from './git-helpers';

vi.setConfig({ testTimeout: 90_000 });
process.env.CONSOLE_TEST = '1';

const repos: TestRepo[] = [];
afterEach(() => { while (repos.length) removeDir(repos.pop()!.base); });
autoClose();
usePipePty(); // no test here reads the terminal

const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];

async function boot(): Promise<{ s: Running; t: TestRepo }> {
  const t = makeRepo({ remote: true });
  repos.push(t);
  const s = await bootServer({ projectRoot: t.repo, config: { git: { worktrees: true } } });
  s.setLimits({ global: 20, perProject: 20 });
  const file = join(t.repo, '.andromedaconsole', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), testCommand: 'node -e "process.exit(0)"', squash: true }));
  return { s, t };
}
const tool = (s: Running, slug: string, name: string, body: unknown = {}) => mod(s, slug, `/v1/tools/${name}`, 'POST', body);
const inbox = async (s: Running, slug: string): Promise<string[]> => (await mod(s, slug, '/v1/inbox')).body.messages.map((m: { text: string }) => m.text);
const ticketFile = (t: TestRepo, slug: string): any => JSON.parse(readFileSync(join(t.repo, '.andromedaconsole', 'state', 'tickets', `${slug}.json`), 'utf8'));
const auditFilesOf = (t: TestRepo, slug: string): string[] => {
  try { return readdirSync(join(t.repo, '.andromedaconsole', 'tickets', slug)).filter((n) => n.startsWith('audit-')); } catch { return []; }
};

async function deliverTicket(s: Running, t: TestRepo, slug = 'fix-login'): Promise<void> {
  expect((await tool(s, 'shop-api', 'spawn_agent', { name: slug, profile: 'developer', goal: 'Fix the login so negative ids are rejected' })).body.status).toBe('started');
  expect((await tool(s, slug, 'checklist_set', { items: ITEMS })).body.status).toBe('ok');
  const wt = worktreePathFor(t.repo, slug);
  writeFileSync(join(wt, 'math.js'), 'module.exports = {};\n');
  for (let n = 1; n <= 6; n++) {
    if (n === 6) writeFileSync(join(wt, 'README.md'), 'docs\n');
    const r = await tool(s, slug, 'step_done', { n, note: 'a decent note for this step' });
    expect(r.body.status, `step ${n}: ${JSON.stringify(r.body)}`).toBe('closed');
  }
}

it('the audit tools belong to their roles, and an auditor cannot be started by hand', async () => {
  const { s, t } = await boot();
  await deliverTicket(s, t);
  expect((await tool(s, 'fix-login', 'request_audit', { name: 'fix-login' })).status).toBe(403);
  expect((await tool(s, 'fix-login', 'audit_report', { notes: [] })).status).toBe(403);
  expect((await tool(s, 'shop-api', 'audit_report', { notes: [] })).status).toBe(403);
  expect((await tool(s, 'shop-api', 'request_audit', {})).body).toEqual({ status: 'error', code: 'bad_request', detail: expect.any(String) });
  expect((await tool(s, 'shop-api', 'request_audit', { name: 'nobody' })).body).toMatchObject({ status: 'refused', code: 'not_delivered' });
  expect((await tool(s, 'shop-api', 'spawn_agent', { name: 'audit-by-hand', profile: 'auditor', goal: 'audit something' })).body).toMatchObject({ status: 'error', code: 'audit.useRequestAudit' });
  expect((await ui(s, '/api/agents', 'POST', { slug: 'audit-by-hand', profile: 'auditor' })).body.code).toBe('audit.useRequestAudit');
});

it('request_audit starts a read-only auditor on a detached checkout of the delivered commit and leaves the ticket as it was', async () => {
  const { s, t } = await boot();
  await deliverTicket(s, t);
  const sha = gitSync(worktreePathFor(t.repo, 'fix-login'), 'rev-parse', 'HEAD');
  const r = await tool(s, 'shop-api', 'request_audit', { name: 'fix-login' });
  expect(r.body).toEqual({ status: 'ok', auditor: 'audit-fix-login' });
  const aw = worktreePathFor(t.repo, 'audit-fix-login');
  expect(existsSync(aw)).toBe(true);
  expect(gitSync(aw, 'rev-parse', 'HEAD')).toBe(sha);
  expect(() => gitSync(aw, 'symbolic-ref', '-q', 'HEAD')).toThrow(); // detached: no branch to commit to
  expect(ticketFile(t, 'fix-login').status).toBe('delivered');
  const goal = (await inbox(s, 'audit-fix-login')).join('\n');
  expect(goal).toContain('mcp__andromeda-mcp__audit_report');
  expect(goal).toContain('git diff project/shop-api...HEAD');
  const guard = (tl: string, input: unknown) => mod(s, 'audit-fix-login', '/v1/guard', 'POST', { tool: tl, input });
  expect((await guard('Write', { file_path: 'notes.md' })).body).toMatchObject({ decision: 'deny', rule: 'readonly.write' });
  expect((await guard('Bash', { command: 'git diff project/shop-api...HEAD' })).body).toEqual({ decision: 'allow' });
  for (const name of ['checklist_set', 'step_done', 'spawn_agent', 'request_review', 'review_verdict', 'request_audit']) expect((await tool(s, 'audit-fix-login', name, {})).status, name).toBe(403);
  expect((await tool(s, 'audit-fix-login', 'list_agents')).status).toBe(200);
  expect(await tool(s, 'shop-api', 'request_audit', { name: 'fix-login' })).toMatchObject({ body: { status: 'refused', code: 'already_running' } });
});

it('the auditor\'s report lands in the audit files, ends its session, tells the main once, and changes nothing of the ticket', async () => {
  const { s, t } = await boot();
  await deliverTicket(s, t);
  await tool(s, 'shop-api', 'request_audit', { name: 'fix-login' });
  await inbox(s, 'shop-api');
  const notes = [{ severity: 'high', where: 'math.js:1', problem: 'an empty module nobody uses', fix: 'drop it' }];
  const r = await tool(s, 'audit-fix-login', 'audit_report', { notes });
  expect(r.body).toEqual({ status: 'ok', ticket: 'fix-login', verdict: 'needs_changes' });
  expect(auditFilesOf(t, 'fix-login').filter((n) => n.endsWith('.json'))).toHaveLength(1);
  const json = JSON.parse(readFileSync(join(t.repo, '.andromedaconsole', 'tickets', 'fix-login', auditFilesOf(t, 'fix-login').find((n) => n.endsWith('.json'))!), 'utf8'));
  expect(json).toMatchObject({ modelRan: true, verdict: 'needs_changes' });
  expect(json.notes[0]).toMatchObject({ source: 'model', severity: 'high', where: 'math.js:1' });
  expect(ticketFile(t, 'fix-login').status).toBe('delivered');
  expect((await inbox(s, 'fix-login')).filter((m) => m.startsWith('Message from the main'))).toHaveLength(0);
  expect((await inbox(s, 'shop-api')).filter((m) => m.includes('Audit of ticket "fix-login"'))).toHaveLength(1);
  await until(() => !existsSync(worktreePathFor(t.repo, 'audit-fix-login')), 20_000); // its checkout is removed
  expect((await tool(s, 'audit-fix-login', 'audit_report', { notes: [] })).status).not.toBe(200); // one report only: the session is gone
});

it('an auditor that ends without a report only tells the main; the ticket stays delivered and can be audited again', async () => {
  const { s, t } = await boot();
  await deliverTicket(s, t);
  await tool(s, 'shop-api', 'request_audit', { name: 'fix-login' });
  await inbox(s, 'shop-api');
  s.writeToSession('audit-fix-login', 'quit\r'); // the fake agent exits without a report
  await until(async () => (await inbox(s, 'shop-api')).join('\n').includes('ended without a report'), 20_000);
  expect(ticketFile(t, 'fix-login').status).toBe('delivered');
  expect(auditFilesOf(t, 'fix-login').filter((n) => n.endsWith('.json'))).toHaveLength(1); // the measures stay
  expect(JSON.parse(readFileSync(join(t.repo, '.andromedaconsole', 'tickets', 'fix-login', auditFilesOf(t, 'fix-login').find((n) => n.endsWith('.json'))!), 'utf8')).modelRan).toBe(false);
  expect((await tool(s, 'shop-api', 'request_audit', { name: 'fix-login' })).body).toMatchObject({ status: 'ok', auditor: 'audit-fix-login-a2' });
});
