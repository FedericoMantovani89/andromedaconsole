import { describe, expect, it } from 'vitest';
import { quoteForShell, runStyleCommand } from '../src/server/audit/commands';
import type { TestRunner } from '../src/server/tickets/test-queue';

const ok = (tail = ''): ReturnType<TestRunner> => Promise.resolve({ ok: true, code: 0, tail });
const fake = (answer: (command: string) => ReturnType<TestRunner>): { run: TestRunner; commands: string[] } => {
  const commands: string[] = [];
  return { commands, run: (o) => { commands.push(o.command); return answer(o.command); } };
};
const base = { cwd: '.', timeoutMs: 1000, owner: 't' };

describe('quoteForShell', () => {
  it('double-quotes for cmd and single-quotes for sh, escaping a quote of the latter', () => {
    expect(quoteForShell('a b.ts', 'win32')).toBe('"a b.ts"');
    expect(quoteForShell('x;rm.ts', 'linux')).toBe("'x;rm.ts'");
    expect(quoteForShell("it's.ts", 'linux')).toBe("'it'\\''s.ts'");
  });
});

describe('runStyleCommand', () => {
  it('replaces {files} with the changed files, each quoted on its own', async () => {
    const f = fake(() => ok('clean'));
    const r = await runStyleCommand({ ...base, id: 'lint', command: 'npx eslint {files}', files: ['a b.ts', 'x;rm.ts'], run: f.run, platform: 'linux' });
    expect(f.commands).toEqual(["npx eslint 'a b.ts' 'x;rm.ts'"]);
    expect(r).toMatchObject({ id: 'lint', ran: true, ok: true, output: 'clean' });
  });

  it('puts the file names in literally: a dollar sign is not a replacement pattern, and every {files} gets them', async () => {
    const f = fake(() => ok());
    await runStyleCommand({ ...base, id: 'lint', command: 'a {files} b {files}', files: ['app/$$x/page.ts', 'it$&.ts'], run: f.run, platform: 'linux' });
    expect(f.commands).toEqual(["a 'app/$$x/page.ts' 'it$&.ts' b 'app/$$x/page.ts' 'it$&.ts'"]);
  });

  it('runs a command without {files} as it is', async () => {
    const f = fake(() => ok());
    await runStyleCommand({ ...base, id: 'lint', command: 'npm run lint', files: ['a.ts'], run: f.run });
    expect(f.commands).toEqual(['npm run lint']);
  });

  it('reports "not run" with a reason, never ok', async () => {
    const none = await runStyleCommand({ ...base, id: 'lint', command: undefined, files: ['a.ts'] });
    expect(none).toMatchObject({ ran: false, reason: 'no_command' });
    expect(none.ok).toBeUndefined();
    const noFiles = await runStyleCommand({ ...base, id: 'lint', command: 'x {files}', files: [] });
    expect(noFiles).toMatchObject({ ran: false, reason: 'no_files' });
    const slow = await runStyleCommand({ ...base, id: 'lint', command: 'x {files}', files: ['a.ts'], run: () => Promise.resolve({ ok: false, code: null, tail: 'partial', timedOut: true }) });
    expect(slow).toMatchObject({ ran: false, reason: 'timeout' });
    for (const code of [127, 9009]) {
      const missing = await runStyleCommand({ ...base, id: 'lint', command: 'x {files}', files: ['a.ts'], run: () => Promise.resolve({ ok: false, code, tail: 'not found' }) });
      expect(missing, String(code)).toMatchObject({ ran: false, reason: 'spawn_failed' });
    }
  });

  it('a failing linter ran and is not ok (the output is advice, not a gate)', async () => {
    const r = await runStyleCommand({ ...base, id: 'format_check', command: 'x {files}', files: ['a.ts'], run: () => Promise.resolve({ ok: false, code: 1, tail: '2 problems' }) });
    expect(r).toMatchObject({ id: 'format_check', ran: true, ok: false, output: '2 problems' });
  });

  it('cuts an over-long output with a marker', async () => {
    const r = await runStyleCommand({ ...base, id: 'lint', command: 'x {files}', files: ['a.ts'], run: () => ok('z'.repeat(30_000)) });
    expect(r.output.length).toBeLessThan(20_100);
    expect(r.output).toContain('[output cut]');
  });

  it('skips a file whose name cannot be quoted safely and says so', async () => {
    const f = fake(() => ok());
    const r = await runStyleCommand({ ...base, id: 'lint', command: 'x {files}', files: ['good.ts', 'bad"name.ts', '100%.ts'], run: f.run, platform: 'linux' });
    expect(f.commands).toEqual(["x 'good.ts'"]);
    expect(r.output).toContain('bad"name.ts');
    expect(r.output).toContain('100%.ts');
  });

  it('splits a long file list into several runs and is ok only when all are', async () => {
    const files = Array.from({ length: 400 }, (_, i) => `src/some/long/folder/name/file-number-${i}.ts`);
    let n = 0;
    const f = fake(() => (++n === 2 ? Promise.resolve({ ok: false, code: 1, tail: 'second failed' }) : ok('fine')));
    const r = await runStyleCommand({ ...base, id: 'lint', command: 'x {files}', files, run: f.run, platform: 'linux' });
    expect(f.commands.length).toBeGreaterThan(1);
    expect(f.commands.every((c) => c.length < 7100)).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('second failed');
  });
});
