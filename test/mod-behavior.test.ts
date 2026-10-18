// Behaviour of the console mod, run against a fake `$` (the engine API). The real engine is covered by
// test/e2e/mod-real-claude.ts; here we pin the failure paths the real run does not exercise.
import { it, expect, vi } from 'vitest';

type Hook = (...args: any[]) => Promise<any>;
interface Registered { event: string; matcher?: { tool?: string }; hook: Hook }

async function loadMod() {
  vi.resetModules(); // the mod keeps module-level state, like it does in a real process
  const mod = await import('../mod/hooks/register.js');
  const registered: Registered[] = [];
  mod.register((event: string, a: unknown, b?: unknown) => {
    registered.push(b === undefined ? { event, hook: a as Hook } : { event, matcher: a as { tool?: string }, hook: b as Hook });
  });
  const find = (event: string, tool?: string) => registered.find((r) => r.event === event && r.matcher?.tool === tool)!.hook;
  return { find };
}

interface FakeOptions {
  env?: Record<string, string | undefined>;
  fetch?: (url: string, init: { method?: string; body?: string }) => { ok: boolean; status?: number; text?: string } | Error;
  /** What `$.prompt.submit` does; by default the prompt enters and the engine answers `{ text }`. */
  submit?: (text: string) => Promise<unknown>;
}
function fake$(o: FakeOptions = {}) {
  const env = { CONSOLE_URL: 'http://127.0.0.1:1', CONSOLE_TOKEN: 'T', CONSOLE_ROLE: 'main', CONSOLE_AGENT: 'shop-api', ...o.env };
  const calls: string[] = [];
  const ticks: (() => Promise<void> | void)[] = [];
  const registeredTools: string[] = [];
  const submitted: string[] = [];
  const $ = {
    env: { get: async (name: string) => env[name as keyof typeof env] },
    session: { id: async () => 'sid-1' },
    http: {
      fetch: async (url: string, init: { method?: string; body?: string } = {}) => {
        calls.push(`${init.method ?? 'GET'} ${url.replace('http://127.0.0.1:1', '')}`);
        const r = o.fetch ? o.fetch(url, init) : { ok: true, status: 200, text: '{}' };
        if (r instanceof Error) throw r;
        return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), text: r.text ?? '{}' };
      },
    },
    tool: { register: async (spec: { name: string }) => { registeredTools.push(spec.name); } },
    clock: { every: (_ms: number, fn: () => Promise<void> | void) => { ticks.push(fn); }, sleep: async () => {}, now: async () => time },
    prompt: { submit: async ({ text }: { text: string }) => { submitted.push(text); calls.push('submit'); return o.submit ? o.submit(text) : { text }; } },
  };
  let time = 1_000_000;
  /** Moves the fake clock forward (`$.clock.now`). */
  const advance = (ms: number) => { time += ms; };
  return { $, calls, ticks, registeredTools, submitted, advance };
}
const next = vi.fn(async (e: unknown) => ({ next: e }));

it('does nothing when it was not launched by the console (no URL or token): no calls, no tools, session untouched', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_URL: undefined, CONSOLE_TOKEN: undefined } });
  const out = await find('session.start')(f.$, { cwd: '/x' }, next);
  expect(out).toEqual({ next: { cwd: '/x' } });
  expect(f.calls).toEqual([]);
  expect(f.registeredTools).toEqual([]);
  expect(f.ticks).toEqual([]);
});
it('registers the tools of its role once and starts one inbox poller, even if session.start fires twice', async () => {
  const { find } = await loadMod();
  const f = fake$();
  await find('session.start')(f.$, {}, next);
  await find('session.start')(f.$, {}, next);
  expect(f.registeredTools).toEqual(['spawn_agent', 'list_agents', 'send_message', 'ticket_report', 'request_review', 'send_back_ticket', 'merge_ticket', 'propose_release', 'start_recovery', 'resume_agent', 'worktree_cleanup']);
  expect(f.ticks).toHaveLength(1);
});
it('an agent gets list_agents and the ticket tools, never spawn_agent', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' } });
  await find('session.start')(f.$, {}, next);
  expect(f.registeredTools).toEqual(['list_agents', 'send_message', 'checklist_set', 'step_done', 'report_blocked']);
});
// ---- inbox delivery (SPEC 10.5 "conferma di ricezione"): acknowledged only once the prompt entered the session ----
/** A console whose inbox keeps offering every message until it is acknowledged, like src/server/agents/inbox.ts. */
function inboxConsole(messages: { id: string; text: string }[], ackOk: () => boolean = () => true) {
  const box = [...messages];
  const acks: string[] = [];
  const fetch = (url: string, init: { method?: string; body?: string }) => {
    if (url.endsWith('/v1/inbox')) return { ok: true, text: JSON.stringify({ messages: box }) };
    if (url.endsWith('/v1/ack')) {
      const id = JSON.parse(init.body ?? '{}').id as string;
      acks.push(id);
      if (!ackOk()) return { ok: false, status: 500 };
      const i = box.findIndex((m) => m.id === id);
      if (i >= 0) box.splice(i, 1);
      return { ok: true, status: 204, text: '' };
    }
    return { ok: true, text: '{}' };
  };
  return { fetch, acks, box };
}

