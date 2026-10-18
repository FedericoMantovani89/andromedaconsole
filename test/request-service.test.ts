import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { RequestService, type RequestDeps } from '../src/server/requests/service';
import { RequestStore } from '../src/server/requests/store';
import type { Role } from '../src/server/agents/registry';
import type { TicketStatus } from '../src/server/tickets/flow';
import type { Activity } from '../src/shared/activity';

const MAIN = 'shop-api';
const MIN = 60_000;
let now: number;
let n: number;
let store: RequestStore;
let sessions: Map<string, { role: Role; state: Activity }>;
let tickets: Map<string, TicketStatus>;
let sent: { to: string; text: string; id: string }[];
let waits: { slug: string; n: number; requestId: string; to: string }[];
let refuseWait: string | undefined;
let cleared: { slug: string; id: string }[];
let clearResult: { n: number; title: string } | undefined;
let clearFails: boolean;
let changes: number;
let svc: RequestService;

beforeEach(() => {
  now = 1_000_000; n = 0; sent = []; waits = []; cleared = []; refuseWait = undefined; clearResult = undefined; clearFails = false; changes = 0;
  store = new RequestStore();
  tickets = new Map();
  sessions = new Map<string, { role: Role; state: Activity }>([
    [MAIN, { role: 'main', state: 'idle' }], ['fe-pages', { role: 'agent', state: 'working' }], ['be-orders', { role: 'agent', state: 'idle' }],
    ['db-model', { role: 'agent', state: 'working' }], ['rev-1', { role: 'reviewer', state: 'working' }],
  ]);
  svc = new RequestService(makeDeps(store));
});

const makeDeps = (st: RequestStore): RequestDeps => ({
  store: st, mainSlug: MAIN,
  agent: (slug) => sessions.get(slug),
  ticketStatus: (slug) => tickets.get(slug),
  push: (to, text) => { const id = `m${++n}`; sent.push({ to, text, id }); return id; },
  markWaiting: async (slug, step, w) => { if (refuseWait) return { ok: false, detail: refuseWait }; waits.push({ slug, n: step, ...w }); return { ok: true }; },
  clearWaiting: async (slug, id) => { cleared.push({ slug, id }); if (clearFails) throw new Error('disk full'); return clearResult; },
  timeoutMs: () => 15 * MIN, maxHops: () => 3, now: () => now, changed: () => { changes++; },
});

const ask = async (from: string, to: string, extra: Record<string, unknown> = {}) =>
  svc.send(from, { type: 'question', to, text: 'What are the REST signatures?', ...extra }) as Promise<{ status: string; requestId?: string; code?: string; escalated?: string }>;
const idOf = (r: { requestId?: string }): string => r.requestId!;

