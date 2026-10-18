import type { ApiError, PrereqResult, StateMessage } from '../shared/protocol';
import { api } from './api';
import { errorText } from './new-agent';
import { bindText, k, language, retranslate, setLanguage, setPlaceholder, setTitle, t } from './i18n-client';
import { closeOverlay, createLanguageSelect, renderPrereqTable } from './settings';
import { openInstallDialog } from './install-dialog';
import { infoIcon } from './info-icon';
import { openRestartDialog } from './restart-dialog';
import { renderProfilesTab } from './options-profiles';
import { fillModelSelect, loadModelSelect } from './model-select';
import { renderGitProject } from './git-section';
import { renderNotificationsTab } from './options-notifications';
import { renderSecretsTab } from './options-secrets';
import { openSaveTemplateDialog } from './new-project';
import { el, note } from './dom';

/** What `GET /api/options` returns (the config is the effective one, defaults filled in). */
interface OptionsPayload {
  config: ConfigView;
  errors: { path: string; code: string }[];
  paths: { configDir: string; profilesDir: string; templatesDir: string };
  server: { port: number };
  profiles: { name: string; source: 'project' | 'user' | 'shipped' | null }[];
}
type ConfigView = Record<string, unknown>;

interface ModelList {
  models: { id: string; label: string; alias?: true }[];
  source: 'remote' | 'cache' | 'shipped';
  updated?: string;
  current: string;
  missing: boolean;
}
interface PluginRow {
  id: string; category: string; summary: Record<string, string>; trust: string; tier: string; requires: string[]; agentsAllowed: boolean;
  conflicts: Record<string, string>[]; cost: { contextTokens: number | null } | null; notTested: boolean; installCommand: string;
}
interface PluginList { source: string; updated?: string; plugins: PluginRow[] }
/** Where a plugin stands for the open project (asked of Claude Code); `null` as a whole when it could not be read. */
interface PluginStatus { state: 'installed' | 'project' | 'disabled' | 'other_project' | 'not_installed'; version?: string }
type InstalledMap = Record<string, PluginStatus> | null;

/** Every tab of the dialog, in order. Only options that exist today are here (no providers, snapshots, Rizzo Flow...). */
/** The left column: what holds for the whole console first, then what belongs to the open project (each group has a small heading). */
export const OPTION_GROUPS = [
  { id: 'global', tabs: ['models', 'profiles', 'budget', 'guard', 'notifications', 'language', 'prerequisites', 'plugins', 'secrets'] },
  { id: 'project', tabs: ['projects', 'git'] },
] as const;
export const OPTION_TABS = OPTION_GROUPS.flatMap((g) => g.tabs);
export type OptionTab = (typeof OPTION_TABS)[number];

interface Env {
  state: StateMessage | undefined;
  options: OptionsPayload | null;
  error: HTMLElement;
  fail(res: { status: number; body: unknown }): boolean;
  getState(): StateMessage | undefined;
  /** Remembers a change until Save: one request per key, the last one wins. Nothing is sent before Save. */
  /** `run(true)` only asks whether the change would be accepted (nothing is written); `run(false)` saves it. */
  stage(key: string, run: (dry: boolean) => Promise<{ status: number; body: unknown }>): void;
  /** The Profiles tab is showing its own form (with its own buttons): the dialog's Save is hidden meanwhile. */
  profileEditing(on: boolean): void;
}

export { infoIcon };
const footnote = (key: string): HTMLElement => {
  const p = note(key);
  p.classList.add('options-footnote');
  return p;
};
const heading = (key: string): HTMLElement => {
  const h = el('h3', 'options-heading');
  bindText(h, key);
  return h;
};

const getPath = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, p) => (typeof acc === 'object' && acc !== null ? (acc as Record<string, unknown>)[p] : undefined), obj);
const setPath = (obj: Record<string, unknown>, path: string, value: unknown): void => {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    const next = cur[p];
    cur = typeof next === 'object' && next !== null ? (next as Record<string, unknown>) : (cur[p] = {}) as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
};
const toPatch = (path: string, value: unknown): Record<string, unknown> =>
  path.split('.').reduceRight<unknown>((acc, p) => ({ [p]: acc }), value) as Record<string, unknown>;

/** The label key of every numeric entry built so far, so an error can name the field the user sees instead of its path. */
export const FIELD_LABELS = new Map<string, string>();

/** Text of a refused request; a config entry is named by its label and its limits are written out (thousands separated). */
function failText(err: ApiError): string {
  const params = err.params ? { ...err.params } : undefined;
  const label = typeof params?.path === 'string' ? FIELD_LABELS.get(params.path) : undefined;
  if (params && label) params.path = t(label);
  if (params && typeof params.min === 'number') params.min = groupNumber(params.min);
  if (params && typeof params.max === 'number') params.max = groupNumber(params.max);
  return errorText({ code: err.code, params: params as ApiError['params'] });
}

/** Stages one config entry (sent by Save); the cached config follows at once so a tab built again shows the pending value. */
function saveEntry(env: Env, path: string, value: unknown): void {
  if (env.options) setPath(env.options.config, path, value);
  env.stage(`config:${path}`, (dry) => api<ApiError>(dry ? '/api/config?dryRun=1' : '/api/config', { method: 'PUT', body: toPatch(path, value) }));
}

type FieldKind = 'number' | 'text' | 'bool' | 'lines';
interface FieldDef { path: string; label: string; kind: FieldKind; help?: string; /** An (i) tooltip next to a text or number input. */ tip?: string }

