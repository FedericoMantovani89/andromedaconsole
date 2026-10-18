import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitSync, makeRepo, type TestRepo, removeDir } from './git-helpers';
import { createAgentWorktree } from '../src/server/git/worktree';
import { loadBundles } from '../src/server/i18n-bundles';
import { createTranslator } from '../src/shared/i18n';
import { TicketStore } from '../src/server/tickets/store';
import { validateChecklist } from '../src/server/tickets/checklist';
import { ReviewService } from '../src/server/tickets/review';
import { reportPath } from '../src/server/tickets/report';

vi.setConfig({ testTimeout: 60_000 });

const bundles = loadBundles();
let t: TestRepo;
let wt: string;
let branch: string;
let tickets: TicketStore;
let svc: ReviewService;
let command: string | undefined;
let off = false; // the project's tests are switched off
let lang = 'en';

const COUNTER = `node -e "const fs=require('fs');const f='runs.txt';fs.appendFileSync(f,'x');"`;

beforeEach(async () => {
  t = makeRepo({ remote: true });
  const w = await createAgentWorktree({ repo: t.repo, project: 'p', slug: 'a-job' });
  wt = w.path;
  branch = w.branch;
  tickets = new TicketStore(t.repo);
  command = 'node -e "process.exit(0)"';
  off = false;
  lang = 'en';
  svc = new ReviewService({
    tickets, root: t.repo, project: 'p',
    worktreeOf: (slug) => (slug === 'a-job' ? { worktree: wt, branch } : undefined),
    testCommand: () => command, testsDisabled: () => off, testTimeoutMs: () => 30_000,
    language: () => ({ lang, t: createTranslator({ lang, messages: bundles.get(lang) ?? {}, fallback: bundles.get('en') }) }),
    spawnReviewer: async () => ({ ok: true }), existingSlugs: () => [], authorAlive: () => true, notifyMain: () => {}, notifyAuthor: () => {}, askUser: () => {}, endReviewer: () => {},
  });
});
afterEach(() => removeDir(t.base));

const commitAll = (msg = 'work'): string => {
  gitSync(wt, 'add', '-A');
  gitSync(wt, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '--allow-empty', '-m', msg);
  return gitSync(wt, 'rev-parse', 'HEAD');
};
/** What the Phase 3 flow leaves behind after the last step: a committed branch and a delivered ticket. */
function deliver(files: Record<string, string | Buffer>, goal = 'Add multiply to src/math.js'): string {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(wt, name, '..'), { recursive: true });
    writeFileSync(join(wt, name), content);
  }
  const sha = commitAll();
  const r = validateChecklist(['Study the code', 'Tests first', 'Implement', 'Implement more', 'Validation', 'Update documentation']);
  if (!r.ok) throw new Error(r.code);
  tickets.setChecklist('a-job', r.steps.map((s) => ({ ...s, done: true, note: s.n === 6 ? 'README updated' : undefined })));
  tickets.setGoal('a-job', goal);
  tickets.move('a-job', 'delivered', { deliveredSha: sha });
  return sha;
}

