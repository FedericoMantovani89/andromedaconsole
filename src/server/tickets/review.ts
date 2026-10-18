import type { Translate } from '../../shared/i18n';
import { git } from '../git/git';
import { changedFiles } from '../git/merge';
import { buildReport, isDocFile, writeReport, type ChangedFile } from './report';
import type { ReviewNote, Ticket, TicketStore, Verdict } from './store';
import { runDirect, type TicketTestDeps } from './test-queue';
import { KeyedQueue } from '../keyed-queue';
import { noTestCommandDetail } from '../test-commands';

export const MAX_REWORK_ROUNDS = 2;

export interface ReviewDeps extends TicketTestDeps {
  /** The per-ticket queue shared by every ticket service of the project; without it the service has its own. */
  queue?: KeyedQueue;
  tickets: TicketStore;
  /** The project folder (where `.andromedaconsole/` lives). */
  root: string;
  /** The user switched the tests off for this project: nothing is run and the facts say so. */
  testsDisabled?(): boolean;
  /** The interface language right now and its translator (report headings follow it). */
  language(): { lang: string; t: Translate };
  /** Starts the reviewer session through the normal spawn flow (limits, worktree, token). */
  spawnReviewer(r: ReviewerSpawn): Promise<{ ok: true } | { ok: false; code: string; detail?: string }>;
  /** Every agent name already used in the project (reviewer names must be new). */
  existingSlugs(): string[];
  authorAlive(slug: string): boolean;
  notifyMain(text: string): void;
  /** A message to the author's inbox. It is always written as coming from the main (P8). */
  notifyAuthor(slug: string, text: string): void;
  /** Puts a decision in the user's queue (kind `decision`); `onAnswer` runs with the chosen option code. */
  askUser(q: { text: string; options: string[]; payload: unknown }, onAnswer: (answer: string) => void): void;
  /** The reviewer has given its verdict: end its session and remove its checkout. */
  endReviewer(slug: string): void;
}

export interface ReportFacts {
  files: ChangedFile[];
  testsOk: boolean | undefined;
  /** The tests are switched off for this project (then `testsOk` is undefined on purpose). */
  testsInhibited?: true;
  checklistComplete: boolean;
  docsChanged: boolean;
  /** Changed files that look unrelated to the goal (lock files, build output, logs) and are not named in it. */
  foreignHints: string[];
}

export type TicketReportResult =
  | { ok: true; report: string; reportFile: string; facts: ReportFacts }
  | { ok: false; code: 'not_delivered' | 'no_worktree' | 'no_test_command' | 'dirty' | 'head_moved' | 'git_failed'; detail?: string };

export interface ReviewerSpawn { slug: string; ticket: string; sha: string; goal: string; model?: string }

export type RequestReviewResult =
  | { ok: true; status: 'in_review'; reviewer: string; round: number }
  | { ok: true; status: 'sent_back'; round: number }
  | { ok: true; status: 'needs_user' }
  | { ok: false; code: 'spawn_failed' | Extract<TicketReportResult, { ok: false }>['code']; detail?: string };

export type VerdictResult =
  | { ok: true; ticket: string; outcome: 'approved' }
  | { ok: true; ticket: string; outcome: 'sent_back'; round: number }
  | { ok: true; ticket: string; outcome: 'needs_user' }
  | { ok: false; code: 'not_reviewer' | 'bad_request' | 'notes_required'; detail?: string };

const FOREIGN = [/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock)$/, /^(dist|build|out|coverage|node_modules|target|\.venv)\//, /\.(log|tmp|class|pyc|swp)$/];
const REVIEWABLE = ['delivered', 'in_review', 'approved'];
const MAX_NOTES = 50;
const MAX_NOTE_TEXT = 2000;
const MAX_NOTE_WHERE = 200;
const MAX_SLUG = 40;
const SEVERITY: Record<string, 'high' | 'medium' | 'low'> = { high: 'high', alta: 'high', medium: 'medium', media: 'medium', low: 'low', bassa: 'low' };

/** `review-<ticket>`, then `-r2`, `-r3`... when taken; never longer than 40 characters and always a valid slug. */
export function reviewerSlugFor(ticket: string, taken: readonly string[]): string {
  const fit = (base: string, suffix: string): string => `${base.slice(0, MAX_SLUG - suffix.length).replace(/-+$/, '')}${suffix}`;
  const first = fit(`review-${ticket}`, '');
  if (!taken.includes(first)) return first;
  for (let n = 2; ; n++) {
    const candidate = fit(`review-${ticket}`, `-r${n}`);
    if (!taken.includes(candidate)) return candidate;
  }
}

