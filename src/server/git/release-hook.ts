import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { commonDir } from './worktree';

/** The marker the console's old main-repository pre-push hook carried; only a hook with it is ever removed. */
const MARKER = '# console-release-hook';

export type ReleaseHookResult = 'removed' | 'none' | 'kept_foreign';

/**
 * Earlier versions installed a `pre-push` hook in the user's repository that refused `main` and tags to everybody but the console. That
 * was too invasive for a repository the user also uses by hand: the protection now lives in the project's `.claude/settings.local.json`
 * (`project-settings.ts`) and in the guard. This takes our old hook away; a hook the project has of its own is never touched.
 */
export async function removeReleaseHook(repo: string): Promise<ReleaseHookResult> {
  const file = join(await commonDir(repo), 'hooks', 'pre-push');
  if (!existsSync(file)) return 'none';
  if (!readFileSync(file, 'utf8').includes(MARKER)) return 'kept_foreign';
  rmSync(file, { force: true });
  return 'removed';
}
