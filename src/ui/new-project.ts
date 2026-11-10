import type { ApiError, StateMessage } from '../shared/protocol';
import { api } from './api';
import { el, checkbox, showDialog } from './dom';
import { focusElementFromUser } from './focus';
import { bindText, k } from './i18n-client';
import { errorText } from './new-agent';
import { closeOverlay } from './settings';
import { setIconButton } from './icons';

/** Label of the button that opens the save-as-template dialog (the Options dialog of 6E binds it). */
export const SAVE_TEMPLATE_LABEL = k('templates.save.open');

/** A project name proposed from the folder: its last segment as lowercase words joined by dashes. */
function nameFromFolder(folder: string): string {
  const last = folder.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  return last.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function field(labelKey: string, input: HTMLElement): HTMLLabelElement {
  const label = el('label');
  const text = el('span');
  bindText(text, labelKey);
  label.append(text, input);
  return label;
}

function textInput(name: string): HTMLInputElement {
  const input = el('input');
  input.name = name;
  input.autocomplete = 'off';
  return input;
}

function actions(submitKey: string, onCancel: () => void): { box: HTMLElement; submit: HTMLButtonElement } {
  const box = el('div', 'form-actions');
  const submit = el('button');
  submit.type = 'submit';
  setIconButton(submit, 'check', submitKey);
  const cancel = el('button');
  cancel.type = 'button';
  setIconButton(cancel, 'x', 'common.cancel');
  cancel.addEventListener('click', onCancel);
  box.append(submit, cancel);
  return { box, submit };
}

/**
 * The new-project dialog (SPEC 21, 29.2): only the folder. The console reads what the folder holds to pick the template and the
 * commands (changed later in Options); a folder that does not exist yet is created (git is a choice made later, in Options). The name is
 * proposed from the folder when it is chosen or typed, and can be changed. Create makes the project through `POST /api/projects`.
 */
export function openNewProjectDialog(getState: () => StateMessage | undefined, onCreated?: (name: string) => void): void {
  const form = el('form', 'new-project-form');
  const title = el('h2');
  bindText(title, 'projects.new.title');

  const folder = textInput('folder');
  const name = textInput('name');
  let nameEdited = false; // a name the user typed is never replaced by the one proposed from the folder
  name.addEventListener('input', () => { nameEdited = true; });
  const nameRow = field(k('projects.new.name'), name);
  const note = el('p', 'settings-note create-note');
  const error = el('div', 'form-error');

  /** Whether the folder is a full path that is not there yet (it will be created); anything else is the server's to judge. */
  const missing = async (): Promise<boolean> => {
    const root = folder.value.trim();
    if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(root)) return false;
    return (await api<unknown>(`/api/projects/detect?root=${encodeURIComponent(root)}`)).status === 422;
  };
  const check = async (): Promise<void> => {
    if (!nameEdited) name.value = nameFromFolder(folder.value);
    note.replaceChildren();
    if (folder.value.trim() !== '' && await missing()) bindText(note, 'projects.new.willCreate');
  };
  folder.addEventListener('blur', () => { void check(); });
  // The native folder window (the console runs on the user's own machine, so it can open one: a page cannot learn a full path).
  const browse = el('button');
  browse.type = 'button';
  browse.className = 'browse-folder';
  setIconButton(browse, 'folder', 'projects.new.browse');
  const browseNote = el('p', 'settings-note browse-note');
  browse.addEventListener('click', () => {
    browseNote.textContent = '';
    error.textContent = '';
    browse.disabled = true;
    void api<{ status: string; path?: string } | ApiError>('/api/pick-folder', { method: 'POST', body: {} }).then(async (res) => {
      if (res.status !== 200) { error.textContent = errorText(res.body as ApiError); return; }
      const out = res.body as { status: string; path?: string };
      if (out.status === 'picked' && out.path) { folder.value = out.path; await check(); focusElementFromUser(name, 'user'); }
      else if (out.status === 'unavailable') bindText(browseNote, 'folder.unavailable');
    }).finally(() => { browse.disabled = false; });
  });

  // Start from the settings of a project that is open now (profiles, rules, commands, limits), instead of what the folder suggests.
  // The menu exists only when there is a project to copy from: with none, the dialog is the folder and the name, as before.
  const others = getState()?.projects ?? [];
  let copy: HTMLSelectElement | undefined;
  let copyRow: HTMLLabelElement | undefined;
  if (others.length > 0) {
    copy = el('select');
    copy.name = 'copyFrom';
    const none = el('option');
    none.value = '';
    bindText(none, 'projects.new.copyFrom.none');
    copy.append(none);
    for (const p of others) {
      const o = el('option');
      o.value = p.name;
      o.textContent = p.name;
      copy.append(o);
    }
    copyRow = field(k('projects.new.copyFrom'), copy);
  }

  const { box, submit } = actions(k('common.create'), closeOverlay);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    void missing().then((create) => api<ApiError>('/api/projects', {
      method: 'POST',
      body: { root: folder.value.trim(), auto: true, create, ...(name.value.trim() ? { name: name.value.trim() } : {}), ...(copy?.value ? { copyFrom: copy.value } : {}) },
    })).then((res) => {
      if (res.status >= 200 && res.status < 300) { closeOverlay(); onCreated?.(String((res.body as { name?: unknown }).name ?? '')); return; }
      const code = (res.body as ApiError).code;
      error.textContent = errorText(res.body as ApiError);
      if (code === 'project.duplicate' || code === 'project.badName') {
        // The name of the folder is taken or not usable: ask for another one.
        if (name.value.trim() === '') name.value = nameFromFolder(folder.value);
        focusElementFromUser(name, 'user');
      }
    }).finally(() => { submit.disabled = false; });
  });

  const folderRow = el('div', 'folder-row');
  folderRow.append(field(k('projects.new.folder'), folder), browse);
  form.append(title, folderRow, browseNote, nameRow, ...(copyRow ? [copyRow] : []), note, error, box);
  showDialog([form]);
  focusElementFromUser(folder, 'user'); // the user just clicked "new project": the cursor may go into the first field
}

/** "Save project as template": a copy of the current project's profiles, rules and settings, kept in the user's templates (SPEC 21). */
export function openSaveTemplateDialog(_getState: () => StateMessage | undefined): void {
  const form = el('form');
  const title = el('h2');
  bindText(title, 'templates.save.title');
  const id = textInput('id');
  const name = textInput('name');
  const overwrite = checkbox('overwrite', k('templates.save.overwrite'));
  const error = el('div', 'form-error');
  const done = el('p', 'settings-note');
  const { box, submit } = actions(k('common.save'), closeOverlay);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    error.textContent = '';
    done.textContent = '';
    submit.disabled = true;
    void api<ApiError>('/api/projects/save-template', {
      method: 'POST',
      body: { id: id.value.trim(), ...(name.value.trim() ? { name: name.value.trim() } : {}), overwrite: overwrite.input.checked },
    }).then((res) => {
      if (res.status >= 200 && res.status < 300) bindText(done, 'templates.save.done', { id: id.value.trim() });
      else error.textContent = errorText(res.body as ApiError);
    }).finally(() => { submit.disabled = false; });
  });
  form.append(title, field(k('templates.save.id'), id), field(k('templates.save.name'), name), overwrite.row, done, error, box);
  showDialog([form]);
  focusElementFromUser(id, 'user');
}
