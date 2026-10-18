// The subscription quota wired into the real server: fake agents, a fake sleep clock, `quota` events sent as the main's session token.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { autoClose, bootServer, configFileOf, fakeSleepClock, mod, modEvent, req, state, ui, until, type Running } from './helpers';

vi.setConfig({ testTimeout: 30_000 });
autoClose();

const RESET = '2026-10-05T12:00:00.000Z'; // two hours after the fake clock's start (10:00Z)
const MIN = 60_000;

const quota = (s: Running, percentUsed: number, resetsAt?: string, kind = 'five_hour') =>
  modEvent(s, 'shop-api', 'quota', { rateLimits: [{ kind, percentUsed, ...(resetsAt ? { resetsAt } : {}) }] });
const spawn = (s: Running, name: string) => mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name, profile: 'developer', goal: 'make it work' });
const agentOf = async (s: Running, slug: string): Promise<any> => (await state(s)).agents.find((a: any) => a.slug === slug);
const ticketFile = (root: string, slug: string): string => join(root, '.andromedaconsole', 'state', 'tickets', `${slug}.json`);

async function boot() {
  const fake = fakeSleepClock();
  const projectRoot = mkdtempSync(join(tmpdir(), 'q-project-'));
  const s = await bootServer({ projectRoot, sleepClock: fake.clock });
  return { s, fake, projectRoot };
}

it('72% halves the limit seen by GET /api/state; the quota percent is there, n/a (absent) before', async () => {
  const { s } = await boot();
  const before = await state(s);
  expect(before.limits).toEqual({ active: 0, max: 3 }); // the stricter of the global (4) and the per-project (3) limit
  expect(before.quota).toBeUndefined(); // unknown: n/a, never zero
  expect(before.sleep).toBeUndefined();
  expect((await quota(s, 72)).status).toBeLessThan(300);
  await until(async () => (await state(s)).limits.max === 2);
  const after = await state(s);
  expect(after.quota).toEqual({ percent: 72, kind: 'five_hour' });
  expect(after.sleep).toBeUndefined();
});

it('88% keeps a spawned agent queued, and it starts by itself when the quota falls back', async () => {
  const { s } = await boot();
  await quota(s, 88);
  await until(async () => (await state(s)).limits.max === 0);
  const out = await spawn(s, 'job-one');
  expect(out.body).toMatchObject({ status: 'queued', name: 'job-one', position: 1 });
  expect((await agentOf(s, 'job-one')).state).toBe('queued');
  expect((await agentOf(s, 'job-one')).status).toBe('pending');
  await quota(s, 10);
  await until(async () => (await agentOf(s, 'job-one'))?.status === 'running');
  expect((await state(s)).limits.max).toBe(3);
});

it('96% moves an active agent\'s ticket to suspended_limit and leaves the main running', async () => {
  const { s, projectRoot } = await boot();
  expect((await spawn(s, 'job-one')).body).toEqual({ status: 'started', name: 'job-one' });
  await until(() => existsSync(ticketFile(projectRoot, 'job-one')));
  await until(async () => (await agentOf(s, 'job-one'))?.status === 'running');
  await quota(s, 96);
  await until(() => JSON.parse(readFileSync(ticketFile(projectRoot, 'job-one'), 'utf8')).status === 'suspended_limit');
  await until(async () => (await agentOf(s, 'job-one'))?.state === 'suspended');
  const st = await state(s);
  expect((await agentOf(s, 'job-one')).status).toBe('exited');
  expect(st.main.status).toBe('running');
  expect(st.quota).toEqual({ percent: 96, kind: 'five_hour' });
  // the main sees the suspended ticket in list_agents (that is where it decides what to resume)
  const listed = (await mod(s, 'shop-api', '/v1/tools/list_agents', 'POST', {})).body.agents;
  expect(listed.find((a: any) => a.slug === 'job-one').ticket).toBe('suspended_limit');
});