describe('a question', () => {
  it('creates a request, tells the recipient who asks and marks the step as waiting', async () => {
    const r = await ask('fe-pages', 'be-orders', { step: 3 });
    expect(r.status).toBe('ok');
    expect(idOf(r)).toMatch(/^TODO-[0-9a-f]{6}$/);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'be-orders' });
    expect(sent[0]!.text).toContain(idOf(r));
    expect(sent[0]!.text).toContain('"fe-pages"');
    expect(sent[0]!.text).toContain('not an order');
    expect(waits).toEqual([{ slug: 'fe-pages', n: 3, requestId: idOf(r), to: 'be-orders' }]);
    expect(store.get(idOf(r))).toMatchObject({ state: 'open', hops: 0, from: 'fe-pages', to: 'be-orders', messageId: 'm1' });
  });
  it('without a step nothing is marked waiting', async () => {
    await ask('fe-pages', 'be-orders');
    expect(waits).toEqual([]);
  });
  it('is refused for yourself, an unknown name, a reviewer, and an overlong or empty text', async () => {
    expect(await ask('fe-pages', 'fe-pages')).toMatchObject({ status: 'refused', code: 'self' });
    expect(await ask('fe-pages', 'nobody')).toMatchObject({ status: 'refused', code: 'unknown_recipient' });
    expect(await ask('fe-pages', 'rev-1')).toMatchObject({ status: 'refused', code: 'not_peer' });
    expect(await svc.send('fe-pages', { type: 'question', to: 'be-orders', text: 'x'.repeat(8001) })).toMatchObject({ status: 'refused', code: 'text_too_long' });
    expect(await svc.send('fe-pages', { type: 'question', to: 'be-orders', text: '  ' })).toEqual({ status: 'error', code: 'bad_request', detail: 'text is required' });
    expect(await svc.send('fe-pages', { type: 'chat', to: 'be-orders', text: 'x' })).toEqual({ status: 'error', code: 'bad_request', detail: 'type must be one of question, answer, info, unknown, escalate' });
    expect(await svc.send('fe-pages', { type: 'question', text: 'x' })).toEqual({ status: 'error', code: 'bad_request', detail: 'to is required for type "question"' });
    expect(await svc.send('be-orders', { type: 'answer', in_reply_to: 'TODO-ffffff', text: ' ' })).toEqual({ status: 'error', code: 'bad_request', detail: 'text is required' });
    expect(store.list()).toEqual([]);
    expect(sent).toEqual([]);
  });
  it('a refused step creates no request and sends nothing', async () => {
    refuseWait = 'the validation and documentation steps cannot wait for an answer';
    const r = await ask('fe-pages', 'be-orders', { step: 5 });
    expect(r).toMatchObject({ status: 'refused', code: 'bad_step' });
    expect(store.list()).toEqual([]);
    expect(sent).toEqual([]);
  });
  it('a step needs a whole number from an agent; the main has no checklist', async () => {
    expect(await ask('fe-pages', 'be-orders', { step: 'three' })).toEqual({ status: 'error', code: 'bad_request', detail: 'step must be a whole number of 1 or more' });
    expect(await ask('fe-pages', 'be-orders', { because: 7 })).toEqual({ status: 'error', code: 'bad_request', detail: 'because must be a request id' });
    expect(await ask(MAIN, 'be-orders', { step: 3 })).toMatchObject({ status: 'refused', code: 'bad_step' });
  });
  it('a question to an unreachable agent goes to the main at once (reviewer is refused, the others are unreachable)', async () => {
    sessions.set('be-orders', { role: 'agent', state: 'interrupted' });
    const r = await ask('fe-pages', 'be-orders');
    expect(r).toMatchObject({ status: 'ok', escalated: 'recipient_gone' });
    expect(store.get(idOf(r))).toMatchObject({ state: 'escalated', escalatedBy: 'recipient_gone' });
    expect(sent.map((s) => s.to).sort()).toEqual(['fe-pages', MAIN]);
    tickets.set('db-model', 'delivered');
    expect(await ask('fe-pages', 'db-model')).toMatchObject({ escalated: 'recipient_gone' });
  });
});

