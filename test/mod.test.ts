import { it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const modDir = join(__dirname, '..', 'mod');
const hasClaude = spawnSync('claude', ['--version'], { shell: process.platform === 'win32' }).status === 0;
const validate = () => execFileSync('claude', ['plugin', 'validate', modDir], { encoding: 'utf8', shell: process.platform === 'win32' });

it.skipIf(!hasClaude)('claude plugin validate accepts the mod and lists the expected hooks and calls', () => {
  const out = validate();
  expect(out).toMatch(/Validation passed/);
  for (const hook of ['session.start', 'session.end', 'turn.start', 'turn.complete', 'tool.call{tool=AskUserQuestion}',
    'tool.call{tool=mcp__console-mod__spawn_agent}', 'tool.call{tool=mcp__console-mod__list_agents}', 'tool.call{tool=mcp__console-mod__ask_user}']) {
    expect(out, hook).toContain(hook);
  }
  for (const call of ['$.http.fetch', '$.tool.register', '$.prompt.submit', '$.clock.every', '$.session.id', '$.session.usage']) {
    expect(out, call).toContain(call);
  }
});
it.skipIf(!hasClaude)('reads exactly the four console variables from the environment', () => {
  const line = validate().split('\n').find((l) => l.includes('env reads')) ?? '';
  expect(line).toContain('CONSOLE_AGENT, CONSOLE_ROLE, CONSOLE_TOKEN, CONSOLE_URL');
  expect(line.match(/CONSOLE_\w+/g)?.length).toBe(4);
});
it('the module has no setTimeout and no dynamic env names (not available or refused inside a mod)', () => {
  const src = readFileSync(join(modDir, 'hooks', 'register.js'), 'utf8');
  expect(src).not.toMatch(/setTimeout|setInterval/);
  for (const m of src.matchAll(/\$\.env\.get\(([^)]*)\)/g)) expect(m[1]).toMatch(/^'CONSOLE_[A-Z]+'$/);
});
it('the manifest names the plugin console-mod (tool names are mcp__console-mod__<tool>)', () => {
  const manifest = JSON.parse(readFileSync(join(modDir, '.claude-plugin', 'plugin.json'), 'utf8'));
  expect(manifest.name).toBe('console-mod');
});
// `claude plugin validate` cuts its hook list ("... [+N chars]") before the hooks added last, so the Phase 5 hooks are checked by
// name in the module itself; their call ($.session.usage) is in the validator's calls line above.
it('the Phase 5 hooks are registered by name in the module', () => {
  const src = readFileSync(join(modDir, 'hooks', 'register.js'), 'utf8');
  expect(src).toContain("on('session.measure'");
  for (const tool of ['start_recovery', 'recovery_report', 'resume_agent', 'archive_agent', 'worktree_cleanup']) expect(src, tool).toContain(`{ tool: 'mcp__console-mod__${tool}' }`);
  expect(src).toContain('$.session.usage()');
});

it('send_message is registered for the main and the agents, with its call, and last', () => {
  const src = readFileSync(join(modDir, 'hooks', 'register.js'), 'utf8');
  expect(src).toMatch(/main: \[[^\]]*'send_message'/);
  expect(src).toMatch(/agent: \[[^\]]*'send_message'/);
  expect(src).not.toMatch(/(reviewer|recovery): \[[^\]]*'send_message'/);
  expect(src).toContain("{ tool: 'mcp__console-mod__send_message' }");
  expect(src).toContain("if (name === 'send_message') return { to: e.to, type: e.type, text: e.text, in_reply_to: e.in_reply_to, step:");
  // Last: `claude plugin validate` cuts its hook list, so new hooks go after every earlier one.
  expect(src.indexOf("mcp__console-mod__send_message' }")).toBeGreaterThan(src.indexOf("on('tool.call', { tool: 'Task' }"));
});
