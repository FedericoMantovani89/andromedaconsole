import { resolve } from 'node:path';
import type { ProjectInfo, TestMoment } from './project-store';
import { detectProject } from './templates/detect';
import { ownValue } from '../shared/guards';

/** How long the command detected in a folder is kept before its files are read again. */
const DETECT_KEEP_MS = 5000;

/**
 * The test command each folder's files suggest (pom.xml, build.gradle, package.json), kept 5 s per folder. `cwd` is the folder a run
 * happens in (an agent's worktree, a repository's project worktree): a project folder that holds several repositories has no build file
 * of its own, so only its repositories propose a command. Without `cwd`, the project folder.
 */
export function detectedTestCommands(projectRoot: string, now: () => number = Date.now): (cwd?: string) => string | undefined {
  const kept = new Map<string, { at: number; value: string | undefined }>();
  return (cwd) => {
    const dir = resolve(cwd ?? projectRoot);
    const t = now();
    for (const [key, e] of kept) if (t - e.at > DETECT_KEEP_MS) kept.delete(key); // worktrees come and go: no folder is kept for long
    let e = kept.get(dir);
    if (!e) { e = { at: t, value: detectProject(dir).test }; kept.set(dir, e); }
    return e.value;
  };
}

/**
 * The test command the console runs at one moment: the command of `repo` (the repository folder name of a folder that holds several,
 * `Ticket.repo`) for every moment, else the project's command for that moment, else its single `testCommand`, else the one detected from
 * the files of `cwd` (the folder the run happens in; absent: the project folder). With the tests inhibited there is none (every moment
 * then runs nothing and the reports say "not run").
 */
export function testCommandFor(
  moment: TestMoment,
  d: { project(): Pick<ProjectInfo, 'testCommand' | 'testCommands' | 'repoTestCommands' | 'testsDisabled'>; detected(cwd?: string): string | undefined },
  cwd?: string,
  repo?: string,
): string | undefined {
  let p: ReturnType<typeof d.project> = {};
  try { p = d.project(); } catch { /* a damaged project.json: as a project with no settings */ }
  if (p.testsDisabled === true) return undefined;
  const own = repo ? ownValue(p.repoTestCommands, repo)?.trim() : undefined;
  return own || p.testCommands?.[moment]?.trim() || p.testCommand?.trim() || d.detected(cwd);
}

/** The detail of a `no_test_command` refusal, for the agent to pass on: with a repository it names it and the option that sets its command. */
export function noTestCommandDetail(repo: string | undefined): string {
  return repo
    ? `no test command was set for the repository ${repo} or for the project, and none was detected in ${repo} (no build file with a test command): ask the main to set one in the console options (Options, Project, "test command of the repository ${repo}")`
    : 'the project has no test command: ask the main to set it in the console options';
}
