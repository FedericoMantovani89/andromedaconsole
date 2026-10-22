import { rmSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeRepo, type TestRepo, removeDir } from './git-helpers';
import { createAgentWorktree } from '../src/server/git/worktree';
import { DEFAULT_SECRET_PATTERNS } from '../src/server/git/secrets';
import { TicketStore } from '../src/server/tickets/store';
import { StepService } from '../src/server/tickets/steps';
import type { TestRun } from '../src/server/tickets/test-queue';

vi.setConfig({ testTimeout: 60_000 });

const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Validation: run the suite', 'Update documentation'];

let t: TestRepo;
let svc: StepService;
let release: (r: TestRun) => void;
let asked: { owner?: string; watchOwner?: boolean }[];
let place: number | undefined;

beforeEach(async () => {
  t = makeRepo({ remote: true });
  const w = await createAgentWorktree({ repo: t.repo, project: 'p', slug: 'a' });
  asked = []; place = undefined;
  svc = new StepService({
    tickets: new TicketStore(t.repo), project: 'p',
    worktreeOf: () => ({ worktree: w.path, branch: w.branch }),
    testCommand: () => 'full-suite', testTimeoutMs: () => 20_000, secretPatterns: () => DEFAULT_SECRET_PATTERNS,
    notifyMain: () => {}, changed: () => {},
    runTests: (o) => { asked.push({ owner: o.owner, watchOwner: o.watchOwner }); return new Promise<TestRun>((resolve) => { release = resolve; }); },
    queuePosition: () => place,
  });
});
afterEach(() => removeDir(t.base));

it('the validation step goes through the test runner as the agent\'s own run, and step_done says where it waits in the queue', async () => {
  await svc.checklistSet('a', ITEMS);
  for (let n = 1; n <= 3; n++) expect((await svc.stepDone('a', { n, note: 'a decent note for this step' })).status).toBe('closed');
  place = 2;
  const first = await svc.stepDone('a', { n: 4, note: 'ready' }, { waitMs: 100 });
  expect(first).toEqual({ status: 'running', n: 4, queue: 2 });
  expect(asked).toEqual([{ owner: 'a', watchOwner: true }]);
  place = undefined;
  const pending = svc.stepDone('a', { n: 4 }, { waitMs: 5000 });
  release({ ok: true, code: 0, tail: '' });
  expect((await pending).status).toBe('closed');
});

it('a validation cancelled because its agent is gone is refused, not accepted', async () => {
  await svc.checklistSet('a', ITEMS);
  for (let n = 1; n <= 3; n++) await svc.stepDone('a', { n, note: 'a decent note for this step' });
  const pending = svc.stepDone('a', { n: 4, note: 'ready' });
  await new Promise((r) => setTimeout(r, 200));
  release({ ok: false, code: null, tail: '', cancelled: true });
  expect(await pending).toMatchObject({ status: 'refused', code: 'validation_failed', detail: 'the test run was cancelled' });
});