it('delivers an inbox message as a prompt and acknowledges it after the prompt entered', async () => {
  const { find } = await loadMod();
  const c = inboxConsole([{ id: 'm1', text: 'hello goal' }]);
  const f = fake$({ fetch: c.fetch });
  await find('session.start')(f.$, {}, next);
  await f.ticks[0]!();
  expect(f.submitted).toEqual(['hello goal']);
  expect(f.calls.indexOf('POST /v1/ack')).toBeGreaterThan(f.calls.indexOf('submit'));
  expect(c.box).toEqual([]);
});
it.each([
  ['throws', async () => { throw new Error('engine busy'); }],
  ['is dropped', async () => ({ drop: 'a Stop hook stands' })],
  ['resolves with nothing', async () => undefined],
])('a prompt that %s is not acknowledged: the next poll offers it again and it is submitted again', async (_label, failing) => {
  const { find } = await loadMod();
  const c = inboxConsole([{ id: 'm1', text: 'the question' }, { id: 'm2', text: 'later' }]);
  let attempts = 0;
  const f = fake$({ fetch: c.fetch, submit: async (text) => { attempts += 1; return attempts === 1 ? failing() : { text }; } });
  await find('session.start')(f.$, {}, next);
  await f.ticks[0]!();
  expect(c.acks).toEqual([]); // the console still holds both, and the order is kept: m2 waits behind m1
  expect(f.submitted).toEqual(['the question']);
  f.advance(2000); // past the first back-off window
  await f.ticks[0]!();
  expect(f.submitted).toEqual(['the question', 'the question', 'later']);
  expect(c.acks).toEqual(['m1', 'm2']);
  expect(c.box).toEqual([]);
});
it('a message whose acknowledgement failed after it entered is acknowledged on the next poll but not submitted twice', async () => {
  const { find } = await loadMod();
  let ackCalls = 0;
  const c = inboxConsole([{ id: 'm1', text: 'goal' }], () => { ackCalls += 1; return ackCalls > 1; });
  const f = fake$({ fetch: c.fetch });
  await find('session.start')(f.$, {}, next);
  await f.ticks[0]!();
  expect(f.submitted).toEqual(['goal']);
  expect(c.box).toHaveLength(1); // the console did not hear the ack: it offers m1 again
  await f.ticks[0]!();
  expect(f.submitted).toEqual(['goal']);
  expect(c.acks).toEqual(['m1', 'm1']);
  expect(c.box).toEqual([]);
  await f.ticks[0]!();
  expect(f.submitted).toEqual(['goal']);
});
it('a message the engine keeps refusing is retried with a growing back-off, never acknowledged, and holds the ones behind it', async () => {
  const { find } = await loadMod();
  const c = inboxConsole([{ id: 'm1', text: 'blocked' }, { id: 'm2', text: 'behind' }]);
  const f = fake$({ fetch: c.fetch, submit: async () => ({ drop: 'a UserPromptSubmit hook blocks plugin prompts' }) });
  await find('session.start')(f.$, {}, next);
  const poll = async (ms: number) => { f.advance(ms); await f.ticks[0]!(); };
  await f.ticks[0]!();
  expect(f.submitted).toHaveLength(1); // t=0: first try, then a 2 s window
  await poll(1000);
  expect(f.submitted).toHaveLength(1); // t=1 s: inside the window, no resubmit
  await poll(1000);
  expect(f.submitted).toHaveLength(2); // t=2 s: retried, then a 4 s window
  await poll(2000);
  expect(f.submitted).toHaveLength(2); // t=4 s
  await poll(2000);
  expect(f.submitted).toHaveLength(3); // t=6 s: retried, then 8 s
  await poll(7000);
  expect(f.submitted).toHaveLength(3); // t=13 s
  await poll(1000);
  expect(f.submitted).toHaveLength(4); // t=14 s
  for (let i = 0; i < 10; i++) await poll(60_000); // the window stops growing at 60 s: one try per minute
  expect(f.submitted).toHaveLength(14);
  expect(f.submitted.every((t) => t === 'blocked')).toBe(true);
  expect(c.acks).toEqual([]);
  expect(c.box.map((m) => m.id)).toEqual(['m1', 'm2']);
});
it('a success after failures delivers the message once and clears its back-off', async () => {
  const { find } = await loadMod();
  const c = inboxConsole([{ id: 'm1', text: 'first' }]);
  let attempts = 0;
  const f = fake$({ fetch: c.fetch, submit: async (text) => { attempts += 1; return attempts <= 2 ? { drop: 'busy' } : { text }; } });
  await find('session.start')(f.$, {}, next);
  await f.ticks[0]!();
  f.advance(2000); await f.ticks[0]!(); // second failure: a 4 s window
  f.advance(4000); await f.ticks[0]!(); // third try enters
  expect(f.submitted).toEqual(['first', 'first', 'first']);
  expect(c.acks).toEqual(['m1']);
  expect(c.box).toEqual([]);
  // The back-off was for m1 only: a new message enters at the next poll, with no wait.
  c.box.push({ id: 'm2', text: 'second' });
  attempts = 0;
  (f.$ as any).prompt.submit = async ({ text }: { text: string }) => { f.submitted.push(text); return attempts++ === 0 ? { drop: 'busy' } : { text }; };
  await f.ticks[0]!();
  f.advance(2000); await f.ticks[0]!();
  expect(f.submitted.slice(3)).toEqual(['second', 'second']);
  expect(c.acks).toEqual(['m1', 'm2']);
});
it('an ack answered 404 (the console no longer holds the message) clears it and the next message goes on', async () => {
  const { find } = await loadMod();
  const box = [{ id: 'gone', text: 'old' }, { id: 'm2', text: 'next' }];
  const acks: string[] = [];
  const fetch = (url: string, init: { body?: string }) => {
    if (url.endsWith('/v1/inbox')) return { ok: true, text: JSON.stringify({ messages: box }) };
    if (url.endsWith('/v1/ack')) {
      const id = JSON.parse(init.body ?? '{}').id as string;
      acks.push(id);
      const i = box.findIndex((m) => m.id === id);
      box.splice(i, 1);
      return id === 'gone' ? { ok: false, status: 404, text: '{"error":"not_found"}' } : { ok: true, status: 204, text: '' };
    }
    return { ok: true, text: '{}' };
  };
  const f = fake$({ fetch });
  await find('session.start')(f.$, {}, next);
  await f.ticks[0]!();
  expect(f.submitted).toEqual(['old', 'next']);
  expect(acks).toEqual(['gone', 'm2']);
  box.push({ id: 'gone', text: 'old' }); // offered again (another process): no longer remembered as delivered, so it enters again
  await f.ticks[0]!();
  expect(f.submitted).toEqual(['old', 'next', 'old']);
});
it('an ack that fails in the middle of a list stops the loop there; the next poll acknowledges it without a second submit', async () => {
  const { find } = await loadMod();
  let ackCalls = 0;
  const c = inboxConsole([{ id: 'm1', text: 'a' }, { id: 'm2', text: 'b' }, { id: 'm3', text: 'c' }], () => { ackCalls += 1; return ackCalls !== 2; }); // the first ack of m2 fails
  const f = fake$({ fetch: c.fetch });
  await find('session.start')(f.$, {}, next);
  await f.ticks[0]!();
  expect(f.submitted).toEqual(['a', 'b']); // m3 was not touched
  expect(c.acks).toEqual(['m1', 'm2']);
  expect(c.box.map((m) => m.id)).toEqual(['m2', 'm3']);
  await f.ticks[0]!();
  expect(f.submitted).toEqual(['a', 'b', 'c']); // b not again
  expect(c.acks).toEqual(['m1', 'm2', 'm2', 'm3']);
  expect(c.box).toEqual([]);
});
it('the acknowledgement is sent only after the submit resolved', async () => {
  const { find } = await loadMod();
  const c = inboxConsole([{ id: 'm1', text: 'goal' }]);
  let enter: (v: unknown) => void = () => {};
  const f = fake$({ fetch: c.fetch, submit: () => new Promise((r) => { enter = r; }) });
  await find('session.start')(f.$, {}, next);
  const tick = f.ticks[0]!();
  await vi.waitFor(() => expect(f.submitted).toEqual(['goal']));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(c.acks).toEqual([]);
  enter({ text: 'goal' });
  await tick;
  expect(c.acks).toEqual(['m1']);
});
it('a console that cannot be reached never breaks a hook: it still passes the event on', async () => {
  const { find } = await loadMod();
  const f = fake$({ fetch: () => new Error('ECONNREFUSED') });
  await find('session.start')(f.$, {}, next);
  const e = { turnId: 't1', answer: 'x' };
  expect(await find('turn.complete')(f.$, e, next)).toEqual({ next: e });
  expect(await find('turn.start')(f.$, {}, next)).toEqual({ next: {} });
});
it('turn.complete forwards the final answer', async () => {
  const { find } = await loadMod();
  const f = fake$();
  await find('session.start')(f.$, {}, next);
  let body = '';
  const g = fake$({ fetch: (_u, init) => { if (init.body) body = init.body; return { ok: true, text: '{}' }; } });
  await find('turn.complete')(g.$, { turnId: 't1', answer: 'the answer', isAborted: false, durationMs: 5 }, next);
  expect(JSON.parse(body)).toMatchObject({ type: 'turn.complete', sessionId: 'sid-1', data: { answer: 'the answer', turn: 't1' } });
});
it('ask_user waits through repeated polls and returns the human answer', async () => {
  const { find } = await loadMod();
  let polls = 0;
  const f = fake$({ fetch: (url, init) => {
    if (init.method === 'POST' && url.endsWith('/v1/tools/ask_user')) return { ok: true, text: JSON.stringify({ id: 'q1' }) };
    if (url.includes('/v1/questions/q1')) { polls += 1; return { ok: true, text: JSON.stringify(polls < 3 ? { answered: false } : { answered: true, answer: 'Red' }) }; }
    return { ok: true, text: '{}' };
  } });
  await find('session.start')(f.$, {}, next);
  const out = await find('tool.call', 'mcp__console-mod__ask_user')(f.$, { question: 'Color?', options: ['Red', 'Blue'] });
  expect(out).toEqual({ result: 'The user answered: Red' });
  expect(polls).toBe(3);
});
it('ask_user gives up with a clear message when the console stops answering, instead of hanging', async () => {
  const { find } = await loadMod();
  let created = false;
  const f = fake$({ fetch: (url, init) => {
    if (init.method === 'POST' && url.endsWith('/v1/tools/ask_user')) { created = true; return { ok: true, text: JSON.stringify({ id: 'q1' }) }; }
    return new Error('down');
  } });
  await find('session.start')(f.$, {}, next);
  const out = await find('tool.call', 'mcp__console-mod__ask_user')(f.$, { question: 'Color?' });
  expect(created).toBe(true);
  expect(out.result).toMatch(/No answer/);
});
it('an agent is refused AskUserQuestion and told to ask the main; a reviewer still goes to the console, and if it is unreachable the normal dialog is left alone', async () => {
  const { find } = await loadMod();
  const agent = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: () => new Error('down') });
  await find('session.start')(agent.$, {}, next);
  const refused = await find('tool.call', 'AskUserQuestion')(agent.$, { questions: [{ question: 'Fruit?' }] }, next);
  expect(refused.deny).toMatch(/send_message/);
  const f = fake$({ env: { CONSOLE_ROLE: 'reviewer', CONSOLE_AGENT: 'review-x' }, fetch: () => new Error('down') });
  await find('session.start')(f.$, {}, next);
  const e = { questions: [{ question: 'Fruit?', options: [{ label: 'Apple' }, { label: 'Pear' }] }] };
  expect(await find('tool.call', 'AskUserQuestion')(f.$, e, next)).toEqual({ next: e });
  const answering = fake$({ env: { CONSOLE_ROLE: 'reviewer', CONSOLE_AGENT: 'review-x' }, fetch: (url, init) => {
    if (init.method === 'POST' && url.endsWith('/v1/tools/ask_user')) return { ok: true, text: JSON.stringify({ id: 'q9' }) };
    if (url.includes('/v1/questions/q9')) return { ok: true, text: JSON.stringify({ answered: true, answer: 'Pear' }) };
    return { ok: true, text: '{}' };
  } });
  await find('session.start')(answering.$, {}, next);
  expect(await find('tool.call', 'AskUserQuestion')(answering.$, e, next)).toEqual({ result: { questions: e.questions, answers: { 'Fruit?': 'Pear' } } });
});

