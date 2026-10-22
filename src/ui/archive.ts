import type { Activity } from '../shared/activity';
import { canArchive } from '../shared/archive';
import type { SessionInfo, StateMessage } from '../shared/protocol';
import { api } from './api';
import { STATE_KEYS, TICKET_KEYS } from './chips';
import { bindText, k } from './i18n-client';
import { closeOverlay } from './settings';
import { el } from './dom';

/** The agents the column shows: the archived ones are in the state in full, but only the archive list draws them. */
export const visibleAgents = (agents: SessionInfo[]): SessionInfo[] => agents.filter((a) => !a.archived);
export const archivedAgents = (agents: SessionInfo[]): SessionInfo[] => agents.filter((a) => a.archived);
/** The agents "Archive all finished" would archive now: the same rule the server applies. */
export const archivableAgents = (agents: SessionInfo[]): SessionInfo[] => agents.filter((a) => !a.archived && canArchive(a.state, a.ticket?.status));

/** The small button of a panel or bar header: shown only while the agent is finished-like (the server checks again). */
export function createArchiveButton(slug: string): HTMLButtonElement {
  const b = el('button');
  b.type = 'button';
  b.className = 'panel-archive';
  b.hidden = true;
  bindText(b, k('panel.archive'));
  b.addEventListener('mousedown', (ev) => ev.preventDefault()); // a button here must not take the keyboard
  b.addEventListener('click', (ev) => { ev.stopPropagation(); void api(`/api/agents/${slug}/archive`, { method: 'POST' }).catch(() => undefined); });
  return b;
}

export function syncArchiveButton(root: HTMLElement, state: Activity, ticket: SessionInfo['ticket']): void {
  const b = root.querySelector<HTMLElement>('.panel-archive');
  if (b) b.hidden = !canArchive(state, ticket?.status);
}

/** The open dialog's list and button, kept so a state push can refresh them without rebuilding the dialog. */
let open: { list: HTMLElement; all: HTMLButtonElement; deleteAll: HTMLButtonElement; finished: HTMLButtonElement; dialog: HTMLElement } | undefined;

const unarchive = (slug: string): Promise<unknown> => api(`/api/agents/${slug}/unarchive`, { method: 'POST' }).catch(() => undefined);

