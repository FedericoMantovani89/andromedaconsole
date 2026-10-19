import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBundles } from '../src/server/i18n-bundles';
import { createTranslator } from '../src/shared/i18n';
import { buildReport, isDocFile, reportPath, squashMessage, writeReport, type ReportInput } from '../src/server/tickets/report';
import { removeDir } from './git-helpers';

const bundles = loadBundles();
const translator = (lang: string) => createTranslator({ lang, messages: bundles.get(lang) ?? {}, fallback: bundles.get('en') });

const base = (over: Partial<ReportInput> = {}): ReportInput => ({
  slug: 'add-multiply', project: 'shop-api', branch: 'agent/shop-api/add-multiply', lang: 'en', t: translator('en'),
  goal: 'Add multiply(a, b) to src/math.js with a test.',
  steps: [
    { n: 1, title: 'Study the code', done: true, note: 'math.js is tiny; tests use node:test' },
    { n: 2, title: 'Tests first: multiply', done: true, note: 'red on purpose' },
    { n: 3, title: 'Implement multiply', done: true },
    { n: 4, title: 'Validation: node --test', done: true },
    { n: 5, title: 'Update documentation', done: true, note: 'README lists multiply now' },
  ],
  files: [{ path: 'src/math.js', added: 3, removed: 0 }, { path: 'test/math.test.js', added: 8, removed: 1 }, { path: 'README.md', added: 1, removed: 0 }],
  tests: { ok: true, command: 'node --test', tail: 'ok', sha: 'abcdef1234567', at: '2026-10-05T10:00:00Z' },
  docsNote: 'README lists multiply now',
  verdicts: [],
  generatedAt: '2026-10-05T10:05:00Z',
  ...over,
});