describe('ticketReport', () => {
  it('reports files from git, reruns the tests on the delivered commit, and writes report.md', async () => {
    const sha = deliver({ 'src/math.js': 'a\nb\nc\n', 'README.md': 'docs\n' });
    const r = await svc.ticketReport('a-job');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.files.map((f) => f.path).sort()).toEqual(['README.md', 'src/math.js']);
    expect(r.facts.files.find((f) => f.path === 'src/math.js')).toMatchObject({ added: 3, removed: 0 });
    expect(r.facts).toMatchObject({ testsOk: true, checklistComplete: true, docsChanged: true, foreignHints: [] });
    expect(tickets.get('a-job')!.tests).toMatchObject({ ok: true, sha, command });
    expect(existsSync(reportPath(t.repo, 'a-job'))).toBe(true);
    const text = readFileSync(reportPath(t.repo, 'a-job'), 'utf8');
    expect(text).toContain('## Objective');
    expect(text).toContain('Add multiply to src/math.js');
    expect(text).toContain('`src/math.js` (+3 -0)');
    expect(r.report).toBe(text);
  });
  it('with the tests switched off nothing is run, the facts and the report say "not run", never passed', async () => {
    deliver({ 'src/a.js': 'x\n' });
    off = true;
    command = 'node -e "process.exit(1)"'; // would be red if it ran
    const r = await svc.ticketReport('a-job');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.testsOk).toBeUndefined();
    expect(r.facts.testsInhibited).toBe(true);
    expect(tickets.get('a-job')!.tests).toBeUndefined();
    const text = readFileSync(reportPath(t.repo, 'a-job'), 'utf8');
    expect(text).toMatch(/Not run: the tests are switched off/);
    expect(text).not.toMatch(/passed/);
    command = undefined; // no command is no longer a refusal while they are off
    expect((await svc.ticketReport('a-job')).ok).toBe(true);
  });
  it('red tests are recorded and reported, not a refusal', async () => {
    deliver({ 'src/a.js': 'x\n' });
    command = 'node -e "console.log(\'1 failing\'); process.exit(1)"';
    const r = await svc.ticketReport('a-job');
    expect(r.ok && r.facts.testsOk).toBe(false);
    expect(tickets.get('a-job')!.tests).toMatchObject({ ok: false });
    expect(tickets.get('a-job')!.tests!.tail).toContain('1 failing');
    expect(readFileSync(reportPath(t.repo, 'a-job'), 'utf8')).toMatch(/failed/);
  });
  it('refuses a ticket that is not delivered, has no worktree, or has no test command', async () => {
    expect(await svc.ticketReport('a-job')).toMatchObject({ ok: false, code: 'not_delivered' });
    deliver({ 'src/a.js': 'x\n' });
    expect(await svc.ticketReport('ghost')).toMatchObject({ ok: false, code: 'not_delivered' });
    command = undefined;
    expect(await svc.ticketReport('a-job')).toMatchObject({ ok: false, code: 'no_test_command' });
    command = '  ';
    expect(await svc.ticketReport('a-job')).toMatchObject({ ok: false, code: 'no_test_command' });
  });
  it("asks for the command of the ticket's repository and, with none, names it and where to set one", async () => {
    deliver({ 'src/a.js': 'x\n' });
    tickets.setRepo('a-job', 'abc-fe');
    const asked: [string | undefined, string | undefined][] = [];
    const repoSvc = new ReviewService({
      tickets, root: t.repo, project: 'p', worktreeOf: (slug) => (slug === 'a-job' ? { worktree: wt, branch } : undefined),
      testCommand: (cwd, repo) => { asked.push([cwd, repo]); return undefined; }, testTimeoutMs: () => 1000, language: () => ({ lang, t: (k: string) => k }),
      spawnReviewer: async () => ({ ok: true }), existingSlugs: () => [], authorAlive: () => true, notifyMain: () => {}, notifyAuthor: () => {}, askUser: () => {}, endReviewer: () => {},
    });
    const r = await repoSvc.ticketReport('a-job');
    expect(asked).toEqual([[wt, 'abc-fe']]);
    expect(r).toMatchObject({ ok: false, code: 'no_test_command' });
    expect(!r.ok && r.detail).toContain('test command of the repository abc-fe');
  });
  it('a worktree that is gone is reported as such', async () => {
    deliver({ 'src/a.js': 'x\n' });
    const gone = new ReviewService({ tickets, root: t.repo, project: 'p', worktreeOf: () => undefined, testCommand: () => command, testTimeoutMs: () => 1000, language: () => ({ lang, t: (k: string) => k }), spawnReviewer: async () => ({ ok: true }), existingSlugs: () => [], authorAlive: () => true, notifyMain: () => {}, notifyAuthor: () => {}, askUser: () => {}, endReviewer: () => {} });
    expect(await gone.ticketReport('a-job')).toMatchObject({ ok: false, code: 'no_worktree' });
  });
  it('refuses to run the tests on a dirty worktree or when the branch moved after delivery', async () => {
    deliver({ 'src/a.js': 'x\n' });
    writeFileSync(join(wt, 'src', 'a.js'), 'edited after delivery'); // a tracked file changed after the commit
    expect(await svc.ticketReport('a-job')).toMatchObject({ ok: false, code: 'dirty' });
    gitSync(wt, 'checkout', '--', 'src/a.js');
    commitAll('one more commit after delivery');
    expect(await svc.ticketReport('a-job')).toMatchObject({ ok: false, code: 'head_moved' });
  });
  it('reuses the recorded test result for the same commit, and reruns on request or on a new commit', async () => {
    command = COUNTER;
    deliver({ 'src/a.js': 'x\n' });
    await svc.ticketReport('a-job');
    await svc.ticketReport('a-job');
    expect(readFileSync(join(wt, 'runs.txt'), 'utf8')).toBe('x'); // the second call did not run the tests
    // test artefacts left by the run must not make the next report "dirty"
    await svc.ticketReport('a-job', { rerun: true });
    expect(readFileSync(join(wt, 'runs.txt'), 'utf8')).toBe('xx');
  });
  it('flags files that look foreign to the goal (lock files, build output, logs) unless the goal names them', async () => {
    deliver({ 'src/a.js': 'x\n', 'package-lock.json': '{}\n', 'dist/app.js': 'y\n', 'debug.log': 'z\n' }, 'Add multiply to src/a.js');
    const r = await svc.ticketReport('a-job');
    expect(r.ok && r.facts.foreignHints.sort()).toEqual(['debug.log', 'dist/app.js', 'package-lock.json']);
    const named = await svc.ticketReport('a-job', { rerun: true });
    expect(named.ok).toBe(true);
    tickets.setGoal('a-job', 'Add multiply to src/a.js and update package-lock.json');
    const again = await svc.ticketReport('a-job');
    expect(again.ok && again.facts.foreignHints.sort()).toEqual(['debug.log', 'dist/app.js']);
  });
  it('a binary file is listed without line counts', async () => {
    deliver({ 'assets/logo.png': Buffer.from([0, 1, 2, 0, 255, 0, 3]) });
    const r = await svc.ticketReport('a-job');
    expect(r.ok && r.facts.files.find((f) => f.path === 'assets/logo.png')).toMatchObject({ added: null, removed: null });
  });
  it('headings follow the interface language', async () => {
    deliver({ 'src/a.js': 'x\n' });
    lang = 'it';
    await svc.ticketReport('a-job');
    expect(readFileSync(reportPath(t.repo, 'a-job'), 'utf8')).toContain('## File toccati');
  });
  it('a new delivery after a review round produces a new report on the new commit', async () => {
    const first = deliver({ 'src/a.js': 'x\n' });
    await svc.ticketReport('a-job');
    tickets.move('a-job', 'in_review');
    tickets.move('a-job', 'changes_requested');
    tickets.reopen('a-job');
    writeFileSync(join(wt, 'src', 'a.js'), 'fixed\n');
    const second = commitAll('fix');
    tickets.setChecklist('a-job', tickets.get('a-job')!.steps.map((s) => ({ ...s, done: true })));
    tickets.move('a-job', 'delivered', { deliveredSha: second });
    expect(second).not.toBe(first);
    const r = await svc.ticketReport('a-job');
    expect(r.ok).toBe(true);
    expect(tickets.get('a-job')!.tests!.sha).toBe(second);
    expect(readFileSync(reportPath(t.repo, 'a-job'), 'utf8')).toContain('## Checklist (9/9)');
  });
  it('the facts say when the checklist is not complete', async () => {
    deliver({ 'src/a.js': 'x\n' });
    const steps = tickets.get('a-job')!.steps.map((s) => (s.n === 3 ? { ...s, done: false } : s));
    tickets.setChecklist('a-job', steps);
    const r = await svc.ticketReport('a-job');
    expect(r.ok && r.facts.checklistComplete).toBe(false);
  });
});

import { reviewerGoal } from '../src/server/tickets/review';
it('the reviewer is told the tests were switched off, not that they are unknown or passed', () => {
  const base = { slug: 'a-job', project: 'p', sha: 'abcdef1234', files: 1, added: 2, removed: 0, reportFile: 'r.md', round: 1, previous: [] };
  expect(reviewerGoal({ ...base, testsOk: undefined, testsInhibited: true })).toMatch(/NOT RUN, the project owner switched the tests off/);
  expect(reviewerGoal({ ...base, testsOk: undefined })).toMatch(/: unknown/);
  expect(reviewerGoal({ ...base, testsOk: true })).toMatch(/PASSED/);
});
