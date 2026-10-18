import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Translate } from '../../shared/i18n';
import type { Step } from './checklist';
import type { AgentTests, TestResult, Verdict } from './store';
import { SLUG_RE } from '../../shared/slug';

export interface ChangedFile { path: string; /** null for a binary file */ added: number | null; removed: number | null }

export interface ReportInput {
  slug: string;
  project: string;
  branch: string;
  goal?: string;
  steps: Step[];
  files: ChangedFile[];
  /** The console's own run (never an agent's claim). */
  tests?: TestResult;
  /** The user switched the tests off for this project: "no run" is then said as such, not as "n/a". */
  testsInhibited?: boolean;
  /** The tests the agent says it ran by hand (`step_done`): shown on a line of their own, labelled as not verified by the console. */
  agentTests?: AgentTests;
  /** The note of the documentation step, when it was closed with a note instead of a change. */
  docsNote?: string;
  verdicts: Verdict[];
  /** Language of the headings (the interface language when the report is generated). */
  lang: string;
  t: Translate;
  generatedAt?: string;
}

const PLAIN = /^[A-Za-z0-9._/-]{1,200}$/;
const DOC_BASENAME = /^(readme|changelog|contributing|license|authors|history)(\.(md|txt|rst|adoc|markdown))?$/i;
const TIMESTAMP = /^[0-9TZ:.+-]{10,40}$/;
const DOC_EXT = /\.(md|rst|adoc|markdown)$/i;

/** README, CHANGELOG, `*.md` and anything under a `docs/` folder. */
export function isDocFile(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  const base = p.slice(p.lastIndexOf('/') + 1);
  return DOC_BASENAME.test(base) || DOC_EXT.test(base) || p.startsWith('docs/') || p.includes('/docs/');
}

export function reportPath(root: string, slug: string): string {
  if (!SLUG_RE.test(slug)) throw new Error('ticket.badSlug');
  return join(root, '.andromedaconsole', 'tickets', slug, 'report.md');
}

/** Writes `.andromedaconsole/tickets/<slug>/report.md` through a temporary file, so a reader never sees half of it. */
export function writeReport(root: string, slug: string, text: string): string {
  const file = reportPath(root, slug);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(`${file}.tmp`, text, 'utf8');
  renameSync(`${file}.tmp`, file);
  return file;
}

const plain = (v: string): string => (PLAIN.test(v) ? v : 'n/a');
const quote = (text: string): string => text.replace(/\r\n?/g, '\n').split('\n').map((l) => (l === '' ? '>' : `> ${l}`)).join('\n');
const totals = (files: ChangedFile[]): { added: number; removed: number } => ({
  added: files.reduce((n, f) => n + (f.added ?? 0), 0), removed: files.reduce((n, f) => n + (f.removed ?? 0), 0),
});
const counts = (f: ChangedFile): string => (f.added === null || f.removed === null ? '' : ` (+${f.added} -${f.removed})`);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/**
 * `report.md` (SPEC 15.6), written by the console without a model. Headings follow the language; everything an agent wrote is
 * quoted verbatim in its own block, and the tests and files are the console's, except one clearly labelled line with what the agent says it ran by hand.
 */