it('100% with a resetsAt sets sleep.phase "sleeping" and one timer until the reset (+5 s); the probe backs off', async () => {
  const { s, fake, projectRoot } = await boot();
  await quota(s, 100, RESET);
  await until(async () => (await state(s)).sleep?.phase === 'sleeping');
  const sleeping = (await state(s)).sleep;
  expect(sleeping).toEqual({ until: '2026-10-05T12:00:05.000Z', phase: 'sleeping', attempt: 0, weekly: false });
  expect(fake.timers.size).toBe(1);
  expect([...fake.timers.values()][0]!.ms).toBe(2 * 60 * MIN + 5000);
  // the same reading again changes nothing (one sleep per reset)
  await quota(s, 100, RESET);
  await new Promise((r) => setTimeout(r, 100));
  expect(fake.timers.size).toBe(1);
  // at the reset the main is woken and the probe waits at most one minute for the next reading; none comes, so it is "limited"
  // and the next probe is 10 minutes away
  fake.advance(2 * 60 * MIN + 5000);
  await until(async () => (await state(s)).sleep?.phase === 'probing');
  expect([...fake.timers.values()].map((t) => t.ms)).toEqual([MIN]);
  fake.advance(MIN);
  await until(async () => (await state(s)).sleep?.attempt === 1);
  expect((await state(s)).sleep.phase).toBe('sleeping');
  expect([...fake.timers.values()].map((t) => t.ms)).toEqual([10 * MIN]);
  // the sleep is saved (console-wide, in the config folder) so a restart can resume it
  const saved = JSON.parse(readFileSync(join(dirname(configFileOf(s)), 'state', 'sleep.json'), 'utf8'));
  expect(saved).toMatchObject({ phase: 'sleeping', attempt: 1 });
});

it('a weekly limit shows the sleep as weekly, sets no timer and tells the main', async () => {
  const { s, fake } = await boot();
  await quota(s, 100, RESET, 'seven_day');
  await until(async () => (await state(s)).sleep?.weekly === true);
  expect(fake.timers.size).toBe(0);
  await until(async () => (await mod(s, 'shop-api', '/v1/inbox')).body.messages.some((m: { text: string }) => m.text.includes('weekly usage limit')));
});

it('POST /api/sleep/resume without the UI token is 401; with it, 204 and one immediate probe', async () => {
  const { s, fake } = await boot();
  expect((await req(s, '/api/sleep/resume', { method: 'POST' })).status).toBe(401);
  expect((await req(s, '/api/sleep/resume', { method: 'POST', token: 'wrong' })).status).toBe(401);
  expect((await req(s, '/api/sleep/resume', { method: 'POST', token: s.sessionTokenFor('shop-api') })).status).toBe(401); // a session token is not the UI token
  await quota(s, 100, RESET);
  await until(async () => (await state(s)).sleep?.phase === 'sleeping');
  expect((await ui(s, '/api/sleep/resume', 'POST')).status).toBe(204);
  expect([...fake.timers.values()].map((t) => t.ms)).toEqual([MIN]); // the probe waits for a reading, at most one minute
  fake.advance(MIN);
  await until(async () => (await state(s)).sleep?.attempt === 1);
  expect([...fake.timers.values()].map((t) => t.ms)).toEqual([10 * MIN]); // the long timer was cancelled
});

const wakeMessages = async (s: Running): Promise<{ text: string }[]> =>
  (await mod(s, 'shop-api', '/v1/inbox')).body.messages.filter((m: { text: string }) => m.text.includes('The subscription limit was reset'));

it('at the reset the main gets exactly one wake-up message; a 10% reading afterwards ends the sleep', async () => {
  const { s, fake } = await boot();
  await quota(s, 100, RESET);
  await until(async () => (await state(s)).sleep?.phase === 'sleeping');
  expect(await wakeMessages(s)).toHaveLength(0); // nothing is attempted before the reset
  fake.advance(2 * 60 * MIN + 5000);
  await until(async () => (await state(s)).sleep?.phase === 'probing');
  const wakes = await wakeMessages(s);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]!.text).toContain('mcp__console-mod__resume_agent');
  expect(wakes[0]!.text).toContain('list_agents');
  expect((await state(s)).main.status).toBe('running'); // the main was alive: it is only told, never restarted
  expect(s.lastLaunchArgs('shop-api')).not.toContain('--resume');
  await quota(s, 10, RESET);
  await until(async () => (await state(s)).sleep === undefined);
  expect(await wakeMessages(s)).toHaveLength(1); // one probe, one message
  expect(fake.timers.size).toBe(0); // the one-minute wait was cancelled and nothing else is scheduled
});

