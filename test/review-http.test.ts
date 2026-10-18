import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { autoClose, bootServer, mod, modEvent, ui, until, type Running } from './helpers';
import { gitSync, makeRepo, type TestRepo, removeDir, worktreePathFor } from './git-helpers';

vi.setConfig({ testTimeout: 90_000 });
process.env.CONSOLE_TEST = '1';

const repos: TestRepo[] = [];
afterEach(() => { while (repos.length) removeDir(repos.pop()!.base); });
autoClose();

const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];
const NOTES = [{ severity: 'high', where: 'src/math.js:3', text: 'negative input is not handled' }];

async function boot(o: { afterWorktree?: (slug: string) => void | Promise<void> } = {}): Promise<{ s: Running; t: TestRepo }> {
  const t = makeRepo({ remote: true });
  repos.push(t);
  const s = await bootServer({ projectRoot: t.repo, config: { git: { worktrees: true } }, afterWorktreeCreated: o.afterWorktree });
  s.setLimits({ global: 20, perProject: 20 }); // fake agents never report events, so they stay active and would hold the slots
  const file = join(t.repo, '.andromedaconsole', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), testCommand: 'node -e "process.exit(0)"' }));
  return { s, t };
}
const tool = (s: Running, slug: string, name: string, body: unknown = {}) => mod(s, slug, `/v1/tools/${name}`, 'POST', body);
const inbox = async (s: Running, slug: string): Promise<string[]> => (await mod(s, slug, '/v1/inbox')).body.messages.map((m: { text: string }) => m.text);
const ticketFile = (t: TestRepo, slug: string): any => JSON.parse(readFileSync(join(t.repo, '.andromedaconsole', 'state', 'tickets', `${slug}.json`), 'utf8'));
const agentsOf = async (s: Running): Promise<any[]> => (await ui(s, '/api/state')).body.agents;

/** The Phase 3 flow, end to end: spawn, checklist, six steps, delivered. */
async function deliverTicket(s: Running, t: TestRepo, slug = 'fix-login', file = 'math.js'): Promise<void> {
  expect((await tool(s, 'shop-api', 'spawn_agent', { name: slug, profile: 'developer', goal: 'Fix the login so negative ids are rejected' })).body.status).toBe('started');
  expect((await tool(s, slug, 'checklist_set', { items: ITEMS })).body.status).toBe('ok');
  const wt = worktreePathFor(t.repo, slug);
  writeFileSync(join(wt, file), 'module.exports = {};\n');
  for (let n = 1; n <= 6; n++) {
    if (n === 6) writeFileSync(join(wt, 'README.md'), 'docs\n');
    const r = await tool(s, slug, 'step_done', { n, note: 'a decent note for this step' });
    expect(r.body.status, `step ${n}: ${JSON.stringify(r.body)}`).toBe('closed');
  }
}
/** The rework steps after a failed review: three more steps, the last one a documentation step. */
async function finishRework(s: Running, t: TestRepo, slug: string, from: number): Promise<void> {
  const wt = worktreePathFor(t.repo, slug);
  writeFileSync(join(wt, 'fixed.js'), `fixed ${from}\n`);
  for (let n = from; n <= from + 2; n++) {
    if (n === from + 2) writeFileSync(join(wt, 'README.md'), `docs ${from}\n`);
    const r = await tool(s, slug, 'step_done', { n, note: 'a decent note for this step' });
    expect(r.body.status, `rework step ${n}: ${JSON.stringify(r.body)}`).toBe('closed');
  }
}
const snapshot = async (s: Running, slug: string): Promise<string> => (await ui(s, `/api/debug/snapshot/${slug}`)).body.text;