export interface ReviewerGoalInput {
  slug: string; project: string; sha: string; goal?: string; testsOk: boolean | undefined; testsInhibited?: boolean; files: number; added: number; removed: number;
  reportFile: string; round: number; previous: Verdict[];
}

/** What the reviewer is told first (English: it is a prompt, not interface text). */
export function reviewerGoal(i: ReviewerGoalInput): string {
  const lines = [
    `Review the delivered ticket "${i.slug}" of the project "${i.project}" (review round ${i.round}). You are read-only: change nothing, run nothing that writes.`,
    '',
    `Objective the main wrote for the author:\n${i.goal?.trim() ? i.goal.trim() : '(none recorded)'}`,
    '',
    'Facts from the console (not from the author):',
    `- the tests, run by the console on the delivered commit ${i.sha.slice(0, 7)}: ${i.testsInhibited ? 'NOT RUN, the project owner switched the tests off (do not count it against the work, and do not assume they pass)' : i.testsOk === undefined ? 'unknown' : i.testsOk ? 'PASSED' : 'FAILED'}`,
    `- ${i.files} files changed, +${i.added} -${i.removed}`,
    `- the full report is the file ${i.reportFile}`,
    '',
    `How: your folder is a checkout of the delivered commit. See the change with: git diff project/${i.project}...HEAD . Read the surrounding code where you need to.`,
    'Look for defects a user would hit (wrong behaviour, missing cases, crashes, unsafe handling, a test that proves nothing), and for work that does not match the objective or files nobody asked for. Not style.',
  ];
  if (i.previous.length > 0) {
    lines.push('', `This is round ${i.round}: the author already fixed notes from the previous review. Check each of them is really fixed, then look for new problems:`);
    for (const v of i.previous) for (const n of v.notes) lines.push(`- [${n.severity}]${n.where ? ` ${n.where}` : ''}: ${n.text}`);
  }
  lines.push(
    '',
    'When you are done call the tool mcp__console-mod__review_verdict (it is deferred: load it first with ToolSearch, query select:mcp__console-mod__review_verdict) with',
    '{ pass, notes }. pass is false when there is at least one high or medium problem a user would hit; every note has severity (high, medium or low), where (file:line) and text with a concrete failing scenario.',
    'Call it exactly once, then stop.',
  );
  return lines.join('\n');
}

function normalizeNotes(raw: unknown): ReviewNote[] | undefined {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return undefined;
  const notes: ReviewNote[] = [];
  for (const n of raw.slice(0, MAX_NOTES)) {
    if (typeof n !== 'object' || n === null) continue;
    const o = n as Record<string, unknown>;
    if (typeof o.text !== 'string' || o.text.trim() === '') continue;
    const severity = SEVERITY[String(o.severity ?? '').toLowerCase()] ?? 'medium'; // an unknown word is not trusted as "low"
    const where = typeof o.where === 'string' && o.where.trim() !== '' ? o.where.trim().slice(0, MAX_NOTE_WHERE) : undefined;
    notes.push({ severity, ...(where ? { where } : {}), text: o.text.trim().slice(0, MAX_NOTE_TEXT) });
  }
  return notes;
}

const noteLines = (notes: ReviewNote[]): string[] => notes.map((n, i) => `${i + 1}. [${n.severity}]${n.where ? ` ${n.where}` : ''} — ${n.text.replace(/\s+/g, ' ')}`);

/**
 * Facts the main and the reviewer judge a delivered ticket on (SPEC 15.2), the review itself (15.1, 15.3) and the rounds that follow.
 * Everything that changes a ticket happens here, one call at a time per ticket.
 */
export class ReviewService {
  private readonly queue: KeyedQueue;

  constructor(private readonly d: ReviewDeps) { this.queue = d.queue ?? new KeyedQueue(); }

