// @vitest-environment jsdom
// The red close dot every dialog, drawer and overlay uses.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/i18n-client', () => {
  const setTitle = (el: HTMLElement, key: string) => { el.title = key; el.setAttribute('aria-label', key); };
  return { t: (key: string) => key, setTitle, k: (s: string) => s, bindText: (el: HTMLElement, key: string) => { el.textContent = key; } };
});

import { closeDot } from '../src/ui/close-dot';

describe('closeDot', () => {
  it('is a button named "common.close" by default, with no text of its own', () => {
    const b = closeDot(() => undefined);
    expect(b.tagName).toBe('BUTTON');
    expect(b.type).toBe('button');
    expect(b.classList.contains('close-dot')).toBe(true);
    expect(b.title).toBe('common.close');
    expect(b.getAttribute('aria-label')).toBe('common.close');
    expect(b.textContent).toBe('');
  });
  it('takes another tooltip key', () => {
    expect(closeDot(() => undefined, 'queue.budget.close').title).toBe('queue.budget.close');
  });
  it('calls the handler once per click and keeps the click from reaching the parent', () => {
    const calls: number[] = [];
    const parent = document.createElement('div');
    const outer = vi.fn();
    parent.addEventListener('click', outer);
    const b = closeDot(() => calls.push(1));
    parent.append(b);
    b.click();
    expect(calls).toHaveLength(1);
    expect(outer).not.toHaveBeenCalled();
  });
  it('draws the X in an svg (shown by CSS on hover and focus), hidden from screen readers', () => {
    const svg = closeDot(() => undefined).querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelectorAll('path').length).toBeGreaterThan(0);
  });
  it('does not take the keyboard focus on mouse down', () => {
    const ev = new MouseEvent('mousedown', { cancelable: true, bubbles: true });
    closeDot(() => undefined).dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});
