// @vitest-environment jsdom
// The audit verdict chip of a ticket, its report dialog, and the queue decision the audit gate opens.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/i18n-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/i18n-client')>()),
  k: (s: string) => s,
  setTitle: (el: HTMLElement, key: string) => { el.title = key; },
  t: (key: string, params?: Record<string, string | number>) => (key.startsWith('error.') ? `E(${key})` : params ? `${key} ${JSON.stringify(params)}` : key),
  bindText: (el: HTMLElement, key: string, params?: Record<string, string | number>) => { el.dataset.i18n = key; el.dataset.i18nParams = JSON.stringify(params ?? {}); el.textContent = key; },
}));

import { applyAudit } from '../src/ui/audit-card';
import { createDecisionEntry } from '../src/ui/console-items';
import type { QueueItem } from '../src/shared/protocol';

let calls: { url: string; method: string }[] = [];
let audit: unknown;
let postStatus = 200;
beforeEach(() => {
  calls = [];
  postStatus = 200;
  audit = {
    verdict: 'split_first', level: 'metrics', profile: 'default', modelRan: true, notRun: [],
    metrics: [{ id: 'diff_lines', value: 412, limit: 250, over: true, where: 'src/a.ts' }, { id: 'file_lines', value: 'n/a', limit: 0, over: false }],
    layerTwo: [{ id: 'lint', ran: false, reason: 'no_command' }],
    notes: [{ source: 'model', severity: 'high', where: 'src/a.ts:41', problem: '<b>duplicates</b> format()', fix: 'call it' }],
  };
  document.body.innerHTML = '<div id="overlay" hidden></div>';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (init?.method === 'POST') return json(postStatus, postStatus === 200 ? { auditor: 'audit-fix' } : { code: 'audit.level_off' });
    return json(200, { audit });
  }));
});
afterEach(() => vi.unstubAllGlobals());
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('the audit chip', () => {
  it('is hidden until the ticket has an audit, then shows the verdict with its colour class', () => {
    const chip = document.createElement('span');
    applyAudit(chip, 'fix', undefined);
    expect(chip.hidden).toBe(true);
    applyAudit(chip, 'fix', { verdict: 'split_first', level: 'metrics', modelRan: false });
    expect(chip.hidden).toBe(false);
    expect(chip.className).toBe('panel-audit split_first');
    expect(chip.dataset.i18n).toBe('audit.verdict.split_first');
    applyAudit(chip, 'fix', { verdict: 'ready', level: 'full', modelRan: true });
    expect(chip.className).toBe('panel-audit ready');
    expect(chip.title).toContain('audit.chip.full');
    applyAudit(chip, 'fix', undefined);
    expect(chip.hidden).toBe(true);
  });

  it('opens the report on a click, once however often the state is applied, without taking the focus', async () => {
    const chip = document.createElement('span');
    for (let i = 0; i < 3; i++) applyAudit(chip, 'fix', { verdict: 'split_first', level: 'metrics', modelRan: true });
    expect(chip.dispatchEvent(new MouseEvent('mousedown', { cancelable: true, bubbles: true }))).toBe(false);
    chip.click();
    await flush();
    expect(calls).toEqual([{ url: '/api/tickets/fix/audit', method: 'GET' }]);
    const dialog = document.querySelector('.audit-dialog')!;
    expect(dialog.textContent).toContain('audit.metric.diff_lines: 412 / 250');
    expect(dialog.textContent).toContain('audit.over');
    expect(dialog.textContent).toContain('audit.metric.file_lines: common.notAvailable / audit.limit.off'); // a missing value is n/a, never 0
    expect(dialog.textContent).toContain('audit.layer.lint: audit.notRun');
    expect(dialog.textContent).toContain('[high] src/a.ts:41 — <b>duplicates</b> format() -> call it');
    expect(dialog.querySelector('b')).toBeNull(); // the model's words are text, never markup
  });

  it('says n/a when there is no audit, and the button starts the model part and shows a refusal by its code', async () => {
    audit = null;
    const chip = document.createElement('span');
    applyAudit(chip, 'fix', { verdict: 'ready', level: 'metrics', modelRan: false });
    chip.click();
    await flush();
    const dialog = document.querySelector('.audit-dialog')!;
    expect(dialog.textContent).toContain('common.notAvailable');
    const run = dialog.querySelector<HTMLButtonElement>('button[name="runAudit"]')!;
    run.click();
    await flush();
    expect(calls.at(-1)).toEqual({ url: '/api/tickets/fix/audit', method: 'POST' });
    expect(dialog.querySelector('[data-i18n="audit.run.started"]')).not.toBeNull();
    postStatus = 409;
    run.click();
    await flush();
    expect(dialog.querySelector('.form-error')!.textContent).toContain('audit.level_off');
    expect(run.disabled).toBe(false);
  });
});

