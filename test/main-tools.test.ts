import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MAIN_TOOLS } from '../src/server/agents/spawn';

it('every tool the mod registers for the main may be called without a permission prompt', () => {
  const mod = readFileSync('mod/hooks/register.js', 'utf8');
  const list = /main: \[([^\]]*)\]/.exec(mod)?.[1] ?? '';
  const registered = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => `mcp__andromeda-mcp__${m[1]}`);
  expect(registered.length).toBeGreaterThan(5);
  for (const t of registered) expect(MAIN_TOOLS).toContain(t);
});
