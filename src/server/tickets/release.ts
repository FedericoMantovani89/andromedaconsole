import { readFileSync } from 'node:fs';
import type { Translate } from '../../shared/i18n';
import { identityArgs } from '../git/commit';
import { git } from '../git/git';
import { worktreesDirFor } from '../git/worktree';
import { changedFiles, ensureProjectWorktree, withProjectLock } from '../git/merge';
import { withReleaseToken } from '../git/release-hook';
import { repoPathOf } from '../git/repos';
import { reportPath, type ChangedFile } from './report';
import type { Ticket, TicketStore } from './store';
import { runDirect, type TestRunner } from './test-queue';

export interface ReleaseDeps {
  tickets: TicketStore;
  /** The project folder. Where `main` lives when the folder is a repository; a ticket with a `repo` releases that sub-folder's repository instead. */
  root: string;
  project: string;
  testCommand(): string | undefined;
  testTimeoutMs(): number;
  /** Runs a test command through the machine's test queue (default: straight away). */
  runTests?: TestRunner;
  /** The central full run already passed with this command on exactly this tip of this repository (`''` = the project folder). */
  greenFor?(repo: string, tip: string, command: string): boolean;
  language(): { lang: string; t: Translate };
  notifyMain(text: string): void;
  /** Puts the confirmation in the user's queue (kind `confirm`) and returns its id; `onAnswer` runs with "approve" or "reject". */
  askConfirm(q: { text: string; payload: unknown }, onAnswer: (answer: string) => void): string;
  /** Whether the queue still holds this confirmation (default: yes). A request answered or dropped elsewhere must not block a new one. */
  isOpen?(id: string): boolean;
  /** Answers the confirmation in the queue (the same path as the console's own buttons); absent: the dialog answer is not accepted. */
  answer?(id: string, answer: 'approve' | 'reject'): 'ok' | 'unknown' | 'already' | 'invalid';
  /** Whether the main's mod holds a release key, so its dialog answer can reach the console (default: yes). Without it, the queue only. */
  dialogReadable?(): boolean;
  /** A ticket changed status in the background (after the user approved): push the state to the UI. */
  changed?(): void;
}

export type ProposeResult =
  | { status: 'asked'; id: string }
  | { status: 'already_asked'; id: string }
  | { status: 'nothing_to_release' }
  | { status: 'tests_failed'; tail: string }
  | { status: 'refused'; code: 'project_branch_checked_out' | 'git_failed' | 'no_main_branch'; detail?: string };

/** How the release question starts: the mod finds the request id here in the main's AskUserQuestion. Keep in step with mod/hooks/register.js. */
export const RELEASE_QUESTION_RE = /^\[release ([A-Za-z0-9-]{1,64})\] /;
const QUESTION_SLUGS = 10;

/** The one question the main shows with AskUserQuestion, and the console compares word for word: what is released, then the request id. */
export function releaseQuestion(o: { id: string; project: string; targets: string; slugs: string[]; files: number; tests?: { ok: boolean; command: string }; /** A folder of several repositories: their names (`''` = the folder itself). */ repos?: string[] }): string {
  const shown = o.slugs.slice(0, QUESTION_SLUGS).join(', ') + (o.slugs.length > QUESTION_SLUGS ? `, +${o.slugs.length - QUESTION_SLUGS} more` : '');
  const tests = o.tests ? `tests passed (${o.tests.command})` : 'no test command, tests not run';
  const where = o.repos && o.repos.length > 0 ? ` in ${o.repos.length} repositor${o.repos.length === 1 ? 'y' : 'ies'} (${o.repos.map((r) => r || '(project folder)').join(', ')})` : '';
  return `[release ${o.id}] Release project "${o.project}"${where} to origin/${o.targets}: ${o.slugs.length} ticket${o.slugs.length === 1 ? '' : 's'} (${shown}), `
    + `${o.files} file${o.files === 1 ? '' : 's'} changed, ${tests}. Approve?`;
}

/**
 * The message the main gets when a release is asked (or asked again): show this dialog as written, and leave the answer to the console.
 * A main whose mod has no release key cannot pass a dialog answer on, so it is told to send the user to the console queue instead.
 */
