import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, it, expect } from 'vitest';
import { autoClose, bootServer, mod, modEvent, modToolUntilEnd, ui, until, state, type Running } from './helpers';
import { makeRepo, removeDir, worktreePathFor, type TestRepo } from './git-helpers';

autoClose();
const repos: TestRepo[] = [];
afterEach(() => { while (repos.length) removeDir(repos.pop()!.base); });

const spawn = (s: Awaited<ReturnType<typeof bootServer>>, name: string, goal: string) =>
  mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name, profile: 'developer', goal });
const list = async (s: Awaited<ReturnType<typeof bootServer>>, as: string) => (await mod(s, as, '/v1/tools/list_agents', 'POST', {})).body.agents;

it('main and agents see the same list: everyone of the project with profile, state and goal', async () => {
  const s = await bootServer();
  await spawn(s, 'fix-login-timeout', 'Fix the login timeout');
  const fromMain = await list(s, 'shop-api');
  const fromAgent = await list(s, 'fix-login-timeout');
  expect(fromMain).toEqual(fromAgent);
  expect(fromMain).toEqual([
    { slug: 'shop-api', profile: 'main', role: 'main', state: 'starting' },
    { slug: 'fix-login-timeout', profile: 'developer', role: 'agent', state: 'starting', goal: 'Fix the login timeout' },
  ]);
});
it('a queued agent shows its position', async () => {
  const s = await bootServer();
  s.setLimits({ global: 1, perProject: 1 });
  await spawn(s, 'first-job', 'a'); await spawn(s, 'second-job', 'b'); await spawn(s, 'third-job', 'c');
  const agents = await list(s, 'shop-api');
  expect(agents.filter((a: any) => a.state === 'queued').map((a: any) => [a.slug, a.queuedPosition])).toEqual([['second-job', 1], ['third-job', 2]]);
});
it('follows events and a dead process', async () => {
  const s = await bootServer();
  await spawn(s, 'fix-login', 'x');
  await modEvent(s, 'fix-login', 'turn.start');
  expect((await list(s, 'shop-api')).find((a: any) => a.slug === 'fix-login').state).toBe('working');
  s.writeToSession('fix-login', 'quit\r');
  await until(async () => (await state(s)).agents[0].state === 'interrupted');
  expect((await list(s, 'shop-api')).find((a: any) => a.slug === 'fix-login').state).toBe('interrupted');
});
it('long goals are truncated to 300 characters', async () => {
  const s = await bootServer();
  await spawn(s, 'long-goal', 'g'.repeat(1000));
  const goal = (await list(s, 'shop-api')).find((a: any) => a.slug === 'long-goal').goal as string;
  expect(goal.length).toBeLessThanOrEqual(301);
  expect(goal.endsWith('…')).toBe(true);
});
it('needs a session token', async () => {
  const s = await bootServer();
  expect((await ui(s, '/v1/tools/list_agents', 'POST', {})).status).toBe(401);
});

const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];
const tool = (s: Running, slug: string, name: string, body: unknown = {}) => mod(s, slug, `/v1/tools/${name}`, 'POST', body);
const listBody = async (s: Running, as: string) => (await tool(s, as, 'list_agents')).body;
async function boot(): Promise<{ s: Running; t: TestRepo }> {
  const t = makeRepo({ remote: true });
  repos.push(t);
  const s = await bootServer({ projectRoot: t.repo, config: { git: { worktrees: true } } });
  s.setLimits({ global: 20, perProject: 20 });
  const file = join(t.repo, '.andromedaconsole', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), testCommand: 'node -e "process.exit(0)"' }));
  return { s, t };
}
async function mergedTicket(s: Running, t: TestRepo, slug: string): Promise<void> {
  await tool(s, 'shop-api', 'spawn_agent', { name: slug, profile: 'developer', goal: `Work of ${slug}` });
  await tool(s, slug, 'checklist_set', { items: ITEMS });
  const wt = worktreePathFor(t.repo, slug);
  writeFileSync(join(wt, `${slug}.js`), `${slug}
`);
  for (let n = 1; n <= 6; n++) {
    if (n === 6) writeFileSync(join(wt, 'README.md'), `docs by ${slug}
`);
    await tool(s, slug, 'step_done', { n, note: 'a decent note for this step' });
  }
  await tool(s, 'shop-api', 'request_review', { name: slug });
  await tool(s, `review-${slug}`, 'review_verdict', { pass: true, notes: [] });
  expect((await modToolUntilEnd(s, 'shop-api', 'merge_ticket', { name: slug })).body.status).toBe('merged');
}

it('the main sees the open release request; an agent does not; it goes away once answered', async () => {
  const { s, t } = await boot();
  await mergedTicket(s, t, 'fix-login');
  expect((await listBody(s, 'shop-api')).release).toBeUndefined();
  const asked = (await tool(s, 'shop-api', 'propose_release')).body;
  expect(asked.status).toBe('asked');
  expect((await listBody(s, 'shop-api')).release).toEqual({ id: asked.id, status: 'pending' });
  expect((await listBody(s, 'fix-login')).release).toBeUndefined();
  expect((await ui(s, `/api/queue/${asked.id}/answer`, 'POST', { answer: 'reject' })).status).toBe(200);
  expect((await listBody(s, 'shop-api')).release).toBeUndefined();
}, 120_000);

it('shows each agent the requests it is holding or waiting on, with id, state and the other side', async () => {
  const s = await bootServer();
  s.setLimits({ global: 9, perProject: 9 });
  await spawn(s, 'be-orders', 'orders API'); await spawn(s, 'fe-pages', 'order pages');
  const q = await mod(s, 'fe-pages', '/v1/tools/send_message', 'POST', { type: 'question', to: 'be-orders', text: 'REST signatures of POST /orders?' });
  const id = q.body.requestId as string;
  const agents = await list(s, 'shop-api');
  const be = agents.find((a: any) => a.slug === 'be-orders');
  const fe = agents.find((a: any) => a.slug === 'fe-pages');
  expect(be.requests).toEqual({ holding: [{ id, from: 'fe-pages', state: 'open' }], asked: [] });
  expect(fe.requests).toEqual({ holding: [], asked: [{ id, to: 'be-orders', state: 'open' }] });
  expect(agents.find((a: any) => a.slug === 'shop-api').requests).toBeUndefined();
  await mod(s, 'be-orders', '/v1/tools/send_message', 'POST', { type: 'answer', in_reply_to: id, text: 'POST /orders {sku, qty} -> 201 {id}' });
  expect((await list(s, 'shop-api')).find((a: any) => a.slug === 'be-orders').requests).toBeUndefined();
});