/** One editable entry: a change is staged for Save (PUT /api/config); a value that is not a number is refused at once. */
function createField(env: Env, def: FieldDef): HTMLElement {
  const row = el('label', def.kind === 'bool' ? 'settings-switch' : 'options-field');
  FIELD_LABELS.set(def.path, def.label);
  const text = el('span');
  bindText(text, def.label);
  const current = getPath(env.options?.config, def.path);
  if (def.kind === 'bool') {
    const box = el('input');
    box.type = 'checkbox';
    box.name = def.path;
    box.checked = current === true;
    box.addEventListener('change', () => saveEntry(env, def.path, box.checked));
    row.append(box, text);
    if (def.help) row.append(infoIcon(def.help)); // a switch explains itself in a tooltip, not in a line below
  } else if (def.kind === 'lines') {
    const area = el('textarea');
    area.name = def.path;
    area.rows = 5;
    const show = (v: unknown): string => (Array.isArray(v) ? v.join('\n') : '');
    area.value = show(current);
    area.addEventListener('change', () => {
      const wanted = area.value.split('\n').map((l) => l.trim()).filter((l) => l !== '');
      area.value = wanted.join('\n');
      saveEntry(env, def.path, wanted);
    });
    row.append(text, area);
  } else {
    const input = el('input');
    input.name = def.path;
    input.autocomplete = 'off';
    if (def.kind === 'number') { input.type = 'number'; input.step = '1'; }
    input.value = current === undefined || current === null ? '' : String(current);
    let saved = input.value;
    input.addEventListener('change', () => {
      const raw = input.value.trim();
      const wanted: unknown = def.kind === 'number' ? (raw === '' ? Number.NaN : Number(raw)) : raw;
      if (typeof wanted === 'number' && !Number.isFinite(wanted)) {
        env.fail({ status: 422, body: { code: 'config.invalid', params: { path: def.path } } });
        input.value = saved;
        return;
      }
      saved = input.value = String(wanted);
      saveEntry(env, def.path, wanted);
    });
    row.append(text, input);
    if (def.tip) row.append(infoIcon(def.tip));
  }
  if (def.help && def.kind !== 'bool') {
    const wrap = el('div', 'options-field-wrap');
    wrap.append(row, note(def.help));
    return wrap;
  }
  return row;
}

const fields = (env: Env, defs: FieldDef[]): HTMLElement => {
  const box = el('div', 'settings-agents');
  for (const d of defs) box.append(createField(env, d));
  return box;
};

interface SliderDef { path: string; label: string; min: number; max: number; step: number; format?: (n: number) => string }

/** A horizontal slider with its value shown at the right in a read-only box. `onValue` runs with the value after every move. */
export function createSlider(def: SliderDef, start: number, onValue: (n: number, slider: HTMLInputElement) => number): { row: HTMLElement; set(n: number): void; get(): number } {
  const row = el('div', 'options-slider');
  FIELD_LABELS.set(def.path, def.label);
  const text = el('span', 'options-slider-label');
  bindText(text, def.label);
  const input = el('input');
  input.type = 'range';
  input.name = def.path;
  input.min = String(def.min);
  input.step = String(def.step);
  // A saved value beyond the usual range stays reachable: the scale grows to hold it.
  input.max = String(Math.max(def.max, start));
  const out = el('output', 'options-slider-value');
  const fmt = def.format ?? ((n: number) => String(n));
  const paint = (): void => {
    const n = Number(input.value);
    out.textContent = fmt(n);
    input.style.setProperty('--fill', `${((n - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100}%`);
  };
  const set = (n: number): void => { input.value = String(n); paint(); };
  input.value = String(start);
  paint();
  input.addEventListener('input', () => { set(onValue(Number(input.value), input)); });
  const line = el('div', 'options-slider-line');
  line.append(input, out);
  row.append(text, line);
  return { row, set, get: () => Number(input.value) };
}

export const groupNumber = (n: number): string => new Intl.NumberFormat(language()).format(n);

/** One slider for one config entry (staged like any field). */
function sliderField(env: Env, def: SliderDef): HTMLElement {
  const start = Number(getPath(env.options?.config, def.path) ?? def.min);
  const s = createSlider(def, start, (n) => { saveEntry(env, def.path, n); return n; });
  return s.row;
}

/**
 * Sliders that must stay in order (alert below restriction below stop): a slider that reaches its neighbour pushes it (and the next one) along,
 * in both directions, and stops only when the whole chain reaches the end of the scale. The whole group is sent as one request, because the
 * server checks the order of the group and a value sent alone could be refused against the old values of the others.
 * `gaps[i]` is the least distance from slider i to slider i+1.
 */
