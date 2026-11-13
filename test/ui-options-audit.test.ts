// @vitest-environment jsdom
// Options > Audit: the level, the automatic model part and the profile (everywhere and for this project) are staged for the single Save;
// the style profiles are files with their own form, export and import.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPTION_GROUPS, openOptions } from '../src/ui/options';
import type { StateMessage } from '../src/shared/protocol';

const options = {
  config: { models: {}, budget: { loop: {}, quota: {} }, git: {}, agents: {}, audit: { level: 'metrics', autoModel: false, profile: 'default' } },
  errors: [], paths: { configDir: 'C:/c', profilesDir: 'C:/c/profiles', templatesDir: 'C:/c/templates' }, server: { port: 1 }, profiles: [],
};
const state = { settings: { bypassPermissions: false, guardMode: 'enforce', worktrees: true }, project: { name: 'p' }, language: 'en', languages: ['en'], prereq: null } as unknown as StateMessage;

const STRICT_TEXT = '---\nname: strict\ndescription: Diff piccole\nlimits:\n  diff_lines: 120\n---\nNiente commenti che spiegano il come.\n';
const row = (name: string, source: string) => ({ name, source, description: name === 'strict' ? 'Diff piccole' : 'Small diffs', shipped: source === 'shipped', userFile: source === 'user', projectFile: source === 'project' });
const strictDetail = {
  ...row('strict', 'user'), text: STRICT_TEXT,
  profile: { name: 'strict', description: 'Diff piccole', limits: { diff_lines: 120, files_touched: 8, file_lines: 600, comment_run_lines: 4, comment_ratio: 0.15 }, commands: { lint: 'npx eslint {files}' }, conventions: 'Niente commenti che spiegano il come.', source: 'user' },
};