describe('the clock', () => {
  it('starts at acknowledgement, not at creation', async () => {
    const r = await ask('fe-pages', 'be-orders');
    const created = now;
    expect(store.get(idOf(r))!.deadline).toBe(created + 30 * MIN); // undelivered cap: twice the timeout
    now += 20 * MIN;
    svc.onDelivered('be-orders', 'm1');
    expect(store.get(idOf(r))).toMatchObject({ deliveredAt: now, deadline: now + 15 * MIN });
    now += 14 * MIN; svc.tick();
    expect(store.get(idOf(r))!.state).toBe('open');
    now += 2 * MIN; svc.tick();
    expect(store.get(idOf(r))).toMatchObject({ state: 'escalated', escalatedBy: 'timeout' });
    const toMain = sent.find((s) => s.to === MAIN)!;
    expect(toMain.text).toContain(idOf(r));
    expect(toMain.text).toContain('did not answer in time');
    expect(sent.some((s) => s.to === 'fe-pages' && s.text.includes('the main was asked'))).toBe(true);
  });
  it('an acknowledgement of another message or by another session starts nothing', async () => {
    const r = await ask('fe-pages', 'be-orders');
    svc.onDelivered('be-orders', 'other');
    svc.onDelivered('db-model', 'm1');
    expect(store.get(idOf(r))!.deliveredAt).toBeUndefined();
  });
  it('a restart keeps the request, its message id and the clock: the new service goes on where the old one was', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'req-restart-')), 'state', 'requests.json');
    const before = new RequestService(makeDeps(new RequestStore(file)));
    const r = await before.send('fe-pages', { type: 'question', to: 'be-orders', text: 'REST signatures?', step: 3 }) as { requestId: string };
    now += 5 * MIN;
    before.onDelivered('be-orders', 'm1');
    const reloaded = new RequestStore(file);
    reloaded.load();
    const after = new RequestService(makeDeps(reloaded));
    expect(reloaded.get(r.requestId)).toMatchObject({ state: 'open', messageId: 'm1', deliveredAt: now, deadline: now + 15 * MIN });
    expect(after.debts('be-orders')).toEqual([r.requestId]);
    now += 16 * MIN; after.tick();
    expect(reloaded.get(r.requestId)).toMatchObject({ state: 'escalated', escalatedBy: 'timeout' });
  });
  it('an acknowledgement tells the UI that the deadline changed', async () => {
    await ask('fe-pages', 'be-orders');
    const before = changes;
    svc.onDelivered('be-orders', 'm1');
    expect(changes).toBe(before + 1);
  });
  it('a start restarts the clocks: the time the console was off does not count against the timeout', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'req-clocks-')), 'state', 'requests.json');
    const before = new RequestService(makeDeps(new RequestStore(file)));
    const acked = await before.send('fe-pages', { type: 'question', to: 'be-orders', text: 'acked' }) as { requestId: string };
    before.onDelivered('be-orders', 'm1');
    const unacked = await before.send('fe-pages', { type: 'question', to: 'db-model', text: 'not acked' }) as { requestId: string };
    const toMain = await before.send('fe-pages', { type: 'question', to: MAIN, text: 'main' }) as { requestId: string };
    now += 600 * MIN;
    const reloaded = new RequestStore(file);
    reloaded.load();
    const after = new RequestService(makeDeps(reloaded));
    after.restartClocks();
    after.tick();
    expect(reloaded.get(acked.requestId)).toMatchObject({ state: 'open', deadline: now + 15 * MIN });
    expect(reloaded.get(unacked.requestId)).toMatchObject({ state: 'open', deadline: now + 30 * MIN });
    expect(reloaded.get(toMain.requestId)!.deadline).toBeUndefined();
    now += 16 * MIN; after.tick();
    expect(reloaded.get(acked.requestId)!.state).toBe('escalated');
    expect(reloaded.get(unacked.requestId)!.state).toBe('open');
  });
  it('a message never acknowledged still goes to the main after twice the timeout', async () => {
    const r = await ask('fe-pages', 'be-orders');
    now += 31 * MIN; svc.tick();
    expect(store.get(idOf(r))).toMatchObject({ state: 'escalated', escalatedBy: 'timeout' });
  });
  it('a question to the main has no timeout and an escalated request has no second one', async () => {
    const r = await ask('fe-pages', MAIN);
    expect(store.get(idOf(r))!.deadline).toBeUndefined();
    svc.onDelivered(MAIN, 'm1');
    now += 600 * MIN; svc.tick();
    expect(store.get(idOf(r))!.state).toBe('open');
    const e = await ask('fe-pages', 'be-orders');
    now += 31 * MIN; svc.tick();
    expect(store.get(idOf(e))!.deadline).toBeUndefined();
  });
});

