// Recovery wired into the real server: a budget stop, a read-only recovery session on the WIP commit, its report, and the new agent
// that takes the ticket over on the same branch. Fake agents, a real temporary git repo, transcripts written by the test.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { autoClose, bootServer, mod, modEvent, state, ui, until, type Running } from './helpers';
import { gitSync, makeRepo, removeDir, type TestRepo, worktreePathFor } from './git-helpers';
import { transcriptPath } from '../src/server/claude-code/transcript';

vi.setConfig({ testTimeout: 90_000 });
process.env.CONSOLE_TEST = '1';

const repos: TestRepo[] = [];
const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) removeDir(scratch.pop()!);
  while (repos.length) removeDir(repos.pop()!.base);
});
autoClose();

const SLUG = 'fix-login';
const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];
const tool = (s: Running, slug: string, name: string, body: unknown = {}) => mod(s, slug, `/v1/tools/${name}`, 'POST', body);
const inbox = async (s: Running, slug: string): Promise<string[]> => (await mod(s, slug, '/v1/inbox')).body.messages.map((m: { text: string }) => m.text);
const ticketFile = (t: TestRepo, slug: string): string => join(t.repo, '.andromedaconsole', 'state', 'tickets', `${slug}.json`);
const ticketOf = (t: TestRepo, slug = SLUG): any => JSON.parse(readFileSync(ticketFile(t, slug), 'utf8'));
const agentOf = async (s: Running, slug: string): Promise<any> => (await state(s)).agents.find((a: any) => a.slug === slug);

