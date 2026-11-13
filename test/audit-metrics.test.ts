import { describe, it, expect } from 'vitest';
import { commentSyntaxFor } from '../src/server/audit/comments';
import { computeMetrics, gatingOver, type AddedFile } from '../src/server/audit/metrics';
import { DEFAULT_LIMITS, type StyleProfile } from '../src/server/audit/style-profile';
import type { ChangedFile } from '../src/server/tickets/report';

const profile = (limits: Partial<StyleProfile['limits']> = {}): StyleProfile => ({
  name: 't', description: '', limits: { ...DEFAULT_LIMITS, ...limits }, commands: {}, conventions: '', source: 'shipped',
});
const file = (path: string, added: number | null, removed: number | null = 0): ChangedFile => ({ path, added, removed });
const lines = (path: string, texts: string[], from = 1): AddedFile => ({ path, lines: texts.map((text, i) => ({ n: from + i, text })) });
const metric = (ms: ReturnType<typeof computeMetrics>, id: string) => ms.find((m) => m.id === id)!;

describe('commentSyntaxFor', () => {
  it('knows the common extensions and nothing else', () => {
    expect(commentSyntaxFor('src/a.ts')?.line).toEqual(['//']);
    expect(commentSyntaxFor('x/y.PY')?.line).toEqual(['#']);
    expect(commentSyntaxFor('q.sql')?.line).toEqual(['--']);
    expect(commentSyntaxFor('a.unknownext')).toBeUndefined();
    expect(commentSyntaxFor('Makefile')).toBeUndefined();
  });
});

describe('computeMetrics', () => {
  it('flags a run of comment lines over the limit and names where it starts', () => {
    const added = [lines('src/a.ts', ['const a = 1;', '// one', '// two', '// three', '// four', '// five', '// six', 'const b = 2;'], 10)];
    const ms = computeMetrics({ files: [file('src/a.ts', 8)], added, fileLines: { 'src/a.ts': 20 }, profile: profile({ comment_run_lines: 4 }) });
    const m = metric(ms, 'comment_run_lines');
    expect(m).toMatchObject({ value: 6, limit: 4, over: true, where: 'src/a.ts:11' });
  });

  it('does not join lines from two separate hunks into one run', () => {
    const a: AddedFile = { path: 'a.ts', lines: [{ n: 1, text: '// a' }, { n: 2, text: '// b' }, { n: 40, text: '// c' }, { n: 41, text: '// d' }] };
    const ms = computeMetrics({ files: [file('a.ts', 4)], added: [a], fileLines: { 'a.ts': 50 }, profile: profile() });
    expect(metric(ms, 'comment_run_lines').value).toBe(2);
  });

  it('counts a block comment as comment lines', () => {
    const ms = computeMetrics({ files: [file('a.java', 5)], added: [lines('a.java', ['/*', ' * long', ' * story', ' */', 'int x;'])], fileLines: {}, profile: profile() });
    expect(metric(ms, 'comment_run_lines').value).toBe(4);
  });

  it('measures the comment ratio on added non-blank lines of files with a known syntax', () => {
    const texts = [...Array.from({ length: 6 }, (_, i) => `// c${i}`), ...Array.from({ length: 14 }, (_, i) => `code${i}`), '', ' '];
    const ms = computeMetrics({ files: [file('a.ts', 22)], added: [lines('a.ts', texts)], fileLines: {}, profile: profile() });
    expect(metric(ms, 'comment_ratio').value).toBeCloseTo(0.3, 5);
    expect(metric(ms, 'comment_ratio').over).toBe(true);
  });

  it('is n/a for the comment metrics when no changed file has a known syntax', () => {
    const ms = computeMetrics({ files: [file('data.unknownext', 5)], added: [lines('data.unknownext', ['x'])], fileLines: {}, profile: profile() });
    expect(metric(ms, 'comment_ratio').value).toBe('n/a');
    expect(metric(ms, 'comment_run_lines').value).toBe('n/a');
    expect(metric(ms, 'comment_ratio').over).toBe(false);
  });

  it('a limit of 0 is never over', () => {
    const ms = computeMetrics({ files: [file('a.ts', 9999, 1)], added: [], fileLines: { 'a.ts': 99999 }, profile: profile({ diff_lines: 0, file_lines: 0 }) });
    expect(metric(ms, 'diff_lines')).toMatchObject({ value: 10000, limit: 0, over: false });
    expect(metric(ms, 'file_lines').over).toBe(false);
    expect(gatingOver(ms)).toEqual([]);
  });

  it('sums added and removed, counts files and names the longest file', () => {
    const files = [file('src/a.ts', 200, 60), file('lib/b.ts', 100, 0)];
    const ms = computeMetrics({ files, added: [], fileLines: { 'src/a.ts': 700, 'lib/b.ts': 100 }, profile: profile() });
    expect(metric(ms, 'diff_lines')).toMatchObject({ value: 360, over: true });
    expect(metric(ms, 'files_touched')).toMatchObject({ value: 2, over: false });
    expect(metric(ms, 'files_touched').where).toBe('src, lib');
    expect(metric(ms, 'file_lines')).toMatchObject({ value: 700, over: true, where: 'src/a.ts' });
    expect(gatingOver(ms)).toEqual(['diff_lines', 'file_lines']);
  });

  it('is n/a (not 0) when every changed file is binary or its length is unknown', () => {
    const ms = computeMetrics({ files: [file('logo.png', null, null)], added: [], fileLines: { 'logo.png': undefined }, profile: profile() });
    expect(metric(ms, 'diff_lines').value).toBe('n/a');
    expect(metric(ms, 'file_lines').value).toBe('n/a');
    expect(metric(ms, 'files_touched').value).toBe(1);
  });

  it('counts one line for a long comment in any script (lengths are lines, not words)', () => {
    const ms = computeMetrics({ files: [file('a.ts', 1)], added: [lines('a.ts', ['// 这是一个很长的注释，没有空格，也算一行'])], fileLines: {}, profile: profile() });
    expect(metric(ms, 'comment_run_lines').value).toBe(1);
  });
});

describe('what the audit does not judge on', () => {
  it('a tiny diff has no comment ratio: one doc comment above a short function is not slop', () => {
    const texts = ['// the helper', 'function f() {', '  return 1;', '}', 'f();', 'g();'];
    const ms = computeMetrics({ files: [file('a.ts', 6)], added: [lines('a.ts', texts)], fileLines: {}, profile: profile() });
    expect(metric(ms, 'comment_ratio')).toMatchObject({ value: 'n/a', over: false });
  });

  it('lock files, build output and logs are not counted: a dependency bump is not a 5000-line ticket', () => {
    const files = [file('package-lock.json', 4990, 10), file('dist/app.js', 800), file('src/a.ts', 10, 2), file('debug.log', 300)];
    const ms = computeMetrics({ files, added: [lines('package-lock.json', ['x', 'y'])], fileLines: { 'package-lock.json': 9000, 'src/a.ts': 50 }, profile: profile() });
    expect(metric(ms, 'diff_lines')).toMatchObject({ value: 12, over: false });
    expect(metric(ms, 'files_touched')).toMatchObject({ value: 1, over: false });
    expect(metric(ms, 'file_lines')).toMatchObject({ value: 50, where: 'src/a.ts' });
  });

  it('a diff of only generated files has nothing to count: n/a, not 0', () => {
    const ms = computeMetrics({ files: [file('yarn.lock', 900)], added: [], fileLines: {}, profile: profile() });
    expect(metric(ms, 'diff_lines').value).toBe('n/a');
  });
});
