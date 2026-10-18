import { describe, it, expect } from 'vitest';
import { createTranslator } from '../src/shared/i18n';
import { loadBundles } from '../src/server/i18n-bundles';
import { DEFAULT_NOTIFICATIONS, type NotificationsConfig, type NotifyMessage } from '../src/shared/notify';
import { NotificationService, inQuietHours, type NotifyClock, type NotifyItem } from '../src/server/notify/service';
import { Presence } from '../src/server/notify/presence';
import type { Notifier, NotifierMessage } from '../src/server/notify/notifier';

const en = loadBundles().get('en')!;
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function setup(over: Partial<NotificationsConfig> = {}, o: { available?: boolean; notify?: (n: NotifierMessage) => Promise<void> } = {}) {
  let now = Date.parse('2026-10-05T12:00:00Z');
  let minutes = 12 * 60;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: NotifyClock = {
    now: () => now,
    minutesOfDay: () => minutes,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (h) => { timers.delete(h as number); },
  };
  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
      await flush();
    }
    now = target;
  };
  const sent: NotifierMessage[] = [];
  const notifier: Notifier = {
    available: async () => o.available ?? true,
    notify: o.notify ?? (async (n) => { sent.push(n); }),
  };
  const pending = new Set<string>();
  const browser: NotifyMessage[] = [];
  const presence = new Presence(() => now);
  const config: NotificationsConfig = { ...structuredClone(DEFAULT_NOTIFICATIONS), ...over };
  const svc = new NotificationService({
    config: () => config, notifier, presence, clock,
    translate: () => createTranslator({ lang: 'en', messages: en }),
    clickUrl: (id) => `http://127.0.0.1:1/?token=t&project=p${id ? `#queue=${id}` : ''}`,
    isPending: (id) => pending.has(id),
    pushBrowser: (m) => browser.push(m),
  });
  const item = (id: string, over: Partial<NotifyItem> = {}): NotifyItem => {
    pending.add(id);
    return { id, from: 'fix-login', kind: 'question', text: 'Which color?', ...over };
  };
  return { svc, config, sent, browser, presence, pending, advance, item, setMinutes: (m: number) => { minutes = m; }, tick: (ms: number) => { now += ms; }, timers };
}

describe('NotificationService: what notifies', () => {
  it('one event shows its own text after the group window, with a click address to the item', async () => {
    const s = setup();
    s.svc.onItem(s.item('q1'));
    expect(s.sent).toHaveLength(0); // buffered
    await s.advance(5000);
    expect(s.sent).toEqual([{ title: 'Question for you', message: 'fix-login: Which color?', open: 'http://127.0.0.1:1/?token=t&project=p#queue=q1', sound: true }]);
  });
  it('a release confirmation from the console notifies once, titled for the release', async () => {
    const s = setup();
    s.svc.onItem(s.item('c1', { from: '@console', kind: 'confirm', text: 'Release project "p" (2 tickets) to origin/main?' }));
    await s.advance(5000);
    expect(s.sent).toEqual([{ title: 'Release to approve', message: 'Release project "p" (2 tickets) to origin/main?', open: 'http://127.0.0.1:1/?token=t&project=p#queue=c1', sound: true }]);
  });
  it('a long text is shortened to 120 characters; console items show no sender', async () => {
    const s = setup();
    s.svc.onItem(s.item('q1', { from: '@console', kind: 'decision', text: 'x'.repeat(300) }));
    await s.advance(5000);
    expect(s.sent[0]!.message).toHaveLength(120);
    expect(s.sent[0]!.message.endsWith('…')).toBe(true);
    expect(s.sent[0]!.message.startsWith('x')).toBe(true);
    expect(s.sent[0]!.title).toBe('Decision needed');
  });
  it('a disabled type does not notify, the others still do', async () => {
    const s = setup();
    s.config.enabled.permission = false;
    s.svc.onItem(s.item('p1', { kind: 'permission' }));
    expect(s.timers.size).toBe(0);
    s.svc.onItem(s.item('q1'));
    await s.advance(5000);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.title).toBe('Question for you');
  });
  it('the sound switch is passed on', async () => {
    const s = setup({ sound: false });
    s.svc.onItem(s.item('q1'));
    await s.advance(5000);
    expect(s.sent[0]!.sound).toBe(false);
  });
  it('the group window is read from the configuration on each event', async () => {
    const s = setup({ groupSeconds: 2 });
    s.svc.onItem(s.item('q1'));
    await s.advance(1999);
    expect(s.sent).toHaveLength(0);
    await s.advance(1);
    expect(s.sent).toHaveLength(1);
  });
});

