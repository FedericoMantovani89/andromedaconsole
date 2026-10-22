import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeRepo, type TestRepo, removeDir } from './git-helpers';
import { createAgentWorktree } from '../src/server/git/worktree';
import { DEFAULT_SECRET_PATTERNS } from '../src/server/git/secrets';
import { TicketStore } from '../src/server/tickets/store';
import { StepService, type StepResult } from '../src/server/tickets/steps';

// Real git and real processes: slow on a busy machine, so these tests get a longer budget.
vi.setConfig({ testTimeout: 60_000 });

const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];
const MARKER = 'node -e "require(\'fs\').writeFileSync(\'validated.txt\', \'ran\')"';
const W = { requestId: 'TODO-7f3a15', to: 'be-orders' };

let t: TestRepo;
let wt: string;
let tickets: TicketStore;
let svc: StepService;
let debts: string[];
let requestIds: string[];

beforeEach(async () => {
  t = makeRepo({ remote: true });
  const w = await createAgentWorktree({ repo: t.repo, project: 'p', slug: 'a' });
  wt = w.path;
  tickets = new TicketStore(t.repo);
  debts = []; requestIds = [];
  svc = new StepService({
    tickets, project: 'p',
    worktreeOf: (slug) => (slug === 'a' ? { worktree: wt, branch: w.branch } : undefined),
    testCommand: () => MARKER, testTimeoutMs: () => 20_000, secretPatterns: () => DEFAULT_SECRET_PATTERNS,
    notifyMain: () => {}, changed: () => {},
    debts: () => debts, requestIds: () => requestIds,
  });
});
afterEach(() => removeDir(t.base));

const done = (n: number, extra: { note?: string } = {}): Promise<StepResult> => svc.stepDone('a', { n, ...extra });
const code = (r: StepResult): string => (r.status === 'refused' ? r.code : 'closed');
async function upTo(last: number, items = ITEMS): Promise<void> {
  await svc.checklistSet('a', items);
  for (let n = 1; n <= last; n++) {
    const r = await done(n, { note: 'a decent note for this step' });
    if (r.status !== 'closed') throw new Error(`step ${n}: ${JSON.stringify(r)}`);
  }
}