function sliderGroup(env: Env, defs: SliderDef[], gaps: number[]): HTMLElement {
  const box = el('div', 'options-slider-group');
  const values = defs.map((d) => Number(getPath(env.options?.config, d.path) ?? d.min));
  const sliders: ReturnType<typeof createSlider>[] = [];
  const stage = (): void => {
    const patch: Record<string, unknown> = {};
    defs.forEach((d, i) => { setPath(patch, d.path, values[i]); if (env.options) setPath(env.options.config, d.path, values[i]); });
    env.stage(`config:${defs[0]!.path}+`, (dry) => api<ApiError>(dry ? '/api/config?dryRun=1' : '/api/config', { method: 'PUT', body: patch }));
  };
  const sum = (from: number, to: number): number => gaps.slice(from, to).reduce((a, g) => a + g, 0);
  const last = defs.length - 1;
  defs.forEach((d, i) => {
    sliders.push(createSlider(d, values[i]!, (n) => {
      // The slider can go as far as the whole chain still fits between the ends of the scale.
      const lo = defs[0]!.min + sum(0, i);
      const hi = Math.max(defs[last]!.max, values[last]!) - sum(i, last);
      values[i] = Math.min(Math.max(n, lo), hi);
      for (let j = i + 1; j <= last; j++) values[j] = Math.max(values[j]!, values[j - 1]! + gaps[j - 1]!);
      for (let j = i - 1; j >= 0; j--) values[j] = Math.min(values[j]!, values[j + 1]! - gaps[j]!);
      sliders.forEach((sl, j) => { if (j !== i) sl.set(values[j]!); });
      stage();
      return values[i]!;
    }));
    box.append(sliders[i]!.row);
  });
  return box;
}

const unavailable = (env: Env): HTMLElement | undefined => (env.options ? undefined : note(k('options.loadFailed')));

function budgetTab(env: Env): HTMLElement {
  const box = el('div', 'settings-agents');
  const bad = unavailable(env);
  if (bad) { box.append(bad); return box; }
  box.append(
    fields(env, [
      { path: 'agents.maxActiveGlobal', label: k('options.agents.maxActiveGlobal'), kind: 'number' },
      { path: 'agents.maxActivePerProject', label: k('options.agents.maxActivePerProject'), kind: 'number' },
      { path: 'agents.requestTimeoutMinutes', label: k('options.agents.requestTimeoutMinutes'), kind: 'number', tip: k('options.agents.requestTimeoutMinutes.tip') },
      { path: 'agents.requestMaxHops', label: k('options.agents.requestMaxHops'), kind: 'number', tip: k('options.agents.requestMaxHops.tip') },
    ]),
    note(k('options.agents.maxActive.help')),
    heading(k('options.budget.tokens')),
    sliderField(env, { path: 'budget.agentTokens', label: k('options.budget.agentTokens'), min: 50_000, max: 2_000_000, step: 50_000, format: groupNumber }),
    sliderGroup(env, [
      { path: 'budget.alertPercent', label: k('options.budget.alertPercent'), min: 5, max: 200, step: 5, format: (n) => `${n} %` },
      { path: 'budget.limitPercent', label: k('options.budget.limitPercent'), min: 5, max: 200, step: 5, format: (n) => `${n} %` },
      { path: 'budget.stopPercent', label: k('options.budget.stopPercent'), min: 5, max: 200, step: 5, format: (n) => `${n} %` },
    ], [5, 0]),
    fields(env, [{ path: 'budget.graceMinutes', label: k('options.budget.graceMinutes'), kind: 'number' }]),
    heading(k('options.budget.loops')),
    fields(env, [
      { path: 'budget.loop.sameCall', label: k('options.budget.loop.sameCall'), kind: 'number' },
      { path: 'budget.loop.sameError', label: k('options.budget.loop.sameError'), kind: 'number' },
      { path: 'budget.loop.compactions', label: k('options.budget.loop.compactions'), kind: 'number' },
      { path: 'budget.loop.stepMinutes', label: k('options.budget.loop.stepMinutes'), kind: 'number' },
      { path: 'budget.loop.silenceMinutes', label: k('options.budget.loop.silenceMinutes'), kind: 'number', tip: k('options.budget.loop.silenceMinutes.tip') },
    ]),
    heading(k('options.budget.quota')),
    sliderGroup(env, [
      { path: 'budget.quota.halvePercent', label: k('options.budget.quota.halvePercent'), min: 5, max: 100, step: 5, format: (n) => `${n} %` },
      { path: 'budget.quota.freezePercent', label: k('options.budget.quota.freezePercent'), min: 5, max: 100, step: 5, format: (n) => `${n} %` },
      { path: 'budget.quota.stopPercent', label: k('options.budget.quota.stopPercent'), min: 5, max: 100, step: 5, format: (n) => `${n} %` },
    ], [5, 5]),
    fields(env, [
      { path: 'budget.quota.staggerSeconds', label: k('options.budget.quota.staggerSeconds'), kind: 'number' },
      { path: 'budget.quota.staggerGroup', label: k('options.budget.quota.staggerGroup'), kind: 'number' },
    ]),
    footnote(k('options.budget.appliesToNew')),
  );
  return box;
}

/** Whether git is installed (from the prerequisite checks) and, when it is not, the exact command the console would run to install it. */
function gitTab(env: Env): HTMLElement {
  const box = el('div', 'settings-agents');
  const bad = unavailable(env);
  if (bad) { box.append(bad); return box; }
  // Nothing about the program while git is there. When it is not (missing, unreadable, installed but not visible yet) one red line sends the
  // user to Prerequisites; it is checked again every time the tab is shown, so it goes away after an install.
  const missing = el('p', 'form-error options-git-missing');
  bindText(missing, 'options.git.missing');
  const syncMissing = (): void => {
    const git = env.state?.prereq?.find((r) => r.id === 'git');
    if (git !== undefined && git.status !== 'ok') box.prepend(missing); else missing.remove(); // unknown (checks not finished): nothing to say yet
  };
  box.addEventListener('optionsshow', syncMissing);
  syncMissing();
  box.append(renderGitProject(env.state, env.fail, heading(k('options.git.project'))));
  box.append(
    fields(env, [
      { path: 'git.worktrees', label: k('options.git.worktrees'), kind: 'bool', help: k('options.git.worktrees.help') },
      { path: 'git.testTimeoutMinutes', label: k('options.git.testTimeoutMinutes'), kind: 'number' },
    ]),
  );
  return box;
}