describe('the report dialog while the auditor works', () => {
  it('looks again every few seconds after the model audit was started, and stops when it is done or the dialog is closed', async () => {
    vi.useFakeTimers();
    try {
      audit = { verdict: 'ready', level: 'full', profile: 'default', modelRan: false, notRun: [], metrics: [], layerTwo: [], notes: [] };
      const chip = document.createElement('span');
      applyAudit(chip, 'fix', { verdict: 'ready', level: 'full', modelRan: false });
      chip.click();
      await vi.advanceTimersByTimeAsync(0);
      const dialog = document.querySelector('.audit-dialog')!;
      dialog.querySelector<HTMLButtonElement>('button[name="runAudit"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(dialog.textContent).not.toContain('duplicates');
      audit = { verdict: 'needs_changes', level: 'full', profile: 'default', modelRan: true, notRun: [], metrics: [], layerTwo: [], notes: [{ source: 'model', severity: 'high', where: 'a.ts:1', problem: 'duplicates format()', fix: 'reuse it' }] };
      await vi.advanceTimersByTimeAsync(6000);
      expect(dialog.textContent).toContain('[high] a.ts:1 — duplicates format() -> reuse it');
      const gets = calls.filter((c) => c.method === 'GET').length;
      await vi.advanceTimersByTimeAsync(20_000); // done: no more asking
      expect(calls.filter((c) => c.method === 'GET').length).toBe(gets);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops asking once the dialog is gone', async () => {
    vi.useFakeTimers();
    try {
      const chip = document.createElement('span');
      applyAudit(chip, 'fix', { verdict: 'ready', level: 'full', modelRan: false });
      chip.click();
      await vi.advanceTimersByTimeAsync(0);
      document.querySelector<HTMLButtonElement>('button[name="runAudit"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      document.getElementById('overlay')!.replaceChildren(); // closed
      const gets = calls.filter((c) => c.method === 'GET').length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls.filter((c) => c.method === 'GET').length).toBe(gets);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the queue decision of the audit gate', () => {
  const item: QueueItem = {
    id: 'q1', from: 'console', kind: 'decision', text: 'x', createdAt: '2026-11-13T10:00:00Z',
    options: ['review_anyway', 'send_back', 'leave'],
    payload: { ticket: 'fix', reason: 'audit_limits', over: [{ id: 'diff_lines', value: 412, limit: 250 }] },
  };

  it('says why, lists the limits that are over, and offers the three answers in this order with their own icons', () => {
    const sent: string[] = [];
    const { el } = createDecisionEntry(item, (a) => sent.push(a));
    expect(el.querySelector('.queue-why')!.getAttribute('data-i18n')).toBe('queue.decision.reason.audit_limits');
    expect(el.textContent).toContain('audit.metric.diff_lines: 412 / 250');
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('button[data-answer]')];
    expect(buttons.map((b) => b.dataset.answer)).toEqual(['review_anyway', 'send_back', 'leave']);
    expect(buttons.map((b) => b.querySelector('svg')!.dataset.icon)).toEqual(['play', 'undo', 'minus']);
    buttons[0]!.click();
    expect(sent).toEqual(['review_anyway']);
  });
});