// ---- permission routing (tool.check) ----
const bashCheck = { tool: 'Bash', input: { command: 'echo hi > out.txt' }, tool_use_id: 'tu1' };
const asking = async () => ({ decision: 'ask', reason: 'Bash needs approval' });
const permissionFetch = (answer: string) => (url: string, init: { method?: string; body?: string }) => {
  if (init.method === 'POST' && url.endsWith('/v1/tools/ask_user')) return { ok: true, text: JSON.stringify({ id: 'p1' }) };
  if (url.includes('/v1/questions/p1')) return { ok: true, text: JSON.stringify({ answered: true, answer }) };
  return { ok: true, text: '{}' };
};

it('an agent permission prompt goes to the console queue as a permission, with the tool and what it would do', async () => {
  const { find } = await loadMod();
  const posted: any[] = [];
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: (url, init) => {
    if (init.method === 'POST' && url.endsWith('/v1/tools/ask_user')) { posted.push(JSON.parse(init.body!)); return { ok: true, text: JSON.stringify({ id: 'p1' }) }; }
    return permissionFetch('allow')(url, init);
  } });
  await find('session.start')(f.$, {}, next);
  const out = await find('tool.check')(f.$, bashCheck, asking);
  expect(out.decision).toBe('allow');
  expect(posted[0]).toMatchObject({ kind: 'permission', tool: 'Bash', detail: 'echo hi > out.txt' });
});
it('"deny" from the console refuses the tool with a reason the model reads', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: permissionFetch('deny') });
  await find('session.start')(f.$, {}, next);
  const out = await find('tool.check')(f.$, bashCheck, asking);
  expect(out.decision).toBe('deny');
  expect(out.reason).toMatch(/denied/i);
});
it('anything but an explicit allow is a deny (never allows by accident)', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: permissionFetch('maybe') });
  await find('session.start')(f.$, {}, next);
  expect((await find('tool.check')(f.$, bashCheck, asking)).decision).toBe('deny');
});
it('"allow_always" and "deny_always" from the console are an allow and a deny', async () => {
  const { find } = await loadMod();
  for (const [answer, decision] of [['allow_always', 'allow'], ['deny_always', 'deny']] as const) {
    const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: permissionFetch(answer) });
    await find('session.start')(f.$, {}, next);
    expect((await find('tool.check')(f.$, bashCheck, asking)).decision).toBe(decision);
  }
});
it('sends the whole input as the key of an "always" (the shown detail may be cut), and none when it is too long', async () => {
  const { find } = await loadMod();
  const posted: any[] = [];
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: (url, init) => {
    if (init.method === 'POST' && url.endsWith('/v1/tools/ask_user')) { posted.push(JSON.parse(init.body!)); return { ok: true, text: JSON.stringify({ id: 'p1' }) }; }
    return permissionFetch('allow')(url, init);
  } });
  await find('session.start')(f.$, {}, next);
  const input = { url: 'https://a.example', note: 'x'.repeat(3000) };
  await find('tool.check')(f.$, { tool: 'WebFetch', input, tool_use_id: 'tu2' }, asking);
  expect(posted[0].key).toBe(JSON.stringify(input));
  expect(posted[0].detail.length).toBe(2000);
  await find('tool.check')(f.$, { tool: 'WebFetch', input: { note: 'x'.repeat(30000) }, tool_use_id: 'tu3' }, asking);
  expect(posted[1].key).toBeUndefined();
});
it('only the exact answers "allow" and "allow_always" allow; a look-alike is a deny', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: permissionFetch('allowance') });
  await find('session.start')(f.$, {}, next);
  expect((await find('tool.check')(f.$, bashCheck, asking)).decision).toBe('deny');
});
it('leaves alone: an engine "allow" or "deny", the main session, queries without a call id, and the console\'s own tools', async () => {
  const { find } = await loadMod();
  const agent = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: permissionFetch('allow') });
  await find('session.start')(agent.$, {}, next);
  const before = agent.calls.length;
  expect((await find('tool.check')(agent.$, bashCheck, async () => ({ decision: 'allow' }))).decision).toBe('allow');
  expect((await find('tool.check')(agent.$, bashCheck, async () => ({ decision: 'deny', reason: 'rule' }))).decision).toBe('deny');
  expect((await find('tool.check')(agent.$, { tool: 'Bash', input: {} }, asking)).decision).toBe('ask');
  expect((await find('tool.check')(agent.$, { tool: 'AskUserQuestion', input: {}, tool_use_id: 'x' }, asking)).decision).toBe('ask');
  expect((await find('tool.check')(agent.$, { tool: 'mcp__console-mod__list_agents', input: {}, tool_use_id: 'x' }, asking)).decision).toBe('ask');
  expect(agent.calls.length).toBe(before);
  const { find: findMain } = await loadMod();
  const main = fake$({ env: { CONSOLE_ROLE: 'main' }, fetch: permissionFetch('allow') });
  await findMain('session.start')(main.$, {}, next);
  expect((await findMain('tool.check')(main.$, bashCheck, asking)).decision).toBe('ask'); // the user is typing in main: native dialog
});
it('if the console is unreachable the native dialog is left in place (the engine ask stands)', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: () => new Error('down') });
  await find('session.start')(f.$, {}, next);
  expect((await find('tool.check')(f.$, bashCheck, asking)).decision).toBe('ask');
});

