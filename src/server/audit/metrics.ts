import type { ChangedFile } from '../tickets/report';
import { isForeignPath } from '../tickets/foreign';
import { commentSyntaxFor, type CommentSyntax } from './comments';
import { LIMIT_IDS, type LimitId, type StyleProfile } from './style-profile';

/** The added lines of one file, each with its line number in the new file (lines of two hunks are never neighbours). */
export interface AddedFile { path: string; lines: { n: number; text: string }[] }

export type MetricValue = number | 'n/a';
export interface Metric { id: LimitId; value: MetricValue; limit: number; over: boolean; where?: string }

export interface MetricsInput {
  files: ChangedFile[];
  added: AddedFile[];
  /** Length of each changed file at the delivered commit; `undefined` for a binary or unreadable one. */
  fileLines: Record<string, number | undefined>;
  profile: StyleProfile;
}

interface CommentScan { comment: number; code: number; longest: { len: number; at: string } | undefined }

/** Classifies the added lines of one file. Structure only: no word lists, no word counts. A block comment is followed within its own hunk run. */
function scan(f: AddedFile, syntax: CommentSyntax): CommentScan {
  let comment = 0;
  let code = 0;
  let run = 0;
  let runStart = 0;
  let prev = -2;
  let inBlock = false;
  let longest: CommentScan['longest'];
  const endRun = (): void => {
    if (run > 0 && (!longest || run > longest.len)) longest = { len: run, at: `${f.path}:${runStart}` };
    run = 0;
  };
  for (const { n, text } of f.lines) {
    if (n !== prev + 1) { endRun(); inBlock = false; }
    prev = n;
    const t = text.trim();
    let isComment = false;
    if (t === '') { endRun(); continue; }
    if (inBlock) {
      isComment = true;
      if (syntax.block && t.includes(syntax.block[1])) inBlock = false;
    } else if (syntax.line.some((p) => t.startsWith(p))) {
      isComment = true;
    } else if (syntax.block && t.startsWith(syntax.block[0])) {
      isComment = true;
      inBlock = !t.slice(syntax.block[0].length).includes(syntax.block[1]);
    }
    if (isComment) {
      comment++;
      if (run === 0) runStart = n;
      run++;
    } else {
      code++;
      endRun();
    }
  }
  endRun();
  return { comment, code, longest };
}

/** A share of comments over fewer lines than this says nothing: one doc comment above a short function is 1/6 and not slop. */
const RATIO_MIN_LINES = 20;

const topFolder = (p: string): string => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '.');

/** Layer 1 of the audit (SPEC 15.7): the numbers the console measures itself. A limit of 0 is not checked; missing data is `n/a`, never 0. */
export function computeMetrics(i: MetricsInput): Metric[] {
  const out: Partial<Record<LimitId, Omit<Metric, 'id' | 'limit' | 'over'>>> = {};
  // Lock files, build output and logs are nobody's writing: a dependency bump is not a 5000-line ticket.
  const files = i.files.filter((f) => !isForeignPath(f.path));

  const countable = files.filter((f) => f.added !== null && f.removed !== null);
  out.diff_lines = { value: i.files.length > 0 && countable.length === 0 ? 'n/a' : countable.reduce((n, f) => n + f.added! + f.removed!, 0) };

  const folders = [...new Set(files.map((f) => topFolder(f.path)))];
  out.files_touched = { value: files.length, ...(folders.length > 0 ? { where: folders.slice(0, 5).join(', ') } : {}) };

  let longestFile: { len: number; path: string } | undefined;
  for (const f of files) {
    const len = i.fileLines[f.path];
    if (len !== undefined && (!longestFile || len > longestFile.len)) longestFile = { len, path: f.path };
  }
  out.file_lines = longestFile ? { value: longestFile.len, where: longestFile.path } : { value: 'n/a' };

  let comment = 0;
  let code = 0;
  let known = 0;
  let longest: CommentScan['longest'];
  for (const f of i.added) {
    if (isForeignPath(f.path)) continue;
    const syntax = commentSyntaxFor(f.path);
    if (!syntax) continue;
    known++;
    const s = scan(f, syntax);
    comment += s.comment;
    code += s.code;
    if (s.longest && (!longest || s.longest.len > longest.len)) longest = s.longest;
  }
  out.comment_run_lines = known === 0 ? { value: 'n/a' } : { value: longest?.len ?? 0, ...(longest ? { where: longest.at } : {}) };
  out.comment_ratio = known === 0 || comment + code < RATIO_MIN_LINES ? { value: 'n/a' } : { value: comment / (comment + code) };

  return LIMIT_IDS.map((id) => {
    const limit = i.profile.limits[id];
    const r = out[id]!;
    return { id, ...r, limit, over: limit > 0 && typeof r.value === 'number' && r.value > limit };
  });
}

/** The limits that are over: they gate the ticket (the rest of the audit is advice). */
export const gatingOver = (m: Metric[]): LimitId[] => m.filter((x) => x.over).map((x) => x.id);