function guardTab(env: Env): HTMLElement {
  const state = env.state;
  const box = el('div', 'settings-agents');
  box.append(heading(k('settings.agents')));
  const bypassRow = el('label', 'settings-switch');
  const bypass = el('input');
  bypass.type = 'checkbox';
  bypass.name = 'bypass';
  bypass.checked = state?.settings.bypassPermissions ?? false;
  const bypassText = el('span');
  bindText(bypassText, 'settings.bypass');
  bypassRow.append(bypass, bypassText);
  const warning = el('p', 'settings-warning');
  bindText(warning, 'settings.bypass.warning');
  bypass.addEventListener('change', () => {
    saveEntry(env, 'agents.bypassPermissions', bypass.checked);
  });

  const guardRow = el('label');
  const guardText = el('span');
  bindText(guardText, 'settings.guardMode');
  const guard = el('select');
  guard.name = 'guardMode';
  for (const mode of ['enforce', 'shadow'] as const) {
    const o = el('option');
    o.value = mode;
    bindText(o, mode === 'enforce' ? k('settings.guardMode.enforce') : k('settings.guardMode.shadow'));
    guard.append(o);
  }
  guard.value = state?.settings.guardMode ?? 'enforce';
  guard.addEventListener('change', () => saveEntry(env, 'guard.mode', guard.value));
  guardRow.append(guardText, guard);
  box.append(bypassRow, warning, guardRow);
  return box;
}

