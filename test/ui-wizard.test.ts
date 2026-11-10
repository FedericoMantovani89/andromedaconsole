// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openWizard } from '../src/ui/wizard';
import type { StateMessage } from '../src/shared/protocol';

const base = { language: 'auto', languages: ['en', 'it'], prereq: [{ id: 'git', status: 'ok', version: '2.50', required: true }], project: { name: 'p' }, projectRoot: 'D:/p', repos: [''] };
const repo = { ...base, projectIsRepo: true } as unknown as StateMessage;
const noRepo = { ...base, projectIsRepo: false, repos: [] } as unknown as StateMessage;
const cell = (n: number): HTMLElement => document.querySelector<HTMLElement>(`#overlay .wizard-actions > :nth-child(${n})`)!;
const next = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('#overlay .wizard-next')!;
const back = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('#overlay .wizard-back');
const title = (): string | undefined => document.querySelector<HTMLElement>('#overlay .wizard-head h2')?.dataset.i18n;
const progress = (): Record<string, number> => JSON.parse(document.querySelector<HTMLElement>('#overlay .wizard-eyebrow')!.dataset.i18nParams!);
const flush = () => new Promise((r) => setTimeout(r, 0));
const posts: string[] = [];

beforeEach(() => {
  posts.length = 0;
  document.body.innerHTML = '<div id="overlay" hidden></div>';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') posts.push(url);
    return { status: 200, json: async () => (url === '/api/prereq/recheck' ? base.prereq : {}) };
  }));
});

describe('first-start wizard', () => {
  it('the language step: one heading (the step) with "First start, step n of m" above it, only existing languages, no Back and no Skip', () => {
    openWizard(() => repo);
    expect(title()).toBe('wizard.step.language');
    expect(progress()).toEqual({ n: 1, total: 2 });
    expect([...document.querySelectorAll<HTMLOptionElement>('#overlay select option')].map((o) => o.value)).toEqual(['en', 'it']);
    expect(document.querySelector<HTMLSelectElement>('#overlay select')!.value).toBe('en'); // a saved "auto" shows English
    expect(back()).toBeNull();
    expect([...document.querySelectorAll('#overlay button')].map((b) => b.getAttribute('data-i18n-title'))).toEqual(['common.next']);
  });

  it('Back on the left, the recheck button in the middle, Next on the right; with a repository the prerequisites are the last step', async () => {
    openWizard(() => repo);
    next().click();
    await flush();
    expect(title()).toBe('wizard.step.prerequisites');
    expect(cell(1).querySelector('button')).toBe(back());
    expect(cell(2).querySelector('button')!.dataset.i18nTitle).toBe('prereq.recheck');
    expect(cell(3).querySelector('button')).toBe(next());
    expect(next().dataset.i18nTitle).toBe('wizard.finish');
    back()!.click();
    await flush();
    expect(title()).toBe('wizard.step.language');
    expect(back()).toBeNull();
  });

  it('a folder that is not a repository adds an optional Git step with git init, and Finish ends it either way', async () => {
    openWizard(() => noRepo);
    expect(progress()).toEqual({ n: 1, total: 3 });
    next().click();
    await flush();
    expect(next().dataset.i18nTitle).toBe('common.next');
    next().click();
    await flush();
    expect(title()).toBe('wizard.step.git');
    expect(document.querySelector('#overlay button[name="gitInit"]')).not.toBeNull();
    expect(next().dataset.i18nTitle).toBe('wizard.finish');
    document.querySelector<HTMLButtonElement>('#overlay button[name="gitInit"]')!.click();
    await flush();
    expect(posts).toContain('/api/projects/git-init');
    next().click();
    await flush();
    expect(posts).not.toContain('/api/config'); // saved with PUT, not POST
    expect(document.getElementById('overlay')!.hidden).toBe(true);
  });
});
