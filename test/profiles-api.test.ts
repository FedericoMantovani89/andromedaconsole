import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { autoClose, bootServer, configFileOf, ui } from './helpers';
import { loadProfile, validateProfileInput } from '../src/server/profiles';

autoClose();

const entry = (over: Record<string, unknown> = {}) => ({ name: 'docs-writer', description: 'Writes the docs.', model: '', budgetTokens: null, readOnly: false, body: 'You write documentation.', ...over });

describe('profiles API', () => {
  it('lists the shipped profiles, creates one of the user, offers it to the new-agent menu and deletes it', async () => {
    const s = await bootServer();
    const first = await ui(s, '/api/profiles');
    expect(first.status).toBe(200);
    expect(first.body.map((p: { name: string }) => p.name)).toEqual(['developer', 'backend', 'frontend', 'dba', 'reviewer', 'recovery']);
    expect(first.body.every((p: { shipped: boolean; userFile: boolean }) => p.shipped && !p.userFile)).toBe(true);

    const made = await ui(s, '/api/profiles/docs-writer', 'PUT', entry({ budgetTokens: 250000, readOnly: true, model: 'claude-opus-5-5' }));
    expect(made.status).toBe(200);
    const file = join(dirname(configFileOf(s)), 'profiles', 'docs-writer.md');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('budget_tokens: 250000');
    expect(text).toContain('read_only: true');
    // The same reader the spawn flow uses sees what was written.
    expect(loadProfile('docs-writer', '/nowhere', join(dirname(configFileOf(s)), 'profiles'))).toMatchObject({ readOnly: true, budgetTokens: 250000, model: 'claude-opus-5-5', body: 'You write documentation.' });
    expect((await ui(s, '/api/state')).body.profiles).toContain('docs-writer');

    expect((await ui(s, '/api/profiles/docs-writer', 'DELETE')).status).toBe(200);
    expect(existsSync(file)).toBe(false);
    expect((await ui(s, '/api/profiles/docs-writer', 'DELETE')).status).toBe(404);
    expect((await ui(s, '/api/state')).body.profiles).not.toContain('docs-writer');
  });

  it('a shipped profile is edited as a copy and restored by removing it; restore-all keeps the user\'s own profiles', async () => {
    const s = await bootServer();
    await ui(s, '/api/profiles/developer', 'PUT', entry({ name: 'developer', body: 'My own rules.' }));
    await ui(s, '/api/profiles/docs-writer', 'PUT', entry());
    const edited = (await ui(s, '/api/profiles')).body.find((p: { name: string }) => p.name === 'developer');
    expect(edited).toMatchObject({ shipped: true, userFile: true, body: 'My own rules.' });

    expect((await ui(s, '/api/profiles/restore', 'POST')).body).toEqual({ restored: 1 });
    const after = (await ui(s, '/api/profiles')).body as { name: string; userFile: boolean; body: string }[];
    expect(after.find((p) => p.name === 'developer')).toMatchObject({ userFile: false });
    expect(after.find((p) => p.name === 'developer')!.body).not.toContain('My own rules.');
    expect(after.find((p) => p.name === 'docs-writer')).toMatchObject({ userFile: true });
  });

  it('refuses an entry that is not valid and a name that differs from the path', async () => {
    const s = await bootServer();
    const bad = await ui(s, '/api/profiles/docs-writer', 'PUT', entry({ budgetTokens: 10 }));
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: 'profile.fieldInvalid', params: { field: 'budgetTokens' } });
    expect((await ui(s, '/api/profiles/other-name', 'PUT', entry())).status).toBe(422);
    expect((await ui(s, '/api/profiles/docs-writer', 'PUT', entry({ body: '   ' }))).status).toBe(422);
    expect((await ui(s, '/api/profiles')).body.some((p: { name: string }) => p.name === 'docs-writer')).toBe(false);
  });
});

describe('validateProfileInput', () => {
  it.each([
    [{ name: 'Bad Name' }, 'name'], [{ name: 'a'.repeat(41) }, 'name'], [{ description: 'two\nlines' }, 'description'],
    [{ model: 'has space' }, 'model'], [{ budgetTokens: 1.5 }, 'budgetTokens'], [{ readOnly: 'yes' }, 'readOnly'], [{ body: '' }, 'body'],
  ])('%j names the field %s', (over, field) => {
    expect(validateProfileInput(entry(over))).toEqual({ ok: false, field });
  });
  it('turns the model "default" into no model and trims the text', () => {
    expect(validateProfileInput(entry({ model: 'default', body: '  text  ' }))).toMatchObject({ ok: true, input: { model: '', body: 'text' } });
  });
});
