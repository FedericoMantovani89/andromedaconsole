import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resourcePath } from './paths';
import { configDir } from './config';
import type { Profile } from '../shared/profile';
import { SLUG_RE } from '../shared/slug';

export type { Profile };

const promptsDir = (): string => resourcePath('prompts');

/** Frontmatter subset: top-level `key: value` lines; nested blocks (like `console:`) are skipped. */
function parseFrontmatter(text: string): { meta: Record<string, string>; consoleKeys: Record<string, string>; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { meta: {}, consoleKeys: {}, body: normalized.trim() };
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return { meta: {}, consoleKeys: {}, body: normalized.trim() };
  const meta: Record<string, string> = {};
  const consoleKeys: Record<string, string> = {};
  let block = '';
  for (const line of normalized.slice(4, end).split('\n')) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line); // indented lines do not match: they belong to a nested block
    if (m) {
      block = m[2] === '' ? m[1]! : '';
      if (m[2] !== '') meta[m[1]!] = m[2]!.trim();
      continue;
    }
    const nested = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (nested && block === 'console') consoleKeys[nested[1]!] = nested[2]!.trim();
  }
  return { meta, consoleKeys, body: normalized.slice(end + 4).replace(/^\n+/, '').trim() };
}

function readProfile(file: string, name: string, source: Profile['source']): Profile | undefined {
  if (!existsSync(file)) return undefined;
  const { meta, consoleKeys, body } = parseFrontmatter(readFileSync(file, 'utf8'));
  const model = meta.model && meta.model !== 'default' && /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/.test(meta.model) ? meta.model : undefined;
  const bt = Number(consoleKeys.budget_tokens);
  const budgetTokens = Number.isInteger(bt) && bt >= 1000 ? bt : undefined;
  return { name, description: meta.description ?? '', model, body, readOnly: consoleKeys.read_only === 'true', budgetTokens, source };
}

/** SPEC 11.4: the project's profiles override the user's, which override the shipped ones. */
export function loadProfile(name: string, projectRoot: string, userDir: string = join(configDir(), 'profiles')): Profile | undefined {
  if (!SLUG_RE.test(name)) return undefined; // also rules out path traversal
  return readProfile(join(projectRoot, '.andromedaconsole', 'profiles', `${name}.md`), name, 'project')
    ?? readProfile(join(userDir, `${name}.md`), name, 'user')
    ?? readProfile(join(promptsDir(), 'profiles', `${name}.md`), name, 'shipped');
}

const shippedDir = (): string => join(promptsDir(), 'profiles');
const SHIPPED_ORDER = ['developer', 'backend', 'frontend', 'dba', 'reviewer', 'recovery'];

function namesIn(dir: string): string[] {
  try { return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).filter((n) => SLUG_RE.test(n)); } catch { return []; }
}

/** Every profile a project can use: the shipped ones first (in their usual order), then the others by name (the user's and the project's). */
/** The profiles an agent can be started with by hand or by the main: the project's own list (or all), only those that exist, without the two roles the console starts itself. */
export function pickableProfiles(offered: readonly string[] | undefined, existing: readonly string[]): string[] {
  return (offered ?? existing).filter((n) => existing.includes(n) && n !== 'reviewer' && n !== 'recovery');
}

export function listProfileNames(projectRoot: string, userDir: string = join(configDir(), 'profiles')): string[] {
  const shipped = namesIn(shippedDir());
  const all = new Set([...shipped, ...namesIn(userDir), ...namesIn(join(projectRoot, '.andromedaconsole', 'profiles'))]);
  const rank = (n: string): number => (SHIPPED_ORDER.includes(n) ? SHIPPED_ORDER.indexOf(n) : SHIPPED_ORDER.length);
  return [...all].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** What the Profiles tab shows and edits: the user's layer (the user's file, else the shipped one) plus where the name is defined. */
export interface ProfileView extends Omit<Profile, 'source'> {
  /** Where the version in force for this project comes from. */
  source: Profile['source'];
  /** There is a shipped profile of this name (so it cannot be deleted, only restored). */
  shipped: boolean;
  /** The user's own file exists. */
  userFile: boolean;
  /** The project has its own profile of this name: it wins over the one edited here. */
  projectOverrides: boolean;
}

export function describeProfiles(projectRoot: string, userDir: string = join(configDir(), 'profiles')): ProfileView[] {
  const views: ProfileView[] = [];
  for (const name of listProfileNames(projectRoot, userDir)) {
    const inForce = loadProfile(name, projectRoot, userDir);
    if (!inForce) continue;
    const layer = readProfile(join(userDir, `${name}.md`), name, 'user') ?? readProfile(join(shippedDir(), `${name}.md`), name, 'shipped') ?? inForce;
    views.push({
      ...layer, source: inForce.source, shipped: existsSync(join(shippedDir(), `${name}.md`)),
      userFile: existsSync(join(userDir, `${name}.md`)), projectOverrides: inForce.source === 'project',
    });
  }
  return views;
}

