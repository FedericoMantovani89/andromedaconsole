import { createHash } from 'node:crypto';
import type { Translate } from '../../shared/i18n';
import type { ChangedFile } from '../tickets/report';
import type { TestRunner } from '../tickets/test-queue';
import { runStyleCommand, type LayerTwoResult } from './commands';
import { addedLines, fileLineCounts } from './git-input';
import { computeMetrics } from './metrics';
import { latestAudit, readAudit, verdictOf, writeAudit, type AuditNote, type AuditReport, type AuditVerdict } from './report';
import type { AuditSettings } from './settings';
import { DEFAULT_LIMITS, loadStyleProfile, type StyleProfile } from './style-profile';

export interface AuditDeps {
  /** The project folder (where `.andromedaconsole/` lives). */
  root: string;
  /** What applies to this project right now (global setting and the project's own override). */
  settings(): AuditSettings;
  userStyleDir?: string;
  /** The interface language right now and its translator (the readable report follows it). */
  language(): { lang: string; t: Translate };
  testTimeoutMs(): number;
  /** Runs a project command (default: straight away, like the tests). */
  runCommand?: TestRunner;
  /** The project's own lint command, used when the style profile has none. */
  lintCommand?(): string | undefined;
  /** The model part: starts the read-only auditor session through the normal spawn flow, and ends it when it has reported. */
  spawnAuditor?(r: AuditorSpawn): Promise<{ ok: true } | { ok: false; code: string; detail?: string }>;
  endAuditor?(slug: string): void;
  /** One line to the main session (it is written as coming from the console). */
  notifyMain?(text: string): void;
  /** Every agent name already used in the project (an auditor's name must be new). */
  existingSlugs?(): string[];
}

/** What the state shows of a ticket's latest audit. */
export interface AuditSummary { verdict: AuditVerdict; level: string; modelRan: boolean }
const summaryOf = (r: AuditReport): AuditSummary => ({ verdict: r.verdict, level: r.level, modelRan: r.modelRan });

export interface AuditorSpawn { slug: string; ticket: string; sha: string; goal: string; model?: string }

export type StartAuditResult =
  | { ok: true; auditor: string }
  | { ok: false; code: 'no_measures' | 'already_running' | 'spawn_failed'; detail?: string };

export type AuditReportResult =
  | { ok: true; ticket: string; verdict: AuditVerdict }
  | { ok: false; code: 'not_auditor' | 'bad_request'; detail?: string };

export interface MeasureInput {
  slug: string;
  /** The ticket's worktree (where the commands run). */
  cwd: string;
  /** The diff is `base...sha`, the same range the ticket report uses. */
  base: string;
  sha: string;
  files: ChangedFile[];
  /** Measure again even if this sha already has a report (the style profile may have changed). */
  rerun?: boolean;
}

const INLINE_DEFAULT: StyleProfile = { name: 'default', description: '', limits: { ...DEFAULT_LIMITS }, commands: {}, conventions: '', source: 'shipped' };

/** The audit of a delivered ticket (SPEC 15.7): the two layers that cost no tokens, run once per delivered sha. */
export class AuditService {
  constructor(private readonly d: AuditDeps) {}

  /** The style profile to use, and the code to report when the wanted one could not be loaded. */
  private profileFor(wanted: string): { profile: StyleProfile; fallback?: string } {
    const found = loadStyleProfile(wanted, this.d.root, this.d.userStyleDir);
    if (found) return { profile: found };
    return { profile: loadStyleProfile('default', this.d.root, this.d.userStyleDir) ?? INLINE_DEFAULT, fallback: `profile_fallback:${wanted}` };
  }

