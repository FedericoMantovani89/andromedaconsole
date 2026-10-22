import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Activity } from '../shared/activity';
import type { SessionInfo } from '../shared/protocol';
import { computeAgentLayout } from '../shared/layout';
import { api, wsUrl } from './api';
import { reconcile } from './dom';
import { errorText } from './new-agent';
import { bindText, k } from './i18n-client';
import { setIconButton } from './icons';
import { createArchiveButton, syncArchiveButton } from './archive';
import { openChecklistDialog } from './checklist-dialog';
import { createCompactButton, createDormantPanel } from './dormant-panel';
import { STATE_KEYS, applyBudget, applyLoop, applyProgress, applyRequests, applyTicket, applyWaiting } from './chips';
import { SCROLLBACK, TERM_OPTIONS } from './term-theme';
import { FocusState, focusActiveTerminal, refreshActiveStyles, type PanelHandle } from './focus';

/** What the chip next to the state says: why the agent has not started (the launch check) or how long it has been silent. */
export interface StallInfo { launch?: 'no_session' | 'goal_not_taken'; silentMinutes?: number }

export function stallOf(info: SessionInfo): StallInfo | undefined {
  const stall: StallInfo = {
    ...(info.launchProblem ? { launch: info.launchProblem } : {}),
    ...(info.silentMinutes !== undefined ? { silentMinutes: info.silentMinutes } : {}),
  };
  return stall.launch || stall.silentMinutes !== undefined ? stall : undefined;
}

/** The progress chip opens the agent's checklist; it never takes the keyboard from the terminal on a mouse press. */
function openChecklistOnClick(chip: HTMLElement, slug: string): void {
  chip.classList.add('panel-progress-open');
  chip.setAttribute('role', 'button');
  chip.addEventListener('mousedown', (ev) => ev.preventDefault());
  chip.addEventListener('click', (ev) => { ev.stopPropagation(); openChecklistDialog(slug); });
}

/** An agent's name with its profile under it (the main keeps its label inline). */
function nameBlock(title: HTMLElement, meta: HTMLElement): HTMLElement {
  const block = document.createElement('span');
  block.className = 'panel-name';
  block.append(title, meta);
  return block;
}

function applyStalled(el: HTMLElement, stall: StallInfo | undefined): void {
  el.hidden = !stall;
  if (stall?.launch === 'no_session') bindText(el, k('panel.launchStalled.no_session'));
  else if (stall?.launch === 'goal_not_taken') bindText(el, k('panel.launchStalled.goal_not_taken'));
  else if (stall?.silentMinutes !== undefined) bindText(el, k('panel.silent'), { minutes: String(stall.silentMinutes) });
  else { el.textContent = ''; delete el.dataset.i18n; delete el.dataset.i18nParams; }
}

/** The stale chip: the worktree has not been touched for many days. */
function applyStale(el: HTMLElement, stale: boolean | undefined): void {
  el.className = 'panel-stale';
  el.hidden = !stale;
  if (stale) bindText(el, k('panel.stale'));
  else { el.textContent = ''; delete el.dataset.i18n; }
}

interface Panel extends PanelHandle {
  setState(state: Activity, progress?: SessionInfo['progress'], stall?: StallInfo, ticket?: SessionInfo['ticket'], budget?: SessionInfo['budget'], loop?: SessionInfo['loop'], waiting?: number, requests?: SessionInfo['requests']): void;
  dispose(): void;
  /** Fits the terminal to its box again (after the project's tab was hidden). */
  refit(): void;
}

