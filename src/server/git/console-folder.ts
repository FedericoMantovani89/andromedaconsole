import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Keeps the console's `.andromedaconsole` folder of `base` (the project folder, or an agent's worktree) out of git status and out of every
 * commit: a `.gitignore` with `*` inside the folder itself, so the rule lives and goes with it (nothing in the user's `.git/info/exclude`
 * or in the project's own `.gitignore`). Safe to repeat; an existing file is left alone.
 */
export function ignoreConsoleFolder(base: string): string {
  const dir = join(base, '.andromedaconsole');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '.gitignore');
  if (!existsSync(file)) writeFileSync(file, '*\n', 'utf8');
  return dir;
}

/**
 * For a folder the console made under a project's `.andromedaconsole` (a worktree, a try checkout): gives that `.andromedaconsole` its
 * `.gitignore`, wherever the first thing in it was made. Does nothing for a path that is not under one (the earlier worktree layout).
 */
export function ignoreConsoleFolderAbove(path: string): void {
  let dir = resolve(path);
  for (;;) {
    if (basename(dir) === '.andromedaconsole') { ignoreConsoleFolder(dirname(dir)); return; }
    const up = dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}
