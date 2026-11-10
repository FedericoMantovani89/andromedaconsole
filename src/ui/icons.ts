import { setTitle } from './i18n-client';
import { el } from './dom';

export type IconName = 'bell' | 'gear' | 'clipboard' | 'mic' | 'record' | 'stop' | 'eye' | 'eyeOff' | 'chevronUp' | 'chevronDown' | 'trash'
  | 'check' | 'x' | 'plus' | 'minus' | 'refresh' | 'copy' | 'download' | 'upload' | 'play' | 'pause' | 'undo' | 'folder' | 'external' | 'edit' | 'search' | 'archive' | 'send' | 'merge' | 'key' | 'link' | 'plug' | 'chevronLeft' | 'chevronRight' | 'warning' | 'checkDouble' | 'ban';

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
  checkDouble: ['M2.5 12.5L7 17l5-6', 'M10 16.5l1 .5L21.5 7'],
  ban: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M6 6l12 12'],
  warning: ['M12 4L2.5 20h19z', 'M12 10v4.5', 'M12 17.2v.01'],
  chevronLeft: ['M15 6l-6 6 6 6'],
  chevronRight: ['M9 6l6 6-6 6'],
  mic: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M5.5 11a6.5 6.5 0 0 0 13 0', 'M12 17.5V21'],
  eye: ['M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  eyeOff: ['M3 3l18 18', 'M10.6 6.2A10.5 10.5 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.2 3.9', 'M6.2 7.6A17 17 0 0 0 2 12s3.6 6.5 10 6.5c1.6 0 3-.4 4.2-1', 'M9.9 9.9a3 3 0 0 0 4.2 4.2'],
  // Filled shapes (see svgFor): the red dot of a recorder and its red stop square.
  record: ['M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z'],
  stop: ['M6.5 6.5h11v11h-11z'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  refresh: ['M20 11a8 8 0 0 0-14.5-4', 'M4 4v4h4', 'M4 13a8 8 0 0 0 14.5 4', 'M20 20v-4h-4'],
  copy: ['M9 9h10v11H9z', 'M15 9V4H5v11h4'],
  download: ['M12 4v11', 'M7.5 11L12 15.5 16.5 11', 'M5 20h14'],
  upload: ['M12 16V5', 'M7.5 9L12 4.5 16.5 9', 'M5 20h14'],
  play: ['M8 5l11 7-11 7z'],
  pause: ['M8 5v14', 'M16 5v14'],
  undo: ['M9 7L4 12l5 5', 'M4 12h10a6 6 0 0 1 6 6'],
  folder: ['M3 7a1.5 1.5 0 0 1 1.5-1.5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5H5V6h5'],
  edit: ['M4 20l1-4L16.5 4.5a2 2 0 0 1 3 3L8 19z', 'M14.5 6.5l3 3'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M16 16l4.5 4.5'],
  archive: ['M3.5 5h17v4h-17z', 'M5 9v10h14V9', 'M10 13h4'],
  send: ['M21 3L3 10.5l7 2.5 2.5 7z', 'M10 13l11-10'],
  merge: ['M7 4v9', 'M7 4a2 2 0 1 0 0 .01', 'M17 20a2 2 0 1 0 0-.01', 'M7 13a4 4 0 0 0 4 4h4'],
  key: ['M8 9a4 4 0 1 0 0 .01', 'M11 12l9 9', 'M16 17l2-2', 'M19 20l2-2'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  plug: ['M9 3v5', 'M15 3v5', 'M6 8h12v4a6 6 0 0 1-12 0z', 'M12 18v3'],
  trash: ['M4 7h16', 'M9 7V4.5h6V7', 'M6.5 7l1 13h9l1-13', 'M10 11v6M14 11v6'],
  clipboard: ['M9 4h6v3H9z', 'M15 5.5h2.5a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V7a1.5 1.5 0 0 1 1.5-1.5H9', 'M8.5 11h7M8.5 14.5h7M8.5 18h4'],
};

/** Every icon of the set (the icon tests walk it). */
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

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