describe('answering', () => {
  it('the recipient closes the request, the waiting step is cleared and the sender gets the answer with the step', async () => {
    const r = await ask('fe-pages', 'be-orders', { step: 3 });
    clearResult = { n: 3, title: 'Implement a' };
    expect(await svc.send('be-orders', { type: 'answer', in_reply_to: idOf(r), text: 'POST /orders {sku, qty} -> 201' })).toEqual({ status: 'ok' });
    expect(store.get(idOf(r))).toMatchObject({ state: 'answered' });
    expect(cleared).toEqual([{ slug: 'fe-pages', id: idOf(r) }]);
    const back = sent.at(-1)!;
    expect(back.to).toBe('fe-pages');
    expect(back.text).toContain('POST /orders');
    expect(back.text).toContain('step 3');
    expect(back.text).toContain(`remove the comment`);
  });
  it('without a waiting step the answer still arrives', async () => {
    const r = await ask('fe-pages', 'be-orders');
    await svc.send('be-orders', { type: 'answer', in_reply_to: idOf(r), text: 'here' });
    expect(sent.at(-1)!.text).toContain(idOf(r));
  });
  it('only the recipient (or the main) may answer; a second answer is refused and delivers nothing', async () => {
    const r = await ask('fe-pages', 'be-orders');
    expect(await svc.send('db-model', { type: 'answer', in_reply_to: idOf(r), text: 'me' })).toMatchObject({ status: 'refused', code: 'not_addressee' });
    expect(await svc.send('be-orders', { type: 'answer', in_reply_to: idOf(r), text: 'first' })).toEqual({ status: 'ok' });
    const count = sent.length;
    expect(await svc.send('be-orders', { type: 'answer', in_reply_to: idOf(r), text: 'second' })).toMatchObject({ status: 'refused', code: 'already_closed' });
    expect(await svc.send(MAIN, { type: 'answer', in_reply_to: idOf(r), text: 'third' })).toMatchObject({ status: 'refused', code: 'already_closed' });
    expect(sent).toHaveLength(count);
    expect(await svc.send('be-orders', { type: 'answer', in_reply_to: 'TODO-ffffff', text: 'x' })).toMatchObject({ status: 'refused', code: 'unknown_request' });
    expect(await svc.send('be-orders', { type: 'answer', text: 'x' })).toEqual({ status: 'error', code: 'bad_request', detail: 'in_reply_to is required for type "answer"' });
  });
  it('the main may answer any open request, and the one it received after an escalation', async () => {
    const r = await ask('fe-pages', 'be-orders');
    expect(await svc.send(MAIN, { type: 'answer', in_reply_to: idOf(r), text: 'main knows' })).toEqual({ status: 'ok' });
    const e = await ask('fe-pages', 'be-orders');
    await svc.send('be-orders', { type: 'unknown', in_reply_to: idOf(e) });
    expect(store.get(idOf(e))!.state).toBe('escalated');
    expect(await svc.send(MAIN, { type: 'answer', in_reply_to: idOf(e), text: 'decided' })).toEqual({ status: 'ok' });
  });
  it('a late answer from the original recipient settles an escalated request and tells the main it need not answer', async () => {
    const e = await ask('fe-pages', 'be-orders', { step: 3 });
    await svc.send('be-orders', { type: 'unknown', in_reply_to: idOf(e) });
    expect(await svc.send('db-model', { type: 'answer', in_reply_to: idOf(e), text: 'me' })).toMatchObject({ status: 'refused', code: 'not_addressee' });
    clearResult = { n: 3, title: 'Implement a' };
    expect(await svc.send('be-orders', { type: 'answer', in_reply_to: idOf(e), text: 'late after all' })).toEqual({ status: 'ok' });
    expect(store.get(idOf(e))!.state).toBe('answered');
    expect(cleared).toEqual([{ slug: 'fe-pages', id: idOf(e) }]);
    const toAsker = sent.filter((s) => s.to === 'fe-pages').at(-1)!;
    expect(toAsker.text).toContain('late after all');
    expect(toAsker.text).toContain('step 3');
    const toMain = sent.filter((s) => s.to === MAIN).at(-1)!;
    expect(toMain.text).toContain(idOf(e));
    expect(toMain.text).toContain('"be-orders" answered it after all');
    expect(await svc.send(MAIN, { type: 'answer', in_reply_to: idOf(e), text: 'too late' })).toMatchObject({ status: 'refused', code: 'already_closed' });
  });
  it('an answer still reaches the asker when the waiting step cannot be cleared', async () => {
    const r = await ask('fe-pages', 'be-orders', { step: 3 });
    clearFails = true;
    expect(await svc.send('be-orders', { type: 'answer', in_reply_to: idOf(r), text: 'POST /orders' })).toEqual({ status: 'ok' });
    expect(store.get(idOf(r))!.state).toBe('answered');
    const back = sent.at(-1)!;
    expect(back.to).toBe('fe-pages');
    expect(back.text).toContain('POST /orders');
    expect(back.text).not.toContain('step 3');
  });
  it('unknown and escalate pass the request to the main with the note; a request to the main cannot be passed up', async () => {
    const a = await ask('fe-pages', 'be-orders');
    expect(await svc.send('be-orders', { type: 'unknown', in_reply_to: idOf(a), text: 'ask db-model' })).toEqual({ status: 'ok' });
    expect(store.get(idOf(a))).toMatchObject({ state: 'escalated', escalatedBy: 'unknown' });
    expect(sent.find((s) => s.to === MAIN)!.text).toContain('ask db-model');
    const b = await ask('fe-pages', 'be-orders');
    expect(await svc.send('be-orders', { type: 'escalate', in_reply_to: idOf(b), text: 'a product choice' })).toEqual({ status: 'ok' });
    expect(store.get(idOf(b))).toMatchObject({ escalatedBy: 'explicit' });
    expect(await svc.send('be-orders', { type: 'escalate', in_reply_to: idOf(b) })).toEqual({ status: 'error', code: 'bad_request', detail: 'text is required' });
    const c = await ask('fe-pages', MAIN);
    expect(await svc.send(MAIN, { type: 'unknown', in_reply_to: idOf(c) })).toMatchObject({ status: 'refused', code: 'top_of_chain' });
  });
});

