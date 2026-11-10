import { Terminal } from '@xterm/xterm';
import { TERM_OPTIONS } from './term-theme';
import { FitAddon } from '@xterm/addon-fit';
import type { StateMessage } from '../shared/protocol';
import { api, wsUrl } from './api';
import { bindText, k } from './i18n-client';
import { closeOverlay } from './settings';
import { el } from './dom';
import { closeDot } from './close-dot';

const RESULT_KEYS = {
  done: k('prereq.install.result.done'),
  needs_admin: k('prereq.install.result.needs_admin'),
  failed: k('prereq.install.result.failed'),
} as const;
const POLL_MS = 1000;

/**
 * Shows the terminal of a running install (`/ws/term/<terminalId>`), read-only: nothing typed here reaches the process, the server
 * ignores keyboard frames on utility terminals, and no focus is ever moved. The result line comes from the state (`install`).
 * Closing the dialog does not stop the install (it says so). `onClose` runs after it closed; the default hands back to the page.
 */
export function openInstallTerminal(terminalId: string, onClose: () => void = closeOverlay): void {
  const tool = terminalId.replace(/^install-/, '');
  const overlay = document.getElementById('overlay')!;
  const dialog = el('div', 'dialog install-dialog');

  const title = el('h2');
  bindText(title, 'prereq.install.running');
  const host = el('div', 'install-terminal');
  const result = el('p', 'install-result');
  const note = el('p', 'settings-note');
  bindText(note, 'prereq.install.closeNote');
  const close = closeDot();
  dialog.append(close, title, host, result, note);
  overlay.replaceChildren(dialog);
  overlay.hidden = false;

  const term = new Terminal({ ...TERM_OPTIONS, scrollback: 5000, cursorBlink: false, convertEol: false, disableStdin: true });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);

  let ws: WebSocket | undefined;
  let closed = false;
  const refit = () => {
    try { fit.fit(); } catch { /* not laid out yet */ }
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };
  const connect = () => {
    ws = new WebSocket(wsUrl(`/ws/term/${terminalId}`));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { term.reset(); refit(); };
    ws.onmessage = (ev) => term.write(new Uint8Array(ev.data as ArrayBuffer));
    ws.onclose = () => { if (!closed) setTimeout(connect, 1000); };
  };
  connect();
  const observer = new ResizeObserver(refit);
  observer.observe(host);

  const poll = setInterval(() => {
    void api<StateMessage>('/api/state').then((res) => {
      const done = res.status === 200 ? res.body.install : undefined;
      if (!done || done.id !== tool || closed) return;
      bindText(result, RESULT_KEYS[done.result], { code: done.exitCode });
      clearInterval(poll);
    }).catch(() => { /* the next tick tries again */ });
  }, POLL_MS);

  close.addEventListener('click', () => {
    closed = true;
    clearInterval(poll);
    observer.disconnect();
    ws?.close();
    term.dispose();
    onClose();
  });
}
