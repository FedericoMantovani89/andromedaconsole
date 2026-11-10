// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrereqResult } from '../src/shared/protocol';

const openInstallTerminal = vi.fn();
vi.mock('../src/ui/install-terminal', () => ({ openInstallTerminal: (...a: unknown[]) => openInstallTerminal(...a) }));

const { renderPrereqTable } = await import('../src/ui/settings');

const calls: { path: string; method: string; body: unknown }[] = [];
let describeBody: unknown;

beforeEach(() => {
  calls.length = 0;
  openInstallTerminal.mockClear();
  document.body.innerHTML = '<div id="overlay" hidden></div><div id="host"></div>';
  vi.stubGlobal('fetch', async (path: string, init?: { method?: string; body?: string }) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    const post = init?.method === 'POST' && path.endsWith('/install');
    return { status: post ? 202 : 200, json: async () => (post ? { terminal: 'install-git' } : path.endsWith('/install') ? describeBody : []) };
  });
});

const results: PrereqResult[] = [
  { id: 'node', required: true, status: 'ok', version: '24.15.0' },
  { id: 'git', required: true, status: 'missing' },
  { id: 'claude', required: true, status: 'outdated', version: '2.1.250' },
  { id: 'gh', required: false, status: 'missing' },
];
const tick = () => new Promise((r) => setTimeout(r, 0));
const info = (o: Record<string, unknown> = {}) => ({
  id: 'git', action: 'install', display: 'winget install --id Git.Git -e --source winget', source: { kind: 'winget', origin: 'winget (Microsoft)' },
  secondConfirm: false, mayNeedAdmin: true, verified: false, ...o,
});

describe('prerequisites table buttons', () => {
  it('offers Install or Update only for rows that are missing, outdated or unreadable', () => {
    const host = document.getElementById('host')!;
    renderPrereqTable(host, results);
    const rows = [...host.querySelectorAll('.prereq-row')];
    const key = (row: Element) => row.querySelector('button')?.dataset.i18n;
    expect(rows.map(key)).toEqual([undefined, 'prereq.install', 'prereq.update', 'prereq.install']);
  });
});

describe('required-only table (the first-start wizard)', () => {
  it('lists only the required tools; Options lists the optional ones too', () => {
    const host = document.getElementById('host')!;
    renderPrereqTable(host, results, undefined, true);
    expect([...host.querySelectorAll('.prereq-row')].map((r) => r.querySelector('[data-i18n^="prereq."]')!.getAttribute('data-i18n'))).toEqual(['prereq.node', 'prereq.git', 'prereq.claude']);
    renderPrereqTable(host, results);
    expect(host.querySelectorAll('.prereq-row')).toHaveLength(4);
  });
});

describe('sections', () => {
  it('Options splits required from optional under two headings; the wizard table has none', () => {
    const host = document.getElementById('host')!;
    renderPrereqTable(host, results);
    expect([...host.querySelectorAll('h3')].map((h) => h.dataset.i18n)).toEqual(['prereq.section.required', 'prereq.section.optional']);
    const order = [...host.children].map((c) => (c.tagName === 'H3' ? 'H' : c.classList.contains('prereq-row') ? 'R' : 'X')).join('');
    expect(order).toBe('HRRRHRX'); // heading, three required rows, heading, the optional row, the recheck button
    renderPrereqTable(host, results, undefined, true);
    expect(host.querySelectorAll('h3')).toHaveLength(0);
  });
});

describe('under the table', () => {
  it('Options has no button (neither Recheck nor Restart could show a new program) but a line saying to start the console from a new terminal; the wizard keeps Recheck', () => {
    const host = document.getElementById('host')!;
    renderPrereqTable(host, results);
    expect(host.querySelector('[data-i18n="prereq.afterInstall"]')).not.toBeNull();
    expect(host.querySelector('[data-i18n="prereq.recheck"]')).toBeNull();
    expect(host.querySelector('button[name="restartConsole"]')).toBeNull();
    const middle = document.createElement('div');
    renderPrereqTable(host, results, middle, true);
    expect(middle.querySelector('[data-i18n-title="prereq.recheck"]')).not.toBeNull();
    expect(host.querySelector('[data-i18n="prereq.afterInstall"]')).toBeNull();
  });
});

