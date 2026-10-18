import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { autoClose, usePipePty, bootServer, modEvent, mod, req, state, ui, type Running } from './helpers';
import { branchesOf, gitSync, makeRepo, type TestRepo, removeDir, worktreePathFor } from './git-helpers';
import { AGENT_TOOLS } from '../src/server/agents/spawn';

// Real git and real processes: slow on a busy machine, so these tests get a longer budget.
vi.setConfig({ testTimeout: 60_000 });

const repos: TestRepo[] = [];
afterEach(() => { while (repos.length) removeDir(repos.pop()!.base); });
autoClose();
usePipePty(); // this file never reads the terminal: its sessions run on plain pipes

const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];

async function boot(testCommand: string | null = 'node -e "process.exit(0)"'): Promise<{ s: Running; t: TestRepo }> {
  const t = makeRepo({ remote: true });
  repos.push(t);
  const s = await bootServer({ projectRoot: t.repo, config: { git: { worktrees: true } } });
  if (testCommand !== null) {
    const file = join(t.repo, '.andromedaconsole', 'project.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), testCommand }));
  }
  return { s, t };
}
const spawn = async (s: Running, name = 'fix-login'): Promise<void> => {
  const r = await mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name, profile: 'developer', goal: 'make it work' });
  expect(r.body.status).toBe('started');
};
const tool = (s: Running, slug: string, name: string, body: unknown) => mod(s, slug, `/v1/tools/${name}`, 'POST', body);
const agentState = async (s: Running, slug = 'fix-login') => (await state(s)).agents.find((a: any) => a.slug === slug);