/** One terminal panel: an xterm.js instance wired to /ws/term/<slug>. The server owns the process and the scrollback. */
function createPanel(info: SessionInfo, onActivate: (slug: string) => void, project: string | undefined, onCompact?: (slug: string) => void): Panel {
  const root = document.createElement('div');
  root.className = 'panel';
  root.dataset.slug = info.slug;

  const header = document.createElement('div');
  header.className = 'panel-header';
  const title = document.createElement('span');
  title.className = 'panel-title';
  title.textContent = info.slug; // P1: the slug is the panel title
  const meta = document.createElement('span');
  meta.className = 'panel-meta';
  if (info.role === 'main') bindText(meta, 'panel.main');
  else meta.textContent = info.profile;
  const badge = document.createElement('span');
  badge.className = 'badge';
  bindText(badge, 'panel.badge.activeInput');
  const stateEl = document.createElement('span');
  const progressEl = document.createElement('span');
  progressEl.className = 'panel-progress';
  progressEl.hidden = true;
  openChecklistOnClick(progressEl, info.slug);
  const stalledEl = document.createElement('span');
  stalledEl.className = 'panel-stalled';
  stalledEl.hidden = true;
  const ticketEl = document.createElement('span');
  ticketEl.className = 'panel-ticket';
  ticketEl.hidden = true;
  const budgetEl = document.createElement('span');
  budgetEl.className = 'panel-budget';
  budgetEl.hidden = true;
  const readBtn = document.createElement('button');
  const loopEl = document.createElement('span');
  loopEl.className = 'panel-loop';
  loopEl.hidden = true;
  const waitingEl = document.createElement('span');
  waitingEl.className = 'panel-waiting';
  waitingEl.hidden = true;
  const requestsWaitingEl = document.createElement('span');
  requestsWaitingEl.className = 'panel-requests waiting';
  requestsWaitingEl.hidden = true;
  const requestsOwedEl = document.createElement('span');
  requestsOwedEl.className = 'panel-requests owed';
  requestsOwedEl.hidden = true;
  readBtn.className = 'panel-read';
  setIconButton(readBtn, 'clipboard', k('reader.open'));
  readBtn.addEventListener('mousedown', (ev) => ev.preventDefault()); // a button here must not take the keyboard
  readBtn.addEventListener('click', () => window.dispatchEvent(new CustomEvent('console-open-reader', { detail: info.slug })));
  header.append(info.role === 'main' ? title : nameBlock(title, meta), ...(info.role === 'main' ? [meta] : []), badge, stateEl, stalledEl, ticketEl, budgetEl, loopEl, waitingEl, requestsWaitingEl, requestsOwedEl, progressEl);
  // Voice dictation goes to the main, so only the main's panel has the button (built once with the header, never re-parented).
  if (info.role === 'main') {
    const micBtn = document.createElement('button');
    micBtn.type = 'button';
    micBtn.className = 'panel-read panel-dictate';
    setIconButton(micBtn, 'mic', k('header.dictation'));
    micBtn.addEventListener('mousedown', (ev) => ev.preventDefault()); // a button here must not take the keyboard
    micBtn.addEventListener('click', () => window.dispatchEvent(new CustomEvent('console-open-dictation')));
    header.append(micBtn);
  }
  header.append(readBtn, createArchiveButton(info.slug));
  if (onCompact) header.append(createCompactButton(info.slug, onCompact));

  const host = document.createElement('div');
  host.className = 'panel-term';
  root.append(header, host);

  const term = new Terminal({ ...TERM_OPTIONS, scrollback: SCROLLBACK, cursorBlink: false, convertEol: false });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);

  let ws: WebSocket | undefined;
  let closed = false;
  let retry = 500;

  const sendResize = () => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };
  const refit = () => {
    try { fit.fit(); } catch { /* panel not laid out yet */ }
    sendResize();
  };

  const connect = () => {
    ws = new WebSocket(wsUrl(`/ws/term/${info.slug}`, project));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      term.reset(); // the server replays the whole scrollback on every connection
      retry = 500;
      refit();
    };
    ws.onmessage = (ev) => term.write(new Uint8Array(ev.data as ArrayBuffer));
    ws.onclose = () => {
      if (closed) return;
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 5000);
    };
  };
  connect();

  const encoder = new TextEncoder();
  term.onData((d) => { if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(d)); });

  const observer = new ResizeObserver(refit);
  observer.observe(host);
  // A click is a user action: it is the only thing (besides shortcuts) that moves the focus.
  root.addEventListener('mousedown', () => onActivate(info.slug));

  return {
    root, term, refit,
    setState: (state, progress, stall, ticket, budget, loop, waiting, requests) => {
      applyRequests(requestsWaitingEl, requestsOwedEl, requests);
      applyLoop(loopEl, loop);
      applyWaiting(waitingEl, waiting);
      applyStalled(stalledEl, stall);
      applyTicket(ticketEl, ticket);
      bindText(stateEl, STATE_KEYS[state]);
      stateEl.className = `panel-state ${state}`;
      applyProgress(progressEl, progress);
      applyBudget(budgetEl, { state, ticket, budget });
      syncArchiveButton(root, state, ticket);
    },
    dispose: () => {
      closed = true;
      observer.disconnect();
      ws?.close();
      term.dispose();
    },
  };
}

