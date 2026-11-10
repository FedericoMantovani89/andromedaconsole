import type { ApiError, StateMessage } from '../shared/protocol';
import { api } from './api';
import { bindText, k, setPlaceholder } from './i18n-client';
import { infoIcon } from './info-icon';
import { el } from './dom';
import { setIconButton } from './icons';


/** A bold title with its (i): what the thing does and why is in the tooltip, not in lines under it. */
function titled(titleKey: string, tipKey: string): HTMLElement {
  const head = el('div', 'options-field-head');
  const strong = el('strong');
  bindText(strong, titleKey);
  head.append(strong, infoIcon(tipKey));
  return head;
}

/**
 * What the project folder is for git, and what to do when it is not a repository (nothing starts git on its own): initialise one here, or
 * clone an existing one. Used by the Options, Git tab and by the optional Git step of the first-start wizard. `fail` shows a refused
 * request and says whether it was one; `heading` is added above the text when given. A folder that is a repository has one line; one that
 * is not shows two bold titles, each with its explanation in a tooltip.
 */
export function renderGitProject(state: StateMessage | undefined, fail: (res: { status: number; body: unknown }) => boolean, heading?: HTMLElement): HTMLElement {
  const box = el('div', 'options-git-project');
  if (heading) box.append(heading);
  const message = el('p', 'settings-note');
  box.append(message);
  if (!state) { bindText(message, 'common.notAvailable'); return box; }
  // The folder itself is what counts: one that only holds repositories (even 35 of them, none listed here) is not a repository, and the
  // user may make it one. The sub-repositories are then theirs to put in the .gitignore.
  const repos = state.repos ?? [];
  if (repos.includes('')) {
    bindText(message, 'options.git.isRepo');
    return box;
  }
  message.hidden = true; // used only for what happened ("done"); everything else is in the tooltips

  const initBlock = el('div', 'options-git-init');
  const init = el('button');
  init.type = 'button';
  init.name = 'gitInit';
  setIconButton(init, 'plus', 'options.git.init.apply');
  initBlock.append(titled(k('options.git.init.title'), repos.length > 0 ? k('options.git.init.tip.holds') : k('options.git.init.tip')), init);

  // Or start from a repository that already exists: its address, then a clone into this (empty) folder. No password goes through here.
  const cloneBlock = el('div', 'options-git-clone');
  const url = el('input');
  url.name = 'cloneUrl';
  url.autocomplete = 'off';
  url.spellcheck = false;
  setPlaceholder(url, 'options.git.clone.example');
  const clone = el('button');
  clone.type = 'button';
  clone.name = 'gitClone';
  setIconButton(clone, 'download', 'options.git.clone.apply');
  const cloneRow = el('div', 'options-select-row');
  cloneRow.append(url, clone);
  cloneBlock.append(titled(k('options.git.clone'), k('options.git.clone.help')), cloneRow);

  const finished = (doneKey: string): void => {
    bindText(message, doneKey);
    message.hidden = false;
    initBlock.hidden = true;
    cloneBlock.hidden = true; // it is a repository now
  };
  init.addEventListener('click', () => {
    init.disabled = true;
    void api<ApiError>('/api/projects/git-init', { method: 'POST' }).then((res) => {
      if (fail(res)) { init.disabled = false; return; }
      finished(k('options.git.init.done'));
    });
  });
  clone.addEventListener('click', () => {
    if (url.value.trim() === '') return;
    clone.disabled = true;
    url.disabled = true;
    bindText(clone, 'options.git.clone.working'); // a big repository takes a while
    void api<ApiError>('/api/projects/git-clone', { method: 'POST', body: { url: url.value.trim() } }).then((res) => {
      if (fail(res)) {
        clone.disabled = false;
        url.disabled = false;
        bindText(clone, 'options.git.clone.apply');
        return;
      }
      finished(k('options.git.clone.done'));
    });
  });
  box.append(initBlock, cloneBlock);
  return box;
}
