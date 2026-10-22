import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { branchesOf, gitSync, makeRepo, type TestRepo, removeDir } from './git-helpers';
import { createAgentWorktree } from '../src/server/git/worktree';
import { DEFAULT_SECRET_PATTERNS } from '../src/server/git/secrets';
import { TicketStore } from '../src/server/tickets/store';
import { StepService, type StepResult } from '../src/server/tickets/steps';
import { runValidation } from '../src/server/tickets/validate';

// Real git and real processes: slow on a busy machine, so these tests get a longer budget.
vi.setConfig({ testTimeout: 60_000 });

const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];
const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "console.log(\'boom\'); process.exit(1)"';
const MARKER = 'node -e "require(\'fs\').writeFileSync(\'validated.txt\', process.cwd())"';

let t: TestRepo;
let wt: string;
let branch: string;
let tickets: TicketStore;
let svc: StepService;
let messages: string[];
let command: string | undefined;
let off = false; // the project's tests are switched off
let timeoutMs: number;

async function setup(remote = true): Promise<void> {
  off = false;
  t = makeRepo({ remote });
  const w = await createAgentWorktree({ repo: t.repo, project: 'p', slug: 'a' });
  wt = w.path;
  branch = w.branch;
  tickets = new TicketStore(t.repo);
  messages = [];
  command = PASS;
  timeoutMs = 20_000;
  svc = new StepService({
    tickets, project: 'p',
    worktreeOf: (slug) => (slug === 'a' ? { worktree: wt, branch } : undefined),
    testCommand: () => command, testsDisabled: () => off, testTimeoutMs: () => timeoutMs, secretPatterns: () => DEFAULT_SECRET_PATTERNS,
    notifyMain: (_slug, text) => { messages.push(text); }, changed: () => {},
  });
}
beforeEach(() => setup());
afterEach(() => removeDir(t.base));

const commits = (): string[] => gitSync(wt, 'log', '--format=%s', 'project/p..HEAD').split('\n').filter(Boolean).reverse();
const done = async (n: number, extra: { note?: string; skip?: boolean } = {}): Promise<StepResult> => svc.stepDone('a', { n, ...extra });
async function closeUpTo(last: number): Promise<void> {
  for (let n = 1; n <= last; n++) {
    if (n === 6) writeFileSync(join(wt, 'README.md'), 'hello docs\n');
    const r = await done(n, { note: 'a decent note for this step' });
    if (r.status !== 'closed') throw new Error(`step ${n}: ${JSON.stringify(r)}`);
  }
}
const refused = (r: StepResult): string => (r.status === 'refused' ? r.code : 'closed');

describe('checklistSet', () => {
  it('stores the checklist and writes .andromedaconsole/checklist.md in the worktree', async () => {
    const r = await svc.checklistSet('a', ITEMS);
    expect(r.status).toBe('ok');
    expect(tickets.progress('a')).toMatchObject({ done: 0, total: 6 });
    const file = readFileSync(join(wt, '.andromedaconsole', 'checklist.md'), 'utf8');
    expect(file).toContain('ticket: a');
    expect(file).toContain('- [ ] 1. Study the code');
  });
  it('refuses a bad skeleton with the code and a detail', async () => {
    const r = await svc.checklistSet('a', ['Implement', 'x']);
    expect(r).toMatchObject({ status: 'refused', code: 'too_short' });
  });
  it('a re-set keeps closed steps and refuses changing them', async () => {
    await svc.checklistSet('a', ITEMS);
    await done(1, { note: 'study notes here' });
    const ok = await svc.checklistSet('a', [...ITEMS.slice(0, 4), 'Implement c', ...ITEMS.slice(4)]);
    expect(ok.status).toBe('ok');
    expect(tickets.get('a')!.steps[0]!.done).toBe(true);
    expect(tickets.progress('a')).toMatchObject({ done: 1, total: 7 });
    const bad = await svc.checklistSet('a', ['Study something else', ...ITEMS.slice(1)]);
    expect(bad).toMatchObject({ status: 'refused', code: 'changes_done' });
    expect(readFileSync(join(wt, '.andromedaconsole', 'checklist.md'), 'utf8')).toContain('- [x] 1. Study the code');
  });
  it('an unknown agent has no worktree', async () => {
    expect(await svc.checklistSet('ghost', ITEMS)).toMatchObject({ status: 'refused', code: 'no_worktree' });
  });
});

