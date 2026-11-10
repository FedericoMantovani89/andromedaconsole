import { it, expect } from 'vitest';
import { buildClaudeLaunch } from '../src/server/claude-code/launch';

const base = {
  command: ['claude'], role: 'agent' as const, slug: 'fix-login', project: 'shop-api',
  url: 'http://127.0.0.1:7391', token: 'SESSION-TOKEN', bypass: false, baseEnv: { PATH: 'p' }, platform: 'linux' as const,
};

it('loads the mod and the profile prompt, with forward-slash paths', () => {
  const l = buildClaudeLaunch({ ...base, pluginDir: 'D:\\work\\mod', appendPromptFile: 'D:\\work\\.andromedaconsole\\p.md' });
  const i = l.args.indexOf('--plugin-dir');
  expect(l.args[i + 1]).toBe('D:/work/mod');
  const j = l.args.indexOf('--append-system-prompt-file');
  expect(l.args[j + 1]).toBe('D:/work/.andromedaconsole/p.md');
});
it('omits both flags when not given (fake agents, mod disabled)', () => {
  const l = buildClaudeLaunch(base);
  expect(l.args).not.toContain('--plugin-dir');
  expect(l.args).not.toContain('--append-system-prompt-file');
});
it('the session token is the one in CONSOLE_TOKEN', () => {
  expect(buildClaudeLaunch(base).env.CONSOLE_TOKEN).toBe('SESSION-TOKEN');
});

it('pre-approves the console tools so they do not stop at a permission prompt, as one comma-separated argument', () => {
  const l = buildClaudeLaunch({ ...base, allowedTools: ['mcp__andromeda-mcp__list_agents', 'mcp__andromeda-mcp__ask_user'] });
  const i = l.args.indexOf('--allowedTools');
  expect(l.args[i + 1]).toBe('mcp__andromeda-mcp__list_agents,mcp__andromeda-mcp__ask_user');
  expect(buildClaudeLaunch(base).args).not.toContain('--allowedTools');
});

it('refuses arguments with cmd.exe metacharacters when the launch goes through cmd.exe (no command injection)', () => {
  const win = { ...base, platform: 'win32' as const };
  for (const model of ['sonnet&calc', 'a|b', 'x>y', 'a^b', '%PATH%', 'a"b', 'a\nb']) {
    expect(() => buildClaudeLaunch({ ...win, model }), model).toThrow(/unsafe/);
  }
  expect(() => buildClaudeLaunch({ ...win, pluginDir: 'D:/R&D/mod' })).toThrow(/unsafe/);
  expect(() => buildClaudeLaunch({ ...win, appendPromptFile: 'D:/x%y/p.md' })).toThrow(/unsafe/);
  expect(() => buildClaudeLaunch({ ...win, model: 'claude-opus-5-5[1m]' })).not.toThrow();
  expect(() => buildClaudeLaunch({ ...win, model: 'sonnet' })).not.toThrow();
});
it('other platforms pass arguments without a shell, so they are not restricted', () => {
  expect(() => buildClaudeLaunch({ ...base, platform: 'linux', model: 'a&b' })).not.toThrow();
});
