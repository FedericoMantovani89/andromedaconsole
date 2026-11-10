// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openNewProjectDialog } = await import('../src/ui/new-project');
const { showWelcome } = await import('../src/ui/welcome');

interface Call { path: string; method: string; body: unknown }
const calls: Call[] = [];
let pick: { status: number; body: unknown };
let created: { status: number; body: unknown };

beforeEach(() => {
  calls.length = 0;
  pick = { status: 200, body: { status: 'picked', path: 'D:\\work\\Shop API' } };
  created = { status: 201, body: { name: 'shop-api' } };
  document.body.innerHTML = '<header id="topbar"></header><main id="workspace"></main><footer id="statusbar"></footer><div id="drawer" hidden></div><div id="overlay" hidden></div>';
  vi.stubGlobal('fetch', async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const answer = (status: number, body: unknown) => ({ status, json: async () => body });
    if (path === '/api/pick-folder') return answer(pick.status, pick.body);
    if (path === '/api/projects' && method === 'POST') return answer(created.status, created.body);
    if (path.startsWith('/api/projects/detect')) return answer(200, { source: 'pom.xml', build: 'mvn package', test: 'mvn test' });
    if (path === '/api/templates') return answer(200, [{ id: 'generic', name: { en: 'Generic' }, description: { en: '' }, source: 'shipped', valid: true }]);
    return answer(200, []);
  });
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const field = (name: string): HTMLInputElement => document.querySelector(`#overlay input[name="${name}"]`)!;
const browse = (): HTMLButtonElement => document.querySelector('#overlay button.browse-folder')!;

describe('the Browse button of the new-project dialog', () => {
  it('fills the folder with what the native window returned and checks it', async () => {
    openNewProjectDialog(() => undefined);
    await tick();
    expect(browse().dataset.i18nTitle).toBe('projects.new.browse');
    browse().click();
    await tick(); await tick();
    expect(calls.some((c) => c.path === '/api/pick-folder' && c.method === 'POST')).toBe(true);
    expect(field('folder').value).toBe('D:\\work\\Shop API');
    expect(field('name').value).toBe('shop-api'); // proposed from the chosen folder
    expect(calls.some((c) => c.path === `/api/projects/detect?root=${encodeURIComponent('D:\\work\\Shop API')}`)).toBe(true);
  });

  it('leaves the folder alone when the window was closed', async () => {
    pick = { status: 200, body: { status: 'cancelled' } };
    openNewProjectDialog(() => undefined);
    await tick();
    field('folder').value = 'D:\\typed';
    browse().click();
    await tick(); await tick();
    expect(field('folder').value).toBe('D:\\typed');
    expect(calls.some((c) => c.path.startsWith('/api/projects/detect'))).toBe(false);
  });

  it('says so when the window cannot be opened here, and the typed path still works', async () => {
    pick = { status: 200, body: { status: 'unavailable', reason: 'unsupported_platform' } };
    openNewProjectDialog(() => undefined);
    await tick();
    browse().click();
    await tick(); await tick();
    const note = document.querySelector<HTMLElement>('#overlay .browse-note')!;
    expect(note.dataset.i18n).toBe('folder.unavailable');
    expect(field('folder').value).toBe('');
  });

  it('shows the error of a refused request (a window is already open)', async () => {
    pick = { status: 409, body: { code: 'folder.pickBusy' } };
    openNewProjectDialog(() => undefined);
    await tick();
    browse().click();
    await tick(); await tick();
    expect(document.querySelector('#overlay .form-error')!.textContent).not.toBe('');
  });
});

describe('the new-project dialog tells who created the project', () => {
  it('calls onCreated with the project name, after closing, only on success', async () => {
    const onCreated = vi.fn();
    openNewProjectDialog(() => undefined, onCreated);
    await tick();
    field('folder').value = 'D:\\work\\shop-api';
    document.querySelector<HTMLFormElement>('#overlay form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(); await tick();
    expect(onCreated).toHaveBeenCalledWith('shop-api');
    expect(document.getElementById('overlay')!.hidden).toBe(true);

    onCreated.mockClear();
    created = { status: 409, body: { code: 'project.duplicate' } };
    openNewProjectDialog(() => undefined, onCreated);
    await tick();
    field('folder').value = 'D:\\work\\shop-api';
    document.querySelector<HTMLFormElement>('#overlay form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(); await tick();
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe('the new-project dialog asks only for the folder', () => {
  const submit = (): void => { document.querySelector<HTMLFormElement>('#overlay form')!.dispatchEvent(new Event('submit', { cancelable: true })); };
  const posted = (): unknown => calls.find((c) => c.path === '/api/projects' && c.method === 'POST')!.body;

  it('has no template or command field (the name is proposed from the folder), and sends the folder with auto', async () => {
    openNewProjectDialog(() => undefined);
    await tick();
    expect(document.querySelector('#overlay select')).toBeNull();
    for (const n of ['create', 'build', 'test', 'lint']) expect(field(n)).toBeNull();
    expect(field('name').closest('label')!.hidden).toBe(false);
    field('folder').value = 'D:\\work\\shop-api';
    submit();
    await tick(); await tick(); await tick();
    expect(posted()).toEqual({ root: 'D:\\work\\shop-api', auto: true, create: false });
  });

  it('with another project open it offers to start from its settings, and sends copyFrom only when one is picked', async () => {
    const withProjects = () => ({ projects: [{ name: 'alpha-site', root: 'D:\a', waiting: 0, mainStatus: 'running' }] }) as never;
    openNewProjectDialog(withProjects);
    await tick();
    const menu = document.querySelector<HTMLSelectElement>('#overlay select[name="copyFrom"]')!;
    expect([...menu.options].map((o) => o.value)).toEqual(['', 'alpha-site']);
    field('folder').value = 'D:\work\shop-api';
    submit();
    await tick(); await tick(); await tick();
    expect(posted()).toEqual({ root: 'D:\work\shop-api', auto: true, create: false }); // "none" is the default: nothing sent
    calls.length = 0; // a created project closes the dialog: open it again
    openNewProjectDialog(withProjects);
    await tick();
    field('folder').value = 'D:\work\shop-api';
    document.querySelector<HTMLSelectElement>('#overlay select[name="copyFrom"]')!.value = 'alpha-site';
    submit();
    await tick(); await tick(); await tick();
    expect(posted()).toEqual({ root: 'D:\work\shop-api', auto: true, create: false, copyFrom: 'alpha-site' });
  });

  it('a folder that does not exist yet says it will be created, and is sent with create', async () => {
    vi.stubGlobal('fetch', async (path: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      calls.push({ path, method, body: init?.body ? JSON.parse(init.body) : undefined });
      const answer = (status: number, body: unknown) => ({ status, json: async () => body });
      if (path.startsWith('/api/projects/detect')) return answer(422, { code: 'project.badRoot' });
      return answer(201, { name: 'fresh' });
    });
    openNewProjectDialog(() => undefined);
    await tick();
    field('folder').value = 'D:\\work\\fresh';
    field('folder').dispatchEvent(new Event('blur'));
    await tick(); await tick();
    expect(document.querySelector<HTMLElement>('#overlay .create-note')!.dataset.i18n).toBe('projects.new.willCreate');
    submit();
    await tick(); await tick(); await tick();
    expect(posted()).toMatchObject({ create: true, auto: true });
  });

  it('a refused name (taken or unusable) keeps the name field filled from the folder and moves the cursor to it', async () => {
    created = { status: 409, body: { code: 'project.duplicate' } };
    openNewProjectDialog(() => undefined);
    await tick();
    field('folder').value = 'D:\\work\\Shop API';
    submit();
    await tick(); await tick(); await tick();
    expect(field('name').closest('label')!.hidden).toBe(false);
    expect(field('name').value).toBe('shop-api');
  });
});

describe('the welcome screen (no project open)', () => {
  it('hides the project chrome, asks for a project at once, and reloads the page once a project exists', async () => {
    const reload = vi.fn();
    showWelcome({ reload });
    await tick();
    expect(document.getElementById('topbar')!.hidden).toBe(true);
    expect(document.getElementById('workspace')!.hidden).toBe(true);
    expect(document.getElementById('statusbar')!.hidden).toBe(true);
    const welcome = document.getElementById('welcome')!;
    expect(welcome.querySelector('h1')!.dataset.i18n).toBe('welcome.title');
    expect(document.getElementById('overlay')!.hidden).toBe(false); // the folder question is already open
    expect(field('folder')).not.toBeNull();

    field('folder').value = 'D:\\work\\shop-api';
    document.querySelector<HTMLFormElement>('#overlay form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(); await tick();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps a button to ask again after the dialog was closed', async () => {
    showWelcome({ reload: vi.fn() });
    await tick();
    document.querySelector<HTMLButtonElement>('#overlay .form-actions button[type="button"]')!.click(); // Cancel
    expect(document.getElementById('overlay')!.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>('#welcome button.welcome-choose')!.click();
    await tick();
    expect(document.getElementById('overlay')!.hidden).toBe(false);
  });
});