function releaseNotice(id: string, question: string, readable: boolean): string {
  if (!readable) {
    return `Release request ${id} is waiting for the user in the console queue. This session cannot pass a dialog answer to the console (its mod has no release key; `
      + 'a restart of the main gets one), so do not show a dialog for it: tell the user to approve or reject it in the console queue. The console tells you the outcome.';
  }
  return `Release request ${id} is waiting for the user. Show it now with AskUserQuestion, exactly as written (one question, nothing reworded): `
    + `question ${JSON.stringify(question)}, header "Release", options in this order "Reject" (nothing is merged or pushed) and "Approve" (merge into main and push to origin), multiSelect false. `
    + 'Do nothing else with the answer: the console reads it from the dialog and acts on it, then tells you the outcome. '
    + 'The user may also answer in the console queue, and the first answer counts. An answer there does not close your dialog: '
    + 'if the user answers the dialog afterwards, the console ignores that answer and tells you so.';
}

/** The queue refuses payloads above 100,000 characters: the reports are shortened to fit, never the tickets or the files. */
const PAYLOAD_BUDGET = 90_000;
const MAX_REPORT_CHARS = 20_000;
const MIN_REPORT_CHARS = 800;
const MAX_TICKETS = 20;

/** One repository of the release: its name (relative to the project folder, `''` for the folder itself), where it lives, the branch it goes to, the approved project branch tip and its merged tickets. */
interface Item { repo: string; path: string; target: string; tip: string; slugs: string[] }
interface Pending { id: string; items: Item[]; /** The exact question the main must show in its AskUserQuestion dialog. */ question?: string }
type Failure = { code: string; text: string };
interface Prepared { item: Item; files: ChangedFile[]; extraCommits: number; tests?: { ok: boolean; command: string; tail: string } }

/**
 * The release to `origin/main` (SPEC 15.5): the console proposes, the user approves once from the queue, and only then the console
 * merges the project branch into the local `main` of the user's checkout, runs the tests, and pushes with a one-time token that the
 * pre-push hook asks for. Whatever goes wrong, the checkout keeps what the user changed in the meantime.
 *
 * A project folder that holds several repositories is released with ONE confirmation for all of them: every repository is checked before
 * anything is merged or pushed (one that fails stops the whole release), then each is merged and pushed in turn.
 */