let calls: { url: string; method: string; body: unknown }[] = [];
let putStyleStatus = 200;
beforeEach(() => {
  calls = [];
  putStyleStatus = 200;
  document.body.innerHTML = '<div id="overlay" hidden></div>';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    const method = init?.method ?? 'GET';
    if (method !== 'GET') calls.push({ url, method, body: JSON.parse(init?.body ?? 'null') });
    if (url === '/api/options') return json(200, structuredClone(options));
    if (url === '/api/style') return json(200, { profiles: [row('default', 'shipped'), row('strict', 'user')], active: { global: 'default', effective: 'default' } });
    if (url === '/api/style/strict' && method === 'GET') return json(200, strictDetail);
    if (url.startsWith('/api/style/') && method === 'PUT') return putStyleStatus === 200 ? json(200, {}) : json(422, { code: 'style.badLimit', params: { key: 'diff_lines', min: 0, max: 100000 } });
    if (url.startsWith('/api/config') || url.startsWith('/api/project')) return json(200, {});
    return json(404, null);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const sel = (name: string): HTMLSelectElement => document.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;
const save = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('button[name="saveOptions"]')!;
const btn = (name: string, profile?: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`button[name="${name}"]${profile ? `[data-profile="${profile}"]` : ''}`)!;
const input = (name: string): HTMLInputElement => document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const change = (el: HTMLElement): void => { el.dispatchEvent(new Event('change', { bubbles: true })); };
const open = async (s: StateMessage = state): Promise<void> => { await openOptions(() => s, 'audit'); await flush(); };

describe('Options > Audit', () => {
  it('is a tab of the project group', () => {
    expect(OPTION_GROUPS[1].tabs).toContain('audit');
  });

  it('shows the global settings and the project\'s override, the override reading "same as everywhere" when none is set', async () => {
    await open();
    expect(sel('audit.level').value).toBe('metrics');
    expect(sel('auditLevelProject').value).toBe('');
    expect(input('audit.autoModel').checked).toBe(false);
    expect(sel('auditAutoModelProject').value).toBe('');
    expect([...sel('audit.profile').options].map((o) => o.value)).toEqual(['default', 'strict']);
    expect([...sel('auditProfileProject').options].map((o) => o.value)).toEqual(['', 'default', 'strict']);
    expect(sel('auditProfileProject').value).toBe('');
  });

  it('shows what the project already overrides', async () => {
    await open({ ...state, project: { name: 'p', auditLevel: 'off', auditAutoModel: false, auditProfile: 'strict' } } as unknown as StateMessage);
    expect(sel('auditLevelProject').value).toBe('off');
    expect(sel('auditAutoModelProject').value).toBe('false');
    expect(sel('auditProfileProject').value).toBe('strict');
  });

  it('stages a change: nothing is sent before Save, then each entry is checked and written once', async () => {
    await open();
    sel('audit.level').value = 'full';
    change(sel('audit.level'));
    input('audit.autoModel').checked = true;
    change(input('audit.autoModel'));
    sel('auditLevelProject').value = 'off';
    change(sel('auditLevelProject'));
    expect(calls).toHaveLength(0);
    save().click();
    await flush();
    const written = calls.filter((c) => !c.url.includes('dryRun=1')).map((c) => [c.url, c.body]);
    expect(written).toEqual(expect.arrayContaining([
      ['/api/config', { audit: { level: 'full' } }],
      ['/api/config', { audit: { autoModel: true } }],
      ['/api/project', { auditLevel: 'off' }],
    ]));
    expect(calls.filter((c) => c.url.includes('dryRun=1')).length).toBe(3); // all checked first
  });

  it('clears a project override by choosing "same as everywhere" again', async () => {
    await open({ ...state, project: { name: 'p', auditLevel: 'off', auditProfile: 'strict' } } as unknown as StateMessage);
    sel('auditLevelProject').value = '';
    change(sel('auditLevelProject'));
    sel('auditProfileProject').value = '';
    change(sel('auditProfileProject'));
    save().click();
    await flush();
    const written = calls.filter((c) => !c.url.includes('dryRun=1')).map((c) => c.body);
    expect(written).toEqual(expect.arrayContaining([{ auditLevel: null }, { auditProfile: null }]));
  });
});

describe('Options > Audit > a staged choice is not lost when the list is shown again', () => {
  it('keeps the chosen profiles on screen after opening the editor and cancelling (Save still applies them)', async () => {
    await open();
    sel('auditProfileProject').value = 'strict';
    change(sel('auditProfileProject'));
    sel('audit.profile').value = 'strict';
    change(sel('audit.profile'));
    btn('editStyle', 'strict').click();
    await flush();
    btn('cancelStyle').click();
    await flush();
    expect(sel('auditProfileProject').value).toBe('strict');
    expect(sel('audit.profile').value).toBe('strict');
    save().click();
    await flush();
    const written = calls.filter((c) => !c.url.includes('dryRun=1')).map((c) => c.body);
    expect(written).toEqual(expect.arrayContaining([{ auditProfile: 'strict' }, { audit: { profile: 'strict' } }]));
  });
});

describe('Options > Audit > style profiles', () => {
  it('lists the profiles with where each comes from, and only a profile that has a file of its own can be removed', async () => {
    await open();
    expect(btn('editStyle', 'default')).not.toBeNull();
    expect(btn('deleteStyle', 'strict')).not.toBeNull();
    expect(btn('deleteStyle', 'default')).toBeNull(); // a shipped one has nothing to remove
    expect(document.querySelector('.options-profile-row [data-i18n="options.audit.source.shipped"]')).not.toBeNull();
  });

  it('edits a profile in a form with its own Save, in its own words, and sends the file text', async () => {
    await open();
    btn('editStyle', 'strict').click();
    await flush();
    expect(input('styleName').value).toBe('strict');
    expect(input('styleName').disabled).toBe(true);
    expect(input('limit.diff_lines').value).toBe('120');
    expect(input('styleLint').value).toBe('npx eslint {files}');
    expect(document.querySelector<HTMLTextAreaElement>('textarea[name="styleConventions"]')!.value).toBe('Niente commenti che spiegano il come.');
    expect(save().hidden).toBe(true); // the dialog's Save is not for this form
    input('limit.diff_lines').value = '90';
    btn('saveStyle').click();
    await flush();
    const put = calls.find((c) => c.method === 'PUT' && c.url === '/api/style/strict')!;
    expect(put.body).toMatchObject({ scope: 'user' });
    const text = (put.body as { text: string }).text;
    expect(text).toContain('name: strict');
    expect(text).toContain('  diff_lines: 90');
    expect(text).toContain('description: Diff piccole');
    expect(text).toContain('  lint: npx eslint {files}');
    expect(text.endsWith('Niente commenti che spiegano il come.\n')).toBe(true);
    expect(document.querySelector('button[name="editStyle"]')).not.toBeNull(); // back to the list
  });

  it('keeps the form open when the console refuses a value', async () => {
    await open();
    btn('editStyle', 'strict').click();
    await flush();
    putStyleStatus = 422;
    btn('saveStyle').click();
    await flush();
    expect(input('styleName')).not.toBeNull();
    expect(document.querySelector('.form-error')!.textContent).not.toBe('');
    expect(btn('saveStyle').disabled).toBe(false);
  });

  it('starts a new profile from the shipped numbers, and the name can only be lowercase', async () => {
    await open();
    btn('newStyle').click();
    await flush();
    expect(input('limit.diff_lines').value).toBe('250');
    expect(input('limit.comment_ratio').value).toBe('0.15');
    expect(input('styleName').disabled).toBe(false);
    input('styleName').value = 'My Style';
    input('styleName').dispatchEvent(new Event('input'));
    expect(input('styleName').value).toBe('my style');
  });

  it('exports the file text as it is stored', async () => {
    const created: Blob[] = [];
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => { created.push(b); return 'blob:x'; };
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
    await open();
    btn('exportStyle', 'strict').click();
    await flush();
    expect(created).toHaveLength(1);
    expect(await created[0]!.text()).toBe(STRICT_TEXT);
  });

  it('imports a file under the name of the file, in the user folder', async () => {
    await open();
    const picker = input('importStyleFile');
    const text = '\uFEFF---\r\nname: x\r\n---\r\nÈ già così\r\n';
    const file = new File([text], 'Rigido Nuovo.md');
    (file as unknown as { text: () => Promise<string> }).text = async () => text; // jsdom's File has no text()
    Object.defineProperty(picker, 'files', { value: [file] });
    change(picker);
    await flush();
    const put = calls.find((c) => c.method === 'PUT' && c.url.startsWith('/api/style/'))!;
    expect(put.url).toBe('/api/style/rigido-nuovo');
    expect(put.body).toEqual({ scope: 'user', text });
  });
});