it('step_done, checklist_set and report_blocked send only their own fields and return the console answer as text', async () => {
  const { find } = await loadMod();
  const bodies: Record<string, unknown> = {};
  const f = fake$({
    env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' },
    fetch: (url, init) => {
      if (url.includes('/v1/tools/')) { bodies[url.split('/').pop()!] = JSON.parse(init.body ?? '{}'); return { ok: true, text: JSON.stringify({ status: 'closed', n: 3 }) }; }
      return { ok: true, text: '{}' };
    },
  });
  await find('session.start')(f.$, {}, next);
  const done = await find('tool.call', 'mcp__console-mod__step_done')(f.$, { n: '3', note: 'x', skip: false, extra: 'ignored' });
  expect(done).toEqual({ result: JSON.stringify({ status: 'closed', n: 3 }) });
  expect(bodies.step_done).toEqual({ n: 3, note: 'x', skip: false });
  await find('tool.call', 'mcp__console-mod__checklist_set')(f.$, { items: ['a', 'b'], extra: 1 });
  expect(bodies.checklist_set).toEqual({ items: ['a', 'b'] });
  await find('tool.call', 'mcp__console-mod__report_blocked')(f.$, { reason: 'stuck', extra: 1 });
  expect(bodies.report_blocked).toEqual({ reason: 'stuck' });
});
it('step_done keeps asking while the console says "running" and returns the final answer', async () => {
  const { find } = await loadMod();
  let n = 0;
  const f = fake$({
    env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' },
    fetch: (url) => {
      if (!url.includes('/v1/tools/step_done')) return { ok: true, text: '{}' };
      n += 1;
      return { ok: true, text: JSON.stringify(n < 4 ? { status: 'running', n: 5 } : { status: 'closed', n: 5 }) };
    },
  });
  await find('session.start')(f.$, {}, next);
  const out = await find('tool.call', 'mcp__console-mod__step_done')(f.$, { n: 5 });
  expect(out).toEqual({ result: JSON.stringify({ status: 'closed', n: 5 }) });
  expect(n).toBe(4);
});
it('step_done survives a dropped connection while the validation runs and asks again', async () => {
  const { find } = await loadMod();
  let n = 0;
  const f = fake$({
    env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' },
    fetch: (url) => {
      if (!url.includes('/v1/tools/step_done')) return { ok: true, text: '{}' };
      n += 1;
      if (n === 2) return new Error('fetch timeout');
      return { ok: true, text: JSON.stringify(n < 3 ? { status: 'running', n: 5 } : { status: 'closed', n: 5 }) };
    },
  });
  await find('session.start')(f.$, {}, next);
  const out = await find('tool.call', 'mcp__console-mod__step_done')(f.$, { n: 5 });
  expect(out).toEqual({ result: JSON.stringify({ status: 'closed', n: 5 }) });
});
it('a ticket tool called while the console is unreachable says so instead of throwing', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: (url) => (url.includes('/v1/tools/') ? new Error('ECONNREFUSED') : { ok: true, text: '{}' }) });
  await find('session.start')(f.$, {}, next);
  const out = await find('tool.call', 'mcp__console-mod__checklist_set')(f.$, { items: ['a'] });
  expect(out).toEqual({ result: 'The console did not answer.' });
  const done = await find('tool.call', 'mcp__console-mod__step_done')(f.$, { n: 1 });
  expect(done.result).toContain('call step_done again with the same n');
});
it('merge_ticket keeps asking while the console says "running" and returns the final answer', async () => {
  const { find } = await loadMod();
  let n = 0;
  const f = fake$({
    fetch: (url) => {
      if (!url.includes('/v1/tools/merge_ticket')) return { ok: true, text: '{}' };
      n += 1;
      if (n === 2) return new Error('fetch timeout');
      return { ok: true, text: JSON.stringify(n < 4 ? { status: 'running' } : { status: 'merged', sha: 'abc' }) };
    },
  });
  await find('session.start')(f.$, {}, next);
  const out = await find('tool.call', 'mcp__console-mod__merge_ticket')(f.$, { name: 'fix-login' });
  expect(out).toEqual({ result: JSON.stringify({ status: 'merged', sha: 'abc' }) });
  expect(n).toBe(4);
});
it('merge_ticket with the console unreachable says the merge may still be running and to call it again', async () => {
  const { find } = await loadMod();
  const f = fake$({ fetch: (url) => (url.includes('/v1/tools/') ? new Error('ECONNREFUSED') : { ok: true, text: '{}' }) });
  await find('session.start')(f.$, {}, next);
  const out = await find('tool.call', 'mcp__console-mod__merge_ticket')(f.$, { name: 'fix-login' });
  expect(out.result).toBe('The console did not answer. The merge may still be running: call merge_ticket again.');
});

