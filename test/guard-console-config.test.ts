// Rule path.console-config: no session (main or agent) changes Claude Code's settings files or the console mod's folder, which would let it
// load other hooks or switch off the guard and the release answer (SPEC 14, 15.5). Reading them, and editing files next to them, stays allowed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  it('refuses writing Claude Code settings files and the mod folder', () => {
    for (const file of ['.claude/settings.json', '.claude/settings.local.json', join(W, '.claude', 'settings.json'), '.claude\\Settings.Local.json']) {
      for (const tool of ['Write', 'Edit']) expect(rule(role, tool, { file_path: file }), `${tool} ${file}`).toBe('path.console-config');
    }
    expect(rule(role, 'Write', { file_path: join(MOD, 'hooks', 'register.js') })).toBe('path.console-config');
    expect(rule(role, 'Edit', { file_path: join(MOD, 'hooks', 'hooks.json') })).toBe('path.console-config');
  });
  it('refuses shell writes to them', () => {
    expect(rule(role, 'Bash', { command: 'echo {} > .claude/settings.local.json' })).toBe('path.console-config');
    expect(rule(role, 'PowerShell', { command: 'Set-Content .claude\\settings.json x' })).toBe('path.console-config');
    expect(rule(role, 'Bash', { command: 'rm .claude/settings.json' })).toBe('path.console-config');
  });
  it('judges the path as Windows resolves it: after a cd, with . segments, with a trailing dot on the folder', () => {
    expect(rule(role, 'Bash', { command: 'cd .claude && echo x > settings.local.json' })).toBe('path.console-config');
    expect(rule(role, 'PowerShell', { command: 'Set-Location .claude; Set-Content settings.json x' })).toBe('path.console-config');
    expect(rule(role, 'Write', { file_path: '.claude/./settings.json' })).toBe('path.console-config');
    expect(rule(role, 'Write', { file_path: '.claude.\\settings.json' })).toBe('path.console-config');
    expect(rule(role, 'Write', { file_path: '.claude \\settings.local.json' })).toBe('path.console-config');
    expect(rule(role, 'Write', { file_path: 'src/../.claude/settings.json' })).toBe('path.console-config');
  });
  it('follows a junction to .claude', () => {
    expect(rule(role, 'Write', { file_path: join(W, 'link', 'settings.json') })).toBe('path.console-config');
    expect(rule(role, 'Bash', { command: 'echo x > link/settings.local.json' })).toBe('path.console-config');
  });
  it('expands 8.3 short names (where the volume has them)', (t) => {
    if (!SHORT_DIR || !SHORT_FILE) { t.skip(); return; }
    expect(rule(role, 'Write', { file_path: join(W, SHORT_DIR, 'settings.json') })).toBe('path.console-config');
    expect(rule(role, 'Write', { file_path: join(W, '.claude', SHORT_FILE) })).toBe('path.console-config');
  });
  it('refuses replacing, moving or removing the .claude folder or a folder that holds it', () => {
    for (const command of ['mv .claude old', 'cp -r dir .claude', 'rm -r .claude', 'rm -rf ./.claude/', 'mv . ../elsewhere']) {
      expect(rule(role, 'Bash', { command }), command).toBe('path.console-config');
    }
    for (const command of ['Copy-Item -Recurse dir .claude', 'Move-Item .claude old', 'Remove-Item -Recurse .claude', 'Rename-Item .claude old']) {
      expect(rule(role, 'PowerShell', { command }), command).toBe('path.console-config');
    }
    expect(rule(role, 'Bash', { command: `rm -r "${join(MOD, '..')}"` })).not.toBe('allow'); // the folder holding the mod
  });
  it('leaves the files inside .claude and its worktrees folder alone', () => {
    for (const command of ['cp notes.md .claude/agents/helper.md', 'rm .claude/agents/old.md', 'mkdir .claude/worktrees/x', 'rm -r .claude/worktrees/old', 'mv a.txt b.txt', 'rm -r build']) {
      expect(rule(role, 'Bash', { command }), command).toBe('allow');
    }
    expect(rule(role, 'Write', { file_path: '.claude/settings-schema.json' })).toBe('allow');
    expect(rule(role, 'Write', { file_path: '.claude/worktrees/x/settings.txt' })).toBe('allow');
  });
  it('allows the files next to them and reading them', () => {
    expect(rule(role, 'Write', { file_path: '.claude/agents/helper.md' })).toBe('allow');
    expect(rule(role, 'Write', { file_path: 'settings.json' })).toBe('allow');
    expect(rule(role, 'Write', { file_path: 'src/.claude-settings.json' })).toBe('allow');
    expect(rule(role, 'Read', { file_path: '.claude/settings.json' })).toBe('allow');
    expect(rule(role, 'Bash', { command: 'cat .claude/settings.json' })).toBe('allow');
    expect(rule(role, 'Bash', { command: 'echo x > notes.txt' })).toBe('allow');
  });
});

it('after a cd the guard cannot follow, the main may not write a relative target (it could be .claude); an absolute one is judged', () => {
  expect(rule('main', 'Bash', { command: 'cd $(echo .claude) && echo x > settings.json' })).toBe('path.console-config');
  expect(rule('main', 'Bash', { command: 'popd; echo x > notes.txt' })).toBe('path.console-config');
  expect(rule('main', 'Bash', { command: `popd; echo x > "${join(W, 'notes.txt')}"` })).toBe('allow');
  expect(rule('main', 'Bash', { command: `popd; echo x > "${join(W, '.claude', 'settings.json')}"` })).toBe('path.console-config');
});
