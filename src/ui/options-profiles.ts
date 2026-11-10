import type { Profile } from '../shared/profile';
import type { ApiError } from '../shared/protocol';
import { api } from './api';
import { bindText, k, t } from './i18n-client';
import { errorText } from './new-agent';
import { loadModelSelect } from './model-select';
import { createSlider, groupNumber, infoIcon } from './options';
import { el, note } from './dom';
import { setIconButton, type IconName } from './icons';

/** What `GET /api/profiles` returns for one profile (the user's layer, plus where the version in force comes from). */
interface ProfileRow extends Profile {
  shipped: boolean; userFile: boolean; projectOverrides: boolean;
}

const button = (name: string, key: string, icon: IconName): HTMLButtonElement => {
  const b = el('button');
  b.type = 'button';
  b.name = name;
  setIconButton(b, icon, key);
  return b;
};

/**
 * The Profiles tab (SPEC 11): the profiles of the user (the config folder), shipped ones edited as a copy. Unlike the other tabs these are
 * actions, like "apply template": each one is sent when its own button is pressed, not by the dialog's Save. A change applies to the
 * agents launched afterwards.
 */
export function renderProfilesTab(box: HTMLElement, folder: string, defaultBudget: number, editing: (on: boolean) => void): void {
  const error = el('div', 'form-error');
  const body = el('div', 'options-profiles');
  box.append(body, error);

  const run = async (res: Promise<{ status: number; body: unknown }>): Promise<boolean> => {
    const r = await res;
    error.textContent = r.status === 200 ? '' : errorText(r.body as ApiError);
    return r.status === 200;
  };

  const showList = async (): Promise<void> => {
    const res = await api<ProfileRow[]>('/api/profiles');
    if (res.status !== 200) { error.textContent = errorText(res.body as unknown as ApiError); return; }
    editing(false);
    body.replaceChildren();
    if (box.parentElement) box.parentElement.scrollTop = 0;
    const top = el('div', 'options-profiles-top options-profile-bar');
    const add = button('newProfile', k('options.profiles.new'), 'plus');
    add.addEventListener('click', () => showForm(undefined));
    top.append(add);
    body.append(top);
    for (const p of res.body) {
      const row = el('div', 'options-profile-row');
      const text = el('div', 'options-profile-text');
      const name = el('strong');
      name.textContent = p.name;
      const desc = el('span', 'settings-note');
      desc.textContent = p.description;
      text.append(name, desc);
      const origin = el('span', 'settings-note');
      bindText(origin, p.source === 'project' ? k('options.profiles.source.project') : p.userFile && p.shipped ? k('options.profiles.modified') : p.userFile ? k('options.profiles.source.user') : k('options.profiles.source.shipped'));
      const actions = el('div', 'options-profile-actions');
      const editable = p.source !== 'project' || p.userFile || p.shipped; // a profile only the project has is not the user's to edit
      if (editable) {
        const edit = button('editProfile', k('options.profiles.edit'), 'edit');
        edit.dataset.profile = p.name;
        edit.addEventListener('click', () => showForm(p));
        actions.append(edit);
      }
      if (p.userFile) {
        const drop = button(p.shipped ? 'restoreProfile' : 'deleteProfile', p.shipped ? k('options.profiles.restoreOne') : k('options.profiles.delete'), p.shipped ? 'undo' : 'trash');
        drop.dataset.profile = p.name;
        drop.addEventListener('click', () => {
          if (!window.confirm(t(p.shipped ? k('options.profiles.confirmRestoreOne') : k('options.profiles.confirmDelete'), { name: p.name }))) return;
          void run(api(`/api/profiles/${encodeURIComponent(p.name)}`, { method: 'DELETE' })).then((ok) => { if (ok) void showList(); });
        });
        actions.append(drop);
      }
      row.append(text, origin, actions);
      if (p.projectOverrides) row.append(note(k('options.profiles.projectOverrides')));
      body.append(row);
    }
    const restore = button('restoreAllProfiles', k('options.profiles.restoreAll'), 'refresh');
    restore.addEventListener('click', () => {
      if (!window.confirm(t(k('options.profiles.confirmRestoreAll')))) return;
      void run(api('/api/profiles/restore', { method: 'POST' })).then((ok) => { if (ok) void showList(); });
    });
    const foot = el('div', 'options-profiles-foot');
    foot.append(note(k('options.profiles.appliesLater')), note(k('options.profiles.folder'), { path: folder }));
    body.append(restore, foot);
  };

  const showForm = (existing: ProfileRow | undefined): void => {
    error.textContent = '';
    editing(true);
    body.replaceChildren();
    if (box.parentElement) box.parentElement.scrollTop = 0;
    const field = <T extends HTMLElement>(labelKey: string, input: T, helpKey?: string): HTMLElement => {
      const label = el('label', 'options-field');
      const span = el('span');
      bindText(span, labelKey);
      label.append(span, input);
      if (!helpKey) return label;
      const wrap = el('div', 'options-field-wrap');
      const help = note(helpKey);
      if (input instanceof HTMLInputElement && input.maxLength > 0) {
        // Typing and pasting stop at maxLength by themselves (a paste is cut); the counter just shows where we are.
        const counter = el('span', 'settings-note options-counter');
        const show = (): void => { counter.textContent = `${Math.min(input.value.length, input.maxLength)}/${input.maxLength}`; };
        input.addEventListener('input', show);
        show();
        const line = el('div', 'options-help-line');
        line.append(help, counter);
        wrap.append(label, line);
        return wrap;
      }
      wrap.append(label, help);
      return wrap;
    };
    const name = el('input');
    name.name = 'profileName';
    name.autocomplete = 'off';
    name.maxLength = 40;
    name.value = existing?.name ?? '';
    name.disabled = existing !== undefined; // the name is the file: a rename would be a new profile
    name.addEventListener('input', () => { // only lowercase is valid: typed or pasted capitals become lowercase, the caret stays
      const at = name.selectionStart;
      name.value = name.value.toLowerCase();
      if (at !== null) name.setSelectionRange(at, at);
    });
    const description = el('input');
    description.name = 'profileDescription';
    description.autocomplete = 'off';
    description.maxLength = 200;
    description.value = existing?.description ?? '';
    const model = el('select');
    model.name = 'profileModel';
    loadModelSelect(model, existing?.model ?? '', k('options.models.default'));
    // The budget: a slider like the one in Budget and limits, starting at the console's default. Left untouched on a profile that has no
    // budget of its own it is not saved, so the profile keeps following the default.
    let budgetTouched = false;
    const budgetSlider = createSlider({ path: 'profileBudget', label: k('options.profiles.budget'), min: 50_000, max: 2_000_000, step: 50_000, format: groupNumber },
      existing?.budgetTokens ?? defaultBudget, (n) => { budgetTouched = true; return n; });
    const budgetBox = el('div', 'options-field-wrap');
    budgetBox.append(budgetSlider.row);
    const readOnly = el('input');
    readOnly.type = 'checkbox';
    readOnly.name = 'profileReadOnly';
    readOnly.checked = existing?.readOnly === true;
    const readOnlyRow = el('label', 'settings-switch');
    const readOnlyText = el('span');
    bindText(readOnlyText, 'options.profiles.readOnly');
    readOnlyRow.append(readOnly, readOnlyText, infoIcon(k('options.profiles.readOnly.help')));
    const text = el('textarea');
    text.name = 'profileBody';
    text.rows = 12;
    text.value = existing?.body ?? '';

    const save = button('saveProfile', k('options.profiles.save'), 'check');
    const cancel = button('cancelProfile', k('options.profiles.cancel'), 'x');
    cancel.addEventListener('click', () => { error.textContent = ''; void showList(); });
    save.addEventListener('click', () => {
      const payload = {
        name: name.value.trim(), description: description.value, model: model.value,
        budgetTokens: existing?.budgetTokens === undefined && !budgetTouched ? null : budgetSlider.get(), readOnly: readOnly.checked, body: text.value,
      };
      save.disabled = true;
      void run(api(`/api/profiles/${encodeURIComponent(payload.name)}`, { method: 'PUT', body: payload })).then((ok) => {
        save.disabled = false;
        if (ok) void showList();
      });
    });
    const actions = el('div', 'options-profile-actions options-profile-bar');
    actions.append(cancel, save);
    body.append(
      field(k('options.profiles.name'), name, k('options.profiles.name.help')),
      field(k('options.profiles.description'), description),
      field(k('options.profiles.model'), model),
      budgetBox,
      readOnlyRow,
      field(k('options.profiles.body'), text, k('options.profiles.body.help')),
      actions,
    );
    if (existing?.projectOverrides) body.append(note(k('options.profiles.projectOverrides')));
  };

  void showList();
}
