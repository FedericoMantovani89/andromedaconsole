import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeRepo, type TestRepo, removeDir } from './git-helpers';
import { createAgentWorktree } from '../src/server/git/worktree';
import { DEFAULT_SECRET_PATTERNS } from '../src/server/git/secrets';
import { TicketStore } from '../src/server/tickets/store';
import { StepService } from '../src/server/tickets/steps';

// A slow validation must outlive the HTTP request that started it: step_done waits a bounded time, says "running", and the
// job goes on and records the step by itself. Real git and a fake slow test command (no real suite).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Validation: run the suite', 'Update documentation'];
const slow = (ms: number, exit = 0): string => `node -e "setTimeout(()=>{require('fs').writeFileSync('validated.txt','ran');process.exit(${exit})},${ms})"`;

let t: TestRepo;
let wt: string;
let tickets: TicketStore;
let svc: StepService;
let command: string;

beforeEach(async () => {
  t = makeRepo({ remote: true });
  const w = await createAgentWorktree({ repo: t.repo, project: 'p', slug: 'a' });
  wt = w.path;
  tickets = new TicketStore(t.repo);
  command = slow(1500);
  svc = new StepService({
    tickets, project: 'p',
    worktreeOf: (slug) => (slug === 'a' ? { worktree: wt, branch: w.branch } : undefined),
    testCommand: () => command, testTimeoutMs: () => 20_000, secretPatterns: () => DEFAULT_SECRET_PATTERNS,
    notifyMain: () => {}, changed: () => {},
  });
  await svc.checklistSet('a', ITEMS);
  for (let n = 1; n <= 3; n++) await svc.stepDone('a', { n, note: 'a decent note for this step' });
});
afterEach(() => removeDir(t.base));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function untilClosed(count: number): Promise<void> {
  for (let i = 0; i < 300 && closedSteps() < count; i++) await sleep(100);
}
const closedSteps = (): number => tickets.get('a')!.steps.filter((s) => s.done).length;

it('answers "running" when the wait ends before the validation, and the step is recorded when the run ends', async () => {
  const r = await svc.stepDone('a', { n: 4 }, { waitMs: 100 });
  expect(r).toEqual({ status: 'running', n: 4 });
  expect(closedSteps()).toBe(3);
  await untilClosed(4);
  expect(existsSync(join(wt, 'validated.txt'))).toBe(true);
  expect(closedSteps()).toBe(4);
});

it('a repeated call joins the run that is going (the tests start once) and gets the real result', async () => {
  const first = await svc.stepDone('a', { n: 4 }, { waitMs: 100 });
  expect(first.status).toBe('running');
  const again = await svc.stepDone('a', { n: 4 }, { waitMs: 15_000 });
  expect(again).toMatchObject({ status: 'closed', n: 4 });
});

it('a result nobody was waiting for is handed to the next call once, then the step is simply closed', async () => {
  await svc.stepDone('a', { n: 4 }, { waitMs: 100 });
  await untilClosed(4);
  expect(await svc.stepDone('a', { n: 4 }, { waitMs: 100 })).toMatchObject({ status: 'closed', n: 4 });
  expect(await svc.stepDone('a', { n: 4 }, { waitMs: 100 })).toMatchObject({ status: 'refused', code: 'out_of_order' });
});

it('a failing run is reported as refused with its tail, not lost', async () => {
  command = slow(300, 3);
  const r = await svc.stepDone('a', { n: 4 }, { waitMs: 15_000 });
  expect(r).toMatchObject({ status: 'refused', code: 'validation_failed' });
  expect(closedSteps()).toBe(3);
});

it('without a wait window the call behaves as before and returns the final result', async () => {
  command = slow(200);
  expect(await svc.stepDone('a', { n: 4 })).toMatchObject({ status: 'closed', n: 4 });
});
