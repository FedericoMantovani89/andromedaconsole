import type { ApiError, StateMessage } from '../shared/protocol';
import { api } from './api';
import { bindText, k } from './i18n-client';
import { infoIcon } from './info-icon';
import { el } from './dom';

type TryCheckout = NonNullable<StateMessage['project']['tryCheckouts']>[number];

/**
 * The Git tab's "try the project branch" section (SPEC 9): one button prepares (or moves to the tip) a checkout of the project branch per
 * repository and lists the folders, each with a copy button, for the user to point a docker compose (or anything else) at; Remove takes them
 * away. The console runs nothing of the user's. Not built for a folder with no repository. `fail` shows a refused request and says whether it was one.
 */
export function renderTryCheckouts(state: StateMessage | undefined, getState: () => StateMessage | undefined, fail: (res: { status: number; body: unknown }) => boolean): HTMLElement | undefined {
  if (!state || (state.repos ?? []).length === 0) return undefined;
  const box = el('div', 'options-git-try');
  const head = el('div', 'options-field-head');
  const title = el('strong');
  bindText(title, k('options.git.try.title'));
  head.append(title, infoIcon(k('options.git.try.tip')));

  const prepare = el('button');
  prepare.type = 'button';
  prepare.name = 'tryPrepare';
  const list = el('div', 'options-git-try-list');
  const actions = el('div', 'options-select-row');
  let remove: HTMLButtonElement | undefined;

  const render = (checkouts: readonly TryCheckout[]): void => {
    bindText(prepare, checkouts.length > 0 ? k('options.git.try.refresh') : k('options.git.try.prepare'));
    list.replaceChildren(...checkouts.map((c) => {
      const row = el('div', 'options-git-try-row');
      const label = el('span', 'settings-note');
      const sha = c.sha.slice(0, 7);
      if (c.repo === '') bindText(label, k('options.git.try.rowSingle'), { sha });
      else bindText(label, k('options.git.try.row'), { repo: c.repo, sha });
      const path = el('input', 'options-command');
      path.readOnly = true;
      path.name = 'tryPath';
      path.value = c.path;
      const copy = el('button');
      copy.type = 'button';
      copy.name = 'tryCopy';
      bindText(copy, k('options.git.try.copy'));
      copy.addEventListener('click', () => {
        try { void navigator.clipboard.writeText(c.path).catch(() => path.select()); } catch { path.select(); }
      });
      const line = el('div', 'options-command-row');
      line.append(path, copy);
      row.append(label, line);
      return row;
    }));
    // Remove is there only when there is something to remove.
    if (checkouts.length > 0 && !remove) {
      remove = el('button');
      remove.type = 'button';
      remove.name = 'tryRemove';
      bindText(remove, k('options.git.try.remove'));
      remove.addEventListener('click', onRemove);
      actions.append(remove);
    } else if (checkouts.length === 0 && remove) {
      remove.remove();
      remove = undefined;
    }
  };

  const busy = (on: boolean): void => {
    prepare.disabled = on;
    if (remove) remove.disabled = on;
  };
  prepare.addEventListener('click', () => {
    busy(true);
    void api<TryCheckout[] | ApiError>('/api/project/try', { method: 'POST' }).then((res) => {
      busy(false);
      if (fail(res)) return;
      if (Array.isArray(res.body)) render(res.body);
    });
  });
  function onRemove(): void {
    busy(true);
    void api<TryCheckout[] | ApiError>('/api/project/try', { method: 'DELETE' }).then((res) => {
      busy(false);
      if (fail(res)) return;
      render([]);
    });
  }

  actions.append(prepare);
  box.append(head, list, actions);
  render(state.project.tryCheckouts ?? []);
  // A kept tab looks at the state again when it is shown: checkouts made or removed meanwhile (another window) are seen.
  box.addEventListener('optionsshow', () => { render(getState()?.project.tryCheckouts ?? []); });
  return box;
}