// ---- the guard hook (Phase 3, Task 5) ----
const GUARDED = ['Bash', 'PowerShell', 'Write', 'Edit', 'NotebookEdit', 'Read', 'Grep', 'Glob'];
const RISKY = ['Bash', 'PowerShell', 'Write', 'Edit', 'NotebookEdit'];
const guardFetch = (answer: { decision: string; reason?: string } | 'down' | 'broken') => (url: string) => {
  if (!url.endsWith('/v1/guard')) return { ok: true, text: '{}' };
  if (answer === 'down') return new Error('ECONNREFUSED');
  if (answer === 'broken') return { ok: false, status: 500, text: 'oops' };
  return { ok: true, text: JSON.stringify(answer) };
};

it('every guarded tool has a hook, and the console\'s own tools are not guarded', async () => {
  const { find } = await loadMod();
  for (const tool of GUARDED) expect(typeof find('tool.call', tool), tool).toBe('function');
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: guardFetch({ decision: 'deny', reason: 'no' }) });
  await find('session.start')(f.$, {}, next);
  f.calls.length = 0;
  await find('tool.call', 'mcp__console-mod__list_agents')(f.$, {});
  expect(f.calls.some((c) => c.endsWith('/v1/guard'))).toBe(false);
});
it('a deny from the console becomes { deny: reason }; an allow passes the call on', async () => {
  const { find } = await loadMod();
  const deny = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: guardFetch({ decision: 'deny', reason: 'force pushes are not allowed' }) });
  await find('session.start')(deny.$, {}, next);
  expect(await find('tool.call', 'Bash')(deny.$, { command: 'git push -f' }, next)).toEqual({ deny: 'force pushes are not allowed' });
  const allow = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: guardFetch({ decision: 'allow' }) });
  await find('session.start')(allow.$, {}, next);
  const e = { command: 'git status' };
  expect(await find('tool.call', 'Bash')(allow.$, e, next)).toEqual({ next: e });
});
it('sends the console only what it needs (command, paths), never file contents', async () => {
  const { find } = await loadMod();
  let sent: any;
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: (url, init) => { if (url.endsWith('/v1/guard')) sent = JSON.parse(init.body ?? '{}'); return { ok: true, text: JSON.stringify({ decision: 'allow' }) }; } });
  await find('session.start')(f.$, {}, next);
  await find('tool.call', 'Write')(f.$, { file_path: 'a.ts', content: 'SECRET BODY', extra: 1 }, next);
  expect(sent).toEqual({ tool: 'Write', input: { file_path: 'a.ts' } });
  await find('tool.call', 'Edit')(f.$, { file_path: 'a.ts', old_string: 'x', new_string: 'y' }, next);
  expect(sent).toEqual({ tool: 'Edit', input: { file_path: 'a.ts' } });
  await find('tool.call', 'NotebookEdit')(f.$, { notebook_path: 'n.ipynb', new_source: 'z' }, next);
  expect(sent).toEqual({ tool: 'NotebookEdit', input: { notebook_path: 'n.ipynb' } });
  await find('tool.call', 'Grep')(f.$, { pattern: 'p', path: 'src' }, next);
  expect(sent).toEqual({ tool: 'Grep', input: { path: 'src' } });
});
it.each(['down', 'broken'] as const)('console %s: shell and writing tools are refused, reading tools carry on', async (mode) => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: guardFetch(mode) });
  await find('session.start')(f.$, {}, next);
  for (const tool of RISKY) {
    const out = await find('tool.call', tool)(f.$, { command: 'x', file_path: 'a' }, next);
    expect(out, tool).toMatchObject({ deny: expect.stringMatching(/guard/i) });
  }
  for (const tool of ['Read', 'Grep', 'Glob']) {
    const e = { file_path: 'a' };
    expect(await find('tool.call', tool)(f.$, e, next), tool).toEqual({ next: e });
  }
});
it('WebFetch, WebSearch and Agent go through the guard and obey a deny', async () => {
  const { find } = await loadMod();
  const deny = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: guardFetch({ decision: 'deny', reason: 'budget used up' }) });
  await find('session.start')(deny.$, {}, next);
  const allow = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: guardFetch({ decision: 'allow' }) });
  await find('session.start')(allow.$, {}, next);
  for (const tool of ['WebFetch', 'WebSearch', 'Agent']) {
    expect(typeof find('tool.call', tool), tool).toBe('function');
    expect(await find('tool.call', tool)(deny.$, { url: 'https://x.test' }, next), tool).toEqual({ deny: 'budget used up' });
    expect(deny.calls.some((c) => c.endsWith('/v1/guard'))).toBe(true);
    const e = { url: 'https://x.test' };
    expect(await find('tool.call', tool)(allow.$, e, next), tool).toEqual({ next: e });
  }
});
it('with the console unreachable WebFetch carries on while Bash is still refused', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: guardFetch('down') });
  await find('session.start')(f.$, {}, next);
  const e = { url: 'https://x.test' };
  expect(await find('tool.call', 'WebFetch')(f.$, e, next)).toEqual({ next: e });
  expect(await find('tool.call', 'Bash')(f.$, { command: 'ls' }, next)).toMatchObject({ deny: expect.stringMatching(/guard/i) });
});
it('an answer that is neither allow nor deny counts as unreachable', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: () => ({ ok: true, text: '{"decision":"maybe"}' }) });
  await find('session.start')(f.$, {}, next);
  expect(await find('tool.call', 'Bash')(f.$, { command: 'ls' }, next)).toMatchObject({ deny: expect.any(String) });
});
it('a failure inside the guard hook never throws into the session', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' } });
  await find('session.start')(f.$, {}, next);
  (f.$ as any).http = undefined; // the engine API breaks
  await expect(find('tool.call', 'Bash')(f.$, { command: 'ls' }, next)).resolves.toMatchObject({ deny: expect.any(String) });
  await expect(find('tool.call', 'Read')(f.$, { file_path: 'a' }, next)).resolves.toEqual({ next: { file_path: 'a' } });
});
it('outside a console session the guard hook leaves every call alone', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_URL: undefined, CONSOLE_TOKEN: undefined } });
  await find('session.start')(f.$, {}, next);
  const e = { command: 'git push -f' };
  expect(await find('tool.call', 'Bash')(f.$, e, next)).toEqual({ next: e });
  expect(f.calls).toEqual([]);
});
it('the main is guarded too (its few rules live on the console)', async () => {
  const { find } = await loadMod();
  const f = fake$({ fetch: guardFetch({ decision: 'deny', reason: 'rm.wide' }) });
  await find('session.start')(f.$, {}, next);
  expect(await find('tool.call', 'Bash')(f.$, { command: 'rm -rf /' }, next)).toEqual({ deny: 'rm.wide' });
});

