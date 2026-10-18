import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitSync, makeRepo, type TestRepo, removeDir } from './git-helpers';
import { ensureProjectWorktree } from '../src/server/git/merge';
import { installReleaseHook } from '../src/server/git/release-hook';
import { loadBundles } from '../src/server/i18n-bundles';
import { createTranslator } from '../src/shared/i18n';
import { TicketStore } from '../src/server/tickets/store';
import { ReleaseService, type ReleaseDeps } from '../src/server/tickets/release';
import { writeReport } from '../src/server/tickets/report';

vi.setConfig({ testTimeout: 90_000 });

const bundles = loadBundles();
let t: TestRepo;
let tickets: TicketStore;
let svc: ReleaseService;
let command: string;
let main: string[];
let asked: { text: string; payload: any; answer: (a: string) => void }[];

beforeEach(async () => {
  t = makeRepo({ remote: true });
  await installReleaseHook(t.repo);
  tickets = new TicketStore(t.repo);
  command = `node -e "process.exit(require('fs').existsSync('BAD') ? 1 : 0)"`;
  main = []; asked = [];
  svc = buildService();
});
function buildService(extra: Partial<ReleaseDeps> = {}): ReleaseService {
  return new ReleaseService({
    tickets, root: t.repo, project: 'p',
    testCommand: () => command, testTimeoutMs: () => 30_000,
    language: () => ({ lang: 'en', t: createTranslator({ lang: 'en', messages: bundles.get('en') ?? {}, fallback: bundles.get('en') }) }),
    notifyMain: (text) => { main.push(text); },
    askConfirm: (q, onAnswer) => { asked.push({ ...q, answer: onAnswer }); return `q${asked.length}`; },
    ...extra,
  });
}
afterEach(() => removeDir(t.base));

/** What merge_ticket leaves behind: a commit on the project branch and a ticket in `merged`. */
async function mergedTicket(slug: string, file: string, content = `${slug}\n`): Promise<string> {
  const project = await ensureProjectWorktree(t.repo, 'p');
  if (!project.ok) throw new Error(project.code);
  writeFileSync(join(project.path, file), content);
  gitSync(project.path, 'add', '-A');
  gitSync(project.path, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', `ticket ${slug}: work`);
  const sha = gitSync(project.path, 'rev-parse', 'HEAD');
  tickets.setChecklist(slug, [{ n: 1, title: 'Study', done: true, note: `note of ${slug}` }]);
  tickets.setGoal(slug, `Goal of ${slug}`);
  tickets.setTests(slug, { ok: true, command, tail: '', sha, at: 'x' });
  tickets.move(slug, 'delivered', { deliveredSha: sha });
  tickets.move(slug, 'in_review', { reviewer: `review-${slug}` });
  tickets.addVerdict(slug, { pass: true, reviewer: `review-${slug}`, notes: [] });
  tickets.move(slug, 'approved');
  tickets.move(slug, 'merged', { mergedSha: sha });
  writeReport(t.repo, slug, `# ${slug}\n\nreport text of ${slug}\n`);
  return sha;
}
const remoteMain = (): string => gitSync(t.remote, 'rev-parse', 'main');
const localMain = (): string => gitSync(t.repo, 'rev-parse', 'main');
const projectTip = (): string => gitSync(t.repo, 'rev-parse', 'project/p');
const settled = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 50)); await svc.idle(); };

