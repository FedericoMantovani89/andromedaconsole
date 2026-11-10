import type { ApiError } from '../shared/protocol';
import { api } from './api';
import { el, showDialog } from './dom';
import { bindText, k } from './i18n-client';
import { errorText } from './new-agent';
import { closeOverlay } from './settings';
import { setIconButton } from './icons';

/**
 * The question after Save when a setting the sessions read only when they start has changed (bypass, guard mode, agent model). Yes asks
 * the server to restart them (the main resumes its conversation, the agents that were running are started again) and then loads the page
 * again, which starts from the splash; No just closes. It cannot make a newly installed program visible: the console never reads the PATH
 * from the system, so that needs the console itself started again from a new terminal.
 */
export function openRestartDialog(): void {
  const title = el('h2');
  bindText(title, 'options.restart.title');
  const note = el('p', 'settings-note');
  bindText(note, k('options.restart.settings'));
  const question = el('p');
  bindText(question, 'options.restart.question');
  const error = el('div', 'form-error');
  const actions = el('div', 'form-actions');
  const no = el('button');
  no.type = 'button';
  no.name = 'restartNo';
  setIconButton(no, 'x', 'common.no');
  no.addEventListener('click', closeOverlay);
  const yes = el('button');
  yes.type = 'button';
  yes.name = 'restartYes';
  setIconButton(yes, 'check', 'common.yes');
  yes.addEventListener('click', () => {
    yes.disabled = true;
    no.disabled = true;
    bindText(question, 'options.restart.working');
    void api<ApiError>('/api/restart', { method: 'POST' }).then((res) => {
      if (res.status === 200) { location.reload(); return; }
      error.textContent = errorText(res.body);
      bindText(question, 'options.restart.question');
      yes.disabled = false;
      no.disabled = false;
    }, () => { location.reload(); }); // the connection dropped while the sessions were restarting: the page loads again
  });
  actions.append(no, yes);
  showDialog([title, note, question, error, actions], 'restart-dialog');
}