// ---- review and merge (Phase 4) ----
it('a reviewer gets only list_agents and review_verdict', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_ROLE: 'reviewer', CONSOLE_AGENT: 'review-fix-login' } });
  await find('session.start')(f.$, {}, next);
  expect(f.registeredTools).toEqual(['list_agents', 'review_verdict']);
});
it('the review tools send only their own fields', async () => {
  const { find } = await loadMod();
  const bodies: Record<string, unknown> = {};
  const f = fake$({ fetch: (url, init) => { if (url.includes('/v1/tools/')) { bodies[url.split('/').pop()!] = JSON.parse(init.body ?? '{}'); return { ok: true, text: '{"status":"ok"}' }; } return { ok: true, text: '{}' }; } });
  await find('session.start')(f.$, {}, next);
  await find('tool.call', 'mcp__console-mod__ticket_report')(f.$, { name: 'fix-login', rerun: true, extra: 1 });
  await find('tool.call', 'mcp__console-mod__request_review')(f.$, { name: 'fix-login', model: 'sonnet', extra: 1 });
  await find('tool.call', 'mcp__console-mod__merge_ticket')(f.$, { name: 'fix-login', extra: 1 });
  await find('tool.call', 'mcp__console-mod__propose_release')(f.$, {});
  expect(bodies).toEqual({ ticket_report: { name: 'fix-login', rerun: true }, request_review: { name: 'fix-login', model: 'sonnet' }, merge_ticket: { name: 'fix-login' }, propose_release: {} });
  const g = fake$({ env: { CONSOLE_ROLE: 'reviewer', CONSOLE_AGENT: 'review-x' }, fetch: (url, init) => { if (url.endsWith('/review_verdict')) bodies.verdict = JSON.parse(init.body ?? '{}'); return { ok: true, text: '{"status":"ok"}' }; } });
  await find('session.start')(g.$, {}, next);
  await find('tool.call', 'mcp__console-mod__review_verdict')(g.$, { pass: false, notes: [{ severity: 'high', text: 'bug' }], extra: 1 });
  expect(bodies.verdict).toEqual({ pass: false, notes: [{ severity: 'high', text: 'bug' }] });
});
it('a reviewer\'s permission prompts and native questions go to the console queue like an agent\'s', async () => {
  const { find } = await loadMod();
  const asked: string[] = [];
  const f = fake$({
    env: { CONSOLE_ROLE: 'reviewer', CONSOLE_AGENT: 'review-x' },
    fetch: (url, init) => {
      if (url.endsWith('/v1/tools/ask_user')) { asked.push(JSON.parse(init.body ?? '{}').kind ?? 'question'); return { ok: true, text: '{"id":"q1"}' }; }
      if (url.includes('/v1/questions/')) return { ok: true, text: '{"answered":true,"answer":"allow"}' };
      return { ok: true, text: '{}' };
    },
  });
  await find('session.start')(f.$, {}, next);
  const verdict = await find('tool.check')(f.$, { tool: 'Bash', tool_use_id: 't1', input: { command: 'npm test' } }, async () => ({ decision: 'ask', reason: 'needs approval' }));
  expect(verdict).toMatchObject({ decision: 'allow' });
  expect(asked).toEqual(['permission']);
});

