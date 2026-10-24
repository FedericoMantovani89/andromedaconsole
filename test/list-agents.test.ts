import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, it, expect } from 'vitest';
import { autoClose, bootServer, mod, modEvent, modToolUntilEnd, ui, until, state, type Running } from './helpers';
import { makeRepo, removeDir, worktreePathFor, type TestRepo } from './git-helpers';

const repos: TestRepo[] = [];
// Registered before autoClose: afterEach hooks run last-in first-out, so the servers (and their agents) are closed before the folders go.
afterEach(() => { while (repos.length) removeDir(repos.pop()!.base); });
autoClose();

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
it('long goals are truncated: 80 characters for the main, 300 with goal "full" and for the others', async () => {
  const s = await bootServer();
  await spawn(s, 'long-goal', 'g'.repeat(1000));
  const goalOf = (agents: any[]) => agents.find((a: any) => a.slug === 'long-goal').goal as string;
  const short = goalOf(await list(s, 'shop-api'));
  expect(short.length).toBe(81);
  expect(short.endsWith('…')).toBe(true);
  const full = goalOf((await mod(s, 'shop-api', '/v1/tools/list_agents', 'POST', { goal: 'full' })).body.agents);
  expect(full.length).toBe(301);
  expect(goalOf(await list(s, 'long-goal')).length).toBe(301);
});
it('the main gets the active agents by default and says how many archived ones it did not get; filter "all" shows them', async () => {
  const { s, t } = await boot();
  await mergedTicket(s, t, 'old-job'); // merged: its session ended for good and it is archived
  await spawn(s, 'new-job', 'going');
  const slugs = (agents: any[]) => agents.map((a: any) => a.slug);
  const asked = (await tool(s, 'shop-api', 'list_agents', {})).body;
  expect(slugs(asked.agents)).toContain('new-job');
  expect(slugs(asked.agents)).not.toContain('old-job');
  expect(asked.archivedHidden).toBeGreaterThanOrEqual(1);
  const all = (await tool(s, 'shop-api', 'list_agents', { filter: 'all' })).body;
  expect(slugs(all.agents)).toEqual(expect.arrayContaining(['shop-api', 'old-job', 'new-job']));
  expect(all.archivedHidden).toBeUndefined();
  expect(slugs(await list(s, 'new-job'))).toContain('old-job'); // the others see everyone
  expect((await tool(s, 'shop-api', 'list_agents', { filter: 'some' })).body).toMatchObject({ status: 'error', code: 'bad_request' });
  // The reviewer's process ends a moment after the merge; once it has, it leaves the main's list too.
  await until(async () => !slugs((await tool(s, 'shop-api', 'list_agents', {})).body.agents).includes('review-old-job'));
  expect(slugs((await tool(s, 'shop-api', 'list_agents', {})).body.agents)).toEqual(['shop-api', 'new-job']);
}, 120_000);
it('archive_agent archives a delivered ticket that sits idle; the default list then leaves it out and filter "all" keeps it', async () => {
  const { s, t } = await boot();
  const slug = 'research-job';
  await tool(s, 'shop-api', 'spawn_agent', { name: slug, profile: 'developer', goal: 'Study something' });
  await modEvent(s, slug, 'session.start');
  await modEvent(s, slug, 'turn.start');
  await tool(s, slug, 'checklist_set', { items: ITEMS });
  const wt = worktreePathFor(t.repo, slug);
  writeFileSync(join(wt, 'notes.md'), 'notes\n');
  for (let n = 1; n <= 6; n++) {
    if (n === 6) writeFileSync(join(wt, 'README.md'), 'docs\n');
    await tool(s, slug, 'step_done', { n, note: 'a decent note for this step' });
  }
  await modEvent(s, slug, 'turn.complete');
  const listed = async (body: object) => (await tool(s, 'shop-api', 'list_agents', body)).body.agents.map((a: any) => a.slug);
  expect(await listed({})).toContain(slug);
  expect((await tool(s, 'shop-api', 'archive_agent', { names: [slug] })).body).toEqual({ status: 'ok', results: [{ name: slug, status: 'archived' }] });
  expect(await listed({})).not.toContain(slug);
  expect(await listed({ filter: 'all' })).toContain(slug);
}, 120_000);
it('archive_agent: the main archives agents that are done, a working one is refused, agents may not call it', async () => {
  const s = await bootServer();
  s.setLimits({ global: 9, perProject: 9 });
  await spawn(s, 'busy-job', 'working');
  const out = (await mod(s, 'shop-api', '/v1/tools/archive_agent', 'POST', { names: ['busy-job', 'nobody'] })).body;
  expect(out).toEqual({ status: 'ok', results: [{ name: 'busy-job', status: 'refused', code: 'agent.notArchivable' }, { name: 'nobody', status: 'refused', code: 'not_found' }] });
  expect((await mod(s, 'shop-api', '/v1/tools/archive_agent', 'POST', { names: [] })).body).toMatchObject({ status: 'error', code: 'bad_request' });
  expect((await mod(s, 'busy-job', '/v1/tools/archive_agent', 'POST', { names: ['busy-job'] })).status).toBe(403);
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
