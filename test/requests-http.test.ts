import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { autoClose, usePipePty, bootServer, mod, modEvent, state, ui, until, type Running } from './helpers';
import { makeRepo, removeDir, worktreePathFor, type TestRepo } from './git-helpers';

// Real git and real processes: slow on a busy machine, so these tests get a longer budget.
vi.setConfig({ testTimeout: 60_000 });

const repos: TestRepo[] = [];
afterEach(() => { while (repos.length) removeDir(repos.pop()!.base); });
autoClose();
usePipePty(); // this file never reads the terminal: its sessions run on plain pipes

const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];
let clock = 0;

async function boot(): Promise<{ s: Running; t: TestRepo }> {
  const t = makeRepo({ remote: true });
  repos.push(t);
  clock = Date.now();
  const s = await bootServer({ projectRoot: t.repo, config: { git: { worktrees: true } }, requestNow: () => clock, tickMs: 50 });
  const file = join(t.repo, '.andromedaconsole', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), testCommand: 'node -e "process.exit(0)"' }));
  return { s, t };
}
const tool = (s: Running, slug: string, name: string, body: unknown) => mod(s, slug, `/v1/tools/${name}`, 'POST', body);
const spawn = async (s: Running, name: string): Promise<void> => {
  expect((await tool(s, 'shop-api', 'spawn_agent', { name, profile: 'developer', goal: `work as ${name}` })).body.status).toBe('started');
};
const agent = async (s: Running, slug: string) => (await state(s)).agents.find((a: any) => a.slug === slug);
const inbox = async (s: Running, slug: string): Promise<{ id: string; text: string }[]> => (await mod(s, slug, '/v1/inbox')).body.messages;
async function twoAgents(s: Running): Promise<void> {
  await spawn(s, 'fe-pages'); await spawn(s, 'be-orders');
  for (const slug of ['fe-pages', 'be-orders']) expect((await tool(s, slug, 'checklist_set', { items: ITEMS })).body.status).toBe('ok');
}
const ask = async (s: Running, extra: Record<string, unknown> = {}): Promise<string> => {
  const r = await tool(s, 'fe-pages', 'send_message', { type: 'question', to: 'be-orders', text: 'REST signatures of POST /orders?', ...extra });
  expect(r.body.status).toBe('ok');
  return r.body.requestId;
};

it('FE asks BE, keeps working, and the answer unlocks the step; the comment must go before the step closes', async () => {
  const { s, t } = await boot();
  await twoAgents(s);
  await tool(s, 'fe-pages', 'step_done', { n: 1, note: 'study notes here' });
  await tool(s, 'fe-pages', 'step_done', { n: 2 });
  const id = await ask(s, { step: 3 });
  expect(id).toMatch(/^TODO-[0-9a-f]{6}$/);

  expect((await inbox(s, 'be-orders')).some((m) => m.text.includes(id) && m.text.includes('"fe-pages"'))).toBe(true);
  expect((await agent(s, 'fe-pages')).requests).toEqual({ waiting: [{ id, to: 'be-orders' }], owed: [] });
  expect((await agent(s, 'be-orders')).requests).toEqual({ waiting: [], owed: [{ id, from: 'fe-pages' }] });
  expect((await state(s)).requests).toMatchObject([{ id, from: 'fe-pages', to: 'be-orders', state: 'open' }]);

  // FE leaves its comment and goes on with step 4; the validation is refused while step 3 waits.
  const wt = worktreePathFor(t.repo, 'fe-pages');
  writeFileSync(join(wt, 'orders.ts'), `// ${id} signature of POST /orders\n`);
  expect((await tool(s, 'fe-pages', 'step_done', { n: 4 })).body.status).toBe('closed');
  expect((await tool(s, 'fe-pages', 'step_done', { n: 5 })).body).toMatchObject({ status: 'refused', code: 'pending_requests' });

  // BE cannot validate while the question is open, then answers.
  for (const n of [1, 2, 3, 4]) await tool(s, 'be-orders', 'step_done', { n, note: 'notes for the step' });
  expect((await tool(s, 'be-orders', 'step_done', { n: 5 })).body).toMatchObject({ status: 'refused', code: 'unanswered_requests' });
  expect((await tool(s, 'be-orders', 'send_message', { type: 'answer', in_reply_to: id, text: 'POST /orders {sku, qty} -> 201 {id}' })).body).toEqual({ status: 'ok' });
  expect((await tool(s, 'be-orders', 'step_done', { n: 5 })).body.status).toBe('closed');

  // The answer reaches FE with the step to go back to; its chip is gone; the comment blocks the step until removed.
  expect((await inbox(s, 'fe-pages')).some((m) => m.text.includes('POST /orders {sku, qty}') && m.text.includes('step 3'))).toBe(true);
  expect((await agent(s, 'fe-pages')).requests).toBeUndefined();
  expect((await tool(s, 'fe-pages', 'step_done', { n: 3 })).body).toMatchObject({ status: 'refused', code: 'todo_left', files: ['orders.ts:1'] });
  rmSync(join(wt, 'orders.ts'));
  expect((await tool(s, 'fe-pages', 'step_done', { n: 3 })).body.status).toBe('closed');
  expect((await tool(s, 'fe-pages', 'step_done', { n: 5 })).body.status).toBe('closed');
});

