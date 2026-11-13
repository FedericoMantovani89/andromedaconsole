import type { ApiError, StateMessage } from '../shared/protocol';
import { api } from './api';
import { bindText, k, t } from './i18n-client';
import { errorText } from './new-agent';
import { el, note } from './dom';
import { infoIcon } from './info-icon';
import { setIconButton, type IconName } from './icons';

type Res = { status: number; body: unknown };

/** What the Audit tab needs from the Options dialog. */
export interface AuditTabEnv {
  state: StateMessage | undefined;
  /** The global audit settings as the options payload has them. */
  config: { level?: string; autoModel?: boolean; profile?: string } | undefined;
  /** Remembers a change until Save (the dialog sends it; nothing is written before). */
  stage(key: string, run: (dry: boolean) => Promise<Res>): void;
  /** Keeps the cached options in step with a staged global change, so a tab built again shows it. */
  setConfig(path: string, value: unknown): void;
  /** The style form has its own buttons: the dialog's Save is hidden meanwhile. */
  editing(on: boolean): void;
}

const LIMITS = ['diff_lines', 'files_touched', 'file_lines', 'comment_run_lines', 'comment_ratio'] as const;
const RANGES: Record<(typeof LIMITS)[number], [number, number]> = { diff_lines: [0, 100_000], files_touched: [0, 100_000], file_lines: [0, 100_000], comment_run_lines: [0, 100_000], comment_ratio: [0, 1] };
const LEVELS = ['off', 'metrics', 'full'] as const;

interface Row { name: string; source: 'project' | 'user' | 'shipped'; description: string; shipped: boolean; userFile: boolean; projectFile: boolean }
interface Detail extends Row {
  profile: { limits: Record<string, number>; commands: { lint?: string; format_check?: string }; conventions: string; description: string };
  text: string;
}

const button = (name: string, key: string, icon: IconName): HTMLButtonElement => {
  const b = el('button');
  b.type = 'button';
  b.name = name;
  setIconButton(b, icon, key);
  return b;
};

/** The profile as the file the console reads: English keys, the user's own words in the description and the body. */
function toText(f: { name: string; description: string; limits: Record<string, number>; lint: string; formatCheck: string; conventions: string }): string {
  const lines = ['---', `name: ${f.name}`];
  if (f.description.trim() !== '') lines.push(`description: ${f.description.replace(/[\r\n]+/g, ' ').trim()}`);
  lines.push('limits:', ...LIMITS.map((id) => `  ${id}: ${f.limits[id]}`));
  const cmds: [string, string][] = [['lint', f.lint.trim()], ['format_check', f.formatCheck.trim()]];
  if (cmds.some(([, v]) => v !== '')) lines.push('commands:', ...cmds.filter(([, v]) => v !== '').map(([id, v]) => `  ${id}: ${v}`));
  lines.push('---', f.conventions);
  return `${lines.join('\n')}\n`;
}

/**
 * The Audit tab (SPEC 15.7): how much of the audit runs (everywhere, and for this project), and the style profiles the audit judges by.
 * The settings are staged for the dialog's Save like every other tab; the style profiles are files, so each form sends itself with its own
 * Save, as the Profiles tab does.
 */