function projectsTab(env: Env): HTMLElement {
  const state = env.state;
  const box = el('div', 'settings-agents');
  const squashRow = el('label', 'settings-switch');
  const squash = el('input');
  squash.type = 'checkbox';
  squash.name = 'squash';
  squash.checked = state?.project.squash !== false; // one commit per merged ticket unless the project says otherwise
  const squashText = el('span');
  bindText(squashText, 'settings.squash');
  squashRow.append(squash, squashText, infoIcon(k('settings.squash.help')));
  squash.addEventListener('change', () => {
    const wanted = squash.checked;
    env.stage('project:squash', (dry) => api<ApiError>(dry ? '/api/project?dryRun=1' : '/api/project', { method: 'PUT', body: { squash: wanted } }));
  });

  // Inhibit the tests: nothing runs them (validation step, review, merge, release) and the reports say "not run". For a project that has none.
  const offRow = el('label', 'settings-switch');
  const off = el('input');
  off.type = 'checkbox';
  off.name = 'testsDisabled';
  off.checked = state?.project.testsDisabled === true;
  const offText = el('span');
  bindText(offText, 'settings.testsDisabled');
  offRow.append(off, offText, infoIcon(k('settings.testsDisabled.help')));

  const testForm = el('form', 'settings-test');
  const testLabel = el('label');
  const testText = el('span', 'options-field-head');
  const testName = el('span');
  bindText(testName, 'settings.testCommand');
  const test = el('input');
  test.name = 'testCommand';
  test.autocomplete = 'off';
  test.value = state?.project.testCommand ?? '';
  testLabel.append(testText, test);
  testForm.addEventListener('submit', (ev) => ev.preventDefault());
  test.addEventListener('change', () => {
    const wanted = test.value;
    env.stage('project:testCommand', (dry) => api<ApiError>(dry ? '/api/project?dryRun=1' : '/api/project', { method: 'PUT', body: { testCommand: wanted } }));
  });
  // Empty means "use what the project's files suggest": the placeholder shows it. Everything that explains the field (what runs it, what was
  // detected, what happens with no command) is in its (i) tooltip, not in lines under it.
  const detected = state?.project.detectedTestCommand;
  const repos = state?.project.repos ?? [];
  if (detected) test.placeholder = detected;
  // A folder of several repositories has no build file of its own: each repository detects its own command (its row below), so the
  // project-wide field must not say that nothing was detected.
  const testTip = detected ? infoIcon(k('settings.testCommand.tip.detected'), { command: detected })
    : repos.length > 0 ? infoIcon(k('settings.testCommand.tip.repos')) : infoIcon(k('settings.testCommand.tip.none'));
  testText.append(testName, testTip);
  testForm.append(testLabel);
  // The same command can be narrower at one moment (a fast, pointed run for a ticket, a smoke set after a merge); empty uses the one above.
  const momentInputs = (['ticket', 'merge', 'release'] as const).map((moment) => {
    const label = el('label');
    const head = el('span', 'options-field-head');
    const name = el('span');
    bindText(name, `settings.testCommands.${moment}`);
    head.append(name, infoIcon(k(`settings.testCommands.${moment}.tip`)));
    const input = el('input');
    input.name = `testCommands.${moment}`;
    input.autocomplete = 'off';
    input.value = state?.project.testCommands?.[moment] ?? '';
    input.addEventListener('change', () => {
      const wanted = input.value;
      env.stage(`project:testCommands.${moment}`, (dry) => api<ApiError>(dry ? '/api/project?dryRun=1' : '/api/project', { method: 'PUT', body: { testCommands: { [moment]: wanted } } }));
    });
    label.append(head, input);
    testForm.append(label);
    return input;
  });
  // A folder of several repositories: one command per repository, before every field above; the placeholder is what its files suggest.
  const repoInputs = repos.map((repo) => {
    const label = el('label');
    const head = el('span', 'options-field-head');
    const name = el('span');
    bindText(name, 'settings.repoTestCommand', { repo });
    head.append(name, infoIcon(k('settings.repoTestCommand.tip'), { repo }));
    const input = el('input');
    input.name = `repoTestCommands.${repo}`;
    input.autocomplete = 'off';
    input.value = state?.project.repoTestCommands?.[repo] ?? '';
    const found = state?.project.detectedRepoTestCommands?.[repo];
    if (found) input.placeholder = found; else setPlaceholder(input, k('common.notAvailable'));
    input.addEventListener('change', () => {
      const wanted = input.value;
      env.stage(`project:repoTestCommands.${repo}`, (dry) => api<ApiError>(dry ? '/api/project?dryRun=1' : '/api/project', { method: 'PUT', body: { repoTestCommands: { [repo]: wanted } } }));
    });
    label.append(head, input);
    testForm.append(label);
    return input;
  });
  // With the tests inhibited the command is not used: the field is disabled (and dimmed), its text is kept for when they come back.
  const syncTests = (): void => { for (const i of [test, ...momentInputs, ...repoInputs]) i.disabled = off.checked; testForm.classList.toggle('is-off', off.checked); };
  off.addEventListener('change', () => {
    const wanted = off.checked;
    env.stage('project:testsDisabled', (dry) => api<ApiError>(dry ? '/api/project?dryRun=1' : '/api/project', { method: 'PUT', body: { testsDisabled: wanted } }));
    syncTests();
  });
  syncTests();
  box.append(squashRow, offRow, testForm);

  // Fields of the project: always shown (a project made from the generic template carries none yet, and this is where they are set).
  const project = (state?.project ?? {}) as Record<string, unknown>;
  const stageProject = (key: string, wanted: unknown): void => env.stage(`project:${key}`, (dry) => api<ApiError>(dry ? '/api/project?dryRun=1' : '/api/project', { method: 'PUT', body: { [key]: wanted } }));
  const modelRow = el('label', 'options-field');
  const modelText = el('span');
  bindText(modelText, 'options.projects.model');
  const model = el('select');
  model.name = 'model';
  loadModelSelect(model, String(project.model ?? ''), k('options.projects.model.default'));
  model.addEventListener('change', () => stageProject('model', model.value));
  modelRow.append(modelText, model);
  box.append(modelRow);
  const maxRow = el('label', 'options-field');
  const maxText = el('span');
  bindText(maxText, 'options.projects.maxActive');
  const maxInput = el('input');
  maxInput.name = 'maxActive';
  FIELD_LABELS.set('project.maxActive', 'options.projects.maxActive');
  maxInput.type = 'number';
  maxInput.value = String(project.maxActive ?? '');
  maxInput.addEventListener('change', () => stageProject('maxActive', maxInput.value.trim() === '' ? null : Number(maxInput.value)));
  maxRow.append(maxText, maxInput);
  box.append(maxRow);
  // The token budget of this project's agents: a slider like the one of Budget and limits, starting where the project stands now. Only a move is saved.
  const globalTokens = Number(getPath(env.options?.config, 'budget.agentTokens') ?? 500_000);
  const tokens = createSlider({ path: 'agentTokens', label: k('options.projects.agentTokens'), min: 50_000, max: 2_000_000, step: 50_000, format: groupNumber },
    Number(project.agentTokens ?? globalTokens), (n) => { stageProject('agentTokens', n); return n; });
  box.append(tokens.row);
  maxInput.placeholder = String(getPath(env.options?.config, 'agents.maxActivePerProject') ?? ''); // empty: the default of Budget and limits

  // The settings of another open project, copied onto this one (what the new-project dialog also offers).
  const others = (env.getState()?.projects ?? []).filter((p) => p.name !== state?.project.name);
  if (others.length > 0) {
    const from = el('select');
    from.name = 'copyFrom';
    for (const p of others) { const o = el('option'); o.value = p.name; o.textContent = p.name; from.append(o); }
    const copyBtn = el('button');
    copyBtn.type = 'button';
    copyBtn.name = 'copySettings';
    bindText(copyBtn, 'options.projects.copy.apply');
    const copied = note(k('options.projects.copy.help'));
    copyBtn.addEventListener('click', () => {
      if (!window.confirm(t(k('options.projects.copy.confirm'), { from: from.value }))) return;
      copyBtn.disabled = true;
      void api<ApiError>('/api/projects/copy-settings', { method: 'POST', body: { from: from.value } }).then((res) => {
        copyBtn.disabled = false;
        if (!env.fail(res)) bindText(copied, 'options.projects.copy.done', { from: from.value });
      });
    });
    const copyLabel = el('label', 'options-field');
    const copyText = el('span');
    bindText(copyText, 'options.projects.copy');
    copyLabel.append(copyText, from);
    box.append(copyLabel, copyBtn, copied);
  }

  // Another template for this project: its profiles, main.md and rules.md replace the files of the same name; the commands stay.
  const pick = el('select');
  pick.name = 'template';
  const apply = el('button');
  apply.type = 'button';
  apply.name = 'applyTemplate';
  bindText(apply, 'options.projects.template.apply');
  apply.disabled = true;
  const applied = note(k('options.projects.template.help'));
  void api<{ id: string; name: Record<string, string>; valid: boolean }[]>('/api/templates').then((res) => {
    if (res.status !== 200) return;
    for (const item of res.body.filter((x) => x.valid)) {
      const o = el('option');
      o.value = item.id;
      o.textContent = item.name[language()] ?? item.name.en ?? item.id;
      pick.append(o);
    }
    apply.disabled = pick.options.length === 0;
  });
  apply.addEventListener('click', () => {
    apply.disabled = true;
    void api<ApiError>('/api/projects/apply-template', { method: 'POST', body: { templateId: pick.value } }).then((res) => {
      apply.disabled = false;
      if (!env.fail(res)) bindText(applied, 'options.projects.template.done');
    });
  });
  const templateLabel = el('label', 'options-field');
  const templateText = el('span');
  bindText(templateText, 'options.projects.template');
  templateLabel.append(templateText, pick);
  box.append(templateLabel, apply, applied);

  const template = el('button');
  template.type = 'button';
  template.name = 'saveTemplate';
  bindText(template, 'options.projects.saveTemplate');
  template.addEventListener('click', () => openSaveTemplateDialog(env.getState));
  box.append(template);
  return box;
}

