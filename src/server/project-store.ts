import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './fs-atomic';
import { readJsonFile, readJsonState, setAside, type StateReport } from './json-file';
import { migrateProjectFolder } from './legacy-names';

export const TEST_MOMENTS = ['ticket', 'merge', 'release'] as const;
export type TestMoment = (typeof TEST_MOMENTS)[number];
export type TestCommands = { [M in TestMoment]?: string };

/** `testCommand` is what the console runs for the validation step of every ticket (SPEC 8.3); the user writes it. */
export interface ProjectInfo {
  name: string;
  createdAt: string;
  testCommand?: string;
  /** Optional command for one moment (`ticket`: validation step and review re-run; `merge`: after a merge; `release`: release); each falls back to `testCommand`. */
  testCommands?: TestCommands;
  /**
   * A project folder that holds several repositories: one command per repository, keyed by its folder name (`Ticket.repo`), for every
   * moment; it comes before `testCommands` and `testCommand`.
   */
  repoTestCommands?: Record<string, string>;
  /** One commit per ticket when merged (default); false keeps the step commits behind a merge commit (SPEC 9.7). */
  squash?: boolean;
  /** The user switched the tests off for this project: nothing runs them and the reports say so (never "passed"). */
  testsDisabled?: boolean;
  /** Phase 6D: what the console builds and lints with (same rules as `testCommand`). */
  buildCommand?: string;
  lintCommand?: string;
  /** Profile names offered to the new-agent picker (default: all). */
  profiles?: string[];
  /** Default model of the project's agents (behind the request's and the profile's). */
  model?: string;
  /** Default token budget of the project's agents (behind the request's and the profile's). */
  agentTokens?: number;
  /** Active-agent limit of this project (default: `agents.maxActivePerProject`). */
  maxActive?: number;
  /** Files the last checklist step must update. */
  docs?: string[];
  /** Extra secret patterns, added to the global ones. */
  secretPatterns?: string[];
}
/** What the console remembers of an agent between runs (Phase 6A). Every field after `createdAt` is optional: older files stay valid. */
export interface AgentRecord {
  slug: string; profile: string; createdAt: string;
  role?: 'main' | 'agent' | 'reviewer' | 'recovery';
  sessionId?: string;
  worktree?: string;
  branch?: string;
  /** Absolute path of the repository of the worktree (a project folder that holds several repos); absent: the project root. */
  repo?: string;
  model?: string;
  cwd?: string;
  /** The registry state when last seen (a crash leaves it behind: `working`/`starting` means a turn was lost). */
  lastState?: string;
  lastActiveAt?: string;
  /** The worktree has not been touched for longer than `git.staleWorktreeDays`. */
  stale?: boolean;
  /** Out of the agents column (it ended for good, or the user archived it); nothing else changes. Cleared by new work. */
  archived?: boolean;
  /** When it was archived (ISO). */
  archivedAt?: string;
}
/** A patch for `updateAgent`: a key set to `undefined` is removed from the record. */
export type AgentPatch = { [K in keyof Omit<AgentRecord, 'slug' | 'createdAt'>]?: AgentRecord[K] | undefined };

/** One line, at most 500 characters (the console runs it through the platform shell: the user wrote it). */
export const isValidTestCommand = (v: unknown): v is string => typeof v === 'string' && v.length <= 500 && !/[\r\n]/.test(v);

/** A `testCommands` patch: an object whose keys are moments and whose values are test commands (an empty string clears one). */
export const isValidTestCommands = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.entries(v).every(([k, c]) => (TEST_MOMENTS as readonly string[]).includes(k) && isValidTestCommand(c));

/** A `repoTestCommands` patch: an object whose keys are repository folder names and whose values are test commands (an empty string clears one). */
export const isValidRepoTestCommands = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.entries(v).every(([k, c]) => k !== '' && isValidTestCommand(c));

/** The repositories a `repoTestCommands` patch sets a command for that are not among `repos` (clearing one that left the folder is allowed). */
export const unknownRepos = (patch: Record<string, string>, repos: readonly string[]): string[] =>
  Object.entries(patch).filter(([k, c]) => c.trim() !== '' && !repos.includes(k)).map(([k]) => k);