export interface ProfileInput { name: string; description: string; model: string; budgetTokens: number | null; readOnly: boolean; body: string }
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;
const MAX_BODY = 32 * 1024;

/** The entry as the form sends it, or the name of the first field that is not acceptable. */
export function validateProfileInput(v: unknown): { ok: true; input: ProfileInput } | { ok: false; field: string } {
  if (typeof v !== 'object' || v === null) return { ok: false, field: 'profile' };
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string' || !SLUG_RE.test(o.name) || o.name.length > 40) return { ok: false, field: 'name' };
  if (typeof o.description !== 'string' || o.description.length > 200 || /[\r\n]/.test(o.description)) return { ok: false, field: 'description' };
  const model = typeof o.model === 'string' ? o.model.trim() : '';
  if (model !== '' && model !== 'default' && !MODEL_RE.test(model)) return { ok: false, field: 'model' };
  const budget = o.budgetTokens;
  if (budget !== null && budget !== undefined && !(typeof budget === 'number' && Number.isInteger(budget) && budget >= 1000 && budget <= 100_000_000)) return { ok: false, field: 'budgetTokens' };
  if (typeof o.readOnly !== 'boolean') return { ok: false, field: 'readOnly' };
  if (typeof o.body !== 'string' || o.body.trim() === '' || o.body.length > MAX_BODY) return { ok: false, field: 'body' };
  return { ok: true, input: { name: o.name, description: o.description.trim(), model: model === 'default' ? '' : model, budgetTokens: budget ?? null, readOnly: o.readOnly, body: o.body.replace(/\r\n/g, '\n').trim() } };
}

/** Writes the user's own file for a profile (a copy of a shipped one when the name is a shipped name): the same format the shipped files use. */
export function saveUserProfile(userDir: string, p: ProfileInput): void {
  const consoleLines = [...(p.budgetTokens !== null ? [`  budget_tokens: ${p.budgetTokens}`] : []), ...(p.readOnly ? ['  read_only: true'] : [])];
  const head = ['---', `name: ${p.name}`, `description: ${p.description}`, `model: ${p.model === '' ? 'default' : p.model}`, ...(consoleLines.length > 0 ? ['console:', ...consoleLines] : []), '---'];
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, `${p.name}.md`), `${head.join('\n')}\n\n${p.body}\n`, 'utf8');
}

/** Removes the user's file of one profile (a shipped name goes back to the shipped text); false when there was none. */
export function removeUserProfile(userDir: string, name: string): boolean {
  if (!SLUG_RE.test(name)) return false;
  const file = join(userDir, `${name}.md`);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

/** Puts every shipped profile back to its shipped text (the user's copies of those names go); the user's own other profiles stay. */
export function restoreShippedProfiles(userDir: string): number {
  let n = 0;
  for (const name of namesIn(shippedDir())) if (removeUserProfile(userDir, name)) n += 1;
  return n;
}

/** Language name in English, for the prompts ("Italian"); "auto" and unknown codes fall back to English. */
export function languageName(code: string): string {
  if (code === 'auto') return 'English';
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? 'English'; } catch { return 'English'; }
}

const fill = (template: string, values: Record<string, string>): string =>
  Object.entries(values).reduce((text, [k, v]) => text.split(`{${k}}`).join(v), template);

function writePrompt(outDir: string, name: string, text: string): string {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, name);
  writeFileSync(file, text, 'utf8');
  return file;
}

const MAX_PROJECT_TEXT = 32 * 1024;

/**
 * No .gitignore: the console commits with `git add -A`, so anything an agent installs or builds (node_modules, build output) would end up in
 * its commits. The main asks the user, once per repository; an agent that finds none keeps its work clean and does not decide it alone.
 */
function gitignoreTextForMain(repos: string[] | undefined): string | undefined {
  if (!repos || repos.length === 0) return undefined;
  const names = repos.map((r) => (r === '' ? 'the project folder' : r)).join(', ');
  return `No .gitignore was found in: ${names}. The console commits everything that is not ignored, so dependencies and build output (node_modules, target, dist...) would end up in the agents' commits. Before the first ticket for each of them, ask the user with AskUserQuestion whether a .gitignore should be created, and suggest what fits the stack (dependencies, build output, caches, .env and editor folders). If they say yes, put "create the .gitignore" in the goal of that repository's first ticket; if they say no, do not ask again.`;
}
/** How a session reaches the human: an author asks the main (which shows it natively, so Remote Control can answer); a reviewer or recovery session has no way to the main and uses the console queue. */
const humanViaMain = (main: string): string => `You cannot ask the human directly (AskUserQuestion is refused to you). When you need a decision, ask the main session, which is named "${main}", with mcp__console-mod__send_message {type: "question", to: "${main}", text}: write the question and, if it has fixed choices, every option, so the main can show them as they are. The answer arrives later as a message.`;
const HUMAN_VIA_QUEUE = 'When you need a decision from the human, use the AskUserQuestion tool: the console shows the question to them in its queue and brings the answer back to you.';
const GITIGNORE_AGENT = 'This repository has no .gitignore. Do not create or edit one unless your goal says so, and keep dependencies and build output (node_modules, target, dist...) out of your work: if they cannot be avoided, say so in the note of the documentation step so the main can ask the user.';

