import { api } from './api';
import { bindText, k, setPlaceholder } from './i18n-client';
import { renderInto } from './markdown-lazy';
import { el } from './dom';
import { closeDot } from './close-dot';
import { setIconButton } from './icons';

export interface ReadingEntry { n: number; at: string; text: string; truncated?: true }

/**
 * The "read" panel (SPEC 5.5): the last answers of one agent as rendered Markdown, with ordinary browser scrolling,
 * a filter, and a copy button. The text never travels through the terminal.
 */
export function createReader(root: HTMLElement) {
  const head = el('div', 'drawer-head');
  const title = el('h2');
  const search = el('input');
  setPlaceholder(search, 'reader.search');
  const copy = el('button');
  setIconButton(copy, 'copy', 'reader.copy');
  const close = closeDot();
  head.append(title, search, copy, close);

  const body = el('div', 'reader-body');
  const turns = el('div', 'reader-turns');
  const content = el('div', 'reader-content');
  const empty = el('div', 'queue-empty');
  bindText(empty, 'reader.empty');
  const note = el('div', 'form-error');
  note.hidden = true;
  bindText(note, 'reader.truncated');
  body.append(turns, content);
  root.append(head, empty, body);

  let slug: string | undefined;
  let entries: ReadingEntry[] = [];
  let selected: number | undefined;
  let isOpen = false;
  const setOpen = (v: boolean) => { isOpen = v; root.hidden = !v; };
  setOpen(false);

  const show = (n: number | undefined) => {
    selected = n;
    const e = entries.find((x) => x.n === n);
    content.replaceChildren();
    if (!e) return;
    const html = el('div', 'markdown');
    renderInto(html, e.text); // sanitised when formatted: answers are untrusted text
    content.append(...(e.truncated ? [note] : []), html);
    note.hidden = !e.truncated;
    for (const b of turns.querySelectorAll<HTMLElement>('button')) b.classList.toggle('selected', Number(b.dataset.n) === n);
  };

  const renderList = () => {
    const q = search.value.trim().toLowerCase();
    turns.replaceChildren();
    for (const e of [...entries].reverse()) {
      if (q && !e.text.toLowerCase().includes(q)) continue;
      const b = el('button');
      b.dataset.n = String(e.n);
      bindText(b, k('reader.turn'), { n: e.n });
      const time = el('small');
      time.textContent = new Date(e.at).toLocaleTimeString();
      b.append(' ', time);
      b.addEventListener('click', () => show(e.n));
      turns.append(b);
    }
    empty.hidden = entries.length > 0;
    body.hidden = entries.length === 0;
    for (const b of turns.querySelectorAll<HTMLElement>('button')) b.classList.toggle('selected', Number(b.dataset.n) === selected);
  };

  search.addEventListener('input', renderList);
  close.addEventListener('click', () => setOpen(false));
  copy.addEventListener('click', () => {
    const e = entries.find((x) => x.n === selected);
    if (!e) return;
    void navigator.clipboard.writeText(e.text).then(() => {
      bindText(copy, 'reader.copied');
      setTimeout(() => bindText(copy, 'reader.copy'), 1500);
    }).catch(() => { /* clipboard blocked: nothing to do */ });
  });

  return {
    isOpen: () => isOpen,
    current: () => slug,
    /** Opens (or closes, if already showing this agent) the panel for `name`. */
    async toggle(name: string): Promise<void> {
      if (isOpen && slug === name) { setOpen(false); return; }
      slug = name;
      bindText(title, 'reader.title', { slug: name });
      const res = await api<{ entries: ReadingEntry[] }>(`/api/reading/${name}`);
      entries = res.status === 200 ? res.body.entries : [];
      search.value = '';
      renderList();
      show(entries.at(-1)?.n);
      setOpen(true);
    },
    /** A live answer arrived: follow it only if the user was looking at the latest one (never yank the view). */
    onEntry(name: string, entry: ReadingEntry): void {
      if (name !== slug) return;
      const followLatest = selected === undefined || selected === entries.at(-1)?.n;
      entries.push(entry);
      renderList();
      if (followLatest) show(entry.n);
    },
  };
}