describe('chains', () => {
  it('because raises the depth, is refused past the limit and when the recipient is already waiting up the chain', async () => {
    sessions.set('x1', { role: 'agent', state: 'working' }); sessions.set('x2', { role: 'agent', state: 'working' });
    const r0 = await ask('fe-pages', 'be-orders');                       // hops 0
    const r1 = await ask('be-orders', 'db-model', { because: idOf(r0) }); // hops 1
    expect(store.get(idOf(r1))).toMatchObject({ hops: 1, parent: idOf(r0) });
    expect(await ask('db-model', 'fe-pages', { because: idOf(r1) })).toMatchObject({ status: 'refused', code: 'cycle' });
    expect(await ask('db-model', 'be-orders', { because: idOf(r1) })).toMatchObject({ status: 'refused', code: 'cycle' });
    const r2 = await ask('db-model', 'x1', { because: idOf(r1) });        // hops 2
    const r3 = await ask('x1', 'x2', { because: idOf(r2) });              // hops 3
    expect(store.get(idOf(r3))!.hops).toBe(3);
    sessions.set('x3', { role: 'agent', state: 'working' });
    expect(await ask('x2', 'x3', { because: idOf(r3) })).toMatchObject({ status: 'refused', code: 'too_many_hops' });
  });
  it('because must name an open request the sender is handling', async () => {
    const r0 = await ask('fe-pages', 'be-orders');
    expect(await ask('db-model', 'fe-pages', { because: idOf(r0) })).toMatchObject({ status: 'refused', code: 'unknown_request' });
    expect(await ask('be-orders', 'db-model', { because: 'TODO-ffffff' })).toMatchObject({ status: 'refused', code: 'unknown_request' });
    await svc.send('be-orders', { type: 'answer', in_reply_to: idOf(r0), text: 'x' });
    expect(await ask('be-orders', 'db-model', { because: idOf(r0) })).toMatchObject({ status: 'refused', code: 'unknown_request' });
  });
  it('independent mutual questions are allowed', async () => {
    await ask('fe-pages', 'be-orders');
    expect(await ask('be-orders', 'fe-pages')).toMatchObject({ status: 'ok' });
  });
});