it('the review tools belong to their roles', async () => {
  const { s, t } = await boot();
  await deliverTicket(s, t);
  expect((await tool(s, 'fix-login', 'ticket_report', { name: 'fix-login' })).status).toBe(403);
  expect((await tool(s, 'fix-login', 'request_review', { name: 'fix-login' })).status).toBe(403);
  expect((await tool(s, 'fix-login', 'review_verdict', { pass: true })).status).toBe(403);
  expect((await tool(s, 'shop-api', 'review_verdict', { pass: true })).status).toBe(403);
  expect((await tool(s, 'shop-api', 'merge_ticket', { name: 'fix-login' })).status).not.toBe(403);
  // send_back_ticket: only the main, and it needs a note (what it does with a note is in review.test.ts and the state test below)
  expect((await tool(s, 'fix-login', 'send_back_ticket', { name: 'fix-login', note: 'x' })).status).toBe(403);
  expect((await tool(s, 'shop-api', 'send_back_ticket', { name: 'fix-login' })).body).toEqual({ status: 'error', code: 'bad_request', detail: expect.any(String) });
  expect((await tool(s, 'shop-api', 'send_back_ticket', { name: 'fix-login', note: '  ' })).body).toMatchObject({ status: 'refused', code: 'notes_required' });
});
it('ticket_report gives the main the console\'s facts and the report text', async () => {
  const { s, t } = await boot();
  await deliverTicket(s, t);
  const r = await tool(s, 'shop-api', 'ticket_report', { name: 'fix-login' });
  expect(r.body.status).toBe('ok');
  expect(r.body.facts).toMatchObject({ testsOk: true, checklistComplete: true, docsChanged: true });
  expect(r.body.facts.files.map((f: any) => f.path).sort()).toEqual(['README.md', 'math.js']);
  expect(r.body.report).toContain('## Objective');
  expect(r.body.report).toContain('Fix the login so negative ids are rejected');
  expect(existsSync(join(t.repo, '.andromedaconsole', 'tickets', 'fix-login', 'report.md'))).toBe(true);
  expect((await tool(s, 'shop-api', 'ticket_report', { name: 'nobody' })).body).toMatchObject({ status: 'refused', code: 'not_delivered' });
  expect((await tool(s, 'shop-api', 'ticket_report', {})).body).toEqual({ status: 'error', code: 'bad_request', detail: expect.any(String) });
});
it('spawn_agent cannot start a reviewer by itself: request_review is the way', async () => {
  const { s } = await boot();
  const r = await tool(s, 'shop-api', 'spawn_agent', { name: 'review-by-hand', profile: 'reviewer', goal: 'review something' });
  expect(r.body).toMatchObject({ status: 'error', code: 'review.useRequestReview' });
  expect((await ui(s, '/api/agents', 'POST', { slug: 'review-by-hand', profile: 'reviewer' })).body.code).toBe('review.useRequestReview');
});
it('request_review starts a read-only reviewer in a detached checkout of the delivered commit', async () => {
  const { s, t } = await boot();
  await deliverTicket(s, t);
  const sha = gitSync(worktreePathFor(t.repo, 'fix-login'), 'rev-parse', 'HEAD');
  const r = await tool(s, 'shop-api', 'request_review', { name: 'fix-login' });
  expect(r.body).toEqual({ status: 'ok', result: 'in_review', reviewer: 'review-fix-login', round: 1 });
  expect(ticketFile(t, 'fix-login')).toMatchObject({ status: 'in_review', reviewer: 'review-fix-login' });
  const rv = worktreePathFor(t.repo, 'review-fix-login');
  expect(existsSync(rv)).toBe(true);
  expect(gitSync(rv, 'rev-parse', 'HEAD')).toBe(sha);
  expect(() => gitSync(rv, 'symbolic-ref', '-q', 'HEAD')).toThrow(); // detached: no branch to commit to
  expect(gitSync(t.repo, 'branch', '--list', 'review/*')).toBe('');
  await until(async () => /CWD [^\r\n]+[\r\n]/.test(await snapshot(s, 'review-fix-login')));
  expect(/CWD ([^\r\n]+)[\r\n]/.exec(await snapshot(s, 'review-fix-login'))![1]!.trim().toLowerCase()).toBe(rv.toLowerCase());
  const entry = (await agentsOf(s)).find((a) => a.slug === 'review-fix-login');
  expect(entry).toMatchObject({ profile: 'reviewer', role: 'agent' });
  // the reviewer's first message names the ticket, the diff command and the verdict tool
  const goal = (await inbox(s, 'review-fix-login')).join('\n');
  expect(goal).toContain('fix-login');
  expect(goal).toContain('git diff project/shop-api...HEAD');
  expect(goal).toContain('mcp__console-mod__review_verdict');
  expect(await tool(s, 'shop-api', 'request_review', { name: 'fix-login' })).toMatchObject({ body: { status: 'refused', code: 'not_delivered' } });
});
it('the reviewer has the verdict tool and the guard keeps it read-only; it has no ticket tools of an author', async () => {
  const { s, t } = await boot();
  await deliverTicket(s, t);
  await tool(s, 'shop-api', 'request_review', { name: 'fix-login' });
  const guard = (tl: string, input: unknown) => mod(s, 'review-fix-login', '/v1/guard', 'POST', { tool: tl, input });
  expect((await guard('Write', { file_path: 'notes.md' })).body).toMatchObject({ decision: 'deny', rule: 'readonly.write' });
  expect((await guard('Bash', { command: 'echo x > f.txt' })).body).toMatchObject({ decision: 'deny', rule: 'readonly.write' });
  expect((await guard('Bash', { command: 'git diff project/shop-api...HEAD' })).body).toEqual({ decision: 'allow' });
  expect((await guard('Read', { file_path: 'math.js' })).body).toEqual({ decision: 'allow' });
  for (const name of ['checklist_set', 'step_done', 'report_blocked', 'spawn_agent', 'request_review', 'ticket_report']) expect((await tool(s, 'review-fix-login', name, {})).status, name).toBe(403);
  expect((await tool(s, 'review-fix-login', 'list_agents')).status).toBe(200);
});
it('a failed review goes back to the author as a message from the main; the author fixes and delivers again; the second review passes', async () => {
  const { s, t } = await boot();
  await deliverTicket(s, t);
  await tool(s, 'shop-api', 'request_review', { name: 'fix-login' });
  await inbox(s, 'shop-api'); // read (not consumed): just to be explicit that the main has its delivery message
  const v = await tool(s, 'review-fix-login', 'review_verdict', { pass: false, notes: NOTES });
  expect(v.body).toEqual({ status: 'ok', ticket: 'fix-login', outcome: 'sent_back', round: 1 });
  const authorMsgs = await inbox(s, 'fix-login');
  const fromMain = authorMsgs.find((m) => m.startsWith('Message from the main'))!;
  expect(fromMain).toContain('negative input is not handled');
  expect(fromMain).not.toMatch(/review-fix-login/);
  expect((await inbox(s, 'shop-api')).join('\n')).toMatch(/NOT PASSED/);
  expect(ticketFile(t, 'fix-login')).toMatchObject({ status: 'in_progress', round: 1 });
  expect((await agentsOf(s)).find((a) => a.slug === 'fix-login').progress).toEqual({ done: 6, total: 9 });
  // a second verdict from the same reviewer is refused: the review is over
  expect((await tool(s, 'review-fix-login', 'review_verdict', { pass: true })).body).toMatchObject({ status: 'refused', code: 'not_reviewer' });
  await finishRework(s, t, 'fix-login', 7);
  expect(ticketFile(t, 'fix-login').status).toBe('delivered');
  const again = await tool(s, 'shop-api', 'request_review', { name: 'fix-login' });
  expect(again.body).toMatchObject({ status: 'ok', reviewer: 'review-fix-login-r2', round: 2 });
  expect((await inbox(s, 'review-fix-login-r2')).join('\n')).toContain('negative input is not handled'); // the notes to re-check
  const pass = await tool(s, 'review-fix-login-r2', 'review_verdict', { pass: true, notes: [] });
  expect(pass.body).toEqual({ status: 'ok', ticket: 'fix-login', outcome: 'approved' });
  expect(ticketFile(t, 'fix-login').status).toBe('approved');
  expect((await inbox(s, 'shop-api')).join('\n')).toMatch(/PASSED[\s\S]*merge_ticket/);
});
// The rounds rule (two rework rounds, then the user) is tested in review.test.ts; here only the way from the verdict to the user's queue and back.
// An author that is gone gets there without three review rounds.
it('a failed review of a ticket whose author is gone puts a decision in the user\'s queue, and the user\'s answer acts on the ticket', async () => {
  const { s, t } = await boot();
  await deliverTicket(s, t);
  await tool(s, 'shop-api', 'request_review', { name: 'fix-login' });
  s.writeToSession('fix-login', 'quit\r'); // the author's process ends: the ticket cannot go back to it
  await until(async () => (await agentsOf(s)).find((a) => a.slug === 'fix-login')?.status === 'exited', 20_000);
  const v = await tool(s, 'review-fix-login', 'review_verdict', { pass: false, notes: NOTES });
  expect(v.body, JSON.stringify(v.body)).toMatchObject({ outcome: 'needs_user' });
  expect(ticketFile(t, 'fix-login').status).toBe('needs_user');
  const queue = (await ui(s, '/api/state')).body.queue;
  expect(queue).toHaveLength(1);
  expect(queue[0]).toMatchObject({ kind: 'decision', from: '@console', options: ['send_back', 'approve', 'leave'] });
  expect(queue[0].payload).toMatchObject({ ticket: 'fix-login', reason: 'author_gone' });
  expect(JSON.stringify(queue[0].payload)).toContain('negative input is not handled');
  expect((await ui(s, `/api/queue/${queue[0].id}/answer`, 'POST', { answer: 'not an option' })).status).toBe(400);
  expect((await ui(s, `/api/queue/${queue[0].id}/answer`, 'POST', { answer: 'approve' })).status).toBe(200);
  expect(ticketFile(t, 'fix-login').status).toBe('approved');
  expect((await ui(s, '/api/state')).body.queue).toEqual([]);
  expect((await inbox(s, 'shop-api')).join('\n')).toMatch(/approved by the user/);
});
it('the whole pipeline: delivered, reviewed, approved, merged into the project branch, sessions ended and folders removed', async () => {
  const { s, t } = await boot();
  await deliverTicket(s, t);
  expect((await tool(s, 'shop-api', 'merge_ticket', { name: 'fix-login' })).body).toMatchObject({ status: 'refused', code: 'not_approved' });
  await tool(s, 'shop-api', 'request_review', { name: 'fix-login' });
  expect((await tool(s, 'review-fix-login', 'review_verdict', { pass: true, notes: [{ severity: 'low', text: 'rename x' }] })).body.outcome).toBe('approved');
  // the reviewer is ended a moment after it spoke, and its checkout goes
  await until(async () => (await agentsOf(s)).find((a) => a.slug === 'review-fix-login')?.state === 'finished', 20_000);
  await until(() => !existsSync(worktreePathFor(t.repo, 'review-fix-login')), 20_000);
  expect((await tool(s, 'shop-api', 'merge_ticket', {})).body).toEqual({ status: 'error', code: 'bad_request', detail: expect.any(String) });
  const before = Number(gitSync(t.repo, 'rev-list', '--count', 'project/shop-api'));
  const r = await tool(s, 'shop-api', 'merge_ticket', { name: 'fix-login' });
  expect(r.body).toMatchObject({ status: 'merged' });
  expect(Number(gitSync(t.repo, 'rev-list', '--count', 'project/shop-api'))).toBe(before + 1);
  expect(gitSync(t.repo, 'show', 'project/shop-api:math.js')).toBe('module.exports = {};');
  expect(gitSync(t.repo, 'log', '-1', '--format=%s', 'project/shop-api')).toBe('ticket fix-login: Fix the login so negative ids are rejected');
  expect(ticketFile(t, 'fix-login')).toMatchObject({ status: 'merged', mergedSha: gitSync(t.repo, 'rev-parse', 'project/shop-api') });
  await until(async () => (await agentsOf(s)).find((a) => a.slug === 'fix-login')?.state === 'finished', 20_000);
  expect(existsSync(worktreePathFor(t.repo, 'fix-login'))).toBe(false);
  expect(gitSync(t.repo, 'branch', '--list', 'agent/*')).toBe('');
  expect((await inbox(s, 'shop-api')).join('\n')).toMatch(/fix-login.*merged/);
  // a new agent starts from the updated project branch
  await tool(s, 'shop-api', 'spawn_agent', { name: 'second-job', profile: 'developer', goal: 'next thing' });
  await until(() => existsSync(join(worktreePathFor(t.repo, 'second-job'), 'math.js')));
});

