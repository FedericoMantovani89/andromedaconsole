import type { ApiError } from '../shared/protocol';
import { api } from './api';
import { el } from './dom';
import { infoIcon } from './info-icon';
import { bindText, k } from './i18n-client';
import { setIconButton } from './icons';

type Stage = (key: string, run: (dry: boolean) => Promise<{ status: number; body: unknown }>) => void;

/**
 * The Secrets tab: console-wide keys. Today only the Groq key of the voice dictation. The page never receives the key: it learns only
 * whether one is saved, and a typed key (or a removal) is staged for the dialog's single Save (PUT /api/secrets, checked first with ?dryRun=1).
 */
export function renderSecretsTab(container: HTMLElement, stage: Stage): void {
  const box = el('div', 'settings-agents');
  const warning = el('p', 'settings-note');
  bindText(warning, 'options.secrets.groqWarning'); // said before the key is typed, not after
  box.append(warning);

  const field = el('label', 'options-field');
  const label = el('span');
  bindText(label, 'options.secrets.groqLabel');
  const input = el('input');
  input.type = 'password';
  input.name = 'secrets.groqKey';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const head = el('span', 'options-field-head');
  head.append(label, infoIcon(k('options.secrets.groqTip')));
  // The eye shows or hides what is being typed, like a password field. It never reveals the saved key: the page does not have it.
  const eye = el('button', 'icon-btn secret-eye');
  eye.type = 'button';
  eye.name = 'toggleGroqKey';
  const paintEye = (): void => setIconButton(eye, input.type === 'password' ? 'eye' : 'eyeOff', input.type === 'password' ? k('options.secrets.show') : k('options.secrets.hide'));
  eye.addEventListener('mousedown', (ev) => ev.preventDefault()); // the keyboard stays in the field
  eye.addEventListener('click', () => { input.type = input.type === 'password' ? 'text' : 'password'; paintEye(); });
  paintEye();
  const entry = el('div', 'options-secret-entry');
  entry.append(input, eye);
  field.append(head, entry);
  box.append(field);

  // One key, so its start (five characters and stars, as the console sends it) is the grey text of the field itself; below the field there is
  // only the way to remove it. A typed key replaces it; the page never has the saved key, so the eye shows only what is typed.
  const row = el('div', 'options-secret-status');
  row.hidden = true;
  const state = el('span', 'secret-state');
  state.dataset.secretStatus = 'groq';
  row.append(state);
  box.append(row);

  let saved: boolean | undefined; // unknown until the console answers
  let preview: string | undefined; // the first five characters and stars
  let clearing = false;
  let clearBtn: HTMLButtonElement | undefined;
  const paint = (): void => {
    input.placeholder = !clearing && saved ? (preview ?? '*****') : ''; // data, not interface text
    row.hidden = saved !== true;
    state.hidden = !clearing;
    state.classList.toggle('willclear', clearing);
    if (clearing) bindText(state, k('options.secrets.willClear'));
    else { delete state.dataset.i18n; delete state.dataset.i18nParams; state.textContent = ''; }
    if (saved && !clearBtn) {
      clearBtn = el('button');
      clearBtn.type = 'button';
      clearBtn.name = 'clearGroqKey';
      clearBtn.addEventListener('click', () => { clearing = !clearing; if (clearing) input.value = ''; paint(); });
      row.append(clearBtn);
    }
    if (clearBtn) setIconButton(clearBtn, clearing ? 'undo' : 'trash', clearing ? k('options.secrets.undoClear') : k('options.secrets.clear'));
  };
  input.addEventListener('input', () => { if (input.value !== '') clearing = false; paint(); });
  paint();

  // One staged entry; what it sends is decided at Save time. Nothing typed and nothing to remove: nothing is sent.
  stage('secrets:groq', async (dry) => {
    const typed = input.value.trim();
    if (typed === '' && !clearing) return { status: 200, body: {} };
    return api<ApiError>(dry ? '/api/secrets?dryRun=1' : '/api/secrets', { method: 'PUT', body: { groqKey: clearing ? null : typed } });
  });

  void api<{ groq?: { set?: boolean; preview?: string } }>('/api/secrets').then((res) => {
    saved = res.status === 200 && res.body?.groq?.set === true;
    preview = saved && typeof res.body?.groq?.preview === 'string' ? res.body.groq.preview : undefined;
    paint();
  }, () => undefined);

  container.replaceChildren(box);
}
