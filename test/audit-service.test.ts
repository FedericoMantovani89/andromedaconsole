import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitSync, makeRepo, removeDir, type TestRepo } from './git-helpers';
import { loadBundles } from '../src/server/i18n-bundles';
import { createTranslator } from '../src/shared/i18n';
import { AuditService, type AuditDeps } from '../src/server/audit/service';
import { changedFiles } from '../src/server/git/merge';
import { readAudit } from '../src/server/audit/report';
import type { TestRunner } from '../src/server/tickets/test-queue';

vi.setConfig({ testTimeout: 60_000 });

const bundles = loadBundles();
let t: TestRepo;
let styleDir: string;
let sha: string;
let commands: string[];
let settings: AuditDeps['settings'] extends () => infer S ? S : never;
let lint: string | undefined;
let run: TestRunner;
let svc: AuditService;

const lines = (n: number): string => `${Array.from({ length: n }, (_, i) => `line ${i}`).join('\n')}\n`;
function commitFile(path: string, content: string): string {
  mkdirSync(join(t.repo, path, '..'), { recursive: true });
  writeFileSync(join(t.repo, path), content);
  gitSync(t.repo, 'add', '-A');
  gitSync(t.repo, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'work');
  return gitSync(t.repo, 'rev-parse', 'HEAD');
}
function style(name: string, text: string): void {
  mkdirSync(styleDir, { recursive: true });
  writeFileSync(join(styleDir, `${name}.md`), text);
}
const measure = async (o: { rerun?: boolean } = {}) =>
  svc.measure({ slug: 'a-job', cwd: t.repo, base: 'main', sha, files: (await changedFiles(t.repo, 'main', sha))!, ...o });

beforeEach(() => {
  t = makeRepo();
  styleDir = mkdtempSync(join(tmpdir(), 'audit-style-'));
  gitSync(t.repo, 'checkout', '-q', '-b', 'work');
  commands = [];
  settings = { level: 'metrics', autoModel: false, profile: 'default' };
  lint = undefined;
  run = async (o) => { commands.push(o.command); return { ok: true, code: 0, tail: 'clean' }; };
  svc = new AuditService({
    root: t.repo, settings: () => settings, userStyleDir: styleDir, testTimeoutMs: () => 30_000, runCommand: (o) => run(o), lintCommand: () => lint,
    language: () => ({ lang: 'en', t: createTranslator({ lang: 'en', messages: bundles.get('en') ?? {}, fallback: bundles.get('en') }) }),
  });
});
afterEach(() => removeDir(t.base));

describe('AuditService.measure', () => {
  it('does nothing at level off: no report, no files', async () => {
    sha = commitFile('src/a.js', lines(300));
    settings = { ...settings, level: 'off' };
    expect(await measure()).toBeUndefined();
    expect(existsSync(join(t.repo, '.andromedaconsole', 'tickets', 'a-job'))).toBe(false);
  });

  it('a 300-line diff over the default limit of 250 is split_first and leaves the files of that sha', async () => {
    sha = commitFile('src/a.js', lines(300));
    const r = await measure();
    expect(r).toMatchObject({ verdict: 'split_first', level: 'metrics', profile: 'default', modelRan: false, sha });
    expect(r!.metrics.find((m) => m.id === 'diff_lines')).toMatchObject({ value: 300, limit: 250, over: true });
    expect(readAudit(t.repo, 'a-job', sha)?.verdict).toBe('split_first');
  });

  it('a limit of 0 in the active profile is not checked: the same diff is ready', async () => {
    sha = commitFile('src/a.js', lines(300));
    style('lax', '---\nname: lax\nlimits:\n  diff_lines: 0\n---\nrelaxed');
    settings = { ...settings, profile: 'lax' };
    expect((await measure())!.verdict).toBe('ready');
  });

  it('measures a small diff as ready', async () => {
    sha = commitFile('src/a.js', lines(20));
    expect((await measure())!.verdict).toBe('ready');
  });

  it('reads the report of the same sha instead of running the commands again, unless asked', async () => {
    sha = commitFile('src/a.js', lines(20));
    style('linted', '---\nname: linted\ncommands:\n  lint: npx eslint {files}\n---\nx');
    settings = { ...settings, profile: 'linted' };
    await measure();
    await measure();
    expect(commands).toHaveLength(1);
    await measure({ rerun: true });
    expect(commands).toHaveLength(2);
  });

  it('runs the profile\'s lint command on the changed files and keeps its output', async () => {
    sha = commitFile('src/a.js', lines(5));
    style('linted', '---\nname: linted\ncommands:\n  lint: npx eslint {files}\n---\nx');
    settings = { ...settings, profile: 'linted' };
    run = async (o) => { commands.push(o.command); return { ok: false, code: 1, tail: '1 problem' }; };
    const r = await measure();
    expect(commands[0]).toContain('src/a.js');
    expect(r!.layerTwo.find((l) => l.id === 'lint')).toMatchObject({ ran: true, ok: false, output: '1 problem' });
    expect(r!.layerTwo.find((l) => l.id === 'format_check')).toMatchObject({ ran: false, reason: 'no_command' });
    expect(r!.verdict).toBe('ready'); // advice, not a gate
  });

  it('falls back to the project\'s own lint command when the profile has none', async () => {
    sha = commitFile('src/a.js', lines(5));
    lint = 'npm run lint';
    await measure();
    expect(commands).toEqual(['npm run lint']);
  });

  it('a profile that cannot be loaded falls back to the default and says so', async () => {
    sha = commitFile('src/a.js', lines(20));
    style('broken', '---\nname: broken\nlimits:\n  diff_lines: abc\n---\nx');
    settings = { ...settings, profile: 'broken' };
    const r = await measure();
    expect(r!.profile).toBe('default');
    expect(r!.notRun).toContain('profile_fallback:broken');
    settings = { ...settings, profile: 'missing-one' };
    expect((await measure({ rerun: true }))!.notRun).toContain('profile_fallback:missing-one');
  });

  it('a new sha is a new audit and the old files stay', async () => {
    sha = commitFile('src/a.js', lines(20));
    const first = sha;
    await measure();
    sha = commitFile('src/b.js', lines(30));
    await measure();
    expect(readAudit(t.repo, 'a-job', first)).toBeDefined();
    expect(readAudit(t.repo, 'a-job', sha)).toBeDefined();
  });
});

describe('the saved report follows what the profile says now', () => {
  it('editing the limits of the profile in force measures the same commit again', async () => {
    sha = commitFile('src/a.js', lines(20));
    style('tuned', '---\nname: tuned\nlimits:\n  diff_lines: 5\n---\nx');
    settings = { ...settings, profile: 'tuned' };
    expect((await measure())!.verdict).toBe('split_first');
    style('tuned', '---\nname: tuned\nlimits:\n  diff_lines: 0\n---\nx'); // the user raised the limit in Options
    expect((await measure())!.verdict).toBe('ready');
  });

  it('changing the lint command measures it again, and an unchanged profile does not', async () => {
    sha = commitFile('src/a.js', lines(5));
    style('lintme', '---\nname: lintme\ncommands:\n  lint: first {files}\n---\nx');
    settings = { ...settings, profile: 'lintme' };
    await measure();
    await measure();
    expect(commands).toEqual([expect.stringContaining('first')]);
    style('lintme', '---\nname: lintme\ncommands:\n  lint: second {files}\n---\nx');
    await measure();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain('second');
  });
});
