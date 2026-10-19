import { existsSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { git } from './git';
import { discoverRepos, repoPathOf } from './repos';
import { removeTryCheckouts } from './try-checkout';
import { commonDir, removeWorktree } from './worktree';

const lower = (p: string): string => resolve(p).replace(/\\/g, '/').toLowerCase();
const inside = (p: string, folder: string): boolean => lower(p).startsWith(`${lower(folder)}/`);

/**
 * Takes a project back to "never opened": removes the worktrees the console made for it (the try checkouts too; also the ones of the earlier layout, next to
 * the repository), the branches `agent/<project>/*` and `project/<project>`, the push-hook folders of its agents and the project's `.andromedaconsole`.
 * Never touches anything else in the project. Every step is best effort: a branch checked out by the user simply stays.
 * The sessions must be stopped first. `slugs` are the agents on record (their hook folders), `worktrees` the paths on record.
 */
export async function purgeProject(o: { projectRoot: string; project: string; slugs: string[]; worktrees: string[] }): Promise<void> {
  const consoleDir = join(resolve(o.projectRoot), '.andromedaconsole');
  // The try checkouts go through git first; one git cannot remove now is still caught below, with every other worktree under .andromedaconsole.
  await removeTryCheckouts({ projectRoot: o.projectRoot, repos: discoverRepos(o.projectRoot).map((name) => ({ name, path: repoPathOf(o.projectRoot, name) })) }).catch(() => undefined);
  const mine = new Set(o.worktrees.map(lower));
  for (const rel of discoverRepos(o.projectRoot)) {
    const repo = repoPathOf(o.projectRoot, rel);
    const listed = await git(repo, ['worktree', 'list', '--porcelain']);
    if (listed.code === 0) {
      for (const block of listed.stdout.split(/\r?\n\r?\n/)) {
        const path = /^worktree (.+)$/m.exec(block)?.[1];
        const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? '';
        if (path === undefined || lower(path) === lower(repo)) continue;
        const ours = inside(path, consoleDir) || mine.has(lower(path)) || branch.startsWith(`agent/${o.project}/`) || branch === `project/${o.project}`;
        if (ours) await removeWorktree(repo, path);
      }
    }
    const refs = await git(repo, ['for-each-ref', '--format=%(refname:short)', `refs/heads/agent/${o.project}/`, `refs/heads/project/${o.project}`]);
    if (refs.code === 0) {
      for (const branch of refs.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) await git(repo, ['branch', '-D', branch]);
    }
    try {
      const hooks = join(await commonDir(repo), 'console-hooks');
      for (const slug of o.slugs) rmSync(join(hooks, slug), { recursive: true, force: true });
    } catch { /* nothing to remove */ }
    // The earlier layout's folder next to the repository goes too, once nothing is left in it.
    const sibling = join(dirname(repo), `${basename(repo)}.worktrees`);
    try { if (existsSync(sibling) && readdirSync(sibling).length === 0) rmdirSync(sibling); } catch { /* not empty or in use */ }
  }
  rmSync(consoleDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
