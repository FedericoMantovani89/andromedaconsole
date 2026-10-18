import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gitSync, makeMultiRepo, removeDir, type MultiRepo } from './git-helpers';
import { createAgentWorktree } from '../src/server/git/worktree';
import { loadBundles } from '../src/server/i18n-bundles';
import { createTranslator } from '../src/shared/i18n';
import { TicketStore } from '../src/server/tickets/store';
import { validateChecklist } from '../src/server/tickets/checklist';
import { MergeService } from '../src/server/tickets/merge';
import type { AgentGit } from '../src/server/agents/registry';

vi.setConfig({ testTimeout: 90_000 });

const bundles = loadBundles();
let m: MultiRepo;
let tickets: TicketStore;
let svc: MergeService;
let deps: ConstructorParameters<typeof MergeService>[0];
let worktrees: Map<string, AgentGit>;

beforeEach(() => {
  m = makeMultiRepo(['abc-fe', 'abc-be']);
  tickets = new TicketStore(m.root); // project state lives in the project folder, which is NOT a repository
  worktrees = new Map();
  deps = {
    tickets, root: m.root, project: 'p',
    worktreeOf: (slug) => worktrees.get(slug),
    testCommand: () => undefined, testTimeoutMs: () => 30_000, squash: () => true,
    language: () => ({ lang: 'en', t: createTranslator({ lang: 'en', messages: bundles.get('en') ?? {}, fallback: bundles.get('en') }) }),
    authorAlive: () => true,
    notifyMain: () => {}, notifyAuthor: () => {}, needsUser: () => {},
    finishAgent: async () => {},
  };
  svc = new MergeService(deps);
});
afterEach(() => removeDir(m.base));

/** An approved ticket in one of the repos: a worktree with one commit of work, review passed. */
async function approvedTicket(slug: string, repoName: string, files: Record<string, string>): Promise<{ wt: string; branch: string }> {
  const repo = m.repos[repoName]!.repo;
  const w = await createAgentWorktree({ repo, project: 'p', slug });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(w.path, name, '..'), { recursive: true });
    writeFileSync(join(w.path, name), content);
  }
  gitSync(w.path, 'add', '-A');
  gitSync(w.path, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', `step 3/6: ${slug}`);
  const sha = gitSync(w.path, 'rev-parse', 'HEAD');
  const r = validateChecklist(['Study the code', 'Tests first', 'Implement', 'Implement more', 'Validation', 'Update documentation']);
  if (!r.ok) throw new Error(r.code);
  tickets.setChecklist(slug, r.steps.map((s) => ({ ...s, done: true, note: s.n === 1 ? 'found the code' : undefined })));
  tickets.setGoal(slug, `Work of ${slug}`);
  tickets.setRepo(slug, repoName);
  tickets.setTests(slug, { ok: true, command: 'x', tail: '', sha, at: '2026-10-05T10:00:00Z' });
  tickets.move(slug, 'delivered', { deliveredSha: sha });
  tickets.move(slug, 'in_review', { reviewer: `review-${slug}` });
  tickets.addVerdict(slug, { pass: true, reviewer: `review-${slug}`, notes: [] });
  tickets.move(slug, 'approved');
  worktrees.set(slug, { worktree: w.path, branch: w.branch, repo });
  return { wt: w.path, branch: w.branch };
}

it("merges a ticket of abc-fe into abc-fe's project branch, even though the project folder is not a repository", async () => {
  const { wt, branch } = await approvedTicket('fe-job', 'abc-fe', { 'src/a.js': 'a\n' });
  const r = await svc.mergeTicket('fe-job');
  expect(r).toMatchObject({ status: 'merged' });
  const fe = m.repos['abc-fe']!.repo;
  expect(gitSync(fe, 'show', 'project/p:src/a.js')).toBe('a');
  expect(existsSync(wt)).toBe(false); // worktree removed
  expect(gitSync(fe, 'branch', '--list', branch)).toBe(''); // author branch deleted
  expect(gitSync(m.repos['abc-be']!.repo, 'branch', '--list', 'project/p')).toBe(''); // the other repo is untouched
});
it("asks for the test command with the ticket's repository, so its own command (set in the options) runs after the merge", async () => {
  await approvedTicket('fe-job', 'abc-fe', { 'src/a.js': 'a\n' });
  const asked: [string | undefined, string | undefined][] = [];
  const own = new MergeService({ ...deps, testCommand: (cwd, repo) => { asked.push([cwd, repo]); return undefined; } });
  expect(await own.mergeTicket('fe-job')).toMatchObject({ status: 'merged' });
  expect(asked).toHaveLength(1);
  expect(asked[0]![1]).toBe('abc-fe');
});
it('two tickets in two repos merge independently', async () => {
  await approvedTicket('fe-job', 'abc-fe', { 'f.js': 'f\n' });
  await approvedTicket('be-job', 'abc-be', { 'b.js': 'b\n' });
  expect(await svc.mergeTicket('fe-job')).toMatchObject({ status: 'merged' });
  expect(await svc.mergeTicket('be-job')).toMatchObject({ status: 'merged' });
  expect(gitSync(m.repos['abc-be']!.repo, 'show', 'project/p:b.js')).toBe('b');
});