/** Owns the panels of the whole workspace: the fixed main on the left, the agents stacked on the right. */
export class Workspace {
  private readonly panels = new Map<string, Panel>();
  private readonly focus: FocusState;
  private expanded: string | null = null;
  /** Agents the user folded into a bar with Compact; Expand brings them back. */
  private readonly collapsed = new Set<string>();
  private mainId = '';
  private lastMain: SessionInfo | undefined;
  private lastAgents: SessionInfo[] = [];
  private newAgentControl: HTMLElement | undefined;
  /** The expanded panels of dormant agents (no process, so no terminal): built once, dropped when the agent wakes or is no longer a panel. */
  private readonly dormantPanels = new Map<string, HTMLElement>();
  /** Bars are kept between updates: rebuilding them would move every node after them and drop the keyboard focus. */
  private readonly bars = new Map<string, { el: HTMLElement; state: HTMLElement; progress: HTMLElement; stalled: HTMLElement; ticket: HTMLElement; budget: HTMLElement; loop: HTMLElement; waiting: HTMLElement; requestsWaiting: HTMLElement; requestsOwed: HTMLElement; pending: boolean; dormant: boolean; stale: HTMLElement }>();

  /** `project` is the project this workspace shows: its terminals connect with it, whichever tab is on screen. */
  constructor(private readonly mainCol: HTMLElement, private readonly agentsCol: HTMLElement, mainId: string, private readonly project?: string) {
    this.mainId = mainId;
    this.focus = new FocusState(mainId);
  }

  /** The project was closed: every terminal connection ends. */
  dispose(): void {
    for (const slug of [...this.panels.keys()]) this.dropPanel(slug);
  }

  /** The project's tab was selected (a user action): fit its terminals again, then make its active panel the active input. */
  show(): void {
    for (const p of this.panels.values()) p.refit();
    this.activate(this.focus.active);
  }

  setNewAgentControl(el: HTMLElement): void {
    this.newAgentControl = el;
  }

  get active(): string { return this.focus.active; }

  /** User-initiated activation (click or shortcut): the only path that moves the keyboard. */
  activate(slug: string): void {
    this.focus.activate(slug);
    refreshActiveStyles(this.focus, this.panels);
    focusActiveTerminal(this.focus, this.panels, 'user');
  }

  /** Alt+1 is main, Alt+2.. the agents in order (SPEC 5.4). */
  activateByIndex(index: number): void {
    const order = [this.mainId, ...this.lastAgents.map((a) => a.slug)];
    const slug = order[index];
    if (slug && this.panels.has(slug)) this.activate(slug);
  }

