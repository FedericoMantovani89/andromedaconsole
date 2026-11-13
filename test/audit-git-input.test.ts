import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitSync, makeRepo, removeDir, type TestRepo } from './git-helpers';
import { addedLines, fileLineCounts } from '../src/server/audit/git-input';

vi.setConfig({ testTimeout: 60_000 });

let t: TestRepo;
let base: string;
let head: string;

beforeEach(() => {
  t = makeRepo();
  base = gitSync(t.repo, 'rev-parse', 'HEAD');
  mkdirSync(join(t.repo, 'src'), { recursive: true });
  writeFileSync(join(t.repo, 'src', 'a.ts'), 'one\ntwo\nthree\n');
  writeFileSync(join(t.repo, 'logo.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  writeFileSync(join(t.repo, 'README.md'), 'hello\n++ b/not-a-header\nlast\n'); // a content line that looks like a diff header
  gitSync(t.repo, 'add', '-A');
  gitSync(t.repo, 'commit', '-q', '-m', 'work');
  head = gitSync(t.repo, 'rev-parse', 'HEAD');
});
afterEach(() => removeDir(t.base));

describe('addedLines', () => {
  it('returns the added lines of each text file with their line numbers in the new file', async () => {
    const out = await addedLines(t.repo, base, head);
    expect(out).toBeDefined();
    const a = out!.find((f) => f.path === 'src/a.ts')!;
    expect(a.lines).toEqual([{ n: 1, text: 'one' }, { n: 2, text: 'two' }, { n: 3, text: 'three' }]);
    const readme = out!.find((f) => f.path === 'README.md')!;
    expect(readme.lines).toEqual([{ n: 2, text: '++ b/not-a-header' }, { n: 3, text: 'last' }]);
    expect(out!.some((f) => f.path === 'logo.bin')).toBe(false); // a binary file has no text lines
  });

  it('returns undefined when git cannot make the range', async () => {
    expect(await addedLines(t.repo, 'nosuchref', head)).toBeUndefined();
  });
});

describe('fileLineCounts', () => {
  it('counts lines of text files and leaves a binary or missing one undefined', async () => {
    const out = await fileLineCounts(t.repo, head, ['src/a.ts', 'logo.bin', 'gone.ts']);
    expect(out['src/a.ts']).toBe(3);
    expect(out['logo.bin']).toBeUndefined();
    expect(out['gone.ts']).toBeUndefined();
  });
});
