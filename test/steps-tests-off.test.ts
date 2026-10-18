import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeRepo, type TestRepo, removeDir } from './git-helpers';
import { createAgentWorktree } from '../src/server/git/worktree';
import { installPushHook } from '../src/server/git/hooks';
import { DEFAULT_SECRET_PATTERNS } from '../src/server/git/secrets';
import { KeyedQueue } from '../src/server/keyed-queue';
import { ProjectStore } from '../src/server/project-store';
import { Container } from '../src/server/runtime/container';
import type { Env } from '../src/server/runtime/env';
import type { Services } from '../src/server/runtime/services';
import { registerTests } from '../src/server/runtime/tests';
import { TicketStore } from '../src/server/tickets/store';
import { StepService } from '../src/server/tickets/steps';

// The user switches "skip tests" on (PUT /api/project writes project.json through ProjectStore) while an agent is refused at the
// validation step with no_test_command: the very next step_done with the same n must close the step without running anything.
// The real providers of runtime/tests.ts read the flag and the command; real git; no test command exists in the repository.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Validation: run the suite', 'Update documentation'];

let t: TestRepo;
let store: ProjectStore;
let queue: KeyedQueue;
let svc: StepService;
let runs: number;

beforeEach(async () => {
  t = makeRepo({ remote: true });
  const w = await createAgentWorktree({ repo: t.repo, project: 'p', slug: 'a' });
  await installPushHook({ repo: t.repo, worktree: w.path, branch: w.branch, slug: 'a' });
  store = new ProjectStore(t.repo);
  store.init('p');
  const c = new Container<Services>();
  c.provide('env', () => ({ o: { projectRoot: t.repo, projectName: 'p' } }) as unknown as Env);
  c.provide('store', () => store);
  registerTests(c);
  queue = new KeyedQueue();
  runs = 0;
  svc = new StepService({
    queue, tickets: new TicketStore(t.repo), project: 'p',
    worktreeOf: (slug) => (slug === 'a' ? { worktree: w.path, branch: w.branch } : undefined),
    testCommand: c.get('testCommandAt')('ticket'), testsDisabled: c.get('testsDisabled'),
    runTests: async () => { runs += 1; return { ok: true, code: 0, tail: '' }; },
    testTimeoutMs: () => 20_000, secretPatterns: () => DEFAULT_SECRET_PATTERNS,
    notifyMain: () => {}, changed: () => {},
  });
  await svc.checklistSet('a', ITEMS);
  for (let n = 1; n <= 3; n++) expect((await svc.stepDone('a', { n, note: 'a decent note for this step' })).status).toBe('closed');
});
afterEach(() => removeDir(t.base));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Holds the agent's queue (another ticket service at work), so the next step_done waits past its window. Returns the release. */
function holdQueue(): () => Promise<void> {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  void queue.run('a', () => gate);
  return async () => { open(); await queue.run('a', async () => {}); await sleep(50); };
}

it('refused with no_test_command, then the switch: the next call closes the step and runs nothing', async () => {
  expect(await svc.stepDone('a', { n: 4 }, { waitMs: 15_000 })).toMatchObject({ status: 'refused', code: 'no_test_command' });
  store.setTestsDisabled(true);
  expect(await svc.stepDone('a', { n: 4 }, { waitMs: 15_000 })).toMatchObject({ status: 'closed', n: 4 });
  expect(runs).toBe(0);
});

it('a call that joined a job whose first caller\'s wait ended gets the refusal; after the switch the next call closes', async () => {
  const release = holdQueue();
  expect(await svc.stepDone('a', { n: 4 }, { waitMs: 50 })).toMatchObject({ status: 'running', n: 4 });
  const joined = svc.stepDone('a', { n: 4 }, { waitMs: 15_000 });
  await release();
  expect(await joined).toMatchObject({ status: 'refused', code: 'no_test_command' });
  store.setTestsDisabled(true);
  expect(await svc.stepDone('a', { n: 4 }, { waitMs: 15_000 })).toMatchObject({ status: 'closed', n: 4 });
  expect(runs).toBe(0);
});

it('a refusal nobody was waiting for is not handed to a call made after the switch', async () => {
  const release = holdQueue();
  expect(await svc.stepDone('a', { n: 4 }, { waitMs: 50 })).toMatchObject({ status: 'running', n: 4 });
  await release(); // the job ends refused (no_test_command) while no call waits: its result is kept
  store.setTestsDisabled(true);
  expect(await svc.stepDone('a', { n: 4 }, { waitMs: 15_000 })).toMatchObject({ status: 'closed', n: 4 });
  expect(runs).toBe(0);
});

it('a closed step nobody was waiting for is still handed to the next call once', async () => {
  store.setTestsDisabled(true);
  const release = holdQueue();
  expect(await svc.stepDone('a', { n: 4 }, { waitMs: 50 })).toMatchObject({ status: 'running', n: 4 });
  await release();
  expect(await svc.stepDone('a', { n: 4 }, { waitMs: 15_000 })).toMatchObject({ status: 'closed', n: 4 });
  expect(await svc.stepDone('a', { n: 4 }, { waitMs: 15_000 })).toMatchObject({ status: 'refused', code: 'out_of_order' });
});