function profilesTab(env: Env): HTMLElement {
  const box = el('div', 'settings-agents options-profiles-box');
  const bad = unavailable(env);
  if (bad) { box.append(bad); return box; }
  renderProfilesTab(box, env.options!.paths.profilesDir, Number(getPath(env.options!.config, 'budget.agentTokens') ?? 500_000), (on) => env.profileEditing(on));
  return box;
}

function languageTab(env: Env): HTMLElement {
  const row = el('label');
  const text = el('span');
  bindText(text, 'settings.language');
  const select = createLanguageSelect(env.state?.language ?? 'en', env.state?.languages ?? [], (value) => {
    env.stage('config:language', (dry) => api<ApiError>(dry ? '/api/config?dryRun=1' : '/api/config', { method: 'PUT', body: { language: value } }));
  });
  row.append(text, select);
  return row;
}

function prereqTab(env: Env): HTMLElement {
  const box = el('div');
  const table = el('div');
  renderPrereqTable(table, env.state?.prereq ?? null, undefined, false, env.state?.helperUse);
  box.append(table); // no title: the tab is already called Prerequisites
  return box;
}

/** The agent model menu: Default, then the catalog's real models; a saved choice that left the catalog stays selected with a warning. */
function modelsTab(env: Env): HTMLElement {
  const box = el('div', 'settings-agents options-models');
  const bad = unavailable(env);
  if (bad) { box.append(bad); return box; }
  const head = el('div', 'options-field-head');
  const text = el('span');
  bindText(text, 'options.models.agent');
  const updated = el('span', 'settings-note');
  head.append(text, updated);
  const select = el('select');
  select.name = 'models.agent';
  const refresh = el('button', 'icon-btn icon-refresh');
  refresh.type = 'button';
  refresh.name = 'refreshModels';
  setTitle(refresh, k('options.models.refresh'));
  const pick = el('div', 'options-select-row');
  pick.append(select, refresh);
  const missing = el('p', 'settings-warning');
  missing.hidden = true;
  let wantedModel = String(getPath(env.options!.config, 'models.agent') ?? '');

  const render = (list: ModelList): void => {
    fillModelSelect(select, list.models, wantedModel, k('options.models.default'));
    const current = wantedModel;
    bindText(updated, 'options.models.updated', { updated: list.updated ?? t('common.notAvailable') });
    missing.hidden = !(list.missing && current === list.current);
    if (!missing.hidden) bindText(missing, 'options.models.missing', { model: current });
  };
  const load = (path: string, method: string): void => {
    void api<ModelList>(path, { method }).then((res) => { if (res.status === 200) render(res.body); else env.fail(res); });
  };
  select.addEventListener('change', () => {
    wantedModel = select.value;
    saveEntry(env, 'models.agent', wantedModel);
    missing.hidden = true;
  });
  refresh.addEventListener('click', () => load('/api/models/refresh', 'POST'));

  const urlLabel = el('label', 'options-field');
  const urlHead = el('span', 'options-field-head');
  const urlText = el('span');
  bindText(urlText, 'options.models.catalogUrl');
  urlHead.append(urlText, infoIcon(k('options.models.catalogUrl.help')));
  const url = el('input');
  url.name = 'models.catalogUrl';
  url.autocomplete = 'off';
  url.value = String(getPath(env.options!.config, 'models.catalogUrl') ?? '');
  url.addEventListener('change', () => saveEntry(env, 'models.catalogUrl', url.value.trim()));
  urlLabel.append(urlHead, url);

  const agentRow = el('div', 'options-field');
  agentRow.append(head, pick);
  box.append(agentRow, missing, urlLabel);
  load('/api/models', 'GET');
  return box;
}

const TIERS = ['recommended', 'on_request', 'discouraged'] as const;

