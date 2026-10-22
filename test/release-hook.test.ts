import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeRepo, type TestRepo, removeDir } from './git-helpers';
import { removeReleaseHook } from '../src/server/git/release-hook';
import { PROTECTED_PUSH_DENY, writeSessionSettings } from '../src/server/claude-code/project-settings';
import { buildClaudeLaunch } from '../src/server/claude-code/launch';

const repos: TestRepo[] = [];
const repo = (): TestRepo => { const t = makeRepo({ remote: true }); repos.push(t); return t; };
afterEach(() => { while (repos.length) removeDir(repos.pop()!.base); });

const hookFile = (t: TestRepo): string => join(t.repo, '.git', 'hooks', 'pre-push');

describe('the old main-repository pre-push hook', () => {
  it('is removed when it is the console\'s, and never installed again', async () => {
    const t = repo();
    expect(await removeReleaseHook(t.repo)).toBe('none');
    mkdirSync(join(t.repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(hookFile(t), '#!/bin/sh\n# console-release-hook: refuses pushes\nexit 1\n');
    expect(await removeReleaseHook(t.repo)).toBe('removed');
    expect(existsSync(hookFile(t))).toBe(false);
  });
  it('leaves a hook the project has of its own', async () => {
    const t = repo();
    mkdirSync(join(t.repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(hookFile(t), '#!/bin/sh\necho mine\nexit 0\n');
    expect(await removeReleaseHook(t.repo)).toBe('kept_foreign');
    expect(readFileSync(hookFile(t), 'utf8')).toContain('echo mine');
  });
});

describe('the deny rules of the sessions the console starts', () => {
  it('live in .andromedaconsole, not in .claude or in git, and are rewritten at every launch', () => {
    const t = repo();
    const file = writeSessionSettings(t.repo);
    expect(file).toBe(join(t.repo, '.andromedaconsole', 'state', 'session-settings.json'));
    expect(JSON.parse(readFileSync(file, 'utf8')).permissions.deny).toEqual([...PROTECTED_PUSH_DENY]);
    writeFileSync(file, '{}');
    writeSessionSettings(t.repo);
    expect(JSON.parse(readFileSync(file, 'utf8')).permissions.deny).toEqual([...PROTECTED_PUSH_DENY]);
    expect(existsSync(join(t.repo, '.claude'))).toBe(false);
  });
  it('reach a session through --settings', () => {
    const l = buildClaudeLaunch({ command: ['claude'], role: 'main', slug: 'p', project: 'p', url: 'http://x', token: 't', bypass: false, baseEnv: {}, platform: 'linux', settingsFile: 'D:\\p\\.andromedaconsole\\state\\session-settings.json' });
    expect(l.args[l.args.indexOf('--settings') + 1]).toBe('D:/p/.andromedaconsole/state/session-settings.json');
  });
});
