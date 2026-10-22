import { api } from './api';
import { el, showDialog } from './dom';
import { bindText } from './i18n-client';
import { closeOverlay } from './settings';

interface ChecklistStep { n: number; title: string; done: boolean; skipped?: boolean; note?: string; waitingOn?: { requestId: string; to: string } }

/** The progress chip ("4/11") opens the checklist the agent is keeping: done steps muted, the first open one in bold. */
export function openChecklistDialog(slug: string): void {
  const title = el('h3');
  bindText(title, 'checklist.title', { slug });
  const list = el('ol', 'checklist-steps');
  const empty = el('div');
  bindText(empty, 'common.notAvailable'); // until the answer arrives, and when it never does: "n/a", never an empty box
  const actions = el('div', 'form-actions');
  const close = el('button');
  bindText(close, 'common.close');
  close.addEventListener('click', closeOverlay);
  actions.append(close);
  showDialog([title, empty, actions], 'checklist-dialog');

  void api<{ steps?: ChecklistStep[] }>(`/api/agents/${slug}/checklist`).then((r) => {
    const steps = r.status === 200 ? r.body?.steps ?? [] : [];
    if (steps.length === 0) { bindText(empty, 'checklist.empty'); return; }
    const next = steps.find((s) => !s.done)?.n;
    list.replaceChildren(...steps.map((s) => {
      const row = el('li', `checklist-step${s.done ? ' done' : ''}${s.n === next ? ' next' : ''}`);
      const mark = el('span');
      mark.textContent = s.done ? '✓' : '○';
      const text = el('span');
      text.textContent = `${s.n}. ${s.title}`; // the agent's own words: data, never markup
      row.append(mark, text);
      const state = el('span', 'checklist-note');
      if (s.skipped) bindText(state, 'checklist.step.skipped');
      else if (s.done) bindText(state, 'checklist.step.done');
      else if (s.waitingOn) bindText(state, 'checklist.step.waiting', { who: s.waitingOn.to, id: s.waitingOn.requestId });
      else if (s.n === next) bindText(state, 'checklist.step.open');
      if (state.dataset.i18n) row.append(state);
      if (s.note) {
        const note = el('span', 'checklist-note');
        note.textContent = s.note;
        row.append(note);
      }
      return row;
    }));
    empty.replaceWith(list);
  }).catch(() => undefined);
}
