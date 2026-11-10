import type { ApiError, StateMessage } from '../shared/protocol';
import { api } from './api';
import { renderGitProject } from './git-section';
import { bindText, k } from './i18n-client';
import { errorText } from './new-agent';
import { closeOverlay, createLanguageSelect, renderPrereqTable } from './settings';
import { el } from './dom';
import { setIconButton } from './icons';

type Step = 'language' | 'prerequisites' | 'git';
const STEP_TITLES: Record<Step, string> = {
  language: k('wizard.step.language'),
  prerequisites: k('wizard.step.prerequisites'),
  git: k('wizard.step.git'),
};

/**
 * First-start wizard (SPEC 29.2): the language, the prerequisites and, only when the chosen project folder is not a git repository,
 * an optional step that offers `git init`. The steps are fixed when it opens. Back, the recheck button and Next share one row; the
 * last Next ends it and saves the configuration, so the wizard never loops. Nothing here blocks the console.
 */
export function openWizard(getState: () => StateMessage | undefined): void {
  const overlay = document.getElementById('overlay')!;
  const offered = getState()?.languages ?? [];
  const saved = getState()?.language ?? 'en';
  let chosenLanguage = offered.includes(saved) ? saved : 'en'; // an older "auto" is English now
  const first = getState();
  const steps: Step[] = ['language', 'prerequisites', ...(first && !first.projectIsRepo ? ['git' as const] : [])];
  let index = 0;

  const finish = () => {
    return api('/api/config', { method: 'PUT', body: { language: chosenLanguage } }).then(closeOverlay);
  };

  const render = () => {
    const state = getState();
    const step = steps[index]!;
    const dialog = el('div', 'dialog');

    // One heading: the step is the title, "First start · step n of m" a quiet line above it.
    const head = el('header', 'wizard-head');
    const progress = el('div', 'wizard-eyebrow');
    bindText(progress, 'wizard.progress', { n: index + 1, total: steps.length });
    const title = el('h2');
    bindText(title, STEP_TITLES[step]);
    head.append(progress, title);

    const body = el('div', 'wizard-body');
    const error = el('div', 'form-error');
    const actions = el('div', 'form-actions wizard-actions');
    const left = el('div');
    const middle = el('div');
    const right = el('div');

    if (step === 'language') {
      body.append(createLanguageSelect(chosenLanguage, state?.languages ?? [], (v) => { chosenLanguage = v; }));
    } else if (step === 'prerequisites') {
      renderPrereqTable(body, state?.prereq ?? null, middle, true); // required tools only: the optional ones are in Options
    } else {
      body.append(renderGitProject(state, (res) => {
        if (res.status >= 200 && res.status < 300) return false;
        error.textContent = errorText(res.body as ApiError);
        return true;
      }));
      const later = el('p', 'settings-note');
      bindText(later, 'wizard.git.later');
      body.append(later);
    }

    const last = index === steps.length - 1;
    if (index > 0) {
      const back = el('button', 'wizard-back');
      setIconButton(back, 'chevronLeft', 'common.back');
      back.addEventListener('click', () => { index -= 1; render(); });
      left.append(back);
    }
    const next = el('button', 'wizard-next');
    setIconButton(next, last ? 'check' : 'chevronRight', last ? k('wizard.finish') : k('common.next'));
    next.addEventListener('click', () => { if (last) void finish(); else { index += 1; render(); } });
    right.append(next);
    actions.append(left, middle, right);

    dialog.append(head, body, error, actions);
    overlay.replaceChildren(dialog);
    overlay.hidden = false;
  };
  render();
}