// ---- usage limits (Phase 5) ----
it('session.measure posts a quota event with only the rate limits and passes the event on', async () => {
  const { find } = await loadMod();
  const posted: any[] = [];
  const f = fake$({ fetch: (url, init) => { if (url.endsWith('/v1/events') && init.body) posted.push(JSON.parse(init.body)); return { ok: true, text: '{}' }; } });
  const rateLimits = [{ kind: 'five_hour', percentUsed: 72, resetsAt: '2026-10-05T15:00:00Z' }];
  (f.$ as any).session.usage = async () => ({ startedAt: 1, context: { tokens: 5 }, rateLimits, cost: { usd: 1 } });
  await find('session.start')(f.$, {}, next);
  posted.length = 0;
  const e = { changed: ['rateLimits'] };
  expect(await find('session.measure')(f.$, e, next)).toEqual({ next: e });
  expect(posted).toEqual([{ type: 'quota', sessionId: 'sid-1', data: { rateLimits } }]);
});
it('session.measure posts nothing without rate limits, outside the console, or when usage fails', async () => {
  const { find } = await loadMod();
  const none = fake$();
  (none.$ as any).session.usage = async () => ({ startedAt: 1, rateLimits: [] });
  await find('session.start')(none.$, {}, next);
  none.calls.length = 0;
  await find('session.measure')(none.$, {}, next);
  expect(none.calls).toEqual([]);
  const missing = fake$();
  (missing.$ as any).session.usage = async () => ({ startedAt: 1 });
  await find('session.start')(missing.$, {}, next);
  missing.calls.length = 0;
  await find('session.measure')(missing.$, {}, next);
  expect(missing.calls).toEqual([]);
  const broken = fake$();
  (broken.$ as any).session.usage = async () => { throw new Error('no usage'); };
  await find('session.start')(broken.$, {}, next);
  broken.calls.length = 0;
  expect(await find('session.measure')(broken.$, { x: 1 }, next)).toEqual({ next: { x: 1 } });
  expect(broken.calls).toEqual([]);
  const { find: findOut } = await loadMod();
  const outside = fake$({ env: { CONSOLE_URL: undefined, CONSOLE_TOKEN: undefined } });
  (outside.$ as any).session.usage = async () => ({ rateLimits: [{ kind: 'five_hour', percentUsed: 1 }] });
  await findOut('session.start')(outside.$, {}, next);
  await findOut('session.measure')(outside.$, {}, next);
  expect(outside.calls).toEqual([]);
});

