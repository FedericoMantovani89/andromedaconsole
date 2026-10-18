// Shared test helpers: a real server with a fake agent, plain-http requests (so the Host header can be set), polling.
import type { UpdateControl } from '../src/shared/update';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { startServer } from '../src/server/index';
import { pipePty } from './pipe-pty';
import { untilEnd } from './until-end';
import type { Runner } from '../src/server/prereq/checks';
import type { SleepClock } from '../src/server/budget/sleep';
import type { Notifier } from '../src/server/notify/notifier';
import type { PickFolderResult } from '../src/server/pick-folder';
import type { NotifyClock } from '../src/server/notify/service';

/** A sleep clock that records its timers and moves only when told; `advance` fires what is due. */
export function fakeSleepClock(start = Date.parse('2026-10-05T10:00:00Z')) {
  let t = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void; ms: number }>();
  const clock: SleepClock = {
    now: () => t,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: t + ms, fn, ms }); return id; },
    clearTimeout: (h) => { timers.delete(h as number); },
  };
  const advance = (ms: number): void => {
    const target = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      t = Math.max(t, due[1].at);
      due[1].fn();
    }
    t = target;
  };
  return { clock, advance, timers, now: () => t };
}

export type Running = Awaited<ReturnType<typeof startServer>>;

const fixture = join(__dirname, 'fixtures', 'fake-agent.cjs').replace(/\\/g, '/');
const running: Running[] = [];
const configFiles = new WeakMap<Running, string>();

/** The config.json a server booted with bootServer reads and writes. */
export const configFileOf = (s: Running): string => configFiles.get(s)!;

export const goodRunner: Runner = async (cmd) => ({
  code: 0, stdout: cmd === 'node' ? 'v24.15.0' : cmd === 'git' ? 'git version 2.53.0' : '2.1.289 (Claude Code)',
});

/** Call once at the top of a test file: closes every server started with bootServer after each test. */
export function autoClose(): void {
  afterEach(async () => { while (running.length) await running.pop()!.close(); });
}

let pipeByDefault = false;
/**
 * A test file that never reads the terminal (its output or size) calls this once at the top: every server it boots runs its sessions on plain
 * pipes (`test/pipe-pty.ts`), so the file does not depend on the ConPTY. Modules are not shared between test files, so it holds for that file only.
 */
export function usePipePty(): void { pipeByDefault = true; }

/**
 * A real server with the fake agent. Agents share the project folder (`git.worktrees: false`, the Phase 2 behaviour) unless the
 * test passes a repository as `projectRoot` and `config: { git: { worktrees: true } }`.
 */
export async function bootServer(o: { projectName?: string; language?: string; projectRoot?: string; config?: Record<string, unknown>; afterWorktreeCreated?: (slug: string) => void | Promise<void>; launchCheckMs?: number; projectsDir?: string; tickMs?: number; requestNow?: () => number; sleepClock?: SleepClock; configDir?: string; /** Start with no project folder: only the remembered projects (projects.json in the config folder) are opened. */ noProject?: boolean; /** Replaces the native folder window. */ pickFolder?: () => Promise<unknown>; notifier?: Notifier; notifyClock?: NotifyClock; /** Replaces the command runner of the prerequisite checks and of the plugin list. */ runner?: Runner; /** The desktop app's update control (a fake in the tests). */ updates?: UpdateControl; /** Replaces fetch for the voice dictation's Groq call (a fake: no network). */ groqFetch?: typeof fetch; /** Sessions run on plain pipes instead of a pseudo terminal: for tests that never read the terminal (its output or size). */ pipePty?: boolean } = {}): Promise<Running> {
  const configDir = o.configDir ?? mkdtempSync(join(tmpdir(), 'h-cfg-'));
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ schema: 1, language: o.language ?? 'en', git: { worktrees: false }, ...o.config }));
  const s = await startServer({
    port: 0, ...(o.noProject ? {} : { projectRoot: o.projectRoot ?? mkdtempSync(join(tmpdir(), 'h-project-')), projectName: o.projectName ?? 'shop-api' }), configDir,
    claudeCommand: [process.execPath, fixture], prereqRunner: o.runner ?? goodRunner, modDir: null, afterWorktreeCreated: o.afterWorktreeCreated, launchCheckMs: o.launchCheckMs,
    // Transcripts: a folder of the test's own (or one nobody writes to), never the user's ~/.claude/projects.
    projectsDir: o.projectsDir ?? mkdtempSync(join(tmpdir(), 'h-proj-')), tickMs: o.tickMs, ...((o.pipePty ?? pipeByDefault) ? { ptySpawn: pipePty } : {}), ...(o.requestNow ? { requestNow: o.requestNow } : {}), sleepClock: o.sleepClock, ...(o.pickFolder ? { pickFolder: o.pickFolder as () => Promise<PickFolderResult> } : {}), notifier: o.notifier, notifyClock: o.notifyClock, ...(o.updates ? { updates: o.updates } : {}), ...(o.groqFetch ? { groqFetch: o.groqFetch } : {}),
  });
  running.push(s);
  configFiles.set(s, join(configDir, 'config.json'));
  return s;
}

export interface Res { status: number; body: any }

export function req(s: Running, path: string, o: { method?: string; token?: string; host?: string; body?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${s.port}` };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    const payload = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    if (payload !== undefined) headers['content-type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port: s.port, path, method: o.method ?? 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { let body: any = data; try { body = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, body }); });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

export const ui = (s: Running, path: string, method = 'GET', body?: unknown): Promise<Res> => req(s, path, { method, token: s.token, body });
export const mod = (s: Running, slug: string, path: string, method = 'GET', body?: unknown): Promise<Res> =>
  req(s, path, { method, token: s.sessionTokenFor(slug), body });
/** A console tool called as the mod calls it: asked again while it answers "running" (merge_ticket, step_done). */
export const modToolUntilEnd = (s: Running, slug: string, name: string, body: unknown = {}): Promise<Res> =>
  untilEnd(() => mod(s, slug, `/v1/tools/${name}`, 'POST', body), (r) => r.body?.status);
export const state = async (s: Running) => (await ui(s, '/api/state')).body;

export async function until(f: () => Promise<boolean> | boolean, ms = 8000, what?: () => string): Promise<void> {
  const t = performance.now(); // not Date.now(): a test that fakes Date would never time out (the 20 s test timeout would hit first and say nothing)
  while (!(await f())) {
    if (performance.now() - t > ms) throw new Error(`timeout${what ? `: ${what()}` : ''}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** The events a mod would send, so tests can drive agent states without a real Claude. */
export const modEvent = (s: Running, slug: string, type: string, data?: unknown): Promise<Res> =>
  mod(s, slug, '/v1/events', 'POST', { type, sessionId: `sess-${slug}`, data });
