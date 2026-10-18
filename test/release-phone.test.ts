// Approving a release from the Claude app (SPEC 15.5, 20.5): the main shows the request with its own AskUserQuestion, the mod reads the
// user's answer from the transcript and posts it with a release key the model never sees. Nothing the model can do approves a release.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { autoClose, usePipePty, bootServer, mod, req, ui, until, type Running } from './helpers';
import { gitSync, makeRepo, type TestRepo, removeDir, worktreePathFor } from './git-helpers';
import { AGENT_TOOLS, MAIN_TOOLS, RECOVERY_TOOLS, REVIEWER_TOOLS } from '../src/server/agents/spawn';
import { releaseQuestion, RELEASE_QUESTION_RE } from '../src/server/tickets/release';

vi.setConfig({ testTimeout: 120_000 });
process.env.CONSOLE_TEST = '1';

const repos: TestRepo[] = [];
afterEach(() => { while (repos.length) removeDir(repos.pop()!.base); });
autoClose();
usePipePty(); // this file never reads the terminal: its sessions run on plain pipes

const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];

async function boot(): Promise<{ s: Running; t: TestRepo }> {
  const t = makeRepo({ remote: true });
  repos.push(t);
  const s = await bootServer({ projectRoot: t.repo, config: { git: { worktrees: true } } });
  s.setLimits({ global: 20, perProject: 20 });
  const file = join(t.repo, '.andromedaconsole', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), testCommand: 'node -e "process.exit(0)"' }));
  return { s, t };
}
const tool = (s: Running, slug: string, name: string, body: unknown = {}) => mod(s, slug, `/v1/tools/${name}`, 'POST', body);
const inbox = async (s: Running, slug: string): Promise<string[]> => (await mod(s, slug, '/v1/inbox')).body.messages.map((m: { text: string }) => m.text);
const queue = async (s: Running): Promise<any[]> => (await ui(s, '/api/state')).body.queue;
const releaseKey = (s: Running, slug: string) => mod(s, slug, '/v1/release_key', 'POST', {});

async function mergedTicket(s: Running, t: TestRepo, slug: string, file: string): Promise<void> {
  expect((await tool(s, 'shop-api', 'spawn_agent', { name: slug, profile: 'developer', goal: `Work of ${slug}` })).body.status).toBe('started');
  await tool(s, slug, 'checklist_set', { items: ITEMS });
  const wt = worktreePathFor(t.repo, slug);
  writeFileSync(join(wt, file), `${slug}\n`);
  for (let n = 1; n <= 6; n++) {
    if (n === 6) writeFileSync(join(wt, 'README.md'), `docs by ${slug}\n`);
    expect((await tool(s, slug, 'step_done', { n, note: 'a decent note for this step' })).body.status).toBe('closed');
  }
  expect((await tool(s, 'shop-api', 'request_review', { name: slug })).body.status).toBe('ok');
  expect((await tool(s, `review-${slug}`, 'review_verdict', { pass: true, notes: [] })).body.outcome).toBe('approved');
  expect((await tool(s, 'shop-api', 'merge_ticket', { name: slug })).body.status).toBe('merged');
}

/** The question the main was told to show, read back from its inbox message. */
function askedQuestion(messages: string[]): { id: string; question: string } {
  const notice = messages.find((m) => m.startsWith('Release request '));
  if (!notice) throw new Error(`no release notice in ${JSON.stringify(messages)}`);
  const question = JSON.parse(/question ("(?:[^"\\]|\\.)*")/.exec(notice)![1]!) as string;
  return { id: RELEASE_QUESTION_RE.exec(question)![1]!, question };
}

