import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeRepo, type TestRepo, removeDir } from './git-helpers';
import { createAgentWorktree } from '../src/server/git/worktree';
import { installPushHook } from '../src/server/git/hooks';
import { DEFAULT_SECRET_PATTERNS } from '../src/server/git/secrets';
import { parseAgentTests } from '../src/server/tickets/agent-tests';
import { TicketStore } from '../src/server/tickets/store';
import { StepService } from '../src/server/tickets/steps';

// What the agent says about the tests it ran itself travels with step_done and is kept on the ticket (last one wins); the console
// never runs or checks it. Real git, as in steps-tests-off.test.ts; the tests are switched off, so the validation runs nothing.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Validation: run the suite', 'Update documentation'];

let t: TestRepo;
let tickets: TicketStore;
let svc: StepService;

beforeEach(async () => {
  t = makeRepo({ remote: true });
  const w = await createAgentWorktree({ repo: t.repo, project: 'p', slug: 'a' });
  await installPushHook({ repo: t.repo, worktree: w.path, branch: w.branch, slug: 'a' });
  tickets = new TicketStore(t.repo);
  svc = new StepService({
    tickets, project: 'p',
    worktreeOf: (slug) => (slug === 'a' ? { worktree: w.path, branch: w.branch } : undefined),
    testCommand: () => undefined, testsDisabled: () => true,
    testTimeoutMs: () => 20_000, secretPatterns: () => DEFAULT_SECRET_PATTERNS,
    notifyMain: () => {}, changed: () => {},
  });
  await svc.checklistSet('a', ITEMS);
});
afterEach(() => removeDir(t.base));

it('step_done with tests stores them on the ticket; without, the ticket has none', async () => {
  expect((await svc.stepDone('a', { n: 1, note: 'a decent note for this step' })).status).toBe('closed');
  expect(tickets.get('a')!.agentTests).toBeUndefined();
  const tests = { command: 'npm test', result: 'passed' as const, summary: '358 tests ok' };
  expect((await svc.stepDone('a', { n: 2, note: 'a decent note for this step', tests })).status).toBe('closed');
  expect(tickets.get('a')!.agentTests).toEqual(tests);
});

it('the last report wins, and a later step_done without tests keeps the earlier one', async () => {
  await svc.stepDone('a', { n: 1, note: 'a decent note for this step', tests: { command: 'npm test', result: 'failed' } });
  await svc.stepDone('a', { n: 2, note: 'a decent note for this step', tests: { command: 'npm test', result: 'passed' } });
  await svc.stepDone('a', { n: 3, note: 'a decent note for this step' });
  expect(tickets.get('a')!.agentTests).toEqual({ command: 'npm test', result: 'passed' });
});

it('parseAgentTests accepts the documented shape and trims', () => {
  expect(parseAgentTests({ command: ' npm test ', result: 'passed', summary: ' ok ' })).toEqual({ ok: true, tests: { command: 'npm test', result: 'passed', summary: 'ok' } });
  expect(parseAgentTests({ command: 'x', result: 'failed' })).toEqual({ ok: true, tests: { command: 'x', result: 'failed' } });
  expect(parseAgentTests({ command: 'x', result: 'failed', summary: '   ' })).toEqual({ ok: true, tests: { command: 'x', result: 'failed' } });
});

it.each([
  ['not an object', 'passed', 'tests'],
  ['an array', [], 'tests'],
  ['no command', { result: 'passed' }, 'tests.command'],
  ['an empty command', { command: '  ', result: 'passed' }, 'tests.command'],
  ['a command of several lines', { command: 'a\nb', result: 'passed' }, 'tests.command'],
  ['a command over 500 characters', { command: 'x'.repeat(501), result: 'passed' }, 'tests.command'],
  ['a result that is neither passed nor failed', { command: 'x', result: 'ok' }, 'tests.result'],
  ['no result', { command: 'x' }, 'tests.result'],
  ['a summary that is not text', { command: 'x', result: 'passed', summary: 3 }, 'tests.summary'],
  ['a summary over 500 characters', { command: 'x', result: 'passed', summary: 'y'.repeat(501) }, 'tests.summary'],
])('parseAgentTests refuses %s and names %s', (_why, raw, field) => {
  const r = parseAgentTests(raw);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.detail.startsWith(field)).toBe(true);
});