it('a probe whose next reading is still high counts as limited and backs off to 10 minutes', async () => {
  const { s, fake } = await boot();
  await quota(s, 100, RESET);
  await until(async () => (await state(s)).sleep?.phase === 'sleeping');
  fake.advance(2 * 60 * MIN + 5000);
  await until(async () => (await state(s)).sleep?.phase === 'probing');
  await quota(s, 90, RESET); // still above the first threshold (70%)
  await until(async () => (await state(s)).sleep?.attempt === 1);
  const st = await state(s);
  expect(st.sleep.phase).toBe('sleeping');
  expect([...fake.timers.values()].map((t) => t.ms)).toEqual([10 * MIN]);
  expect(await wakeMessages(s)).toHaveLength(1);
});

it('a main whose process had ended is started again with --resume of its last session, then told once', async () => {
  const { s, fake } = await boot();
  await modEvent(s, 'shop-api', 'session.start'); // the main's session id: sess-shop-api
  await quota(s, 100, RESET);
  await until(async () => (await state(s)).sleep?.phase === 'sleeping');
  s.writeToSession('shop-api', 'quit\r');
  await until(async () => (await state(s)).main.status === 'exited');
  fake.advance(2 * 60 * MIN + 5000);
  await until(async () => (await state(s)).main.status === 'running');
  const args = s.lastLaunchArgs('shop-api')!;
  expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', 'sess-shop-api']);
  expect(await wakeMessages(s)).toHaveLength(1); // the new session token reads the main's inbox
  await quota(s, 10, RESET);
  await until(async () => (await state(s)).sleep === undefined);
});

it('resume_agent over /v1: bad_request without names; quota_high while the quota is high; with worktrees off the agent resumes in the project folder', async () => {
  const { s, projectRoot } = await boot();
  expect((await spawn(s, 'job-one')).body).toEqual({ status: 'started', name: 'job-one' });
  await until(() => existsSync(ticketFile(projectRoot, 'job-one')));
  await until(async () => (await agentOf(s, 'job-one'))?.status === 'running');
  await modEvent(s, 'job-one', 'session.start'); // its session id is recorded
  await quota(s, 96);
  await until(() => JSON.parse(readFileSync(ticketFile(projectRoot, 'job-one'), 'utf8')).status === 'suspended_limit');
  const resume = (body: unknown) => mod(s, 'shop-api', '/v1/tools/resume_agent', 'POST', body);
  expect((await resume({})).body).toEqual({ status: 'error', code: 'bad_request', detail: expect.any(String) });
  expect((await resume({ names: [] })).body).toEqual({ status: 'error', code: 'bad_request', detail: expect.any(String) });
  expect((await resume({ names: ['job-one'] })).body).toMatchObject({ status: 'refused', code: 'quota_high' });
  await quota(s, 10);
  await until(async () => (await state(s)).limits.max === 3);
  expect((await resume({ names: ['no-such-job'] })).body).toEqual({ status: 'refused', code: 'not_suspended', detail: 'no-such-job' });
  expect(JSON.parse(readFileSync(ticketFile(projectRoot, 'job-one'), 'utf8')).status).toBe('suspended_limit');
  // the agents of this server share the project folder (git.worktrees off): that is where the session is resumed
  await until(async () => (await agentOf(s, 'job-one'))?.status === 'exited'); // the stop has finished
  expect((await resume({ names: ['job-one'] })).body).toEqual({ status: 'ok', started: ['job-one'], scheduled: [] });
  await until(() => (s.lastLaunchArgs('job-one') ?? []).includes('--resume'));
  const args = s.lastLaunchArgs('job-one')!;
  expect(args[args.indexOf('--resume') + 1]).toBe('sess-job-one');
  await until(async () => (await agentOf(s, 'job-one'))?.status === 'running');
  expect(JSON.parse(readFileSync(ticketFile(projectRoot, 'job-one'), 'utf8')).status).toBe('in_progress');
});