/** The plugin catalog as a list to read: nothing is installed or enabled from here, the exact command is shown to copy. */
function pluginsTab(env: Env): HTMLElement {
  const box = el('div', 'settings-agents');
  box.append(note(k('options.plugins.readOnly')));
  const body = el('div', 'options-plugins');
  const source = el('p', 'settings-note');
  const refresh = el('button');
  refresh.type = 'button';
  refresh.name = 'refreshPlugins';
  bindText(refresh, 'options.plugins.refresh');
  const lang = language();
  let installed: InstalledMap | undefined; // undefined: not asked yet
  const unreadable = note(k('options.plugins.installed.unreadable'));
  unreadable.hidden = true;
  /** Writes the install state on every card (and drops the command to copy from a plugin that is already there). */
  const showInstalled = (): void => {
    unreadable.hidden = installed !== null;
    if (installed === undefined) return;
    for (const card of body.querySelectorAll<HTMLElement>('.options-plugin')) {
      const slot = card.querySelector<HTMLElement>('.options-plugin-status')!;
      const status = installed?.[card.dataset.plugin ?? ''];
      const here = status?.state === 'installed' || status?.state === 'project' || status?.state === 'disabled';
      card.classList.toggle('is-installed', here);
      card.querySelector<HTMLElement>('.options-command-row')?.toggleAttribute('hidden', here);
      slot.className = `options-plugin-status${here ? ' ok' : ''}`;
      if (!status) { slot.removeAttribute('data-i18n'); slot.textContent = ''; continue; }
      bindText(slot, `options.plugins.installed.${status.state}`, { version: status.version ?? t('common.notAvailable') });
    }
  };
  const render = (list: PluginList): void => {
    bindText(source, `options.plugins.source.${list.source}`, { updated: list.updated ?? t('common.notAvailable') });
    body.replaceChildren();
    for (const tier of TIERS) {
      const rows = list.plugins.filter((p) => p.tier === tier);
      if (rows.length === 0) continue;
      const tierTitle = el('h3', 'options-heading');
      bindText(tierTitle, `options.plugins.tier.${tier}`);
      body.append(tierTitle);
      for (const p of rows) {
        const card = el('div', 'options-plugin');
        card.dataset.plugin = p.id;
        const title = el('div', 'options-plugin-title');
        const id = el('strong');
        id.textContent = p.id;
        const trust = el('span', 'settings-note');
        bindText(trust, `options.plugins.trust.${p.trust}`);
        const status = el('span', 'options-plugin-status');
        title.append(id, trust, status);
        const summary = el('p');
        summary.textContent = p.summary[lang] ?? p.summary.en ?? '';
        card.append(title, summary);
        // The context a plugin takes is shown only when it is known: a line that always says n/a is noise.
        if (p.cost?.contextTokens != null) {
          const cost = el('p', 'settings-note');
          bindText(cost, 'options.plugins.cost', { value: p.cost.contextTokens });
          card.append(cost);
        }
        if (p.requires.length > 0) card.append(note(k('options.plugins.requires'), { list: p.requires.join(', ') }));
        for (const c of p.conflicts) {
          const w = el('p', 'settings-warning');
          w.textContent = c[lang] ?? c.en ?? '';
          card.append(w);
        }
        if (!p.agentsAllowed) card.append(note(k('options.plugins.notForAgents')));
        if (p.notTested) {
          const w = el('p', 'settings-warning');
          bindText(w, 'options.plugins.notTested');
          card.append(w);
        }
        if (tier !== 'discouraged') {
          const cmd = el('input', 'options-command');
          cmd.readOnly = true;
          cmd.value = p.installCommand;
          cmd.name = 'installCommand';
          const copy = el('button');
          copy.type = 'button';
          bindText(copy, 'options.plugins.copy');
          copy.addEventListener('click', () => {
            try { void navigator.clipboard.writeText(p.installCommand).catch(() => cmd.select()); } catch { cmd.select(); }
          });
          const line = el('div', 'options-command-row');
          line.append(cmd, copy);
          card.append(line);
        }
        body.append(card);
      }
    }
    showInstalled(); // the state asked earlier (a refresh of the catalog does not ask Claude again)
  };
  const load = (path: string, method: string): void => {
    void api<PluginList>(path, { method }).then((res) => { if (res.status === 200) render(res.body); else env.fail(res); });
  };
  // Which plugins are installed comes from Claude Code and takes a moment: the catalog shows first, the states follow.
  const loadInstalled = (): void => {
    void api<{ installed: InstalledMap }>('/api/plugins/installed').then((res) => { if (res.status === 200) { installed = res.body.installed; showInstalled(); } });
  };
  refresh.addEventListener('click', () => { load('/api/plugins/refresh', 'POST'); loadInstalled(); });
  box.append(refresh, source, unreadable, body);
  load('/api/plugins', 'GET');
  loadInstalled();
  return box;
}

/** Settings Claude reads only when a session starts: a changed one asks for a restart after Save. */
const RESTART_PATHS = ['agents.bypassPermissions', 'guard.mode', 'models.agent', 'notifications.mainPush'] as const;

const BUILDERS: Record<OptionTab, (env: Env) => HTMLElement> = {
  models: modelsTab, profiles: profilesTab, budget: budgetTab, projects: projectsTab, git: gitTab, guard: guardTab,
  notifications: (env) => {
    const box = el('div');
    if (env.state) renderNotificationsTab(box, env.state, env.stage, (path, value) => { if (env.options) setPath(env.options.config, path, value); });
    return box;
  },
  language: languageTab, prerequisites: prereqTab, plugins: pluginsTab,
  secrets: (env) => {
    const box = el('div');
    renderSecretsTab(box, env.stage);
    return box;
  },
};

/** Where a restart-relevant setting is when the options payload has no value for it (the guard tab reads the state, not the config). */
function getRestartDefault(path: (typeof RESTART_PATHS)[number], state: StateMessage | undefined): unknown {
  if (path === 'agents.bypassPermissions') return state?.settings.bypassPermissions ?? false;
  if (path === 'guard.mode') return state?.settings.guardMode ?? 'enforce';
  if (path === 'notifications.mainPush') return false;
  return '';
}