describe('use counts', () => {
  it('shows how often each installed helper was used; a tool nobody measures or a missing one has an empty cell, never a 0', () => {
    const host = document.getElementById('host')!;
    const rows: PrereqResult[] = [...results, { id: 'rg', required: false, status: 'ok', version: '15.1.0' }, { id: 'jq', required: false, status: 'ok', version: '1.7.1' }, { id: 'fd', required: false, status: 'missing' }];
    renderPrereqTable(host, rows, undefined, false, { since: '2026-10-08T10:00:00.000Z', counts: { rg: 12, jq: 1 } });
    // (the texts are not loaded in this test: the cell carries its key and parameters)
    const usesOf = (id: string): string => {
      const cell = [...host.querySelectorAll('.prereq-row')].find((r) => r.querySelector(`[data-i18n="prereq.${id}"]`))?.querySelector<HTMLElement>('.prereq-uses');
      return cell?.dataset.i18n ? `${cell.dataset.i18n} ${cell.dataset.i18nParams}` : '';
    };
    expect(usesOf('rg')).toBe('prereq.uses {"count":12}');
    expect(usesOf('jq')).toBe('prereq.uses {"count":1}');
    expect(usesOf('fd')).toBe(''); // missing: not measured
    expect(usesOf('gh')).toBe(''); // the GitHub CLI is not counted
    expect(usesOf('node')).toBe('');
    expect(host.querySelector('[data-i18n="prereq.uses.help"]')).not.toBeNull();
    renderPrereqTable(host, rows); // no usage in the state (an older server): no column content at all
    expect(host.querySelector('.prereq-uses')?.textContent ?? '').toBe('');
    expect(host.querySelector('[data-i18n="prereq.uses.help"]')).toBeNull();
  });
});

describe('install dialog', () => {
  const open = async (): Promise<HTMLElement> => {
    const host = document.getElementById('host')!;
    renderPrereqTable(host, results);
    host.querySelectorAll('.prereq-row')[1]!.querySelector('button')!.click();
    await tick();
    return document.getElementById('overlay')!;
  };

  it('shows the exact command, the origin and the notes, and runs nothing before the click', async () => {
    describeBody = info();
    const overlay = await open();
    expect(overlay.hidden).toBe(false);
    expect(overlay.querySelector('.install-command')!.textContent).toBe('winget install --id Git.Git -e --source winget');
    const keys = [...overlay.querySelectorAll<HTMLElement>('[data-i18n]')].map((e) => e.dataset.i18n);
    expect(keys).toContain('prereq.install.source');
    expect(keys).toContain('prereq.install.admin');
    expect(keys).toContain('prereq.install.unverified');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('Run it posts the consent and opens the terminal it was given', async () => {
    describeBody = info();
    const overlay = await open();
    const confirm = [...overlay.querySelectorAll('button')].find((b) => b.dataset.i18nTitle === 'prereq.install.confirm')!;
    confirm.click();
    await tick();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/api/prereq/git/install', body: { confirmed: true } });
    expect(openInstallTerminal).toHaveBeenCalledWith('install-git', expect.any(Function));
  });

  it('a script waits for its second confirmation before the button works', async () => {
    describeBody = info({ secondConfirm: true, source: { kind: 'script', origin: 'https://example.invalid/i.ps1' } });
    const overlay = await open();
    const confirm = [...overlay.querySelectorAll('button')].find((b) => b.dataset.i18nTitle === 'prereq.install.confirm')!;
    const box = overlay.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(confirm.disabled).toBe(true);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await tick();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ confirmed: true, confirmedScript: true });
  });

  it('shows the manual instructions, and no command, when the tool cannot be installed from here', async () => {
    describeBody = { unavailable: 'no_winget' };
    const overlay = await open();
    expect(overlay.querySelector('.install-command')).toBeNull();
    const keys = [...overlay.querySelectorAll<HTMLElement>('[data-i18n]')].map((e) => e.dataset.i18n);
    expect(keys).toContain('prereq.install.unavailable.no_winget');
    expect(keys).toContain('prereq.install.manual.git');
  });

  it('Cancel gives back what was on screen before and runs nothing', async () => {
    describeBody = info();
    const overlay = document.getElementById('overlay')!;
    const before = document.createElement('div');
    before.id = 'before';
    overlay.append(before);
    await open();
    expect(overlay.querySelector('#before')).toBeNull();
    [...overlay.querySelectorAll('button')].find((b) => b.dataset.i18nTitle === 'common.cancel')!.click();
    await tick();
    expect(overlay.querySelector('#before')).not.toBeNull();
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/install'))).toEqual([]);
  });
});
