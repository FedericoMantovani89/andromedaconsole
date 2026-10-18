import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../src/server/project-store';
import { detectedTestCommands, testCommandFor } from '../src/server/test-commands';
import { saveTemplate } from '../src/server/templates/save';
import { findTemplate } from '../src/server/templates/load';
import { applyTemplate } from '../src/server/templates/apply';
import { copyProjectSettings } from '../src/server/templates/copy';
import { autoClose, bootServer, state, ui } from './helpers';
import { makeMultiRepo, removeDir } from './git-helpers';

vi.setConfig({ testTimeout: 60_000 });
autoClose();
const folder = (): string => mkdtempSync(join(tmpdir(), 'tc-'));

it('the store keeps testCommands per key, trims, merges, and an empty string clears one key', () => {
  const root = folder();
  const s = new ProjectStore(root);
  s.init('shop-api');
  expect(s.project.testCommands).toBeUndefined();
  s.setTestCommands({ ticket: '  npm run test:ticket ', merge: 'npm run test:smoke' });
  expect(new ProjectStore(root).project.testCommands).toEqual({ ticket: 'npm run test:ticket', merge: 'npm run test:smoke' });
  s.setTestCommands({ release: 'npm test', merge: '' });
  expect(s.project.testCommands).toEqual({ ticket: 'npm run test:ticket', release: 'npm test' });
  s.setTestCommands({ ticket: '', release: '' });
  expect(s.project.testCommands).toBeUndefined();
  expect(s.project.name).toBe('shop-api');
});

it('the store refuses a bad testCommands and changes nothing', () => {
  const s = new ProjectStore(folder());
  s.init('shop-api');
  s.setTestCommands({ ticket: 'ok' });
  for (const bad of [{ ticket: 'a\nb' }, { merge: 'x'.repeat(501) }, { release: 5 }, { other: 'x' }, 'npm test', null, ['a']]) {
    expect(() => s.setTestCommands(bad as never), JSON.stringify(bad)).toThrow('project.testCommandInvalid');
  }
  expect(s.project.testCommands).toEqual({ ticket: 'ok' });
});

it('testCommandFor: the moment key, else testCommand, else the detected one; disabled means none', () => {
  const base = { testCommand: 'npm test' as string | undefined, testCommands: { ticket: ' fast ', merge: 'smoke' } as Record<string, string> | undefined, testsDisabled: false };
  const detected = (): string => 'detected';
  const pick = (m: 'ticket' | 'merge' | 'release', p: Partial<typeof base> = {}) => testCommandFor(m, { project: () => ({ ...base, ...p }), detected });
  expect(pick('ticket')).toBe('fast');
  expect(pick('merge')).toBe('smoke');
  expect(pick('release')).toBe('npm test'); // not set: the single command
  expect(pick('release', { testCommand: undefined })).toBe('detected');
  expect(pick('ticket', { testCommands: undefined })).toBe('npm test');
  expect(pick('ticket', { testCommands: { ticket: '  ' } })).toBe('npm test');
  expect(pick('ticket', { testsDisabled: true })).toBeUndefined();
  expect(pick('release', { testsDisabled: true })).toBeUndefined();
  expect(testCommandFor('ticket', { project: () => { throw new Error('damaged'); }, detected })).toBe('detected'); // a damaged project.json: as with no settings
});

