import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from './fs-atomic';
import { migrateConfigFolder } from './legacy-names';
import { DEFAULT_SECRET_PATTERNS } from './git/secrets';
import { DEFAULT_NOTIFICATIONS, NOTIFY_TYPES, type NotificationsConfig } from '../shared/notify';
import { isObj } from '../shared/guards';
import { SLUG_RE } from '../shared/slug';
import { AUDIT_LEVELS, type AuditLevel } from './audit/levels';

/** "auto" or a language code that has a bundle (checked against the bundles by the server). */
export type Language = string;
export interface Config {
  schema: 1;
  language: Language;
  agents: { bypassPermissions: boolean; maxActiveGlobal: number; maxActivePerProject: number; requestTimeoutMinutes: number; requestMaxHops: number };
  claude: { command: string[] };
  mod: { enabled: boolean };
  /** Worktrees and commits by the console (SPEC 9). `worktrees: false` keeps the Phase 2 behaviour: agents share the project folder. */
  git: { worktrees: boolean; secretPatterns: string[]; testTimeoutMinutes: number; staleWorktreeDays: number; staleCheck: boolean };
  /** `shadow` allows everything but logs what `enforce` would have denied (SPEC 14). */
  guard: { mode: 'enforce' | 'shadow' };
  /** The anti-slop audit of delivered tickets (SPEC 15.7): how much of it runs, whether the model part starts by itself, and the style profile. A project can override each. */
  audit: { level: AuditLevel; autoModel: boolean; profile: string };
  /** Budget, loop and quota thresholds (SPEC 16, 17, 18). Applied to sessions launched afterwards; the quota steps are read on every event. */
  budget: BudgetConfig;
  /** Toasts for everything that needs the user (SPEC 20); read on every event, so a change applies at once. */
  notifications: NotificationsConfig;
  /** The model agents are launched with ('' = Claude Code's default) and where the model list comes from (SPEC 12). */
  models: { agent: string; catalogUrl: string; cacheHours: number };
  /** The plugin catalog (a list to read; SPEC 30). */
  plugins: { catalogUrl: string; cacheHours: number };
  telemetry: false;
}
export interface BudgetConfig {
  agentTokens: number; alertPercent: number; limitPercent: number; stopPercent: number; graceMinutes: number;
  loop: { sameCall: number; sameError: number; compactions: number; stepMinutes: number; silenceMinutes: number };
  quota: { halvePercent: number; freezePercent: number; stopPercent: number; staggerSeconds: number; staggerGroup: number };
}
/** Allowed whole-number range of every numeric entry (the single source: validation and the message that names the limits both read it). */
export const CONFIG_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  'agents.maxActiveGlobal': [1, 64], 'agents.maxActivePerProject': [1, 64], 'agents.requestTimeoutMinutes': [1, 240], 'agents.requestMaxHops': [1, 10],
  'git.testTimeoutMinutes': [1, 240], 'git.staleWorktreeDays': [1, 365],
  'budget.agentTokens': [1000, 100_000_000], 'budget.graceMinutes': [0, 120],
  'budget.alertPercent': [1, 200], 'budget.limitPercent': [1, 200], 'budget.stopPercent': [1, 200],
  'budget.loop.sameCall': [1, 1000], 'budget.loop.sameError': [1, 1000], 'budget.loop.compactions': [1, 1000],
  'budget.loop.stepMinutes': [1, 1000], 'budget.loop.silenceMinutes': [1, 1000],
  'budget.quota.halvePercent': [1, 100], 'budget.quota.freezePercent': [1, 100], 'budget.quota.stopPercent': [1, 100],
  'models.cacheHours': [1, 168], 'plugins.cacheHours': [1, 168], 'notifications.groupSeconds': [1, 60],
  'budget.quota.staggerSeconds': [0, 3600], 'budget.quota.staggerGroup': [1, 16],
};
const R = (path: string): readonly [number, number] => CONFIG_RANGES[path]!;

export interface ConfigError { path: string; code: 'config.invalid' | 'config.unreadable' }