describe('buildReport', () => {
  it('has frontmatter with the language and the sections of SPEC 15.6, in English', () => {
    const text = buildReport(base());
    expect(text.startsWith('---\nticket: add-multiply\nproject: shop-api\nbranch: agent/shop-api/add-multiply\nlang: en\n')).toBe(true);
    for (const h of ['## Objective', '## Checklist (5/5)', '## Files touched', '## Tests', '## Documentation', '## Decisions and doubts']) expect(text, h).toContain(h);
    expect(text).toContain('Add multiply(a, b) to src/math.js with a test.');
  });
  it('headings follow the language and the frontmatter records it', () => {
    const text = buildReport(base({ lang: 'it', t: translator('it') }));
    expect(text).toContain('lang: it');
    expect(text).toContain('## Obiettivo');
    expect(text).toContain('## File toccati');
    expect(text).toContain('## Decisioni e dubbi');
    expect(text).not.toContain('## Objective');
  });
  it('the numbers come from the inputs: files, added and removed lines', () => {
    const text = buildReport(base());
    expect(text).toContain('3 files, +12 -1');
    expect(text).toContain('`src/math.js` (+3 -0)');
    expect(text).toContain('`test/math.test.js` (+8 -1)');
  });
  it('a binary file (no line counts) is listed without numbers and does not break the total', () => {
    const text = buildReport(base({ files: [{ path: 'logo.png', added: null, removed: null }, { path: 'a.ts', added: 2, removed: 1 }] }));
    expect(text).toContain('`logo.png`');
    expect(text).toContain('2 files, +2 -1');
  });
  it('one file uses the singular form', () => {
    expect(buildReport(base({ files: [{ path: 'a.ts', added: 1, removed: 0 }] }))).toContain('1 file, +1 -0');
  });
  it('the test result is the console\'s: command, outcome and commit', () => {
    const ok = buildReport(base());
    expect(ok).toContain('`node --test`');
    expect(ok).toMatch(/passed/);
    expect(ok).toContain('abcdef1');
    const bad = buildReport(base({ tests: { ok: false, command: 'npm test', tail: '1 failing: add', sha: 'abcdef1234567', at: 'x' } }));
    expect(bad).toMatch(/failed/);
    expect(bad).toContain('1 failing: add');
  });
  it('missing data is n/a, never a made-up value (no tests, no goal, no files)', () => {
    const text = buildReport(base({ tests: undefined, goal: undefined, files: [], docsNote: undefined }));
    expect(text).toMatch(/## Objective\n\nn\/a/);
    expect(text).toMatch(/## Tests\n\nn\/a/);
    expect(text).toMatch(/## Files touched\n\nn\/a/);
  });
  it('what the agent says about its own test run is its own line, labelled, next to the console\'s (tests switched off)', () => {
    const text = buildReport(base({ tests: undefined, testsInhibited: true, agentTests: { command: 'npm test', result: 'passed', summary: '358 tests ok' } }));
    expect(text).toContain('Not run: the tests are switched off for this project.');
    expect(text).toContain('Reported by the agent, not verified by the console: passed (`npm test`) - 358 tests ok');
    expect(text.indexOf('Not run:')).toBeLessThan(text.indexOf('Reported by the agent'));
  });
  it('an agent failure is shown as failed; with the console\'s own run both are there', () => {
    const text = buildReport(base({ agentTests: { command: 'npm run lint', result: 'failed' } }));
    expect(text).toContain('Reported by the agent, not verified by the console: failed (`npm run lint`)');
    expect(text).toContain('Result: passed (on commit abcdef1)');
  });
  it('without an agent report the agent line is n/a, never passed', () => {
    const text = buildReport(base({ tests: undefined, testsInhibited: true }));
    expect(text).toContain('Reported by the agent, not verified by the console: n/a');
    expect(text).not.toMatch(/Reported by the agent[^\n]*passed/);
  });
  it('a ticket started after another agent says so under the objective, with the reason as one plain line, in both languages', () => {
    const after = { name: 'dba-schema', reason: 'the API tests need\nthe real `migration`\n## Fake heading' };
    const en = buildReport(base({ after }));
    expect(en).toContain('Started after the agent dba-schema, on top of its work. Why: the API tests need the real migration ## Fake heading');
    expect(en.split('\n').filter((l) => l.startsWith('## Fake'))).toEqual([]);
    expect(en.indexOf('Started after')).toBeGreaterThan(en.indexOf('## Objective'));
    expect(en.indexOf('Started after')).toBeLessThan(en.indexOf('## Checklist'));
    const itText = buildReport(base({ lang: 'it', t: translator('it'), after }));
    expect(itText).toContain('Avviato dopo l\'agente dba-schema, sopra il suo lavoro. Perché: the API tests need the real migration ## Fake heading');
    expect(itText).not.toContain('Started after');
    // no line without a dependency
    expect(buildReport(base())).not.toContain('Started after');
  });
  it('the agent\'s command and summary are one plain line: no backticks, no new line, no heading', () => {
    const text = buildReport(base({ agentTests: { command: 'npm `test`', result: 'passed', summary: 'ok\n## Fake heading\n- [x] done' } }));
    expect(text.split('\n').filter((l) => l.startsWith('## Fake'))).toEqual([]);
    expect(text).toContain('passed (`npm test`) - ok ## Fake heading - [x] done');
  });
  it('the agent line follows the language', () => {
    const text = buildReport(base({ lang: 'it', t: translator('it'), agentTests: { command: 'npm test', result: 'passed' } }));
    expect(text).toContain('Dichiarato dall\'agente, non verificato dalla console: superati (`npm test`)');
    expect(text).not.toContain('Reported by the agent');
    expect(buildReport(base({ lang: 'it', t: translator('it') }))).toContain('Dichiarato dall\'agente, non verificato dalla console: n/d');
  });
  it('step notes are kept verbatim, in the language the agent wrote, under decisions and doubts', () => {
    const text = buildReport(base({ steps: [{ n: 1, title: 'Study', done: true, note: 'Ho trovato il problema nel mapper.\nDubbio: il caso SPEDITO.' }] }));
    expect(text).toContain('> Ho trovato il problema nel mapper.\n> Dubbio: il caso SPEDITO.');
  });
  it('agent text is data: markdown and HTML inside a note stay inside its quote block', () => {
    const text = buildReport(base({ steps: [{ n: 1, title: 'Study', done: true, note: '## Not a heading\n<script>alert(1)</script>\n---' }] }));
    expect(text).toContain('> ## Not a heading');
    expect(text).toContain('> <script>alert(1)</script>');
    expect(text).toContain('> ---');
    expect(text.split('\n').filter((l) => l === '## Not a heading')).toEqual([]);
  });
  it('a skipped step says so', () => {
    const text = buildReport(base({ steps: [{ n: 1, title: 'Study', done: true, skipped: true, note: 'not needed here at all' }] }));
    expect(text).toMatch(/skipped/);
  });
  it('documentation: lists changed doc files, else the note of the documentation step, else says none', () => {
    expect(buildReport(base())).toContain('`README.md`');
    const noFiles = buildReport(base({ files: [{ path: 'a.ts', added: 1, removed: 0 }], docsNote: 'nothing to document here' }));
    expect(noFiles).toContain('nothing to document here');
    expect(buildReport(base({ files: [{ path: 'a.ts', added: 1, removed: 0 }], docsNote: undefined }))).toContain('no documentation file changed');
  });
  it('the review section lists the rounds with their notes', () => {
    const text = buildReport(base({
      verdicts: [
        { round: 1, pass: false, reviewer: 'review-add-multiply', at: 'x', notes: [{ severity: 'high', where: 'src/math.js:3', text: 'negative input not handled' }] },
        { round: 2, pass: true, reviewer: 'review-add-multiply', at: 'y', notes: [] },
      ],
    }));
    expect(text).toContain('## Review');
    expect(text).toMatch(/Round 1: not passed/);
    expect(text).toContain('src/math.js:3');
    expect(text).toContain('negative input not handled');
    expect(text).toMatch(/Round 2: passed/);
  });
  it('a frontmatter value that is not plain is not written (it could break the header)', () => {
    const text = buildReport(base({ slug: 'a\nlang: evil', project: 'p---', branch: 'b\r\nx' }));
    expect(text.split('\n---\n')[0]).not.toContain('evil');
    expect(text.split('\n').filter((l) => l.startsWith('lang:'))).toEqual(['lang: en']);
  });
});

describe('squashMessage', () => {
  const sq = (over: Record<string, unknown> = {}) => squashMessage({ ...base(), ...over } as never);
  it('is English, subject first, trailers last', () => {
    const m = sq();
    const lines = m.split('\n');
    expect(lines[0]).toBe('ticket add-multiply: Add multiply(a, b) to src/math.js with a test.');
    expect(lines[1]).toBe('');
    expect(m).toContain('Files: 3 changed (+12 -1)');
    expect(m).toContain('Tests: passed (node --test)');
    expect(m).toContain('Steps: 5/5');
    expect(m.trimEnd().split('\n').slice(-3)).toEqual(['Agent: add-multiply', 'Ticket: add-multiply', 'Progetto: shop-api']);
  });
  it('keeps a long goal short and uses only its first line in the subject', () => {
    const m = sq({ goal: `${'word '.repeat(60)}\nsecond line` });
    expect(m.split('\n')[0]!.length).toBeLessThanOrEqual(100);
    expect(m.split('\n')[0]).not.toContain('second line');
  });
  it('does not depend on the interface language', () => {
    expect(sq({ lang: 'it', t: translator('it') })).toBe(sq());
  });
  it('names the reviewer when the review passed', () => {
    const m = sq({ verdicts: [{ round: 1, pass: true, reviewer: 'review-add-multiply', at: 'x', notes: [] }] });
    expect(m).toContain('Reviewed-by: review-add-multiply (round 1)');
  });
  it('no goal: the subject still says which ticket', () => {
    expect(sq({ goal: undefined }).split('\n')[0]).toBe('ticket add-multiply');
  });
});

describe('isDocFile', () => {
  it.each(['README.md', 'docs/guide.md', 'CHANGELOG.md', 'docs/api/index.html', 'src/main/java/A.java.md', 'readme.txt', 'CONTRIBUTING.md'])('%s is documentation', (p) => expect(isDocFile(p)).toBe(true));
  it.each(['src/a.ts', 'package.json', 'test/readme.test.ts', 'src/docs.ts', 'dist/readme.js'])('%s is not', (p) => expect(isDocFile(p)).toBe(false));
});

let dir: string;
afterEach(() => { if (dir) removeDir(dir); });
describe('writeReport', () => {
  it('writes .andromedaconsole/tickets/<slug>/report.md and replaces an older one', () => {
    dir = mkdtempSync(join(tmpdir(), 'rep-'));
    const file = writeReport(dir, 'add-multiply', 'first');
    expect(file).toBe(reportPath(dir, 'add-multiply'));
    expect(file.replace(/\\/g, '/')).toMatch(/\.andromedaconsole\/tickets\/add-multiply\/report\.md$/);
    writeReport(dir, 'add-multiply', 'second');
    expect(readFileSync(file, 'utf8')).toBe('second');
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
  it('refuses a slug that could leave the folder', () => {
    dir = mkdtempSync(join(tmpdir(), 'rep-'));
    expect(() => writeReport(dir, '../evil', 'x')).toThrow();
    expect(() => reportPath(dir, 'a/b')).toThrow();
  });
});

describe('review findings: text written by agents cannot break the report', () => {
  it('a goal in the spec\'s own format (with # headings and a --- line) stays inside its quote block under Objective', () => {
    const goal = '# Obiettivo\nAggiungere il campo stato\n\n---\n# Vincoli\nNessuna migrazione';
    const text = buildReport(base({ goal }));
    const lines = text.split('\n');
    expect(lines.filter((l) => l === '# Obiettivo' || l === '# Vincoli' || l === '---').length).toBe(2); // only the frontmatter fences remain
    expect(text).toContain('> # Obiettivo');
    expect(text).toContain('> ---');
    expect(lines.filter((l) => /^#{1,2} /.test(l)).map((l) => l.replace(/ \(.*/, ''))).toEqual(['# add-multiply', '## Objective', '## Checklist', '## Files touched', '## Tests', '## Documentation', '## Decisions and doubts']);
  });
  it('a review note\'s "where" is one line and cannot open a heading or a code span', () => {
    const where = 'a.ts:1`\n## Tests\nPASSED (fake)';
    const text = buildReport(base({ verdicts: [{ round: 1, pass: false, reviewer: 'review-x', at: 'x', notes: [{ severity: 'high', where, text: 'bug' }] }] }));
    expect(text.split('\n').filter((l) => l === '## Tests')).toHaveLength(1); // the real one only
    expect(text).not.toContain('PASSED (fake)\n');
  });
});