export class ReleaseService {
  private pending: Pending | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private proposing: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: ReleaseDeps) {}

  /** Resolves when the release being performed (if any) is over. */
  idle(): Promise<void> { return this.inFlight; }

  /** The confirmation waiting for the user, if the queue still holds it. */
  pendingRequest(): { id: string } | undefined {
    if (this.pending && this.d.isOpen && !this.d.isOpen(this.pending.id)) this.pending = undefined;
    return this.pending ? { id: this.pending.id } : undefined;
  }

  proposeRelease(): Promise<ProposeResult> {
    const run = this.proposing.then(() => this.propose(), () => this.propose());
    this.proposing = run.catch(() => undefined);
    return run;
  }

  private async propose(): Promise<ProposeResult> {
    const merged = this.d.tickets.list().filter((t) => t.status === 'merged');
    if (merged.length === 0) return { status: 'nothing_to_release' };
    const waiting = this.pendingRequest();
    if (waiting) {
      // The main asks again because it lost the dialog (a restart, a compacted context): give it the same question back.
      if (this.pending?.question !== undefined) this.d.notifyMain(releaseNotice(waiting.id, this.pending.question, this.readable()));
      return { status: 'already_asked', id: waiting.id };
    }
    const groups = new Map<string, Ticket[]>();
    for (const t of merged) groups.set(t.repo ?? '', [...(groups.get(t.repo ?? '') ?? []), t]);
    const items: Item[] = [];
    const files: ChangedFile[] = [];
    let extraCommits = 0;
    let tests: { ok: boolean; command: string; tail: string } | undefined;
    const named = [...groups.keys()].some((rel) => rel !== '');
    for (const rel of [...groups.keys()].sort()) {
      const path = repoPathOf(this.d.root, rel);
      // The proposal runs the tests in this repository's project worktree, which a merge is using at times: one at a time.
      const one = await withProjectLock(path, () => this.prepare(rel, path, groups.get(rel)!));
      if ('refusal' in one) return one.refusal;
      items.push(one.item);
      files.push(...one.files.map((f) => (rel === '' ? f : { ...f, path: `${rel}/${f.path}` })));
      extraCommits += one.extraCommits;
      if (one.tests) tests = tests ? { ok: tests.ok && one.tests.ok, command: tests.command, tail: tests.tail } : one.tests;
    }
    const slugs = merged.map((t) => t.slug);
    const targets = [...new Set(items.map((i) => i.target))].join(', ');
    const payload = this.payload({
      target: targets, tip: items[0]!.tip, files, extraCommits, tests, shown: merged.slice(0, MAX_TICKETS),
      ...(named ? { repos: items.map((i) => ({ repo: i.repo, branch: i.target, tip: i.tip })) } : {}),
    });
    const id = this.d.askConfirm(
      { text: `Release project "${this.d.project}" (${slugs.length} ticket${slugs.length === 1 ? '' : 's'}) to origin/${targets}?`, payload },
      (answer) => this.answered(answer, { id, items }),
    );
    const question = releaseQuestion({ id, project: this.d.project, targets, slugs, files: files.length, tests, ...(named ? { repos: items.map((i) => i.repo) } : {}) });
    this.pending = { id, items, question };
    this.d.notifyMain(releaseNotice(id, question, this.readable()));
    return { status: 'asked', id };
  }

  private readable(): boolean { return this.d.dialogReadable ? this.d.dialogReadable() : true; }

  /**
   * The user's answer to the main's own release dialog (SPEC 15.5, 20.5), posted by the mod with the release key. It counts only for the
   * request still waiting and only when the dialog showed exactly the question the console wrote; it lands in the queue like a click there,
   * so the first answer, from either place, is the one that counts.
   */
  answerFromDialog(id: string, answer: 'approve' | 'reject', question: string): { status: 'ok' } | { status: 'error'; code: 'unknown_request' } {
    const refused = { status: 'error', code: 'unknown_request' } as const;
    const waiting = this.pendingRequest();
    // The user answered a dialog that no longer counts: the main was told the console reports the outcome, so it is told this too.
    if (!waiting || waiting.id !== id || this.pending?.question === undefined || !this.d.answer) {
      this.d.notifyMain(`Release request ${id}: the answer given in your dialog did not count, because the request is no longer waiting (it was already answered in the console queue, or withdrawn). Do not act on that answer; call propose_release again only if the user still wants a release.`);
      return refused;
    }
    if (question.trim() !== this.pending.question) {
      this.d.notifyMain(`Release request ${id}: the answer given in your dialog did not count, because the dialog's question was not exactly the console's text. The request is still waiting in the console queue. ${releaseNotice(id, this.pending.question, true)}`);
      return refused;
    }
    return this.d.answer(id, answer) === 'ok' ? { status: 'ok' } : refused;
  }

  /** Everything the proposal needs from one repository: its target branch, the project worktree, the tests on it, what would be pushed. */
  private async prepare(rel: string, path: string, tickets: Ticket[]): Promise<{ refusal: ProposeResult } | Prepared> {
    const target = await this.targetBranch(path);
    if (!target) return { refusal: { status: 'refused', code: 'no_main_branch', ...(rel ? { detail: rel } : {}) } };
    const project = await ensureProjectWorktree(path, this.d.project, worktreesDirFor(this.d.root, path));
    if (!project.ok) return { refusal: { status: 'refused', code: project.code, detail: project.detail } };
    const tip = (await git(project.path, ['rev-parse', 'HEAD'])).stdout.trim();

    const command = this.d.testCommand()?.trim();
    let tests: { ok: boolean; command: string; tail: string } | undefined;
    if (command) {
      const reused = this.d.greenFor?.(rel, tip, command) === true;
      const run = reused ? { ok: true, tail: 'already green on this exact tip (central full run)' } : await (this.d.runTests ?? runDirect)({ cwd: project.path, command, timeoutMs: this.d.testTimeoutMs(), owner: `release:${this.d.project}` });
      tests = { ok: run.ok, command, tail: run.tail };
      if (!run.ok) return { refusal: { status: 'tests_failed', tail: run.tail } };
    }
    const { files, extraCommits } = await this.whatWouldBePushed(path, target);
    return { item: { repo: rel, path, target, tip, slugs: tickets.map((t) => t.slug) }, files, extraCommits, ...(tests ? { tests } : {}) };
  }

  /**
   * What the push would publish: the project branch, and also any commit that is on the local main but not on origin yet (the release
   * pushes the whole branch). Compared with `origin/<main>` when there is one.
   */
  private async whatWouldBePushed(repo: string, target: string): Promise<{ files: ChangedFile[]; extraCommits: number }> {
    const hasOrigin = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${target}`])).code === 0;
    const base = hasOrigin ? `origin/${target}` : target;
    const fromProject = (await changedFiles(repo, base, `project/${this.d.project}`)) ?? [];
    const fromMain = hasOrigin ? ((await changedFiles(repo, base, target)) ?? []) : [];
    const byPath = new Map<string, ChangedFile>();
    for (const f of [...fromMain, ...fromProject]) if (!f.path.startsWith('.andromedaconsole/')) byPath.set(f.path, byPath.get(f.path) ?? f);
    const extra = hasOrigin ? Number((await git(repo, ['rev-list', '--count', `origin/${target}..${target}`])).stdout.trim()) : 0;
    return { files: [...byPath.values()], extraCommits: Number.isFinite(extra) ? extra : 0 };
  }

  private payload(o: { target: string; tip: string; files: ChangedFile[]; extraCommits: number; tests?: { ok: boolean; command: string; tail: string }; shown: Ticket[]; repos?: { repo: string; branch: string; tip: string }[] }): unknown {
    let limit = MAX_REPORT_CHARS;
    for (;;) {
      const payload = {
        project: this.d.project, branch: o.target, tip: o.tip, files: o.files, extraCommits: o.extraCommits, tests: o.tests,
        ...(o.repos ? { repos: o.repos } : {}),
        tickets: o.shown.map((t) => this.ticketSummary(t, limit)),
      };
      if (JSON.stringify(payload).length <= PAYLOAD_BUDGET || limit <= MIN_REPORT_CHARS) return payload;
      limit = Math.max(MIN_REPORT_CHARS, Math.floor(limit / 2));
    }
  }

  private ticketSummary(t: Ticket, reportChars: number): unknown {
    let report = '';
    try { report = readFileSync(reportPath(this.d.root, t.slug), 'utf8').slice(0, reportChars); } catch { /* the report is written at merge time; missing means n/a */ }
    return { slug: t.slug, goal: t.goal, mergedSha: t.mergedSha, verdicts: t.verdicts, tests: t.tests ? { ok: t.tests.ok, command: t.tests.command } : undefined, report };
  }

  private answered(answer: string, p: Pending): void {
    if (answer === 'reject') {
      this.pending = undefined;
      this.d.notifyMain(`The user rejected the release of project "${this.d.project}". Nothing was merged or pushed; the tickets stay merged in the project branch.`);
    } else if (answer === 'approve') {
      this.pending = undefined;
      this.inFlight = this.inFlight.then(() => this.perform(p)).catch(() => undefined).finally(() => this.d.changed?.());
    }
  }

  private async targetBranch(repo: string): Promise<string | undefined> {
    for (const name of ['main', 'master']) if ((await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])).code === 0) return name;
    return undefined;
  }

  private refuse(code: string, text: string): void {
    this.d.notifyMain(`Release of project "${this.d.project}" refused (${code}): ${text}`);
  }

  /**
   * Puts the checkout back where it was before our merge, keeping whatever the user edited in the meantime (`reset --keep` refuses to
   * overwrite local changes). False when it could not be undone because of such edits.
   */
  private async undo(repo: string, before: string): Promise<boolean> {
    return (await git(repo, ['reset', '--keep', '-q', before])).code === 0;
  }

  /** `[abc-fe] ` for a repository inside the project folder; nothing for the project folder itself (the messages stay what they were). */
  private label(item: Item): string { return item.repo === '' ? '' : `[${item.repo}] `; }

  private async perform(p: Pending): Promise<void> {
    // Every repository is checked BEFORE anything is merged or pushed: one that fails stops the whole release.
    for (const item of p.items) {
      const bad = await this.preflight(item);
      if (bad) return this.refuse(bad.code, `${this.label(item)}${bad.text}`);
    }
    const done: string[] = [];
    const notes: string[] = [];
    for (const item of p.items) {
      const result = await this.releaseOne(item);
      if ('code' in result) {
        const left = p.items.slice(p.items.indexOf(item)).map((i) => i.repo || '(project folder)');
        const tail = p.items.length > 1 ? `${done.length > 0 ? ` Already released: ${done.join(', ')}.` : ''} Not released: ${left.join(', ')}.` : '';
        return this.refuse(result.code, `${this.label(item)}${result.text}${tail}`);
      }
      done.push(item.repo || '(project folder)');
      notes.push(result.note);
    }
    const count = p.items.reduce((n, i) => n + i.slugs.length, 0);
    const targets = [...new Set(p.items.map((i) => i.target))].join(', ');
    const note = notes.join('');
    const where = p.items.length > 1 ? ` in ${p.items.length} repositories` : '';
    this.d.notifyMain(`Project "${this.d.project}" released: ${count} ticket(s) merged into ${targets}${where}${note ? '' : ' and pushed to origin'}.${note}`);
  }

  /** The checks that need no change in any repository: the checkout is on main, clean, and the project branch is where the user saw it. */
  private async preflight(item: Item): Promise<Failure | undefined> {
    const root = item.path;
    const target = await this.targetBranch(root);
    if (!target) return { code: 'release.noMainBranch', text: 'the repository has no main or master branch. Nothing was pushed.' };
    const head = await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
    if (head.stdout.trim() !== target) return { code: 'release.notOnMain', text: `the checkout is not on ${target}; switch to it and propose again. Nothing was pushed and the checkout was left as it was.` };
    const dirty = await git(root, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty.stdout.trim() !== '') return { code: 'release.dirty', text: 'the checkout has uncommitted changes to tracked files; commit or stash them and propose again. Nothing was pushed and the checkout was left as it was.' };
    const tip = (await git(root, ['rev-parse', `refs/heads/project/${this.d.project}`])).stdout.trim();
    if (tip !== item.tip) return { code: 'release.projectMoved', text: 'the project branch moved after the proposal, so what you approved is not what would be released; propose again. Nothing was pushed and the checkout was left as it was.' };
    return undefined;
  }

  /** Merges the approved project tip into one repository's main, runs the tests, pushes, and marks its tickets released. */
  private async releaseOne(item: Item): Promise<Failure | { note: string }> {
    const root = item.path;
    const target = item.target;
    const before = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    const upToDate = (await git(root, ['merge-base', '--is-ancestor', item.tip, 'HEAD'])).code === 0;
    if (!upToDate) {
      // The approved commit itself, not whatever the branch name points to by the time the merge runs.
      const fastForward = (await git(root, ['merge-base', '--is-ancestor', 'HEAD', item.tip])).code === 0;
      const merged = fastForward
        ? await git(root, ['merge', '--ff-only', '-q', item.tip])
        : await git(root, [...(await identityArgs(root)), 'merge', '--no-ff', '--no-edit', '-q', '-m', `Release project ${this.d.project}`, item.tip]);
      if (merged.code !== 0) {
        await git(root, ['merge', '--abort']);
        const undone = await this.undo(root, before);
        return { code: 'release.conflict', text: `the project branch does not merge cleanly into ${target}.${undone ? ' Nothing was pushed and the checkout was left as it was.' : ` Your own edits made it impossible to undo completely: check ${target}.`}` };
      }
      // A fast-forward leaves the target with exactly the tree the proposal already tested on this tip: only a real merge is new code to test.
      const command = fastForward ? undefined : this.d.testCommand()?.trim();
      if (command) {
        const run = await (this.d.runTests ?? runDirect)({ cwd: root, command, timeoutMs: this.d.testTimeoutMs(), owner: `release:${this.d.project}` });
        if (!run.ok) {
          const undone = await this.undo(root, before);
          return { code: 'release.testsFailed', text: `the tests fail on ${target} after merging the project branch. Output:\n${run.tail.trim().slice(-800)}\n${undone ? `The merge was undone: ${target} is back where it was. Nothing was pushed.` : `The merge could NOT be undone because tracked files were edited while the tests ran (your edits were kept): ${target} contains the merge, but nothing was pushed.`}` };
        }
      }
    }

    const remotes = (await git(root, ['remote'])).stdout.split(/\r?\n/).map((l) => l.trim());
    let note = '';
    if (!remotes.includes('origin')) {
      note = ' There is no remote named origin: the release is a local merge only.';
    } else {
      const pushed = await withReleaseToken(root, (env) => git(root, ['push', 'origin', target], { env, timeoutMs: 120_000 }));
      if (pushed.code !== 0) {
        return { code: 'release.pushFailed', text: `the merge into ${target} is done locally but the push failed: ${(pushed.stderr || pushed.stdout).trim().slice(-400)} Propose again to retry the push.` };
      }
    }
    for (const slug of item.slugs) {
      const t = this.d.tickets.get(slug);
      if (t?.status === 'merged') this.d.tickets.move(slug, 'released');
    }
    return { note };
  }
}
