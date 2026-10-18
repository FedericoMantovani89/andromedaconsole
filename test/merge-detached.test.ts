import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitSync, makeRepo, type TestRepo, removeDir } from './git-helpers';
import { createAgentWorktree } from '../src/server/git/worktree';
import { git } from '../src/server/git/git';
import { loadBundles } from '../src/server/i18n-bundles';
import { createTranslator } from '../src/shared/i18n';
import { TicketStore } from '../src/server/tickets/store';
import { validateChecklist } from '../src/server/tickets/checklist';
import { MergeService, type MergeDeps } from '../src/server/tickets/merge';
import type { TestRun } from '../src/server/tickets/test-queue';

// merge_ticket runs git merge, the project's tests and the cleanup: longer than the host keeps a request open. Like step_done it is a
// job of its own: a bounded call answers "running", a repeated call joins the job or, once merged, answers from the ticket. Real git,
// a fake test runner (no real suite).
vi.mock('../src/server/git/git', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/server/git/git')>();
  return { ...real, git: vi.fn(real.git) };
});
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const bundles = loadBundles();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let t: TestRepo;
let tickets: TicketStore;
let worktrees: Map<string, { worktree: string; branch: string }>;
let main: string[];
let finishFails: boolean;
let runs: number;
let testDelayMs: number;
let testsPass: boolean;

function service(): MergeService {
  const deps: MergeDeps = {
    tickets, root: t.repo, project: 'p',
    worktreeOf: (slug) => worktrees.get(slug),
    testCommand: () => 'npm test', testTimeoutMs: () => 30_000, squash: () => true,
    runTests: async (): Promise<TestRun> => {
      runs += 1;
      await sleep(testDelayMs);
      return testsPass ? { ok: true, code: 0, tail: 'all green' } : { ok: false, code: 1, tail: 'one test failed' };
    },
    language: () => ({ lang: 'en', t: createTranslator({ lang: 'en', messages: bundles.get('en') ?? {}, fallback: bundles.get('en') }) }),
    authorAlive: () => true,
    notifyMain: (text) => { main.push(text); },
    notifyAuthor: () => {},
    needsUser: () => {},
    finishAgent: async () => { if (finishFails) throw new Error('cannot stop'); },
  };
  return new MergeService(deps);
}

beforeEach(() => {
  t = makeRepo({ remote: true });
  tickets = new TicketStore(t.repo);
  worktrees = new Map();
  main = []; finishFails = false; runs = 0; testDelayMs = 800; testsPass = true;
});
afterEach(() => removeDir(t.base));

async function approvedTicket(slug: string, files: Record<string, string>): Promise<void> {
  const w = await createAgentWorktree({ repo: t.repo, project: 'p', slug });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(w.path, name, '..'), { recursive: true });
    writeFileSync(join(w.path, name), content);
  }
  gitSync(w.path, 'add', '-A');
  gitSync(w.path, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '--allow-empty', '-m', `step 3/6: ${slug}`);
  const sha = gitSync(w.path, 'rev-parse', 'HEAD');
  const r = validateChecklist(['Study the code', 'Tests first', 'Implement', 'Implement more', 'Validation', 'Update documentation']);
  if (!r.ok) throw new Error(r.code);
  tickets.setChecklist(slug, r.steps.map((s) => ({ ...s, done: true, note: s.n === 1 ? 'found the code' : undefined })));
  tickets.setGoal(slug, `Work of ${slug}`);
  tickets.move(slug, 'delivered', { deliveredSha: sha });
  tickets.move(slug, 'in_review', { reviewer: `review-${slug}` });
  tickets.addVerdict(slug, { pass: true, reviewer: `review-${slug}`, notes: [] });
  tickets.move(slug, 'approved');
  worktrees.set(slug, { worktree: w.path, branch: w.branch });
}
const projectCount = (): number => Number(gitSync(t.repo, 'rev-list', '--count', 'project/p'));
const projectTip = (): string => gitSync(t.repo, 'rev-parse', 'project/p');
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !cond(); i++) await sleep(50);
}

