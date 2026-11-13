import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitSync, makeRepo, removeDir, type TestRepo } from './git-helpers';
import { createAgentWorktree } from '../src/server/git/worktree';
import { loadBundles } from '../src/server/i18n-bundles';
import { createTranslator } from '../src/shared/i18n';
import { TicketStore } from '../src/server/tickets/store';
import { validateChecklist } from '../src/server/tickets/checklist';
import { ReviewService, type ReviewDeps } from '../src/server/tickets/review';
import { AuditService } from '../src/server/audit/service';
import { readAudit } from '../src/server/audit/report';
import type { AuditSettings } from '../src/server/audit/settings';

vi.setConfig({ testTimeout: 60_000 });

const bundles = loadBundles();
const translate = () => createTranslator({ lang: 'en', messages: bundles.get('en') ?? {}, fallback: bundles.get('en') });
let t: TestRepo;
let wt: string;
let branch: string;
let tickets: TicketStore;
let svc: ReviewService;
let deps: ReviewDeps;
let settings: AuditSettings;
let spawned: { slug: string; ticket: string; sha: string }[];
let main: string[];
let author: { slug: string; text: string }[];
let asked: { text: string; options: string[]; payload: unknown; answer: (a: string) => void }[];

const lines = (n: number): string => `${Array.from({ length: n }, (_, i) => `line ${i}`).join('\n')}\n`;

beforeEach(async () => {
  t = makeRepo({ remote: true });
  const w = await createAgentWorktree({ repo: t.repo, project: 'p', slug: 'a-job' });
  wt = w.path;
  branch = w.branch;
  tickets = new TicketStore(t.repo);
  spawned = []; main = []; author = []; asked = [];
  settings = { level: 'metrics', autoModel: false, profile: 'default' };
  const language = () => ({ lang: 'en', t: translate() });
  deps = {
    tickets, root: t.repo, project: 'p',
    worktreeOf: (slug) => (slug === 'a-job' ? { worktree: wt, branch } : undefined),
    testCommand: () => 'node -e "process.exit(0)"', testTimeoutMs: () => 30_000, language,
    spawnReviewer: async (r) => { spawned.push(r); return { ok: true }; },
    existingSlugs: () => ['a-job'],
    authorAlive: () => true,
    notifyMain: (text) => { main.push(text); },
    notifyAuthor: (slug, text) => { author.push({ slug, text }); },
    askUser: (q, answer) => { asked.push({ ...q, answer }); },
    endReviewer: () => undefined,
    audit: new AuditService({ root: t.repo, settings: () => settings, testTimeoutMs: () => 30_000, language }),
  };
  svc = new ReviewService(deps);
});
afterEach(() => removeDir(t.base));

function deliver(n: number, file = 'src/work.js'): string {
  mkdirSync(join(wt, 'src'), { recursive: true });
  writeFileSync(join(wt, file), lines(n));
  gitSync(wt, 'add', '-A');
  gitSync(wt, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'work');
  const sha = gitSync(wt, 'rev-parse', 'HEAD');
  const r = validateChecklist(['Study the code', 'Tests first', 'Implement', 'Implement more', 'Validation', 'Update documentation']);
  if (!r.ok) throw new Error(r.code);
  tickets.setChecklist('a-job', r.steps.map((s) => ({ ...s, done: true })));
  tickets.setGoal('a-job', 'Add the work file');
  tickets.move('a-job', 'delivered', { deliveredSha: sha });
  return sha;
}

describe('ticketReport carries the audit', () => {
  it('facts.audit has the verdict and the metrics over their limit, and the readable file is written', async () => {
    const sha = deliver(300);
    const r = await svc.ticketReport('a-job');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.audit).toMatchObject({ verdict: 'split_first', level: 'metrics' });
    expect(r.facts.audit!.over.map((m) => m.id)).toEqual(['diff_lines']);
    expect(r.facts.audit!.over[0]).toMatchObject({ value: 300, limit: 250 });
    expect(r.facts.audit!.file.replace(/\\/g, '/')).toMatch(/tickets\/a-job\/audit-[0-9a-f]{12}\.md$/);
    expect(readAudit(t.repo, 'a-job', sha)).toBeDefined();
  });

  it('has no audit at level off', async () => {
    deliver(300);
    settings = { ...settings, level: 'off' };
    const r = await svc.ticketReport('a-job');
    expect(r.ok && r.facts.audit).toBeFalsy();
  });
});

