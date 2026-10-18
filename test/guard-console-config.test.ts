// Rule path.console-config: no session (main or agent) changes Claude Code's settings files or the console mod's folder, which would let it
// load other hooks or switch off the guard and the release answer (SPEC 14, 15.5). Reading them, and editing files next to them, stays allowed.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluate, type GuardContext } from '../src/server/guard/rules';
import { DEFAULT_SECRET_PATTERNS } from '../src/server/git/secrets';
import { removeDir } from './git-helpers';

let root: string;
let W: string;
let MOD: string;
let ctx: GuardContext;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'guard-cfg-'));
  W = join(root, 'repo');
  MOD = join(root, 'app', 'mod');
  mkdirSync(join(W, '.claude'), { recursive: true });
  mkdirSync(join(MOD, 'hooks'), { recursive: true });
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
  it('allows the files next to them and reading them', () => {
    expect(rule(role, 'Write', { file_path: '.claude/agents/helper.md' })).toBe('allow');
    expect(rule(role, 'Write', { file_path: 'settings.json' })).toBe('allow');
    expect(rule(role, 'Write', { file_path: 'src/.claude-settings.json' })).toBe('allow');
    expect(rule(role, 'Read', { file_path: '.claude/settings.json' })).toBe('allow');
    expect(rule(role, 'Bash', { command: 'cat .claude/settings.json' })).toBe('allow');
    expect(rule(role, 'Bash', { command: 'echo x > notes.txt' })).toBe('allow');
  });
});
