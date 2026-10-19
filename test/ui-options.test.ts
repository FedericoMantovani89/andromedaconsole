// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPTION_TABS, openOptions } from '../src/ui/options';
import type { StateMessage } from '../src/shared/protocol';

const options = {
  config: { agents: { maxActiveGlobal: 4, maxActivePerProject: 3, bypassPermissions: false }, git: { worktrees: true, testTimeoutMinutes: 15, secretPatterns: ['.env'] }, mod: { enabled: true },
    budget: { agentTokens: 400000, alertPercent: 80, limitPercent: 100, stopPercent: 110, graceMinutes: 5, loop: {}, quota: {} }, models: { agent: '', catalogUrl: '', cacheHours: 6 } },
  errors: [], paths: { configDir: 'C:/c', profilesDir: 'C:/c/profiles', templatesDir: 'C:/c/templates' }, server: { port: 7391 },
  profiles: [{ name: 'backend', source: 'shipped' }],
};
const state = { settings: { bypassPermissions: false, guardMode: 'enforce', worktrees: true }, project: { name: 'p' }, language: 'en', languages: ['en', 'it'], prereq: null } as unknown as StateMessage;

let posts: string[] = [];
let puts: unknown[] = [];
let dryPuts: unknown[] = [];
let putStatus = 200;
let pluginRows: unknown[] = [];
let pluginInstalled: unknown = null;
let tryStatus = 200;
const tryList = [{ repo: 'abc-be', path: 'C:/p/.andromedaconsole/try/abc-be', sha: '1111111111111111111111111111111111111111' }, { repo: 'abc-fe', path: 'C:/p/.andromedaconsole/try/abc-fe', sha: '2222222222222222222222222222222222222222' }];
beforeEach(() => {
  tryStatus = 200;
  puts = [];
  dryPuts = [];
  posts = [];
  putStatus = 200;
  pluginRows = [];
  pluginInstalled = null;
  document.body.innerHTML = '<div id="overlay" hidden></div>';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (init?.method === 'PUT') {
      const failBody = { code: 'config.invalid', params: { path: 'x' } };
      if (url.includes('dryRun=1')) { dryPuts.push(JSON.parse(init.body ?? 'null')); return json(putStatus, putStatus === 200 ? {} : failBody); } // only a check: nothing written
      puts.push(JSON.parse(init.body ?? 'null'));
      return json(putStatus, putStatus === 200 ? {} : failBody);
    }
    if (url === '/api/project/try') { posts.push(`${init?.method} ${url}`); return json(tryStatus, tryStatus !== 200 ? { code: 'try.noProjectBranch', params: { repo: 'abc-be' } } : init?.method === 'DELETE' ? [] : tryList); }
    if (init?.method === 'POST') { posts.push(url); return json(200, url === '/api/prereq/recheck' ? [{ id: 'git', status: 'ok', version: '2.50', required: true }] : { ok: true }); }
    if (url === '/api/prereq/git/install') return json(200, { id: 'git', action: 'install', display: 'winget install --id Git.Git -e --source winget' });
    if (url === '/api/options') return json(200, structuredClone(options)); // a fresh copy: staged edits change the object they are given
    if (url === '/api/models') return json(200, { models: [{ id: 'opus', label: 'opus', alias: true }], source: 'shipped', current: '', missing: false });
    if (url === '/api/plugins/installed') return json(200, { installed: pluginInstalled });
    if (url === '/api/plugins') return json(200, { source: 'shipped', plugins: pluginRows });
    if (url === '/api/profiles') return json(200, [{ name: 'backend', description: 'Backend', body: 'x', readOnly: false, source: 'shipped', shipped: true, userFile: false, projectOverrides: false }]);
    return json(404, null);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('options dialog', () => {
  it('renders every tab and shows only the selected panel', async () => {
    await openOptions(() => state);
    const tabs = [...document.querySelectorAll<HTMLElement>('.options-tab')].map((b) => b.dataset.tab);
    expect(tabs).toEqual([...OPTION_TABS]);
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    expect(document.querySelector('input[name="git.testTimeoutMinutes"]')).not.toBeNull();
    expect(document.querySelector('input[name="bypass"]')).toBeNull();
    document.querySelector<HTMLElement>('.options-tab[data-tab="guard"]')!.click();
    expect(document.querySelector('input[name="bypass"]')).not.toBeNull();
    expect(document.querySelector('select[name="guardMode"]')).not.toBeNull();
  });
  it('the Git tab says nothing about the program while git is there; when it is missing one red line points to Prerequisites; and the git init button shows for a folder that is no repository', async () => {
    const missing = { ...state, projectIsRepo: false, repos: [], prereq: [{ id: 'git', status: 'missing', required: true }] } as unknown as StateMessage;
    await openOptions(() => missing);
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    await flush();
    expect(document.querySelector('.options-git-missing')!.getAttribute('data-i18n')).toBe('options.git.missing');
    expect(document.querySelector('.options-git-tool')).toBeNull(); // the old program section is gone
    document.querySelector<HTMLButtonElement>('button[name="gitInit"]')!.click();
    await flush();
    expect(posts).toContain('/api/projects/git-init');
    expect(document.querySelector<HTMLElement>('.options-git-init')!.hidden).toBe(true); // done: the whole init block goes
  });
  it('the Git tab has no git init button when the folder is already a repository, and shows nothing about git when it is there', async () => {
    const fine = { ...state, projectIsRepo: true, repos: [''], prereq: [{ id: 'git', status: 'ok', version: '2.50', required: true }] } as unknown as StateMessage;
    await openOptions(() => fine);
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    await flush();
    expect(document.querySelector('button[name="gitInit"]')).toBeNull();
    expect(document.querySelector('.options-git-missing')).toBeNull();
    expect(document.querySelector('.options-git-tool')).toBeNull();
  });
  it('a folder that is no repository offers git init and a clone from an address; a repository offers neither', async () => {
    const none = { ...state, projectIsRepo: false, repos: [], prereq: [{ id: 'git', status: 'ok', version: '2.50', required: true }] } as unknown as StateMessage;
    await openOptions(() => none);
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    await flush();
    const url = document.querySelector<HTMLInputElement>('input[name="cloneUrl"]')!;
    const clone = document.querySelector<HTMLButtonElement>('button[name="gitClone"]')!;
    expect(url).not.toBeNull();
    expect(document.querySelector('button[name="gitInit"]')).not.toBeNull();
    clone.click(); // nothing typed: nothing sent
    await flush();
    expect(posts).not.toContain('/api/projects/git-clone');
    url.value = '  https://github.com/org/repo.git ';
    clone.click();
    expect(clone.disabled).toBe(true); // a clone can take a while: no second click
    await flush();
    expect(posts).toContain('/api/projects/git-clone');
    expect(document.querySelector<HTMLElement>('.options-git-clone')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('.options-git-init')!.hidden).toBe(true);
  });
  const repoState = { ...state, projectIsRepo: true, repos: [''], prereq: [{ id: 'git', status: 'ok', version: '2.50', required: true }] } as unknown as StateMessage;
  it('a project that is already a repository has no clone box', async () => {
    await openOptions(() => repoState);
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    await flush();
    expect(document.querySelector('input[name="cloneUrl"]')).toBeNull();
    expect(document.querySelector('button[name="gitInit"]')).toBeNull();
  });
  it('a folder that only holds repositories is not a repository: it offers git init and clone, and names none of the repositories', async () => {
    const many = { ...state, projectIsRepo: true, repos: Array.from({ length: 35 }, (_, i) => `repo-${i}`), prereq: [{ id: 'git', status: 'ok', version: '2.50', required: true }] } as unknown as StateMessage;
    await openOptions(() => many);
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    await flush();
    expect(document.querySelector('button[name="gitInit"]')).not.toBeNull();
    expect(document.querySelector('button[name="gitClone"]')).not.toBeNull();
    // the explanation is in the (i) tooltip of a bold title, not in lines under it
    expect(document.querySelector('.options-git-init strong')!.getAttribute('data-i18n')).toBe('options.git.init.title');
    expect(document.querySelector('.options-git-init .info-icon')!.getAttribute('data-i18n-title')).toBe('options.git.init.tip.holds');
    expect(document.querySelector('.options-git-clone .info-icon')!.getAttribute('data-i18n-title')).toBe('options.git.clone.help');
    expect(document.querySelectorAll('.options-git-project > .settings-note:not([hidden])')).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain('repo-34');
    document.querySelector<HTMLButtonElement>('button[name="gitInit"]')!.click();
    await flush();
    expect(posts).toContain('/api/projects/git-init');
    expect(document.querySelector<HTMLElement>('.options-git-init')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('.options-git-clone')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('.options-git-project > .settings-note')!.hidden).toBe(false); // "done" is shown
  });
  it('the Git tab has no box for the files the console never commits: .gitignore is for the programmers to fill', async () => {
    await openOptions(() => state, 'git');
    expect(document.querySelector('textarea[name="git.secretPatterns"]')).toBeNull();
    expect(document.querySelector('input[name="git.testTimeoutMinutes"]')).not.toBeNull(); // the other git settings stay
  });
  it('the Git tab prepares a checkout of the project branch per repo for a try: paths with a copy button, then Remove', async () => {
    const multi = { ...state, projectIsRepo: true, repos: ['abc-be', 'abc-fe'], prereq: [{ id: 'git', status: 'ok', version: '2.50', required: true }] } as unknown as StateMessage;
    await openOptions(() => multi, 'git');
    await flush();
    expect(document.querySelector('.options-git-try strong')!.getAttribute('data-i18n')).toBe('options.git.try.title');
    expect(document.querySelector('.options-git-try .info-icon')!.getAttribute('data-i18n-title')).toBe('options.git.try.tip');
    expect(document.querySelector('button[name="tryRemove"]')).toBeNull(); // nothing to remove yet: not built
    expect(document.querySelectorAll('input[name="tryPath"]')).toHaveLength(0);
    document.querySelector<HTMLButtonElement>('button[name="tryPrepare"]')!.click();
    await flush();
    expect(posts).toContain('POST /api/project/try');
    expect([...document.querySelectorAll<HTMLInputElement>('input[name="tryPath"]')].map((i) => i.value)).toEqual(tryList.map((c) => c.path));
    expect(document.querySelectorAll('button[name="tryCopy"]')).toHaveLength(2);
    expect(document.querySelector('button[name="tryPrepare"]')!.getAttribute('data-i18n')).toBe('options.git.try.refresh');
    document.querySelector<HTMLButtonElement>('button[name="tryRemove"]')!.click();
    await flush();
    expect(posts).toContain('DELETE /api/project/try');
    expect(document.querySelectorAll('input[name="tryPath"]')).toHaveLength(0);
    expect(document.querySelector('button[name="tryRemove"]')).toBeNull();
  });
  it('the try section starts from the checkouts in the state, shows a refusal translated, and is not built for a folder with no repository', async () => {
    const ready = { ...state, projectIsRepo: true, repos: [''], project: { name: 'p', repos: [], tryCheckouts: [tryList[0]] }, prereq: [{ id: 'git', status: 'ok', version: '2.50', required: true }] } as unknown as StateMessage;
    await openOptions(() => ready, 'git');
    await flush();
    expect([...document.querySelectorAll<HTMLInputElement>('input[name="tryPath"]')].map((i) => i.value)).toEqual([tryList[0]!.path]);
    tryStatus = 409;
    document.querySelector<HTMLButtonElement>('button[name="tryPrepare"]')!.click();
    await flush();
    expect(document.querySelector('.options-dialog .form-error')!.textContent).not.toBe('');
    document.body.innerHTML = '<div id="overlay" hidden></div>';
    const none = { ...state, projectIsRepo: false, repos: [], prereq: [{ id: 'git', status: 'ok', version: '2.50', required: true }] } as unknown as StateMessage;
    await openOptions(() => none, 'git');
    await flush();
    expect(document.querySelector('.options-git-try')).toBeNull();
  });
  it('the red git line follows the state each time the tab is shown: it goes away after git is installed', async () => {
    let now = { ...state, projectIsRepo: true, repos: [''], prereq: [{ id: 'git', status: 'missing', required: true }] } as unknown as StateMessage;
    await openOptions(() => now);
    const tab = (name: string) => document.querySelector<HTMLElement>(`.options-tab[data-tab="${name}"]`)!.click();
    tab('git');
    expect(document.querySelector('.options-git-missing')).not.toBeNull();
    tab('prerequisites');
    now = { ...now, prereq: [{ id: 'git', status: 'ok', version: '2.50', required: true }] } as unknown as StateMessage;
    tab('git');
    expect(document.querySelector('.options-git-missing')).toBeNull();
    now = { ...now, prereq: null } as unknown as StateMessage; // checks not finished: unknown, nothing claimed either way
    tab('prerequisites');
    tab('git');
    expect(document.querySelector('.options-git-missing')).toBeNull();
  });
  it('the Project tab lets the template be applied to the open project', async () => {
    await openOptions(() => state);
    document.querySelector<HTMLElement>('.options-tab[data-tab="projects"]')!.click();
    expect(document.querySelector('select[name="template"]')).not.toBeNull();
    expect(document.querySelector('button[name="applyTemplate"]')).not.toBeNull();
  });
  const clickSave = async (): Promise<void> => { document.querySelector<HTMLElement>('button[name="saveOptions"]')!.click(); await flush(); await flush(); };
  it('a changed field is staged, and Save sends only its own entry and closes the dialog', async () => {
    await openOptions(() => state);
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    const input = document.querySelector<HTMLInputElement>('input[name="git.testTimeoutMinutes"]')!;
    input.value = '30';
    input.dispatchEvent(new Event('change'));
    await flush();
    expect(puts).toEqual([]);
    await clickSave();
    expect(puts).toEqual([{ git: { testTimeoutMinutes: 30 } }]);
    expect(document.getElementById('overlay')!.hidden).toBe(true);
  });
  it('an edit survives a visit to another tab', async () => {
    await openOptions(() => state);
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    const input = document.querySelector<HTMLInputElement>('input[name="git.testTimeoutMinutes"]')!;
    input.value = '30';
    input.dispatchEvent(new Event('change'));
    document.querySelector<HTMLElement>('.options-tab[data-tab="budget"]')!.click();
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    expect(document.querySelector<HTMLInputElement>('input[name="git.testTimeoutMinutes"]')!.value).toBe('30');
  });
  it('a refused save shows the error, keeps the dialog open and keeps what was typed', async () => {
    await openOptions(() => state);
    document.querySelector<HTMLElement>('.options-tab[data-tab="budget"]')!.click();
    const input = document.querySelector<HTMLInputElement>('input[name="budget.graceMinutes"]')!;
    putStatus = 422;
    input.value = '150';
    input.dispatchEvent(new Event('change'));
    await clickSave();
    expect(input.value).toBe('150');
    expect(document.querySelector('.form-error')!.textContent).not.toBe('');
    expect(document.getElementById('overlay')!.hidden).toBe(false);
  });
  it('the X closes the dialog without sending anything', async () => {
    await openOptions(() => state, 'guard');
    const box = document.querySelector<HTMLInputElement>('input[name="bypass"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    document.querySelector<HTMLElement>('button[name="closeOptions"]')!.click();
    await flush();
    expect(puts).toEqual([]);
    expect(document.getElementById('overlay')!.hidden).toBe(true);
  });
  it('changing the bypass switch asks to restart after Save; a plain setting does not', async () => {
    await openOptions(() => state, 'guard');
    const box = document.querySelector<HTMLInputElement>('input[name="bypass"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await clickSave();
    expect(puts).toEqual([{ agents: { bypassPermissions: true } }]);
    expect(document.querySelector('.restart-dialog')).not.toBeNull();
    document.querySelector<HTMLElement>('button[name="restartNo"]')!.click();
    expect(document.getElementById('overlay')!.hidden).toBe(true);
    await openOptions(() => state, 'git');
    const input = document.querySelector<HTMLInputElement>('input[name="git.testTimeoutMinutes"]')!;
    input.value = '20';
    input.dispatchEvent(new Event('change'));
    await clickSave();
    expect(document.querySelector('.restart-dialog')).toBeNull();
  });
  it('the dialog Save is hidden while a profile is being edited, and back with Annulla', async () => {
    await openOptions(() => state, 'profiles');
    await flush();
    const saveBtn = document.querySelector<HTMLButtonElement>('button[name="saveOptions"]')!;
    expect(saveBtn.hidden).toBe(false);
    document.querySelector<HTMLElement>('button[name="newProfile"]')!.click();
    expect(saveBtn.hidden).toBe(true);
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    expect(saveBtn.hidden).toBe(false); // another tab: the dialog's Save is back
    document.querySelector<HTMLElement>('.options-tab[data-tab="profiles"]')!.click();
    expect(saveBtn.hidden).toBe(true); // the form is still open there
    document.querySelector<HTMLElement>('button[name="cancelProfile"]')!.click();
    await flush();
    expect(saveBtn.hidden).toBe(false);
  });
  it('the budget levels are sliders with a read-only value; reaching a neighbour pushes it along and the trio is sent as one request', async () => {
    await openOptions(() => state, 'budget');
    const slider = (name: string) => document.querySelector<HTMLInputElement>(`input[type="range"][name="${name}"]`)!;
    const value = (name: string) => slider(name).nextElementSibling as HTMLElement;
    expect(value('budget.stopPercent').tagName).toBe('OUTPUT');
    expect(value('budget.alertPercent').textContent).toBe('80 %');
    const move = (name: string, to: number) => { slider(name).value = String(to); slider(name).dispatchEvent(new Event('input')); };
    move('budget.alertPercent', 150); // past the restriction level (100): it pushes restriction (five above) and stop along
    expect(slider('budget.alertPercent').value).toBe('150');
    expect(slider('budget.limitPercent').value).toBe('155');
    expect(slider('budget.stopPercent').value).toBe('155');
    expect(value('budget.limitPercent').textContent).toBe('155 %');
    move('budget.stopPercent', 120); // down: restriction follows, then alert keeps its five below
    expect(slider('budget.limitPercent').value).toBe('120');
    expect(slider('budget.alertPercent').value).toBe('115');
    move('budget.alertPercent', 200); // the end of the scale: the chain stops where all three still fit
    expect(slider('budget.alertPercent').value).toBe('195');
    expect(slider('budget.stopPercent').value).toBe('200');
    await clickSave();
    expect(puts).toEqual([{ budget: { alertPercent: 195, limitPercent: 200, stopPercent: 200 } }]);
  });
  it('nothing is sent until Save: moved sliders, another tab and the X leave no request behind', async () => {
    await openOptions(() => state, 'budget');
    const slider = (name: string) => document.querySelector<HTMLInputElement>(`input[type="range"][name="${name}"]`)!;
    slider('budget.agentTokens').value = '900000';
    slider('budget.agentTokens').dispatchEvent(new Event('input'));
    slider('budget.alertPercent').value = '50';
    slider('budget.alertPercent').dispatchEvent(new Event('input'));
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    await flush();
    document.querySelector<HTMLElement>('.options-tab[data-tab="budget"]')!.click();
    expect(slider('budget.agentTokens').value).toBe('900000'); // still staged
    document.querySelector<HTMLElement>('button[name="closeOptions"]')!.click();
    await flush();
    expect(puts).toEqual([]);
    expect(posts).toEqual([]);
  });
  it('a refused Save writes nothing: every change is checked first and stays staged', async () => {
    await openOptions(() => state, 'budget');
    const slider = (name: string) => document.querySelector<HTMLInputElement>(`input[type="range"][name="${name}"]`)!;
    slider('budget.agentTokens').value = '900000';
    slider('budget.agentTokens').dispatchEvent(new Event('input'));
    putStatus = 422;
    await clickSave();
    expect(dryPuts.length).toBeGreaterThan(0);
    expect(puts).toEqual([]); // the check failed, so not even the valid change was written
    expect(document.querySelector('.options-dialog')).not.toBeNull();
    putStatus = 200;
    await clickSave();
    expect(puts).toEqual([{ budget: { agentTokens: 900000 } }]);
  });
  it('a grouping value out of range is staged, not dropped: Save refuses it and names the limits', async () => {
    const withNotify = { ...state, notifications: { config: { enabled: {}, sound: false, groupSeconds: 5, quietHours: { enabled: false, from: '22:00', to: '08:00' } } } } as unknown as StateMessage;
    await openOptions(() => withNotify, 'notifications');
    const group = document.querySelector<HTMLInputElement>('input[name="groupSeconds"]')!;
    group.value = '1000000000';
    group.dispatchEvent(new Event('change'));
    expect(group.value).toBe('1000000000'); // not silently put back
    putStatus = 422;
    await clickSave();
    expect(dryPuts).toEqual([{ notifications: { groupSeconds: 1000000000 } }]);
    expect(puts).toEqual([]);
    expect(document.querySelector('.options-dialog')).not.toBeNull();
  });
  it('a language change also translates the tabs that are not on screen', async () => {
    await openOptions(() => state, 'models');
    const label = (): string => document.querySelector('.options-models [data-i18n="options.models.agent"]')!.textContent ?? '';
    const view = document.querySelector('.options-models')!;
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click(); // Models leaves the document
    expect(view.isConnected).toBe(false);
    view.querySelector('[data-i18n="options.models.agent"]')!.textContent = 'stale';
    window.dispatchEvent(new CustomEvent('languagechange'));
    expect(view.querySelector('[data-i18n="options.models.agent"]')!.textContent).not.toBe('stale');
    document.querySelector<HTMLElement>('.options-tab[data-tab="models"]')!.click();
    expect(label()).not.toBe('stale');
  });
  it('after Save the restart question is asked only for a setting the sessions read at launch, never for a program installed later', async () => {
    const installedLater = { ...state, prereq: [{ id: 'git', status: 'restart', version: '2.50', required: true }] } as unknown as StateMessage;
    await openOptions(() => installedLater, 'budget');
    const slider = document.querySelector<HTMLInputElement>('input[type="range"][name="budget.agentTokens"]')!;
    slider.value = '900000';
    slider.dispatchEvent(new Event('input'));
    await clickSave();
    expect(puts).toEqual([{ budget: { agentTokens: 900000 } }]);
    expect(document.querySelector('.restart-dialog')).toBeNull(); // restarting the sessions would not make the program visible
    expect(document.querySelector('.options-dialog')).toBeNull(); // the dialog just closed
  });
  it('plugins: the install state comes after the catalog; an installed one loses its command to copy, the context line shows only when known', async () => {
    const row = (id: string, cost: number | null) => ({ id, category: 'x', summary: { en: id }, trust: 'official', tier: 'on_request', requires: [], agentsAllowed: true, conflicts: [], cost: cost === null ? null : { contextTokens: cost }, notTested: false, installCommand: `/plugin install ${id}` });
    pluginRows = [row('a@m', null), row('b@m', null), row('c@m', 1200), row('d@m', null)];
    pluginInstalled = { 'a@m': { state: 'installed', version: '1.0' }, 'b@m': { state: 'not_installed' }, 'c@m': { state: 'other_project' }, 'd@m': { state: 'disabled', version: '2.0' } };
    await openOptions(() => state, 'plugins');
    await flush();
    await flush();
    const card = (id: string) => document.querySelector<HTMLElement>(`.options-plugin[data-plugin="${id}"]`)!;
    const status = (id: string) => card(id).querySelector('.options-plugin-status')!.getAttribute('data-i18n');
    expect(['a@m', 'b@m', 'c@m', 'd@m'].map(status)).toEqual(['options.plugins.installed.installed', 'options.plugins.installed.not_installed', 'options.plugins.installed.other_project', 'options.plugins.installed.disabled']);
    expect(card('a@m').querySelector('.options-command-row')!.hasAttribute('hidden')).toBe(true); // already there: nothing to copy
    expect(card('d@m').querySelector('.options-command-row')!.hasAttribute('hidden')).toBe(true);
    expect(card('b@m').querySelector('.options-command-row')!.hasAttribute('hidden')).toBe(false);
    expect(card('c@m').querySelector('.options-command-row')!.hasAttribute('hidden')).toBe(false); // installed only elsewhere: still to install here
    expect(card('a@m').querySelector('[data-i18n="options.plugins.cost"]')).toBeNull(); // n/a: no line
    expect(card('c@m').querySelector('[data-i18n="options.plugins.cost"]')).not.toBeNull();
    expect(document.querySelector('[data-i18n="options.plugins.installed.unreadable"]')!.hasAttribute('hidden')).toBe(true);
  });
  it('plugins: when Claude Code cannot tell, no card claims "not installed" and the tab says so', async () => {
    pluginRows = [{ id: 'a@m', category: 'x', summary: { en: 'a' }, trust: 'official', tier: 'on_request', requires: [], agentsAllowed: true, conflicts: [], cost: null, notTested: false, installCommand: '/plugin install a@m' }];
    pluginInstalled = null;
    await openOptions(() => state, 'plugins');
    await flush();
    await flush();
    expect(document.querySelector('.options-plugin-status')!.getAttribute('data-i18n')).toBeNull();
    expect(document.querySelector('[data-i18n="options.plugins.installed.unreadable"]')!.hasAttribute('hidden')).toBe(false);
  });
  it('the tests switch: off disables the command field, is staged for Save, and the explanation is a tooltip', async () => {
    await openOptions(() => state, 'projects');
    await flush();
    const off = document.querySelector<HTMLInputElement>('input[name="testsDisabled"]')!;
    const command = document.querySelector<HTMLInputElement>('input[name="testCommand"]')!;
    expect(off.checked).toBe(false);
    expect(command.disabled).toBe(false);
    expect(off.closest('label')!.querySelector('.info-icon')).not.toBeNull(); // the explanation is in the (i), not under the box
    off.checked = true;
    off.dispatchEvent(new Event('change'));
    expect(command.disabled).toBe(true);
    await clickSave();
    expect(puts).toContainEqual({ testsDisabled: true });
    expect(document.querySelectorAll('.settings-test > .settings-note')).toHaveLength(0); // no lines under the command field
  });
  it('three optional commands per moment sit beside the test command, each staged for Save with a tooltip', async () => {
    await openOptions(() => state, 'projects');
    await flush();
    for (const key of ['ticket', 'merge', 'release']) {
      const input = document.querySelector<HTMLInputElement>(`input[name="testCommands.${key}"]`)!;
      expect(input, key).not.toBeNull();
      expect(input.value).toBe('');
      expect(input.closest('label')!.querySelector('.info-icon')!.getAttribute('data-i18n-title')).toBe(`settings.testCommands.${key}.tip`);
    }
    const merge = document.querySelector<HTMLInputElement>('input[name="testCommands.merge"]')!;
    merge.value = 'npm run test:smoke';
    merge.dispatchEvent(new Event('change'));
    expect(puts).toEqual([]); // one Save
    await clickSave();
    expect(puts).toContainEqual({ testCommands: { merge: 'npm run test:smoke' } });
  });
  it('with the tests inhibited the per-moment fields are disabled too', async () => {
    await openOptions(() => state, 'projects');
    await flush();
    const off = document.querySelector<HTMLInputElement>('input[name="testsDisabled"]')!;
    off.checked = true;
    off.dispatchEvent(new Event('change'));
    for (const key of ['ticket', 'merge', 'release']) expect(document.querySelector<HTMLInputElement>(`input[name="testCommands.${key}"]`)!.disabled).toBe(true);
  });
  it('the saved per-moment commands are shown in their fields', async () => {
    const withCommands = { ...state, project: { name: 'p', testCommands: { ticket: 'fast', release: 'full' } } } as unknown as StateMessage;
    await openOptions(() => withCommands, 'projects');
    await flush();
    expect(document.querySelector<HTMLInputElement>('input[name="testCommands.ticket"]')!.value).toBe('fast');
    expect(document.querySelector<HTMLInputElement>('input[name="testCommands.merge"]')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('input[name="testCommands.release"]')!.value).toBe('full');
  });
  it('the note on when settings apply is said once, next to Save, on every tab and not inside any of them', async () => {
    await openOptions(() => state);
    for (const tab of ['models', 'profiles', 'budget', 'guard', 'notifications', 'git', 'projects']) {
      document.querySelector<HTMLElement>(`.options-tab[data-tab="${tab}"]`)!.click();
      await flush();
      const notes = [...document.querySelectorAll('[data-i18n="settings.appliesToNew"]')];
      expect(notes, tab).toHaveLength(1);
      expect(notes[0]!.closest('.options-foot')!.querySelector('button[name="saveOptions"]'), tab).not.toBeNull();
    }
  });
  it('the token budget slider shows the number with the language separators', async () => {
    await openOptions(() => state, 'budget');
    const out = document.querySelector<HTMLInputElement>('input[type="range"][name="budget.agentTokens"]')!.nextElementSibling as HTMLElement;
    expect(out.textContent).toMatch(/^400\D?000$/);
  });
  it('the project model is a menu like the one in Models: saved value selected, no alias, saved with Save', async () => {
    const withModel = { ...state, project: { name: 'p', model: 'claude-opus-5-5' } } as unknown as StateMessage;
    await openOptions(() => withModel, 'projects');
    await flush();
    await flush();
    const menu = document.querySelector<HTMLSelectElement>('select[name="model"]')!;
    expect(menu.value).toBe('claude-opus-5-5'); // kept even when the catalog does not list it
    expect([...menu.options].map((o) => o.value)).toEqual(['', 'claude-opus-5-5']);
    menu.value = '';
    menu.dispatchEvent(new Event('change'));
    await clickSave();
    expect(puts).toContainEqual({ model: '' });
  });
  it('the test command field shows what the project suggests as its placeholder and says where it comes from', async () => {
    const withDetected = { ...state, project: { name: 'p', detectedTestCommand: 'npm test' } } as unknown as StateMessage;
    await openOptions(() => withDetected, 'projects');
    const input = document.querySelector<HTMLInputElement>('input[name="testCommand"]')!;
    expect(input.placeholder).toBe('npm test');
    expect(input.value).toBe('');
    expect(document.querySelector('.settings-test .info-icon')!.getAttribute('data-i18n-title')).toBe('settings.testCommand.tip.detected');
    await openOptions(() => state, 'projects');
    expect(document.querySelector('.settings-test .info-icon')!.getAttribute('data-i18n-title')).toBe('settings.testCommand.tip.none');
  });
  it('a folder of several repositories has one test command row per repository: detected command or n/a as placeholder, saved with the one Save', async () => {
    const multi = { ...state, project: { name: 'p', repos: ['abc-be', 'abc-fe'], detectedRepoTestCommands: { 'abc-fe': 'npm test' }, repoTestCommands: { 'abc-be': 'mvn -q test' } } } as unknown as StateMessage;
    await openOptions(() => multi, 'projects');
    await flush();
    const be = document.querySelector<HTMLInputElement>('input[name="repoTestCommands.abc-be"]')!;
    const fe = document.querySelector<HTMLInputElement>('input[name="repoTestCommands.abc-fe"]')!;
    expect(be.value).toBe('mvn -q test');
    expect(be.dataset.i18nPlaceholder).toBe('common.notAvailable'); // nothing detected in abc-be: "n/a"
    expect(fe.value).toBe('');
    expect(fe.placeholder).toBe('npm test');
    const head = fe.closest('label')!.querySelector('.options-field-head')!;
    expect(head.querySelector('[data-i18n="settings.repoTestCommand"]')!.getAttribute('data-i18n-params')).toBe(JSON.stringify({ repo: 'abc-fe' }));
    expect(head.querySelector('.info-icon')!.getAttribute('data-i18n-title')).toBe('settings.repoTestCommand.tip');
    // The project-wide field does not claim that nothing was detected: each repository detects its own.
    expect(document.querySelector('.settings-test .info-icon')!.getAttribute('data-i18n-title')).toBe('settings.testCommand.tip.repos');
    fe.value = 'npm run test:ci';
    fe.dispatchEvent(new Event('change'));
    be.value = '';
    be.dispatchEvent(new Event('change'));
    expect(puts).toEqual([]); // one Save
    const off = document.querySelector<HTMLInputElement>('input[name="testsDisabled"]')!;
    off.checked = true;
    off.dispatchEvent(new Event('change'));
    expect(fe.disabled).toBe(true); // inhibited tests: these rows are off too
    await clickSave();
    expect(puts).toContainEqual({ repoTestCommands: { 'abc-fe': 'npm run test:ci' } });
    expect(puts).toContainEqual({ repoTestCommands: { 'abc-be': '' } });
  });
  it('a repository folder named like an object property (constructor) shows its own command or n/a, never something inherited', async () => {
    const odd = { ...state, project: { name: 'p', repos: ['constructor', 'toString'], detectedRepoTestCommands: { toString: 'npm test' }, repoTestCommands: {} } } as unknown as StateMessage;
    await openOptions(() => odd, 'projects');
    await flush();
    const c = document.querySelector<HTMLInputElement>('input[name="repoTestCommands.constructor"]')!;
    const s = document.querySelector<HTMLInputElement>('input[name="repoTestCommands.toString"]')!;
    expect(c.value).toBe('');
    expect(c.dataset.i18nPlaceholder).toBe('common.notAvailable');
    expect(s.value).toBe('');
    expect(s.placeholder).toBe('npm test');
  });
  it('a project folder that is one repository has no repository rows', async () => {
    await openOptions(() => ({ ...state, project: { name: 'p', repos: [] } }) as unknown as StateMessage, 'projects');
    await flush();
    expect(document.querySelector('input[name^="repoTestCommands."]')).toBeNull();
  });
  it('the models menu offers Default and real models only, never an alias', async () => {
    await openOptions(() => state, 'models');
    await flush();
    await flush();
    expect([...document.querySelectorAll<HTMLOptionElement>('select[name="models.agent"] option')].map((o) => o.value)).toEqual(['']);
  });
});