  /** `undefined` at level `off`. A report already made for this sha is returned as it is, unless `rerun`. */
  async measure(o: MeasureInput): Promise<AuditReport | undefined> {
    const s = this.d.settings();
    if (s.level === 'off') return undefined;
    const existing = readAudit(this.d.root, o.slug, o.sha);
    const { profile, fallback } = this.profileFor(s.profile);
    // What the measures depend on: the limits and the commands in force now. An edit of the profile (or of the project's lint command)
    // makes the same commit be measured again; the conventions text only matters to the model, so it is not part of the key.
    const lintFallback = profile.commands.lint ? undefined : this.d.lintCommand?.();
    const profileKey = createHash('sha1').update(JSON.stringify({ limits: profile.limits, commands: profile.commands, lintFallback: lintFallback ?? null })).digest('hex').slice(0, 12);
    if (existing && !o.rerun && existing.profile === profile.name && existing.profileKey === profileKey) return existing;
    const notRun: string[] = fallback ? [fallback] : [];
    const added = await addedLines(o.cwd, o.base, o.sha);
    if (!added) notRun.push('diff_unreadable');
    const paths = o.files.map((f) => f.path);
    const fileLines = await fileLineCounts(o.cwd, o.sha, paths);
    const metrics = computeMetrics({ files: o.files, added: added ?? [], fileLines, profile });

    // A binary, deleted or unreadable file has no line count: nothing to lint there.
    const lintable = paths.filter((p) => fileLines[p] !== undefined);
    const layerTwo: LayerTwoResult[] = [];
    for (const [id, command] of [['lint', profile.commands.lint ?? lintFallback], ['format_check', profile.commands.format_check]] as const) {
      layerTwo.push(await runStyleCommand({ id, command, files: lintable, cwd: o.cwd, timeoutMs: this.d.testTimeoutMs(), run: this.d.runCommand, owner: o.slug }));
    }

    // What the model said about this sha stays when the measures are redone. Read again here, after every wait above: the auditor may have reported meanwhile.
    const latest = readAudit(this.d.root, o.slug, o.sha);
    const notes = latest?.modelRan ? latest.notes.filter((n) => n.source === 'model') : [];
    const report: AuditReport = {
      sha: o.sha, level: s.level, profile: profile.name, profileKey, verdict: 'ready', metrics, layerTwo, notes, notRun, modelRan: latest?.modelRan === true, at: new Date().toISOString(),
    };
    report.verdict = verdictOf(report);
    const { lang, t } = this.d.language();
    writeAudit(this.d.root, o.slug, report, t, lang);
    this.summaries.set(o.slug, summaryOf(report));
    return report;
  }

  /** Every state push asks for this: read from the disk once per ticket, then kept up to date by the two places that write an audit. */
  private readonly summaries = new Map<string, AuditSummary | undefined>();
  summary(slug: string): AuditSummary | undefined {
    if (!this.summaries.has(slug)) {
      const r = latestAudit(this.d.root, slug);
      this.summaries.set(slug, r ? summaryOf(r) : undefined);
    }
    return this.summaries.get(slug);
  }

  private readonly autoTried = new Set<string>();

  /** The auditors started and not yet heard from: session name -> the ticket and commit it audits. */
  private readonly running = new Map<string, { ticket: string; sha: string }>();

  /** The model part starts by itself (level `full` and the setting on). */
  wantsAutoModel(): boolean {
    const s = this.d.settings();
    return s.level === 'full' && s.autoModel;
  }

