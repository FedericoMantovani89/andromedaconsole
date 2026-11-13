import { git } from '../git/git';
import type { AddedFile } from './metrics';

const MAX_COUNTED_FILES = 200;
const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The added lines of every text file in `base...sha` (the same three-dot range the report's file list uses), each with its line number
 * in the new file. The hunk counts tell where a hunk ends, so a content line that looks like a header (`+++ b/x`) is never taken for one.
 * A binary file has no hunks and so no entry. `undefined` when git cannot make the range.
 */
export async function addedLines(cwd: string, base: string, sha: string): Promise<AddedFile[] | undefined> {
  const r = await git(cwd, ['-c', 'core.quotepath=off', 'diff', '-U0', '--no-color', '--no-renames', `${base}...${sha}`]);
  if (r.code !== 0) return undefined;
  const files: AddedFile[] = [];
  let cur: AddedFile | undefined;
  let remOld = 0;
  let remNew = 0;
  let n = 0;
  for (const raw of r.stdout.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (remOld > 0 || remNew > 0) {
      if (line.startsWith('+')) { cur?.lines.push({ n, text: line.slice(1) }); n++; remNew--; }
      else if (line.startsWith('-')) remOld--;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/\t$/, '');
      cur = path === '/dev/null' ? undefined : { path: path.startsWith('b/') ? path.slice(2) : path, lines: [] };
      if (cur) files.push(cur);
      continue;
    }
    const h = HUNK.exec(line);
    if (h) {
      remOld = h[1] === undefined ? 1 : Number(h[1]);
      n = Number(h[2]);
      remNew = h[3] === undefined ? 1 : Number(h[3]);
    }
  }
  return files.filter((f) => f.lines.length > 0);
}

/** Line count of each file at `sha`; `undefined` for a binary, missing or unreadable one (never 0). Only the first 200 paths are read. */
export async function fileLineCounts(cwd: string, sha: string, paths: string[]): Promise<Record<string, number | undefined>> {
  const out: Record<string, number | undefined> = {};
  for (const [i, path] of paths.entries()) {
    out[path] = undefined;
    if (i >= MAX_COUNTED_FILES) continue;
    const r = await git(cwd, ['show', `${sha}:${path}`]);
    if (r.code !== 0 || r.stdout.includes('\0')) continue;
    const text = r.stdout;
    out[path] = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }
  return out;
}
