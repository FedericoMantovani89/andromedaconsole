import { setIconButton } from './icons';

/**
 * The close control of every dialog, drawer and overlay: a red dot that shows an X on hover and on keyboard focus (CSS `.close-dot`).
 * Its words ("Close") are the tooltip and the accessible name. In a `.dialog` it sits in the top right corner by itself.
 */
export function closeDot(onClick?: () => void, titleKey = 'common.close'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'close-dot';
  setIconButton(b, 'x', titleKey);
  b.addEventListener('mousedown', (ev) => ev.preventDefault()); // a button here must not take the keyboard
  b.addEventListener('click', (ev) => { ev.stopPropagation(); onClick?.(); });
  return b;
}