describe('proposeRelease', () => {
  it('has nothing to say when no ticket is merged', async () => {
    expect(await svc.proposeRelease()).toEqual({ status: 'nothing_to_release' });
    expect(asked).toEqual([]);
  });
  it('puts one confirmation in the queue with the tickets, their reports, the files, the verdicts and the test result', async () => {
    await mergedTicket('a-job', 'a.txt');
    await mergedTicket('b-job', 'b.txt');
    const r = await svc.proposeRelease();
    expect(r).toMatchObject({ status: 'asked' });
    expect(asked).toHaveLength(1);
    const p = asked[0]!.payload;
    expect(p).toMatchObject({ project: 'p', branch: 'main', tip: projectTip() });
    expect(p.tickets.map((x: any) => x.slug).sort()).toEqual(['a-job', 'b-job']);
    expect(p.tickets[0]).toMatchObject({ goal: expect.stringContaining('Goal of'), verdicts: [expect.objectContaining({ pass: true })] });
    expect(p.tickets.find((x: any) => x.slug === 'a-job').report).toContain('report text of a-job');
    expect(p.files.map((f: any) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
    expect(p.tests).toMatchObject({ ok: true });
    expect(asked[0]!.text).toMatch(/origin\/main/);
  });
  it('asks only once at a time', async () => {
    await mergedTicket('a-job', 'a.txt');
    const first = await svc.proposeRelease();
    const second = await svc.proposeRelease();
    expect(second).toMatchObject({ status: 'already_asked' });
    expect((second as { id?: string }).id).toBe((first as { id?: string }).id);
    expect(asked).toHaveLength(1);
  });
  it('a request still open answers already_asked with the same id', async () => {
    svc = buildService({ isOpen: () => true });
    await mergedTicket('a-job', 'a.txt');
    const first = await svc.proposeRelease();
    expect(await svc.proposeRelease()).toEqual({ status: 'already_asked', id: (first as { id: string }).id });
    expect(svc.pendingRequest()).toEqual({ id: (first as { id: string }).id });
    expect(asked).toHaveLength(1);
  });
  it('a request that vanished from the queue is asked again', async () => {
    svc = buildService({ isOpen: () => false });
    await mergedTicket('a-job', 'a.txt');
    const first = await svc.proposeRelease();
    expect(first).toMatchObject({ status: 'asked' });
    expect(svc.pendingRequest()).toBeUndefined();
    const second = await svc.proposeRelease();
    expect(second).toMatchObject({ status: 'asked' });
    expect((second as { id: string }).id).not.toBe((first as { id: string }).id);
    expect(asked).toHaveLength(2);
  });
  it('pendingRequest is undefined after reject', async () => {
    svc = buildService({ isOpen: () => true });
    await mergedTicket('a-job', 'a.txt');
    await svc.proposeRelease();
    expect(svc.pendingRequest()).toBeDefined();
    asked[0]!.answer('reject');
    expect(svc.pendingRequest()).toBeUndefined();
  });
  it('reject then propose again opens a new entry', async () => {
    svc = buildService({ isOpen: () => true });
    await mergedTicket('a-job', 'a.txt');
    const first = await svc.proposeRelease();
    asked[0]!.answer('reject');
    const second = await svc.proposeRelease();
    expect(second).toMatchObject({ status: 'asked' });
    expect((second as { id: string }).id).not.toBe((first as { id: string }).id);
    expect(asked).toHaveLength(2);
  });
  it('does not bother the user when the tests of the project branch are red', async () => {
    await mergedTicket('a-job', 'BAD');
    const r = await svc.proposeRelease();
    expect(r).toMatchObject({ status: 'tests_failed' });
    expect(asked).toEqual([]);
  });
});

describe('the user answers', () => {
  it('reject: nothing moves anywhere', async () => {
    await mergedTicket('a-job', 'a.txt');
    const before = { remote: remoteMain(), local: localMain() };
    await svc.proposeRelease();
    asked[0]!.answer('reject');
    await settled();
    expect(remoteMain()).toBe(before.remote);
    expect(localMain()).toBe(before.local);
    expect(tickets.get('a-job')!.status).toBe('merged');
    expect(main.join('\n')).toMatch(/rejected/i);
    expect(await svc.proposeRelease()).toMatchObject({ status: 'asked' }); // a new proposal is possible afterwards
  });
  it('approve: main moves to the project tip locally and on origin, and the tickets are released', async () => {
    await mergedTicket('a-job', 'a.txt');
    await mergedTicket('b-job', 'b.txt');
    const tip = projectTip();
    await svc.proposeRelease();
    asked[0]!.answer('approve');
    await settled();
    expect(localMain()).toBe(tip);
    expect(remoteMain()).toBe(tip);
    expect(tickets.get('a-job')!.status).toBe('released');
    expect(tickets.get('b-job')!.status).toBe('released');
    expect(main.join('\n')).toMatch(/released/i);
    expect(existsSync(join(t.repo, '.git', 'console-hooks', 'release-token'))).toBe(false);
    expect(gitSync(t.repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(await svc.proposeRelease()).toEqual({ status: 'nothing_to_release' });
  });
  it('approve when main moved on its own: a merge commit, and the push still works', async () => {
    await mergedTicket('a-job', 'a.txt');
    writeFileSync(join(t.repo, 'main-only.txt'), 'x');
    gitSync(t.repo, 'add', '-A');
    gitSync(t.repo, 'commit', '-q', '-m', 'work on main');
    await svc.proposeRelease();
    asked[0]!.answer('approve');
    await settled();
    expect(gitSync(t.repo, 'log', '-1', '--format=%P', 'main').split(' ')).toHaveLength(2);
    expect(remoteMain()).toBe(localMain());
    expect(existsSync(join(t.repo, 'a.txt'))).toBe(true);
    expect(tickets.get('a-job')!.status).toBe('released');
  });
  it('a dirty checkout is refused and left exactly as it was', async () => {
    await mergedTicket('a-job', 'a.txt');
    await svc.proposeRelease();
    writeFileSync(join(t.repo, 'README.md'), 'edited by the user\n');
    const before = { remote: remoteMain(), local: localMain() };
    asked[0]!.answer('approve');
    await settled();
    expect(remoteMain()).toBe(before.remote);
    expect(localMain()).toBe(before.local);
    expect(readFileSync(join(t.repo, 'README.md'), 'utf8')).toBe('edited by the user\n');
    expect(tickets.get('a-job')!.status).toBe('merged');
    expect(main.join('\n')).toMatch(/release\.dirty|uncommitted/i);
  });
  it('a checkout that is not on main is refused', async () => {
    await mergedTicket('a-job', 'a.txt');
    await svc.proposeRelease();
    gitSync(t.repo, 'checkout', '-q', '-b', 'something-else');
    asked[0]!.answer('approve');
    await settled();
    expect(remoteMain()).not.toBe(projectTip());
    expect(gitSync(t.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('something-else');
    expect(main.join('\n')).toMatch(/release\.notOnMain|not on main/i);
  });
  it('a project branch that moved after the proposal is not released: the user approved something else', async () => {
    await mergedTicket('a-job', 'a.txt');
    await svc.proposeRelease();
    await mergedTicket('b-job', 'b.txt'); // merged after the proposal
    const before = remoteMain();
    asked[0]!.answer('approve');
    await settled();
    expect(remoteMain()).toBe(before);
    expect(tickets.get('a-job')!.status).toBe('merged');
    expect(main.join('\n')).toMatch(/release\.projectMoved|moved/i);
  });
  it('tests that turn red on main after the merge undo it: main is back, nothing is pushed', async () => {
    await mergedTicket('a-job', 'a.txt');
    writeFileSync(join(t.repo, 'BAD'), 'a file that makes the tests fail once merged\n');
    gitSync(t.repo, 'add', '-A');
    gitSync(t.repo, 'commit', '-q', '-m', 'main carries BAD');
    const mainBefore = localMain();
    const remoteBefore = remoteMain();
    command = `node -e "process.exit(require('fs').existsSync('BAD') && require('fs').existsSync('a.txt') ? 1 : 0)"`;
    await svc.proposeRelease();
    asked[0]!.answer('approve');
    await settled();
    expect(localMain()).toBe(mainBefore);
    expect(remoteMain()).toBe(remoteBefore);
    expect(gitSync(t.repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(tickets.get('a-job')!.status).toBe('merged');
    expect(main.join('\n')).toMatch(/release\.testsFailed|tests/i);
  });
  it('a fast-forward release runs the tests once (at the proposal): the tree on main is the one already tested', async () => {
    await mergedTicket('a-job', 'a.txt');
    const runs = join(t.base, 'runs.log');
    command = `node -e "require('fs').appendFileSync(process.argv[1], 'x')" "${runs.replace(/\\/g, '/')}"`;
    await svc.proposeRelease();
    asked[0]!.answer('approve');
    await settled();
    expect(remoteMain()).toBe(projectTip());
    expect(readFileSync(runs, 'utf8')).toBe('x');
  });
  it('a push that fails keeps the tickets merged, and a later proposal pushes without merging again', async () => {
    await mergedTicket('a-job', 'a.txt');
    await svc.proposeRelease();
    renameSync(t.remote, `${t.remote}.away`);
    asked[0]!.answer('approve');
    await settled();
    expect(tickets.get('a-job')!.status).toBe('merged');
    expect(main.join('\n')).toMatch(/release\.pushFailed|push/i);
    expect(localMain()).toBe(projectTip()); // merged locally
    renameSync(`${t.remote}.away`, t.remote);
    expect(await svc.proposeRelease()).toMatchObject({ status: 'asked' });
    asked[1]!.answer('approve');
    await settled();
    expect(remoteMain()).toBe(projectTip());
    expect(tickets.get('a-job')!.status).toBe('released');
  });
  it('without a remote the release is a local merge, and says so', async () => {
    gitSync(t.repo, 'remote', 'remove', 'origin');
    await mergedTicket('a-job', 'a.txt');
    await svc.proposeRelease();
    asked[0]!.answer('approve');
    await settled();
    expect(localMain()).toBe(projectTip());
    expect(tickets.get('a-job')!.status).toBe('released');
    expect(main.join('\n')).toMatch(/no remote/i);
  });
  it('an answer that is not approve or reject changes nothing', async () => {
    await mergedTicket('a-job', 'a.txt');
    await svc.proposeRelease();
    asked[0]!.answer('maybe');
    await settled();
    expect(tickets.get('a-job')!.status).toBe('merged');
    expect(remoteMain()).not.toBe(projectTip());
  });
});

describe('review findings: release', () => {
  it('edits the user makes while the release tests run are never wiped by the undo (reset --hard)', async () => {
    await mergedTicket('a-job', 'a.txt');
    writeFileSync(join(t.repo, 'notes.txt'), 'original\n');
    gitSync(t.repo, 'add', '-A');
    gitSync(t.repo, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'notes on main'); // main diverged: the release is a merge commit
    // notes.txt exists only on main (not in the console's worktree), so the tests pass at proposal time and edit it, then fail, on main
    command = `node -e "const fs=require('fs'); if (fs.existsSync('notes.txt')) { fs.writeFileSync('notes.txt','edited while the tests ran'); process.exit(1); }"`;
    await svc.proposeRelease();
    asked[0]!.answer('approve');
    await settled();
    expect(readFileSync(join(t.repo, 'notes.txt'), 'utf8')).toBe('edited while the tests ran'); // the user edit survived
    expect(tickets.get('a-job')!.status).toBe('merged');
    expect(main.join('\n')).toMatch(/release\.testsFailed/);
  });
  it('a release of many large reports still shows every ticket, with its files and tests (nothing is silently dropped)', async () => {
    for (let i = 1; i <= 6; i++) {
      await mergedTicket(`job-${i}`, `f${i}.txt`);
      writeReport(t.repo, `job-${i}`, `# job-${i}\n\n${'x'.repeat(30_000)}\n`);
    }
    await svc.proposeRelease();
    const p = asked[0]!.payload;
    expect(JSON.stringify(p).length).toBeLessThan(100_000);
    expect(p.truncated).toBeUndefined();
    expect(p.tickets).toHaveLength(6);
    expect(p.files.length).toBe(6);
    expect(p.tests).toMatchObject({ ok: true });
    expect(p.tickets.every((x: any) => x.report.length > 1000)).toBe(true); // shortened, not removed
  });
  it('tells the user about commits already on local main that the release would publish as well', async () => {
    await mergedTicket('a-job', 'a.txt');
    writeFileSync(join(t.repo, 'mine.txt'), 'x');
    gitSync(t.repo, 'add', '-A');
    gitSync(t.repo, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'my own work on main');
    await svc.proposeRelease();
    const p = asked[0]!.payload;
    expect(p.extraCommits).toBe(1);
    expect(p.files.map((f: any) => f.path).sort()).toEqual(['a.txt', 'mine.txt']);
  });
  it('every merged ticket of the proposal is released, not only the first twenty shown', async () => {
    for (let i = 1; i <= 22; i++) await mergedTicket(`job-${i}`, `f${i}.txt`);
    await svc.proposeRelease();
    asked[0]!.answer('approve');
    await settled();
    expect(tickets.list().filter((x) => x.status === 'released')).toHaveLength(22);
  });
  it('releases the commit that was approved, not whatever the project branch name points to later', async () => {
    await mergedTicket('a-job', 'a.txt');
    await svc.proposeRelease();
    const approved = projectTip();
    asked[0]!.answer('approve');
    await settled();
    expect(remoteMain()).toBe(approved);
  });
});