  async ticketReport(slug: string, o: { rerun?: boolean } = {}): Promise<TicketReportResult> {
    const ticket = this.d.tickets.get(slug);
    if (!ticket || !REVIEWABLE.includes(ticket.status) || !ticket.deliveredSha) return { ok: false, code: 'not_delivered' };
    const wt = this.d.worktreeOf(slug);
    if (!wt) return { ok: false, code: 'no_worktree' };
    const sha = ticket.deliveredSha;

    const inhibited = this.d.testsDisabled?.() === true;
    let tests = !inhibited && ticket.tests && ticket.tests.sha === sha && !o.rerun ? ticket.tests : undefined;
    if (!tests && !inhibited) {
      const command = this.d.testCommand(wt.worktree, ticket.repo)?.trim();
      if (!command) return { ok: false, code: 'no_test_command', detail: noTestCommandDetail(ticket.repo) };
      const head = await git(wt.worktree, ['rev-parse', 'HEAD']);
      if (head.code !== 0) return { ok: false, code: 'git_failed', detail: head.stderr.trim() };
      if (head.stdout.trim() !== sha) return { ok: false, code: 'head_moved', detail: `the branch is at ${head.stdout.trim().slice(0, 7)}, delivered ${sha.slice(0, 7)}` };
      // Tracked files only: artefacts of an earlier test run (untracked) must not block the next one.
      const status = await git(wt.worktree, ['status', '--porcelain', '--untracked-files=no']);
      if (status.stdout.trim() !== '') return { ok: false, code: 'dirty', detail: status.stdout.trim().split(/\r?\n/).slice(0, 5).join('; ') };
      const run = await (this.d.runTests ?? runDirect)({ cwd: wt.worktree, command, timeoutMs: this.d.testTimeoutMs(), owner: slug });
      tests = { ok: run.ok, command, tail: run.tail, sha, at: new Date().toISOString() };
      this.d.tickets.setTests(slug, tests);
    }

    const files = await changedFiles(wt.worktree, `project/${this.d.project}`, sha);
    if (!files) return { ok: false, code: 'git_failed', detail: 'could not list the changed files' };
    const goal = ticket.goal ?? '';
    const foreignHints = files.map((f) => f.path).filter((p) => FOREIGN.some((re) => re.test(p)) && !goal.toLowerCase().includes(p.slice(p.lastIndexOf('/') + 1).toLowerCase()));
    const docsNote = ticket.steps.length > 0 ? ticket.steps[ticket.steps.length - 1]!.note : undefined;
    const { lang, t } = this.d.language();
    const report = buildReport({
      slug, project: this.d.project, branch: wt.branch, goal: ticket.goal, steps: ticket.steps, files, tests, testsInhibited: inhibited, docsNote,
      verdicts: ticket.verdicts, lang, t, generatedAt: new Date().toISOString(),
    });
    const reportFile = writeReport(this.d.root, slug, report);
    return {
      ok: true, report, reportFile,
      facts: {
        files, testsOk: tests?.ok, ...(inhibited ? { testsInhibited: true as const } : {}), checklistComplete: ticket.steps.length > 0 && ticket.steps.every((s) => s.done),
        docsChanged: files.some((f) => isDocFile(f.path)), foreignHints,
      },
    };
  }

  /**
   * Puts a delivered ticket into review: the console's own checks first (a red test run goes straight back to the author), then the
   * reviewer is started. A refused start leaves the ticket delivered, so the main can try again.
   */
  requestReview(slug: string, o: { model?: string } = {}): Promise<RequestReviewResult> {
    return this.queue.run(slug, async () => {
      const ticket = this.d.tickets.get(slug);
      if (!ticket || ticket.status !== 'delivered' || !ticket.deliveredSha) return { ok: false, code: 'not_delivered' };
      const report = await this.ticketReport(slug);
      if (!report.ok) return { ok: false, code: report.code, detail: report.detail };
      const sha = ticket.deliveredSha;
      const tests = this.d.tickets.get(slug)!.tests; // none when the project's tests are switched off
      if (tests && !tests.ok) {
        this.d.tickets.move(slug, 'in_review', { reviewer: 'console' });
        const note: ReviewNote = { severity: 'high', text: `The console ran the tests on your delivered commit ${sha.slice(0, 7)} (${tests.command}) and they fail:\n${tests.tail.trim().slice(-1500)}` };
        const out = this.fail(slug, [note], 'console');
        return out.outcome === 'needs_user' ? { ok: true, status: 'needs_user' } : { ok: true, status: 'sent_back', round: out.round };
      }
      const reviewer = reviewerSlugFor(slug, this.d.existingSlugs());
      const round = ticket.verdicts.length + 1;
      const sum = report.facts.files.reduce((n, f) => ({ a: n.a + (f.added ?? 0), r: n.r + (f.removed ?? 0) }), { a: 0, r: 0 });
      const goal = reviewerGoal({
        slug, project: this.d.project, sha, goal: ticket.goal, testsOk: tests?.ok, testsInhibited: report.facts.testsInhibited === true, files: report.facts.files.length, added: sum.a, removed: sum.r,
        reportFile: report.reportFile.replace(/\\/g, '/'), round, previous: ticket.verdicts,
      });
      const started = await this.d.spawnReviewer({ slug: reviewer, ticket: slug, sha, goal, model: o.model });
      if (!started.ok) return { ok: false, code: 'spawn_failed', detail: started.detail ?? started.code };
      this.d.tickets.move(slug, 'in_review', { reviewer });
      return { ok: true, status: 'in_review', reviewer, round };
    });
  }

