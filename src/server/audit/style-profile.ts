import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../config';
import { parseFrontmatter } from '../frontmatter';
import { resourcePath } from '../paths';
import { SLUG_RE } from '../../shared/slug';

/** The numbers the console measures on a diff (layer 1). `0` means "not checked". */
export const LIMIT_IDS = ['diff_lines', 'files_touched', 'file_lines', 'comment_run_lines', 'comment_ratio'] as const;
export type LimitId = (typeof LIMIT_IDS)[number];

export const LIMIT_RANGES: Record<LimitId, readonly [number, number]> = {
  diff_lines: [0, 100_000], files_touched: [0, 100_000], file_lines: [0, 100_000], comment_run_lines: [0, 100_000], comment_ratio: [0, 1],
};

/** Same numbers as `prompts/style/default.md` (a test keeps the two equal): a profile that states only some limits keeps these for the rest. */
export const DEFAULT_LIMITS: Record<LimitId, number> = { diff_lines: 250, files_touched: 8, file_lines: 600, comment_run_lines: 4, comment_ratio: 0.15 };

export const COMMAND_IDS = ['lint', 'format_check'] as const;
export type CommandId = (typeof COMMAND_IDS)[number];
const MAX_COMMAND = 500;

export type StyleSource = 'project' | 'user' | 'shipped';

export interface StyleProfile {
  name: string;
  description: string;
  limits: Record<LimitId, number>;
  /** Commands run on the changed files (layer 2); `{files}` is replaced by them. */
  commands: Partial<Record<CommandId, string>>;
  /** Free text for the model, in the user's own language. */
  conventions: string;
  source: StyleSource;
}

export type StyleParse =
  | { ok: true; profile: StyleProfile }
  | { ok: false; code: 'style.badLimit' | 'style.badCommand'; params: { key: string } };

const isLimitId = (k: string): k is LimitId => (LIMIT_IDS as readonly string[]).includes(k);
const isCommandId = (k: string): k is CommandId => (COMMAND_IDS as readonly string[]).includes(k);

/** Parses and validates one style file (also used for an import): the keys are English codes, the body and description are free text. */
export function parseStyleProfile(text: string, name: string, source: StyleSource): StyleParse {
  const { meta, blocks, body } = parseFrontmatter(text);
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, raw] of Object.entries(blocks.limits ?? {})) {
    if (!isLimitId(key)) return { ok: false, code: 'style.badLimit', params: { key } };
    const v = Number(raw);
    const [lo, hi] = LIMIT_RANGES[key];
    const whole = key === 'comment_ratio' || Number.isInteger(v);
    if (raw === '' || !Number.isFinite(v) || !whole || v < lo || v > hi) return { ok: false, code: 'style.badLimit', params: { key } };
    limits[key] = v;
  }
  const commands: StyleProfile['commands'] = {};
  for (const [key, raw] of Object.entries(blocks.commands ?? {})) {
    if (!isCommandId(key) || raw === '' || raw.length > MAX_COMMAND || /[\r\n]/.test(raw)) return { ok: false, code: 'style.badCommand', params: { key } };
    commands[key] = raw;
  }
  return { ok: true, profile: { name, description: meta.description ?? '', limits, commands, conventions: body, source } };
}

/** The file form of a profile; `parseStyleProfile(serializeStyleProfile(p))` gives `p` back. */
export function serializeStyleProfile(p: StyleProfile): string {
  const lines = ['---', `name: ${p.name}`];
  if (p.description) lines.push(`description: ${p.description.replace(/[\r\n]+/g, ' ')}`);
  lines.push('limits:', ...LIMIT_IDS.map((id) => `  ${id}: ${p.limits[id]}`));
  const cmds = COMMAND_IDS.filter((id) => p.commands[id] !== undefined);
  if (cmds.length > 0) lines.push('commands:', ...cmds.map((id) => `  ${id}: ${p.commands[id]}`));
  lines.push('---', p.conventions);
  return `${lines.join('\n')}\n`;
}

const projectDir = (root: string): string => join(root, '.andromedaconsole', 'style');
const shippedDir = (): string => join(resourcePath('prompts'), 'style');

function readOne(file: string, name: string, source: StyleSource): StyleProfile | undefined {
  if (!existsSync(file)) return undefined;
  const r = parseStyleProfile(readFileSync(file, 'utf8'), name, source);
  return r.ok ? r.profile : undefined;
}

/** SPEC 11.4 order, like the role profiles: the project's file wins over the user's, which wins over the shipped one. */
export function loadStyleProfile(name: string, projectRoot: string, userDir: string = join(configDir(), 'style')): StyleProfile | undefined {
  if (!SLUG_RE.test(name)) return undefined; // also rules out path traversal
  return readOne(join(projectDir(projectRoot), `${name}.md`), name, 'project')
    ?? readOne(join(userDir, `${name}.md`), name, 'user')
    ?? readOne(join(shippedDir(), `${name}.md`), name, 'shipped');
}

function namesIn(dir: string): string[] {
  try { return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).filter((n) => SLUG_RE.test(n)); } catch { return []; }
}

/** Every profile a project can pick, once, with the source that wins: the shipped ones first, then the others by name. */
export function listStyleProfiles(projectRoot: string, userDir: string = join(configDir(), 'style')): { name: string; source: StyleSource }[] {
  const shipped = namesIn(shippedDir());
  const others = [...new Set([...namesIn(userDir), ...namesIn(projectDir(projectRoot))])].filter((n) => !shipped.includes(n)).sort();
  return [...shipped, ...others].flatMap((name) => {
    const p = loadStyleProfile(name, projectRoot, userDir);
    return p ? [{ name, source: p.source }] : [];
  });
}

/** Which layers have a file for this name: the shipped one, the user's and the project's. */
export function styleFilesOf(name: string, projectRoot: string, userDir: string = join(configDir(), 'style')): { shipped: boolean; user: boolean; project: boolean } {
  if (!SLUG_RE.test(name)) return { shipped: false, user: false, project: false };
  return {
    shipped: existsSync(join(shippedDir(), `${name}.md`)),
    user: existsSync(join(userDir, `${name}.md`)),
    project: existsSync(join(projectDir(projectRoot), `${name}.md`)),
  };
}

/** Where the file of one layer lives (it may not exist). The name must be a valid slug: the caller checks. */
export function styleFileFor(name: string, source: StyleSource, projectRoot: string, userDir: string = join(configDir(), 'style')): string {
  return join(source === 'project' ? projectDir(projectRoot) : source === 'user' ? userDir : shippedDir(), `${name}.md`);
}
