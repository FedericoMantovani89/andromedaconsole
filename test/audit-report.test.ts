import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBundles } from '../src/server/i18n-bundles';
import { createTranslator } from '../src/shared/i18n';
import { auditFiles, latestAudit, readAudit, verdictOf, writeAudit, type AuditReport } from '../src/server/audit/report';
import type { Metric } from '../src/server/audit/metrics';

const bundles = loadBundles();
const tr = (lang: string) => createTranslator({ lang, messages: bundles.get(lang) ?? {}, fallback: bundles.get('en') });
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const metric = (over: boolean, id: Metric['id'] = 'diff_lines'): Metric => ({ id, value: over ? 400 : 100, limit: 250, over, ...(over ? { where: 'src/a.ts' } : {}) });
const report = (o: Partial<AuditReport> = {}): AuditReport => ({
  sha: SHA_A, level: 'full', profile: 'default', verdict: 'ready', metrics: [metric(false)], layerTwo: [], notes: [], notRun: [], modelRan: false, at: '2026-11-13T10:00:00.000Z', ...o,
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'audit-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('verdictOf', () => {
  const note = (severity: 'high' | 'medium' | 'low') => ({ source: 'model' as const, severity, where: 'a.ts:1', problem: 'p', fix: 'f' });
  it.each([
    ['an over limit beats everything', [metric(true)], [], 'split_first'],
    ['an over limit beats a note', [metric(true)], [note('high')], 'split_first'],
    ['a high note needs changes', [metric(false)], [note('high')], 'needs_changes'],
    ['a medium note needs changes', [metric(false)], [note('medium')], 'needs_changes'],
    ['only low notes are ready', [metric(false)], [note('low')], 'ready'],
    ['nothing is ready', [metric(false)], [], 'ready'],
  ] as const)('%s', (_name, metrics, notes, expected) => {
    expect(verdictOf({ metrics: [...metrics], notes: [...notes] })).toBe(expected);
  });
});

describe('files', () => {
  it('names the files after the first 12 characters of the sha, under the ticket folder', () => {
    const f = auditFiles(dir, 'add-thing', SHA_A);
    expect(f.json.replace(/\\/g, '/')).toMatch(/\.andromedaconsole\/tickets\/add-thing\/audit-aaaaaaaaaaaa\.json$/);
    expect(f.md.endsWith('audit-aaaaaaaaaaaa.md')).toBe(true);
  });

  it('refuses a slug or a sha that could leave the folder', () => {
    expect(() => auditFiles(dir, '../x', SHA_A)).toThrow();
    expect(() => auditFiles(dir, 'ok', '../../x')).toThrow();
  });

  it('two shas leave two pairs of files and the old ones stay', () => {
    writeAudit(dir, 'add-thing', report({ sha: SHA_A, at: '2026-11-13T10:00:00.000Z' }), tr('en'), 'en');
    writeAudit(dir, 'add-thing', report({ sha: SHA_B, at: '2026-11-13T11:00:00.000Z', verdict: 'needs_changes' }), tr('en'), 'en');
    const names = readdirSync(join(dir, '.andromedaconsole', 'tickets', 'add-thing')).sort();
    expect(names).toEqual(['audit-aaaaaaaaaaaa.json', 'audit-aaaaaaaaaaaa.md', 'audit-bbbbbbbbbbbb.json', 'audit-bbbbbbbbbbbb.md']);
    expect(readAudit(dir, 'add-thing', SHA_A)?.verdict).toBe('ready');
    expect(latestAudit(dir, 'add-thing')?.sha).toBe(SHA_B);
  });

  it('a damaged JSON reads as no audit, and so does a missing one', () => {
    const f = writeAudit(dir, 'add-thing', report(), tr('en'), 'en');
    writeFileSync(f.json, '{ not json', 'utf8');
    expect(readAudit(dir, 'add-thing', SHA_A)).toBeUndefined();
    expect(latestAudit(dir, 'add-thing')).toBeUndefined();
    expect(readAudit(dir, 'nothing-here', SHA_B)).toBeUndefined();
  });

  it('leaves no temporary file behind', () => {
    const f = writeAudit(dir, 'add-thing', report(), tr('en'), 'en');
    expect(existsSync(`${f.json}.tmp`)).toBe(false);
    expect(existsSync(`${f.md}.tmp`)).toBe(false);
  });
});

describe('the readable report', () => {
  const full = report({
    verdict: 'split_first',
    metrics: [metric(true), { id: 'file_lines', value: 'n/a', limit: 600, over: false }],
    layerTwo: [{ id: 'lint', ran: true, ok: false, output: '2 problems\nsrc/a.ts 3:1 no-unused' }, { id: 'format_check', ran: false, output: '', reason: 'no_command' }],
    notes: [{ source: 'model', severity: 'high', where: 'src/a.ts:41', problem: 'duplicates\nformat() in src/b.ts:7', fix: 'call it' }],
    notRun: ['profile_fallback:strict'],
    modelRan: true,
  });

  it('lists path:line — problem -> fix, with the headings in the interface language', () => {
    const en = readFileSync(writeAudit(dir, 'add-thing', full, tr('en'), 'en').md, 'utf8');
    expect(en).toContain('src/a.ts:41 — duplicates format() in src/b.ts:7 -> call it');
    expect(en).toContain('Split first');
    expect(en).toContain('2 problems');
    const it = readFileSync(writeAudit(dir, 'add-thing', full, tr('it'), 'it').md, 'utf8');
    expect(it).toContain('Da dividere');
    expect(it).toContain('src/a.ts:41 — duplicates format() in src/b.ts:7 -> call it'); // the model's words are not translated
  });

  it('says n/a for a missing value and "not run" for a layer that did not run, never ok', () => {
    const en = readFileSync(writeAudit(dir, 'add-thing', full, tr('en'), 'en').md, 'utf8');
    expect(en).toMatch(/n\/a/);
    expect(en).toMatch(/Not run/);
    expect(en).not.toMatch(/Format check: ok/i);
  });

  it('says plainly when the model audit has not run', () => {
    const en = readFileSync(writeAudit(dir, 'add-thing', report(), tr('en'), 'en').md, 'utf8');
    expect(en).toContain('The model audit has not run');
  });
});