it('an unacknowledged question goes to the main after twice the timeout; an acknowledged one after the timeout', async () => {
  const { s } = await boot();
  await twoAgents(s);
  const first = await ask(s, { step: 3 });
  clock += 31 * 60_000;
  await until(async () => (await state(s)).requests?.find((r: any) => r.id === first)?.state === 'escalated');
  expect((await inbox(s, 'shop-api')).some((m) => m.text.includes(first) && m.text.includes('did not answer in time'))).toBe(true);
  expect((await agent(s, 'fe-pages')).requests.waiting).toEqual([{ id: first, to: 'shop-api' }]);

  const second = await ask(s);
  const delivered = (await inbox(s, 'be-orders')).find((m) => m.text.includes(second))!;
  expect((await mod(s, 'be-orders', '/v1/ack', 'POST', { id: delivered.id })).status).toBe(204);
  clock += 14 * 60_000;
  await new Promise((r) => setTimeout(r, 200));
  expect((await state(s)).requests.find((r: any) => r.id === second).state).toBe('open');
  clock += 2 * 60_000;
  await until(async () => (await state(s)).requests.find((r: any) => r.id === second).state === 'escalated');

  // The main answers the escalated one; FE hears it.
  expect((await tool(s, 'shop-api', 'send_message', { type: 'answer', in_reply_to: first, text: 'use the shared schema' })).body).toEqual({ status: 'ok' });
  expect((await inbox(s, 'fe-pages')).some((m) => m.text.includes('use the shared schema'))).toBe(true);
  // FE still has the second question open (it passed no step, so no chip for it): nothing waits and nothing is owed.
  expect((await agent(s, 'fe-pages')).requests).toBeUndefined();
});

it('refusals come back as codes; a reviewer cannot use the tool; a bad body is bad_request', async () => {
  const { s } = await boot();
  await twoAgents(s);
  expect((await tool(s, 'fe-pages', 'send_message', { type: 'question', to: 'fe-pages', text: 'x' })).body).toMatchObject({ status: 'refused', code: 'self' });
  expect((await tool(s, 'fe-pages', 'send_message', { type: 'question', to: 'nobody', text: 'x' })).body).toMatchObject({ status: 'refused', code: 'unknown_recipient' });
  expect((await tool(s, 'fe-pages', 'send_message', { type: 'question', to: 'be-orders', text: 'x', step: 6 })).body).toMatchObject({ status: 'refused', code: 'bad_step' });
  expect((await tool(s, 'fe-pages', 'send_message', { nonsense: true })).body).toEqual({ status: 'error', code: 'bad_request', detail: expect.any(String) });
  expect((await ui(s, '/v1/tools/send_message', 'POST', {})).status).toBe(401);
});

it('the requests and the waiting step are written to disk (what a restart reads back)', async () => {
  const { s, t } = await boot();
  await twoAgents(s);
  const id = await ask(s, { step: 3 });
  const file = join(t.repo, '.andromedaconsole', 'state', 'requests.json');
  expect(existsSync(file)).toBe(true);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject([{ id, from: 'fe-pages', to: 'be-orders', state: 'open' }]);
  expect(JSON.parse(readFileSync(join(t.repo, '.andromedaconsole', 'state', 'tickets', 'fe-pages.json'), 'utf8')).steps[2].waitingOn).toEqual({ requestId: id, to: 'be-orders' });
});

