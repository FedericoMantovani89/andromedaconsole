// Rule path.console-config: no session (main or agent) changes a project's `.claude/settings.local.json` or the console mod's folder, which
// would let it load other hooks or switch off the guard and the release answer (SPEC 14, 15.5). Only that one settings file, on purpose:
// `settings.json`, the user's settings and the `.claude` folder itself stay free for projects that do not use the console.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluate, type GuardContext } from '../src/server/guard/rules';
import { DEFAULT_SECRET_PATTERNS } from '../src/server/git/secrets';
import { removeDir } from './git-helpers';

let root: string;
let W: string;
let MOD: string;
let ctx: GuardContext;
let SHORT_DIR: string | undefined;
let SHORT_FILE: string | undefined;
/** The 8.3 name Windows gave the last component, or undefined when the volume has none (8.3 names are often off). */
function shortName(p: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const r = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${p}") do @echo %~snxI`], { encoding: 'utf8', windowsVerbatimArguments: true });
  const name = r.stdout.trim();
  return name !== '' && name.toLowerCase() !== basename(p).toLowerCase() && name.includes('~') ? name : undefined;
}
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'guard-cfg-'));
  W = join(root, 'repo');
  MOD = join(root, 'app', 'mod');
  mkdirSync(join(W, '.claude'), { recursive: true });
  mkdirSync(join(MOD, 'hooks'), { recursive: true });
  writeFileSync(join(W, '.claude', 'settings.local.json'), '{}');
  symlinkSync(join(W, '.claude'), join(W, 'link'), 'junction');
  SHORT_DIR = shortName(join(W, '.claude'));
  SHORT_FILE = shortName(join(W, '.claude', 'settings.local.json'));
  ctx = { worktree: W, repo: W, branch: 'agent/p/a', projectBranch: 'project/p', secretPatterns: DEFAULT_SECRET_PATTERNS, modDir: MOD };
});
afterAll(() => removeDir(root));

const rule = (role: 'main' | 'agent', tool: string, input: Record<string, unknown>): string => {
  const d = evaluate({ role, tool, input }, ctx);
  return d.decision === 'deny' ? d.rule : 'allow';
};

describe.each(['main', 'agent'] as const)('%s', (role) => {
  it('refuses writing .claude/settings.local.json and the mod folder', () => {
    for (const file of ['.claude/settings.local.json', join(W, '.claude', 'settings.local.json'), '.claude\\Settings.Local.json']) {
      for (const tool of ['Write', 'Edit']) expect(rule(role, tool, { file_path: file }), `${tool} ${file}`).toBe('path.console-config');
    }
    expect(rule(role, 'Write', { file_path: join(MOD, 'hooks', 'register.js') })).toBe('path.console-config');
    expect(rule(role, 'Edit', { file_path: join(MOD, 'hooks', 'hooks.json') })).toBe('path.console-config');
  });
  it('refuses shell writes to it', () => {
    expect(rule(role, 'Bash', { command: 'echo {} > .claude/settings.local.json' })).toBe('path.console-config');
    expect(rule(role, 'PowerShell', { command: 'Set-Content .claude\\settings.local.json x' })).toBe('path.console-config');
    expect(rule(role, 'Bash', { command: 'rm .claude/settings.local.json' })).toBe('path.console-config');
  });
  it('judges the path as Windows resolves it: after a cd, with . segments, with a trailing dot or space on the folder', () => {
    expect(rule(role, 'Bash', { command: 'cd .claude && echo x > settings.local.json' })).toBe('path.console-config');
    expect(rule(role, 'PowerShell', { command: 'Set-Location .claude; Set-Content settings.local.json x' })).toBe('path.console-config');
    expect(rule(role, 'Write', { file_path: '.claude/./settings.local.json' })).toBe('path.console-config');
    expect(rule(role, 'Write', { file_path: '.claude.\\settings.local.json' })).toBe('path.console-config');
    expect(rule(role, 'Write', { file_path: '.claude \\settings.local.json' })).toBe('path.console-config');
    expect(rule(role, 'Write', { file_path: 'src/../.claude/settings.local.json' })).toBe('path.console-config');
  });
  it('follows a junction to .claude', () => {
    expect(rule(role, 'Write', { file_path: join(W, 'link', 'settings.local.json') })).toBe('path.console-config');
    expect(rule(role, 'Bash', { command: 'echo x > link/settings.local.json' })).toBe('path.console-config');
  });
  it('expands 8.3 short names (where the volume has them)', (t) => {
    if (!SHORT_DIR || !SHORT_FILE) { t.skip(); return; }
    expect(rule(role, 'Write', { file_path: join(W, SHORT_DIR, 'settings.local.json') })).toBe('path.console-config');
    expect(rule(role, 'Write', { file_path: join(W, '.claude', SHORT_FILE) })).toBe('path.console-config');
  });
  it('leaves settings.json, the .claude folder itself and the other files in it alone (projects that do not use the console)', () => {
    for (const file of ['.claude/settings.json', '.claude/./settings.json', join(homedir(), '.claude', 'settings.json'), '.claude/settings-schema.json', '.claude/agents/helper.md', '.claude/worktrees/x/settings.txt']) {
      expect(rule(role === 'agent' && file.startsWith(homedir()) ? 'main' : role, 'Write', { file_path: file }), file).toBe('allow');
    }
    for (const command of ['echo {} > .claude/settings.json', 'mv .claude old', 'cp -r dir .claude', 'rm -r .claude', 'cp notes.md .claude/agents/helper.md', 'rm -r .claude/worktrees/old', 'mv a.txt b.txt']) {
      expect(rule(role, 'Bash', { command }), command).toBe('allow');
    }
    expect(rule(role, 'PowerShell', { command: 'Copy-Item -Recurse dir .claude' })).toBe('allow');
  });
  it('allows the files next to it and reading it', () => {
    expect(rule(role, 'Write', { file_path: 'settings.local.json' })).toBe('allow');
    expect(rule(role, 'Write', { file_path: 'src/.claude-settings.local.json' })).toBe('allow');
    expect(rule(role, 'Read', { file_path: '.claude/settings.local.json' })).toBe('allow');
    expect(rule(role, 'Bash', { command: 'cat .claude/settings.local.json' })).toBe('allow');
    expect(rule(role, 'Bash', { command: 'echo x > notes.txt' })).toBe('allow');
  });
});

it('after a cd the guard cannot follow, the main may not write a relative settings.local.json; other targets are judged as before', () => {
  expect(rule('main', 'Bash', { command: 'cd $(echo .claude) && echo x > settings.local.json' })).toBe('path.console-config');
  expect(rule('main', 'Bash', { command: 'popd; echo x > settings.local.json' })).toBe('path.console-config');
  expect(rule('main', 'Bash', { command: 'popd; echo x > notes.txt' })).toBe('allow');
  expect(rule('main', 'Bash', { command: 'popd; echo x > settings.json' })).toBe('allow');
  expect(rule('main', 'Bash', { command: `popd; echo x > "${join(W, '.claude', 'settings.local.json')}"` })).toBe('path.console-config');
});