export function renderAuditTab(box: HTMLElement, env: AuditTabEnv): void {
  const error = el('div', 'form-error');
  const settings = el('div', 'options-audit-settings');
  const styles = el('div', 'options-profiles');
  box.append(settings, styles, error);

  const failure = (body: unknown): string => {
    const e = body as ApiError;
    const params = e.params ? { ...e.params } : undefined;
    if (params && typeof params.key === 'string' && e.code === 'style.badLimit') params.key = t(`audit.metric.${params.key}`); // the field the user sees, not its code
    return errorText({ code: e.code, ...(params ? { params: params as ApiError['params'] } : {}) });
  };
  const run = async (res: Promise<Res>): Promise<boolean> => {
    const r = await res;
    error.textContent = r.status === 200 ? '' : failure(r.body);
    return r.status === 200;
  };

  let names: string[] = [];
  const profileOptions = (select: HTMLSelectElement, current: string, inherit: boolean): void => {
    select.replaceChildren();
    if (inherit) { const o = el('option'); o.value = ''; bindText(o, 'options.audit.inherit'); select.append(o); }
    for (const n of names) { const o = el('option'); o.value = n; o.textContent = n; select.append(o); } // a name is data
    select.value = names.includes(current) || (inherit && current === '') ? current : inherit ? '' : (names[0] ?? '');
  };

  // ---- how much of the audit runs ----
  const globalCfg = env.config ?? {};
  const projectState = env.state?.project;
  const stageProject = (key: string, value: unknown): void => env.stage(`project:${key}`, (dry) => api<ApiError>(dry ? '/api/project?dryRun=1' : '/api/project', { method: 'PUT', body: { [key]: value } }));
  const stageGlobal = (path: string, value: unknown): void => {
    env.setConfig(`audit.${path}`, value);
    env.stage(`config:audit.${path}`, (dry) => api<ApiError>(dry ? '/api/config?dryRun=1' : '/api/config', { method: 'PUT', body: { audit: { [path]: value } } }));
  };
  const heading = (key: string): HTMLElement => { const h = el('h3', 'options-heading'); bindText(h, key); return h; };
  const row = (labelKey: string, helpKey: string, global: HTMLElement, project: HTMLElement): HTMLElement => {
    const r = el('div', 'options-audit-row');
    const label = el('span');
    bindText(label, labelKey);
    const g = el('label', 'options-field');
    const gs = el('span'); bindText(gs, 'options.audit.everywhere'); g.append(gs, global);
    const p = el('label', 'options-field');
    const ps = el('span'); bindText(ps, 'options.audit.thisProject'); p.append(ps, project);
    const head = el('div', 'options-audit-head');
    head.append(label, infoIcon(helpKey));
    r.append(head, g, p);
    return r;
  };
  const levelSelect = (name: string, inherit: boolean, value: string, onChange: (v: string) => void): HTMLSelectElement => {
    const s = el('select');
    s.name = name;
    if (inherit) { const o = el('option'); o.value = ''; bindText(o, 'options.audit.inherit'); s.append(o); }
    for (const l of LEVELS) { const o = el('option'); o.value = l; bindText(o, `options.audit.level.${l}`); s.append(o); }
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  };
  const autoSelect = (): HTMLSelectElement => {
    const s = el('select');
    s.name = 'auditAutoModelProject';
    for (const [v, key] of [['', k('options.audit.inherit')], ['true', k('options.audit.auto.on')], ['false', k('options.audit.auto.off')]] as const) { const o = el('option'); o.value = v; bindText(o, key); s.append(o); }
    s.value = projectState?.auditAutoModel === undefined ? '' : String(projectState.auditAutoModel);
    s.addEventListener('change', () => stageProject('auditAutoModel', s.value === '' ? null : s.value === 'true'));
    return s;
  };
  const autoBox = el('input');
  autoBox.type = 'checkbox';
  autoBox.name = 'audit.autoModel';
  autoBox.checked = globalCfg.autoModel === true;
  autoBox.addEventListener('change', () => stageGlobal('autoModel', autoBox.checked));
  // What is chosen now, staged or not: the selects are filled again each time the list is shown, and must not go back to what was saved.
  const chosen = { global: globalCfg.profile ?? 'default', project: projectState?.auditProfile ?? '' };
  const globalProfile = el('select');
  globalProfile.name = 'audit.profile';
  globalProfile.addEventListener('change', () => { chosen.global = globalProfile.value; stageGlobal('profile', globalProfile.value); });
  const projectProfile = el('select');
  projectProfile.name = 'auditProfileProject';
  projectProfile.addEventListener('change', () => { chosen.project = projectProfile.value; stageProject('auditProfile', projectProfile.value === '' ? null : projectProfile.value); });

  settings.append(
    heading(k('options.audit.heading')),
    row(k('options.audit.level'), k('options.audit.level.help'),
      levelSelect('audit.level', false, globalCfg.level ?? 'metrics', (v) => stageGlobal('level', v)),
      levelSelect('auditLevelProject', true, projectState?.auditLevel ?? '', (v) => stageProject('auditLevel', v === '' ? null : v))),
    row(k('options.audit.autoModel'), k('options.audit.autoModel.help'), autoBox, autoSelect()),
    row(k('options.audit.profile'), k('options.audit.profile.help'), globalProfile, projectProfile),
  );

  // ---- the style profiles ----
  const showList = async (): Promise<void> => {
    const res = await api<{ profiles: Row[] }>('/api/style');
    if (res.status !== 200) { error.textContent = failure(res.body); return; }
    env.editing(false);
    settings.hidden = false;
    names = res.body.profiles.map((p) => p.name);
    profileOptions(globalProfile, chosen.global, false);
    profileOptions(projectProfile, chosen.project, true);
    styles.replaceChildren();
    const top = el('div', 'options-profiles-top options-profile-bar');
    const add = button('newStyle', k('options.audit.style.new'), 'plus');
    add.addEventListener('click', () => void showForm(undefined));
    const file = el('input');
    file.type = 'file';
    file.accept = '.md,text/markdown,text/plain';
    file.hidden = true;
    file.name = 'importStyleFile';
    const imp = button('importStyle', k('options.audit.style.import'), 'upload');
    imp.addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      void f.text().then(async (text) => {
        const name = f.name.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
        if (name === '') { error.textContent = errorText({ code: 'style.badName' }); return; }
        if (names.includes(name) && !window.confirm(t('options.audit.style.confirmOverwrite', { name }))) return;
        if (await run(api(`/api/style/${name}`, { method: 'PUT', body: { scope: 'user', text } }))) void showList();
      });
    });
    const head = el('h3', 'options-heading');
    bindText(head, 'options.audit.style.heading');
    top.append(add, imp, file);
    styles.append(head, top);
    for (const p of res.body.profiles) styles.append(profileRow(p));
    styles.append(note(k('options.audit.style.appliesLater')));
  };

  const profileRow = (p: Row): HTMLElement => {
    const r = el('div', 'options-profile-row');
    const text = el('div', 'options-profile-text');
    const name = el('strong');
    name.textContent = p.name;
    const desc = el('span', 'settings-note');
    desc.textContent = p.description; // the user's own words
    text.append(name, desc);
    const origin = el('span', 'settings-note');
    bindText(origin, `options.audit.source.${p.source}`);
    const actions = el('div', 'options-profile-actions');
    const edit = button('editStyle', k('options.audit.style.edit'), 'edit');
    edit.dataset.profile = p.name;
    edit.addEventListener('click', () => void showForm(p.name));
    const dup = button('duplicateStyle', k('options.audit.style.duplicate'), 'copy');
    dup.dataset.profile = p.name;
    dup.addEventListener('click', () => {
      const to = window.prompt(t('options.audit.style.duplicateName'), `${p.name}-copy`);
      if (to === null) return;
      void run(api(`/api/style/${p.name}/duplicate`, { method: 'POST', body: { to: to.trim(), scope: 'user' } })).then((ok) => { if (ok) void showList(); });
    });
    const exp = button('exportStyle', k('options.audit.style.export'), 'download');
    exp.dataset.profile = p.name;
    exp.addEventListener('click', () => {
      void api<Detail>(`/api/style/${p.name}`).then((r2) => {
        if (r2.status !== 200) { error.textContent = failure(r2.body); return; }
        const a = el('a');
        a.href = URL.createObjectURL(new Blob([r2.body.text], { type: 'text/markdown' }));
        a.download = `${p.name}.md`;
        a.click();
        URL.revokeObjectURL(a.href);
      });
    });
    actions.append(edit, dup, exp);
    // Removing the file that is in force: a shipped profile has none to remove, and the user's copy of one brings it back.
    if (p.source !== 'shipped') {
      const drop = button('deleteStyle', k('options.audit.style.delete'), 'trash');
      drop.dataset.profile = p.name;
      drop.addEventListener('click', () => {
        if (!window.confirm(t('options.audit.style.confirmDelete', { name: p.name }))) return;
        void run(api(`/api/style/${p.name}?scope=${p.source}`, { method: 'DELETE' })).then((ok) => { if (ok) void showList(); });
      });
      actions.append(drop);
    }
    r.append(text, origin, actions);
    return r;
  };

  const showForm = async (existing: string | undefined): Promise<void> => {
    let detail: Detail | undefined;
    if (existing !== undefined) {
      const r = await api<Detail>(`/api/style/${existing}`);
      if (r.status !== 200) { error.textContent = failure(r.body); return; }
      detail = r.body;
    }
    error.textContent = '';
    env.editing(true);
    settings.hidden = true; // the form has the whole tab; what was staged above stays staged
    styles.replaceChildren();
    const field = (labelKey: string, input: HTMLElement, tip?: string): HTMLElement => {
      const label = el('label', 'options-field');
      const span = el('span');
      bindText(span, labelKey);
      const head = el('span', 'options-audit-head-inline');
      head.append(span);
      if (tip) head.append(infoIcon(tip));
      label.append(head, input);
      return label;
    };
    const text = (name: string, value: string, max: number): HTMLInputElement => {
      const i = el('input');
      i.name = name;
      i.autocomplete = 'off';
      i.maxLength = max;
      i.value = value;
      return i;
    };
    const name = text('styleName', detail?.name ?? '', 40);
    name.disabled = existing !== undefined; // the name is the file
    name.addEventListener('input', () => { name.value = name.value.toLowerCase(); });
    const description = text('styleDescription', detail?.profile.description ?? '', 200);
    const limitInputs = new Map<string, HTMLInputElement>();
    const limitFields = LIMITS.map((id) => {
      const i = el('input');
      i.name = `limit.${id}`;
      i.type = 'number';
      i.min = String(RANGES[id][0]);
      i.max = String(RANGES[id][1]);
      i.step = id === 'comment_ratio' ? '0.01' : '1';
      i.value = String(detail?.profile.limits[id] ?? (id === 'diff_lines' ? 250 : id === 'files_touched' ? 8 : id === 'file_lines' ? 600 : id === 'comment_run_lines' ? 4 : 0.15));
      limitInputs.set(id, i);
      return field(`audit.metric.${id}`, i, k('options.audit.limit.help'));
    });
    const lint = text('styleLint', detail?.profile.commands.lint ?? '', 500);
    const formatCheck = text('styleFormatCheck', detail?.profile.commands.format_check ?? '', 500);
    const conventions = el('textarea');
    conventions.name = 'styleConventions';
    conventions.rows = 10;
    conventions.value = detail?.profile.conventions ?? '';
    const scope = el('select');
    scope.name = 'styleScope';
    for (const s of ['user', 'project'] as const) { const o = el('option'); o.value = s; bindText(o, `options.audit.scope.${s}`); scope.append(o); }
    scope.value = detail?.source === 'project' ? 'project' : 'user';

    const save = button('saveStyle', k('options.audit.style.save'), 'check');
    const cancel = button('cancelStyle', k('options.audit.style.cancel'), 'x');
    cancel.addEventListener('click', () => { error.textContent = ''; void showList(); });
    save.addEventListener('click', () => {
      const limits: Record<string, number> = {};
      for (const [id, i] of limitInputs) limits[id] = Number(i.value);
      const payload = toText({ name: name.value.trim(), description: description.value, limits, lint: lint.value, formatCheck: formatCheck.value, conventions: conventions.value });
      save.disabled = true;
      void run(api(`/api/style/${encodeURIComponent(name.value.trim())}`, { method: 'PUT', body: { scope: scope.value, text: payload } })).then((ok) => {
        save.disabled = false;
        if (ok) void showList();
      });
    });
    const actions = el('div', 'options-profile-actions options-profile-bar');
    actions.append(cancel, save);
    styles.append(
      field(k('options.audit.style.name'), name, k('options.audit.style.name.help')),
      field(k('options.audit.style.description'), description),
      ...limitFields,
      field(k('audit.layer.lint'), lint, k('options.audit.command.help')),
      field(k('audit.layer.format_check'), formatCheck, k('options.audit.command.help')),
      field(k('options.audit.style.conventions'), conventions, k('options.audit.style.conventions.help')),
      field(k('options.audit.style.scope'), scope, k('options.audit.style.scope.help')),
      actions,
    );
  };

  void showList();
}