describe('NotificationService: grouping', () => {
  it('events within the window become one toast that says how many', async () => {
    const s = setup();
    s.svc.onItem(s.item('q1'));
    await s.advance(1000);
    s.svc.onItem(s.item('q2', { from: 'other' }));
    s.svc.onItem(s.item('q3', { kind: 'permission' }));
    await s.advance(4000);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ title: 'Waiting for you', message: '3 things are waiting' });
    expect(s.sent[0]!.open).toContain('#queue=q1');
    await s.advance(20000);
    expect(s.sent).toHaveLength(1);
  });
  it('an event after the window starts a new toast', async () => {
    const s = setup();
    s.svc.onItem(s.item('q1'));
    await s.advance(5000);
    s.svc.onItem(s.item('q2'));
    await s.advance(5000);
    expect(s.sent).toHaveLength(2);
  });
  it('an item answered while it waited is dropped from the group', async () => {
    const s = setup();
    s.svc.onItem(s.item('q1', { text: 'first' }));
    s.svc.onItem(s.item('q2', { text: 'second' }));
    s.pending.delete('q1');
    await s.advance(5000);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.message).toBe('fix-login: second');
  });
  it('nothing is sent when every item was answered', async () => {
    const s = setup();
    s.svc.onItem(s.item('q1'));
    s.pending.delete('q1');
    await s.advance(5000);
    expect(s.sent).toHaveLength(0);
  });
  it('close drops what is buffered', async () => {
    const s = setup();
    s.svc.onItem(s.item('q1'));
    s.svc.close();
    await s.advance(10000);
    expect(s.sent).toHaveLength(0);
    s.svc.onItem(s.item('q2'));
    expect(s.timers.size).toBe(0);
  });
});

describe('quiet hours', () => {
  const q = (from: string, to: string) => ({ enabled: true, from, to });
  it.each([
    ['same day, inside', q('13:00', '15:00'), 14 * 60, true],
    ['same day, before', q('13:00', '15:00'), 12 * 60, false],
    ['same day, the end is excluded', q('13:00', '15:00'), 15 * 60, false],
    ['same day, the start is included', q('13:00', '15:00'), 13 * 60, true],
    ['across midnight, late evening', q('22:00', '07:00'), 23 * 60, true],
    ['across midnight, after midnight', q('22:00', '07:00'), 3 * 60, true],
    ['across midnight, daytime', q('22:00', '07:00'), 12 * 60, false],
    ['across midnight, the end is excluded', q('22:00', '07:00'), 7 * 60, false],
    ['from equal to is an empty window', q('08:00', '08:00'), 8 * 60, false],
    ['disabled', { enabled: false, from: '00:00', to: '23:59' }, 12 * 60, false],
  ] as const)('%s', (_n, quiet, minutes, expected) => {
    expect(inQuietHours(quiet, minutes)).toBe(expected);
  });

  it('events inside quiet hours are not announced, also across midnight', async () => {
    const s = setup({ quietHours: { enabled: true, from: '22:00', to: '07:00' } });
    s.setMinutes(23 * 60);
    s.svc.onItem(s.item('q1'));
    s.setMinutes(3 * 60);
    s.svc.onItem(s.item('q2'));
    expect(s.timers.size).toBe(0);
    await s.advance(10000);
    expect(s.sent).toHaveLength(0);
    s.setMinutes(12 * 60);
    s.svc.onItem(s.item('q3'));
    await s.advance(5000);
    expect(s.sent).toHaveLength(1);
  });
});

describe('presence', () => {
  const here = { focused: true, visible: true, drawerOpen: false, active: 'shop-api' };
  it('nothing for an item while the console is in front with the queue open', async () => {
    const s = setup();
    s.presence.report({ ...here, drawerOpen: true });
    s.svc.onItem(s.item('q1'));
    await s.advance(10000);
    expect(s.sent).toHaveLength(0);
  });
  it('nothing for an item of the active panel, a toast for another one', async () => {
    const s = setup();
    s.presence.report({ ...here, active: 'fix-login' });
    s.svc.onItem(s.item('q1', { from: 'fix-login' }));
    s.svc.onItem(s.item('q2', { from: 'other', text: 'elsewhere' }));
    await s.advance(5000);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.message).toBe('other: elsewhere');
  });
  it('a console that is not focused or not visible does not suppress', async () => {
    const s = setup();
    s.presence.report({ ...here, drawerOpen: true, focused: false });
    s.svc.onItem(s.item('q1'));
    s.presence.report({ ...here, drawerOpen: true, visible: false });
    s.svc.onItem(s.item('q2'));
    await s.advance(5000);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.title).toBe('Waiting for you');
  });
  it('a report older than 40 seconds counts as no console in front', async () => {
    const s = setup();
    s.presence.report({ ...here, drawerOpen: true });
    s.tick(39_000);
    s.svc.onItem(s.item('q1'));
    await s.advance(5000); // 44 s since the report by the time of the flush, but the event was judged at 39 s
    expect(s.sent).toHaveLength(0);
    s.svc.onItem(s.item('q2')); // 44 s: stale
    await s.advance(5000);
    expect(s.sent).toHaveLength(1);
  });
  it('no report at all never suppresses', async () => {
    const s = setup();
    s.svc.onItem(s.item('q1'));
    await s.advance(5000);
    expect(s.sent).toHaveLength(1);
  });
});

