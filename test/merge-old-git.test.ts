import { expect, it, vi } from 'vitest';

vi.mock('../src/server/git/git', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/server/git/git')>();
  return { ...real, git: vi.fn() };
});

import { git } from '../src/server/git/git';
import { mergeIntoProject } from '../src/server/git/merge';

const result = (code: number, stdout = '', stderr = '') => ({ code, stdout, stderr });

it('a git older than 2.40 (merge-tree without --merge-base) is named as the reason the squash of a dependent ticket cannot run', async () => {
  vi.mocked(git).mockImplementation(async (_cwd, args) => {
    if (args[0] === 'rev-parse') return result(0, 'a'.repeat(40));
    if (args[0] === 'merge-tree') return result(129, '', 'error: unknown option `merge-base=abc\'\nusage: git merge-tree [<options>] <branch1> <branch2>');
    return result(0);
  });
  const out = await mergeIntoProject({ wt: 'x', sha: 'b'.repeat(40), message: 'm', squash: true, base: 'c'.repeat(40) });
  expect(out).toMatchObject({ ok: false, kind: 'failed' });
  expect((out as { detail: string }).detail).toContain('needs git 2.40 or later');
  // nothing was touched in the worktree
  expect(vi.mocked(git).mock.calls.map((c) => c[1][0])).toEqual(['rev-parse', 'merge-tree']);
});