describe('merge_ticket as a detached job', () => {
  it('answers "running" when the tests outlast the wait, and the repeated call answers "merged" with the same sha and one commit', async () => {
    await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    const svc = service();
    const before = projectCount();
    expect(await svc.mergeTicket('a-job', { waitMs: 50 })).toEqual({ status: 'running' });
    const again = await svc.mergeTicket('a-job', { waitMs: 15_000 });
    expect(again).toEqual({ status: 'merged', sha: projectTip() });
    expect(await svc.mergeTicket('a-job', { waitMs: 50 })).toEqual({ status: 'merged', sha: projectTip() });
    expect(projectCount()).toBe(before + 1);
    expect(runs).toBe(1);
  });

  it('an already merged ticket answers "merged" from the ticket without touching git, also after a restart', async () => {
    await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    testDelayMs = 0;
    const merged = await service().mergeTicket('a-job', { waitMs: 15_000 });
    expect(merged).toMatchObject({ status: 'merged' });
    const sha = (merged as { sha: string }).sha;
    vi.mocked(git).mockClear();
    runs = 0;
    const restarted = service(); // a fresh service has no job in memory: the ticket status decides
    expect(await restarted.mergeTicket('a-job', { waitMs: 50 })).toEqual({ status: 'merged', sha });
    expect(vi.mocked(git)).not.toHaveBeenCalled();
    expect(runs).toBe(0);
  });

  it('a released ticket was merged too: it answers "merged" with its sha without touching git', async () => {
    await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    testDelayMs = 0;
    const merged = await service().mergeTicket('a-job', { waitMs: 15_000 });
    const sha = (merged as { sha: string }).sha;
    tickets.move('a-job', 'released');
    vi.mocked(git).mockClear();
    runs = 0;
    expect(await service().mergeTicket('a-job', { waitMs: 50 })).toEqual({ status: 'merged', sha });
    expect(vi.mocked(git)).not.toHaveBeenCalled();
    expect(runs).toBe(0);
  });

  it('two calls at the same moment share one job', async () => {
    await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    const svc = service();
    const [x, y] = await Promise.all([svc.mergeTicket('a-job', { waitMs: 15_000 }), svc.mergeTicket('a-job', { waitMs: 15_000 })]);
    expect(x).toEqual({ status: 'merged', sha: projectTip() });
    expect(y).toEqual(x);
    expect(runs).toBe(1);
  });

  it('red tests: the first and the repeated call both answer tests_failed and the project branch is back where it was', async () => {
    await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    testsPass = false;
    const svc = service();
    const tip = projectTip();
    expect(await svc.mergeTicket('a-job', { waitMs: 15_000 })).toMatchObject({ status: 'tests_failed', tail: 'one test failed' });
    expect(await svc.mergeTicket('a-job', { waitMs: 50 })).toMatchObject({ status: 'tests_failed', tail: 'one test failed' });
    expect(projectTip()).toBe(tip);
    expect(tickets.get('a-job')!.status).toBe('in_progress');
    expect(runs).toBe(1);
  });

  it('red tests nobody was waiting for are still the answer of the next call', async () => {
    await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    testsPass = false;
    const svc = service();
    expect(await svc.mergeTicket('a-job', { waitMs: 50 })).toEqual({ status: 'running' });
    await until(() => tickets.get('a-job')!.status !== 'approved');
    await sleep(100);
    expect(await svc.mergeTicket('a-job', { waitMs: 50 })).toMatchObject({ status: 'tests_failed' });
    expect(runs).toBe(1);
  });

  it('a failed cleanup answers "merged" with what was left, and the notice to the main names the same', async () => {
    await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    testDelayMs = 0;
    finishFails = true;
    const svc = service();
    const r = await svc.mergeTicket('a-job', { waitMs: 15_000 });
    expect(r).toEqual({ status: 'merged', sha: projectTip(), cleanup: { incomplete: ['session'] } });
    const notice = main.find((m) => m.includes('was merged'))!;
    expect(notice).toMatch(/session/);
    expect(notice).not.toMatch(/completely/);
    expect(await svc.mergeTicket('a-job', { waitMs: 50 })).toMatchObject({ status: 'merged', sha: projectTip() });
  });
});
