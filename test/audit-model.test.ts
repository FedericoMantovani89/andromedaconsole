import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitSync, makeRepo, removeDir, type TestRepo } from './git-helpers';
import { until } from './helpers';
import { createAgentWorktree } from '../src/server/git/worktree';
import { loadBundles } from '../src/server/i18n-bundles';
import { createTranslator } from '../src/shared/i18n';
import { TicketStore } from '../src/server/tickets/store';
import { validateChecklist } from '../src/server/tickets/checklist';
import { ReviewService, type ReviewDeps } from '../src/server/tickets/review';
import { AuditService } from '../src/server/audit/service';
import { auditorSlugFor } from '../src/server/audit/service';
import { readAudit } from '../src/server/audit/report';
import type { AuditSettings } from '../src/server/audit/settings';

vi.setConfig({ testTimeout: 60_000 });

const bundles = loadBundles();
const translate = () => createTranslator({ lang: 'en', messages: bundles.get('en') ?? {}, fallback: bundles.get('en') });
let t: TestRepo;
let styleDir: string;
let wt: string;
let branch: string;
let sha: string;
let tickets: TicketStore;
let svc: ReviewService;
let deps: ReviewDeps;
let settings: AuditSettings;
let spawned: { slug: string; ticket: string; sha: string; goal: string; model?: string }[];
let spawnResult: { ok: true } | { ok: false; code: string; detail?: string };
let ended: string[];
let main: string[];
let author: { slug: string; text: string }[];

const lines = (n: number): string => `${Array.from({ length: n }, (_, i) => `line ${i}`).join('\n')}\n`;

beforeEach(async () => {
  t = makeRepo({ remote: true });
  styleDir = mkdtempSync(join(tmpdir(), 'audit-style-'));
  writeFileSync(join(styleDir, 'strict.md'), '---\nname: strict\n---\nPreferisco funzioni piccole. Niente commenti che spiegano il come.');
  const w = await createAgentWorktree({ repo: t.repo, project: 'p', slug: 'a-job' });
  wt = w.path;
  branch = w.branch;
  tickets = new TicketStore(t.repo);
  spawned = []; ended = []; main = []; author = [];
  spawnResult = { ok: true };
  settings = { level: 'full', autoModel: false, profile: 'strict' };
  const language = () => ({ lang: 'en', t: translate() });
  deps = {
    tickets, root: t.repo, project: 'p',
    worktreeOf: (slug) => (slug === 'a-job' ? { worktree: wt, branch } : undefined),
    testCommand: () => 'node -e "process.exit(0)"', testTimeoutMs: () => 30_000, language,
    spawnReviewer: async () => ({ ok: true }),
    existingSlugs: () => ['a-job'],
    authorAlive: () => true,
    notifyMain: (text) => { main.push(text); },
    notifyAuthor: (slug, text) => { author.push({ slug, text }); },
    askUser: () => undefined,
    endReviewer: () => undefined,
    audit: new AuditService({
      root: t.repo, settings: () => settings, userStyleDir: styleDir, testTimeoutMs: () => 30_000, language,
      spawnAuditor: async (r) => { spawned.push(r); return spawnResult; },
      endAuditor: (slug) => { ended.push(slug); },
      notifyMain: (text) => { main.push(text); },
      existingSlugs: () => ['a-job', ...spawned.map((s) => s.slug)],
    }),
  };
  svc = new ReviewService(deps);
  mkdirSync(join(wt, 'src'), { recursive: true });
  writeFileSync(join(wt, 'src', 'work.js'), lines(20));
  gitSync(wt, 'add', '-A');
  gitSync(wt, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'work');
  sha = gitSync(wt, 'rev-parse', 'HEAD');
  const r = validateChecklist(['Study the code', 'Tests first', 'Implement', 'Implement more', 'Validation', 'Update documentation']);
  if (!r.ok) throw new Error(r.code);
  tickets.setChecklist('a-job', r.steps.map((s) => ({ ...s, done: true })));
  tickets.setGoal('a-job', 'Add the work file');
  tickets.move('a-job', 'delivered', { deliveredSha: sha });
});
afterEach(() => removeDir(t.base));

const NOTES = [
  { severity: 'high', where: 'src/work.js:3', problem: 'duplicates format() in src/util.js:7', fix: 'call the existing one' },
  { severity: 'weird', where: 'src/work.js:9', problem: 'a layer nobody asked for', fix: 'inline it' },
];