describe('stepDone', () => {
  it('happy path: N commits with the SPEC messages, validation in the worktree, push, delivered, main told', async () => {
    command = MARKER;
    await svc.checklistSet('a', ITEMS);
    writeFileSync(join(wt, 'x.test.js'), 'throw new Error("red on purpose")\n'); // step 2 may be red
    await closeUpTo(6);
    expect(commits()).toEqual(ITEMS.map((title, i) => `step ${i + 1}/6: ${title}`));
    const body = gitSync(wt, 'log', '-1', '--format=%B', 'HEAD~5');
    expect(body).toContain('Agent: a');
    expect(body).toContain('Ticket: a');
    expect(body).toContain('Progetto: p');
    expect(readFileSync(join(wt, 'validated.txt'), 'utf8').toLowerCase()).toBe(wt.toLowerCase());
    expect(branchesOf(t.remote)).toContain('agent/p/a');
    expect(tickets.progress('a')).toMatchObject({ done: 6, total: 6, status: 'delivered' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/delivered/);
    expect(messages[0]).toContain('agent/p/a');
  });
  it('a red step 2 is accepted without running anything', async () => {
    command = FAIL;
    await svc.checklistSet('a', ITEMS);
    await done(1, { note: 'study notes here' });
    expect(await done(2)).toMatchObject({ status: 'closed', n: 2, total: 6 });
  });
  it('a failing validation returns the tail, closes and commits nothing, then passes after the fix', async () => {
    await svc.checklistSet('a', ITEMS);
    await closeUpTo(4);
    command = FAIL;
    const r = await done(5);
    expect(r).toMatchObject({ status: 'refused', code: 'validation_failed' });
    expect(r.status === 'refused' && r.tail).toContain('boom');
    expect(commits()).toHaveLength(4);
    expect(tickets.progress('a')?.done).toBe(4);
    command = PASS;
    expect(await done(5)).toMatchObject({ status: 'closed', n: 5 });
    expect(commits()).toHaveLength(5);
  });
  it('a missing test command refuses the validation step', async () => {
    await svc.checklistSet('a', ITEMS);
    await closeUpTo(4);
    command = undefined;
    expect(refused(await done(5))).toBe('no_test_command');
    command = '   ';
    expect(refused(await done(5))).toBe('no_test_command');
  });
  it('with the tests switched off the validation step closes without running anything, even with no command', async () => {
    await svc.checklistSet('a', ITEMS);
    await closeUpTo(4);
    off = true;
    command = FAIL; // would fail if it ran
    expect(await done(5)).toMatchObject({ status: 'closed', n: 5 });
    command = undefined;
    off = false;
    expect(refused(await done(6, { note: 'docs note long enough to close the last step' }))).not.toBe('validation_failed');
  });
  it('the validation step cannot be skipped', async () => {
    await svc.checklistSet('a', ITEMS);
    await closeUpTo(4);
    expect(refused(await done(5, { skip: true, note: 'x'.repeat(30) }))).toBe('validation_failed');
  });
  it('a validation that outlives its timeout is killed and reported', async () => {
    await svc.checklistSet('a', ITEMS);
    await closeUpTo(4);
    command = 'node -e "setTimeout(()=>{},60000)"';
    timeoutMs = 800;
    const started = Date.now();
    const r = await done(5);
    expect(r).toMatchObject({ status: 'refused', code: 'validation_failed', timedOut: true });
    expect(Date.now() - started).toBeLessThan(15_000);
  });
  it('refuses out-of-order, repeated and impossible steps without a second commit', async () => {
    await svc.checklistSet('a', ITEMS);
    expect(refused(await done(3))).toBe('out_of_order');
    await done(1, { note: 'study notes here' });
    expect(refused(await done(1, { note: 'study notes here' }))).toBe('out_of_order');
    expect(refused(await done(99))).toBe('out_of_order');
    expect(refused(await done(0))).toBe('out_of_order');
    expect(commits()).toHaveLength(1);
  });
  it('two simultaneous calls for the same step close it once', async () => {
    await svc.checklistSet('a', ITEMS);
    const [a, b] = await Promise.all([done(1, { note: 'study notes here' }), done(1, { note: 'study notes here' })]);
    expect([a.status, b.status].sort()).toEqual(['closed', 'refused']);
    expect(commits()).toHaveLength(1);
  });
  it('without a checklist: no_checklist; without a worktree: no_worktree', async () => {
    expect(refused(await done(1))).toBe('no_checklist');
    expect(refused(await svc.stepDone('ghost', { n: 1 }))).toBe('no_worktree');
  });
  it('step 1 needs the study note', async () => {
    await svc.checklistSet('a', ITEMS);
    expect(refused(await done(1))).toBe('note_required');
    expect(refused(await done(1, { note: 'short' }))).toBe('note_required');
    expect(await done(1, { note: 'found the order module' })).toMatchObject({ status: 'closed' });
  });
  it('a skipped step needs a note of at least 20 characters and still commits', async () => {
    await svc.checklistSet('a', ITEMS);
    await closeUpTo(2);
    expect(refused(await done(3, { skip: true }))).toBe('note_required');
    expect(refused(await done(3, { skip: true, note: 'x'.repeat(19) }))).toBe('note_required');
    expect(await done(3, { skip: true, note: 'x'.repeat(20) })).toMatchObject({ status: 'closed' });
    expect(tickets.get('a')!.steps[2]).toMatchObject({ skipped: true, done: true });
    expect(commits()).toHaveLength(3);
  });
  it('the documentation step needs a change or a note of at least 10 characters', async () => {
    await svc.checklistSet('a', ITEMS);
    await closeUpTo(5);
    expect(refused(await done(6))).toBe('docs_empty');
    expect(refused(await done(6, { note: 'short' }))).toBe('docs_empty');
    expect(await done(6, { note: 'no documentation needed here' })).toMatchObject({ status: 'closed', delivered: true });
  });
  it('a documentation change alone is enough', async () => {
    await svc.checklistSet('a', ITEMS);
    await closeUpTo(5);
    writeFileSync(join(wt, 'CHANGELOG.md'), '- a change\n');
    expect(await done(6)).toMatchObject({ status: 'closed', delivered: true });
  });
  it('a secret in the worktree blocks the commit and names the file; nothing is left staged', async () => {
    await svc.checklistSet('a', ITEMS);
    await closeUpTo(2);
    writeFileSync(join(wt, '.env'), 'TOKEN=abc\n');
    const r = await done(3);
    expect(r).toMatchObject({ status: 'refused', code: 'secrets' });
    expect(r.status === 'refused' && r.files).toEqual(['.env']);
    expect(commits()).toHaveLength(2);
    expect(gitSync(wt, 'diff', '--cached', '--name-only')).toBe('');
    rmSync(join(wt, '.env'));
    expect(await done(3)).toMatchObject({ status: 'closed' });
  });
  it('an index.lock is reported as retry-later and never deleted', async () => {
    await svc.checklistSet('a', ITEMS);
    await closeUpTo(2);
    const lock = gitSync(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock');
    mkdirSync(join(lock, '..'), { recursive: true });
    writeFileSync(lock, '');
    expect(refused(await done(3))).toBe('index_locked');
    expect(existsSync(lock)).toBe(true);
    rmSync(lock);
    expect(await done(3)).toMatchObject({ status: 'closed' });
  });
  it('after delivery nothing more can be closed', async () => {
    await svc.checklistSet('a', ITEMS);
    await closeUpTo(6);
    expect(refused(await done(6, { note: 'again and again' }))).toBe('already_delivered');
    expect(commits()).toHaveLength(6);
  });
  it('without a remote the ticket is still delivered and the main is told the push was skipped', async () => {
    rmSync(t.base, { recursive: true, force: true });
    await setup(false);
    await svc.checklistSet('a', ITEMS);
    await closeUpTo(6);
    expect(tickets.progress('a')?.status).toBe('delivered');
    expect(messages[0]).toMatch(/no remote/i);
  });
  it('a failed push still delivers, and says so', async () => {
    gitSync(t.repo, 'remote', 'set-url', 'origin', join(t.base, 'does-not-exist.git'));
    await svc.checklistSet('a', ITEMS);
    await closeUpTo(5);
    writeFileSync(join(wt, 'README.md'), 'hello docs\n');
    const r = await done(6, { note: 'docs are fine as they are' });
    expect(r).toMatchObject({ status: 'closed', delivered: true, pushed: false });
    expect(messages[0]).toMatch(/push failed/i);
  });
});

describe('reportBlocked', () => {
  it('tells the main, marks the ticket blocked, and clears on the next closed step', async () => {
    await svc.checklistSet('a', ITEMS);
    svc.reportBlocked('a', 'need the database schema');
    expect(messages[0]).toContain('need the database schema');
    expect(messages[0]).toContain('a');
    expect(tickets.progress('a')?.blocked).toBe(true);
    await done(1, { note: 'study notes here' });
    expect(tickets.progress('a')?.blocked).toBe(false);
  });
  it('works before a checklist exists', () => {
    svc.reportBlocked('a', 'cannot find the repo layout');
    expect(tickets.progress('a')).toMatchObject({ blocked: true, total: 0 });
  });
});

describe('runValidation', () => {
  const cwd = process.cwd();
  it('reports exit codes', async () => {
    expect(await runValidation({ cwd, command: PASS, timeoutMs: 20_000 })).toMatchObject({ ok: true, code: 0 });
    expect(await runValidation({ cwd, command: 'node -e "process.exit(3)"', timeoutMs: 20_000 })).toMatchObject({ ok: false, code: 3 });
  });
  it('keeps only the last 4 KiB, with colour codes stripped', async () => {
    const r = await runValidation({ cwd, command: `node -e "console.log('x'.repeat(9000)); console.log('\\u001b[31mred\\u001b[0m END')"`, timeoutMs: 20_000 });
    expect(r.tail.length).toBeLessThanOrEqual(4096);
    expect(r.tail).toContain('red END');
    expect(r.tail).not.toContain(String.fromCharCode(27));
  });
  it('merges stderr into the tail', async () => {
    const r = await runValidation({ cwd, command: 'node -e "console.error(\'oops\'); process.exit(1)"', timeoutMs: 20_000 });
    expect(r.tail).toContain('oops');
  });
  it('a command that does not exist fails cleanly', async () => {
    const r = await runValidation({ cwd, command: 'definitely-not-a-command-xyz', timeoutMs: 20_000 });
    expect(r.ok).toBe(false);
  });
  it('runs in the given folder and never receives the console token', async () => {
    process.env.CONSOLE_TOKEN = 'secret-token';
    const r = await runValidation({ cwd: wt, command: 'node -e "console.log(process.cwd(), process.env.CONSOLE_TOKEN ?? \'no-token\')"', timeoutMs: 20_000 });
    delete process.env.CONSOLE_TOKEN;
    expect(r.tail.toLowerCase()).toContain(wt.toLowerCase());
    expect(r.tail).toContain('no-token');
  });
});

describe('crash recovery (SPEC 24 Phase 3)', () => {
  it('after a crash the commits of the closed steps are still there and the ticket resumes from disk', async () => {
    await svc.checklistSet('a', ITEMS);
    await closeUpTo(3);
    // the console dies: everything in memory is gone, a new one starts on the same files
    const reborn = new StepService({
      tickets: new TicketStore(t.repo), project: 'p', worktreeOf: (slug) => (slug === 'a' ? { worktree: wt, branch } : undefined),
      testCommand: () => command, testTimeoutMs: () => timeoutMs, secretPatterns: () => DEFAULT_SECRET_PATTERNS,
      notifyMain: (_s, text) => { messages.push(text); }, changed: () => {},
    });
    expect(commits()).toHaveLength(3);
    expect(new TicketStore(t.repo).progress('a')).toMatchObject({ done: 3, total: 6 });
    expect(await reborn.stepDone('a', { n: 3, note: 'a decent note for this step' })).toMatchObject({ status: 'refused', code: 'out_of_order' });
    expect(await reborn.stepDone('a', { n: 4, note: 'a decent note for this step' })).toMatchObject({ status: 'closed', n: 4 });
    expect(commits()).toHaveLength(4);
  });
  it('a crash between the commit and the ticket update does not make a second commit for the same step', async () => {
    await svc.checklistSet('a', ITEMS);
    await closeUpTo(2);
    const { commitStep } = await import('../src/server/git/commit');
    const made = await commitStep({ worktree: wt, n: 3, total: 6, title: 'Implement a', slug: 'a', project: 'p', secretPatterns: DEFAULT_SECRET_PATTERNS });
    expect(made.ok).toBe(true);
    expect(tickets.progress('a')?.done).toBe(2); // the process died before markDone
    const r = await done(3, { note: 'a decent note for this step' });
    expect(r).toMatchObject({ status: 'closed', n: 3 });
    expect(r.status === 'closed' && r.sha).toBe(made.ok ? made.sha : '');
    expect(commits()).toHaveLength(3);
    expect(tickets.progress('a')?.done).toBe(3);
  });
});

describe('after delivery (Phase 4 statuses)', () => {
  it('step_done and checklist_set are refused while the ticket is in review, approved or merged', async () => {
    await svc.checklistSet('a', ITEMS);
    await closeUpTo(6);
    for (const to of ['in_review', 'approved', 'merged'] as const) {
      tickets.move('a', to);
      expect(refused(await done(6, { note: 'again and again' })), to).toBe('already_delivered');
      expect(await svc.checklistSet('a', ITEMS), to).toMatchObject({ status: 'refused', code: 'already_delivered' });
    }
  });
});

describe('stepClosed (the loop handling learns whether the step was progress)', () => {
  it('says skipped for a skipped step and empty for a commit that changed no file', async () => {
    const closed: { slug: string; skipped: boolean; empty: boolean }[] = [];
    svc = new StepService({
      tickets, project: 'p',
      worktreeOf: (slug) => (slug === 'a' ? { worktree: wt, branch } : undefined),
      testCommand: () => command, testTimeoutMs: () => timeoutMs, secretPatterns: () => DEFAULT_SECRET_PATTERNS,
      notifyMain: () => {}, changed: () => {},
      stepClosed: (slug, o) => { closed.push({ slug, ...o }); },
    });
    await svc.checklistSet('a', ITEMS);
    writeFileSync(join(wt, 'study.md'), 'notes\n');
    expect((await done(1, { note: 'a decent note for this step' })).status).toBe('closed');
    expect((await done(2, { note: 'nothing to write here, a real reason', skip: true })).status).toBe('closed');
    expect((await done(3, { note: 'a decent note for this step' })).status).toBe('closed');
    expect(closed).toEqual([
      { slug: 'a', skipped: false, empty: false },
      { slug: 'a', skipped: true, empty: true },
      { slug: 'a', skipped: false, empty: true },
    ]);
  });
});
