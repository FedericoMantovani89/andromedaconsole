import { createTranslator } from '../../shared/i18n';
import type { TestMoment } from '../project-store';
import { detectedTestCommands, testCommandFor } from '../test-commands';
import type { TestRunner } from '../tickets/test-queue';
import type { ProjectContainer } from './services';

/** The services that decide which test command runs, how it runs, and in which language the reports are written. */
export function registerTests(c: ProjectContainer): void {
  // The command the files of a folder suggest (pom.xml, build.gradle, package.json): the folder a run happens in, else the project folder.
  c.provide('detectedTestCommand', (k) => detectedTestCommands(k.get('env').o.projectRoot));
  // With the tests inhibited there is no command at all: the merge, the release and the recovery then run nothing (they already skip an empty one).
  c.provide('testsDisabled', (k) => { const store = k.get('store'); return (): boolean => { try { return store.project.testsDisabled === true; } catch { return false; } }; });
  // One command per moment: the repository's own (`repo`, a folder of several repositories), else the project's own for `ticket`
  // (validation step, review re-run, recovery), `merge` or `release`, else its single command, else the one detected in `cwd`, the
  // repository folder the run happens in.
  c.provide('testCommandAt', (k) => {
    const store = k.get('store');
    const detectedTestCommand = k.get('detectedTestCommand');
    return (moment: TestMoment) => (cwd?: string, repo?: string): string | undefined => testCommandFor(moment, { project: () => store.project, detected: detectedTestCommand }, cwd, repo);
  });
  /**
   * The test runs go through the machine's queue. A run is heavy (it takes the queue's one slot) unless it is a `ticket` run of the
   * project's own `testCommands.ticket`: a project that defines it says that command is the fast, pointed one. `merge`, `release` and the
   * central run are always heavy; a ticket run of anything else (the full `testCommand`, a repository's own command) is heavy too.
   */
  c.provide('testRunnerAt', (k) => {
    const { shared } = k.get('env');
    const store = k.get('store');
    const projectName = k.get('projectName');
    return (moment: TestMoment): TestRunner => (r) => shared.testQueue.run({
      cwd: r.cwd, command: r.command, timeoutMs: r.timeoutMs,
      heavy: moment !== 'ticket' || r.command.trim() !== store.project.testCommands?.ticket?.trim(),
      label: `${moment}:${r.owner ?? projectName}`,
      ...(r.owner !== undefined ? { owner: r.owner } : {}),
      ...(r.watchOwner && r.owner !== undefined ? { ownerAlive: () => k.get('registry').get(r.owner!)?.state !== 'finished' && k.get('ptys').status(r.owner!) === 'running' } : {}),
    });
  });
  c.provide('reportLanguage', (k) => {
    const { shared, bundles } = k.get('env');
    return () => {
      const language = shared.language();
      const lang = language !== 'auto' && bundles.has(language) ? language : 'en';
      return { lang, t: createTranslator({ lang, messages: bundles.get(lang) ?? {}, fallback: bundles.get('en') }) };
    };
  });
}
