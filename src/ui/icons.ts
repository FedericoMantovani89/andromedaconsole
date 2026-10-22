import { setTitle } from './i18n-client';
import { el } from './dom';

export type IconName = 'bell' | 'gear' | 'clipboard' | 'mic' | 'record' | 'stop' | 'eye' | 'eyeOff' | 'chevronUp' | 'chevronDown';

const NS = 'http://www.w3.org/2000/svg';

/** Stroke paths on a 24x24 grid; the color is the button's own (currentColor). */
const PATHS: Record<IconName, string[]> = {
  bell: ['M6 9a6 6 0 0 1 12 0c0 6 2 7.5 2 7.5H4S6 15 6 9z', 'M10 20a2 2 0 0 0 4 0'],
  // A toothed cog around a hub (a circle with rays reads as a sun).
  gear: [
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  ],
  chevronUp: ['M6 15l6-6 6 6'],
  chevronDown: ['M6 9l6 6 6-6'],
  mic: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M5.5 11a6.5 6.5 0 0 0 13 0', 'M12 17.5V21'],
  eye: ['M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  eyeOff: ['M3 3l18 18', 'M10.6 6.2A10.5 10.5 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.2 3.9', 'M6.2 7.6A17 17 0 0 0 2 12s3.6 6.5 10 6.5c1.6 0 3-.4 4.2-1', 'M9.9 9.9a3 3 0 0 0 4.2 4.2'],
  // Filled shapes (see svgFor): the red dot of a recorder and its red stop square.
  record: ['M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z'],
  stop: ['M6.5 6.5h11v11h-11z'],
  clipboard: ['M9 4h6v3H9z', 'M15 5.5h2.5a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V7a1.5 1.5 0 0 1 1.5-1.5H9', 'M8.5 11h7M8.5 14.5h7M8.5 18h4'],
};

function svgFor(name: IconName): SVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  const filled = name === 'record' || name === 'stop';
  svg.setAttribute('fill', filled ? 'currentColor' : 'none');
  svg.setAttribute('stroke', filled ? 'none' : 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.icon = name;
  for (const d of PATHS[name]) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** Turns a button into an icon button: the icon replaces the text, the tooltip and accessible name come from the key (and follow the language). The button itself is never replaced, so it keeps focus. */
export function setIconButton(btn: HTMLElement, name: IconName, titleKey: string, params?: Record<string, string | number>): void {
  const current = btn.querySelector<SVGElement>(':scope > svg.icon');
  if (current?.dataset.icon !== name) {
    for (const node of [...btn.childNodes]) if (node.nodeType === Node.TEXT_NODE || node === current) node.remove();
    btn.prepend(svgFor(name));
  }
  btn.classList.add('icon-action');
  setTitle(btn, titleKey, params);
}

/** The pending count over the bell: hidden at zero (the tooltip still says the number). */
export function setQueueBadge(btn: HTMLElement, count: number): void {
  let badge = btn.querySelector<HTMLElement>(':scope > .icon-badge');
  if (!badge) {
    badge = el('span');
    badge.className = 'icon-badge';
    btn.append(badge);
  }
  badge.textContent = String(count);
  badge.hidden = count <= 0;
}
