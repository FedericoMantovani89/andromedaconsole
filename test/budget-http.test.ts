// The token budget wired into the real server: fake agents, a real temporary git repo, transcripts written by the test.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { autoClose, usePipePty, bootServer, mod, modEvent, state, ui, until, type Running } from './helpers';
import { gitSync, makeRepo, removeDir, type TestRepo, worktreePathFor } from './git-helpers';
import { transcriptPath } from '../src/server/claude-code/transcript';
import { ALERT_TEXT } from '../src/server/budget/service';
import { CONSOLE_FROM } from '../src/server/questions/queue';

// Real git and real processes: slow on a busy machine.
vi.setConfig({ testTimeout: 60_000 });

const repos: TestRepo[] = [];
const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) removeDir(scratch.pop()!);
  while (repos.length) removeDir(repos.pop()!.base);
});
autoClose();
usePipePty(); // this file never reads the terminal: its sessions run on plain pipes

const SLUG = 'fix-login';

interface Budgeted { s: Running; t: TestRepo; wt: string; projectsDir: string; addTokens(out: number): void; turn(): Promise<void> }

async function boot(o: { budget?: Record<string, unknown>; spawnBudget?: number | null; worktrees?: boolean } = {}): Promise<Budgeted> {
  const t = makeRepo({ remote: true });
  repos.push(t);
  const projectsDir = mkdtempSync(join(tmpdir(), 'bud-proj-'));
  scratch.push(projectsDir);
  const s = await bootServer({ projectRoot: t.repo, projectsDir, config: { git: { worktrees: o.worktrees ?? true }, ...(o.budget ? { budget: o.budget } : {}) } });
  const body: Record<string, unknown> = { name: SLUG, profile: 'developer', goal: 'make it work' };
  if (o.spawnBudget !== null) body.budget = o.spawnBudget ?? 1000;
  expect((await mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', body)).body).toEqual({ status: 'started', name: SLUG });
  const wt = o.worktrees === false ? t.repo : worktreePathFor(t.repo, SLUG);
  await modEvent(s, SLUG, 'session.start', { cwd: wt });
  const file = transcriptPath(projectsDir, wt, `sess-${SLUG}`);
  let n = 0;
  const addTokens = (out: number): void => {
    mkdirSync(dirname(file), { recursive: true });
    n += 1;
    appendFileSync(file, `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: `msg_${n}`, model: 'claude-test', usage: { input_tokens: 0, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [] } })}\n`);
  };
  const turn = async (): Promise<void> => {
    await modEvent(s, SLUG, 'turn.start');
    await modEvent(s, SLUG, 'turn.complete', {});
  };
  return { s, t, wt, projectsDir, addTokens, turn };
}

const agentOf = async (s: Running): Promise<any> => (await state(s)).agents.find((a: any) => a.slug === SLUG);
const wipCommits = (wt: string): string[] => gitSync(wt, 'log', '--format=%s').split('\n').filter((l) => l.startsWith('wip:'));
const ticketOf = (t: TestRepo): any => JSON.parse(readFileSync(join(t.repo, '.andromedaconsole', 'state', 'tickets', `${SLUG}.json`), 'utf8'));
const inboxTexts = async (s: Running, slug: string): Promise<string[]> => (await mod(s, slug, '/v1/inbox')).body.messages.map((m: { text: string }) => m.text);

it('1-2. the budget is n/a until the first readable turn; session.start gives the console the session whose transcript it then reads', async () => {
  const { s, t, addTokens, turn } = await boot();
  await until(() => existsSync(join(t.repo, '.andromedaconsole', 'state', 'tickets', `${SLUG}.json`)) && ticketOf(t).budget !== undefined);
  expect(ticketOf(t).budget).toEqual({ limit: 1000, step: 'ok' });
  expect((await agentOf(s)).budget).toBeUndefined(); // n/a, never zero
  // the transcript is found under the session id and the folder that session.start gave
  addTokens(120);
  await turn();
  await until(async () => (await agentOf(s))?.budget !== undefined);
  expect((await agentOf(s)).budget).toEqual({ used: 120, limit: 1000, step: 'ok' });
});

it('4. at 80% the agent gets an alert, a WIP commit is made and both the agent and the main are told', async () => {
  const { s, wt, addTokens, turn } = await boot();
  writeFileSync(join(wt, 'half-done.txt'), 'x');
  addTokens(850);
  await turn();
  await until(async () => (await agentOf(s))?.budget?.step === 'alert', 2000);
  expect((await agentOf(s)).budget).toEqual({ used: 850, limit: 1000, step: 'alert' });
  await until(() => wipCommits(wt).length === 1);
  expect(wipCommits(wt)).toEqual(['wip: budget alert']);
  // the step is persisted first and its effects follow: the messages come right after the commit
  await until(async () => (await inboxTexts(s, 'shop-api')).some((m) => m.includes(SLUG) && m.includes('850')));
  expect(await inboxTexts(s, SLUG)).toContain(ALERT_TEXT);
});

it('5. at 100% the guard restricts the agent to closing its step; step_done itself is not a guarded call', async () => {
  const { s, addTokens, turn } = await boot();
  addTokens(850);
  await turn();
  await until(async () => (await agentOf(s))?.budget?.step === 'alert');
  // before the limit the same call is allowed
  expect((await mod(s, SLUG, '/v1/guard', 'POST', { tool: 'Bash', input: { command: 'ls' } })).body).toEqual({ decision: 'allow' });
  addTokens(200);
  await turn();
  await until(async () => (await agentOf(s))?.budget?.step === 'limit');
  const g = await mod(s, SLUG, '/v1/guard', 'POST', { tool: 'Bash', input: { command: 'ls' } });
  expect(g.body).toMatchObject({ decision: 'deny', rule: 'budget.limit' });
  // closing the step stays possible: the mod never asks the guard about the console's own tools (fix wave A3: the guard has no
  // allow-list for them any more), and step_done answers for itself; a new checklist is refused while restricted
  expect((await mod(s, SLUG, '/v1/tools/checklist_set', 'POST', { items: ['a', 'b'] })).body).toEqual({ status: 'refused', code: 'restricted' });
  const done = await mod(s, SLUG, '/v1/tools/step_done', 'POST', { n: 1 });
  expect(done.status).not.toBe(403);
  expect(done.body).toMatchObject({ status: 'refused', code: 'no_checklist' });
  // the main is never restricted
  expect((await mod(s, 'shop-api', '/v1/guard', 'POST', { tool: 'Bash', input: { command: 'ls' } })).body).toEqual({ decision: 'allow' });
});

it('6. after the grace the agent is stopped: final WIP, ticket suspended_budget, state suspended, one decision in the queue', async () => {
  const { s, t, wt, addTokens, turn } = await boot({ budget: { graceMinutes: 0 } });
  addTokens(1050);
  await turn();
  await until(async () => (await agentOf(s))?.budget?.step === 'limit');
  // the effects of the step (alert WIP, then the restriction) have run once the guard refuses
  await until(async () => (await mod(s, SLUG, '/v1/guard', 'POST', { tool: 'Bash', input: { command: 'ls' } })).body.decision === 'deny');
  writeFileSync(join(wt, 'late.txt'), 'x');
  await turn();
  await until(async () => (await agentOf(s))?.budget?.step === 'stopped');
  await until(() => ticketOf(t).status === 'suspended_budget');
  expect(ticketOf(t).stopCause).toBe('budget');
  await until(async () => (await agentOf(s))?.state === 'suspended');
  expect((await agentOf(s)).status).toBe('exited');
  expect(wipCommits(wt)).toContain('wip: budget stop');
  await until(async () => (await state(s)).queue.length === 1);
  const q = (await state(s)).queue;
  expect(q).toHaveLength(1);
  expect(q[0]).toMatchObject({ from: CONSOLE_FROM, kind: 'decision', options: ['raise', 'close', 'recover'], payload: { ticket: SLUG } });
  // the answer reaches the budget handler: "close" hands the ticket to the user
  expect((await ui(s, `/api/queue/${q[0].id}/answer`, 'POST', { answer: 'close' })).status).toBe(200);
  await until(() => ticketOf(t).status === 'needs_user');
});

// 7. (the same step never fires twice) is in budget-service.test.ts: 'alerts once at 80%'. It waited a fixed 1.5 s to see nothing happen.
it('8. no worktree means no budget in the state; a missing transcript leaves the step untouched', async () => {
  const off = await boot({ worktrees: false });
  await until(async () => (await agentOf(off.s))?.status === 'running');
  await off.turn();
  await new Promise((r) => setTimeout(r, 300));
  expect((await agentOf(off.s)).budget).toBeUndefined();

  const { s, t, projectsDir, wt } = await boot();
  const path = transcriptPath(projectsDir, wt, `sess-${SLUG}`);
  expect(existsSync(path)).toBe(false);
  await modEvent(s, SLUG, 'turn.start');
  await modEvent(s, SLUG, 'turn.complete', {});
  await modEvent(s, SLUG, 'turn.start');
  await modEvent(s, SLUG, 'turn.complete', {});
  // the main is told once that this agent's budget cannot be enforced
  await until(async () => (await inboxTexts(s, 'shop-api')).some((m) => m.startsWith(`budget is not enforced for ${SLUG}`)));
  await new Promise((r) => setTimeout(r, 300));
  const told = (await inboxTexts(s, 'shop-api')).filter((m) => m.startsWith(`budget is not enforced for ${SLUG}`));
  expect(told).toHaveLength(1);
  expect(told[0]).toContain(path);
  expect((await agentOf(s)).budget).toBeUndefined(); // n/a, never zero
  expect(ticketOf(t).budget).toEqual({ limit: 1000, step: 'ok' }); // the step is untouched
});

it('a spawn_agent budget that is not an integer between 1000 and 100 000 000 is refused as bad_request', async () => {
  const t = makeRepo({ remote: true });
  repos.push(t);
  const s = await bootServer({ projectRoot: t.repo, config: { git: { worktrees: true } } });
  for (const budget of [12.5, 999, 100_000_001, '5000']) {
    expect((await mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name: SLUG, profile: 'developer', goal: 'go', budget })).body, String(budget)).toEqual({ status: 'error', code: 'bad_request', detail: expect.any(String) });
  }
  expect((await state(s)).agents).toEqual([]);
});

it('the periodic tick stops an agent whose grace ran out without another turn', async () => {
  const t = makeRepo({ remote: true });
  repos.push(t);
  const projectsDir = mkdtempSync(join(tmpdir(), 'bud-proj-'));
  scratch.push(projectsDir);
  const s = await bootServer({ projectRoot: t.repo, projectsDir, tickMs: 200, config: { git: { worktrees: true }, budget: { graceMinutes: 0 } } });
  await mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name: SLUG, profile: 'developer', goal: 'go', budget: 1000 });
  const wt = worktreePathFor(t.repo, SLUG);
  await modEvent(s, SLUG, 'session.start', { cwd: wt });
  const file = transcriptPath(projectsDir, wt, `sess-${SLUG}`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 0, output_tokens: 1050 } } })}\n`);
  await modEvent(s, SLUG, 'turn.complete', {});
  await until(async () => (await agentOf(s))?.budget?.step === 'stopped', 10_000);
});