it('an asker stopped by the usage limit keeps its request: after the resume the answer still unlocks the waiting step', async () => {
  const { s, t } = await boot();
  await twoAgents(s);
  await tool(s, 'fe-pages', 'step_done', { n: 1, note: 'study notes here' });
  await tool(s, 'fe-pages', 'step_done', { n: 2 });
  const id = await ask(s, { step: 3 });
  await modEvent(s, 'fe-pages', 'session.start'); // its session id is recorded, so it can be resumed
  const ticket = (): string => JSON.parse(readFileSync(join(t.repo, '.andromedaconsole', 'state', 'tickets', 'fe-pages.json'), 'utf8')).status;
  await modEvent(s, 'shop-api', 'quota', { rateLimits: [{ kind: 'five_hour', percentUsed: 96 }] });
  await until(() => ticket() === 'suspended_limit');
  await until(async () => (await agent(s, 'fe-pages'))?.status === 'exited');
  // Stopped, not ended: the request is not cancelled (BE was suspended too, so the main holds it now).
  expect((await state(s)).requests.find((r: any) => r.id === id).state).not.toBe('cancelled');
  await modEvent(s, 'shop-api', 'quota', { rateLimits: [{ kind: 'five_hour', percentUsed: 10 }] });
  await until(async () => (await state(s)).limits.max > 0);
  expect((await tool(s, 'shop-api', 'resume_agent', { names: ['fe-pages'] })).body).toMatchObject({ status: 'ok', started: ['fe-pages'] });
  await until(() => ticket() === 'in_progress');
  expect((await tool(s, 'shop-api', 'send_message', { type: 'answer', in_reply_to: id, text: 'POST /orders {sku, qty}' })).body).toEqual({ status: 'ok' });
  expect((await inbox(s, 'fe-pages')).some((m) => m.text.includes('POST /orders {sku, qty}') && m.text.includes('step 3'))).toBe(true);
  expect((await tool(s, 'fe-pages', 'step_done', { n: 3 })).body.status).toBe('closed');
});

it('the request settings saved in Options apply at once: a 1-minute timeout escalates after 2 minutes', async () => {
  const { s } = await boot();
  await twoAgents(s);
  expect((await ui(s, '/api/config', 'PUT', { agents: { requestTimeoutMinutes: 1, requestMaxHops: 1 } })).status).toBe(200);
  const id = await ask(s);
  const delivered = (await inbox(s, 'be-orders')).find((m) => m.text.includes(id))!;
  expect((await mod(s, 'be-orders', '/v1/ack', 'POST', { id: delivered.id })).status).toBe(204);
  clock += 2 * 60_000;
  await until(async () => (await state(s)).requests.find((r: any) => r.id === id).state === 'escalated');
});

it('list_agents called by the main lists the requests it holds; called by an agent it has none', async () => {
  const { s } = await boot();
  await twoAgents(s);
  const escalated = await ask(s);
  expect((await tool(s, 'be-orders', 'send_message', { type: 'unknown', in_reply_to: escalated })).body).toEqual({ status: 'ok' });
  const toMain = (await tool(s, 'fe-pages', 'send_message', { type: 'question', to: 'shop-api', text: 'Which currency?' })).body.requestId;
  const open = await ask(s);
  const listed = (await tool(s, 'shop-api', 'list_agents', {})).body;
  expect(listed.requests).toHaveLength(2);
  expect(listed.requests).toEqual(expect.arrayContaining([
    { id: escalated, from: 'fe-pages', to: 'be-orders', state: 'escalated', text: 'REST signatures of POST /orders?' },
    { id: toMain, from: 'fe-pages', to: 'shop-api', state: 'open', text: 'Which currency?' },
  ]));
  expect(listed.requests.some((r: any) => r.id === open)).toBe(false);
  expect((await tool(s, 'fe-pages', 'list_agents', {})).body.requests).toBeUndefined();
});
