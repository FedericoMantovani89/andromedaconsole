import { join } from 'node:path';
import { writeJsonAtomic } from '../fs-atomic';
import { readJsonState, setAside, type StateReport } from '../json-file';
import { attribute, failingTestFiles, type Attribution, type BatchItem } from './attribution';
import type { CentralMark } from './store';
import type { TestJob, TestRun } from './test-queue';

/** The part of a ticket the central run reads. */
export interface CentralTicket { slug: string; status: string; repo?: string; mergedSha?: string; central?: CentralMark }

/** What the central run knows about one repository's last full run on the merged project branch. */
export interface CentralRecord {
  tip: string;
  command: string;
  ok: boolean;
  at: string;
  /** The tickets this run covered (merged since the run before), in merge order. */
  tickets: string[];
  /** Red only: the end of the output, the failing test files, and who was blamed (or why nobody was). */
  tail?: string;
  failing?: string[];
  culprit?: string;
  by?: 'single' | 'files' | 'bisect';
  undecided?: string;
  /** The merge of the last ticket already ran the same command on this tip: no second run. */
  reusedMerge?: true;
}

/** Everything the run needs from git, so the rules can be tested with a fake. `rel` is the repository inside the project folder (`''` = the folder itself). */
export interface CentralGit {
  /** Runs `fn` while nothing else merges into this repository's project worktree. */
  lock<T>(rel: string, fn: () => Promise<T>): Promise<T>;
  /** The tip of the repository's project branch (taken under `lock`). */
  prepare(rel: string): Promise<{ path: string; tip: string } | undefined>;
  /** Runs `fn` on a stable detached checkout of `sha` (a temporary worktree, removed afterwards): merges go on meanwhile. */
  withCheckout<T>(rel: string, sha: string, fn: (dir: string) => Promise<T>): Promise<T | undefined>;
  /** The tickets in the order they were merged. */
  order(rel: string, tickets: CentralTicket[]): Promise<CentralTicket[]>;
  /** The files the ticket's merge commit changed. */
  touched(rel: string, ticket: CentralTicket): Promise<string[]>;
  /** Re-runs only `files` on a temporary checkout of `sha`: green, red, or undefined when it could not be done. */
  rerun(rel: string, sha: string, files: string[], command: string): Promise<boolean | undefined>;
}

export interface CentralDeps {
  root: string;
  project: string;
  /** Told when the record file could not be read and was set aside. */
  report?: StateReport;
  tickets: { list(): CentralTicket[]; setCentral(slug: string, mark: CentralMark): unknown };
  /** The `release` (full) command for a run in `cwd` (the repository's project worktree) of repository `repo`, or none when the tests are off. */
  command(cwd?: string, repo?: string): string | undefined;
  /** The command a merge runs after merging in `cwd`: when it is the release command, the last merge already tested the tip. */
  mergeCommand?(cwd?: string, repo?: string): string | undefined;
  timeoutMs(): number;
  /** How long after a merge the run waits for the next one (the quiet time that makes a batch). */
  settleMs: number;
  /** Merges asked for and not finished: the run does not start while any is on its way. */
  merging(): number;
  git: CentralGit;
  /** Through the machine's test queue. */
  runTests(job: TestJob): Promise<TestRun>;
  authorAlive(slug: string): boolean;
  notifyAuthor(slug: string, text: string): void;
  notifyMain(text: string): void;
  askUser(q: { text: string; options: string[]; payload: unknown }, onAnswer: (answer: string) => void): void;
  changed?(): void;
}

const TAIL_TO_AUTHOR = 1500;

/**
 * The full test run on the merged project branch (SPEC 8.3, 15.5). Tickets are merged with a fast or smoke command; this runs the
 * `release` (full) command on the tip once the merges have settled, so one full run covers several merges and the queue (the
 * machine's one slot) is not asked for it after every merge. The result is kept on the project: which tip, which command, which
 * tickets. When it is red the console works out whose merge broke it (`attribute`) and tells that author, or asks the user.
 * It never changes code.
 */
export class CentralRun {
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly file: string;

  constructor(private readonly d: CentralDeps) {
    this.file = join(d.root, '.andromedaconsole', 'state', 'central-tests.json');
  }