it('the state tells the UI where each ticket is in the pipeline (nothing for a ticket still being written)', async () => {
  const { s, t } = await boot();
  expect((await tool(s, 'shop-api', 'spawn_agent', { name: 'fix-login', profile: 'developer', goal: 'g' })).body.status).toBe('started');
  const ticketOf = async (slug = 'fix-login') => (await agentsOf(s)).find((a) => a.slug === slug)?.ticket;
  expect(await ticketOf()).toBeUndefined();
  await tool(s, 'fix-login', 'checklist_set', { items: ITEMS });
  const wt = worktreePathFor(t.repo, 'fix-login');
  writeFileSync(join(wt, 'a.js'), 'a\n');
  for (let n = 1; n <= 6; n++) {
    if (n === 6) writeFileSync(join(wt, 'README.md'), 'docs\n');
    await tool(s, 'fix-login', 'step_done', { n, note: 'a decent note for this step' });
  }
  expect(await ticketOf()).toEqual({ status: 'delivered', round: 0, maxRounds: 2 });
  await tool(s, 'shop-api', 'request_review', { name: 'fix-login' });
  expect(await ticketOf()).toMatchObject({ status: 'in_review' });
  expect(await ticketOf('review-fix-login')).toBeUndefined(); // a reviewer has no ticket of its own
  await tool(s, 'review-fix-login', 'review_verdict', { pass: false, notes: NOTES });
  expect(await ticketOf()).toEqual({ status: 'in_progress', round: 1, maxRounds: 2 }); // rework 1 of 2
  await finishRework(s, t, 'fix-login', 7);
  await tool(s, 'shop-api', 'request_review', { name: 'fix-login' });
  await tool(s, 'review-fix-login-r2', 'review_verdict', { pass: true });
  expect(await ticketOf()).toMatchObject({ status: 'approved' });
});