// ---- fix wave ----

it('limits.max is the stricter of the global and the per-project limit', async () => {
  const { s } = await boot();
  s.setLimits({ global: 5, perProject: 2 });
  expect((await state(s)).limits.max).toBe(2);
  s.setLimits({ global: 1, perProject: 6 });
  expect((await state(s)).limits.max).toBe(1);
});

it('96% with a known reset starts the sleep at the stop: one timer, one wake-up at the reset, a 10% reading ends it', async () => {
  const { s, fake } = await boot();
  await quota(s, 96, RESET);
  await until(async () => (await state(s)).sleep?.phase === 'sleeping');
  expect(fake.timers.size).toBe(1);
  expect([...fake.timers.values()][0]!.ms).toBe(2 * 60 * MIN + 5000);
  await quota(s, 100, RESET); // the same window and reset at 100%: no second sleep
  await new Promise((r) => setTimeout(r, 100));
  expect(fake.timers.size).toBe(1);
  fake.advance(2 * 60 * MIN + 5000);
  await until(async () => (await state(s)).sleep?.phase === 'probing');
  expect(await wakeMessages(s)).toHaveLength(1);
  expect(s.lastLaunchArgs('shop-api')).not.toContain('--resume'); // the main was running: only told
  await quota(s, 10, RESET);
  await until(async () => (await state(s)).sleep === undefined);
  expect(await wakeMessages(s)).toHaveLength(1);
});

it('96% without a reset time starts no sleep (a probe with no time would burn the last percent)', async () => {
  const { s, fake } = await boot();
  await quota(s, 96);
  await until(async () => (await state(s)).limits.max === 0);
  await new Promise((r) => setTimeout(r, 100));
  expect((await state(s)).sleep).toBeUndefined();
  expect(fake.timers.size).toBe(0);
});

it('after a stop, the five-hour window reset with the weekly one at 76%: halve (max 2), and the probe answers running', async () => {
  const { s, fake } = await boot();
  await quota(s, 96, RESET);
  await until(async () => (await state(s)).sleep?.phase === 'sleeping');
  expect((await state(s)).limits.max).toBe(0);
  fake.advance(2 * 60 * MIN + 5000);
  await until(async () => (await state(s)).sleep?.phase === 'probing');
  await modEvent(s, 'shop-api', 'quota', { rateLimits: [{ kind: 'five_hour', percentUsed: 2, resetsAt: RESET }, { kind: 'seven_day', percentUsed: 76 }] });
  await until(async () => (await state(s)).sleep === undefined); // running: awake
  expect((await state(s)).limits.max).toBe(2);
  expect(fake.timers.size).toBe(0);
  await until(async () => (await mod(s, 'shop-api', '/v1/inbox')).body.messages.some((m: { text: string }) => m.text.includes('half as many') && m.text.includes('resume_agent')));
});

it('a probe that timed out is ended by a later low reading: no sleep, no timer, still one wake-up message', async () => {
  const { s, fake } = await boot();
  await quota(s, 100, RESET);
  await until(async () => (await state(s)).sleep?.phase === 'sleeping');
  fake.advance(2 * 60 * MIN + 5000);
  await until(async () => (await state(s)).sleep?.phase === 'probing');
  fake.advance(MIN); // no reading within the minute: limited, the next probe in 10 minutes
  await until(async () => (await state(s)).sleep?.attempt === 1);
  expect([...fake.timers.values()].map((t) => t.ms)).toEqual([10 * MIN]);
  await quota(s, 10, RESET);
  await until(async () => (await state(s)).sleep === undefined);
  expect(fake.timers.size).toBe(0);
  expect(await wakeMessages(s)).toHaveLength(1);
});