it('the three ticket tools are agent-only; a bad or missing token is refused', async () => {
  const { s } = await boot();
  await spawn(s);
  for (const name of ['checklist_set', 'step_done', 'report_blocked']) {
    expect((await tool(s, 'shop-api', name, {})).status, `${name} by main`).toBe(403);
    expect((await req(s, `/v1/tools/${name}`, { method: 'POST', body: {} })).status, `${name} without token`).toBe(401);
    expect((await req(s, `/v1/tools/${name}`, { method: 'POST', token: s.token, body: {} })).status, `${name} with the UI token`).toBe(401);
  }
});
it('malformed bodies come back as bad_request, not as a crash', async () => {
  const { s } = await boot();
  await spawn(s);
  expect((await tool(s, 'fix-login', 'checklist_set', {})).body).toEqual({ status: 'error', code: 'bad_request', detail: expect.any(String) });
  expect((await tool(s, 'fix-login', 'checklist_set', { items: 'nope' })).body).toEqual({ status: 'error', code: 'bad_request', detail: expect.any(String) });
  expect((await tool(s, 'fix-login', 'step_done', { n: '1' })).body).toEqual({ status: 'error', code: 'bad_request', detail: expect.any(String) });
  expect((await tool(s, 'fix-login', 'step_done', { n: 1.5 })).body).toEqual({ status: 'error', code: 'bad_request', detail: expect.any(String) });
  expect((await tool(s, 'fix-login', 'report_blocked', { reason: '   ' })).body).toEqual({ status: 'error', code: 'bad_request', detail: expect.any(String) });
});
it('a rejected checklist says why; a good one is stored and shows as progress in the state', async () => {
  const { s } = await boot();
  await spawn(s);
  expect((await tool(s, 'fix-login', 'checklist_set', { items: ['Implement', 'x'] })).body).toMatchObject({ status: 'refused', code: 'too_short' });
  expect((await agentState(s)).progress).toBeUndefined();
  expect((await tool(s, 'fix-login', 'checklist_set', { items: ITEMS })).body.status).toBe('ok');
  expect((await agentState(s)).progress).toEqual({ done: 0, total: 6 });
  expect((await state(s)).main.progress).toBeUndefined();
});
it('the agent shows Studying until it has a checklist, then Working', async () => {
  const { s } = await boot();
  await spawn(s);
  await modEvent(s, 'fix-login', 'session.start');
  await modEvent(s, 'fix-login', 'turn.start');
  expect((await agentState(s)).state).toBe('studying');
  await tool(s, 'fix-login', 'checklist_set', { items: ITEMS });
  expect((await agentState(s)).state).toBe('working');
  await modEvent(s, 'fix-login', 'turn.complete', { answer: 'ok' });
  expect((await agentState(s)).state).toBe('idle');
});
it('the whole ticket over HTTP: N commits, validation by the console, push, delivered, the main is told', async () => {
  const { s, t } = await boot();
  await spawn(s);
  const wt = worktreePathFor(t.repo, 'fix-login');
  await modEvent(s, 'fix-login', 'session.start');
  await modEvent(s, 'fix-login', 'turn.start');
  await tool(s, 'fix-login', 'checklist_set', { items: ITEMS });
  for (let n = 1; n <= 6; n++) {
    if (n === 6) writeFileSync(join(wt, 'README.md'), 'hello docs\n');
    const r = await tool(s, 'fix-login', 'step_done', { n, note: 'a decent note for this step' });
    expect(r.body, `step ${n}`).toMatchObject({ status: 'closed', n, total: 6 });
    if (n < 6) expect((await agentState(s)).progress).toEqual({ done: n, total: 6 });
  }
  expect(gitSync(wt, 'log', '--format=%s', 'project/shop-api..HEAD').split('\n').reverse()).toEqual(ITEMS.map((x, i) => `step ${i + 1}/6: ${x}`));
  expect(branchesOf(t.remote)).toContain('agent/shop-api/fix-login');
  const inbox = (await mod(s, 'shop-api', '/v1/inbox')).body.messages.map((m: any) => m.text);
  expect(inbox.some((x: string) => /delivered/.test(x) && x.includes('agent/shop-api/fix-login'))).toBe(true);
  expect((await tool(s, 'fix-login', 'step_done', { n: 6, note: 'again and again' })).body).toMatchObject({ status: 'refused', code: 'already_delivered' });
});
it('a failing test command refuses the validation step and returns the output tail over HTTP', async () => {
  const { s, t } = await boot('node -e "console.log(\'boom\'); process.exit(1)"');
  await spawn(s);
  await tool(s, 'fix-login', 'checklist_set', { items: ITEMS });
  for (let n = 1; n <= 4; n++) await tool(s, 'fix-login', 'step_done', { n, note: 'a decent note for this step' });
  const r = await tool(s, 'fix-login', 'step_done', { n: 5 });
  expect(r.body).toMatchObject({ status: 'refused', code: 'validation_failed' });
  expect(r.body.tail).toContain('boom');
  expect(gitSync(worktreePathFor(t.repo, 'fix-login'), 'log', '--format=%s', 'project/shop-api..HEAD').split('\n')).toHaveLength(4);
});
it('without a test command the validation step cannot close', async () => {
  const { s } = await boot(null);
  await spawn(s);
  await tool(s, 'fix-login', 'checklist_set', { items: ITEMS });
  for (let n = 1; n <= 4; n++) await tool(s, 'fix-login', 'step_done', { n, note: 'a decent note for this step' });
  expect((await tool(s, 'fix-login', 'step_done', { n: 5 })).body).toMatchObject({ status: 'refused', code: 'no_test_command' });
});
it('report_blocked tells the main, shows Blocked, and the next closed step clears it', async () => {
  const { s } = await boot();
  await spawn(s);
  await modEvent(s, 'fix-login', 'session.start');
  await modEvent(s, 'fix-login', 'turn.start');
  await tool(s, 'fix-login', 'checklist_set', { items: ITEMS });
  expect((await tool(s, 'fix-login', 'report_blocked', { reason: 'need the database schema' })).body).toEqual({ status: 'ok' });
  expect((await agentState(s)).state).toBe('blocked');
  const inbox = (await mod(s, 'shop-api', '/v1/inbox')).body.messages.map((m: any) => m.text);
  expect(inbox.some((x: string) => x.includes('fix-login') && x.includes('need the database schema'))).toBe(true);
  await tool(s, 'fix-login', 'step_done', { n: 1, note: 'found it all in src' });
  expect((await agentState(s)).state).toBe('working');
});
it('an agent without a worktree (git.worktrees off) cannot use the ticket tools and says why', async () => {
  const s = await bootServer();
  expect((await mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name: 'fix-login', profile: 'developer', goal: 'g' })).body.status).toBe('started');
  expect((await tool(s, 'fix-login', 'step_done', { n: 1 })).body).toMatchObject({ status: 'refused', code: 'no_worktree' });
  expect((await tool(s, 'fix-login', 'checklist_set', { items: ITEMS })).body).toMatchObject({ status: 'refused', code: 'no_worktree' });
  expect((await agentState(s)).state).toBe('starting');
});
it('the console tools an agent may use without a prompt are named by their full names', () => {
  expect(AGENT_TOOLS).toEqual(expect.arrayContaining(['mcp__console-mod__step_done', 'mcp__console-mod__checklist_set', 'mcp__console-mod__report_blocked', 'mcp__console-mod__list_agents']));
  expect(AGENT_TOOLS).not.toContain('mcp__console-mod__spawn_agent');
});
it('the state API needs the UI token, and progress is in the JSON the UI reads', async () => {
  const { s } = await boot();
  await spawn(s);
  await tool(s, 'fix-login', 'checklist_set', { items: ITEMS });
  expect((await ui(s, '/api/state')).body.agents[0].progress).toEqual({ done: 0, total: 6 });
});