  /**
   * Starts the read-only auditor for a commit that has been measured. One auditor per commit at a time; the name is reserved before the
   * session is asked for, so two calls at once cannot start two.
   */
  async startModel(o: { slug: string; sha: string; project: string; base?: string; goal?: string; reportFile: string; model?: string; /** Started by the setting, not asked for: tried once per commit, so a failed auditor is not started again by every later report. */ auto?: boolean }): Promise<StartAuditResult> {
    if (o.auto) {
      const key = `${o.slug}:${o.sha}`;
      if (this.autoTried.has(key)) return { ok: false, code: 'already_running' };
      this.autoTried.add(key);
    }
    const report = readAudit(this.d.root, o.slug, o.sha);
    if (!report) return { ok: false, code: 'no_measures' };
    if ([...this.running.values()].some((r) => r.ticket === o.slug && r.sha === o.sha)) return { ok: false, code: 'already_running' };
    if (!this.d.spawnAuditor) return { ok: false, code: 'spawn_failed', detail: 'the model audit is not available' };
    const auditor = auditorSlugFor(o.slug, [...(this.d.existingSlugs?.() ?? []), ...this.running.keys()]);
    this.running.set(auditor, { ticket: o.slug, sha: o.sha });
    const profile = this.profileFor(this.d.settings().profile).profile;
    const goal = auditGoal({ slug: o.slug, project: o.project, sha: o.sha, goal: o.goal, base: o.base, reportFile: o.reportFile.replace(/\\/g, '/'), report, profile, uiLang: this.d.language().lang });
    let started: Awaited<ReturnType<NonNullable<AuditDeps['spawnAuditor']>>>;
    try {
      started = await this.d.spawnAuditor({ slug: auditor, ticket: o.slug, sha: o.sha, goal, ...(o.model ? { model: o.model } : {}) });
    } catch (e) {
      started = { ok: false, code: 'spawn_failed', detail: e instanceof Error ? e.message : String(e) };
    }
    if (!started.ok) {
      this.running.delete(auditor);
      return { ok: false, code: 'spawn_failed', detail: started.detail ?? started.code };
    }
    return { ok: true, auditor };
  }

  /** The ticket an auditor session was started for (undefined once it has reported or ended). */
  ticketOf(auditor: string): string | undefined { return this.running.get(auditor)?.ticket; }

  /**
   * The auditor's one report: its notes join the report of that commit (the measures stay), the verdict is worked out again, the
   * session ends and the main gets one line. The ticket is never moved and the author is never written to.
   */
  async report(auditor: string, body: unknown): Promise<AuditReportResult> {
    const run = this.running.get(auditor);
    if (!run) return { ok: false, code: 'not_auditor' };
    const raw = typeof body === 'object' && body !== null ? (body as { notes?: unknown }).notes : undefined;
    if (!Array.isArray(raw)) return { ok: false, code: 'bad_request', detail: 'notes must be a list of { severity, where, problem, fix }' };
    const stored = readAudit(this.d.root, run.ticket, run.sha);
    if (!stored) return { ok: false, code: 'bad_request', detail: 'the measures of this commit are gone: ask for the audit again' };

    const merged: AuditReport = { ...stored, notes: [...stored.notes.filter((n) => n.source !== 'model'), ...modelNotes(raw)], modelRan: true, at: new Date().toISOString() };
    merged.verdict = verdictOf(merged);
    const { lang, t } = this.d.language();
    const files = writeAudit(this.d.root, run.ticket, merged, t, lang);
    this.summaries.set(run.ticket, summaryOf(merged));
    this.running.delete(auditor);
    this.d.endAuditor?.(auditor);
    const count = merged.notes.filter((n) => n.source === 'model').length;
    this.d.notifyMain?.(`Audit of ticket "${run.ticket}": ${merged.verdict.replace('_', ' ')} (${count} note(s) from the model). Report: ${files.md.replace(/\\/g, '/')}.`);
    return { ok: true, ticket: run.ticket, verdict: merged.verdict };
  }

  /** The auditor's process ended with no report: nothing changes but the main is told. True when it was one of ours. */
  abandon(auditor: string): boolean {
    const run = this.running.get(auditor);
    if (!run) return false;
    this.running.delete(auditor);
    this.d.notifyMain?.(`The auditor ${auditor} ended without a report for ticket "${run.ticket}". Call request_audit again if you still want the model audit.`);
    return true;
  }
}

