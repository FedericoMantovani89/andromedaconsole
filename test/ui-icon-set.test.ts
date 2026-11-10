// @vitest-environment jsdom
// Every icon of the set draws, is told apart from the others and gives its button a name (the tooltip).
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/i18n-client', () => {
  const setTitle = (el: HTMLElement, key: string) => { el.title = key; el.setAttribute('aria-label', key); };
  return { t: (key: string) => key, setTitle, k: (s: string) => s };
});

import { ICON_NAMES, setIconButton } from '../src/ui/icons';

describe('icon set', () => {
  it('has the icons the buttons of the UI need', () => {
    for (const n of ['check', 'x', 'plus', 'minus', 'refresh', 'copy', 'download', 'upload', 'play', 'pause', 'undo', 'folder', 'external', 'edit', 'search', 'archive', 'send', 'merge', 'key', 'link', 'plug', 'trash']) {
      expect(ICON_NAMES, n).toContain(n);
    }
  });
  it('draws every icon as one svg with at least one path, and names the button', () => {
    for (const name of ICON_NAMES) {
      const b = document.createElement('button');
      setIconButton(b, name, 'some.key');
      expect(b.querySelectorAll('svg.icon'), name).toHaveLength(1);
      expect(b.querySelector('svg')!.dataset.icon).toBe(name);
      expect(b.querySelectorAll('path').length, name).toBeGreaterThan(0);
      expect([...b.querySelectorAll('path')].every((p) => (p.getAttribute('d') ?? '').length > 3), name).toBe(true);
      expect(b.getAttribute('aria-label'), name).toBe('some.key');
      expect(b.title, name).toBe('some.key');
    }
  });
  it('draws no two icons the same', () => {
    const drawn = ICON_NAMES.map((name) => { const b = document.createElement('button'); setIconButton(b, name, 'k'); return b.querySelector('svg')!.innerHTML; });
    expect(new Set(drawn).size).toBe(ICON_NAMES.length);
  });
});