it('a waiting step is skipped: the agent goes on to the next one, and cannot close the waiting one', async () => {
  await upTo(2);
  expect(await svc.markWaiting('a', 3, W)).toEqual({ ok: true });
  expect(code(await done(3))).toBe('out_of_order');
  expect(code(await done(4))).toBe('closed');
  expect(tickets.get('a')!.steps.map((s) => s.done)).toEqual([true, true, false, true, false, false]);
});
it('the checklist file in the worktree says what a step waits for', async () => {
  await upTo(2);
  await svc.markWaiting('a', 3, W);
  const file = join(wt, '.andromedaconsole', 'checklist.md');
  expect(readFileSync(file, 'utf8')).toContain('waiting for TODO-7f3a15 (be-orders)');
});
it('the validation and documentation cannot be closed while a step waits, and the tests do not run', async () => {
  await upTo(2);
  await svc.markWaiting('a', 3, W);
  await done(4);
  const r = await done(5);
  expect(code(r)).toBe('pending_requests');
  expect(r.status === 'refused' && r.detail).toContain('TODO-7f3a15');
  expect(existsSync(join(wt, 'validated.txt'))).toBe(false);
});
it('markWaiting refuses the validation and documentation steps, a closed step, an unknown step and a step that already waits', async () => {
  await upTo(2);
  expect(await svc.markWaiting('a', 5, W)).toMatchObject({ ok: false });
  expect(await svc.markWaiting('a', 6, W)).toMatchObject({ ok: false });
  expect(await svc.markWaiting('a', 1, W)).toMatchObject({ ok: false });
  expect(await svc.markWaiting('a', 99, W)).toMatchObject({ ok: false });
  expect(await svc.markWaiting('a', 3, W)).toEqual({ ok: true });
  expect(await svc.markWaiting('a', 3, { requestId: 'TODO-bbbbbb', to: 'x' })).toMatchObject({ ok: false });
  expect(await svc.markWaiting('nobody', 3, W)).toMatchObject({ ok: false });
});
it('clearWaiting returns the step, which is then the first open one again', async () => {
  await upTo(2);
  await svc.markWaiting('a', 3, W);
  expect(await svc.clearWaiting('a', 'TODO-7f3a15')).toEqual({ n: 3, title: 'Implement a' });
  expect(await svc.clearWaiting('a', 'TODO-7f3a15')).toBeUndefined();
  expect(code(await done(3))).toBe('closed');
});
it('a step that waited cannot close while its comment is still in the code, and then can', async () => {
  await upTo(2);
  await svc.markWaiting('a', 3, W);
  await done(4);
  await svc.clearWaiting('a', 'TODO-7f3a15');
  mkdirSync(join(wt, 'src'), { recursive: true });
  writeFileSync(join(wt, 'src', 'orders.ts'), 'export const x = 1;\n// TODO-7f3a15 signature of POST /orders\n');
  const r = await done(3);
  expect(code(r)).toBe('todo_left');
  expect(r.status === 'refused' && r.files).toEqual(['src/orders.ts:2']);
  expect(tickets.get('a')!.steps[2]!.done).toBe(false);
  writeFileSync(join(wt, 'src', 'orders.ts'), 'export const x = 1;\nexport const post = () => 201;\n');
  expect(code(await done(3))).toBe('closed');
});
it('a request still owed blocks the validation, and the step named after it blocks itself', async () => {
  const items = ['Study the code', 'Tests first: ordering', 'Answer TODO-aaaaaa', 'Implement a', 'Validation: run the suite', 'Update documentation'];
  await upTo(2, items);
  debts = ['TODO-aaaaaa'];
  const here = await done(3);
  expect(code(here)).toBe('request_unanswered');
  // A request's text waits for the end of the turn (a plugin prompt enters once the session is idle): the id can be seen first.
  expect(here.status === 'refused' && here.detail).toMatch(/text .*end your turn/i);
  debts = [];
  expect(code(await done(3))).toBe('closed');
  await done(4);
  debts = ['TODO-cccccc'];
  const r = await done(5);
  expect(code(r)).toBe('unanswered_requests');
  expect(r.status === 'refused' && r.detail).toContain('TODO-cccccc');
  expect(r.status === 'refused' && r.detail).toMatch(/text .*end your turn/i);
  expect(existsSync(join(wt, 'validated.txt'))).toBe(false);
});
it('the ticket is not delivered while any comment of any of its requests is left, and is when they are gone', async () => {
  await upTo(5);
  requestIds = ['TODO-7f3a15', 'TODO-bbbbbb'];
  writeFileSync(join(wt, 'README.md'), 'hello docs\n');
  writeFileSync(join(wt, 'late.ts'), '// TODO-bbbbbb a request that was settled by the main\n');
  const r = await done(6, { note: 'documented the new endpoint' });
  expect(code(r)).toBe('todo_left');
  expect(tickets.get('a')!.status).toBe('in_progress');
  rmSync(join(wt, 'late.ts'));
  const ok = await done(6, { note: 'documented the new endpoint' });
  expect(ok).toMatchObject({ status: 'closed', delivered: true });
  expect(tickets.get('a')!.status).toBe('delivered');
});
it('a new checklist cannot drop a waiting step', async () => {
  await upTo(2);
  await svc.markWaiting('a', 3, W);
  const r = await svc.checklistSet('a', ['Study the code', 'Tests first: ordering', 'Implement c', 'Implement b', 'Validation: run the suite', 'Update documentation']);
  expect(r).toMatchObject({ status: 'refused', code: 'changes_waiting' });
});