  /** The reviewer's process ended without a verdict: the ticket is delivered again and the main is told. True when something changed. */
  abandonReview(reviewer: string): boolean {
    const ticket = this.d.tickets.list().find((t) => t.status === 'in_review' && t.reviewer === reviewer);
    if (!ticket) return false;
    this.d.tickets.move(ticket.slug, 'delivered', { reviewer: undefined });
    this.d.notifyMain(`The reviewer ${reviewer} ended without a verdict, so ticket "${ticket.slug}" is delivered again. Call request_review to start another review.`);
    return true;
  }

  /** The main's own check (SPEC 15.2) found the work does not answer the objective: back to the author, no reviewer needed. */
  sendBack(slug: string, note: string): Promise<{ ok: true; status: 'sent_back'; round: number } | { ok: true; status: 'needs_user' } | { ok: false; code: 'not_delivered' | 'notes_required' }> {
    return this.queue.run(slug, async () => {
      const ticket = this.d.tickets.get(slug);
      if (!ticket || ticket.status !== 'delivered') return { ok: false, code: 'not_delivered' } as const;
      const notes = normalizeNotes([{ severity: 'high', text: note }]) ?? [];
      if (notes.length === 0) return { ok: false, code: 'notes_required' } as const;
      this.d.tickets.move(slug, 'in_review', { reviewer: 'main' });
      const out = this.fail(slug, notes, 'main');
      return out.outcome === 'needs_user' ? ({ ok: true, status: 'needs_user' } as const) : ({ ok: true, status: 'sent_back', round: out.round } as const);
    });
  }

  /** The reviewer's one verdict (SPEC 15.3). Accepted once, from the reviewer of a ticket that is in review. */
  async reviewVerdict(reviewer: string, body: unknown): Promise<VerdictResult> {
    const found = this.d.tickets.list().find((t) => t.status === 'in_review' && t.reviewer === reviewer);
    if (!found) return { ok: false, code: 'not_reviewer' };
    const b = (typeof body === 'object' && body !== null ? body : {}) as { pass?: unknown; notes?: unknown };
    if (typeof b.pass !== 'boolean') return { ok: false, code: 'bad_request', detail: 'pass is required and must be true or false' };
    const notes = normalizeNotes(b.notes);
    if (!notes) return { ok: false, code: 'bad_request', detail: 'notes must be a list of { severity, where, text }' };
    if (!b.pass && notes.length === 0) return { ok: false, code: 'notes_required' };

    return this.queue.run(found.slug, async () => {
      const ticket = this.d.tickets.get(found.slug);
      if (!ticket || ticket.status !== 'in_review' || ticket.reviewer !== reviewer) return { ok: false, code: 'not_reviewer' } as const;
      this.d.endReviewer(reviewer);
      if (b.pass) {
        this.d.tickets.addVerdict(ticket.slug, { pass: true, reviewer, notes });
        this.d.tickets.move(ticket.slug, 'approved');
        this.d.notifyMain(`Review of ticket "${ticket.slug}" (round ${ticket.verdicts.length + 1}): PASSED. Next: call merge_ticket for "${ticket.slug}".`);
        return { ok: true, ticket: ticket.slug, outcome: 'approved' } as const;
      }
      const out = this.fail(ticket.slug, notes, reviewer);
      return out.outcome === 'needs_user'
        ? ({ ok: true, ticket: ticket.slug, outcome: 'needs_user' } as const)
        : ({ ok: true, ticket: ticket.slug, outcome: 'sent_back', round: out.round } as const);
    });
  }