/** A model alias or id: plain characters only, because it becomes a command-line argument (same rule as `MODEL_RE` in spawn.ts). */
const PROJECT_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;
const isStringList = (v: unknown, max: number, maxLen: number): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.trim() !== '' && x.length <= maxLen && !/[\r\n]/.test(x));
const isIntIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** The optional project fields of Phase 6D that are set through `setFields` (`testCommand` and `squash` have their own setters). */
export const PROJECT_FIELDS = ['buildCommand', 'lintCommand', 'profiles', 'model', 'agentTokens', 'maxActive', 'docs', 'secretPatterns'] as const;
export type ProjectField = (typeof PROJECT_FIELDS)[number];

/** Allowed whole-number range of the numeric project fields (validation and the error text read it). */
export const PROJECT_RANGES: Readonly<Record<string, readonly [number, number]>> = { agentTokens: [1000, 100_000_000], maxActive: [1, 64] };

/** Whether a value is acceptable for a project field. `knownProfiles` limits `profiles` (names the console knows). */
export function isValidProjectField(field: ProjectField, v: unknown, knownProfiles?: readonly string[]): boolean {
  switch (field) {
    case 'buildCommand': case 'lintCommand': return isValidTestCommand(v);
    case 'profiles': return isStringList(v, 64, 40) && (knownProfiles === undefined || v.every((p) => knownProfiles.includes(p)));
    case 'model': return typeof v === 'string' && PROJECT_MODEL_RE.test(v);
    case 'agentTokens': return isIntIn(v, ...PROJECT_RANGES.agentTokens!);
    case 'maxActive': return isIntIn(v, ...PROJECT_RANGES.maxActive!);
    case 'docs': return isStringList(v, 20, 200);
    case 'secretPatterns': return isStringList(v, 50, 200);
  }
}

/** Project state under <repo>/.andromedaconsole/ (SPEC 23): project.json and state/agents.json. */
export class ProjectStore {
  private readonly projectFile: string;
  private readonly agentsFile: string;
  private readonly stateDir: string;

  constructor(root: string, private readonly report?: StateReport) {
    migrateProjectFolder(root);
    this.stateDir = join(root, '.andromedaconsole', 'state');
    this.projectFile = join(root, '.andromedaconsole', 'project.json');
    this.agentsFile = join(root, '.andromedaconsole', 'state', 'agents.json');
  }

  init(name: string): void {
    if (!existsSync(this.projectFile)) writeJsonAtomic(this.projectFile, { name, createdAt: new Date().toISOString() });
    if (!existsSync(this.agentsFile)) writeJsonAtomic(this.agentsFile, []);
  }

  get project(): ProjectInfo {
    return JSON.parse(readFileSync(this.projectFile, 'utf8')) as ProjectInfo;
  }

  /** Sets (or, with an empty string, clears) the project's test command. One line, at most 500 characters. */
  setTestCommand(command: string): void {
    if (!isValidTestCommand(command)) throw new Error('project.testCommandInvalid');
    const { testCommand: _old, ...rest } = this.project;
    const trimmed = command.trim();
    writeJsonAtomic(this.projectFile, trimmed === '' ? rest : { ...rest, testCommand: trimmed });
  }

  /** Sets (or, with an empty string, clears) the commands of single moments; keys not mentioned keep their value. Checked before anything is written. */
  setTestCommands(patch: unknown): void {
    if (!isValidTestCommands(patch)) throw new Error('project.testCommandInvalid');
    const { testCommands: old, ...rest } = this.project;
    const next: TestCommands = { ...old };
    for (const [moment, command] of Object.entries(patch) as [TestMoment, string][]) {
      if (command.trim() === '') delete next[moment]; else next[moment] = command.trim();
    }
    writeJsonAtomic(this.projectFile, Object.keys(next).length === 0 ? rest : { ...rest, testCommands: next });
  }

  /**
   * Sets (or, with an empty string, clears) the commands of single repositories of the folder; keys not mentioned keep their value. A
   * command for a repository not in `repos` (the folder's repository names) throws `project.repoUnknown`. Checked before anything is written.
   */
  setRepoTestCommands(patch: unknown, repos: readonly string[]): void {
    if (!isValidRepoTestCommands(patch)) throw new Error('project.testCommandInvalid');
    if (unknownRepos(patch, repos).length > 0) throw new Error('project.repoUnknown');
    const { repoTestCommands: old, ...rest } = this.project;
    const next: Record<string, string> = { ...old };
    for (const [repo, command] of Object.entries(patch)) {
      if (command.trim() === '') delete next[repo]; else next[repo] = command.trim();
    }
    writeJsonAtomic(this.projectFile, Object.keys(next).length === 0 ? rest : { ...rest, repoTestCommands: next });
  }

