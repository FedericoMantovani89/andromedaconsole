// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { applyBudget, applyTicket, STATE_KEYS } from '../src/ui/chips';
import { createDecisionEntry, createBudgetEntry, createWeeklyEntry } from '../src/ui/console-items';
import { createQueueDrawer } from '../src/ui/queue';
import { renderStatusBar } from '../src/ui/statusbar';
import type { QueueItem, SessionInfo, StateMessage } from '../src/shared/protocol';

const chip = () => document.createElement('span');
const params = (el: HTMLElement) => JSON.parse(el.dataset.i18nParams ?? '{}');

describe('budget chip', () => {
  it.each([['ok', 62], ['alert', 82], ['limit', 100], ['stopped', 104]] as const)('step %s shows the percent and the class', (step, percent) => {
    const el = chip();
    applyBudget(el, { state: 'working', budget: { used: percent * 10, limit: 1000, step } });
    expect(el.hidden).toBe(false);
    expect(el.dataset.i18n).toBe('panel.budget');
    expect(params(el)).toEqual({ percent });
    expect(el.className).toBe(`panel-budget ${step}`);
  });
  it('is hidden when the agent has no budget', () => {
    const el = chip();
    applyBudget(el, { state: 'idle' });
    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe('');
    applyBudget(el, { state: 'working' }); // working without a ticket: still nothing
    expect(el.hidden).toBe(true);
  });
  it('shows n/a for a working agent with a ticket and no budget, then hides again', () => {
    const el = chip();
    const ticket = { status: 'in_progress', round: 0, maxRounds: 3 };
    applyBudget(el, { state: 'working', ticket });
    expect(el.hidden).toBe(false);
    expect(el.dataset.i18n).toBe('panel.budgetNotAvailable');
    expect(el.className).toBe('panel-budget');
    applyBudget(el, { state: 'idle', ticket });
    expect(el.hidden).toBe(true);
    expect(el.dataset.i18n).toBeUndefined();
  });
});

describe('budget chip with unusable numbers', () => {
  it.each([[0], [-5], [Number.NaN], [Number.POSITIVE_INFINITY]])('limit %s counts as absent', (limit) => {
    const el = chip();
    applyBudget(el, { state: 'idle', budget: { used: 10, limit, step: 'ok' } });
    expect(el.hidden).toBe(true);
    expect(el.textContent).not.toMatch(/NaN|Infinity/);
    applyBudget(el, { state: 'working', ticket: { status: 'in_progress', round: 0, maxRounds: 3 }, budget: { used: 10, limit, step: 'ok' } });
    expect(el.dataset.i18n).toBe('panel.budgetNotAvailable');
  });
  it('a non-finite used counts as absent', () => {
    const el = chip();
    applyBudget(el, { state: 'idle', budget: { used: Number.NaN, limit: 100, step: 'ok' } });
    expect(el.hidden).toBe(true);
    applyBudget(el, { state: 'idle', budget: {} as never });
    expect(el.hidden).toBe(true);
  });
  it('used above the limit stays literal', () => {
    const el = chip();
    applyBudget(el, { state: 'idle', budget: { used: 1500, limit: 1000, step: 'stopped' } });
    expect(params(el)).toEqual({ percent: 150 });
  });
});

describe('ticket and state chips', () => {
  it.each(['suspended_budget', 'blocked', 'recovering', 'suspended_limit'])('ticket status %s has a chip', (status) => {
    const el = chip();
    applyTicket(el, { status, round: 0, maxRounds: 3 });
    expect(el.hidden).toBe(false);
    expect(el.dataset.i18n).toBe(`ticket.status.${status}`);
    expect(el.className).toBe(`panel-ticket ${status}`);
  });
  it('the suspended state has a key', () => expect(STATE_KEYS.suspended).toBe('state.suspended'));
});

describe('budget queue entry', () => {
  const item: QueueItem = {
    id: 'q1', from: 'console', kind: 'decision', text: '', createdAt: '2026-10-05T00:00:00Z',
    options: ['raise', 'close', 'recover'],
    payload: { kind: 'budget_stop', ticket: 'job-1', used: 1200, limit: 1000 },
  };
  it('has three buttons that answer raise, close and recover', () => {
    const sent: string[] = [];
    const { el } = createBudgetEntry(item, (a) => sent.push(a));
    const buttons = [...el.querySelectorAll('button')];
    expect(buttons.map((b) => b.dataset.answer)).toEqual(['raise', 'close', 'recover']);
    expect(buttons.map((b) => b.dataset.i18nTitle)).toEqual(['queue.budget.raise', 'queue.budget.close', 'queue.budget.recover']);
    buttons.forEach((b) => b.click());
    expect(sent).toEqual(['raise', 'close', 'recover']);
    const title = el.querySelector<HTMLElement>('.queue-text')!;
    expect(title.dataset.i18n).toBe('queue.budget.title');
    expect(params(title)).toEqual({ agent: 'job-1', used: 1200, limit: 1000 });
  });
  it('the queue routes budget_stop to the budget entry and other decisions to the generic one', async () => {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => { calls.push({ url, body: init.body }); return { status: 200, json: async () => ({}) }; }));
    const root = document.createElement('div');
    const drawer = createQueueDrawer(root);
    const other: QueueItem = { ...item, id: 'q2', payload: { reason: 'author_gone', ticket: 'job-2' }, options: ['send_back', 'leave'] };
    drawer.update([item, other]);
    const budget = root.querySelector<HTMLElement>('[data-id="q1"]')!;
    const generic = root.querySelector<HTMLElement>('[data-id="q2"]')!;
    expect(budget.className).toContain('queue-budget');
    expect(generic.className).toContain('queue-decision');
    expect(generic.className).not.toContain('queue-budget');
    expect([...generic.querySelectorAll('button')].map((b) => b.dataset.answer)).toEqual(['send_back', 'leave']);
    budget.querySelectorAll('button').forEach((b) => b.click());
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map((c) => [c.url, JSON.parse(c.body).answer])).toEqual([
      ['/api/queue/q1/answer', 'raise'], ['/api/queue/q1/answer', 'close'], ['/api/queue/q1/answer', 'recover'],
    ]);
    vi.unstubAllGlobals();
  });
});