export function buildReport(i: ReportInput): string {
  const { t } = i;
  const na = t('common.notAvailable');
  const out: string[] = [];
  out.push('---', `ticket: ${plain(i.slug)}`, `project: ${plain(i.project)}`, `branch: ${plain(i.branch)}`, `lang: ${plain(i.lang)}`);
  if (i.generatedAt && TIMESTAMP.test(i.generatedAt)) out.push(`generated: ${i.generatedAt}`);
  out.push('---', '', `# ${plain(i.slug)}`, '');

  out.push(`## ${t('report.objective')}`, '', i.goal?.trim() ? quote(i.goal.trim()) : na, '');

  const done = i.steps.filter((s) => s.done).length;
  out.push(`## ${t('report.checklist', { done, total: i.steps.length })}`, '');
  for (const s of i.steps) out.push(`- [${s.done ? 'x' : ' '}] ${s.n}. ${s.title}${s.skipped ? ` (${t('report.skipped')})` : ''}${s.waitingOn ? ` (${s.waitingOn.requestId})` : ''}`);
  if (i.steps.length === 0) out.push(na);
  out.push('');

  out.push(`## ${t('report.files')}`, '');
  if (i.files.length === 0) out.push(na);
  else {
    const sum = totals(i.files);
    out.push(t('report.files.summary', { count: i.files.length, added: sum.added, removed: sum.removed }), '');
    for (const f of i.files) out.push(`- \`${f.path}\`${counts(f)}`);
  }
  out.push('');

  out.push(`## ${t('report.tests')}`, '');
  if (!i.tests) out.push(i.testsInhibited ? t('report.tests.inhibited') : na);
  else {
    out.push(`${t('report.tests.command')}: \`${i.tests.command}\``);
    out.push(`${t('report.tests.result')}: ${i.tests.ok ? t('report.tests.passed') : t('report.tests.failed')} (${t('report.tests.commit', { sha: i.tests.sha.slice(0, 7) })})`);
    if (!i.tests.ok && i.tests.tail.trim() !== '') out.push('', '````', i.tests.tail.trim().replace(/````/g, "'''"), '````');
  }
  // The agent's own claim, apart from the console's run and labelled as unverified. Its text is data: one plain line, no backticks.
  const label = t('report.tests.agent');
  if (!i.agentTests) out.push('', `${label}: ${na}`);
  else {
    const a = i.agentTests;
    const summary = a.summary ? oneLine(a.summary) : '';
    out.push('', `${label}: ${a.result === 'passed' ? t('report.tests.passed') : t('report.tests.failed')} (\`${oneLine(a.command).replace(/`/g, '')}\`)${summary !== '' ? ` - ${summary}` : ''}`);
  }
  out.push('');

  out.push(`## ${t('report.docs')}`, '');
  const docFiles = i.files.filter((f) => isDocFile(f.path));
  for (const f of docFiles) out.push(`- \`${f.path}\``);
  if (i.docsNote?.trim()) out.push(...(docFiles.length > 0 ? [''] : []), `${t('report.docs.note')}`, '', quote(i.docsNote.trim()));
  if (docFiles.length === 0 && !i.docsNote?.trim()) out.push(t('report.docs.none'));
  out.push('');

  out.push(`## ${t('report.decisions')}`, '');
  const noted = i.steps.filter((s) => s.note?.trim());
  if (noted.length === 0) out.push(na);
  for (const s of noted) out.push(`**${t('report.decisions.step', { n: s.n })}** — ${s.title}${s.skipped ? ` (${t('report.skipped')})` : ''}`, '', quote(s.note!.trim()), '');
  if (noted.length > 0) out.pop();
  out.push('');

  if (i.verdicts.length > 0) {
    out.push(`## ${t('report.review')}`, '');
    for (const v of i.verdicts) {
      out.push(`- ${t('report.review.round', { n: v.round })}: ${v.pass ? t('report.review.pass') : t('report.review.fail')} (${t('report.review.by', { reviewer: v.reviewer })})`);
      for (const n of v.notes) out.push(`  - [${n.severity}]${n.where ? ` \`${n.where.replace(/[\s`]+/g, ' ').trim().slice(0, 200)}\`` : ''}`, '', ...quote(n.text).split('\n').map((l) => `    ${l}`), '');
    }
    out.push('');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** The body of the squash commit: English on purpose, so the git history stays in one language (SPEC 15.6). */
export function squashMessage(i: ReportInput): string {
  const goalLine = oneLine((i.goal ?? '').split(/\r?\n/).find((l) => l.trim() !== '') ?? '');
  const sum = totals(i.files);
  const done = i.steps.filter((s) => s.done).length;
  const lines = [`ticket ${plain(i.slug)}${goalLine ? `: ${cut(goalLine, 72)}` : ''}`, ''];
  if (i.goal?.trim()) lines.push(`Objective: ${cut(oneLine(i.goal), 400)}`);
  lines.push(`Files: ${i.files.length} changed (+${sum.added} -${sum.removed})`);
  lines.push(`Tests: ${i.tests ? `${i.tests.ok ? 'passed' : 'failed'} (${oneLine(i.tests.command)})` : i.testsInhibited ? 'not run (switched off for this project)' : 'n/a'}`);
  lines.push(`Steps: ${done}/${i.steps.length}`);
  const notes = i.steps.filter((s) => s.note?.trim()).slice(0, 10);
  if (notes.length > 0) {
    lines.push('Notes:');
    for (const s of notes) lines.push(`- step ${s.n}: ${cut(oneLine(s.note!), 120)}`);
  }
  lines.push('', `Agent: ${plain(i.slug)}`, `Ticket: ${plain(i.slug)}`, `Progetto: ${plain(i.project)}`);
  const passed = [...i.verdicts].reverse().find((v) => v.pass);
  if (passed) lines.push(`Reviewed-by: ${plain(passed.reviewer)} (round ${passed.round})`);
  return `${lines.join('\n')}\n`;
}
