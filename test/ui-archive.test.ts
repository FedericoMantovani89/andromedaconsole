// @vitest-environment jsdom
// The archive in the browser: the chip in the status bar, the list with its buttons, and the counters that ignore archived agents.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { path: string; method?: string }[] = [];
vi.mock('../src/ui/api', () => ({
  api: vi.fn(async (path: string, o?: { method?: string }) => { calls.push({ path, method: o?.method }); return { status: 200, body: { ok: true } }; }),
}));

import { openArchiveDialog, refreshArchiveDialog, visibleAgents } from '../src/ui/archive';
import { renderStatusBar } from '../src/ui/statusbar';
import { runningAgents } from '../src/shared/stats';
import type { SessionInfo, StateMessage } from '../src/shared/protocol';

const info = (slug: string, o: Partial<SessionInfo> = {}): SessionInfo => ({ slug, state: 'idle', status: 'exited', role: 'agent', profile: 'developer', ...o });
const make = (agents: SessionInfo[]): StateMessage => ({ main: info('main', { role: 'main', status: 'running' }), agents } as unknown as StateMessage);
const byKey = (root: HTMLElement, key: string): HTMLElement | undefined => [...root.querySelectorAll<HTMLElement>('[data-i18n]')].find((e) => e.dataset.i18n === key);
const params = (el: Element) => JSON.parse((el as HTMLElement).dataset.i18nTitleParams ?? (el as HTMLElement).dataset.i18nParams ?? '{}'); // an icon button keeps its words in the tooltip

const ended = '2026-10-10T08:30:00.000Z';
const two = [
  info('be-orders', { state: 'finished', archived: true, archivedAt: ended, ticket: { status: 'merged', round: 0, maxRounds: 2 } }),
  info('fe-cart', { archived: true, archivedAt: '2026-10-10T09:00:00.000Z', ticket: { status: 'delivered', round: 0, maxRounds: 2 } }),
];

beforeEach(() => { calls.length = 0; document.body.innerHTML = '<div id="overlay" hidden></div>'; });
afterEach(() => { document.getElementById('overlay')!.replaceChildren(); });

describe('visibleAgents', () => {
  it('keeps the agents that are not archived and leaves the full list alone', () => {
    const all = [info('a'), ...two];
    expect(visibleAgents(all).map((a) => a.slug)).toEqual(['a']);
    expect(all).toHaveLength(3);
  });
});

describe('status bar chip', () => {
  it('is hidden at zero and shows Archived (N) otherwise', () => {
    const el = document.createElement('div');
    renderStatusBar(el, make([info('a')]));
    const chip = el.querySelector<HTMLButtonElement>('.statusbar-archived')!;
    expect(chip.hidden).toBe(true);
    renderStatusBar(el, make([info('a'), ...two]));
    expect(chip.hidden).toBe(false);
    expect(chip.dataset.i18nTitle).toBe('statusbar.archived');
    expect(params(chip)).toEqual({ count: 2 });
    renderStatusBar(el, make([info('a')]));
    expect(chip.hidden).toBe(true);
    expect(el.querySelector('.statusbar-archived')).toBe(chip); // the same node, never rebuilt
  });
  it('the agents and suspended counters ignore archived agents', () => {
    const el = document.createElement('div');
    renderStatusBar(el, make([info('a', { status: 'running', state: 'working' }), info('z', { status: 'running', archived: true }), info('s', { state: 'suspended', archived: true }), info('t', { state: 'suspended' })]));
    expect(params(byKey(el, 'statusbar.agents')!)).toEqual({ count: 1 });
    expect(params(byKey(el, 'statusbar.suspended')!)).toEqual({ count: 1 });
    expect(runningAgents(make([]).main, [info('x', { status: 'running', archived: true })])).toBe(0);
  });
  it('a click on the chip opens the list', () => {
    const el = document.createElement('div');
    renderStatusBar(el, make(two));
    el.querySelector<HTMLButtonElement>('.statusbar-archived')!.click();
    expect(document.querySelectorAll('#overlay .archive-row')).toHaveLength(2);
  });
});

