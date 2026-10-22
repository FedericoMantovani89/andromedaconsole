import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gitSync, makeMultiRepo, removeDir, type MultiRepo } from './git-helpers';
import { ensureProjectWorktree } from '../src/server/git/merge';
import { loadBundles } from '../src/server/i18n-bundles';
import { createTranslator } from '../src/shared/i18n';
import { TicketStore } from '../src/server/tickets/store';
import { ReleaseService } from '../src/server/tickets/release';
import { writeReport } from '../src/server/tickets/report';

vi.setConfig({ testTimeout: 90_000 });

const bundles = loadBundles();
let m: MultiRepo;
let tickets: TicketStore;
let svc: ReleaseService;
let deps: ConstructorParameters<typeof ReleaseService>[0];
let main: string[];
let asked: { text: string; payload: any; answer: (a: string) => void }[];

beforeEach(async () => {
  m = makeMultiRepo(['abc-fe', 'abc-be'], { remote: true });
  tickets = new TicketStore(m.root); // the project folder is NOT a repository
  main = []; asked = [];
  deps = {
    tickets, root: m.root, project: 'p',
    testCommand: () => undefined, testTimeoutMs: () => 30_000,
    language: () => ({ lang: 'en', t: createTranslator({ lang: 'en', messages: bundles.get('en') ?? {}, fallback: bundles.get('en') }) }),
    notifyMain: (text) => { main.push(text); },
    askConfirm: (q, onAnswer) => { asked.push({ ...q, answer: onAnswer }); return `q${asked.length}`; },
  };
  svc = new ReleaseService(deps);
});
afterEach(() => removeDir(m.base));

/** What merge_ticket leaves behind in one repo: a commit on its project branch and a ticket in `merged`. */
async function mergedTicket(slug: string, repoName: string): Promise<void> {
  const repo = m.repos[repoName]!.repo;
  const project = await ensureProjectWorktree(repo, 'p');
  if (!project.ok) throw new Error(project.code);
  writeFileSync(join(project.path, `${slug}.txt`), `${slug}\n`);
  gitSync(project.path, 'add', '-A');
  gitSync(project.path, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', `ticket ${slug}: work`);
  const sha = gitSync(project.path, 'rev-parse', 'HEAD');
  tickets.setChecklist(slug, [{ n: 1, title: 'Study', done: true, note: `note of ${slug}` }]);
  tickets.setGoal(slug, `Goal of ${slug}`);
  tickets.setRepo(slug, repoName);
  tickets.setTests(slug, { ok: true, command: 'x', tail: '', sha, at: 'x' });
  tickets.move(slug, 'delivered', { deliveredSha: sha });
  tickets.move(slug, 'in_review', { reviewer: `review-${slug}` });
  tickets.addVerdict(slug, { pass: true, reviewer: `review-${slug}`, notes: [] });
  tickets.move(slug, 'approved');
  tickets.move(slug, 'merged', { mergedSha: sha });
  writeReport(m.root, slug, `# ${slug}\n\nreport text of ${slug}\n`);
}
const remoteFiles = (name: string): string => gitSync(m.repos[name]!.remote, 'ls-tree', '-r', '--name-only', 'main');
const remoteMain = (name: string): string => gitSync(m.repos[name]!.remote, 'rev-parse', 'main');
const settled = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 50)); await svc.idle(); };