export const DEFAULT_CONFIG: Config = {
  schema: 1,
  language: 'en',
  agents: { bypassPermissions: false, maxActiveGlobal: 4, maxActivePerProject: 3, requestTimeoutMinutes: 15, requestMaxHops: 3 },
  claude: { command: ['claude'] },
  mod: { enabled: true },
  git: { worktrees: true, secretPatterns: DEFAULT_SECRET_PATTERNS, testTimeoutMinutes: 15, staleWorktreeDays: 10, staleCheck: true },
  guard: { mode: 'enforce' },
  audit: { level: 'metrics', autoModel: false, profile: 'default' },
  budget: {
    agentTokens: 400000, alertPercent: 80, limitPercent: 100, stopPercent: 110, graceMinutes: 5,
    loop: { sameCall: 5, sameError: 3, compactions: 2, stepMinutes: 30, silenceMinutes: 5 },
    quota: { halvePercent: 70, freezePercent: 85, stopPercent: 95, staggerSeconds: 60, staggerGroup: 2 },
  },
  notifications: DEFAULT_NOTIFICATIONS,
  models: { agent: '', catalogUrl: '', cacheHours: 6 },
  plugins: { catalogUrl: '', cacheHours: 6 },
  telemetry: false,
};

/** %APPDATA%/andromedaconsole, or CONSOLE_CONFIG_DIR when set (tests, portable installs). */
export const configDir = (): string => {
  if (process.env.CONSOLE_CONFIG_DIR) return process.env.CONSOLE_CONFIG_DIR;
  const base = process.env.APPDATA ?? homedir();
  if (!configMigrated) { configMigrated = true; migrateConfigFolder(base); }
  return join(base, 'andromedaconsole');
};
let configMigrated = false;

/** Same rule as `MODEL_RE` in agents/spawn.ts (not imported: spawn.ts reaches profiles.ts, which imports this file). */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;

/** A catalog address: https, or plain http only for this machine (tests). Empty means "the shipped list only". */
export const isCatalogUrl = (v: unknown): v is string => {
  if (typeof v !== 'string') return false;
  if (v === '') return true;
  if (v.length > 500) return false;
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  if (u.username !== '' || u.password !== '') return false;
  return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'));
};
const isCacheHours = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 168; // CONFIG_RANGES holds the same limits for the error text

/** SPEC 29.7: an invalid entry never blocks the console; the default is used and the error is reported. */
export function loadConfig(path: string): { config: Config; errors: ConfigError[] } {
  if (!existsSync(path)) return { config: structuredClone(DEFAULT_CONFIG), errors: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { config: structuredClone(DEFAULT_CONFIG), errors: [{ path: '', code: 'config.unreadable' }] };
  }
  if (!isObj(raw)) return { config: structuredClone(DEFAULT_CONFIG), errors: [{ path: '', code: 'config.unreadable' }] };
  return validateConfig(raw);
}

