import type { StateMessage } from '../shared/protocol';
import { runningAgents } from '../shared/stats';
import { api } from './api';
import { openArchiveDialog, refreshArchiveDialog, archivedAgents, archivableAgents, visibleAgents } from './archive';
import { bindText, k, setTitle, t } from './i18n-client';
import { setIconButton, setQueueBadge } from './icons';

interface Bar {
  /** Shown while agents run without permission prompts (bypass). */
  bypass: HTMLElement;
  /** Shown while a state file the console could not read sits set aside; a click dismisses all of them. */
  problem: HTMLElement;
  budget: HTMLElement;
  quota: HTMLElement;
  /** A newer version of the desktop app (SPEC 33.4): the text and the one button of the phase (download, or restart). */
  update: HTMLElement;
  updateBtn: HTMLButtonElement;
  updateAction?: 'download' | 'install';
  sleep: HTMLElement;
  resume: HTMLButtonElement;
  agents: HTMLElement;
  /** "Archived (N)": hidden at zero, opens the list. */
  archived: HTMLButtonElement;
  latest?: StateMessage;
  suspended: HTMLElement;
  /** The countdown refreshes by itself between state pushes; only while the console sleeps. */
  timer?: ReturnType<typeof setInterval>;
  sleepState?: NonNullable<StateMessage['sleep']>;
}

// The nodes of a bar are made once and only updated afterwards: replacing them on every push would drop a focused button.
const bars = new WeakMap<HTMLElement, Bar>();

const span = (): HTMLElement => document.createElement('span');
const gap = (): HTMLElement => { const s = span(); s.textContent = ' '; return s; };

function build(el: HTMLElement): Bar {
  const label = (key: string): HTMLElement => { const l = span(); bindText(l, key); return l; };
  // With bypass on the guard is the only brake: the bar says so at all times, not only inside Options.
  const bypass = span();
  bypass.className = 'statusbar-bypass';
  bypass.hidden = true;
  bindText(bypass, k('statusbar.bypass'));
  setTitle(bypass, k('settings.bypass.warning'));
  const problem = document.createElement('button');
  problem.type = 'button';
  problem.className = 'statusbar-problem';
  problem.hidden = true;
  problem.addEventListener('mousedown', (ev) => ev.preventDefault()); // clicking never takes the keyboard from where it is
  problem.addEventListener('click', () => { void api('/api/state-problems/dismiss', { method: 'POST' }).catch(() => undefined); });
  const budget = span();
  // The project has no budget of its own (only agents and tickets do): no limit is set, which reads as infinite, not as "n/a".
  budget.append(label(k('statusbar.budget')), gap(), label(k('statusbar.budgetUnlimited')));
  const quota = span();
  const update = span();
  update.hidden = true;
  const updateBtn = document.createElement('button');
  updateBtn.type = 'button';
  updateBtn.className = 'statusbar-update';
  updateBtn.hidden = true;
  updateBtn.addEventListener('mousedown', (ev) => ev.preventDefault()); // clicking never takes the keyboard from where it is
  const sleep = span();
  sleep.hidden = true;
  // Shown only while the console sleeps (nothing to resume otherwise); clicking it never takes the keyboard from where it is.
  const resume = document.createElement('button');
  resume.type = 'button';
  resume.className = 'statusbar-resume';
  resume.hidden = true;
  resume.disabled = true;
  setIconButton(resume, 'play', 'statusbar.resumeNow');
  resume.addEventListener('mousedown', (ev) => ev.preventDefault());
  resume.addEventListener('click', () => { void api('/api/sleep/resume', { method: 'POST' }).catch(() => undefined); });
  const agents = span();
  const suspended = span();
  const archived = document.createElement('button');
  archived.type = 'button';
  archived.className = 'statusbar-archived';
  archived.hidden = true;
  archived.addEventListener('mousedown', (ev) => ev.preventDefault());
  const bar: Bar = { bypass, problem, budget, quota, update, updateBtn, sleep, resume, agents, archived, suspended };
  archived.addEventListener('click', () => openArchiveDialog(() => bar.latest));
  updateBtn.addEventListener('click', () => {
    if (bar.updateAction) void api(`/api/update/${bar.updateAction}`, { method: 'POST' }).catch(() => undefined);
  });
  // The update chip is the last thing in the bar, at its far right edge (margin-left: auto on the text in styles.css).
  update.className = 'statusbar-update-text';
  el.replaceChildren(bypass, problem, budget, quota, sleep, resume, agents, archived, suspended, update, updateBtn);
  return bar;
}

