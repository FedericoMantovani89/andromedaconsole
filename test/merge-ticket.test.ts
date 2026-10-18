import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { branchesOf, gitSync, makeRepo, type TestRepo, removeDir } from './git-helpers';
import { createAgentWorktree, worktreesDirFor } from '../src/server/git/worktree';
import { loadBundles } from '../src/server/i18n-bundles';
import { createTranslator } from '../src/shared/i18n';
import { TicketStore } from '../src/server/tickets/store';
import { validateChecklist } from '../src/server/tickets/checklist';
import { MergeService } from '../src/server/tickets/merge';
import { projectWorktreePath } from '../src/server/git/merge';

vi.setConfig({ testTimeout: 90_000 });

const bundles = loadBundles();
let t: TestRepo;
let tickets: TicketStore;
let svc: MergeService;
let worktrees: Map<string, { worktree: string; branch: string }>;
let squash: boolean;
let command: string;
let alive: boolean;
let main: string[];
let author: { slug: string; text: string }[];
let needsUser: { slug: string; reason: string }[];
let finished: string[];
let finishFails: boolean;

beforeEach(() => {
  t = makeRepo({ remote: true });
  tickets = new TicketStore(t.repo);
  worktrees = new Map();
  squash = true; alive = true; main = []; author = []; needsUser = []; finished = []; finishFails = false;
  command = `node -e "process.exit(require('fs').existsSync('BAD') ? 1 : 0)"`;
  svc = new MergeService({
    tickets, root: t.repo, project: 'p',
    worktreeOf: (slug) => worktrees.get(slug),
    testCommand: () => command, testTimeoutMs: () => 30_000, squash: () => squash,
    language: () => ({ lang: 'en', t: createTranslator({ lang: 'en', messages: bundles.get('en') ?? {}, fallback: bundles.get('en') }) }),
    authorAlive: () => alive,
    notifyMain: (text) => { main.push(text); },
    notifyAuthor: (slug, text) => { author.push({ slug, text }); },
    needsUser: (slug, reason) => { needsUser.push({ slug, reason }); },
    finishAgent: async (slug) => { if (finishFails) throw new Error('cannot stop'); finished.push(slug); },
  });
});
afterEach(() => removeDir(t.base));

/** An approved ticket: a worktree with one commit of work, tests recorded, review passed. */
async function approvedTicket(slug: string, files: Record<string, string>, goal = `Work of ${slug}`): Promise<{ wt: string; branch: string; sha: string }> {
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
  tickets.setGoal(slug, goal);
  tickets.setTests(slug, { ok: true, command, tail: '', sha, at: '2026-10-05T10:00:00Z' });
  tickets.move(slug, 'delivered', { deliveredSha: sha });
  tickets.move(slug, 'in_review', { reviewer: `review-${slug}` });
  tickets.addVerdict(slug, { pass: true, reviewer: `review-${slug}`, notes: [] });
  tickets.move(slug, 'approved');
  worktrees.set(slug, { worktree: w.path, branch: w.branch });
  return { wt: w.path, branch: w.branch, sha };
}
const projectCount = (): number => Number(gitSync(t.repo, 'rev-list', '--count', 'project/p'));
const projectTip = (): string => gitSync(t.repo, 'rev-parse', 'project/p');
const projectFile = (path: string): string => gitSync(t.repo, 'show', `project/p:${path}`);