describe('interrupted agents', () => {
  const agent = (state: string, slug = 'fix-login', role = 'agent') => ({ slug, role, state });
  it('an agent that became interrupted is announced once', async () => {
    const s = setup();
    s.svc.onRegistryChange(agent('working'));
    s.svc.onRegistryChange(agent('interrupted'));
    s.svc.onRegistryChange(agent('interrupted'));
    await s.advance(5000);
    expect(s.sent).toEqual([{ title: 'Agent interrupted', message: 'Agent "fix-login" was interrupted', open: 'http://127.0.0.1:1/?token=t&project=p', sound: true }]);
    // it works again and is interrupted again: a new announcement
    s.svc.onRegistryChange(agent('working'));
    s.svc.onRegistryChange(agent('interrupted'));
    await s.advance(5000);
    expect(s.sent).toHaveLength(2);
  });
  it('only agents: the main, reviewers and finished sessions do not notify', async () => {
    const s = setup();
    s.svc.onRegistryChange(agent('interrupted', 'shop-api', 'main'));
    s.svc.onRegistryChange(agent('interrupted', 'rev', 'reviewer'));
    s.svc.onRegistryChange(agent('finished'));
    s.svc.onRegistryChange(undefined);
    await s.advance(5000);
    expect(s.sent).toHaveLength(0);
  });
  it('suppressed only when its own panel is the active one in a focused console', async () => {
    const s = setup();
    s.presence.report({ focused: true, visible: true, drawerOpen: true, active: 'fix-login' });
    s.svc.onRegistryChange(agent('interrupted'));
    s.presence.report({ focused: true, visible: true, drawerOpen: true, active: 'shop-api' }); // an open drawer does not matter here
    s.svc.onRegistryChange(agent('interrupted', 'other'));
    await s.advance(5000);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.message).toContain('other');
  });
  it('the type switch applies', async () => {
    const s = setup();
    s.config.enabled.interrupted = false;
    s.svc.onRegistryChange(agent('interrupted'));
    await s.advance(5000);
    expect(s.sent).toHaveLength(0);
  });
});

describe('the notifier failing or missing', () => {
  it('a notifier that throws does not throw into the pipeline; the browser gets the message and the status says unavailable', async () => {
    const s = setup({}, { notify: async () => { throw new Error('boom'); } });
    s.svc.onItem(s.item('q1'));
    await s.advance(5000);
    expect(s.svc.toast()).toBe('unavailable');
    expect(s.browser).toHaveLength(1);
    expect(s.browser[0]).toMatchObject({ type: 'notify', title: 'Question for you', message: 'fix-login: Which color?' });
    expect(s.browser[0]!.id).toBeTruthy();
  });
  it('a notifier that records lastError counts as failed', async () => {
    const sent: NotifierMessage[] = [];
    const notifier: Notifier = { available: async () => true, notify: async (n) => { sent.push(n); }, lastError: 'no snoretoast' };
    const browser: NotifyMessage[] = [];
    let now = 0;
    const timers: (() => void)[] = [];
    const svc = new NotificationService({
      config: () => DEFAULT_NOTIFICATIONS, notifier, presence: new Presence(() => now),
      clock: { now: () => now, minutesOfDay: () => 600, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => undefined },
      translate: () => createTranslator({ lang: 'en', messages: en }), clickUrl: () => 'u', isPending: () => true, pushBrowser: (m) => browser.push(m),
    });
    now = 1;
    svc.onItem({ id: 'q', from: 'a', kind: 'question', text: 't' });
    timers[0]!();
    await flush();
    expect(svc.toast()).toBe('unavailable');
    expect(browser).toHaveLength(1);
  });
  it('unknown until checked, ok when the notifier is available', async () => {
    const s = setup();
    expect(s.svc.toast()).toBe('unknown');
    await s.svc.checkAvailability();
    expect(s.svc.toast()).toBe('ok');
  });
  it('an unavailable notifier: no send attempt, the browser fallback message instead', async () => {
    const s = setup({}, { available: false });
    await s.svc.checkAvailability();
    expect(s.svc.toast()).toBe('unavailable');
    s.svc.onItem(s.item('q1'));
    await s.advance(5000);
    expect(s.sent).toHaveLength(0);
    expect(s.browser).toHaveLength(1);
  });
});

describe('the test toast', () => {
  it('bypasses presence, grouping, quiet hours and the type switches', async () => {
    const s = setup({ quietHours: { enabled: true, from: '00:00', to: '23:59' } });
    s.config.enabled.question = false;
    s.presence.report({ focused: true, visible: true, drawerOpen: true, active: 'shop-api' });
    expect(await s.svc.test()).toBe(true); // no timer to advance: sent at once
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ title: 'Test notification' });
  });
  it('says false when no toast could be shown', async () => {
    const s = setup({}, { notify: async () => { throw new Error('boom'); } });
    expect(await s.svc.test()).toBe(false);
  });
});