/** Opens the tabbed Options dialog (SPEC 5.8). Changes are staged while editing; Save sends them and closes, X discards them. */
export async function openOptions(getState: () => StateMessage | undefined, first: OptionTab = 'models'): Promise<void> {
  const overlay = document.getElementById('overlay')!;
  const loaded = await api<OptionsPayload>('/api/options').catch(() => ({ status: 0, body: null }));
  const dialog = el('div', 'dialog options-dialog');
  dialog.dataset.escape = '';
  const title = el('h2');
  bindText(title, 'settings.title');
  const error = el('div', 'form-error');
  const pending = new Map<string, (dry: boolean) => Promise<{ status: number; body: unknown }>>();
  let editingProfile = false;
  let current: OptionTab = first;
  let syncSave = (): void => undefined; // set once the Save button exists
  const startLanguage = getState()?.language;
  const env: Env = {
    state: getState(), options: loaded.status === 200 ? (loaded.body as OptionsPayload) : null, error, getState,
    fail: (res) => {
      if (res.status === 200) { error.textContent = ''; return false; }
      error.textContent = failText(res.body as ApiError);
      return true;
    },
    stage: (key, run) => { pending.delete(key); pending.set(key, run); },
    profileEditing: (on) => { editingProfile = on; syncSave(); },
  };
  const tabs = el('div', 'options-tabs');
  tabs.setAttribute('role', 'tablist');
  const panel = el('div', 'options-panel');
  panel.setAttribute('role', 'tabpanel');
  const buttons = new Map<OptionTab, HTMLButtonElement>();
  const built = new Map<OptionTab, HTMLElement>(); // a tab keeps its fields while another is shown, so staged edits are not lost
  // A tab that is not on screen is not in the document, so a language change would skip it: translate every kept tab again.
  const onLanguage = (): void => {
    if (!dialog.isConnected) { window.removeEventListener('languagechange', onLanguage); return; }
    for (const view of built.values()) retranslate(view);
  };
  window.addEventListener('languagechange', onLanguage);
  const LIVE: readonly OptionTab[] = ['prerequisites', 'plugins']; // read-only views rebuilt on every visit
  const show = (tab: OptionTab): void => {
    for (const [id, b] of buttons) { b.setAttribute('aria-selected', String(id === tab)); b.classList.toggle('selected', id === tab); }
    error.textContent = '';
    current = tab;
    syncSave();
    env.state = getState() ?? env.state; // the dialog may stay open while projects and settings change
    let view = built.get(tab);
    if (!view || LIVE.includes(tab)) { view = BUILDERS[tab](env); built.set(tab, view); }
    panel.replaceChildren(view);
    view.dispatchEvent(new Event('optionsshow')); // a kept tab may need to look at the state again
  };
  for (const group of OPTION_GROUPS) {
    const head = el('div', 'options-group');
    head.setAttribute('role', 'presentation');
    bindText(head, `options.group.${group.id}`);
    tabs.append(head);
    for (const id of group.tabs) {
      const b = el('button', 'options-tab');
      b.type = 'button';
      b.dataset.tab = id;
      b.setAttribute('role', 'tab');
      bindText(b, `options.tab.${id}`);
      b.addEventListener('click', () => show(id));
      buttons.set(id, b);
      tabs.append(b);
    }
  }
  const x = el('button', 'icon-btn dialog-x');
  x.type = 'button';
  x.name = 'closeOptions';
  setTitle(x, 'common.close');
  x.addEventListener('click', () => {
    const lang = startLanguage;
    closeOverlay();
    if (lang !== undefined && lang !== language()) void setLanguage(lang); // a language previewed but not saved goes back
  });
  const save = el('button');
  save.type = 'button';
  save.name = 'saveOptions';
  const readNow = (): unknown[] => RESTART_PATHS.map((p) => getPath(env.options?.config, p) ?? getRestartDefault(p, getState()));
  const before = readNow();
  bindText(save, 'common.save');
  save.addEventListener('click', () => {
    save.disabled = true;
    void (async () => {
      // All or nothing: every staged change is first only checked (nothing is written), so all the refusals are shown together and a
      // refused Save leaves everything as it was, the changes staged and the dialog open.
      const refused: string[] = [];
      for (const [, run] of pending) {
        const res = await run(true).catch(() => ({ status: 0, body: { code: 'network' } }));
        if (res.status === 200) continue;
        const text = failText(res.body as ApiError);
        if (!refused.includes(text)) refused.push(text);
      }
      if (refused.length > 0) { error.textContent = refused.join('\n'); save.disabled = false; return; }
      error.textContent = '';
      for (const [key, run] of [...pending]) {
        const res = await run(false).catch(() => ({ status: 0, body: { code: 'network' } }));
        if (env.fail(res)) { save.disabled = false; return; } // not expected after the check (a file changed meanwhile); what is left stays staged
        pending.delete(key);
      }
      // The guard and bypass tabs are built from the state, the others from the config: the staged value is in the config either way.
      const after = readNow();
      const settings = after.some((v, i) => JSON.stringify(v) !== JSON.stringify(before[i]));
      if (settings) openRestartDialog();
      else closeOverlay();
    })();
  });
  syncSave = (): void => { save.hidden = editingProfile && current === 'profiles'; };
  // The note about when settings apply is said once, here, next to Save (and stays when Save is hidden by the profile form).
  const foot = el('div', 'options-foot');
  foot.append(note(k('settings.appliesToNew')), save);
  dialog.append(title, x, tabs, panel, error, foot);
  overlay.replaceChildren(dialog);
  overlay.hidden = false;
  show(first);
}