describe('auditorSlugFor', () => {
  it('audit-<ticket>, then -a2, -a3, never over 40 characters and always a valid slug', () => {
    expect(auditorSlugFor('fix-login', [])).toBe('audit-fix-login');
    expect(auditorSlugFor('fix-login', ['audit-fix-login'])).toBe('audit-fix-login-a2');
    expect(auditorSlugFor('fix-login', ['audit-fix-login', 'audit-fix-login-a2'])).toBe('audit-fix-login-a3');
    const s = auditorSlugFor('a'.repeat(40), ['audit-' + 'a'.repeat(34)]);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe('requestAudit', () => {
  it('starts an auditor whose goal carries the objective, the metrics, the diff command and the conventions as written', async () => {
    const r = await svc.requestAudit('a-job', { model: 'sonnet' });
    expect(r).toEqual({ ok: true, auditor: 'audit-a-job' });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ slug: 'audit-a-job', ticket: 'a-job', sha, model: 'sonnet' });
    const g = spawned[0]!.goal;
    expect(g).toContain('Add the work file');
    expect(g).toContain('git diff project/p...HEAD');
    expect(g).toContain('diff_lines');
    expect(g).toContain('Preferisco funzioni piccole. Niente commenti che spiegano il come.');
    expect(g).toContain('mcp__andromeda-mcp__audit_report');
    expect(g).toMatch(/correctness/i);
    expect(g).toMatch(/function length/i);
    expect(g).toMatch(/language/i);
  });

  it('is refused at level off, for a ticket that is not delivered, and while an auditor already runs for that commit', async () => {
    expect(await svc.requestAudit('ghost')).toMatchObject({ ok: false, code: 'not_delivered' });
    settings = { ...settings, level: 'off' };
    expect(await svc.requestAudit('a-job')).toMatchObject({ ok: false, code: 'level_off' });
    settings = { ...settings, level: 'metrics' };
    expect(await svc.requestAudit('a-job')).toMatchObject({ ok: true }); // on request is allowed below level full
    expect(await svc.requestAudit('a-job')).toMatchObject({ ok: false, code: 'already_running' });
    expect(spawned).toHaveLength(1);
  });

  it('a refused spawn leaves nothing running, so it can be tried again', async () => {
    spawnResult = { ok: false, code: 'agent.spawnFailed', detail: 'no room' };
    expect(await svc.requestAudit('a-job')).toMatchObject({ ok: false, code: 'spawn_failed', detail: 'no room' });
    spawnResult = { ok: true };
    expect(await svc.requestAudit('a-job')).toMatchObject({ ok: true });
  });
});

describe('auditReport', () => {
  beforeEach(async () => { await svc.requestAudit('a-job'); });

  it('merges the notes into the report of that commit, recomputes the verdict, ends the session and tells the main once', async () => {
    const r = await svc.auditReport('audit-a-job', { notes: NOTES });
    expect(r).toEqual({ ok: true, ticket: 'a-job', verdict: 'needs_changes' });
    const stored = readAudit(t.repo, 'a-job', sha)!;
    expect(stored.modelRan).toBe(true);
    expect(stored.verdict).toBe('needs_changes');
    expect(stored.notes).toHaveLength(2);
    expect(stored.notes.every((n) => n.source === 'model')).toBe(true);
    expect(stored.notes[1]!.severity).toBe('medium'); // an unknown word is not trusted as low
    expect(ended).toEqual(['audit-a-job']);
    expect(main.filter((m) => m.includes('needs changes') || m.includes('needs_changes'))).toHaveLength(1);
    expect(main.join('\n')).toMatch(/Report: .*audit-[0-9a-f]{12}\.md/);
  });

  it('never moves the ticket and never writes to its author', async () => {
    await svc.auditReport('audit-a-job', { notes: NOTES });
    expect(tickets.get('a-job')!.status).toBe('delivered');
    expect(author).toHaveLength(0);
  });

  it('only low notes, or none, leave the verdict ready', async () => {
    expect(await svc.auditReport('audit-a-job', { notes: [{ severity: 'low', where: 'a.js:1', problem: 'p', fix: 'f' }] })).toMatchObject({ ok: true, verdict: 'ready' });
  });

  it('an over limit still decides split_first whatever the model says', async () => {
    writeFileSync(join(styleDir, 'tiny.md'), '---\nname: tiny\nlimits:\n  diff_lines: 5\n---\nx');
    settings = { ...settings, profile: 'tiny' };
    await svc.ticketReport('a-job'); // measured again under the stricter profile: 20 lines against a limit of 5
    expect(await svc.auditReport('audit-a-job', { notes: [] })).toMatchObject({ ok: true, verdict: 'split_first' });
  });

  it('accepts a report once, only from an auditor that was started', async () => {
    expect(await svc.auditReport('audit-someone-else', { notes: [] })).toMatchObject({ ok: false, code: 'not_auditor' });
    expect(await svc.auditReport('audit-a-job', { notes: [] })).toMatchObject({ ok: true });
    expect(await svc.auditReport('audit-a-job', { notes: [] })).toMatchObject({ ok: false, code: 'not_auditor' });
  });

  it('a malformed body is refused and the auditor may answer again', async () => {
    expect(await svc.auditReport('audit-a-job', {})).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await svc.auditReport('audit-a-job', { notes: 'text' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await svc.auditReport('audit-a-job', { notes: [{ severity: 'high', problem: '  ' }, 5, null] })).toMatchObject({ ok: true });
    expect(readAudit(t.repo, 'a-job', sha)!.notes).toHaveLength(0); // notes with no problem text are dropped
  });

  it('measuring the same commit again keeps what the model said', async () => {
    await svc.auditReport('audit-a-job', { notes: NOTES });
    await svc.ticketReport('a-job', { rerun: true });
    const stored = readAudit(t.repo, 'a-job', sha)!;
    expect(stored.modelRan).toBe(true);
    expect(stored.notes.filter((n) => n.source === 'model')).toHaveLength(2);
  });

  it('a second audit after a report is allowed: the auditor gets a new name', async () => {
    await svc.auditReport('audit-a-job', { notes: [] });
    expect(await svc.requestAudit('a-job')).toEqual({ ok: true, auditor: 'audit-a-job-a2' });
  });
});

describe('an auditor that ends without a report', () => {
  it('only tells the main: the ticket and the report stay as they were', async () => {
    await svc.requestAudit('a-job');
    expect(svc.abandonAudit('audit-a-job')).toBe(true);
    expect(main.join('\n')).toMatch(/audit-a-job.*without a report/);
    expect(tickets.get('a-job')!.status).toBe('delivered');
    expect(svc.abandonAudit('audit-a-job')).toBe(false);
    expect(svc.abandonAudit('review-a-job')).toBe(false);
    expect(await svc.requestAudit('a-job')).toMatchObject({ ok: true }); // nothing is left running
  });
});

describe('the automatic model part', () => {
  it('starts once per commit when the level is full and autoModel is on', async () => {
    settings = { ...settings, autoModel: true };
    await svc.ticketReport('a-job');
    await until(() => spawned.length === 1);
    await svc.ticketReport('a-job');
    await svc.ticketReport('a-job', { rerun: true });
    expect(spawned).toHaveLength(1);
  });

  it('does not start below level full, or with autoModel off', async () => {
    settings = { ...settings, level: 'metrics', autoModel: true };
    await svc.ticketReport('a-job');
    settings = { ...settings, level: 'full', autoModel: false };
    await svc.ticketReport('a-job', { rerun: true });
    expect(spawned).toHaveLength(0);
  });

  it('does not start again for a commit the model already audited', async () => {
    await svc.requestAudit('a-job');
    await svc.auditReport('audit-a-job', { notes: [] });
    spawned.length = 0;
    settings = { ...settings, autoModel: true };
    await svc.ticketReport('a-job', { rerun: true });
    expect(spawned).toHaveLength(0);
  });
});

describe('requestAudit needs the measures, not the tests', () => {
  it('starts without a test command, and with uncommitted tracked changes in the worktree', async () => {
    svc = new ReviewService({ ...deps, testCommand: () => undefined });
    writeFileSync(join(wt, 'src', 'work.js'), 'edited but not committed\n'); // a tracked file: the full report would refuse as dirty
    expect(await svc.requestAudit('a-job')).toEqual({ ok: true, auditor: 'audit-a-job' });
    expect(readAudit(t.repo, 'a-job', sha)).toBeDefined();
  });

  it('does not run the project tests', async () => {
    const marker = join(t.base, 'tests-ran.txt'); // outside the worktree: the run must not make it dirty
    const script = join(t.base, 'mark.cjs');
    writeFileSync(script, "require('fs').writeFileSync(process.argv[2], 'x');\n");
    svc = new ReviewService({ ...deps, testCommand: () => `node "${script}" "${marker}"` });
    await svc.ticketReport('a-job'); // control: the full report does run the tests, so the marker proves the check below
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    tickets.setTests('a-job', undefined as never); // forget the cached run
    expect(await svc.requestAudit('a-job')).toMatchObject({ ok: true });
    expect(existsSync(marker)).toBe(false);
  });
});

describe('the automatic model part is tried once per commit', () => {
  it('a failed or abandoned auditor is not started again by the next report; an explicit request still works', async () => {
    settings = { ...settings, autoModel: true };
    await svc.ticketReport('a-job');
    await until(() => spawned.length === 1);
    expect(svc.abandonAudit('audit-a-job')).toBe(true);
    await svc.ticketReport('a-job');
    await svc.ticketReport('a-job', { rerun: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(spawned).toHaveLength(1);
    expect(await svc.requestAudit('a-job')).toMatchObject({ ok: true });
    expect(spawned).toHaveLength(2);
  });
});