  update(main: SessionInfo, agents: SessionInfo[]): void {
    this.lastAgents = agents;
    this.lastMain = main;
    this.mainId = main.slug;
    this.ensurePanel(main);
    if (this.mainCol.firstElementChild !== this.panels.get(main.slug)!.root) {
      this.mainCol.replaceChildren(this.panels.get(main.slug)!.root);
    }
    this.panels.get(main.slug)!.setState(main.state, main.progress);

    const bySlug = new Map(agents.map((a) => [a.slug, a]));
    // Agents without a process yet (waiting in the queue) are always bars; the rest follow the 4-panels rule.
    const live = agents.filter((a) => a.status !== 'pending');
    const layout = [
      ...computeAgentLayout(live.map((a) => a.slug), this.expanded, 4, this.collapsed),
      ...agents.filter((a) => a.status === 'pending').map((a) => ({ slug: a.slug, mode: 'bar' as const })),
    ];
    // The "+ new agent" control is always the first thing in the agents column, whatever the number of agents.
    const children: HTMLElement[] = this.newAgentControl ? [this.newAgentControl] : [];
    for (const item of layout) {
      const info = bySlug.get(item.slug)!;
      if (item.mode === 'panel' && info.state === 'dormant') {
        this.dropPanel(item.slug);
        let d = this.dormantPanels.get(item.slug);
        if (!d) { d = createDormantPanel(info, (s) => this.compact(s)); this.dormantPanels.set(item.slug, d); }
        children.push(d);
      } else if (item.mode === 'panel') {
        this.dormantPanels.delete(item.slug);
        const p = this.ensurePanel(info);
        p.setState(info.state, info.progress, stallOf(info), info.ticket, info.budget, info.loop, info.waiting, info.requests);
        children.push(p.root);
      } else {
        this.dropPanel(item.slug); // the server keeps the scrollback; reconnecting restores it
        children.push(this.bar(info));
      }
    }
    for (const slug of [...this.dormantPanels.keys()]) {
      if (!layout.some((l) => l.slug === slug && l.mode === 'panel') || bySlug.get(slug)?.state !== 'dormant') this.dormantPanels.delete(slug);
    }
    const barSlugs = new Set(layout.filter((l) => l.mode === 'bar').map((l) => l.slug));
    for (const slug of [...this.bars.keys()]) if (!barSlugs.has(slug)) this.bars.delete(slug);
    for (const slug of [...this.panels.keys()]) {
      if (slug !== main.slug && !bySlug.has(slug)) this.dropPanel(slug);
    }
    reconcile(this.agentsCol, children);
    refreshActiveStyles(this.focus, this.panels); // styles only: a new panel never takes the focus (P2)
  }

  /** Focus the main terminal once when the console is opened (the user just opened it). */
  focusMainOnOpen(): void {
    focusActiveTerminal(this.focus, this.panels, 'user');
  }

  private ensurePanel(info: SessionInfo): Panel {
    let p = this.panels.get(info.slug);
    if (!p) {
      p = createPanel(info, (slug) => this.activate(slug), this.project, info.role === 'main' ? undefined : (s) => this.compact(s));
      this.panels.set(info.slug, p);
      this.focus.onPanelAdded(info.slug);
    }
    return p;
  }

  /** Compact on a panel: the agent becomes a bar (its terminal is dropped, the server keeps the scrollback). */
  private compact(slug: string): void {
    this.collapsed.add(slug);
    if (this.expanded === slug) this.expanded = null;
    this.update(this.lastMain!, this.lastAgents);
  }

  private dropPanel(slug: string): void {
    const p = this.panels.get(slug);
    if (!p) return;
    p.dispose();
    this.panels.delete(slug);
    this.focus.remove(slug);
  }