describe('testCommandFor in the folder a run happens in (a project folder that holds several repositories)', () => {
  /** `abc-website` holds `abc-be` (pom.xml) and `abc-fe` (package.json with a test script); the folder itself has neither. */
  const multi = (): { root: string; be: string; fe: string } => {
    const root = folder();
    const be = join(root, 'abc-be');
    const fe = join(root, 'abc-fe');
    mkdirSync(be);
    mkdirSync(fe);
    writeFileSync(join(be, 'pom.xml'), '<project/>');
    writeFileSync(join(fe, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    return { root, be, fe };
  };
  const nothingSaved = (): Record<string, never> => ({});

  it('detects the command of the repository it runs in, and nothing in the bare project folder', () => {
    const { root, be, fe } = multi();
    const d = { project: nothingSaved, detected: detectedTestCommands(root) };
    expect(testCommandFor('ticket', d, be)).toMatch(/mvn test$/);
    expect(testCommandFor('merge', d, fe)).toBe('npm test');
    expect(testCommandFor('ticket', d)).toBeUndefined();
  });
  it('a project folder that is the repository gives the same command with or without the folder', () => {
    const root = folder();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    const d = { project: nothingSaved, detected: detectedTestCommands(root) };
    expect(testCommandFor('ticket', d)).toBe('npm test');
    expect(testCommandFor('ticket', d, root)).toBe('npm test');
  });
  it('with the tests inhibited there is none, in whichever folder', () => {
    const { root, be } = multi();
    const d = { project: () => ({ testsDisabled: true, testCommand: 'npm test' }), detected: detectedTestCommands(root) };
    expect(testCommandFor('ticket', d, be)).toBeUndefined();
    expect(testCommandFor('release', d)).toBeUndefined();
  });
  it("the project's own command wins over the detected one", () => {
    const { root, be } = multi();
    const d = { project: () => ({ testCommand: 'my test', testCommands: { merge: 'smoke' } }), detected: detectedTestCommands(root) };
    expect(testCommandFor('ticket', d, be)).toBe('my test');
    expect(testCommandFor('merge', d, be)).toBe('smoke');
  });
  it('keeps each folder for 5 s, then reads it again', () => {
    const { root, be } = multi();
    let now = 1_000;
    const detected = detectedTestCommands(root, () => now);
    expect(detected(be)).toMatch(/mvn test$/);
    rmSync(join(be, 'pom.xml'));
    expect(detected(be)).toMatch(/mvn test$/); // within 5 s: the kept answer
    now += 5_001;
    expect(detected(be)).toBeUndefined();
  });
});

describe("a repository's own test command (repoTestCommands, keyed by the repository folder name)", () => {
  it('the store keeps one per repository, trims, merges, clears with an empty string and touches no other field', () => {
    const root = folder();
    const s = new ProjectStore(root);
    s.init('abc-website');
    s.setTestCommands({ ticket: 'fast' });
    s.setRepoTestCommands({ 'abc-be': '  mvn -q test ', 'abc-fe': 'npm test' }, ['abc-be', 'abc-fe']);
    expect(new ProjectStore(root).project.repoTestCommands).toEqual({ 'abc-be': 'mvn -q test', 'abc-fe': 'npm test' });
    s.setRepoTestCommands({ 'abc-fe': '' }, ['abc-be', 'abc-fe']);
    expect(s.project.repoTestCommands).toEqual({ 'abc-be': 'mvn -q test' });
    expect(s.project).toMatchObject({ name: 'abc-website', testCommands: { ticket: 'fast' } });
    s.setRepoTestCommands({ 'abc-be': '' }, ['abc-be', 'abc-fe']);
    expect(s.project.repoTestCommands).toBeUndefined();
    expect(Object.keys(JSON.parse(readFileSync(join(root, '.andromedaconsole', 'project.json'), 'utf8'))).sort()).toEqual(['createdAt', 'name', 'testCommands']);
  });
  it('the store refuses a bad command or an unknown repository and changes nothing', () => {
    const s = new ProjectStore(folder());
    s.init('abc-website');
    s.setRepoTestCommands({ 'abc-be': 'ok' }, ['abc-be', 'abc-fe']);
    for (const bad of [{ 'abc-be': 'a\nb' }, { 'abc-fe': 'x'.repeat(501) }, { 'abc-be': 5 }, 'npm test', null, ['a'], { 'abc-fe': 'fine', 'abc-be': 'a\rb' }]) {
      expect(() => s.setRepoTestCommands(bad as never, ['abc-be', 'abc-fe']), JSON.stringify(bad)).toThrow('project.testCommandInvalid');
    }
    expect(() => s.setRepoTestCommands({ 'abc-fe': 'npm test', 'abc-xx': 'x' }, ['abc-be', 'abc-fe'])).toThrow('project.repoUnknown');
    expect(s.project.repoTestCommands).toEqual({ 'abc-be': 'ok' });
    s.setRepoTestCommands({ gone: '' }, ['abc-be']); // a repository that left the folder can still be cleared
    expect(s.project.repoTestCommands).toEqual({ 'abc-be': 'ok' });
  });
  it("testCommandFor: the repository's command beats the moment's, the single one and the detected one; the tests inhibited still win", () => {
    const p = { testCommand: 'npm test', testCommands: { ticket: 'fast' }, repoTestCommands: { 'abc-be': ' mvn -q test ' } as Record<string, string> };
    const d = { project: () => p, detected: (): string => 'detected' };
    for (const m of ['ticket', 'merge', 'release'] as const) expect(testCommandFor(m, d, 'C:/wt', 'abc-be'), m).toBe('mvn -q test');
    expect(testCommandFor('ticket', d, 'C:/wt', 'abc-fe')).toBe('fast'); // no command of its own: the project's
    expect(testCommandFor('merge', d, 'C:/wt', 'abc-fe')).toBe('npm test');
    expect(testCommandFor('ticket', d, 'C:/wt')).toBe('fast');
    expect(testCommandFor('release', { project: () => ({ repoTestCommands: { 'abc-fe': '  ' } }), detected: () => 'detected' }, 'C:/wt', 'abc-fe')).toBe('detected');
    expect(testCommandFor('ticket', { project: () => ({ ...p, testsDisabled: true }), detected: () => 'detected' }, 'C:/wt', 'abc-be')).toBeUndefined();
  });
  it('PUT /api/project sets and clears a repository command, the state lists the repositories with what each detects, and an unknown one is refused', async () => {
    const m = makeMultiRepo(['abc-fe', 'abc-be']);
    try {
      writeFileSync(join(m.repos['abc-fe']!.repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
      const s = await bootServer({ projectRoot: m.root });
      const put = (body: unknown) => ui(s, '/api/project', 'PUT', body);
      const before = (await state(s)).project;
      expect(before.repos).toEqual(['abc-be', 'abc-fe']);
      expect(before.detectedRepoTestCommands).toEqual({ 'abc-fe': 'npm test' }); // abc-be has no build file: left out, shown as n/a
      expect(before.detectedTestCommand).toBeUndefined();
      const r = await put({ repoTestCommands: { 'abc-be': 'mvn -q test' } });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ repoTestCommands: { 'abc-be': 'mvn -q test' } });
      expect((await state(s)).project.repoTestCommands).toEqual({ 'abc-be': 'mvn -q test' });
      const unknown = await put({ testCommand: 'changed', repoTestCommands: { 'abc-xx': 'x' } });
      expect(unknown.status).toBe(422);
      expect(unknown.body.code).toBe('project.repoUnknown');
      const bad = await put({ repoTestCommands: { 'abc-fe': 'a\nb' } });
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe('project.testCommandInvalid');
      expect((await ui(s, '/api/project?dryRun=1', 'PUT', { repoTestCommands: { 'abc-fe': 'x' } })).status).toBe(200);
      expect((await state(s)).project).toMatchObject({ repoTestCommands: { 'abc-be': 'mvn -q test' } });
      expect((await state(s)).project.testCommand).toBeUndefined(); // neither the refused nor the dry run wrote
      expect((await put({ repoTestCommands: { 'abc-be': '' } })).body).toEqual({});
      expect((await state(s)).project.repoTestCommands).toBeUndefined();
    } finally { removeDir(m.base); }
  });
  it('a project folder that is the repository lists no repositories and refuses any repository command', async () => {
    const s = await bootServer();
    expect((await state(s)).project.repos).toEqual([]);
    const r = await ui(s, '/api/project', 'PUT', { repoTestCommands: { 'abc-be': 'x' } });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('project.repoUnknown');
  });
});

it('PUT /api/project sets, echoes, merges and clears testCommands; a bad one changes nothing', async () => {
  const s = await bootServer();
  const put = (body: unknown) => ui(s, '/api/project', 'PUT', body);
  const r = await put({ testCommands: { ticket: 'npm run test:ticket', merge: 'npm run test:smoke' } });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ testCommands: { ticket: 'npm run test:ticket', merge: 'npm run test:smoke' } });
  expect((await state(s)).project.testCommands).toEqual({ ticket: 'npm run test:ticket', merge: 'npm run test:smoke' });
  expect((await put({ testCommands: { merge: '' } })).body).toEqual({ testCommands: { ticket: 'npm run test:ticket' } });
  for (const bad of [{ release: 'a\nb' }, { ticket: 'x'.repeat(501) }, { merge: 4 }, { nope: 'x' }, 'npm test']) {
    const f = await put({ testCommand: 'changed', testCommands: bad });
    expect(f.status, JSON.stringify(bad)).toBe(422);
    expect(f.body.code).toBe('project.testCommandInvalid');
  }
  const dry = await ui(s, '/api/project?dryRun=1', 'PUT', { testCommands: { release: 'x' } });
  expect(dry.status).toBe(200);
  expect((await state(s)).project.testCommands).toEqual({ ticket: 'npm run test:ticket' }); // neither the dry run nor the bad ones wrote
  expect((await state(s)).project.testCommand).toBeUndefined();
});