describe('an agent that goes away', () => {
  it('escalates what was asked of it and cancels what it asked', async () => {
    const toIt = await ask('fe-pages', 'be-orders');
    const fromIt = await ask('be-orders', 'db-model');
    const other = await ask('fe-pages', 'db-model');
    svc.agentGone('be-orders');
    expect(store.get(idOf(toIt))).toMatchObject({ state: 'escalated', escalatedBy: 'recipient_gone' });
    expect(store.get(idOf(fromIt))!.state).toBe('cancelled');
    expect(store.get(idOf(other))!.state).toBe('open');
    expect(await svc.send('db-model', { type: 'answer', in_reply_to: idOf(fromIt), text: 'late' })).toMatchObject({ status: 'refused', code: 'already_closed' });
  });
  it('ended for good: the waiting steps of its cancelled requests are released and the recipient is told it need not answer', async () => {
    const fromIt = await ask('be-orders', 'db-model');
    const escalatedFromIt = await ask('be-orders', 'fe-pages');
    await svc.send('fe-pages', { type: 'unknown', in_reply_to: idOf(escalatedFromIt) });
    const toMain = await ask('be-orders', MAIN);
    const count = sent.length;
    svc.agentGone('be-orders');
    expect(cleared.map((c) => c.id).sort()).toEqual([idOf(fromIt), idOf(escalatedFromIt), idOf(toMain)].sort());
    expect(cleared.every((c) => c.slug === 'be-orders')).toBe(true);
    const told = sent.slice(count);
    const toDb = told.find((s) => s.to === 'db-model')!;
    expect(toDb.text).toContain(idOf(fromIt));
    expect(toDb.text).toContain('"be-orders" is not working any more');
    // An escalated request is held by the main, so the main is the one told.
    expect(told.some((s) => s.to === 'fe-pages')).toBe(false);
    expect(told.filter((s) => s.to === MAIN).map((s) => s.text).join('\n')).toContain(idOf(escalatedFromIt));
    expect(told.filter((s) => s.to === MAIN).map((s) => s.text).join('\n')).toContain(idOf(toMain));
  });
  it('ended for good: a recipient that is not running any more is not told', async () => {
    const fromIt = await ask('be-orders', 'db-model');
    sessions.set('db-model', { role: 'agent', state: 'finished' });
    const count = sent.length;
    svc.agentGone('be-orders');
    expect(store.get(idOf(fromIt))!.state).toBe('cancelled');
    expect(sent.slice(count)).toEqual([]);
  });
  it('stopped (it will go on): what it asked stays open with its waiting step, what was asked of it goes to the main', async () => {
    const toIt = await ask('fe-pages', 'be-orders');
    const fromIt = await ask('be-orders', 'db-model', { step: 2 });
    const escalatedFromIt = await ask('be-orders', 'fe-pages');
    await svc.send('fe-pages', { type: 'unknown', in_reply_to: idOf(escalatedFromIt) });
    const count = sent.length;
    svc.agentStopped('be-orders');
    expect(store.get(idOf(toIt))).toMatchObject({ state: 'escalated', escalatedBy: 'recipient_gone' });
    expect(store.get(idOf(fromIt))!.state).toBe('open');
    expect(store.get(idOf(escalatedFromIt))!.state).toBe('escalated');
    expect(cleared).toEqual([]);
    expect(sent.slice(count).some((s) => s.to === 'db-model')).toBe(false);
    clearResult = { n: 2, title: 'Use the model' };
    expect(await svc.send('db-model', { type: 'answer', in_reply_to: idOf(fromIt), text: 'here' })).toEqual({ status: 'ok' });
    expect(cleared).toEqual([{ slug: 'be-orders', id: idOf(fromIt) }]);
  });
  it('a replacement takes over the requests of the agent it replaces, both ways', async () => {
    const fromIt = await ask('be-orders', 'db-model', { step: 2 });
    const toIt = await ask('fe-pages', 'be-orders');
    const answered = await ask('be-orders', 'fe-pages');
    await svc.send('fe-pages', { type: 'answer', in_reply_to: idOf(answered), text: 'done' });
    sessions.set('be-orders-r1', { role: 'agent', state: 'working' });
    svc.rename('be-orders', 'be-orders-r1');
    expect(store.get(idOf(fromIt))!.from).toBe('be-orders-r1');
    expect(store.get(idOf(toIt))!.to).toBe('be-orders-r1');
    expect(store.get(idOf(answered))!.from).toBe('be-orders');
    expect(svc.idsFrom('be-orders-r1')).toEqual([idOf(fromIt)]);
    expect(svc.debts('be-orders-r1')).toEqual([idOf(toIt)]);
    expect(await svc.send('db-model', { type: 'answer', in_reply_to: idOf(fromIt), text: 'here' })).toEqual({ status: 'ok' });
    expect(cleared.at(-1)).toEqual({ slug: 'be-orders-r1', id: idOf(fromIt) });
    expect(sent.at(-1)!.to).toBe('be-orders-r1');
    expect(await svc.send('be-orders-r1', { type: 'answer', in_reply_to: idOf(toIt), text: 'ok' })).toEqual({ status: 'ok' });
  });
});

