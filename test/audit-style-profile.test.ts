import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LIMITS, listStyleProfiles, loadStyleProfile, parseStyleProfile, serializeStyleProfile } from '../src/server/audit/style-profile';

const tmp = () => mkdtempSync(join(tmpdir(), 'style-'));
const put = (dir: string, name: string, text: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), text, 'utf8');
};

describe('shipped default', () => {
  it('loads with the spec values', () => {
    const p = loadStyleProfile('default', tmp(), tmp());
    expect(p?.source).toBe('shipped');
    expect(p?.limits).toEqual({ diff_lines: 250, files_touched: 8, file_lines: 600, comment_run_lines: 4, comment_ratio: 0.15 });
    expect(p?.limits).toEqual(DEFAULT_LIMITS);
    expect(p?.commands).toEqual({});
    expect(p?.conventions.length).toBeGreaterThan(10);
  });
});

describe('precedence', () => {
  it('project beats user beats shipped', () => {
    const root = tmp();
    const user = tmp();
    put(user, 'default', '---\nname: default\nlimits:\n  diff_lines: 100\n---\nuser text');
    expect(loadStyleProfile('default', root, user)?.limits.diff_lines).toBe(100);
    expect(loadStyleProfile('default', root, user)?.source).toBe('user');
    put(join(root, '.andromedaconsole', 'style'), 'default', '---\nname: default\nlimits:\n  diff_lines: 50\n---\nproject text');
    const p = loadStyleProfile('default', root, user);
    expect(p?.limits.diff_lines).toBe(50);
    expect(p?.source).toBe('project');
    expect(p?.limits.files_touched).toBe(8); // a limit the file does not state keeps the default
  });

  it('refuses a name that could leave the folder', () => {
    expect(loadStyleProfile('../x', tmp(), tmp())).toBeUndefined();
  });

  it('lists every profile once with its winning source', () => {
    const root = tmp();
    const user = tmp();
    put(user, 'strict', '---\nname: strict\n---\nx');
    put(join(root, '.andromedaconsole', 'style'), 'strict', '---\nname: strict\n---\ny');
    const list = listStyleProfiles(root, user);
    expect(list.find((p) => p.name === 'default')?.source).toBe('shipped');
    expect(list.filter((p) => p.name === 'strict')).toEqual([{ name: 'strict', source: 'project' }]);
  });
});

describe('parseStyleProfile', () => {
  it('round-trips a BOM + CRLF file with an Italian body', () => {
    const text = '﻿---\r\nname: rigido\r\ndescription: Diff piccole\r\nlimits:\r\n  diff_lines: 120\r\n  comment_ratio: 0.1\r\ncommands:\r\n  lint: npx eslint {files}\r\n---\r\nNiente commenti che spiegano il come.\r\n';
    const a = parseStyleProfile(text, 'rigido', 'user');
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.profile.description).toBe('Diff piccole');
    expect(a.profile.commands.lint).toBe('npx eslint {files}');
    expect(a.profile.conventions).toBe('Niente commenti che spiegano il come.');
    const b = parseStyleProfile(serializeStyleProfile(a.profile), 'rigido', 'user');
    expect(b).toEqual(a);
  });

  it.each([
    ['diff_lines: abc', 'diff_lines'],
    ['diff_lines: -1', 'diff_lines'],
    ['comment_ratio: 1.5', 'comment_ratio'],
    ['diff_lines: 2.5', 'diff_lines'],
    ['made_up: 3', 'made_up'],
  ])('rejects the limit line "%s"', (line, key) => {
    const r = parseStyleProfile(`---\nname: x\nlimits:\n  ${line}\n---\nbody`, 'x', 'user');
    expect(r).toEqual({ ok: false, code: 'style.badLimit', params: { key } });
  });

  it('accepts 0 (not checked) as a limit', () => {
    const r = parseStyleProfile('---\nname: x\nlimits:\n  diff_lines: 0\n---\nb', 'x', 'user');
    expect(r.ok && r.profile.limits.diff_lines).toBe(0);
  });

  it('rejects a multi-line, over-long or unknown command', () => {
    const long = `lint: ${'a'.repeat(501)}`;
    expect(parseStyleProfile(`---\nname: x\ncommands:\n  ${long}\n---\nb`, 'x', 'user')).toEqual({ ok: false, code: 'style.badCommand', params: { key: 'lint' } });
    expect(parseStyleProfile('---\nname: x\ncommands:\n  deploy: rm -rf /\n---\nb', 'x', 'user')).toEqual({ ok: false, code: 'style.badCommand', params: { key: 'deploy' } });
  });
});