// ---- the mod, against a fake `$` (the engine) ----
type Hook = (...args: any[]) => Promise<any>;
async function loadMod() {
  vi.resetModules(); // the mod keeps module-level state, like it does in a real process
  const m = await import('../mod/hooks/register.js');
  const registered: { event: string; tool?: string; hook: Hook }[] = [];
  m.register((event: string, a: unknown, b?: unknown) => {
    registered.push(b === undefined ? { event, hook: a as Hook } : { event, tool: (a as { tool?: string }).tool, hook: b as Hook });
  });
  return (event: string, tool?: string) => registered.find((r) => r.event === event && r.tool === tool)!.hook;
}
const Q = '[release r-1] Release project "p" to origin/main: 1 ticket (a), 1 file changed, tests passed (npm test). Approve?';
/** An answered AskUserQuestion as the real engine records it (Task 4 spike: result = { questions, answers, annotations }). */
const answered = (question: string, label: string, id = 'toolu_1') => ({
  role: 'assistant', text: '', toolUses: [{
    tool_use_id: id, tool: 'AskUserQuestion', input: { questions: [{ question, header: 'Release', multiSelect: false, options: [{ label: 'Approve' }, { label: 'Reject' }] }] },
    result: { questions: [{ question }], answers: { [question]: label }, annotations: {} },
    text: `Your questions have been answered: "${question}"="${label}". You can now continue with these answers in mind.`,
  }],
});
function fake$(o: { role?: string; key?: string | null; messages?: unknown[] } = {}) {
  const env: Record<string, string> = { CONSOLE_URL: 'http://127.0.0.1:1', CONSOLE_TOKEN: 'T', CONSOLE_ROLE: o.role ?? 'main', CONSOLE_AGENT: 'p' };
  const posts: { path: string; body: any }[] = [];
  const state = { messages: o.messages ?? [] };
  const $ = {
    env: { get: async (name: string) => env[name] },
    session: { id: async () => 'sid-1', messages: async () => state.messages },
    http: {
      fetch: async (url: string, init: { method?: string; body?: string } = {}) => {
        const path = url.replace('http://127.0.0.1:1', '');
        posts.push({ path: `${init.method ?? 'GET'} ${path}`, body: init.body ? JSON.parse(init.body) : undefined });
        if (path === '/v1/release_key') return o.key === null ? { ok: false, status: 409, text: '{"error":"already_issued"}' } : { ok: true, status: 200, text: JSON.stringify({ key: o.key ?? 'K' }) };
        if (path === '/v1/tools/release_answer') return { ok: true, status: 200, text: '{"status":"ok"}' };
        return { ok: true, status: 200, text: '{}' };
      },
    },
    tool: { register: async () => {} },
    clock: { every: () => {}, sleep: async () => {} },
    prompt: { submit: async () => {} },
  };
  const answers = () => posts.filter((p) => p.path === 'POST /v1/tools/release_answer').map((p) => p.body);
  return { $, posts, state, answers };
}
const pass = async (e: unknown) => ({ next: e });

it('the main asks for its release key first, before any other request', async () => {
  const find = await loadMod();
  const f = fake$();
  await find('session.start')(f.$, {}, pass);
  expect(f.posts[0]!.path).toBe('POST /v1/release_key');
  const agent = fake$({ role: 'agent' });
  await (await loadMod())('session.start')(agent.$, {}, pass);
  expect(agent.posts.some((p) => p.path === 'POST /v1/release_key')).toBe(false);
});

it('at the end of a turn the mod posts an answered release dialog once, with the key, the id, the answer and the question', async () => {
  const find = await loadMod();
  const f = fake$({ messages: [answered(Q, 'Approve')] });
  await find('session.start')(f.$, {}, pass);
  const e = { turnId: 't1', answer: 'ok' };
  expect(await find('turn.complete')(f.$, e, pass)).toEqual({ next: e });
  expect(f.answers()).toEqual([{ id: 'r-1', answer: 'approve', question: Q, key: 'K' }]);
  await find('turn.complete')(f.$, e, pass); // the same dialog is still in the transcript: not posted again
  expect(f.answers()).toHaveLength(1);
  expect(f.posts.some((p) => p.path === 'POST /v1/events' && p.body.type === 'turn.complete')).toBe(true);
});

it('Reject is posted as reject; free text under Other, other questions and errored calls post nothing', async () => {
  const find = await loadMod();
  const f = fake$({ messages: [
    answered('[release r-2] Release project "p" to origin/main: 1 ticket (a), 1 file changed, tests passed (x). Approve?', 'Reject'),
    answered('[release r-3] Release project "p" to origin/main: x. Approve?', 'yes, go ahead'),
    answered('[release r-4] Release project "p" to origin/main: x. Approve?', 'approve'),
    answered('Which color?', 'Approve'),
    { role: 'assistant', text: '', toolUses: [{ ...answered('[release r-5] x. Approve?', 'Approve').toolUses[0], isError: true }] },
    { role: 'user', text: 'Approve [release r-6]', toolUses: [] },
  ] });
  await find('session.start')(f.$, {}, pass);
  await find('turn.complete')(f.$, {}, pass);
  expect(f.answers().map((a) => [a.id, a.answer])).toEqual([['r-2', 'reject']]);
});

