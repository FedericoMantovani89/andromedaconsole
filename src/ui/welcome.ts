import { bindText } from './i18n-client';
import { openNewProjectDialog } from './new-project';
import { setIconButton } from './icons';

/**
 * The screen of a console with no project open (SPEC 5.1, 29.2): the project chrome is hidden and the new-project dialog asks for a project
 * at once; a button asks again after the dialog was closed. Once a project exists the page reloads and starts as usual.
 */
export function showWelcome(o: { reload?: () => void } = {}): void {
  const reload = o.reload ?? ((): void => location.reload());
  for (const id of ['topbar', 'workspace', 'statusbar']) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  let welcome = document.getElementById('welcome');
  if (!welcome) {
    welcome = document.createElement('section');
    welcome.id = 'welcome';
    document.body.append(welcome);
  }
  const title = document.createElement('h1');
  bindText(title, 'welcome.title');
  const text = document.createElement('p');
  bindText(text, 'welcome.text');
  const choose = document.createElement('button');
  choose.type = 'button';
  choose.className = 'welcome-choose';
  setIconButton(choose, 'folder', 'welcome.choose');
  const ask = (): void => openNewProjectDialog(() => undefined, () => reload());
  choose.addEventListener('click', ask);
  welcome.replaceChildren(title, text, choose);
  ask(); // the user just opened the console: the question is the first thing they see
}