/** Validates a parsed config object entry by entry: an invalid entry keeps its default and is reported. */
export function validateConfig(raw: Record<string, unknown>): { config: Config; errors: ConfigError[] } {
  const config: Config = structuredClone(DEFAULT_CONFIG);
  const errors: ConfigError[] = [];
  const bad = (p: string) => errors.push({ path: p, code: 'config.invalid' });

  if ('language' in raw) {
    if (typeof raw.language === 'string' && /^(auto|[a-z]{2,3})$/.test(raw.language)) config.language = raw.language;
    else bad('language');
  }
  if ('agents' in raw) {
    if (isObj(raw.agents)) {
      const a = raw.agents;
      if ('bypassPermissions' in a) {
        if (typeof a.bypassPermissions === 'boolean') config.agents.bypassPermissions = a.bypassPermissions;
        else bad('agents.bypassPermissions');
      }
      for (const key of ['maxActiveGlobal', 'maxActivePerProject', 'requestTimeoutMinutes', 'requestMaxHops'] as const) {
        if (!(key in a)) continue;
        const v = a[key];
        if (typeof v === 'number' && Number.isInteger(v) && v >= R(`agents.${key}`)[0] && v <= R(`agents.${key}`)[1]) config.agents[key] = v;
        else bad(`agents.${key}`);
      }
    } else bad('agents');
  }
  if ('claude' in raw) {
    const cmd = isObj(raw.claude) ? raw.claude.command : undefined;
    if (Array.isArray(cmd) && cmd.length > 0 && cmd.every((c) => typeof c === 'string')) config.claude.command = cmd as string[];
    else bad('claude.command');
  }
  if ('mod' in raw) {
    const enabled = isObj(raw.mod) ? raw.mod.enabled : undefined;
    if (typeof enabled === 'boolean') config.mod.enabled = enabled;
    else bad('mod.enabled');
  }
  if ('git' in raw) {
    if (isObj(raw.git)) {
      const g = raw.git;
      if ('worktrees' in g) {
        if (typeof g.worktrees === 'boolean') config.git.worktrees = g.worktrees;
        else bad('git.worktrees');
      }
      if ('secretPatterns' in g) {
        const sp = g.secretPatterns;
        if (Array.isArray(sp) && sp.every((x) => typeof x === 'string' && x.trim() !== '' && x.length <= 200)) config.git.secretPatterns = sp as string[];
        else bad('git.secretPatterns');
      }
      if ('testTimeoutMinutes' in g) {
        const v = g.testTimeoutMinutes;
        if (typeof v === 'number' && Number.isInteger(v) && v >= R('git.testTimeoutMinutes')[0] && v <= R('git.testTimeoutMinutes')[1]) config.git.testTimeoutMinutes = v;
        else bad('git.testTimeoutMinutes');
      }
      if ('staleWorktreeDays' in g) {
        const v = g.staleWorktreeDays;
        if (typeof v === 'number' && Number.isInteger(v) && v >= R('git.staleWorktreeDays')[0] && v <= R('git.staleWorktreeDays')[1]) config.git.staleWorktreeDays = v;
        else bad('git.staleWorktreeDays');
      }
      if ('staleCheck' in g) {
        if (typeof g.staleCheck === 'boolean') config.git.staleCheck = g.staleCheck;
        else bad('git.staleCheck');
      }
    } else bad('git');
  }
  if ('guard' in raw) {
    const mode = isObj(raw.guard) ? raw.guard.mode : undefined;
    if (mode === 'enforce' || mode === 'shadow') config.guard.mode = mode;
    else bad('guard.mode');
  }
  if ('audit' in raw) {
    if (isObj(raw.audit)) {
      const a = raw.audit;
      if ('level' in a) {
        if (typeof a.level === 'string' && (AUDIT_LEVELS as readonly string[]).includes(a.level)) config.audit.level = a.level as AuditLevel;
        else bad('audit.level');
      }
      if ('autoModel' in a) {
        if (typeof a.autoModel === 'boolean') config.audit.autoModel = a.autoModel;
        else bad('audit.autoModel');
      }
      if ('profile' in a) {
        if (typeof a.profile === 'string' && SLUG_RE.test(a.profile)) config.audit.profile = a.profile;
        else bad('audit.profile');
      }
    } else bad('audit');
  }
  if ('budget' in raw) {
    if (isObj(raw.budget)) {
      const b = raw.budget;
      const int = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
      const set = (path: string, v: unknown, apply: (n: number) => void): void => { if (v === undefined) return; if (int(v, R(path)[0], R(path)[1])) apply(v); else bad(path); };
      const c = config.budget;
      set('budget.agentTokens', b.agentTokens, (n) => { c.agentTokens = n; });
      set('budget.graceMinutes', b.graceMinutes, (n) => { c.graceMinutes = n; });
      // alert < limit <= stop: an invalid trio keeps all three defaults and is reported on every given entry
      const trio = { alertPercent: b.alertPercent ?? c.alertPercent, limitPercent: b.limitPercent ?? c.limitPercent, stopPercent: b.stopPercent ?? c.stopPercent };
      const okTrio = int(trio.alertPercent, ...R('budget.alertPercent')) && int(trio.limitPercent, ...R('budget.limitPercent')) && int(trio.stopPercent, ...R('budget.stopPercent')) && trio.alertPercent < trio.limitPercent && trio.limitPercent <= trio.stopPercent;
      for (const key of ['alertPercent', 'limitPercent', 'stopPercent'] as const) {
        if (b[key] === undefined) continue;
        if (okTrio) c[key] = trio[key] as number; else bad(`budget.${key}`);
      }
      if (isObj(b.loop)) {
        for (const key of ['sameCall', 'sameError', 'compactions', 'stepMinutes', 'silenceMinutes'] as const) {
          set(`budget.loop.${key}`, (b.loop as Record<string, unknown>)[key], (n) => { c.loop[key] = n; });
        }
      } else if ('loop' in b) bad('budget.loop');
      if (isObj(b.quota)) {
        const q = b.quota as Record<string, unknown>;
        const trioQ = { halvePercent: q.halvePercent ?? c.quota.halvePercent, freezePercent: q.freezePercent ?? c.quota.freezePercent, stopPercent: q.stopPercent ?? c.quota.stopPercent };
        const okQ = int(trioQ.halvePercent, ...R('budget.quota.halvePercent')) && int(trioQ.freezePercent, ...R('budget.quota.freezePercent')) && int(trioQ.stopPercent, ...R('budget.quota.stopPercent')) && trioQ.halvePercent < trioQ.freezePercent && trioQ.freezePercent < trioQ.stopPercent;
        for (const key of ['halvePercent', 'freezePercent', 'stopPercent'] as const) {
          if (q[key] === undefined) continue;
          if (okQ) c.quota[key] = trioQ[key] as number; else bad(`budget.quota.${key}`);
        }
        set('budget.quota.staggerSeconds', q.staggerSeconds, (n) => { c.quota.staggerSeconds = n; });
        set('budget.quota.staggerGroup', q.staggerGroup, (n) => { c.quota.staggerGroup = n; });
      } else if ('quota' in b) bad('budget.quota');
    } else bad('budget');
  }
  if ('notifications' in raw) config.notifications = mergeNotifications(config.notifications, raw.notifications, bad);
  if ('models' in raw) {
    if (isObj(raw.models)) {
      const m = raw.models;
      if ('agent' in m) {
        if (typeof m.agent === 'string' && (m.agent === '' || MODEL_RE.test(m.agent))) config.models.agent = m.agent;
        else bad('models.agent');
      }
      if ('catalogUrl' in m) {
        if (isCatalogUrl(m.catalogUrl)) config.models.catalogUrl = m.catalogUrl;
        else bad('models.catalogUrl');
      }
      if ('cacheHours' in m) {
        if (isCacheHours(m.cacheHours)) config.models.cacheHours = m.cacheHours;
        else bad('models.cacheHours');
      }
    } else bad('models');
  }
  if ('plugins' in raw) {
    if (isObj(raw.plugins)) {
      const m = raw.plugins;
      if ('catalogUrl' in m) {
        if (isCatalogUrl(m.catalogUrl)) config.plugins.catalogUrl = m.catalogUrl;
        else bad('plugins.catalogUrl');
      }
      if ('cacheHours' in m) {
        if (isCacheHours(m.cacheHours)) config.plugins.cacheHours = m.cacheHours;
        else bad('plugins.cacheHours');
      }
    } else bad('plugins');
  }
  if ('telemetry' in raw && raw.telemetry !== false) bad('telemetry');
  return { config, errors };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Applies the entries of `raw` that are valid on top of `base` and reports each invalid one by path (the default or the earlier
 * value stays). Used for the configuration file and for the patch the Notifications tab sends.
 */
export function mergeNotifications(base: NotificationsConfig, raw: unknown, bad: (path: string) => void): NotificationsConfig {
  const out = structuredClone(base);
  if (!isObj(raw)) { bad('notifications'); return out; }
  if ('enabled' in raw) {
    if (isObj(raw.enabled)) {
      for (const type of NOTIFY_TYPES) {
        const v = raw.enabled[type];
        if (v === undefined) continue;
        if (typeof v === 'boolean') out.enabled[type] = v; else bad(`notifications.enabled.${type}`);
      }
      for (const key of Object.keys(raw.enabled)) if (!(NOTIFY_TYPES as readonly string[]).includes(key)) bad(`notifications.enabled.${key}`);
    } else bad('notifications.enabled');
  }
  if ('quietHours' in raw) {
    const q = raw.quietHours;
    if (isObj(q)) {
      if ('enabled' in q) { if (typeof q.enabled === 'boolean') out.quietHours.enabled = q.enabled; else bad('notifications.quietHours.enabled'); }
      for (const key of ['from', 'to'] as const) {
        if (!(key in q)) continue;
        const v = q[key];
        if (typeof v === 'string' && HHMM.test(v)) out.quietHours[key] = v; else bad(`notifications.quietHours.${key}`);
      }
    } else bad('notifications.quietHours');
  }
  if ('sound' in raw) { if (typeof raw.sound === 'boolean') out.sound = raw.sound; else bad('notifications.sound'); }
  if ('browserFallback' in raw) { if (typeof raw.browserFallback === 'boolean') out.browserFallback = raw.browserFallback; else bad('notifications.browserFallback'); }
  if ('mainPush' in raw) { if (typeof raw.mainPush === 'boolean') out.mainPush = raw.mainPush; else bad('notifications.mainPush'); }
  if ('groupSeconds' in raw) {
    const v = raw.groupSeconds;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 60) out.groupSeconds = v; else bad('notifications.groupSeconds');
  }
  return out;
}

