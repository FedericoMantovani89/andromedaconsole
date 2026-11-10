import type { PrereqResult, StateMessage } from '../shared/protocol';

/** How often the shell commands of the agents used each optional helper (from the state), shown next to the helper. */
export type HelperUse = NonNullable<StateMessage['helperUse']>;
import { api } from './api';
import { openInstallDialog } from './install-dialog';
import { bindText, k, language, languageName, resolveLanguage, setLanguage } from './i18n-client';
import { el } from './dom';
import { setIconButton } from './icons';

/** The helpers the console counts (the ids of the optional tools whose use is measured). */
const HELPER_COUNT_IDS: Record<string, true> = { python: true, rg: true, ctags: true, jq: true, fd: true, shellcheck: true, uv: true };

/**
 * Language selector: every language the server has a bundle for (a new messages_xx file is enough). There is no "browser language"
 * entry: a browser in a language with no bundle would get English anyway, and the user's choice must be one that exists.
 * Applies at runtime without a reload and saves the choice (SPEC 5.9, 22.2).
 */
export function createLanguageSelect(current: string, languages: readonly string[], onChange?: (value: string) => void): HTMLSelectElement {
  const select = el('select');
  for (const code of languages) {
    const o = el('option');
    o.value = code;
    o.textContent = languageName(code); // language names are shown in their own language
    select.append(o);
  }
  // A saved "auto" (an older configuration) or a language whose bundle is gone shows English.
  select.value = languages.includes(current) ? current : languages.includes('en') ? 'en' : (languages[0] ?? '');
  select.addEventListener('change', () => {
    void setLanguage(resolveLanguage(select.value, languages)).then(() => onChange?.(select.value));
  });
  return select;
}

/**
 * Table of required tools with their status and a "check again" button (SPEC 29.3). The button goes under the table, centred, or into
 * `recheckHost` when the caller has a place for it (the wizard puts it between Back and Next).
 */
export function renderPrereqTable(container: HTMLElement, results: PrereqResult[] | null, recheckHost?: HTMLElement, requiredOnly = false, usage?: HelperUse): void {
  container.replaceChildren();
  // Two sections, required then optional (a heading each); the first-start wizard lists only the required ones, under no heading.
  const sections: { key?: string; rows: PrereqResult[] }[] = requiredOnly
    ? [{ rows: (results ?? []).filter((x) => x.required) }]
    : [{ key: k('prereq.section.required'), rows: (results ?? []).filter((x) => x.required) }, { key: k('prereq.section.optional'), rows: (results ?? []).filter((x) => !x.required) }];
  for (const section of sections.filter((s) => s.rows.length > 0)) {
    if (section.key) {
      const h = el('h3', 'options-heading prereq-heading');
      bindText(h, section.key);
      container.append(h);
      if (usage && section.key === k('prereq.section.optional')) {
        const help = el('p', 'settings-note');
        bindText(help, 'prereq.uses.help', { since: new Date(usage.since).toLocaleDateString(language()) });
        container.append(help);
      }
    }
    for (const r of section.rows) appendPrereqRow(container, r, recheckHost, requiredOnly, usage, !requiredOnly);
  }
  appendRecheck(container, recheckHost, requiredOnly, usage);
}

function appendPrereqRow(container: HTMLElement, r: PrereqResult, recheckHost: HTMLElement | undefined, requiredOnly: boolean, usage: HelperUse | undefined, withUses: boolean): void {
  const row = el('div', 'prereq-row');
  const name = el('span');
  bindText(name, `prereq.${r.id}`);
  const status = el('span');
  status.className = `prereq-${r.status}`;
  bindText(status, `prereq.status.${r.status}`);
  const detail = el('span');
  detail.textContent = r.version ?? '';
  row.append(name, status, detail);
  if (withUses) {
    // Only a helper that is installed has a count; a tool nobody measures (Node, Git, the GitHub CLI...) leaves the cell empty, never a 0.
    const uses = el('span', 'prereq-uses');
    const n = r.status === 'ok' ? (usage?.counts as Record<string, number | undefined> | undefined)?.[r.id] : undefined;
    const measured = r.status === 'ok' && usage !== undefined && r.id in HELPER_COUNT_IDS;
    if (measured) bindText(uses, 'prereq.uses', { count: n ?? 0 });
    row.append(uses);
  }
  // A missing, outdated or unreadable tool can be installed from here, after the user has seen and approved the command (Phase 6F).
  const fixable = r.status === 'missing' || r.status === 'outdated' || r.status === 'error';
  const action = el(fixable ? 'button' : 'span');
  if (fixable) {
    bindText(action, r.status === 'missing' ? k('prereq.install') : k('prereq.update'));
    action.addEventListener('click', () => { openInstallDialog(r.id, () => recheck(container, recheckHost, requiredOnly, usage)); });
  }
  row.append(action);
  container.append(row);
}

/** Asks the server to check the tools again and draws the table anew. */
function recheck(container: HTMLElement, recheckHost: HTMLElement | undefined, requiredOnly: boolean, usage?: HelperUse): void {
  void api<PrereqResult[]>('/api/prereq/recheck', { method: 'POST' }).then((res) => {
    if (res.status === 200) renderPrereqTable(container, res.body, recheckHost, requiredOnly, usage);
  });
}

function appendRecheck(container: HTMLElement, recheckHost: HTMLElement | undefined, requiredOnly: boolean, usage?: HelperUse): void {
  const again = el('button');
  if (requiredOnly) {
    // The first-start wizard: check again, so the user can go on once a required tool is there.
    setIconButton(again, 'refresh', 'prereq.recheck');
    again.addEventListener('click', () => recheck(container, recheckHost, requiredOnly, usage));
  } else {
    // Options: a program installed after the console started is not on the PATH this process was given, and the console never reads the
    // PATH from the system. Checking again or restarting the sessions would show nothing new: the console has to be started again from
    // a new terminal. The line below the table says so (the button is not offered: it could not do anything).
    const hint = el('p', 'settings-note prereq-hint');
    bindText(hint, 'prereq.afterInstall');
    container.append(hint);
    return;
  }
  if (recheckHost) { recheckHost.replaceChildren(again); return; }
  const centre = el('div', 'prereq-recheck');
  centre.append(again);
  container.append(centre);
}

export function closeOverlay(): void {
  const overlay = document.getElementById('overlay')!;
  overlay.hidden = true;
  overlay.replaceChildren();
  // The user just closed a dialog (a click): the shell hands the keyboard back to the active terminal.
  window.dispatchEvent(new CustomEvent('overlayclosed'));
}

/** Opens the Options dialog (tabs: models, budget, git, guard, projects, language, prerequisites, plugins...; see options.ts). */
export function openSettings(getState: () => StateMessage | undefined): void {
  // The dialog's code (about 50 KB) loads when it is first opened (SPEC 33.2).
  void import('./options').then((m) => m.openOptions(getState)).catch(showLoadFailed);
}

/** A part of the page could not be loaded (the console stopped?): one line at the bottom, gone after a few seconds. */
export function showLoadFailed(): void {
  const note = el('div', 'load-failed');
  bindText(note, k('common.loadFailed'));
  document.body.append(note);
  setTimeout(() => note.remove(), 4000);
}