it('every review, merge and release tool call pushes the new state to the UI (a status change has no other event)', async () => {
  const { s, t } = await boot();
  await deliverTicket(s, t);
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/ui?token=${s.token}`, { headers: { origin: `http://127.0.0.1:${s.port}` } });
  await new Promise<void>((ok) => ws.on('open', () => ok()));
  const states: any[] = [];
  ws.on('message', (d) => { try { const m = JSON.parse(d.toString()); if (m.type === 'state') states.push(m); } catch { /* binary */ } });
  const lastTicket = () => states.at(-1)?.agents.find((a: any) => a.slug === 'fix-login')?.ticket?.status;
  states.length = 0;
  await tool(s, 'shop-api', 'send_back_ticket', { name: 'fix-login', note: 'Please change this.' });
  await until(() => lastTicket() === 'in_progress', 40_000);
  expect(states.at(-1).agents.find((a: any) => a.slug === 'fix-login').ticket).toMatchObject({ status: 'in_progress', round: 1 });
  await finishRework(s, t, 'fix-login', 7);
  await tool(s, 'shop-api', 'request_review', { name: 'fix-login' });
  await until(() => lastTicket() === 'in_review', 40_000);
  await tool(s, 'review-fix-login', 'review_verdict', { pass: true });
  await until(() => lastTicket() === 'approved', 40_000);
  await tool(s, 'shop-api', 'merge_ticket', { name: 'fix-login' });
  await until(() => lastTicket() === 'merged', 60_000);
  ws.close();
});