describe('mergeTicket', () => {
  it('squashes the ticket into the project branch as one commit with the console\'s message, then cleans up', async () => {
    const { wt, branch } = await approvedTicket('a-job', { 'src/a.js': 'a\n', 'README.md': 'docs\n' }, 'Add the A module');
    const before = projectCount();
    const r = await svc.mergeTicket('a-job');
    expect(r).toMatchObject({ status: 'merged' });
    expect(projectCount()).toBe(before + 1);
    expect(projectFile('src/a.js')).toBe('a');
    const msg = gitSync(t.repo, 'log', '-1', '--format=%B', 'project/p');
    expect(msg.split('\n')[0]).toBe('ticket a-job: Add the A module');
    expect(msg).toContain('Agent: a-job');
    expect(msg).toContain('Progetto: p');
    expect(msg).toContain('Reviewed-by: review-a-job (round 1)');
    expect(msg).toContain('Tests: passed');
    expect(tickets.get('a-job')).toMatchObject({ status: 'merged', mergedSha: projectTip() });
    // cleanup: session ended, worktree and local branch gone, remote branch kept (it was never pushed in this test: nothing to keep)
    expect(finished).toEqual(['a-job']);
    expect(existsSync(wt)).toBe(false);
    expect(gitSync(t.repo, 'branch', '--list', branch)).toBe('');
    expect(existsSync(join(t.repo, '.git', 'console-hooks', 'a-job'))).toBe(false);
    expect(main.join('\n')).toMatch(/a-job.*merged/i);
  });
  it('keeps the step commits behind a merge commit when the project says squash:false', async () => {
    squash = false;
    await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    const r = await svc.mergeTicket('a-job');
    expect(r).toMatchObject({ status: 'merged' });
    const parents = gitSync(t.repo, 'log', '-1', '--format=%P', 'project/p').split(' ');
    expect(parents).toHaveLength(2);
    expect(gitSync(t.repo, 'log', '--format=%s', 'project/p')).toContain('step 3/6: a-job');
  });
  it('merges in series: the second ticket lands on top of the first', async () => {
    await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    await approvedTicket('b-job', { 'src/b.js': 'b\n' });
    const before = projectCount();
    expect(await svc.mergeTicket('a-job')).toMatchObject({ status: 'merged' });
    expect(await svc.mergeTicket('b-job')).toMatchObject({ status: 'merged' });
    expect(projectCount()).toBe(before + 2);
    expect(projectFile('src/a.js')).toBe('a');
    expect(projectFile('src/b.js')).toBe('b');
  });
  it('two merges asked at the same moment are done one after the other, without a git lock error', async () => {
    await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    await approvedTicket('b-job', { 'src/b.js': 'b\n' });
    const [x, y] = await Promise.all([svc.mergeTicket('a-job'), svc.mergeTicket('b-job')]);
    expect([x.status, y.status]).toEqual(['merged', 'merged']);
  });
  it('a conflict is never forced: the project branch stays where it was and the author gets the files and a ready conflict state', async () => {
    await approvedTicket('a-job', { 'src/shared.js': 'line from a\n' });
    const b = await approvedTicket('b-job', { 'src/shared.js': 'line from b\n' });
    expect(await svc.mergeTicket('a-job')).toMatchObject({ status: 'merged' });
    const tip = projectTip();
    const r = await svc.mergeTicket('b-job');
    expect(r).toEqual({ status: 'conflict', files: ['src/shared.js'] });
    expect(projectTip()).toBe(tip);
    expect(gitSync(projectWorktreePath(t.repo, worktreesDirFor(t.repo, t.repo)), 'status', '--porcelain')).toBe(''); // the console's own worktree is clean again
    expect(tickets.get('b-job')).toMatchObject({ status: 'in_progress', round: 1 });
    expect(tickets.get('b-job')!.steps.at(-3)!.title).toBe('Resolve merge conflicts (round 1)');
    expect(author).toHaveLength(1);
    expect(author[0]!.text).toMatch(/^Message from the main/);
    expect(author[0]!.text).toContain('src/shared.js');
    expect(main.join('\n')).toMatch(/b-job.*conflict/i);
    // the author's worktree is in the middle of the merge with markers in the file: it can fix it with its normal tools
    expect(existsSync(join(b.wt, '.git'))).toBe(true);
    expect(readFileSync(join(b.wt, 'src', 'shared.js'), 'utf8')).toContain('<<<<<<<');
    expect(gitSync(b.wt, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(b.wt)).toBe(true); // not cleaned up: the author is still working
    expect(finished).toEqual(['a-job']);
  });
  it('after the author resolves the conflict and the ticket is approved again, it merges', async () => {
    await approvedTicket('a-job', { 'src/shared.js': 'line from a\n' });
    const b = await approvedTicket('b-job', { 'src/shared.js': 'line from b\n' });
    await svc.mergeTicket('a-job');
    await svc.mergeTicket('b-job');
    writeFileSync(join(b.wt, 'src', 'shared.js'), 'line from a\nline from b\n');
    gitSync(b.wt, 'add', '-A');
    gitSync(b.wt, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'step 7/9: resolve');
    const sha = gitSync(b.wt, 'rev-parse', 'HEAD');
    tickets.setChecklist('b-job', tickets.get('b-job')!.steps.map((s) => ({ ...s, done: true })));
    tickets.setTests('b-job', { ok: true, command, tail: '', sha, at: 'x' });
    tickets.move('b-job', 'delivered', { deliveredSha: sha });
    tickets.move('b-job', 'in_review', { reviewer: 'review-b-job-r2' });
    tickets.addVerdict('b-job', { pass: true, reviewer: 'review-b-job-r2', notes: [] });
    tickets.move('b-job', 'approved');
    expect(await svc.mergeTicket('b-job')).toMatchObject({ status: 'merged' });
    expect(projectFile('src/shared.js')).toBe('line from a\nline from b');
  });
  it('a conflict with a dead author goes to the user instead', async () => {
    await approvedTicket('a-job', { 'src/shared.js': 'line from a\n' });
    await approvedTicket('b-job', { 'src/shared.js': 'line from b\n' });
    await svc.mergeTicket('a-job');
    alive = false;
    expect(await svc.mergeTicket('b-job')).toMatchObject({ status: 'conflict' });
    expect(tickets.get('b-job')!.status).toBe('needs_user');
    expect(needsUser).toEqual([{ slug: 'b-job', reason: 'conflict_author_gone' }]);
    expect(author).toEqual([]);
  });
  it('red tests after the merge undo it: the project branch is back where it was and the ticket returns to its author', async () => {
    await approvedTicket('a-job', { 'src/a.js': 'a\n', BAD: 'breaks the tests when merged\n' });
    const tip = projectTip();
    const r = await svc.mergeTicket('a-job');
    expect(r).toMatchObject({ status: 'tests_failed' });
    expect(projectTip()).toBe(tip);
    expect(gitSync(projectWorktreePath(t.repo, worktreesDirFor(t.repo, t.repo)), 'status', '--porcelain')).toBe('');
    expect(tickets.get('a-job')).toMatchObject({ status: 'in_progress', round: 1 });
    expect(author[0]!.text).toMatch(/tests/i);
    expect(finished).toEqual([]);
  });
  it('only an approved ticket can be merged', async () => {
    expect(await svc.mergeTicket('ghost')).toMatchObject({ status: 'refused', code: 'not_approved' });
    await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    tickets.move('a-job', 'merged');
    expect(await svc.mergeTicket('a-job')).toMatchObject({ status: 'refused', code: 'not_approved' });
  });
  it('a branch that moved after the approval is not merged (what was reviewed is what is merged)', async () => {
    const a = await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    writeFileSync(join(a.wt, 'src', 'sneaky.js'), 'added after the review\n');
    gitSync(a.wt, 'add', '-A');
    gitSync(a.wt, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'late');
    const tip = projectTip();
    expect(await svc.mergeTicket('a-job')).toMatchObject({ status: 'refused', code: 'author_moved' });
    expect(projectTip()).toBe(tip);
    expect(tickets.get('a-job')!.status).toBe('approved');
  });
  it('refuses when the project branch is checked out in the main repository (it cannot be merged into from elsewhere)', async () => {
    await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    gitSync(t.repo, 'checkout', '-q', 'project/p');
    expect(await svc.mergeTicket('a-job')).toMatchObject({ status: 'refused', code: 'project_branch_checked_out' });
    expect(tickets.get('a-job')!.status).toBe('approved');
    gitSync(t.repo, 'checkout', '-q', 'main');
    expect(await svc.mergeTicket('a-job')).toMatchObject({ status: 'merged' });
  });
  it('a merge interrupted by a crash leaves the console worktree in a half state; the next merge starts clean', async () => {
    await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    await approvedTicket('b-job', { 'src/b.js': 'b\n' });
    await svc.mergeTicket('a-job');
    // simulate the crash: a squash staged in the console worktree, never committed
    gitSync(projectWorktreePath(t.repo, worktreesDirFor(t.repo, t.repo)), 'merge', '--squash', '--no-commit', 'agent/p/b-job');
    expect(gitSync(projectWorktreePath(t.repo, worktreesDirFor(t.repo, t.repo)), 'status', '--porcelain')).not.toBe('');
    const tip = projectTip();
    expect(await svc.mergeTicket('b-job')).toMatchObject({ status: 'merged' });
    expect(projectCount()).toBeGreaterThan(Number(gitSync(t.repo, 'rev-list', '--count', tip)));
  });
  it('a cleanup that fails does not undo the merge, and says so', async () => {
    await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    finishFails = true;
    const r = await svc.mergeTicket('a-job');
    expect(r).toMatchObject({ status: 'merged', cleanup: { incomplete: ['session'] } });
    expect(tickets.get('a-job')!.status).toBe('merged');
    expect(main.join('\n')).toMatch(/not cleaned up: .*session/i);
  });
  it('the remote branch of a merged ticket is kept (SPEC 9.7)', async () => {
    const a = await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    gitSync(a.wt, 'push', '-q', 'origin', a.branch);
    await svc.mergeTicket('a-job');
    expect(branchesOf(t.remote)).toContain('agent/p/a-job');
    expect(gitSync(t.repo, 'branch', '--list', 'agent/p/a-job')).toBe('');
  });
  it('a ticket that changes nothing still merges as an empty commit (the history says it was reviewed)', async () => {
    await approvedTicket('a-job', {});
    const before = projectCount();
    expect(await svc.mergeTicket('a-job')).toMatchObject({ status: 'merged' });
    expect(projectCount()).toBe(before + 1);
  });
});

describe('recovery after a crash between the merge commit and the ticket update', () => {
  it('a ticket whose squash commit is already on the project branch is adopted, not merged a second time', async () => {
    await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    const first = await svc.mergeTicket('a-job');
    expect(first).toMatchObject({ status: 'merged' });
    const count = projectCount();
    const sha = projectTip();
    // the process died after the commit and before the ticket moved: put the ticket back to "approved", as the disk would have it
    const file = join(t.repo, '.andromedaconsole', 'state', 'tickets', 'a-job.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...raw, status: 'approved', mergedSha: undefined }));
    // and the author's branch is still there, as it would be
    gitSync(t.repo, 'branch', 'agent/p/a-job', raw.deliveredSha);
    worktrees.set('a-job', { worktree: join(t.base, 'my repo.worktrees', 'a-job'), branch: 'agent/p/a-job' });
    const again = await svc.mergeTicket('a-job');
    expect(again).toMatchObject({ status: 'merged', sha });
    expect(projectCount()).toBe(count); // no second commit
    expect(tickets.get('a-job')).toMatchObject({ status: 'merged', mergedSha: sha });
  });
  it('a ticket whose name is the start of another one\'s is not mistaken for it', async () => {
    await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    await approvedTicket('a-job-two', { 'src/b.js': 'b\n' });
    await svc.mergeTicket('a-job-two');
    const before = projectCount();
    expect(await svc.mergeTicket('a-job')).toMatchObject({ status: 'merged' });
    expect(projectCount()).toBe(before + 1); // a-job really was merged, it was not "already there"
    expect(projectFile('src/a.js')).toBe('a');
  });
});

describe('review findings: merge', () => {
  it('a crash during the post-merge tests does not get adopted as merged: red tests are undone, not accepted', async () => {
    await approvedTicket('a-job', { 'src/a.js': 'a\n', BAD: 'breaks the tests\n' });
    const sha = tickets.get('a-job')!.deliveredSha!;
    const project = await (await import('../src/server/git/merge')).ensureProjectWorktree(t.repo, 'p');
    if (!project.ok) throw new Error(project.code);
    const { mergeIntoProject } = await import('../src/server/git/merge');
    const tipBefore = projectTip();
    // the process "dies" right after the merge commit: the commit is there, the tests never ran
    expect((await mergeIntoProject({ wt: project.path, sha, message: 'ticket a-job: work\n\nAgent: a-job\nTicket: a-job\nProgetto: p\n', squash: true })).ok).toBe(true);
    const r = await svc.mergeTicket('a-job');
    expect(r).toMatchObject({ status: 'tests_failed' });
    expect(projectTip()).toBe(tipBefore); // the red commit is gone again
    expect(tickets.get('a-job')!.status).toBe('in_progress');
    expect(finished).toEqual([]);
  });
  it('a deleted console worktree folder is created again instead of blocking every merge', async () => {
    await approvedTicket('a-job', { 'src/a.js': 'a\n' });
    await approvedTicket('b-job', { 'src/b.js': 'b\n' });
    await svc.mergeTicket('a-job');
    rmSync(projectWorktreePath(t.repo, worktreesDirFor(t.repo, t.repo)), { recursive: true, force: true }); // somebody cleaned the folder; git still lists it
    expect(await svc.mergeTicket('b-job')).toMatchObject({ status: 'merged' });
    expect(projectFile('src/b.js')).toBe('b');
  });
  it('work that overlaps in time (a merge and a release proposal) is done one after the other', async () => {
    const { withProjectLock } = await import('../src/server/git/merge');
    const order: string[] = [];
    const slow = withProjectLock(t.repo, async () => { order.push('merge:start'); await new Promise((r) => setTimeout(r, 300)); order.push('merge:end'); });
    const quick = withProjectLock(t.repo, async () => { order.push('propose:start'); order.push('propose:end'); });
    await Promise.all([slow, quick]);
    expect(order).toEqual(['merge:start', 'merge:end', 'propose:start', 'propose:end']);
  });
});