/** H:MM:SS left until `until`, or null when the time is unknown or past. Digits only, so it needs no translation. */
function remaining(until: string | undefined, now: number): string | null {
  const at = until === undefined ? Number.NaN : Date.parse(until);
  if (!Number.isFinite(at)) return null;
  const s = Math.max(0, Math.round((at - now) / 1000));
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

/** The reset time: the hour for one within a day, the date and the hour for a later one (a weekly reset). Never a made-up value. */
export function formatWhen(until: string | undefined, now: number): string | null {
  const at = until === undefined ? Number.NaN : Date.parse(until);
  if (!Number.isFinite(at)) return null;
  const d = new Date(at);
  return at - now > 24 * 60 * 60_000
    ? d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The update chip: found (Download), downloading (the percent), downloaded (Restart); nothing when there is no newer version. */
function paintUpdate(bar: Bar, u: StateMessage['update']): void {
  bar.update.hidden = u === undefined;
  bar.updateAction = u?.phase === 'available' ? 'download' : u?.phase === 'ready' ? 'install' : undefined;
  bar.updateBtn.hidden = bar.updateAction === undefined;
  if (!u) {
    delete bar.update.dataset.i18n;
    delete bar.update.dataset.i18nParams;
    bar.update.textContent = '';
    return;
  }
  if (u.phase === 'available') bindText(bar.update, 'statusbar.update.available', { version: u.version });
  else if (u.phase === 'downloading') bindText(bar.update, 'statusbar.update.downloading', { version: u.version, percent: u.percent ?? 0 });
  else bindText(bar.update, 'statusbar.update.ready', { version: u.version });
  if (bar.updateAction === 'download') setIconButton(bar.updateBtn, 'download', 'statusbar.update.download');
  else if (bar.updateAction === 'install') setIconButton(bar.updateBtn, 'refresh', 'statusbar.update.install');
}

function paintSleep(bar: Bar): void {
  const s = bar.sleepState;
  bar.sleep.hidden = s === undefined;
  bar.resume.hidden = s === undefined;
  bar.resume.disabled = s === undefined || s.phase === 'probing';
  if (!s) {
    // Hidden and empty: a stale key would be retranslated for nothing.
    delete bar.sleep.dataset.i18n;
    delete bar.sleep.dataset.i18nParams;
    bar.sleep.textContent = '';
    return;
  }
  const now = Date.now();
  const time = formatWhen(s.until, now) ?? t('common.notAvailable');
  const left = remaining(s.until, now) ?? t('common.notAvailable');
  if (s.phase === 'probing') bindText(bar.sleep, 'statusbar.sleepProbing');
  else if (s.weekly) bindText(bar.sleep, 'statusbar.sleepWeekly', { time });
  else bindText(bar.sleep, 'statusbar.sleep', { time, remaining: left });
}

/** Bottom bar (SPEC 5.7): project budget (no source yet: n/a), subscription quota, the sleep for a usage limit, agents. */
export function renderStatusBar(el: HTMLElement, state: StateMessage): void {
  const bar = bars.get(el) ?? build(el);
  bars.set(el, bar);
  bar.bypass.hidden = !state.settings?.bypassPermissions;
  const newest = state.stateProblems?.[state.stateProblems.length - 1];
  bar.problem.hidden = newest === undefined;
  if (newest) setIconButton(bar.problem, 'warning', 'statusbar.stateProblem', { file: newest.file, movedTo: newest.movedTo });
  // The quota percent is absent when unknown: n/a, never zero.
  bar.quota.replaceChildren();
  if (state.quota && Number.isFinite(state.quota.percent)) {
    const q = span();
    bindText(q, 'statusbar.quota', { percent: Math.round(state.quota.percent) });
    bar.quota.append(q, gap());
  } else {
    const l = span(); bindText(l, 'statusbar.quotaLabel');
    const v = span(); bindText(v, 'common.notAvailable');
    bar.quota.append(l, gap(), v, gap());
  }
  paintUpdate(bar, state.update);
  bar.sleepState = state.sleep && state.sleep.phase !== 'awake' ? state.sleep : undefined;
  paintSleep(bar);
  if (bar.sleepState && bar.timer === undefined) bar.timer = setInterval(() => paintSleep(bar), 1000);
  else if (!bar.sleepState && bar.timer !== undefined) { clearInterval(bar.timer); bar.timer = undefined; }
  // The counter uses the limit in force now (the quota may have cut it); without it the plain count is shown.
  if (state.limits) bindText(bar.agents, 'statusbar.agentsOf', { active: state.limits.active, max: state.limits.max });
  else bindText(bar.agents, 'statusbar.agents', { count: runningAgents(state.main, state.agents) });
  bindText(bar.suspended, 'statusbar.suspended', { count: visibleAgents(state.agents).filter((a) => a.state === 'suspended').length });
  bar.latest = state;
  const archived = archivedAgents(state.agents).length;
  // Reachable also at zero while something can be archived: the list holds the "Archive all finished" button.
  bar.archived.hidden = archived === 0 && archivableAgents(state.agents).length === 0;
  if (!bar.archived.hidden) { setIconButton(bar.archived, 'archive', 'statusbar.archived', { count: archived }); setQueueBadge(bar.archived, archived); }
  refreshArchiveDialog(state);
}