function paintRows(list: HTMLElement, archived: SessionInfo[]): void {
  if (archived.length === 0) {
    const empty = el('div', 'archive-empty');
    bindText(empty, k('archive.empty'));
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...archived.map((a) => {
    const row = el('div', 'archive-row');
    const name = el('span', 'archive-name');
    name.textContent = a.slug;
    const profile = el('span', 'archive-profile');
    profile.textContent = a.profile;
    const ticket = el('span', 'archive-ticket');
    const ticketKey = a.ticket ? TICKET_KEYS[a.ticket.status] : undefined;
    bindText(ticket, ticketKey ?? STATE_KEYS[a.state]);
    const when = el('span', 'archive-when');
    const at = a.archivedAt === undefined ? Number.NaN : Date.parse(a.archivedAt);
    if (Number.isFinite(at)) when.textContent = new Date(at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    else bindText(when, 'common.notAvailable');
    const restore = el('button');
    restore.type = 'button';
    bindText(restore, k('archive.unarchive'));
    restore.addEventListener('click', () => { void unarchive(a.slug); });
    const remove = el('button');
    remove.type = 'button';
    remove.className = 'archive-delete';
    bindText(remove, k('archive.delete'));
    remove.addEventListener('click', () => { void api(`/api/agents/${a.slug}`, { method: 'DELETE' }).catch(() => undefined); });
    row.append(name, profile, ticket, when, restore, remove);
    return row;
  }));
}

/** Follows the state while the dialog is open: a restored agent leaves the list at once. */
export function refreshArchiveDialog(state: StateMessage): void {
  if (!open || !open.dialog.isConnected) { open = undefined; return; }
  const archived = archivedAgents(state.agents);
  paintRows(open.list, archived);
  open.all.disabled = archived.length === 0;
  open.deleteAll.disabled = archived.length === 0;
  const popup = (kind: string): Element | null | undefined => open?.dialog.parentElement?.querySelector(`.archive-confirm.${kind}`)?.parentElement;
  if (archived.length === 0) popup('delete')?.remove();
  const n = archivableAgents(state.agents).length;
  open.finished.disabled = n === 0;
  if (n === 0) popup('archive')?.remove();
}

/** The archive list (a dialog like the other ones): who is archived, and a button to bring each one, or all, back. */
export function openArchiveDialog(getState: () => StateMessage | undefined): void {
  const overlay = document.getElementById('overlay')!;
  const dialog = el('div', 'dialog archive-dialog');
  dialog.dataset.escape = '';
  const title = el('h3');
  bindText(title, k('archive.title'));
  const list = el('div', 'archive-list');
  const actions = el('div', 'form-actions');
  const all = el('button');
  all.type = 'button';
  all.className = 'archive-all';
  bindText(all, k('archive.unarchiveAll'));
  all.addEventListener('click', () => {
    const slugs = archivedAgents(getState()?.agents ?? []).map((a) => a.slug);
    void Promise.all(slugs.map(unarchive));
  });
  const close = el('button');
  close.type = 'button';
  bindText(close, 'common.close');
  close.addEventListener('click', closeOverlay);
  const finished = el('button');
  finished.type = 'button';
  finished.className = 'archive-finished';
  bindText(finished, k('archive.archiveFinished'));
  /** A confirmation popup over the dialog (a long list would push an inline question out of sight): the one that was open goes, Cancel closes this one, Yes runs `onYes`. */
  const ask = (kind: 'archive' | 'delete', count: number, textKey: string, yesKey: string, onYes: () => void): void => {
    overlay.querySelectorAll('.archive-confirm-backdrop').forEach((n) => n.remove());
    if (count === 0) return;
    const backdrop = el('div', 'archive-confirm-backdrop');
    const line = el('div', `dialog archive-confirm ${kind}`);
    const text = el('p');
    bindText(text, textKey, { count });
    const buttons = el('div', 'form-actions');
    const yes = el('button');
    yes.type = 'button';
    yes.className = 'archive-confirm-yes';
    bindText(yes, yesKey);
    yes.addEventListener('click', () => { backdrop.remove(); onYes(); });
    const no = el('button');
    no.type = 'button';
    no.className = 'archive-confirm-no';
    bindText(no, 'common.cancel');
    no.addEventListener('click', () => backdrop.remove());
    buttons.append(yes, no);
    line.append(text, buttons);
    backdrop.append(line);
    overlay.append(backdrop);
  };
  finished.addEventListener('click', () => {
    ask('archive', archivableAgents(getState()?.agents ?? []).length, k('archive.confirmFinished'), k('archive.confirmYes'),
      () => { void api('/api/agents/archive-finished', { method: 'POST' }).catch(() => undefined); });
  });
  // Deleting is not undone: the list is cleaned in one go only after a question.
  const deleteAll = el('button');
  deleteAll.type = 'button';
  deleteAll.className = 'archive-delete-all';
  bindText(deleteAll, k('archive.deleteAll'));
  deleteAll.addEventListener('click', () => {
    ask('delete', archivedAgents(getState()?.agents ?? []).length, k('archive.confirmDeleteAll'), k('archive.confirmDeleteYes'),
      () => { void api('/api/agents/delete-archived', { method: 'POST' }).catch(() => undefined); });
  });
  actions.append(finished, all, deleteAll, close);
  dialog.append(title, list, actions);
  overlay.replaceChildren(dialog);
  overlay.hidden = false;
  open = { list, all, deleteAll, finished, dialog };
  const s = getState();
  if (s) refreshArchiveDialog(s);
}