it('a reviewer that ends without a verdict gives the ticket back to the main: delivered again, with a message', async () => {
  const { s, t } = await boot();
  await deliverTicket(s, t);
  expect((await tool(s, 'shop-api', 'request_review', { name: 'fix-login' })).body.reviewer).toBe('review-fix-login');
  await inbox(s, 'shop-api');
  s.writeToSession('review-fix-login', 'quit\r'); // the fake agent exits: the reviewer's process is gone without a verdict
  await until(() => ticketFile(t, 'fix-login').status === 'delivered', 20_000);
  expect(ticketFile(t, 'fix-login').reviewer).toBeUndefined();
  expect((await inbox(s, 'shop-api')).join('\n')).toMatch(/ended without a verdict/);
  const again = await tool(s, 'shop-api', 'request_review', { name: 'fix-login' });
  expect(again.body).toMatchObject({ status: 'ok', reviewer: 'review-fix-login-r2' });
});

it('a reviewer that waits in the queue and then fails to start gives the ticket back to the main (it must not stay in review for ever)', async () => {
  let failReviewers = false;
  const { s, t } = await boot({ afterWorktree: (slug) => { if (failReviewers && slug.startsWith('review-')) throw new Error('no worktree for you'); } });
  await deliverTicket(s, t);
  s.setLimits({ global: 1, perProject: 1 }); // the author still counts as active: the reviewer has to wait
  failReviewers = true;
  const r = await tool(s, 'shop-api', 'request_review', { name: 'fix-login' });
  expect(r.body).toMatchObject({ status: 'ok', result: 'in_review', reviewer: 'review-fix-login' });
  expect(ticketFile(t, 'fix-login').status).toBe('in_review');
  // the author finishes its goal: its slot frees, the queued reviewer starts, and its start fails
  for (const type of ['session.start', 'turn.start', 'turn.complete']) {
    await mod(s, 'fix-login', '/v1/events', 'POST', { type, sessionId: 'sess-a', data: { answer: 'done' } });
  }
  await until(() => ticketFile(t, 'fix-login').status === 'delivered', 30_000);
  expect((await inbox(s, 'shop-api')).join('\n')).toMatch(/ended without a verdict|could not start/);
  failReviewers = false;
  s.setLimits({ global: 20, perProject: 20 });
  expect((await tool(s, 'shop-api', 'request_review', { name: 'fix-login' })).body).toMatchObject({ status: 'ok', reviewer: 'review-fix-login-r2' });
});