/** A project's own text file (`.andromedaconsole/main.md`, `.andromedaconsole/rules.md`), bounded; undefined when it is missing, empty or unreadable. */
function projectText(projectRoot: string | undefined, file: 'main.md' | 'rules.md'): string | undefined {
  if (!projectRoot) return undefined;
  try {
    const path = join(projectRoot, '.andromedaconsole', file);
    if (!existsSync(path)) return undefined;
    const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trim();
    return text === '' ? undefined : text.slice(0, MAX_PROJECT_TEXT);
  } catch {
    return undefined;
  }
}

/** The main's system-prompt addition (SPEC 10.4, 13.4). Returns the path of the rendered file. With `projectRoot`, the project's main.md and rules.md follow. */
export function renderMainPrompt(o: { project: string; workLanguage: string; outDir: string; projectRoot?: string; repos?: string[]; /** The profiles the main may name in spawn_agent. */ profiles?: readonly string[]; helpers?: string; /** Repositories (relative names, '' for the project folder) with no .gitignore that were not yet brought up. */ noGitignore?: string[]; /** Notifications > the main notifies the Claude app (Remote Control): the instructions to do so are added. */ mainPush?: boolean }): string {
  const template = readFileSync(join(promptsDir(), 'main.md'), 'utf8');
  const base = fill(template, { project: o.project, workLanguage: o.workLanguage, profiles: (o.profiles && o.profiles.length > 0 ? o.profiles : ['developer']).join(', ') });
  // A project folder that holds several repositories: every agent works in exactly one, which the main must name.
  const repoText = o.repos && o.repos.length > 1
    ? `This project folder holds several git repositories: ${o.repos.join(', ')}. Every agent works in exactly one of them: pass its name as "repo" to spawn_agent. Work that touches two repositories needs one agent for each.`
    : undefined;
  const push = o.mainPush ? readFileSync(join(promptsDir(), 'main-push.md'), 'utf8').replace(/\r\n/g, '\n').trim() : undefined;
  const extra = [repoText, gitignoreTextForMain(o.noGitignore), o.helpers, push, projectText(o.projectRoot, 'main.md'), projectText(o.projectRoot, 'rules.md')].filter((x): x is string => x !== undefined);
  return writePrompt(o.outDir, `main-${o.project}.md`, extra.length > 0 ? `${base.trimEnd()}\n\n${extra.join('\n\n')}\n` : base);
}

/** An agent's system-prompt addition: its profile plus who it is and what the console offers it. */
export function renderAgentPrompt(o: { profile: Profile; slug: string; project: string; outDir: string; git?: { worktree: string; branch: string }; review?: boolean; recovery?: boolean; projectRoot?: string; docs?: string[]; helpers?: string; /** The agent's checkout has no .gitignore. */ noGitignore?: boolean }): string {
  const template = readFileSync(join(promptsDir(), 'agent.md'), 'utf8');
  const rulesFile = o.review ? 'reviewer-git.md' : o.recovery ? 'recovery-git.md' : 'agent-git.md';
  const gitRules = o.git ? fill(readFileSync(join(promptsDir(), rulesFile), 'utf8'), { worktree: o.git.worktree, branch: o.git.branch, project: o.project }) : '';
  const text = fill(template, { slug: o.slug, project: o.project, profile: o.profile.body, git: gitRules, human: o.review || o.recovery ? HUMAN_VIA_QUEUE : humanViaMain(o.project) });
  // The project's rules reach every session; the documents to update concern only the one that writes the work (not a review or a recovery).
  const docs = o.docs && o.docs.length > 0 && !o.review && !o.recovery ? `At the last step update: ${o.docs.join(', ')}.` : undefined;
  const requests = !o.review && !o.recovery ? readFileSync(join(promptsDir(), 'agent-requests.md'), 'utf8').replace(/\r\n/g, '\n').trim() : undefined;
  const extra = [o.helpers, requests, o.noGitignore && !o.review && !o.recovery ? GITIGNORE_AGENT : undefined, projectText(o.projectRoot, 'rules.md'), docs].filter((x): x is string => x !== undefined);
  const full = extra.length > 0 ? `${text.trimEnd()}\n\n${extra.join('\n\n')}\n` : text;
  return writePrompt(o.outDir, `agent-${o.slug}.md`, full.replace(/\n{3,}/g, '\n\n'));
}
