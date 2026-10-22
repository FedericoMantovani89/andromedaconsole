import type { SessionInfo } from '../shared/protocol';
import { api } from './api';
import { STATE_KEYS } from './chips';
import { bindText, k } from './i18n-client';
import { setIconButton } from './icons';
import { errorText } from './new-agent';
import { el } from './dom';

/** The panel's counterpart of the bar's Expand: folds an agent's panel back into a bar. Never on the main. */
export function createCompactButton(slug: string, onCompact: (slug: string) => void): HTMLButtonElement {
  const b = el('button');
  b.type = 'button';
  b.className = 'panel-compact';
  setIconButton(b, 'chevronUp', k('panel.compact'));
  b.addEventListener('mousedown', (ev) => ev.preventDefault()); // a button here must not take the keyboard
  b.addEventListener('click', (ev) => { ev.stopPropagation(); onCompact(slug); });
  return b;
}

/** How many of the agent's last entries the panel prints. */
const MAX_ENTRIES = 6;

/**
 * The expanded panel of a dormant agent. It has no process, so it has no terminal: it prints what the agent last said (the entries of the
 * read panel, in full, not the cut line of the bar) so the user can read it before waking the agent, and has the Wake up button.
 */
export function createDormantPanel(info: SessionInfo, onCompact?: (slug: string) => void): HTMLElement {
  const root = el('div', 'panel panel-dormant');

  const header = el('div', 'panel-header');
  const title = el('span', 'panel-title');
  title.textContent = info.slug; // the slug is data
  const meta = el('span', 'panel-meta');
  meta.textContent = info.profile;
  const state = el('span');
  state.className = `panel-state ${info.state}`;
  bindText(state, STATE_KEYS[info.state]);
  const error = el('span', 'form-error');
  const wake = el('button');
  wake.type = 'button';
  wake.className = 'panel-wake';
  bindText(wake, 'panel.wake');
  wake.addEventListener('mousedown', (ev) => ev.preventDefault()); // a button here must not take the keyboard
  wake.addEventListener('click', () => {
    wake.disabled = true;
    error.textContent = '';
    void api<{ code?: string }>(`/api/agents/${info.slug}/wake`, { method: 'POST' }).then((r) => {
      if (r.status === 200) return; // the next state push shows it starting or queued
      wake.disabled = false;
      error.textContent = errorText({ code: r.body?.code ?? 'generic' });
    }).catch(() => { wake.disabled = false; });
  });
  const name = el('span', 'panel-name');
  name.append(title, meta);
  header.append(name, state, error, wake);
  if (onCompact) header.append(createCompactButton(info.slug, onCompact));

  const body = el('div', 'panel-dormant-body');
  const none = el('span');
  bindText(none, 'common.notAvailable'); // no data: "n/a", never an empty box
  body.append(none);
  void api<{ entries?: { text?: string }[] }>(`/api/reading/${info.slug}`).then((r) => {
    const texts = (r.status === 200 ? r.body?.entries ?? [] : []).map((e) => e.text ?? '').filter((t) => t.trim() !== '').slice(-MAX_ENTRIES);
    if (texts.length === 0) return;
    body.replaceChildren(...texts.map((text) => {
      const entry = el('div', 'panel-dormant-entry');
      entry.textContent = text; // the agent's own words: data, never markup
      return entry;
    }));
    body.scrollTop = body.scrollHeight;
  }).catch(() => undefined);

  root.append(header, body);
  return root;
}
