import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitError } from './worktree';
import { SLUG_RE } from '../../shared/slug';

const BRANCH = /^[A-Za-z0-9._/-]+$/;

/** The pre-push script (SPEC 9.5): only the agent's own branch, never a force, a delete or a tag. */
const script = (branch: string): string => `#!/bin/sh
own="refs/heads/${branch}"
zero="0000000000000000000000000000000000000000"
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" != "$own" ]; then
    echo "console pre-push: refusing to push $remote_ref (this worktree may only push ${branch})" >&2
    exit 1
  fi
  if [ "$local_sha" = "$zero" ]; then
    echo "console pre-push: refusing to delete a remote branch" >&2
    exit 1
  fi
  if [ "$remote_sha" != "$zero" ] && ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
    echo "console pre-push: refusing a non-fast-forward push (force is not allowed)" >&2
    exit 1
  fi
done
exit 0
`;

/** Where an agent's hook script lives: under the project's `.andromedaconsole`, outside every worktree (the agent's files never contain it). */
export const hooksDirFor = (projectRoot: string, slug: string): string => join(projectRoot, '.andromedaconsole', 'state', 'hooks', slug);

/**
 * The pre-push hook of ONE agent session (SPEC 9.5). The script is written under the project's `.andromedaconsole` and git is pointed at it
 * through the session's environment (`GIT_CONFIG_COUNT`/`KEY`/`VALUE`, which outrank every config file), so nothing is put in the user's
 * repository: no hooks folder in `.git`, no `core.hooksPath` or `extensions.worktreeConfig` in its config. It applies to the git commands the
 * session runs; the user's own terminal and the console's own git calls are not affected. A variable the user already set is kept: ours is
 * added after it. Note: `git push --no-verify` skips hooks, and so does unsetting these variables; the guard denies both.
 */
export function pushHookEnv(o: { projectRoot: string; branch: string; slug: string; base?: NodeJS.ProcessEnv }): Record<string, string> {
  if (!BRANCH.test(o.branch)) throw new GitError('git.badName', `invalid branch name ${o.branch}`);
  if (!SLUG_RE.test(o.slug)) throw new GitError('git.badName', `invalid slug ${o.slug}`);
  const dir = hooksDirFor(o.projectRoot, o.slug);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'pre-push');
  writeFileSync(file, script(o.branch), { encoding: 'utf8', mode: 0o755 });
  try { chmodSync(file, 0o755); } catch { /* not meaningful on Windows */ }
  const had = Number((o.base ?? process.env).GIT_CONFIG_COUNT);
  const n = Number.isInteger(had) && had >= 0 ? had : 0;
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${n}`]: dir.replace(/\\/g, '/'),
  };
}