  /** `true`: the project's tests are inhibited (no test run anywhere); `false` takes the field away, so the project is as any other. */
  setTestsDisabled(disabled: boolean): void {
    if (typeof disabled !== 'boolean') throw new Error('project.testsDisabledInvalid');
    const { testsDisabled: _old, ...rest } = this.project;
    writeJsonAtomic(this.projectFile, disabled ? { ...rest, testsDisabled: true } : rest);
  }

  setSquash(squash: boolean): void {
    if (typeof squash !== 'boolean') throw new Error('project.squashInvalid');
    writeJsonAtomic(this.projectFile, { ...this.project, squash });
  }

  /** Stores the build and lint commands given at creation (empty or absent: left out). */
  setCommands(c: { build?: string; lint?: string }): void {
    const next: ProjectInfo = { ...this.project };
    if (c.build?.trim()) next.buildCommand = c.build.trim();
    if (c.lint?.trim()) next.lintCommand = c.lint.trim();
    writeJsonAtomic(this.projectFile, next);
  }

  /**
   * Sets (or, with `undefined`, `null`, an empty string or an empty list, clears) the Phase 6D fields. Every entry is checked before
   * anything is written; a bad one throws `project.fieldInvalid:<field>` and changes nothing.
   */
  setFields(patch: Partial<Record<ProjectField, unknown>>, knownProfiles?: readonly string[]): void {
    const next: Record<string, unknown> = { ...this.project };
    for (const field of PROJECT_FIELDS) {
      if (!(field in patch)) continue;
      let v = patch[field];
      if (typeof v === 'string') v = v.trim();
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) { delete next[field]; continue; }
      if (!isValidProjectField(field, v, knownProfiles)) throw new Error(`project.fieldInvalid:${field}`);
      next[field] = v;
    }
    writeJsonAtomic(this.projectFile, next);
  }

  /** The project's optional fields; empty when project.json cannot be read (a damaged file must not stop a launch). */
  fields(): Partial<ProjectInfo> {
    try { return this.project; } catch { return {}; }
  }

  listAgents(): AgentRecord[] {
    const s = readJsonState(this.agentsFile, this.report); // damaged: set aside and reported, then no agents
    if (s.status !== 'ok') return [];
    if (!Array.isArray(s.value)) { setAside(this.agentsFile, this.report); return []; }
    return s.value as AgentRecord[];
  }

  /** Forgets an agent whose creation failed (a normal agent stays on record: the name stays reserved). */
  removeAgent(slug: string): void {
    writeJsonAtomic(this.agentsFile, this.listAgents().filter((a) => a.slug !== slug));
  }

  addAgent(a: { slug: string; profile: string; model?: string }): void {
    const all = this.listAgents();
    if (all.some((x) => x.slug === a.slug)) throw new Error('slug.duplicate');
    all.push({ ...a, createdAt: new Date().toISOString() });
    writeJsonAtomic(this.agentsFile, all);
  }

  /** Merges a patch into one agent's record (atomic write). An unknown slug is ignored. */
  updateAgent(slug: string, patch: AgentPatch): void {
    const all = this.listAgents();
    const i = all.findIndex((a) => a.slug === slug);
    if (i < 0) return;
    const next: Record<string, unknown> = { ...all[i] };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    all[i] = next as unknown as AgentRecord;
    writeJsonAtomic(this.agentsFile, all);
  }

  private readJson(name: string): Record<string, unknown> | undefined {
    const parsed = readJsonFile(join(this.stateDir, name)); // missing or damaged: treated as no saved state
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  }

  /** The main's last session id (`state/main.json`), kept so a restart resumes its context. */
  readMainSession(): string | undefined {
    const id = this.readJson('main.json')?.sessionId;
    return typeof id === 'string' ? id : undefined;
  }

  writeMainSession(sessionId: string): void {
    writeJsonAtomic(join(this.stateDir, 'main.json'), { sessionId });
  }

  /** `state/run.json`: false after a crash (the previous run never reached the end of `close()`); true when there is no file. */
  readCleanStop(): boolean {
    return this.readJson('run.json')?.cleanStop !== false;
  }

  writeCleanStop(cleanStop: boolean): void {
    writeJsonAtomic(join(this.stateDir, 'run.json'), { cleanStop });
  }
}
