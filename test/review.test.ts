import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitSync, makeRepo, type TestRepo, removeDir } from './git-helpers';
import { createAgentWorktree } from '../src/server/git/worktree';
import { loadBundles } from '../src/server/i18n-bundles';
import { createTranslator } from '../src/shared/i18n';
import { TicketStore } from '../src/server/tickets/store';
import { validateChecklist } from '../src/server/tickets/checklist';
import { ReviewService, reviewerGoal, reviewerSlugFor, type ReviewDeps } from '../src/server/tickets/review';

vi.setConfig({ testTimeout: 60_000 });

const bundles = loadBundles();
let t: TestRepo;
let wt: string;
let branch: string;
let tickets: TicketStore;
let svc: ReviewService;
let command: string;
let spawned: { slug: string; ticket: string; sha: string; goal: string; model?: string }[];
let spawnResult: { ok: true } | { ok: false; code: string; detail?: string };
let main: string[];
let author: { slug: string; text: string }[];
let asked: { text: string; options: string[]; payload: unknown; answer: (a: string) => void }[];
let alive: boolean;
let existing: string[];
let ended: string[];

beforeEach(async () => {
  t = makeRepo({ remote: true });
  const w = await createAgentWorktree({ repo: t.repo, project: 'p', slug: 'a-job' });
  wt = w.path;
  branch = w.branch;
  tickets = new TicketStore(t.repo);
  command = 'node -e "process.exit(0)"';
  spawned = []; main = []; author = []; asked = []; alive = true; existing = ['a-job']; ended = [];
  spawnResult = { ok: true };
  const deps: ReviewDeps = {
    tickets, root: t.repo, project: 'p',
    worktreeOf: (slug) => (slug === 'a-job' ? { worktree: wt, branch } : undefined),
    testCommand: () => command, testTimeoutMs: () => 30_000,
    language: () => ({ lang: 'en', t: createTranslator({ lang: 'en', messages: bundles.get('en') ?? {}, fallback: bundles.get('en') }) }),
    spawnReviewer: async (r) => { spawned.push(r); return spawnResult; },
    existingSlugs: () => existing,
    authorAlive: () => alive,
    notifyMain: (text) => { main.push(text); },
    notifyAuthor: (slug, text) => { author.push({ slug, text }); },
    askUser: (q, answer) => { asked.push({ ...q, answer }); },
    endReviewer: (slug) => { ended.push(slug); },
  };
  svc = new ReviewService(deps);
});
afterEach(() => removeDir(t.base));

function deliver(content = 'x\n', goal = 'Add multiply to src/math.js'): string {
  mkdirSync(join(wt, 'src'), { recursive: true });
  writeFileSync(join(wt, 'src', 'math.js'), content);
  gitSync(wt, 'add', '-A');
  gitSync(wt, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'work');
  const sha = gitSync(wt, 'rev-parse', 'HEAD');
  const existingTicket = tickets.get('a-job');
  const r = validateChecklist(['Study the code', 'Tests first', 'Implement', 'Implement more', 'Validation', 'Update documentation']);
  if (!r.ok) throw new Error(r.code);
  const steps = existingTicket && existingTicket.steps.length > 0 ? existingTicket.steps.map((s) => ({ ...s, done: true })) : r.steps.map((s) => ({ ...s, done: true }));
  tickets.setChecklist('a-job', steps);
  if (!existingTicket?.goal) tickets.setGoal('a-job', goal);
  tickets.move('a-job', 'delivered', { deliveredSha: sha });
  return sha;
}
const NOTES = [{ severity: 'high', where: 'src/math.js:3', text: 'negative input is not handled' }];

