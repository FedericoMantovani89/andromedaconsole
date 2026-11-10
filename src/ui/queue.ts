import type { QueueItem } from '../shared/protocol';
import { api } from './api';
import { keepFocus, reconcile } from './dom';
import { createDrawerShell } from './drawer';
import { bindText, k, setPlaceholder } from './i18n-client';
import { infoIcon } from './info-icon';
import { answerButton, createBudgetEntry, createConfirmEntry, createDecisionEntry, createWeeklyEntry, type Entry } from './console-items';
import { setIconButton } from './icons';

/** The console's own decision kinds that have an entry of their own (`payload.kind`). */
function payloadKind(item: QueueItem): unknown {
  const p = item.payload;
  return typeof p === 'object' && p !== null ? (p as Record<string, unknown>).kind : undefined;
}

/** The item a notification click points at: `#queue=<id>` in the address. */
export function queueIdFromHash(hash: string): string | undefined {
  const m = /^#queue=([\w-]{1,100})$/.exec(hash);
  return m ? m[1] : undefined;
}

function createEntry(item: QueueItem, send: (answer: string) => void): Entry {
  if (item.kind === 'confirm') return createConfirmEntry(item, send);
  if (item.kind === 'decision' && payloadKind(item) === 'budget_stop') return createBudgetEntry(item, send);
  if (item.kind === 'decision' && payloadKind(item) === 'weekly_limit') return createWeeklyEntry(item, send);
  if (item.kind === 'decision') return createDecisionEntry(item, send);
  const el = document.createElement('div');
  el.className = 'queue-item';
  el.dataset.id = item.id;

  const from = document.createElement('div');
  from.className = 'queue-from';
  bindText(from, 'queue.from', { slug: item.from });
  const text = document.createElement('div');
  text.className = 'queue-text';
  text.textContent = item.text; // the question is data
  el.append(from, text);

  if (item.kind === 'permission') {
    // An agent's tool wants approval: show what it would do, offer Allow, Deny and their "always" forms (answers "allow" / "deny" / "allow_always" / "deny_always").
    const what = document.createElement('div');
    what.className = 'queue-permission';
    bindText(what, 'queue.permission', { tool: item.tool ?? '' });
    const detail = document.createElement('pre');
    detail.className = 'queue-detail';
    detail.textContent = item.detail ?? ''; // data: shown as plain text, never as HTML
    const row = document.createElement('div');
    row.className = 'queue-options';
    // The buttons are the answers the console offers: the "always" ones only for a call it can remember.
    const labels: Record<string, string> = { allow: k('queue.allow'), deny: k('queue.deny'), allow_always: k('queue.allowAlways'), deny_always: k('queue.denyAlways') };
    const offered = item.options ?? ['allow', 'deny'];
    for (const value of offered) {
      const key = labels[value];
      if (!key) continue;
      row.append(answerButton(key, value, send));
    }
    if (offered.includes('allow_always')) row.append(infoIcon(k('queue.alwaysInfo')));
    el.append(what, detail, row);
    return { el };
  }

  const free = document.createElement('input');
  free.className = 'queue-free';
  free.autocomplete = 'off';
  setPlaceholder(free, 'queue.otherAnswer');

  const checks: HTMLInputElement[] = [];
  if (item.options && item.options.length > 0) {
    const row = document.createElement('div');
    row.className = 'queue-options';
    for (const label of item.options) {
      if (item.multiSelect) {
        const wrap = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = label;
        checks.push(box);
        const span = document.createElement('span');
        span.textContent = label;
        wrap.append(box, span);
        row.append(wrap);
      } else {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label; // an option is data
        b.addEventListener('click', () => send(label));
        keepFocus(b);
        row.append(b);
      }
    }
    el.append(row);
  }

  const answerRow = document.createElement('div');
  answerRow.className = 'queue-answer';
  const submit = document.createElement('button');
  submit.type = 'button';
  setIconButton(submit, 'send', 'queue.send');
  const collect = () => {
    const picked = checks.filter((c) => c.checked).map((c) => c.value);
    const typed = free.value.trim();
    send([...picked, ...(typed ? [typed] : [])].join(', '));
  };
  submit.addEventListener('click', collect);
  free.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); collect(); } });
  answerRow.append(free, submit);
  el.append(answerRow);
  return { el };
}

/** The question drawer. Entries are created once per question and never rebuilt, so typing survives state updates. */
export function createQueueDrawer(root: HTMLElement) {
  const { list, empty, setOpen, ...shell } = createDrawerShell(root, k('queue.title'), k('queue.empty'));
  const entries = new Map<string, Entry>();

  return {
    ...shell,
    /** A notification click: opens the drawer and brings that item into view (scrolling, never focus). */
    openOn(id: string): void {
      setOpen(true);
      entries.get(id)?.el.scrollIntoView?.({ block: 'nearest' });
    },
    update(items: QueueItem[]): void {
      const ids = new Set(items.map((i) => i.id));
      for (const id of [...entries.keys()]) if (!ids.has(id)) entries.delete(id);
      for (const item of items) {
        if (!entries.has(item.id)) {
          entries.set(item.id, createEntry(item, (answer) => {
            if (answer.trim() !== '') void api(`/api/queue/${item.id}/answer`, { method: 'POST', body: { answer } });
          }));
        }
      }
      reconcile(list, items.map((i) => entries.get(i.id)!.el));
      empty.hidden = items.length > 0;
    },
  };
}