// ---- recovery (Phase 5) ----
it('a recovery session gets only list_agents and recovery_report', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_ROLE: 'recovery', CONSOLE_AGENT: 'recover-fix-login' } });
  await find('session.start')(f.$, {}, next);
  expect(f.registeredTools).toEqual(['list_agents', 'recovery_report']);
});
it('the recovery tools send only their own fields', async () => {
  const { find } = await loadMod();
  const bodies: Record<string, unknown> = {};
  const fetch = (url: string, init: { body?: string }) => { if (url.includes('/v1/tools/')) bodies[url.split('/').pop()!] = JSON.parse(init.body ?? '{}'); return { ok: true, text: '{"status":"ok"}' }; };
  const m = fake$({ fetch });
  await find('session.start')(m.$, {}, next);
  await find('tool.call', 'mcp__console-mod__start_recovery')(m.$, { name: 'fix-login', extra: 1 });
  const r = fake$({ env: { CONSOLE_ROLE: 'recovery', CONSOLE_AGENT: 'recover-fix-login' }, fetch });
  await find('session.start')(r.$, {}, next);
  const out = await find('tool.call', 'mcp__console-mod__recovery_report')(r.$, { verified_steps: [1, 2], diagnosis: 'loop on dist/', remedy: 'exclude_paths', notes: 'skip dist/', extra: 1 });
  expect(out).toEqual({ result: '{"status":"ok"}' });
  expect(bodies).toEqual({
    start_recovery: { name: 'fix-login' },
    recovery_report: { verified_steps: [1, 2], diagnosis: 'loop on dist/', remedy: 'exclude_paths', notes: 'skip dist/' },
  });
});
it('recovery_report declares its remedy as an enum of the five remedies', async () => {
  const { find } = await loadMod();
  const specs: { name: string; inputSchema: any }[] = [];
  const f = fake$({ env: { CONSOLE_ROLE: 'recovery', CONSOLE_AGENT: 'recover-x' } });
  (f.$ as any).tool.register = async (spec: { name: string; inputSchema: unknown }) => { specs.push(spec as never); };
  await find('session.start')(f.$, {}, next);
  const spec = specs.find((x) => x.name === 'recovery_report')!;
  expect(spec.inputSchema.properties.remedy.enum).toEqual(['split', 'exclude_paths', 'change_model', 'remove_obstacle', 'raise_budget']);
  expect(spec.inputSchema.properties.verified_steps).toMatchObject({ type: 'array', items: { type: 'integer' } });
  expect(spec.inputSchema.required).toEqual(expect.arrayContaining(['verified_steps', 'diagnosis', 'remedy']));
});

// ---- resume after a usage limit (Phase 5) ----
it('resume_agent is a main-only tool: no other role registers it', async () => {
  for (const role of ['agent', 'reviewer', 'recovery']) {
    const { find } = await loadMod();
    const f = fake$({ env: { CONSOLE_ROLE: role, CONSOLE_AGENT: 'fix-login' } });
    await find('session.start')(f.$, {}, next);
    expect(f.registeredTools, role).not.toContain('resume_agent');
  }
  const { find } = await loadMod();
  const specs: { name: string; inputSchema: any }[] = [];
  const m = fake$();
  (m.$ as any).tool.register = async (spec: { name: string; inputSchema: unknown }) => { specs.push(spec as never); };
  await find('session.start')(m.$, {}, next);
  const spec = specs.find((x) => x.name === 'resume_agent')!;
  expect(spec.inputSchema.properties.names).toMatchObject({ type: 'array', items: { type: 'string' } });
  expect(spec.inputSchema.required).toEqual(['names']);
});
it('resume_agent forwards only { names } and returns the console answer as text', async () => {
  const { find } = await loadMod();
  const bodies: Record<string, unknown> = {};
  const answer = { status: 'ok', started: ['fix-login'], scheduled: [] };
  const f = fake$({ fetch: (url, init) => {
    if (url.includes('/v1/tools/')) { bodies[url.split('/').pop()!] = JSON.parse(init.body ?? '{}'); return { ok: true, text: JSON.stringify(answer) }; }
    return { ok: true, text: '{}' };
  } });
  await find('session.start')(f.$, {}, next);
  const out = await find('tool.call', 'mcp__console-mod__resume_agent')(f.$, { names: ['fix-login', 'add-cart'], extra: 1 });
  expect(out).toEqual({ result: JSON.stringify(answer) });
  expect(bodies).toEqual({ resume_agent: { names: ['fix-login', 'add-cart'] } });
});
