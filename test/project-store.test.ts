import { it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/server/project-store';

const repo = () => mkdtempSync(join(tmpdir(), 'project-'));
it('init creates project.json and an empty agents.json', () => {
  const root = repo(); const s = new ProjectStore(root); s.init('shop-api');
  expect(existsSync(join(root, '.andromedaconsole', 'project.json'))).toBe(true);
  expect(existsSync(join(root, '.andromedaconsole', 'state', 'agents.json'))).toBe(true);
  expect(s.project.name).toBe('shop-api');
  expect(s.listAgents()).toEqual([]);
});
it('persists agents across a restart', () => {
  const root = repo(); const s = new ProjectStore(root); s.init('shop-api');
  s.addAgent({ slug: 'fix-login', profile: 'developer' });
  const again = new ProjectStore(root);
  expect(again.project.name).toBe('shop-api');
  expect(again.listAgents().map((a) => [a.slug, a.profile])).toEqual([['fix-login', 'developer']]);
});
it('rejects a duplicate slug', () => {
  const root = repo(); const s = new ProjectStore(root); s.init('shop-api');
  s.addAgent({ slug: 'fix-login', profile: 'developer' });
  expect(() => s.addAgent({ slug: 'fix-login', profile: 'developer' })).toThrow('slug.duplicate');
});
it('init is idempotent and keeps the original creation date', () => {
  const root = repo(); const s = new ProjectStore(root); s.init('shop-api'); const created = s.project.createdAt;
  new ProjectStore(root).init('shop-api');
  expect(new ProjectStore(root).project.createdAt).toBe(created);
});

it('keeps a test command in project.json, trims it, and clears it with an empty string', () => {
  const root = repo(); const s = new ProjectStore(root); s.init('shop-api');
  expect(s.project.testCommand).toBeUndefined();
  s.setTestCommand('  npx vitest run  ');
  expect(new ProjectStore(root).project.testCommand).toBe('npx vitest run');
  expect(new ProjectStore(root).project.name).toBe('shop-api');
  s.setTestCommand('');
  expect(new ProjectStore(root).project.testCommand).toBeUndefined();
});
it('rejects a test command that is too long or not a string', () => {
  const root = repo(); const s = new ProjectStore(root); s.init('shop-api');
  expect(() => s.setTestCommand('x'.repeat(501))).toThrow('project.testCommandInvalid');
  expect(() => s.setTestCommand(5 as unknown as string)).toThrow('project.testCommandInvalid');
  expect(() => s.setTestCommand('a\nb')).toThrow('project.testCommandInvalid');
});

it('squash is off unless the project says true, and the choice is kept next to the other options', () => {
  const root = repo(); const s = new ProjectStore(root); s.init('shop-api');
  expect(s.project.squash).toBeUndefined();
  s.setSquash(false);
  expect(new ProjectStore(root).project.squash).toBe(false);
  s.setTestCommand('npm test');
  expect(new ProjectStore(root).project).toMatchObject({ name: 'shop-api', squash: false, testCommand: 'npm test' });
  s.setSquash(true);
  expect(new ProjectStore(root).project.squash).toBe(true);
  expect(() => s.setSquash('yes' as unknown as boolean)).toThrow('project.squashInvalid');
});
