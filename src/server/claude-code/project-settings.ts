import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What a session the console launches may not run: a push to a protected branch or of tags. A deny rule holds in every permission mode,
 * bypass included. The rules live in a file under the project's `.andromedaconsole` and reach Claude Code through `--settings` on the
 * sessions the console starts, so they are not in the user's repository, in `.claude/` or in a git hook: a `claude` started by hand in the
 * folder, the user's own `git push`, and a project from which `.andromedaconsole` was deleted are untouched. The console releases with its own
 * git call after the user approves (SPEC 15.5); the guard refuses the same pushes in every session.
 */
export const PROTECTED_PUSH_DENY = [
  'Bash(git push *main*)', 'Bash(git push *master*)', 'Bash(git push *develop*)', 'Bash(git push *trunk*)', 'Bash(git push *release/*)',
  'Bash(git push *--tags*)', 'Bash(git push *--follow-tags*)',
] as const;

/** Writes the settings file of the project's sessions (rewritten at every launch, so it never goes stale) and returns its path. */
export function writeSessionSettings(projectRoot: string): string {
  const dir = join(projectRoot, '.andromedaconsole', 'state');
  const file = join(dir, 'session-settings.json');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ permissions: { deny: [...PROTECTED_PUSH_DENY] } }, null, 2)}\n`, 'utf8');
  return file;
}