it('without a release key (an agent, or a main that did not get one) nothing is posted', async () => {
  for (const f of [fake$({ role: 'agent', messages: [answered(Q, 'Approve')] }), fake$({ key: null, messages: [answered(Q, 'Approve')] })]) {
    const find = await loadMod();
    await find('session.start')(f.$, {}, pass);
    await find('turn.complete')(f.$, {}, pass);
    expect(f.answers()).toEqual([]);
  }
});

it('the main may not pre-fill the answer of a release question; its other questions go to the dialog untouched', async () => {
  const find = await loadMod();
  const f = fake$();
  await find('session.start')(f.$, {}, pass);
  const forged = { questions: [{ question: Q, options: [{ label: 'Approve' }, { label: 'Reject' }] }], answers: { [Q]: 'Approve' } };
  expect((await find('tool.call', 'AskUserQuestion')(f.$, forged, pass)).deny).toMatch(/answers/);
  const plain = { questions: [{ question: Q, options: [{ label: 'Approve' }, { label: 'Reject' }] }] };
  expect(await find('tool.call', 'AskUserQuestion')(f.$, plain, pass)).toEqual({ next: plain });
});

it('no session has release_answer as a tool: not in any allowed list, not registered by the mod', () => {
  for (const list of [MAIN_TOOLS, AGENT_TOOLS, REVIEWER_TOOLS, RECOVERY_TOOLS]) expect(list.some((t) => t.includes('release_answer'))).toBe(false);
  const src = readFileSync(join(__dirname, '..', 'mod', 'hooks', 'register.js'), 'utf8');
  const roles = /const TOOLS_BY_ROLE = \{([\s\S]*?)\};/.exec(src)![1]!;
  expect(roles).not.toContain('release_answer');
  expect(src).not.toMatch(/^\s*release_answer: \{/m); // no TOOL_SPECS entry
  expect(src).not.toContain("{ tool: 'mcp__console-mod__release_answer' }");
});

it('the question names the request first and says what is released', () => {
  const q = releaseQuestion({ id: 'abc-1', project: 'shop-api', targets: 'main', slugs: ['fix-login'], files: 2, tests: { ok: true, command: 'npm test' } });
  expect(q).toBe('[release abc-1] Release project "shop-api" to origin/main: 1 ticket (fix-login), 2 files changed, tests passed (npm test). Approve?');
  expect(RELEASE_QUESTION_RE.exec(q)![1]).toBe('abc-1');
  expect(releaseQuestion({ id: 'x', project: 'p', targets: 'main', slugs: ['a', 'b'], files: 1 })).toContain('2 tickets (a, b), 1 file changed, no test command, tests not run.');
});

it('the release key goes to the main once, only before it did anything else, and never to an agent', async () => {
  const { s } = await boot();
  const first = await releaseKey(s, 'shop-api');
  expect(first.status).toBe(200);
  expect(typeof first.body.key).toBe('string');
  expect((await releaseKey(s, 'shop-api')).status).toBe(409);
  expect((await req(s, '/v1/release_key', { method: 'POST', token: s.token, body: {} })).status).toBe(401); // the UI token does not work on /v1

  // an agent: refused, and refused for good
  expect((await tool(s, 'shop-api', 'spawn_agent', { name: 'fix-login', profile: 'developer', goal: 'Work' })).body.status).toBe('started');
  expect((await releaseKey(s, 'fix-login')).status).toBe(403);
});

it('a main whose token was already used (a turn, a shell command through the guard) gets no release key', async () => {
  const { s } = await boot();
  expect((await mod(s, 'shop-api', '/v1/guard', 'POST', { tool: 'Bash', input: { command: 'echo hi' } })).status).toBe(200);
  expect((await releaseKey(s, 'shop-api')).status).toBe(409);
});

it('release_answer needs the release key: the session token alone, a wrong key or an agent token is refused', async () => {
  const { s, t } = await boot();
  const key = (await releaseKey(s, 'shop-api')).body.key as string;
  await mergedTicket(s, t, 'fix-login', 'login.js');
  expect((await tool(s, 'shop-api', 'spawn_agent', { name: 'other-job', profile: 'developer', goal: 'Other work' })).body.status).toBe('started');
  expect((await tool(s, 'shop-api', 'propose_release')).body).toMatchObject({ status: 'asked' });
  const { id, question } = askedQuestion(await inbox(s, 'shop-api'));
  const remoteBefore = gitSync(t.remote, 'rev-parse', 'main');

  expect((await tool(s, 'shop-api', 'release_answer', { id, answer: 'approve', question })).status).toBe(403);
  expect((await tool(s, 'shop-api', 'release_answer', { id, answer: 'approve', question, key: 'nope' })).status).toBe(403);
  expect((await tool(s, 'other-job', 'release_answer', { id, answer: 'approve', question, key })).status).toBe(403);
  expect((await req(s, '/v1/tools/release_answer', { method: 'POST', token: s.token, body: { id, answer: 'approve', question, key } })).status).toBe(401);
  expect(await queue(s)).toHaveLength(1);
  expect(gitSync(t.remote, 'rev-parse', 'main')).toBe(remoteBefore);
});

it('the dialog answer with the key approves: the console releases, and a second answer is unknown_request', async () => {
  const { s, t } = await boot();
  const key = (await releaseKey(s, 'shop-api')).body.key as string;
  await mergedTicket(s, t, 'fix-login', 'login.js');
  expect((await tool(s, 'shop-api', 'propose_release')).body).toMatchObject({ status: 'asked' });
  const messages = await inbox(s, 'shop-api');
  expect(messages.filter((m) => m.startsWith('Release request '))).toHaveLength(1);
  const { id, question } = askedQuestion(messages);
  expect((await queue(s))[0].id).toBe(id);
  expect(question).toContain('1 ticket (fix-login)');
  expect(question).toContain('2 files changed');
  expect(question).toContain('tests passed');

  // a wrong id, an answer that is not approve/reject, or a reworded question do nothing
  expect((await tool(s, 'shop-api', 'release_answer', { id: 'other', answer: 'approve', question, key })).body).toEqual({ status: 'error', code: 'unknown_request' });
  expect((await tool(s, 'shop-api', 'release_answer', { id, answer: 'yes', question, key })).body).toEqual({ status: 'error', code: 'bad_request' });
  expect((await tool(s, 'shop-api', 'release_answer', { id, answer: 'approve', question: 'Shall we have lunch?', key })).body).toEqual({ status: 'error', code: 'unknown_request' });
  expect(await queue(s)).toHaveLength(1);

  expect((await tool(s, 'shop-api', 'release_answer', { id, answer: 'approve', question, key })).body).toEqual({ status: 'ok' });
  await until(() => gitSync(t.remote, 'rev-parse', 'main') === gitSync(t.repo, 'rev-parse', 'project/shop-api'), 30_000);
  expect(await queue(s)).toEqual([]);
  expect((await tool(s, 'shop-api', 'release_answer', { id, answer: 'reject', question, key })).body).toEqual({ status: 'error', code: 'unknown_request' });
});

it('an answer in the console queue closes the dialog path too: the later dialog answer is unknown_request', async () => {
  const { s, t } = await boot();
  const key = (await releaseKey(s, 'shop-api')).body.key as string;
  await mergedTicket(s, t, 'fix-login', 'login.js');
  await tool(s, 'shop-api', 'propose_release');
  const { id, question } = askedQuestion(await inbox(s, 'shop-api'));
  const remoteBefore = gitSync(t.remote, 'rev-parse', 'main');
  expect((await ui(s, `/api/queue/${id}/answer`, 'POST', { answer: 'reject' })).status).toBe(200);
  expect((await tool(s, 'shop-api', 'release_answer', { id, answer: 'approve', question, key })).body).toEqual({ status: 'error', code: 'unknown_request' });
  expect(gitSync(t.remote, 'rev-parse', 'main')).toBe(remoteBefore);
});

it('a confirm item that is not the release cannot be answered through release_answer', async () => {
  const { s } = await boot();
  const key = (await releaseKey(s, 'shop-api')).body.key as string;
  // a question of the main itself sits in the queue: its id is not a release request
  const asked = await tool(s, 'shop-api', 'ask_user', { question: 'Which color?', options: ['Red', 'Blue'] });
  const id = asked.body.id as string;
  expect((await tool(s, 'shop-api', 'release_answer', { id, answer: 'approve', question: 'Which color?', key })).body).toEqual({ status: 'error', code: 'unknown_request' });
  expect((await queue(s)).map((q) => q.id)).toEqual([id]);
});