it('a weekly limit puts one acknowledgement in the queue of the user, with its reset time', async () => {
  const { s } = await boot();
  await quota(s, 100, RESET, 'seven_day');
  await until(async () => (await state(s)).queue.length === 1);
  await quota(s, 100, RESET, 'seven_day');
  await new Promise((r) => setTimeout(r, 150));
  const items = (await state(s)).queue;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ from: '@console', kind: 'decision', options: ['ok'], payload: { kind: 'weekly_limit', resetsAt: RESET } });
  expect((await ui(s, `/api/queue/${items[0].id}/answer`, 'POST', { answer: 'ok' })).status).toBe(200);
  expect((await state(s)).queue).toHaveLength(0);
});

it('a main relaunched at a wake-up keeps its session id: a relaunch that dies before reporting in is resumed again next time', async () => {
  const { s, fake } = await boot();
  await modEvent(s, 'shop-api', 'session.start'); // sess-shop-api
  await quota(s, 100, RESET);
  await until(async () => (await state(s)).sleep?.phase === 'sleeping');
  s.writeToSession('shop-api', 'quit\r');
  await until(async () => (await state(s)).main.status === 'exited');
  fake.advance(2 * 60 * MIN + 5000);
  await until(async () => (await state(s)).main.status === 'running');
  const first = s.lastLaunchArgs('shop-api')!;
  expect(first[first.indexOf('--resume') + 1]).toBe('sess-shop-api');
  // the relaunched main dies before it reports in; the probe times out and backs off
  s.writeToSession('shop-api', 'quit\r');
  await until(async () => (await state(s)).main.status === 'exited');
  fake.advance(MIN);
  await until(async () => (await state(s)).sleep?.attempt === 1);
  fake.advance(10 * MIN);
  await until(async () => (await state(s)).main.status === 'running' && s.lastLaunchArgs('shop-api') !== first);
  const second = s.lastLaunchArgs('shop-api')!;
  expect(second[second.indexOf('--resume') + 1]).toBe('sess-shop-api');
});

it('a resumed agent whose process ends before its session starts is suspended again and the main is told', async () => {
  const { s, projectRoot } = await boot();
  expect((await spawn(s, 'job-one')).body).toEqual({ status: 'started', name: 'job-one' });
  await until(() => existsSync(ticketFile(projectRoot, 'job-one')));
  await until(async () => (await agentOf(s, 'job-one'))?.status === 'running');
  await modEvent(s, 'job-one', 'session.start');
  await quota(s, 96);
  await until(() => JSON.parse(readFileSync(ticketFile(projectRoot, 'job-one'), 'utf8')).status === 'suspended_limit');
  await until(async () => (await agentOf(s, 'job-one'))?.status === 'exited');
  await quota(s, 10);
  await until(async () => (await state(s)).limits.max === 3);
  expect((await mod(s, 'shop-api', '/v1/tools/resume_agent', 'POST', { names: ['job-one'] })).body).toMatchObject({ status: 'ok', started: ['job-one'] });
  await until(async () => (await agentOf(s, 'job-one'))?.status === 'running');
  s.writeToSession('job-one', 'quit\r'); // it dies before reporting session.start
  await until(() => JSON.parse(readFileSync(ticketFile(projectRoot, 'job-one'), 'utf8')).status === 'suspended_limit');
  await until(async () => (await mod(s, 'shop-api', '/v1/inbox')).body.messages.some((m: { text: string }) => m.text.includes('job-one') && m.text.includes('before its session started')));
});

it('a sleep saved by an earlier run is re-armed: a time still ahead gets its timer, a time that has passed probes at once (Phase 6A)', async () => {
  for (const [until, phase] of [['2026-10-05T09:00:00.000Z', 'probing'], ['2026-10-05T12:00:00.000Z', 'sleeping']] as const) {
    const fake = fakeSleepClock(); // 10:00Z
    const configDir = mkdtempSync(join(tmpdir(), 'q-cfg-'));
    mkdirSync(join(configDir, 'state'), { recursive: true });
    writeFileSync(join(configDir, 'state', 'sleep.json'), JSON.stringify({ until, kind: 'five_hour', attempt: 1, phase: 'sleeping' }));
    const s = await bootServer({ configDir, sleepClock: fake.clock });
    const st = await state(s);
    expect(st.sleep?.phase, until).toBe(phase);
    expect(fake.timers.size, until).toBe(1); // the saved wake-up, or the wait of the probe that started at once
  }
});
