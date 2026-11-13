import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Translate } from '../../shared/i18n';
import { reportPath } from '../tickets/report';
import type { LayerTwoResult } from './commands';
import type { AuditLevel } from './levels';
import type { Metric } from './metrics';

export type { AuditLevel };
export type AuditVerdict = 'ready' | 'needs_changes' | 'split_first';
export const AUDIT_VERDICTS: readonly AuditVerdict[] = ['ready', 'needs_changes', 'split_first'];

export interface AuditNote { source: 'metrics' | 'lint' | 'model'; severity: 'high' | 'medium' | 'low'; where: string; problem: string; fix: string }

/** The structured audit of one delivered diff (`audit-<sha>.json`). */
export interface AuditReport {
  sha: string;
  level: AuditLevel;
  profile: string;
  /** A fingerprint of the limits and commands the measures were made with: a report made with other ones is made again. */
  profileKey?: string;
  verdict: AuditVerdict;
  metrics: Metric[];
  layerTwo: LayerTwoResult[];
  notes: AuditNote[];
  /** Layers or inputs that did not run (a profile that failed to load, a missing tool): shown as "not run", never as ok. */
  notRun: string[];
  modelRan: boolean;
  at: string;
}

/** An over limit gates and decides the verdict; otherwise a high or medium note asks for changes; low notes alone are fine. */
export function verdictOf(r: Pick<AuditReport, 'metrics' | 'notes'>): AuditVerdict {
  if (r.metrics.some((m) => m.over)) return 'split_first';
  if (r.notes.some((n) => n.severity === 'high' || n.severity === 'medium')) return 'needs_changes';
  return 'ready';
}

const SHA_RE = /^[0-9a-f]{7,64}$/i;
const FILE_RE = /^audit-[0-9a-f]{12}\.json$/;

/** `<root>/.andromedaconsole/tickets/<slug>/audit-<first 12 of the sha>.json|md`: one pair per diff, the older ones stay. */
export function auditFiles(root: string, slug: string, sha: string): { json: string; md: string } {
  if (!SHA_RE.test(sha)) throw new Error('audit.badSha');
  const dir = dirname(reportPath(root, slug)); // validates the slug
  const stem = join(dir, `audit-${sha.slice(0, 12).toLowerCase()}`);
  return { json: `${stem}.json`, md: `${stem}.md` };
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const plainWhere = (s: string): string => oneLine(s).replace(/`/g, '').slice(0, 200);

function metricLine(m: Metric, t: Translate): string {
  const na = t('common.notAvailable');
  const value = m.value === 'n/a' ? na : String(m.value);
  const limit = m.limit === 0 ? t('audit.limit.off') : String(m.limit);
  const where = m.where ? ` (${plainWhere(m.where)})` : '';
  return `- ${t(`audit.metric.${m.id}`)}: ${value} / ${limit}${m.over ? ` — ${t('audit.over')}` : ''}${where}`;
}

function layerLines(l: LayerTwoResult, t: Translate): string[] {
  const name = t(`audit.layer.${l.id}`);
  if (!l.ran) return [`- ${name}: ${t('audit.notRun')}${l.reason ? ` (${t(`audit.reason.${l.reason}`)})` : ''}`];
  const lines = [`- ${name}: ${l.ok ? t('audit.layer.ok') : t('audit.layer.failed')}`];
  if (l.output.trim() !== '') lines.push('', '````', l.output.trim().replace(/````/g, "'''"), '````', '');
  return lines;
}

/** The readable form: headings, metric names and the verdict follow the interface language; the model's notes are shown as written. */
function renderAudit(r: AuditReport, t: Translate, lang: string): string {
  const out: string[] = ['---', `sha: ${r.sha.slice(0, 12)}`, `level: ${r.level}`, `profile: ${/^[\w-]{1,40}$/.test(r.profile) ? r.profile : 'n/a'}`, `verdict: ${r.verdict}`, `lang: ${/^[\w-]{1,10}$/.test(lang) ? lang : 'n/a'}`, '---', ''];
  out.push(`# ${t('audit.title')}: ${t(`audit.verdict.${r.verdict}`)}`, '');
  out.push(`## ${t('audit.metrics')}`, '', ...(r.metrics.length > 0 ? r.metrics.map((m) => metricLine(m, t)) : [t('common.notAvailable')]), '');
  out.push(`## ${t('audit.layers')}`, '', ...(r.layerTwo.length > 0 ? r.layerTwo.flatMap((l) => layerLines(l, t)) : [t('audit.notRun')]), '');
  out.push(`## ${t('audit.notes')}`, '');
  if (!r.modelRan) out.push(t('audit.model.notRun'), '');
  if (r.notes.length === 0) out.push(t('audit.notes.none'));
  r.notes.forEach((n, i) => out.push(`${i + 1}. [${n.severity}] (${t(`audit.source.${n.source}`)}) ${plainWhere(n.where)} — ${oneLine(n.problem)} -> ${oneLine(n.fix)}`));
  if (r.notRun.length > 0) out.push('', `## ${t('audit.notRun')}`, '', ...r.notRun.map((x) => {
    const i = x.indexOf(':');
    return `- ${t(`audit.notRunItem.${i < 0 ? x : x.slice(0, i)}`, { name: i < 0 ? '' : plainWhere(x.slice(i + 1)) })}`;
  }));
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function writeAtomic(file: string, text: string): void {
  writeFileSync(`${file}.tmp`, text, 'utf8');
  renameSync(`${file}.tmp`, file);
}

/** Writes both files of this diff (through temporary files). Another sha's files are never touched. */
export function writeAudit(root: string, slug: string, r: AuditReport, t: Translate, lang: string): { json: string; md: string } {
  const f = auditFiles(root, slug, r.sha);
  mkdirSync(dirname(f.json), { recursive: true });
  writeAtomic(f.json, `${JSON.stringify(r, null, 2)}\n`);
  writeAtomic(f.md, renderAudit(r, t, lang));
  return f;
}

function parse(file: string): AuditReport | undefined {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<AuditReport>;
    const ok = typeof v.sha === 'string' && AUDIT_VERDICTS.includes(v.verdict as AuditVerdict) && Array.isArray(v.metrics) && Array.isArray(v.notes)
      && Array.isArray(v.layerTwo) && Array.isArray(v.notRun) && typeof v.at === 'string';
    return ok ? (v as AuditReport) : undefined;
  } catch {
    return undefined; // missing or damaged: there is no audit
  }
}

export const readAudit = (root: string, slug: string, sha: string): AuditReport | undefined => parse(auditFiles(root, slug, sha).json);

/** The audit with the newest `at` among the ticket's files (a damaged file is skipped). */
export function latestAudit(root: string, slug: string): AuditReport | undefined {
  const dir = dirname(reportPath(root, slug));
  let names: string[];
  try { names = readdirSync(dir).filter((n) => FILE_RE.test(n)); } catch { return undefined; }
  let best: AuditReport | undefined;
  for (const n of names) {
    const r = parse(join(dir, n));
    if (r && (!best || r.at > best.at)) best = r;
  }
  return best;
}