  /** A failed review (by the reviewer or by the console's own test run): back to the author, or to the user when it cannot go back. */
  private fail(slug: string, notes: ReviewNote[], reviewer: string): { outcome: 'sent_back'; round: number } | { outcome: 'needs_user' } {
    const before = this.d.tickets.get(slug)!;
    const round = before.verdicts.length + 1;
    this.d.tickets.addVerdict(slug, { pass: false, reviewer, notes });
    const failedBefore = before.verdicts.filter((v) => !v.pass).length; // conflicts and red merge tests reopen the ticket too, but are not failed reviews
    if (!this.d.authorAlive(slug) || failedBefore >= MAX_REWORK_ROUNDS) {
      const reason = !this.d.authorAlive(slug) ? 'author_gone' : 'rounds_exhausted';
      this.d.tickets.move(slug, 'needs_user');
      this.askUser(slug, reason, notes);
      this.d.notifyMain(`Review of ticket "${slug}" (round ${round}): NOT PASSED, and the ticket needs the user (${reason === 'author_gone' ? 'its author is gone' : `${MAX_REWORK_ROUNDS} rework rounds are used up`}). A decision is in the queue.`);
      return { outcome: 'needs_user' };
    }
    this.d.tickets.move(slug, 'changes_requested');
    const reopened = this.d.tickets.reopen(slug);
    this.d.notifyAuthor(slug, this.authorMessage(slug, reopened.round, notes, failedBefore + 1));
    this.d.notifyMain(`Review of ticket "${slug}" (round ${round}): NOT PASSED. Sent back to its author (rework ${reopened.round} of ${MAX_REWORK_ROUNDS}) with ${notes.length} note(s).`);
    return { outcome: 'sent_back', round: reopened.round };
  }

  private authorMessage(slug: string, round: number, notes: ReviewNote[], failed?: number): string {
    return [
      `Message from the main about your ticket "${slug}": the review of your delivered work found problems (${failed ? `failed review ${failed} of ${MAX_REWORK_ROUNDS}` : `rework round ${round}`}). Fix them; do not argue.`,
      'Notes:',
      ...noteLines(notes),
      `The console reopened your checklist with three new steps ("Review fixes (round ${round})", "Validation (round ${round})", "Update documentation (round ${round})"). Close them in order with step_done as before; the console will deliver the branch again.`,
    ].join('\n');
  }

  /** A ticket the pipeline cannot move on by itself: the user chooses (SPEC 15.1). The answer acts on the ticket. */
  askUserAboutTicket(slug: string, reason: string, notes?: ReviewNote[]): void {
    this.askUser(slug, reason, notes ?? this.d.tickets.get(slug)?.verdicts.at(-1)?.notes ?? []);
  }

  private askUser(slug: string, reason: string, notes: ReviewNote[]): void {
    const ticket = this.d.tickets.get(slug);
    this.d.askUser(
      {
        text: `Ticket "${slug}" needs your decision: ${reason}`,
        options: ['send_back', 'approve', 'leave'],
        payload: { ticket: slug, reason, notes, verdicts: ticket?.verdicts ?? [], tests: ticket?.tests },
      },
      (answer) => this.userDecided(slug, answer),
    );
  }

  private userDecided(slug: string, answer: string): void {
    const ticket = this.d.tickets.get(slug);
    if (!ticket || ticket.status !== 'needs_user') return;
    if (answer === 'approve') {
      this.d.tickets.move(slug, 'approved');
      this.d.notifyMain(`Ticket "${slug}" was approved by the user. Next: call merge_ticket for "${slug}".`);
    } else if (answer === 'send_back') {
      if (!this.d.authorAlive(slug)) {
        this.d.notifyMain(`The user wants ticket "${slug}" sent back, but its author is gone. Tell the user.`);
        return;
      }
      const notes = ticket.verdicts.at(-1)?.notes ?? [];
      const reopened = this.d.tickets.reopen(slug);
      this.d.notifyAuthor(slug, this.authorMessage(slug, reopened.round, notes));
      this.d.notifyMain(`The user sent ticket "${slug}" back to its author (rework ${reopened.round}).`);
    }
  }
}