/** The `notifications` entry of PUT /api/config: the merged settings, or the path of the first invalid entry (nothing is written then). */
export function validateNotificationsPatch(raw: unknown, current: NotificationsConfig): { ok: true; value: NotificationsConfig } | { ok: false; path: string } {
  let first: string | undefined;
  const value = mergeNotifications(current, raw, (p) => { first ??= p; });
  return first === undefined ? { ok: true, value } : { ok: false, path: first };
}

export function saveConfigAtomic(path: string, config: Config): void {
  writeJsonAtomic(path, config);
}

/**
 * Changes only the given entries (language, the bypass switch, the guard mode) inside the user's file and keeps every other entry as written (even invalid or unknown ones).
 * A file that cannot be parsed is never overwritten: the caller reports `config.unreadable`.
 */
export interface ConfigPatch {
  language?: Language;
  agents?: { bypassPermissions: boolean };
  guard?: { mode: 'enforce' | 'shadow' };
  /** The complete, already validated settings (see `validateNotificationsPatch`). */
  notifications?: NotificationsConfig;
}

/** The user's file as written (`{ schema: 1 }` when there is none); not readable when it is not a JSON object. */
function readRawConfig(path: string): { ok: true; raw: Record<string, unknown> } | { ok: false } {
  if (!existsSync(path)) return { ok: true, raw: { schema: 1 } };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isObj(parsed) ? { ok: true, raw: parsed } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function patchConfig(path: string, patch: ConfigPatch): { ok: true } | { ok: false; code: 'config.unreadable' } {
  let raw: Record<string, unknown> = { schema: 1 };
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isObj(parsed)) return { ok: false, code: 'config.unreadable' };
      raw = parsed;
    } catch {
      return { ok: false, code: 'config.unreadable' };
    }
  }
  const next: Record<string, unknown> = { ...raw };
  if (patch.language !== undefined) next.language = patch.language;
  if (patch.agents) next.agents = { ...(isObj(raw.agents) ? raw.agents : {}), ...patch.agents };
  if (patch.guard) next.guard = { ...(isObj(raw.guard) ? raw.guard : {}), ...patch.guard };
  if (patch.notifications) next.notifications = patch.notifications;
  writeJsonAtomic(path, next);
  return { ok: true };
}