  private bar(info: SessionInfo): HTMLElement {
    const cached = this.bars.get(info.slug);
    const pending = info.status === 'pending';
    const dormant = info.state === 'dormant';
    if (cached && cached.pending === pending && cached.dormant === dormant) {
      applyStale(cached.stale, info.stale);
      bindText(cached.state, STATE_KEYS[info.state]);
      cached.state.className = `panel-state ${info.state}`;
      applyProgress(cached.progress, info.progress);
      applyStalled(cached.stalled, stallOf(info));
      applyTicket(cached.ticket, info.ticket);
      applyBudget(cached.budget, info);
      applyLoop(cached.loop, info.loop);
      applyWaiting(cached.waiting, info.waiting);
      applyRequests(cached.requestsWaiting, cached.requestsOwed, info.requests);
      syncArchiveButton(cached.el, info.state, info.ticket);
      return cached.el;
    }
    const el = document.createElement('div');
    el.className = 'bar';
    const title = document.createElement('span');
    title.className = 'panel-title';
    title.textContent = info.slug;
    const meta = document.createElement('span');
    meta.className = 'panel-meta';
    meta.textContent = info.profile;
    const state = document.createElement('span');
    state.className = `panel-state ${info.state}`;
    bindText(state, STATE_KEYS[info.state]);
    const progress = document.createElement('span');
    progress.className = 'panel-progress';
    openChecklistOnClick(progress, info.slug);
    applyProgress(progress, info.progress);
    const stalled = document.createElement('span');
    stalled.className = 'panel-stalled';
    applyStalled(stalled, stallOf(info));
    const ticket = document.createElement('span');
    applyTicket(ticket, info.ticket);
    const budget = document.createElement('span');
    applyBudget(budget, info);
    const loop = document.createElement('span');
    applyLoop(loop, info.loop);
    const waiting = document.createElement('span');
    waiting.className = 'panel-waiting';
    applyWaiting(waiting, info.waiting);
    const requestsWaiting = document.createElement('span');
    const requestsOwed = document.createElement('span');
    applyRequests(requestsWaiting, requestsOwed, info.requests);
    const stale = document.createElement('span');
    applyStale(stale, info.stale);
    el.append(nameBlock(title, meta), state, stalled, ticket, budget, loop, waiting, requestsWaiting, requestsOwed, stale, progress, createArchiveButton(info.slug));
    syncArchiveButton(el, info.state, info.ticket);
    if (dormant) this.dormantControls(el, info.slug);
    if (!pending) { // a queued agent has no terminal to expand yet
      const expand = document.createElement('button');
      expand.className = 'bar-expand';
      setIconButton(expand, 'chevronDown', k('panel.expand'));
      expand.addEventListener('click', () => { this.collapsed.delete(info.slug); this.expanded = info.slug; this.update(this.lastMain!, this.lastAgents); });
      el.append(expand);
    }
    this.bars.set(info.slug, { el, state, progress, stalled, ticket, budget, loop, waiting, requestsWaiting, requestsOwed, pending, dormant, stale });
    return el;
  }

  /** A dormant agent has no terminal: its last summary (from the read panel, n/a when none) and a Wake up button (a user action). */
  private dormantControls(el: HTMLElement, slug: string): void {
    const summary = document.createElement('span');
    summary.className = 'panel-summary';
    bindText(summary, 'common.notAvailable');
    void api<{ entries?: { text?: string }[] }>(`/api/reading/${slug}`).then((r) => {
      const last = r.status === 200 ? r.body?.entries?.at(-1)?.text : undefined;
      if (typeof last !== 'string' || last.trim() === '') return;
      delete summary.dataset.i18n;
      delete summary.dataset.i18nParams;
      summary.textContent = last.slice(0, 200); // the agent's own words: data, not interface text
      el.title = last.slice(0, 200);
    }).catch(() => undefined);
    const wake = document.createElement('button');
    wake.className = 'panel-wake';
    bindText(wake, 'panel.wake');
    const error = document.createElement('span');
    error.className = 'form-error';
    const doWake = (): void => {
      wake.disabled = true;
      error.textContent = '';
      void api<{ code?: string }>(`/api/agents/${slug}/wake`, { method: 'POST' }).then((r) => {
        if (r.status === 200) return; // the next state push shows it starting or queued
        wake.disabled = false;
        error.textContent = errorText({ code: r.body?.code ?? 'generic' });
      }).catch(() => { wake.disabled = false; });
    };
    wake.addEventListener('click', (e) => { e.stopPropagation(); doWake(); });
    el.addEventListener('click', () => { if (!wake.disabled) doWake(); }); // the bar itself is also a way to open it
    el.append(summary, error, wake);
  }
}