/** An agent with a checklist (step 1 closed) stopped by its budget: ticket suspended_budget, one decision in the queue. */
async function stopped(o: { handover?: string } = {}): Promise<{ s: Running; t: TestRepo; wt: string; wip: string }> {
  const t = makeRepo({ remote: true });
  repos.push(t);
  const projectsDir = mkdtempSync(join(tmpdir(), 'rec-proj-'));
  scratch.push(projectsDir);
  const s = await bootServer({ projectRoot: t.repo, projectsDir, config: { git: { worktrees: true }, budget: { graceMinutes: 0 } } });
  s.setLimits({ global: 20, perProject: 20 }); // fake agents never finish a turn by themselves, so they would hold the slots
  expect((await tool(s, 'shop-api', 'spawn_agent', { name: SLUG, profile: 'developer', goal: 'Fix the login so negative ids are rejected', budget: 1000 })).body.status).toBe('started');
  const wt = worktreePathFor(t.repo, SLUG);
  await modEvent(s, SLUG, 'session.start', { cwd: wt });
  expect((await tool(s, SLUG, 'checklist_set', { items: ITEMS })).body.status).toBe('ok');
  expect((await tool(s, SLUG, 'step_done', { n: 1, note: 'the login lives in login.js' })).body.status).toBe('closed');
  writeFileSync(join(wt, 'half.js'), 'half done\n');
  // the alert tells the agent to write its handover note here before the limit (kept out of git by the console)
  if (o.handover !== undefined) { mkdirSync(join(wt, '.andromedaconsole'), { recursive: true }); writeFileSync(join(wt, '.andromedaconsole', 'handover.md'), o.handover); }
  const file = transcriptPath(projectsDir, wt, `sess-${SLUG}`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-test', usage: { input_tokens: 0, output_tokens: 1050 }, content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] } })}\n`);
  await modEvent(s, SLUG, 'turn.start');
  await modEvent(s, SLUG, 'turn.complete', {});
  await until(async () => (await mod(s, SLUG, '/v1/guard', 'POST', { tool: 'Bash', input: { command: 'ls' } })).body.decision === 'deny', 20_000);
  // restricted: a new checklist (to escape with an empty step) is refused; only step_done remains
  expect((await tool(s, SLUG, 'checklist_set', { items: ITEMS })).body).toEqual({ status: 'refused', code: 'restricted' });
  await modEvent(s, SLUG, 'turn.start');
  await modEvent(s, SLUG, 'turn.complete', {});
  await until(() => ticketOf(t).status === 'suspended_budget', 20_000);
  await until(async () => (await state(s)).queue.length === 1, 20_000);
  await until(async () => (await agentOf(s, SLUG))?.status === 'exited', 20_000);
  return { s, t, wt, wip: gitSync(wt, 'rev-parse', 'HEAD') };
}

it('start_recovery: a read-only recovery on the WIP commit; its report restarts the ticket with a new agent on the same branch', async () => {
  const { s, t, wt, wip } = await stopped();
  expect(gitSync(wt, 'log', '-1', '--format=%s')).toMatch(/^wip: budget/); // the half-done work is committed
  expect((await tool(s, SLUG, 'start_recovery', { name: SLUG })).status).toBe(401); // the stopped agent has no session any more
  expect((await tool(s, 'shop-api', 'start_recovery', {})).body).toEqual({ status: 'error', code: 'bad_request', detail: expect.any(String) });

  const r = await tool(s, 'shop-api', 'start_recovery', { name: SLUG });
  expect(r.body).toEqual({ status: 'ok', recovery: 'recover-fix-login', attempt: 1 });
  expect(ticketOf(t)).toMatchObject({ status: 'recovering', recoveries: 1 });
  const rc = worktreePathFor(t.repo, 'recover-fix-login');
  expect(gitSync(rc, 'rev-parse', 'HEAD')).toBe(wip);
  expect(() => gitSync(rc, 'symbolic-ref', '-q', 'HEAD')).toThrow(); // detached: nothing to commit to
  expect(gitSync(t.repo, 'branch', '--list', 'recovery/*')).toBe('');
  expect(await agentOf(s, 'recover-fix-login')).toMatchObject({ profile: 'recovery' });
  expect((await agentOf(s, 'recover-fix-login')).budget).toBeUndefined(); // a recovery has no token budget
  expect(existsSync(ticketFile(t, 'recover-fix-login'))).toBe(false); // nor a ticket of its own
  const goal = (await inbox(s, 'recover-fix-login')).join('\n');
  expect(goal).toContain('mcp__console-mod__recovery_report');
  expect(goal).toMatch(/budget/i);
  expect(goal).toMatch(/turn \d+: 1050 tokens/);
  // read-only, and only its own tools
  expect((await mod(s, 'recover-fix-login', '/v1/guard', 'POST', { tool: 'Write', input: { file_path: 'x.md' } })).body).toMatchObject({ decision: 'deny', rule: 'readonly.write' });
  expect((await mod(s, 'recover-fix-login', '/v1/guard', 'POST', { tool: 'Bash', input: { command: `git diff project/shop-api...HEAD` } })).body).toEqual({ decision: 'allow' });
  for (const name of ['step_done', 'checklist_set', 'spawn_agent', 'review_verdict', 'start_recovery']) expect((await tool(s, 'recover-fix-login', name, {})).status, name).toBe(403);
  expect((await tool(s, SLUG, 'recovery_report', {})).status).not.toBe(200);
  expect((await tool(s, 'recover-fix-login', 'recovery_report', { verified_steps: [1], diagnosis: 'x', remedy: 'banana' })).body).toEqual({ status: 'error', code: 'bad_request', detail: expect.any(String) });
  // a second recovery for the same ticket is refused while this one runs
  expect((await tool(s, 'shop-api', 'start_recovery', { name: SLUG })).body).toEqual({ status: 'refused', code: 'not_stopped' });

  const rep = await tool(s, 'recover-fix-login', 'recovery_report', { verified_steps: [1], diagnosis: 'Step 3 is too big for one budget.', remedy: 'split', notes: 'split implement a' });
  expect(rep.body).toEqual({ status: 'ok', ticket: SLUG, outcome: 'restarted' });
  expect((await tool(s, 'recover-fix-login', 'recovery_report', { verified_steps: [1], diagnosis: 'again', remedy: 'split' })).body).toEqual({ status: 'refused', code: 'not_recovery' });

  // the new agent: same branch, same commits, a folder of its own; the old folder is gone; the ticket moved with its history
  const next = worktreePathFor(t.repo, 'fix-login-r2');
  await until(() => existsSync(next), 20_000);
  expect(existsSync(wt)).toBe(false);
  expect(gitSync(next, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`agent/shop-api/${SLUG}`);
  expect(gitSync(next, 'rev-parse', 'HEAD')).toBe(wip);
  expect(existsSync(ticketFile(t, SLUG))).toBe(false);
  const moved = ticketOf(t, 'fix-login-r2');
  expect(moved).toMatchObject({ slug: 'fix-login-r2', status: 'in_progress', recoveries: 1, goal: 'Fix the login so negative ids are rejected' });
  expect(moved.steps[0]).toMatchObject({ n: 1, done: true });
  await until(() => ticketOf(t, 'fix-login-r2').budget?.step === 'ok');
  expect(ticketOf(t, 'fix-login-r2').budget).toEqual({ limit: 1000, step: 'ok' });
  const handover = (await inbox(s, 'fix-login-r2')).join('\n');
  expect(handover).toContain('Step 3 is too big for one budget.');
  expect(handover).toMatch(/step_done/);
  // a restriction of the old session never reaches the new one
  expect((await mod(s, 'fix-login-r2', '/v1/guard', 'POST', { tool: 'Bash', input: { command: 'ls' } })).body).toEqual({ decision: 'allow' });
  // it continues the checklist: the console commits on the same branch
  writeFileSync(join(next, 'test.js'), 'test\n');
  expect((await tool(s, 'fix-login-r2', 'step_done', { n: 2, note: 'tests first' })).body).toMatchObject({ status: 'closed', n: 2 });
  expect(gitSync(t.repo, 'rev-list', '--count', `${wip}..agent/shop-api/${SLUG}`)).toBe('1');
  expect((await inbox(s, 'shop-api')).join('\n')).toContain('fix-login-r2');
  // the recovery session is ended a moment after it reported, and its checkout removed
  await until(async () => (await agentOf(s, 'recover-fix-login'))?.state === 'finished', 20_000);
  await until(() => !existsSync(rc), 20_000);
});

it('the budget answer "recover" starts the recovery; a recovery that ends without a report gives the ticket back', async () => {
  const { s, t } = await stopped();
  const q = (await state(s)).queue[0];
  expect((await ui(s, `/api/queue/${q.id}/answer`, 'POST', { answer: 'recover' })).status).toBe(200);
  await until(() => ticketOf(t).status === 'recovering', 20_000);
  await until(async () => (await agentOf(s, 'recover-fix-login'))?.status === 'running', 20_000);
  s.writeToSession('recover-fix-login', 'quit\r'); // the fake agent exits without calling recovery_report
  await until(() => ticketOf(t).status === 'suspended_budget', 20_000);
  expect(ticketOf(t).recoveries).toBe(1);
  expect((await inbox(s, 'shop-api')).join('\n')).toMatch(/recover-fix-login ended without a report/);
  // the main may try again: a new recovery gets a new name
  expect((await tool(s, 'shop-api', 'start_recovery', { name: SLUG })).body).toEqual({ status: 'ok', recovery: 'recover-fix-login-r2', attempt: 2 });
});

it('the budget answer "raise" restarts the ticket with a new agent on the same branch and a budget half again as large; the handover note written in the worktree reaches it', async () => {
  const { s, t, wip } = await stopped({ handover: 'HANDOVER FROM THE FILE: step 2 half done, half.js holds the start' });
  expect(ticketOf(t).handover).toBe('HANDOVER FROM THE FILE: step 2 half done, half.js holds the start'); // kept at the stop
  const q = (await state(s)).queue[0];
  expect((await ui(s, `/api/queue/${q.id}/answer`, 'POST', { answer: 'raise' })).status).toBe(200);
  const next = worktreePathFor(t.repo, 'fix-login-r2');
  await until(() => existsSync(next) && existsSync(ticketFile(t, 'fix-login-r2')), 20_000);
  expect(gitSync(next, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`agent/shop-api/${SLUG}`);
  expect(gitSync(next, 'rev-parse', 'HEAD')).toBe(wip);
  await until(() => ticketOf(t, 'fix-login-r2').budget?.limit === 1575, 20_000);
  expect(ticketOf(t, 'fix-login-r2')).toMatchObject({ status: 'in_progress', recoveries: 0, budget: { limit: 1575, step: 'ok' } });
  await until(async () => (await inbox(s, 'shop-api')).some((m) => m.includes('fix-login-r2') && m.includes('1575')), 20_000);
  await until(async () => (await inbox(s, 'fix-login-r2').catch(() => [])).some((m) => m.includes('HANDOVER FROM THE FILE')), 20_000);
});

it('spawn_agent and the UI cannot start a recovery by hand: start_recovery is the way', async () => {
  const t = makeRepo({ remote: true });
  repos.push(t);
  const s = await bootServer({ projectRoot: t.repo, config: { git: { worktrees: true } } });
  expect((await tool(s, 'shop-api', 'spawn_agent', { name: 'recover-by-hand', profile: 'recovery', goal: 'recover something' })).body).toMatchObject({ status: 'error', code: 'recovery.useRecoveryTool' });
  expect((await ui(s, '/api/agents', 'POST', { slug: 'recover-by-hand', profile: 'recovery' })).body.code).toBe('recovery.useRecoveryTool');
  expect((await tool(s, 'shop-api', 'start_recovery', { name: 'nobody' })).body).toEqual({ status: 'refused', code: 'not_stopped' });
});

it('a recovery running when the usage limit stops everything gives the ticket back in its stop status', async () => {
  const { s, t } = await stopped();
  expect((await tool(s, 'shop-api', 'start_recovery', { name: SLUG })).body).toMatchObject({ status: 'ok', recovery: 'recover-fix-login' });
  await until(async () => (await agentOf(s, 'recover-fix-login'))?.status === 'running', 20_000);
  await modEvent(s, 'shop-api', 'quota', { rateLimits: [{ kind: 'five_hour', percentUsed: 96 }] });
  await until(async () => (await agentOf(s, 'recover-fix-login'))?.status === 'exited', 20_000);
  await until(() => ticketOf(t).status === 'suspended_budget', 20_000);
  expect((await inbox(s, 'shop-api')).join('\n')).toMatch(/recover-fix-login ended without a report/);
});