export const saveLanguage = (path: string, language: Language): ReturnType<typeof patchConfig> => patchConfig(path, { language });

/** Top-level entries the generic patch can change; anything else in a patch is ignored (and kept as written in the file). */
const PATCHABLE = ['language', 'agents', 'guard', 'git', 'audit', 'budget', 'models', 'plugins', 'notifications'] as const;

const leavesOf = (value: Record<string, unknown>, prefix: string, out: string[] = []): string[] => {
  for (const [key, v] of Object.entries(value)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (isObj(v) && Object.keys(v).length > 0) leavesOf(v, p, out);
    else out.push(p);
  }
  return out;
};

const deepMerge = (base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...base };
  for (const [key, v] of Object.entries(patch)) {
    const current = out[key];
    out[key] = isObj(v) && isObj(current) ? deepMerge(current, v) : v;
  }
  return out;
};

export type PatchResult =
  | { ok: true; config: Config; applied: Record<string, unknown> }
  | { ok: false; code: 'config.unreadable' }
  | { ok: false; code: 'config.invalid'; path: string; /** Set when the value is a number outside the allowed whole-number range. */ range?: { min: number; max: number } };

/**
 * Generic patch (SPEC 22, 29.7): deep-merges the given entries into the user's file (every other entry stays as written, even invalid or
 * unknown ones), validates the merged object and refuses when an entry the patch touched is invalid: nothing is written then.
 * `claude.command`, `mod.enabled` and `telemetry` are not in the patchable list (restart needed, security).
 */
export function applyConfigPatch(path: string, patch: Record<string, unknown>, dryRun = false): PatchResult {
  const applied: Record<string, unknown> = {};
  for (const key of PATCHABLE) if (key in patch) applied[key] = patch[key];
  if (Object.keys(applied).length === 0) return { ok: false, code: 'config.invalid', path: '' };
  let raw: Record<string, unknown> = { schema: 1 };
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isObj(parsed)) return { ok: false, code: 'config.unreadable' };
      raw = parsed;
    } catch {
      return { ok: false, code: 'config.unreadable' };
    }
  }
  const merged = deepMerge(raw, applied);
  const { config, errors } = validateConfig(merged);
  for (const leaf of leavesOf(applied, '')) {
    const hit = errors.find((e) => e.path === leaf || e.path.startsWith(`${leaf}.`) || leaf.startsWith(`${e.path}.`));
    if (hit) {
      const path = hit.path.length < leaf.length ? hit.path : leaf;
      const lim = CONFIG_RANGES[path];
      const v = path.split('.').reduce<unknown>((o, key) => (isObj(o) ? o[key] : undefined), merged);
      const outside = lim !== undefined && typeof v === 'number' && (!Number.isInteger(v) || v < lim[0] || v > lim[1]);
      return { ok: false, code: 'config.invalid', path, ...(outside ? { range: { min: lim[0], max: lim[1] } } : {}) };
    }
  }
  if (!dryRun) writeJsonAtomic(path, merged); // a dry run only answers whether the patch would be accepted
  return { ok: true, config, applied };
}