it('asks ONCE for both repos, with every ticket and the repos listed', async () => {
  await mergedTicket('fe-job', 'abc-fe'); await mergedTicket('be-job', 'abc-be');
  expect(await svc.proposeRelease()).toMatchObject({ status: 'asked' });
  expect(asked).toHaveLength(1);
  const p = asked[0]!.payload;
  expect(p.repos.map((r: any) => r.repo).sort()).toEqual(['abc-be', 'abc-fe']);
  expect(p.tickets.map((t: any) => t.slug).sort()).toEqual(['be-job', 'fe-job']);
  expect(p.files.map((f: any) => f.path).sort()).toEqual(['abc-be/be-job.txt', 'abc-fe/fe-job.txt']);
  expect(p.branch).toBe('main');
});
it('asks for the test command with each repository name, so a repository with its own command (set in the options) runs that one', async () => {
  await mergedTicket('fe-job', 'abc-fe'); await mergedTicket('be-job', 'abc-be');
  const repos: (string | undefined)[] = [];
  const own = new ReleaseService({ ...deps, testCommand: (_cwd, repo) => { repos.push(repo); return undefined; } });
  expect(await own.proposeRelease()).toMatchObject({ status: 'asked' });
  expect(repos.sort()).toEqual(['abc-be', 'abc-fe']);
});
it('a repo with no merged work is not in the confirmation', async () => {
  await mergedTicket('fe-job', 'abc-fe');
  await svc.proposeRelease();
  expect(asked[0]!.payload.repos).toEqual([{ repo: 'abc-fe', branch: 'main', tip: expect.any(String) }]);
  expect(asked[0]!.payload.files.map((f: any) => f.path)).toEqual(['abc-fe/fe-job.txt']);
});
it('a second proposal while one is waiting says so, even when started at the same time', async () => {
  await mergedTicket('fe-job', 'abc-fe');
  const [a, b] = await Promise.all([svc.proposeRelease(), svc.proposeRelease()]);
  expect([a.status, b.status].sort()).toEqual(['already_asked', 'asked']);
  expect(asked).toHaveLength(1);
});
it('approve merges and pushes each repo to its own origin/main and releases the tickets', async () => {
  await mergedTicket('fe-job', 'abc-fe'); await mergedTicket('be-job', 'abc-be');
  await svc.proposeRelease(); asked[0]!.answer('approve'); await settled();
  expect(remoteFiles('abc-fe')).toContain('fe-job.txt');
  expect(remoteFiles('abc-be')).toContain('be-job.txt');
  expect(remoteFiles('abc-fe')).not.toContain('be-job.txt');
  expect(tickets.get('fe-job')?.status).toBe('released');
  expect(tickets.get('be-job')?.status).toBe('released');
  expect(main.join('\n')).toContain('in 2 repositories and pushed to origin');
});
it('if one repo fails its pre-checks (dirty), NOTHING is pushed in any repo', async () => {
  await mergedTicket('fe-job', 'abc-fe'); await mergedTicket('be-job', 'abc-be');
  const feBefore = remoteMain('abc-fe');
  await svc.proposeRelease();
  writeFileSync(join(m.repos['abc-be']!.repo, 'README.md'), 'edited\n'); // a tracked file is now dirty
  asked[0]!.answer('approve'); await settled();
  expect(main.join('\n')).toMatch(/\[abc-be\] .*uncommitted changes/);
  expect(remoteMain('abc-fe')).toBe(feBefore);
  expect(tickets.get('fe-job')?.status).toBe('merged');
  expect(tickets.get('be-job')?.status).toBe('merged');
});
it('if the push of the second repo fails, the report says what was released and what was not', async () => {
  // Repos go in name order: abc-be first, then abc-fe, whose origin is made unreachable.
  await mergedTicket('fe-job', 'abc-fe'); await mergedTicket('be-job', 'abc-be');
  await svc.proposeRelease();
  gitSync(m.repos['abc-fe']!.repo, 'remote', 'set-url', 'origin', join(m.base, 'does-not-exist.git'));
  asked[0]!.answer('approve'); await settled();
  expect(tickets.get('be-job')?.status).toBe('released');
  expect(tickets.get('fe-job')?.status).toBe('merged');
  const text = main.join('\n');
  expect(text).toMatch(/release\.pushFailed/);
  expect(text).toContain('Already released: abc-be');
  expect(text).toContain('Not released: abc-fe');
});