const MAX = 40;
/** `audit-<ticket>`, then `-a2`, `-a3`... when taken; never longer than 40 characters and always a valid slug. */
export function auditorSlugFor(ticket: string, taken: readonly string[]): string {
  const fit = (base: string, suffix: string): string => `${base.slice(0, MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
  const first = fit(`audit-${ticket}`, '');
  if (!taken.includes(first)) return first;
  for (let n = 2; ; n++) {
    const candidate = fit(`audit-${ticket}`, `-a${n}`);
    if (!taken.includes(candidate)) return candidate;
  }
}

const SEVERITY: Record<string, AuditNote['severity']> = { high: 'high', alta: 'high', medium: 'medium', media: 'medium', low: 'low', bassa: 'low' };
const MAX_NOTES = 50;
const MAX_TEXT = 2000;
const MAX_WHERE = 200;

/** The notes of the auditor's report: the ones with no problem text are dropped, an unknown severity is not trusted as low. */
function modelNotes(raw: unknown[]): AuditNote[] {
  const notes: AuditNote[] = [];
  for (const n of raw.slice(0, MAX_NOTES)) {
    if (typeof n !== 'object' || n === null) continue;
    const o = n as Record<string, unknown>;
    if (typeof o.problem !== 'string' || o.problem.trim() === '') continue;
    notes.push({
      source: 'model',
      severity: SEVERITY[String(o.severity ?? '').toLowerCase()] ?? 'medium',
      where: typeof o.where === 'string' ? o.where.trim().slice(0, MAX_WHERE) : '',
      problem: o.problem.trim().slice(0, MAX_TEXT),
      fix: typeof o.fix === 'string' ? o.fix.trim().slice(0, MAX_TEXT) : '',
    });
  }
  return notes;
}

/** What the auditor is told first (English: it is a prompt, not interface text). */
export function auditGoal(i: { slug: string; project: string; sha: string; goal?: string; base?: string; reportFile: string; report: AuditReport; profile: StyleProfile; uiLang: string }): string {
  const measured = i.report.metrics.map((m) => `- ${m.id}: ${m.value} (limit ${m.limit === 0 ? 'not checked' : m.limit})${m.over ? ' OVER THE LIMIT' : ''}${m.where ? `, ${m.where}` : ''}`);
  const layers = i.report.layerTwo.map((l) => `- ${l.id}: ${l.ran ? (l.ok ? 'no problems reported' : 'problems reported') : 'not run'}`);
  const conventions = i.profile.conventions.trim();
  const diff = i.base
    ? `git diff ${i.base.slice(0, 12)}..HEAD (this ticket was started on top of another agent's work: git diff project/${i.project}...HEAD would also show that, which is not under audit)`
    : `git diff project/${i.project}...HEAD`;
  return [
    `Audit the delivered ticket "${i.slug}" of the project "${i.project}" (commit ${i.sha.slice(0, 7)}) for slop. You are read-only: change nothing, run nothing that writes.`,
    '',
    `Objective the main wrote for the author:\n${i.goal?.trim() ? i.goal.trim() : '(none recorded)'}`,
    '',
    'Facts from the console (measured, not claimed by the author):',
    ...measured,
    ...layers,
    `- the report so far is the file ${i.reportFile}`,
    '',
    `How: your folder is a checkout of the delivered commit. See the change with: ${diff}. Search the rest of the repository for code that already does what the diff adds.`,
    'Look for: size and scope (a change that mixes concerns), duplication (against the diff and against the repository: name the existing function as path:line), unrelated changes, over-engineering, narrating or oversized comments, and deviations from the conventions below.',
    'Function length is yours to judge: the console does not measure it. Never judge correctness: the tests and the reviewer own it.',
    '',
    `The conventions of this project's style profile "${i.profile.name}", as the user wrote them:`,
    '````',
    conventions === '' ? '(none written)' : conventions.replace(/````/g, "'''"),
    '````',
    conventions === ''
      ? `Write your notes in the language with the code "${i.uiLang}".`
      : 'Write your notes in the language of the conventions text above. Keep paths and identifiers as they are.',
    '',
    'When you are done call the tool mcp__andromeda-mcp__audit_report (it is deferred: load it first with ToolSearch, query select:mcp__andromeda-mcp__audit_report) with',
    '{ notes }: each note has severity (high, medium or low), where (file:line), problem and fix. An empty list means you found nothing. Call it exactly once, then stop.',
  ].join('\n');
}