describe('archive list', () => {
  it('shows name, profile, ticket status and when it ended, one row per archived agent', () => {
    openArchiveDialog(() => make(two));
    const rows = [...document.querySelectorAll<HTMLElement>('#overlay .archive-row')];
    expect(rows.map((r) => r.querySelector('.archive-name')!.textContent)).toEqual(['be-orders', 'fe-cart']);
    expect(rows[0]!.querySelector('.archive-profile')!.textContent).toBe('developer');
    expect(rows[0]!.querySelector<HTMLElement>('.archive-ticket')!.dataset.i18n).toBe('ticket.status.merged');
    expect(rows[1]!.querySelector<HTMLElement>('.archive-ticket')!.dataset.i18n).toBe('ticket.status.delivered');
    expect(rows[0]!.querySelector('.archive-when')!.textContent).not.toBe('');
    expect(document.querySelector('#overlay .dialog')!.hasAttribute('data-escape')).toBe(true);
  });
  it('Unarchive posts for that agent only; Unarchive all posts for every archived one', async () => {
    openArchiveDialog(() => make(two));
    const rows = [...document.querySelectorAll<HTMLElement>('#overlay .archive-row')];
    rows[1]!.querySelector<HTMLButtonElement>('button')!.click();
    expect(calls).toEqual([{ path: '/api/agents/fe-cart/unarchive', method: 'POST' }]);
    calls.length = 0;
    document.querySelector<HTMLButtonElement>('#overlay .archive-all')!.click();
    await Promise.resolve();
    expect(calls.map((c) => c.path).sort()).toEqual(['/api/agents/be-orders/unarchive', '/api/agents/fe-cart/unarchive']);
  });
  it('follows the state while open: a row goes when its agent is restored, and the empty list says so', () => {
    openArchiveDialog(() => make(two));
    refreshArchiveDialog(make([two[1]!]));
    expect(document.querySelectorAll('#overlay .archive-row')).toHaveLength(1);
    refreshArchiveDialog(make([]));
    expect(document.querySelectorAll('#overlay .archive-row')).toHaveLength(0);
    expect(byKey(document.getElementById('overlay')!, 'archive.empty')).toBeDefined();
    expect(document.querySelector<HTMLButtonElement>('#overlay .archive-all')!.disabled).toBe(true);
  });
});

describe('archive all finished', () => {
  const finished = [info('r1', { state: 'finished' }), info('d1', { ticket: { status: 'delivered', round: 0, maxRounds: 2 } }), info('w', { state: 'working' }), info('s', { state: 'finished', ticket: { status: 'blocked', round: 0, maxRounds: 2 } })];
  it('the chip shows Archived (0) when nothing is archived but something can be', () => {
    const el = document.createElement('div');
    renderStatusBar(el, make(finished));
    const chip = el.querySelector<HTMLButtonElement>('.statusbar-archived')!;
    expect(chip.hidden).toBe(false);
    expect(params(chip)).toEqual({ count: 0 });
  });
  it('the button is disabled when nothing can be archived', () => {
    openArchiveDialog(() => make([info('w', { state: 'working' })]));
    expect(document.querySelector<HTMLButtonElement>('#overlay .archive-finished')!.disabled).toBe(true);
  });
  it('asks for confirmation with the count, posts once on confirm, and does nothing on cancel', async () => {
    openArchiveDialog(() => make(finished));
    const btn = document.querySelector<HTMLButtonElement>('#overlay .archive-finished')!;
    expect(btn.disabled).toBe(false);
    btn.click();
    const line = document.querySelector<HTMLElement>('#overlay .archive-confirm')!;
    expect(line.querySelector<HTMLElement>('[data-i18n="archive.confirmFinished"]') ?? line).toBeTruthy();
    expect(params(byKey(line, 'archive.confirmFinished')!)).toEqual({ count: 2 });
    expect(calls).toEqual([]);
    line.querySelector<HTMLButtonElement>('.archive-confirm-no')!.click();
    expect(document.querySelector('#overlay .archive-confirm')).toBeNull();
    expect(calls).toEqual([]);
    btn.click();
    document.querySelector<HTMLButtonElement>('#overlay .archive-confirm-yes')!.click();
    await Promise.resolve();
    expect(calls).toEqual([{ path: '/api/agents/archive-finished', method: 'POST' }]);
  });
});
