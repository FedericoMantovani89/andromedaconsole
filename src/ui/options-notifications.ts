import { DEFAULT_NOTIFICATIONS, NOTIFY_TYPES, type NotificationsConfig, type NotifyType } from '../shared/notify';
import type { ApiError, StateMessage } from '../shared/protocol';
import { api } from './api';
import { bindText, k } from './i18n-client';
import { el, checkbox, note } from './dom';
import { errorText } from './new-agent';
import { FIELD_LABELS } from './options';
import { attachClock } from './time-picker';
import { setIconButton } from './icons';

/**
 * The Notifications tab (SPEC 20.4, 22.2): which events notify, quiet hours, sound, grouping, the browser fallback, a test toast and
 * whether a toast can be shown at all. Changes are staged and sent by the dialog's Save through PUT /api/config; they apply to the next event.
 */
export function renderNotificationsTab(container: HTMLElement, state: StateMessage, stage: (key: string, run: (dry: boolean) => Promise<{ status: number; body: unknown }>) => void, /** Tells the dialog the staged value of a setting its Save compares (the restart question). */ mirror?: (path: string, value: unknown) => void): void {
  const config: NotificationsConfig = structuredClone(state.notifications?.config ?? DEFAULT_NOTIFICATIONS);
  container.replaceChildren();
  const box = el('div', 'settings-agents settings-notifications');
  const error = el('div', 'form-error');

  /** Stages one part of the settings for the dialog's Save; a later change of the same setting replaces it. */
  const save = (patch: Record<string, unknown>): void => {
    const path: string[] = [];
    for (let cur: unknown = patch; typeof cur === 'object' && cur !== null; ) {
      const [key, next] = Object.entries(cur)[0] ?? [];
      if (key === undefined) break;
      path.push(key);
      cur = next;
    }
    stage(`notifications:${path.join('.')}`, (dry) => api<ApiError>(dry ? '/api/config?dryRun=1' : '/api/config', { method: 'PUT', body: { notifications: patch } }));
  };

  // One switch per event type.
  const typesTitle = el('p', 'settings-note');
  bindText(typesTitle, 'settings.notifications.types');
  box.append(typesTitle);
  for (const type of NOTIFY_TYPES) {
    const { row, input } = checkbox(`type-${type}`, `settings.notifications.type.${type}`);
    input.checked = config.enabled[type];
    input.addEventListener('change', () => {
      const wanted = input.checked;
      config.enabled[type as NotifyType] = wanted;
      save({ enabled: { [type]: wanted } });
    });
    box.append(row);
  }

  // Quiet hours: a switch and two local times (the window may cross midnight).
  const quietRow = el('label', 'settings-switch');
  const quiet = el('input');
  quiet.type = 'checkbox';
  quiet.name = 'quietEnabled';
  quiet.checked = config.quietHours.enabled;
  const quietText = el('span');
  bindText(quietText, 'settings.notifications.quiet');
  quietRow.append(quiet, quietText);
  quiet.addEventListener('change', () => {
    const wanted = quiet.checked;
    save({ quietHours: { enabled: wanted } });
    syncTimes();
  });
  const times = el('div', 'settings-switch');
  const timeInput = (name: 'from' | 'to', key: string): HTMLElement => {
    const label = el('div'); // not a <label>: a click on the text would press the clock button a second time
    label.className = 'settings-switch';
    const text = el('span');
    bindText(text, key);
    const input = el('input');
    input.name = `quiet-${name}`;
    input.value = config.quietHours[name];
    let saved = input.value;
    input.addEventListener('change', () => {
      const wanted = input.value;
      if (wanted === '') { input.value = saved; return; } // a cleared time is not a time
      save({ quietHours: { [name]: wanted } });
      saved = wanted;
    });
    label.append(text, attachClock(input, key)); // the clock face picks the time; `input` (hidden) keeps it and fires `change`
    return label;
  };
  times.append(timeInput('from', k('settings.notifications.quietFrom')), timeInput('to', k('settings.notifications.quietTo')));
  // The times only matter while quiet hours are on: with the box off the two clocks are disabled (and dimmed).
  function syncTimes(): void {
    times.classList.toggle('is-off', !quiet.checked);
    for (const b of times.querySelectorAll('button')) b.disabled = !quiet.checked;
  }
  syncTimes();

  const soundRow = el('label', 'settings-switch');
  const soundInput = el('input');
  soundInput.type = 'checkbox';
  soundInput.name = 'sound';
  soundInput.checked = config.sound;
  const soundText = el('span');
  bindText(soundText, 'settings.notifications.sound');
  soundRow.append(soundInput, soundText);
  soundInput.addEventListener('change', () => {
    const wanted = soundInput.checked;
    save({ sound: wanted });
  });

  const groupLabel = el('label', 'settings-switch');
  const groupText = el('span');
  bindText(groupText, 'settings.notifications.group');
  const group = el('input');
  group.type = 'number';
  group.name = 'groupSeconds';
  group.min = '1';
  group.max = '60';
  group.value = String(config.groupSeconds);
  FIELD_LABELS.set('notifications.groupSeconds', 'settings.notifications.group');
  // Whatever is typed is staged: Save asks the server, which refuses a value out of range and the message names the field and its limits.
  group.addEventListener('change', () => save({ groupSeconds: Number(group.value) }));
  groupLabel.append(groupText, group);

  // The browser fallback: the permission is asked on this click only.
  const browserRow = el('label', 'settings-switch');
  const browser = el('input');
  browser.type = 'checkbox';
  browser.name = 'browserFallback';
  browser.checked = config.browserFallback;
  const browserText = el('span');
  bindText(browserText, 'settings.notifications.browser');
  browserRow.append(browser, browserText);
  browser.addEventListener('change', () => {
    const wanted = browser.checked;
    void (async () => {
      if (wanted) {
        let granted = false;
        try { granted = typeof Notification !== 'undefined' && (Notification.permission === 'granted' || (await Notification.requestPermission()) === 'granted'); } catch { granted = false; }
        if (!granted) { browser.checked = false; return; }
      }
      save({ browserFallback: wanted });
    })();
  });
  const browserHelp = el('p', 'settings-note');
  bindText(browserHelp, 'settings.notifications.browser.help');

  // The main's own notifications to the Claude app (Remote Control): read by the main when it starts, so Save asks for a restart.
  const mainPush = checkbox('mainPush', 'settings.notifications.mainPush');
  mainPush.input.checked = config.mainPush;
  mainPush.input.addEventListener('change', () => {
    mirror?.('notifications.mainPush', mainPush.input.checked);
    save({ mainPush: mainPush.input.checked });
  });
  const mainPushHelp = note(k('settings.notifications.mainPush.help'));

  // The test toast and what is known about toasts on this machine.
  const status = el('div', 'settings-note settings-toast-status');
  const showToast = (toast: 'ok' | 'unavailable' | 'unknown'): void => {
    // Unknown is shown as n/a, never as "ok" (P7).
    bindText(status, toast === 'ok' ? k('settings.notifications.toast.ok') : toast === 'unavailable' ? k('settings.notifications.toast.unavailable') : k('settings.notifications.toast.unknown'));
  };
  showToast(state.notifications?.toast ?? 'unknown');
  const test = el('button');
  test.type = 'button';
  test.name = 'testToast';
  setIconButton(test, 'play', 'settings.notifications.test');
  const result = el('span', 'settings-note');
  test.addEventListener('click', () => {
    void api<{ ok: boolean }>('/api/notifications/test', { method: 'POST' }).then((res) => {
      const ok = res.status === 200 && res.body.ok === true;
      bindText(result, ok ? k('settings.notifications.testSent') : k('settings.notifications.testFailed'));
      showToast(ok ? 'ok' : 'unavailable');
    });
  });
  const testRow = el('div', 'settings-switch');
  testRow.append(test, result);

  box.append(quietRow, times, soundRow, groupLabel, browserRow, browserHelp, mainPush.row, mainPushHelp, status, testRow, error);
  container.append(box);
}