it('a reviewer running when the usage limit stops everything gives the ticket back as delivered; the delivered author is not committed', async () => {
  const { s, t } = await boot();
  await deliverTicket(s, t);
  expect((await tool(s, 'shop-api', 'request_review', { name: 'fix-login' })).body).toMatchObject({ status: 'ok', reviewer: 'review-fix-login' });
  const author = worktreePathFor(t.repo, 'fix-login');
  const before = gitSync(author, 'rev-parse', 'HEAD');
  writeFileSync(join(author, 'stray.txt'), 'not part of the delivery\n'); // a dirty file in the delivered author's worktree
  await until(async () => (await agentsOf(s)).some((a) => a.slug === 'review-fix-login' && a.status === 'running'));
  await modEvent(s, 'shop-api', 'quota', { rateLimits: [{ kind: 'five_hour', percentUsed: 96 }] });
  await until(() => ticketFile(t, 'fix-login').status === 'delivered', 20_000);
  expect(ticketFile(t, 'fix-login').reviewer).toBeUndefined();
  await until(async () => (await inbox(s, 'shop-api')).some((m) => m.includes('review-fix-login') && m.includes('request_review')), 20_000);
  await until(async () => (await agentsOf(s)).find((a) => a.slug === 'review-fix-login')?.status === 'exited', 20_000);
  await until(async () => (await agentsOf(s)).find((a) => a.slug === 'fix-login')?.status === 'exited', 20_000);
  expect(gitSync(author, 'rev-parse', 'HEAD')).toBe(before); // no WIP commit moved the delivered branch
  expect(gitSync(t.repo, 'log', '--format=%s', '-1', 'agent/shop-api/fix-login')).not.toMatch(/^wip:/);
});