describe('reads', () => {
  it('debts are the open requests addressed to a session; idsFrom are all it made', async () => {
    const a = await ask('fe-pages', 'be-orders');
    const b = await ask('fe-pages', 'db-model');
    expect(svc.debts('be-orders')).toEqual([idOf(a)]);
    expect(svc.idsFrom('fe-pages').sort()).toEqual([idOf(a), idOf(b)].sort());
    await svc.send('be-orders', { type: 'answer', in_reply_to: idOf(a), text: 'x' });
    expect(svc.debts('be-orders')).toEqual([]);
    await svc.send('db-model', { type: 'unknown', in_reply_to: idOf(b) });
    expect(svc.debts('db-model')).toEqual([]);
    expect(svc.handlerOf(idOf(b))).toBe(MAIN);
    expect(svc.handlerOf(idOf(a))).toBe('be-orders');
  });
  it('rows show the live requests first, then the latest settled ones, with ISO times and a cut text', async () => {
    const a = await ask('fe-pages', 'be-orders');
    await svc.send('be-orders', { type: 'answer', in_reply_to: idOf(a), text: 'x' });
    now += 1000;
    const b = await svc.send('fe-pages', { type: 'question', to: 'db-model', text: 'y'.repeat(500) }) as { requestId: string };
    const rows = svc.rows();
    expect(rows.map((r) => r.id)).toEqual([b.requestId, idOf(a)]);
    expect(rows[0]).toMatchObject({ state: 'open', handler: 'db-model' });
    expect(rows[0]!.text).toHaveLength(300);
    expect(rows[0]!.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
  it('infoFor merges the waiting steps (shown against whoever holds the request now) with the debts', async () => {
    const a = await ask('fe-pages', 'be-orders', { step: 3 });
    await svc.send('be-orders', { type: 'unknown', in_reply_to: idOf(a) });
    expect(svc.infoFor('fe-pages', [{ requestId: idOf(a), to: 'be-orders' }])).toEqual({ waiting: [{ id: idOf(a), to: MAIN }], owed: [] });
    const b = await ask('fe-pages', 'db-model');
    expect(svc.infoFor('db-model', [])).toEqual({ waiting: [], owed: [{ id: idOf(b), from: 'fe-pages' }] });
    expect(svc.infoFor('x', [])).toBeUndefined();
  });
});

describe('information', () => {
  it('is delivered as information to a reachable colleague and refused otherwise', async () => {
    expect(await svc.send('be-orders', { type: 'info', to: 'fe-pages', text: 'DDL are ready' })).toEqual({ status: 'ok' });
    expect(sent.at(-1)).toMatchObject({ to: 'fe-pages' });
    expect(sent.at(-1)!.text).toContain('not an order');
    expect(store.list()).toEqual([]);
    sessions.set('db-model', { role: 'agent', state: 'finished' });
    expect(await svc.send('be-orders', { type: 'info', to: 'db-model', text: 'x' })).toMatchObject({ status: 'refused', code: 'unknown_recipient' });
    expect(await svc.send('be-orders', { type: 'info', to: 'rev-1', text: 'x' })).toMatchObject({ status: 'refused', code: 'not_peer' });
  });
});