  /** A ticket was merged: the run starts when the merges have settled. */
  merged(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.d.merging() > 0) return this.merged(); // more merges are on their way: they join the same batch
      void this.runNow().catch(() => undefined);
    }, Math.max(this.d.settleMs, 25));
    this.timer.unref?.();
  }

  /** After a console start: merges done before it (or by an earlier version) that no run has covered get one. */
  start(): void {
    if (this.d.tickets.list().some((t) => t.status === 'merged' && !t.central?.checkedTip)) this.merged();
  }

  /** Resolves when the run in progress (if any) is over. */
  idle(): Promise<void> { return this.chain; }

  cancel(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

  /** The last full run on one repository's project branch. */
  record(rel: string): CentralRecord | undefined {
    const all = this.readAll();
    const r = all?.repos?.[rel];
    return r && typeof r.tip === 'string' ? r : undefined;
  }

  /** True when the full command already passed on exactly this tip: the release does not run it again. */
  greenFor(rel: string, tip: string, command: string): boolean {
    const r = this.record(rel);
    return r?.ok === true && r.tip === tip && r.command === command;
  }

  runNow(): Promise<void> {
    const run = this.chain.then(() => this.once(), () => this.once());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private readAll(): { repos?: Record<string, CentralRecord> } | undefined {
    const s = readJsonState(this.file, this.d.report);
    if (s.status !== 'ok') return undefined;
    if (typeof s.value !== 'object' || s.value === null || Array.isArray(s.value)) { setAside(this.file, this.d.report); return undefined; }
    return s.value as { repos?: Record<string, CentralRecord> };
  }

  private save(rel: string, rec: CentralRecord): void {
    const all = this.readAll() ?? {};
    writeJsonAtomic(this.file, { ...all, repos: { ...(all.repos ?? {}), [rel]: rec } });
  }

  private async once(): Promise<void> {
    const groups = new Map<string, CentralTicket[]>();
    for (const t of this.d.tickets.list()) {
      if (t.status !== 'merged' || t.central?.checkedTip) continue;
      groups.set(t.repo ?? '', [...(groups.get(t.repo ?? '') ?? []), t]);
    }
    for (const [rel, batch] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      try { await this.oneRepo(rel, batch); } catch { /* one repository failing to run must not stop the others or the console */ }
    }
  }

  private async oneRepo(rel: string, batch: CentralTicket[]): Promise<void> {
    // The project lock is held only to read the tip: the suite runs on a detached checkout of that commit, so merges are never blocked by it.
    const prep = await this.d.git.lock(rel, () => this.d.git.prepare(rel));
    if (!prep) return;
    // Asked in the repository's project worktree: in a folder of several repositories each one detects its own command.
    const command = this.d.command(prep.path, rel || undefined)?.trim();
    if (!command) return;
    const tip = prep.tip;
    const before = this.record(rel);
    if (before && before.tip === tip && before.command === command) return; // this tip was already checked
    const ordered = await this.d.git.order(rel, batch);
    const rec: CentralRecord = { tip, command, ok: true, at: new Date().toISOString(), tickets: ordered.map((t) => t.slug) };
    const markAll = (): void => { for (const t of ordered) this.d.tickets.setCentral(t.slug, { checkedTip: tip }); };

    // With one test command for every moment, the merge of the last ticket already ran the whole suite on exactly this tip.
    const mergeCommand = this.d.mergeCommand?.(prep.path, rel || undefined)?.trim();
    if (mergeCommand === command && ordered.length > 0 && ordered[ordered.length - 1]!.mergedSha === tip) {
      this.save(rel, { ...rec, reusedMerge: true });
      markAll();
      this.d.changed?.();
      return;
    }

    const run = await this.d.git.withCheckout(rel, tip, (dir) => this.d.runTests({
      cwd: dir, command, timeoutMs: this.d.timeoutMs(), heavy: true, label: `central:${this.d.project}`, owner: `central:${this.d.project}`,
    }));
    if (!run || run.cancelled) return;
    if (run.ok) {
      this.save(rel, rec);
      markAll();
      this.d.changed?.();
      return;
    }
    const failing = failingTestFiles(run.tail);
    const verdict = await this.blame(rel, ordered, failing, command);
    const done: CentralRecord = {
      ...rec, ok: false, tail: run.tail.slice(-TAIL_TO_AUTHOR), failing,
      ...(verdict.kind === 'culprit' ? { culprit: verdict.slug, by: verdict.by } : { undecided: verdict.reason }),
    };
    this.save(rel, done);
    // Every ticket of the batch was handed to someone (its author or the user): none is blamed again by the next run.
    markAll();
    // A break that was already red at the start of this batch (the same failing files as the last red run) is not asked about again.
    const known = verdict.kind === 'undecided' && verdict.reason === 'base_red' && before?.ok === false && before.failing?.join() === failing.join();
    if (!known) this.report(rel, done, verdict, ordered);
    this.d.changed?.();
  }

  private async blame(rel: string, ordered: CentralTicket[], failing: string[], command: string): Promise<Attribution> {
    try {
      const items: BatchItem[] = [];
      for (const t of ordered) items.push({ slug: t.slug, sha: t.mergedSha ?? '', files: await this.d.git.touched(rel, t) });
      if (items.some((i) => i.sha === '')) return { kind: 'undecided', reason: 'cannot_rerun' };
      return await attribute({ failing, batch: items, base: `${items[0]!.sha}^`, rerun: (sha, files) => this.d.git.rerun(rel, sha, files, command) });
    } catch {
      return { kind: 'undecided', reason: 'cannot_rerun' };
    }
  }

  private report(rel: string, rec: CentralRecord, verdict: Attribution, ordered: CentralTicket[]): void {
    const where = `project/${this.d.project}${rel ? ` (${rel})` : ''} at ${rec.tip.slice(0, 7)}`;
    const tests = rec.failing ?? [];
    // `tests` has the shape the queue already shows as "Test output".
    const facts = { tip: rec.tip, command: rec.command, tickets: rec.tickets, failing: tests, tests: { ok: false, tail: rec.tail ?? '' } };
    if (verdict.kind === 'culprit') {
      const slug = verdict.slug;
      this.d.tickets.setCentral(slug, { red: { tip: rec.tip, tests, at: rec.at } });
      const how = verdict.by === 'bisect' ? 'a bisect of the merges' : verdict.by === 'files' ? 'the files it changed' : 'it is the only ticket of the batch';
      const body = [
        `The full test run on ${where} is red and ${how} point to your ticket "${slug}".`,
        tests.length > 0 ? `Failing tests: ${tests.join(', ')}.` : '',
        'End of the output:',
        (rec.tail ?? '').trim().slice(-TAIL_TO_AUTHOR),
      ].filter(Boolean).join('\n');
      this.d.notifyMain(`Full test run on ${where} is red; ticket "${slug}" was blamed (${verdict.by}). ${this.d.authorAlive(slug) ? 'Its author was told.' : 'Its author is gone: a decision is in the user\'s queue.'}`);
      if (this.d.authorAlive(slug)) this.d.notifyAuthor(slug, `Message from the main about your ticket "${slug}": it was merged, but ${body}`);
      else {
        this.d.askUser(
          { text: `The full test run on ${where} is red because of ticket "${slug}" and its author is gone.`, options: ['follow_up', 'leave'], payload: { ticket: slug, reason: 'central_red_author_gone', by: verdict.by, ...facts } },
          (answer) => { if (answer === 'follow_up') this.d.notifyMain(this.followUp(slug, where, body)); },
        );
      }
      return;
    }
    this.d.notifyMain(`Full test run on ${where} is red and the console could not tell which of ${ordered.length} merged tickets broke it (${verdict.reason}): a decision is in the user's queue.`);
    this.d.askUser({ text: `The full test run on ${where} is red and the console could not tell which merged ticket broke it.`, options: ['leave'], payload: { reason: 'central_red_undecided', why: verdict.reason, ...facts } }, () => {});
  }

  /** What the main needs to start a follow-up agent for a ticket whose author is gone: the goal to give it, with the failing tests and the output. */
  private followUp(slug: string, where: string, body: string): string {
    return [
      `The user asked for a follow-up on ticket "${slug}": its author is gone, so start a new agent with a goal like the one below (spawn_agent), then review and merge it as usual.`,
      `Goal: make the full test run on ${where} green again. The merge of ticket "${slug}" broke it. Fix the cause without weakening the tests.`,
      body,
    ].join('\n');
  }
}