describe('reviewerSlugFor', () => {
  it('review-<ticket> first, then -r2, -r3, never longer than 40 characters, never a taken name', () => {
    expect(reviewerSlugFor('fix-login', [])).toBe('review-fix-login');
    expect(reviewerSlugFor('fix-login', ['review-fix-login'])).toBe('review-fix-login-r2');
    expect(reviewerSlugFor('fix-login', ['review-fix-login', 'review-fix-login-r2'])).toBe('review-fix-login-r3');
    const long = 'a'.repeat(40);
    for (const taken of [[], ['review-' + 'a'.repeat(33)]]) {
      const s = reviewerSlugFor(long, taken);
      expect(s.length).toBeLessThanOrEqual(40);
      expect(taken).not.toContain(s);
      expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
  it('a cut in the middle of a dash does not leave a trailing dash', () => {
    expect(reviewerSlugFor('abcdefghijklmnopqrstuvwxyz-abcdefghijk', [])).not.toMatch(/-$/);
  });
});

describe('reviewerGoal', () => {
  it('tells the reviewer what to look at, that it is read-only, how to answer, and the console facts', () => {
    const g = reviewerGoal({ slug: 'a-job', project: 'p', sha: 'abcdef1234567', goal: 'Add multiply', testsOk: true, files: 2, added: 11, removed: 1, reportFile: 'D:/x/report.md', round: 1, previous: [] });
    expect(g).toContain('a-job');
    expect(g).toContain('Add multiply');
    expect(g).toContain('git diff project/p...HEAD');
    expect(g).toContain('abcdef1');
    expect(g).toMatch(/PASSED/);
    expect(g).toContain('D:/x/report.md');
    expect(g).toMatch(/read-only/i);
    expect(g).toContain('mcp__andromeda-mcp__review_verdict');
    expect(g).toMatch(/ToolSearch/);
  });
  it('a second round lists the previous notes to check', () => {
    const g = reviewerGoal({ slug: 'a-job', project: 'p', sha: 'abcdef1', goal: 'g', testsOk: true, files: 1, added: 1, removed: 0, reportFile: 'r', round: 2, previous: [{ round: 1, pass: false, reviewer: 'review-a-job', at: 'x', notes: NOTES }] });
    expect(g).toMatch(/round 2/i);
    expect(g).toContain('negative input is not handled');
  });
});

describe('requestReview', () => {
  it('spawns the reviewer with the console facts and moves the ticket to in_review', async () => {
    const sha = deliver();
    const r = await svc.requestReview('a-job', { model: 'sonnet' });
    expect(r).toEqual({ ok: true, status: 'in_review', reviewer: 'review-a-job', round: 1 });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ slug: 'review-a-job', ticket: 'a-job', sha, model: 'sonnet' });
    expect(spawned[0]!.goal).toContain('Add multiply to src/math.js');
    expect(spawned[0]!.goal).toContain('git diff project/p...HEAD');
    expect(tickets.get('a-job')).toMatchObject({ status: 'in_review', reviewer: 'review-a-job' });
  });
  it('only a delivered ticket can be put into review, and only once', async () => {
    expect(await svc.requestReview('a-job')).toMatchObject({ ok: false, code: 'not_delivered' });
    expect(await svc.requestReview('ghost')).toMatchObject({ ok: false, code: 'not_delivered' });
    deliver();
    const [a, b] = await Promise.all([svc.requestReview('a-job'), svc.requestReview('a-job')]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(spawned).toHaveLength(1);
    expect(await svc.requestReview('a-job')).toMatchObject({ ok: false, code: 'not_delivered' });
  });
  it('a refused spawn leaves the ticket delivered, so it can be tried again', async () => {
    deliver();
    spawnResult = { ok: false, code: 'agent.spawnFailed', detail: 'no room' };
    expect(await svc.requestReview('a-job')).toMatchObject({ ok: false, code: 'spawn_failed' });
    expect(tickets.get('a-job')!.status).toBe('delivered');
    spawnResult = { ok: true };
    expect(await svc.requestReview('a-job')).toMatchObject({ ok: true });
  });
  it('the console\'s report problems are returned as they are (dirty tree, no test command)', async () => {
    deliver();
    writeFileSync(join(wt, 'src', 'math.js'), 'edited after delivery');
    expect(await svc.requestReview('a-job')).toMatchObject({ ok: false, code: 'dirty' });
    expect(spawned).toEqual([]);
    expect(tickets.get('a-job')!.status).toBe('delivered');
  });
  it('red tests on the delivered commit send the ticket back to its author without a reviewer', async () => {
    deliver();
    command = 'node -e "console.log(\'2 failing\'); process.exit(1)"';
    const r = await svc.requestReview('a-job');
    expect(r).toEqual({ ok: true, status: 'sent_back', round: 1 });
    expect(spawned).toEqual([]);
    const tk = tickets.get('a-job')!;
    expect(tk).toMatchObject({ status: 'in_progress', round: 1 });
    expect(tk.verdicts[0]).toMatchObject({ pass: false, reviewer: 'console' });
    expect(author).toHaveLength(1);
    expect(author[0]!.slug).toBe('a-job');
    expect(author[0]!.text).toContain('2 failing');
    expect(main.some((m) => /a-job/.test(m))).toBe(true);
  });
  it('red tests after the allowed rounds go to the user', async () => {
    deliver();
    tickets.setChecklist('a-job', tickets.get('a-job')!.steps);
    for (let round = 1; round <= 2; round++) {
      command = 'node -e "process.exit(1)"';
      await svc.requestReview('a-job');
      expect(tickets.get('a-job')!.round).toBe(round);
      writeFileSync(join(wt, 'src', 'math.js'), `fix ${round}\n`);
      deliver(`fix ${round}\n`);
    }
    command = 'node -e "process.exit(1)"';
    const r = await svc.requestReview('a-job');
    expect(r).toMatchObject({ ok: true, status: 'needs_user' });
    expect(tickets.get('a-job')!.status).toBe('needs_user');
    expect(asked).toHaveLength(1);
  });
  it('the second review gets its own reviewer name and the previous notes', async () => {
    deliver();
    await svc.requestReview('a-job');
    existing.push('review-a-job');
    await svc.reviewVerdict('review-a-job', { pass: false, notes: NOTES });
    deliver('fixed\n');
    const r = await svc.requestReview('a-job');
    expect(r).toMatchObject({ ok: true, reviewer: 'review-a-job-r2', round: 2 });
    expect(spawned[1]!.goal).toMatch(/round 2/i);
    expect(spawned[1]!.goal).toContain('negative input is not handled');
  });
});

describe('reviewVerdict', () => {
  const reviewing = async (): Promise<void> => { deliver(); await svc.requestReview('a-job'); main.length = 0; };

  it('a pass approves the ticket and tells the main what comes next', async () => {
    await reviewing();
    const r = await svc.reviewVerdict('review-a-job', { pass: true, notes: [] });
    expect(r).toEqual({ ok: true, ticket: 'a-job', outcome: 'approved' });
    expect(tickets.get('a-job')!.status).toBe('approved');
    expect(tickets.get('a-job')!.verdicts).toMatchObject([{ round: 1, pass: true, reviewer: 'review-a-job' }]);
    expect(main.join('\n')).toMatch(/PASSED/);
    expect(main.join('\n')).toContain('merge_ticket');
    expect(author).toEqual([]);
  });
  it('a pass may still carry low-severity notes, which are kept', async () => {
    await reviewing();
    const r = await svc.reviewVerdict('review-a-job', { pass: true, notes: [{ severity: 'low', text: 'rename x' }] });
    expect(r).toMatchObject({ ok: true, outcome: 'approved' });
    expect(tickets.get('a-job')!.verdicts[0]!.notes).toHaveLength(1);
  });
  it('a failure goes back to the author as a message from the main, with the notes and the reopened steps', async () => {
    await reviewing();
    const r = await svc.reviewVerdict('review-a-job', { pass: false, notes: NOTES });
    expect(r).toEqual({ ok: true, ticket: 'a-job', outcome: 'sent_back', round: 1 });
    const tk = tickets.get('a-job')!;
    expect(tk).toMatchObject({ status: 'in_progress', round: 1 });
    expect(tk.steps.slice(-3).map((s) => s.title)).toEqual(['Review fixes (round 1)', 'Validation (round 1)', 'Update documentation (round 1)']);
    expect(author).toHaveLength(1);
    expect(author[0]!.slug).toBe('a-job');
    expect(author[0]!.text).toMatch(/^Message from the main/);
    expect(author[0]!.text).toContain('negative input is not handled');
    expect(author[0]!.text).toContain('src/math.js:3');
    expect(author[0]!.text).not.toMatch(/reviewer said|review-a-job/i); // P8: the notes come from the main, not from the reviewer
    expect(main.join('\n')).toMatch(/NOT PASSED/);
  });
  it('after two rework rounds the next failure goes to the user instead of the author', async () => {
    await reviewing();
    for (let round = 1; round <= 2; round++) {
      await svc.reviewVerdict(round === 1 ? 'review-a-job' : `review-a-job-r${round}`, { pass: false, notes: NOTES });
      deliver(`fix ${round}\n`);
      existing.push(round === 1 ? 'review-a-job' : `review-a-job-r${round}`);
      await svc.requestReview('a-job');
    }
    const last = tickets.get('a-job')!.reviewer!;
    expect(last).toBe('review-a-job-r3');
    author.length = 0; main.length = 0;
    const r = await svc.reviewVerdict(last, { pass: false, notes: NOTES });
    expect(r).toEqual({ ok: true, ticket: 'a-job', outcome: 'needs_user' });
    expect(tickets.get('a-job')).toMatchObject({ status: 'needs_user', round: 2 });
    expect(author).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.options).toEqual(['send_back', 'approve', 'leave']);
    expect(JSON.stringify(asked[0]!.payload)).toContain('negative input is not handled');
    expect(main.join('\n')).toMatch(/needs the user/i);
  });
  it('the user\'s answer acts on the ticket: send back, approve as it is, or leave it', async () => {
    await reviewing();
    tickets.move('a-job', 'changes_requested');
    tickets.move('a-job', 'needs_user');
    svc.askUserAboutTicket('a-job', 'Tests keep failing');
    expect(asked).toHaveLength(1);
    asked[0]!.answer('leave');
    expect(tickets.get('a-job')!.status).toBe('needs_user');
    asked[0]!.answer('send_back');
    expect(tickets.get('a-job')).toMatchObject({ status: 'in_progress', round: 1 });
    expect(author.at(-1)!.text).toMatch(/^Message from the main/);
    tickets.move('a-job', 'delivered');
    tickets.move('a-job', 'needs_user');
    svc.askUserAboutTicket('a-job', 'again');
    asked[1]!.answer('approve');
    expect(tickets.get('a-job')!.status).toBe('approved');
    expect(main.join('\n')).toMatch(/approved by the user/i);
  });
  it('an author that is gone cannot get the ticket back: the user decides', async () => {
    await reviewing();
    alive = false;
    const r = await svc.reviewVerdict('review-a-job', { pass: false, notes: NOTES });
    expect(r).toMatchObject({ ok: true, outcome: 'needs_user' });
    expect(tickets.get('a-job')!.status).toBe('needs_user');
    expect(author).toEqual([]);
    expect(asked[0]!.payload).toMatchObject({ reason: 'author_gone' });
  });
  it('the reviewer session is ended after its verdict, whatever the outcome, and not after a refused one', async () => {
    await reviewing();
    expect(await svc.reviewVerdict('review-a-job', { pass: false, notes: [] })).toMatchObject({ ok: false });
    expect(ended).toEqual([]);
    await svc.reviewVerdict('review-a-job', { pass: true, notes: [] });
    expect(ended).toEqual(['review-a-job']);
    expect(await svc.reviewVerdict('review-a-job', { pass: true, notes: [] })).toMatchObject({ ok: false });
    expect(ended).toEqual(['review-a-job']);
  });
  it('a verdict is accepted once, and only from the reviewer of a ticket in review', async () => {
    await reviewing();
    expect(await svc.reviewVerdict('some-agent', { pass: true, notes: [] })).toMatchObject({ ok: false, code: 'not_reviewer' });
    expect(await svc.reviewVerdict('a-job', { pass: true, notes: [] })).toMatchObject({ ok: false, code: 'not_reviewer' });
    expect(await svc.reviewVerdict('review-a-job', { pass: true, notes: [] })).toMatchObject({ ok: true });
    expect(await svc.reviewVerdict('review-a-job', { pass: false, notes: NOTES })).toMatchObject({ ok: false, code: 'not_reviewer' });
    expect(tickets.get('a-job')!.verdicts).toHaveLength(1);
  });
  it('two verdicts at the same moment count once', async () => {
    await reviewing();
    const [a, b] = await Promise.all([svc.reviewVerdict('review-a-job', { pass: true, notes: [] }), svc.reviewVerdict('review-a-job', { pass: true, notes: [] })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(tickets.get('a-job')!.verdicts).toHaveLength(1);
  });
  it('validates the body: pass is a boolean, a failure needs at least one note, notes are bounded and normalised', async () => {
    await reviewing();
    expect(await svc.reviewVerdict('review-a-job', {})).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await svc.reviewVerdict('review-a-job', { pass: 'yes', notes: [] })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await svc.reviewVerdict('review-a-job', { pass: true, notes: 'none' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await svc.reviewVerdict('review-a-job', { pass: false, notes: [] })).toMatchObject({ ok: false, code: 'notes_required' });
    expect(await svc.reviewVerdict('review-a-job', { pass: false, notes: [{ severity: 'high' }] })).toMatchObject({ ok: false, code: 'notes_required' });
    expect(tickets.get('a-job')!.status).toBe('in_review'); // nothing was recorded by the refused calls
    const many = Array.from({ length: 80 }, (_, i) => ({ severity: i === 0 ? 'alta' : 'weird', where: 'f'.repeat(500), text: `n${i} ${'x'.repeat(5000)}` }));
    expect(await svc.reviewVerdict('review-a-job', { pass: false, notes: many })).toMatchObject({ ok: true });
    const notes = tickets.get('a-job')!.verdicts[0]!.notes;
    expect(notes).toHaveLength(50);
    expect(notes[0]!.severity).toBe('high'); // the Italian word of the spec is understood
    expect(notes[1]!.severity).toBe('medium'); // unknown severities are not trusted as "low"
    expect(notes[0]!.text.length).toBeLessThanOrEqual(2000);
    expect(notes[0]!.where!.length).toBeLessThanOrEqual(200);
  });
});

describe('abandonReview (the reviewer ended without a verdict)', () => {
  it('puts the ticket back to delivered so the main can ask again, and tells the main', async () => {
    deliver();
    await svc.requestReview('a-job');
    main.length = 0;
    expect(svc.abandonReview('review-a-job')).toBe(true);
    expect(tickets.get('a-job')).toMatchObject({ status: 'delivered' });
    expect(tickets.get('a-job')!.reviewer).toBeUndefined();
    expect(main.join('\n')).toMatch(/ended without a verdict/);
    existing.push('review-a-job'); // the first reviewer's name is taken: the next one gets a new name
    expect(await svc.requestReview('a-job')).toMatchObject({ ok: true, reviewer: 'review-a-job-r2' });
  });
  it('does nothing after a verdict, for a stranger, or twice', async () => {
    deliver();
    await svc.requestReview('a-job');
    expect(svc.abandonReview('nobody')).toBe(false);
    await svc.reviewVerdict('review-a-job', { pass: true, notes: [] });
    expect(svc.abandonReview('review-a-job')).toBe(false);
    expect(tickets.get('a-job')!.status).toBe('approved');
  });
});

describe('sendBack (the main sends a delivered ticket back before any review)', () => {
  it('returns the ticket to its author with the main\'s own note, as a rework round', async () => {
    deliver();
    const r = await svc.sendBack('a-job', 'The diff touches the login page, which this ticket was not about.');
    expect(r).toEqual({ ok: true, status: 'sent_back', round: 1 });
    expect(tickets.get('a-job')).toMatchObject({ status: 'in_progress', round: 1 });
    expect(tickets.get('a-job')!.verdicts[0]).toMatchObject({ pass: false, reviewer: 'main' });
    expect(author[0]!.text).toMatch(/^Message from the main/);
    expect(author[0]!.text).toContain('touches the login page');
    expect(spawned).toEqual([]);
  });
  it('needs a delivered ticket and a note', async () => {
    expect(await svc.sendBack('a-job', 'x')).toMatchObject({ ok: false, code: 'not_delivered' });
    deliver();
    expect(await svc.sendBack('a-job', '   ')).toMatchObject({ ok: false, code: 'notes_required' });
    expect(tickets.get('a-job')!.status).toBe('delivered');
  });
  it('counts toward the two rework rounds', async () => {
    deliver();
    await svc.sendBack('a-job', 'first');
    deliver('x2\n');
    await svc.sendBack('a-job', 'second');
    deliver('x3\n');
    expect(await svc.sendBack('a-job', 'third')).toEqual({ ok: true, status: 'needs_user' });
    expect(tickets.get('a-job')!.status).toBe('needs_user');
  });
});

describe('review findings: rounds', () => {
  it('conflicts and red post-merge tests do not use up the review rounds: only failed reviews count', async () => {
    deliver();
    await svc.requestReview('a-job');
    // two earlier reopenings that were not review failures (a conflict and a merge with red tests)
    const file = join(t.repo, '.andromedaconsole', 'state', 'tickets', 'a-job.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), round: 2 }));
    const r = await svc.reviewVerdict('review-a-job', { pass: false, notes: NOTES });
    expect(r).toMatchObject({ ok: true, outcome: 'sent_back' }); // the first failed review still goes back to the author
    expect(author[0]!.text).toMatch(/failed review 1 of 2/);
  });
  it('the third failed review goes to the user, whatever else happened to the ticket', async () => {
    deliver();
    for (let i = 1; i <= 3; i++) {
      existing.push(`review-a-job${i === 1 ? '' : `-r${i}`}`.replace('review-a-job-r1', 'review-a-job'));
      const rq = await svc.requestReview('a-job');
      expect(rq).toMatchObject({ ok: true, status: 'in_review' });
      const v = await svc.reviewVerdict((rq as { reviewer: string }).reviewer, { pass: false, notes: NOTES });
      expect(v).toMatchObject({ ok: true, outcome: i < 3 ? 'sent_back' : 'needs_user' });
      if (i < 3) deliver(`fix ${i}\n`);
    }
  });
});