it('a template saved from a project carries testCommands, and applying and copying keep them', async () => {
  const root = folder();
  const store = new ProjectStore(root);
  store.init('shop-api');
  store.setTestCommand('npm test');
  store.setTestCommands({ ticket: 'fast', merge: 'smoke', release: 'full' });
  const configDir = folder();
  expect(saveTemplate({ projectRoot: root, project: store.project, configDir, id: 'with-tests' }).ok).toBe(true);
  const t = findTemplate('with-tests', { configDir })!;
  expect(t.valid, t.reason).toBe(true);
  expect(t.data!.commands).toMatchObject({ test: 'npm test', testTicket: 'fast', testMerge: 'smoke', testRelease: 'full' });
  const other = folder();
  expect(await applyTemplate({ templateId: 'with-tests', root: other, name: 'copy', create: false, configDir })).toEqual({ ok: true });
  expect(JSON.parse(readFileSync(join(other, '.andromedaconsole', 'project.json'), 'utf8')).testCommands).toEqual({ ticket: 'fast', merge: 'smoke', release: 'full' });
  const third = folder();
  expect(copyProjectSettings(root, third, 'third')).toEqual({ ok: true });
  expect(new ProjectStore(third).project.testCommands).toEqual({ ticket: 'fast', merge: 'smoke', release: 'full' });
  const bare = folder();
  new ProjectStore(bare).init('bare');
  expect(copyProjectSettings(bare, third, 'third')).toEqual({ ok: true });
  expect(new ProjectStore(third).project.testCommands).toBeUndefined(); // the two end up alike
});

it('package.json defines test:ticket and test:smoke', () => {
  const scripts = JSON.parse(readFileSync(join(dirname(import.meta.dirname), 'package.json'), 'utf8')).scripts as Record<string, string>;
  expect(scripts['test:ticket']).toBe('tsx scripts/test-ticket.ts'); // the base branch is project/<name>, found by the script
  // From a plain checkout (no ticket worktree) the base is origin/main: project/<name> may be many commits behind and select every file.
  expect(scripts['test:changed']).toBe('npm run check && vitest run --changed origin/main --passWithNoTests');
  expect(scripts['test:smoke']).toMatch(/^npm run check && vitest run /);
  for (const f of ['server', 'merge-ticket', 'spawn', 'pty-manager', 'git-worktree', 'v1', 'i18n-checks']) expect(scripts['test:smoke']).toContain(`test/${f}.test.ts`);
});