describe('recovery raise decision', () => {
  it('says why and offers approve and decline, with the diagnosis as a note', () => {
    const item: QueueItem = {
      id: 'q3', from: 'console', kind: 'decision', text: '', createdAt: '2026-10-05T00:00:00Z', options: ['approve', 'decline'],
      payload: { ticket: 'job-1', reason: 'recovery_raise', notes: [{ severity: 'diagnosis', text: 'the work is bigger than the budget' }] },
    };
    const sent: string[] = [];
    const { el } = createDecisionEntry(item, (a) => sent.push(a));
    expect(el.querySelector<HTMLElement>('.queue-why')!.dataset.i18n).toBe('queue.decision.reason.recovery_raise');
    const buttons = [...el.querySelectorAll('button')];
    expect(buttons.map((b) => b.dataset.answer)).toEqual(['approve', 'decline']);
    expect(buttons.map((b) => b.dataset.i18nTitle)).toEqual(['queue.decision.approveRaise', 'queue.decision.decline']);
    buttons.forEach((b) => b.click());
    expect(sent).toEqual(['approve', 'decline']);
    expect(el.textContent).toContain('the work is bigger than the budget');
  });
});

describe('status bar', () => {
  const info = (slug: string, state: SessionInfo['state']): SessionInfo => ({ slug, state, status: 'running', role: 'agent', profile: 'dev' } as SessionInfo);
  it('counts the suspended agents', () => {
    const el = document.createElement('div');
    const state = { main: info('main', 'idle'), agents: [info('a', 'suspended'), info('b', 'working'), info('c', 'suspended')] } as unknown as StateMessage;
    renderStatusBar(el, state);
    const span = [...el.querySelectorAll<HTMLElement>('[data-i18n]')].find((e) => e.dataset.i18n === 'statusbar.suspended')!;
    expect(params(span)).toEqual({ count: 2 });
  });
});

describe('weekly limit entry', () => {
  const item: QueueItem = {
    id: 'w1', from: 'console', kind: 'decision', text: '', createdAt: '2026-10-05T00:00:00Z', options: ['ok'],
    payload: { kind: 'weekly_limit', resetsAt: '2026-10-09T08:00:00Z' },
  };
  it('lists the choices and has one button that answers ok; the date of the reset is shown', () => {
    const sent: string[] = [];
    const { el } = createWeeklyEntry(item, (a) => sent.push(a));
    expect(el.querySelector<HTMLElement>('.queue-text')!.dataset.i18n).toBe('queue.weekly.title');
    expect(typeof params(el.querySelector<HTMLElement>('.queue-text')!).time).toBe('string');
    expect(el.querySelector<HTMLElement>('.queue-why')!.dataset.i18n).toBe('queue.weekly.choices');
    const buttons = [...el.querySelectorAll('button')];
    expect(buttons.map((b) => b.dataset.answer)).toEqual(['ok']);
    buttons[0]!.click();
    expect(sent).toEqual(['ok']);
  });
  it('without a reset time it says so, never a made-up date', () => {
    const { el } = createWeeklyEntry({ ...item, payload: { kind: 'weekly_limit' } }, () => {});
    expect(el.querySelector<HTMLElement>('.queue-text')!.dataset.i18n).toBe('queue.weekly.titleUnknown');
  });
  it('the queue routes weekly_limit to its own entry', () => {
    const root = document.createElement('div');
    createQueueDrawer(root).update([item]);
    expect(root.querySelector<HTMLElement>('[data-id="w1"]')!.className).toContain('queue-weekly');
  });
});

describe('recovery change_model decision', () => {
  it('says why and offers restart (same model) and leave', () => {
    const item: QueueItem = {
      id: 'q4', from: 'console', kind: 'decision', text: '', createdAt: '2026-10-05T00:00:00Z', options: ['restart', 'leave'],
      payload: { ticket: 'job-1', reason: 'recovery_change_model', notes: [{ severity: 'diagnosis', text: 'too subtle for this model' }] },
    };
    const { el } = createDecisionEntry(item, () => {});
    expect(el.querySelector<HTMLElement>('.queue-why')!.dataset.i18n).toBe('queue.decision.reason.recovery_change_model');
    const buttons = [...el.querySelectorAll('button')];
    expect(buttons.map((b) => b.dataset.answer)).toEqual(['restart', 'leave']);
    expect(buttons.map((b) => b.dataset.i18nTitle)).toEqual(['queue.decision.restart', 'queue.decision.leave']);
    expect(el.textContent).toContain('too subtle for this model');
  });
});