describe('the gate in requestReview', () => {
  it('a diff over a limit does not start the reviewer: the ticket waits for the user', async () => {
    deliver(300);
    expect(await svc.requestReview('a-job')).toEqual({ ok: true, status: 'needs_user' });
    expect(spawned).toHaveLength(0);
    expect(tickets.get('a-job')!.status).toBe('needs_user');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.options).toEqual(['review_anyway', 'send_back', 'leave']);
    expect(asked[0]!.payload).toMatchObject({ ticket: 'a-job', reason: 'audit_limits' });
    expect(main.join('\n')).toMatch(/split first/i);
    expect(main.join('\n')).toContain('diff_lines');
  });

  it('a diff within the limits goes to review as before', async () => {
    deliver(30);
    expect(await svc.requestReview('a-job')).toMatchObject({ ok: true, status: 'in_review' });
    expect(asked).toHaveLength(0);
  });

  it('"review anyway" returns the ticket to delivered, tells the main, and the next request spawns the reviewer', async () => {
    const sha = deliver(300);
    await svc.requestReview('a-job');
    asked[0]!.answer('review_anyway');
    expect(tickets.get('a-job')).toMatchObject({ status: 'delivered', auditWaived: sha });
    expect(main.join('\n')).toMatch(/request_review/);
    expect(await svc.requestReview('a-job')).toMatchObject({ ok: true, status: 'in_review' });
    expect(spawned).toHaveLength(1);
  });

  it('the waiver belongs to one sha: another delivered commit is gated again', async () => {
    deliver(300);
    tickets.setAuditWaived('a-job', 'f'.repeat(40)); // given for an older delivery
    expect(await svc.requestReview('a-job')).toEqual({ ok: true, status: 'needs_user' });
  });

  it('"send back" reopens the ticket for its author with the numbers in the message', async () => {
    deliver(300);
    await svc.requestReview('a-job');
    asked[0]!.answer('send_back');
    expect(tickets.get('a-job')!.status).toBe('in_progress');
    expect(author).toHaveLength(1);
    expect(author[0]!.text).toContain('diff_lines');
    expect(author[0]!.text).toContain('300');
    expect(author[0]!.text).toContain('250');
    expect(author[0]!.text).toMatch(/Review fixes/);
  });

  it('"leave" changes nothing', async () => {
    deliver(300);
    await svc.requestReview('a-job');
    asked[0]!.answer('leave');
    expect(tickets.get('a-job')!.status).toBe('needs_user');
    expect(author).toHaveLength(0);
    expect(spawned).toHaveLength(0);
  });

  it('a ticket started after another is measured on its own work, not on the other agent\'s', async () => {
    deliver(300, 'src/other-agents-work.js'); // the other agent's commit, already on the branch
    const base = gitSync(wt, 'rev-parse', 'HEAD');
    tickets.setBaseSha('a-job', base);
    writeFileSync(join(wt, 'src', 'mine.js'), lines(20));
    gitSync(wt, 'add', '-A');
    gitSync(wt, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'mine');
    const mine = gitSync(wt, 'rev-parse', 'HEAD');
    tickets.move('a-job', 'in_review', { reviewer: 'x' });
    tickets.move('a-job', 'delivered', { deliveredSha: mine });
    const r = await svc.ticketReport('a-job');
    expect(r.ok && r.facts.audit?.verdict).toBe('ready');
    expect(r.ok && r.facts.audit?.over).toEqual([]);
  });
});

describe('an audit that fails never breaks the review flow', () => {
  it('ticketReport and request_review go on without the audit when measuring throws', async () => {
    deliver(30);
    const broken = { measure: async () => { throw new Error('EPERM: the file is locked'); }, wantsAutoModel: () => false, summary: () => undefined } as unknown as AuditService;
    svc = new ReviewService({ ...deps, audit: broken });
    const r = await svc.ticketReport('a-job');
    expect(r.ok).toBe(true);
    expect(r.ok && r.facts.audit).toBeUndefined();
    expect(await svc.requestReview('a-job')).toMatchObject({ ok: true, status: 'in_review' });
  });
});
