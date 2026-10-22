import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LaunchWatch } from '../agents/launch-watch';
import { AgentRegistry } from '../agents/registry';
import { Scheduler } from '../agents/scheduler';
import { failQueuedStart, launchAgent, MAIN_TOOLS } from '../agents/spawn';
import { defaultProjectsDir, transcriptPath } from '../claude-code/transcript';
import type { QuotaStep } from '../budget/quota';
import { discoverRepos, repoPathOf } from '../git/repos';
import { GitignoreAsked, hasGitignore } from '../git/gitignore';
import { StaleChecker, latestCommitMs } from '../git/stale';
import { commonDir, dropLegacyExclude, removeWorktree } from '../git/worktree';
import { ignoreConsoleFolder } from '../git/console-folder';
import { removeReleaseHook } from '../git/release-hook';
import { writeSessionSettings } from '../claude-code/project-settings';
import { helperToolsText } from '../helper-tools';
import { languageName, listProfileNames, pickableProfiles, renderMainPrompt } from '../profiles';
import { buildClaudeLaunch, SESSION_ID_RE } from '../claude-code/launch';
import { readHandoverNote } from '../tickets/handover';
import { PtyManager } from '../pty/pty-manager';
import { SessionTokens } from '../security';
import type { ProjectContainer } from './services';

/** The services that own the agent sessions: the terminals, their tokens, the registry, the guard mode each session started under, and the repositories. */
export function registerAgents(c: ProjectContainer): void {
  c.provide('ptys', (k) => new PtyManager(k.get('env').o.ptySpawn));
  c.provide('tokens', () => new SessionTokens());
  // The main's last session (state/main.json): the first launch resumes it, so the main keeps its context across a restart.
  // Claude Code keeps no transcript for a session that never got a prompt: resuming that id fails with "No conversation found", so such an id starts fresh.
  c.provide('mainResumeId', (k) => {
    const { o } = k.get('env');
    const store = k.get('store');
    const savedMainSession = store.readMainSession();
    const hasMainTranscript = (id: string): boolean => existsSync(transcriptPath(o.projectsDir ?? defaultProjectsDir(), o.projectRoot, id));
    const resumeId = savedMainSession !== undefined && SESSION_ID_RE.test(savedMainSession) && hasMainTranscript(savedMainSession) ? savedMainSession : undefined;
    return () => resumeId;
  });
  c.provide('registry', (k) => {
    const projectName = k.get('projectName');
    const mainResumeId = k.get('mainResumeId')();
    const registry = new AgentRegistry();
    registry.register({ slug: projectName, role: 'main', profile: 'main', ...(mainResumeId !== undefined ? { sessionId: mainResumeId } : {}) });
    return registry;
  });
  // The guard mode a session was launched under: a later change in Settings does not reach sessions already running.
  c.provide('sessionGuardMode', (k) => {
    const { config } = k.get('env');
    const projectName = k.get('projectName');
    return new Map<string, 'enforce' | 'shadow'>([[projectName, config.guard.mode]]);
  });
  c.provide('launchLog', () => new Map<string, string[]>());

  // The state is rebuilt on every push to the UI and discovery spawns git: a few seconds of memory is plenty (a repo made later shows up soon).
  let repoCache: { at: number; list: string[] } | undefined;
  const preparedRepos = new Set<string>();
  c.provide('repos', (k) => {
    const { o } = k.get('env');
    return (): string[] => {
      const now = Date.now();
      if (!repoCache || now - repoCache.at > 5000) repoCache = { at: now, list: discoverRepos(o.projectRoot) };
      return repoCache.list;
    };
  });
  c.provide('forgetRepos', () => (): void => { repoCache = undefined; });
  c.provide('prepareRepo', (k) => async (path: string): Promise<void> => {
    const key = path.replace(/\\/g, '/').toLowerCase();
    if (preparedRepos.has(key)) return;
    preparedRepos.add(key);
    // The console's own folder never shows in git status (it carries its own .gitignore), and main is pushed only by the console, after the user
    // approves a release (SPEC 9.1, 15.5): sessions are kept from it by the guard and by deny rules in .andromedaconsole (session-settings.json).
    // Nothing of the console stays in the user's repository: what earlier versions put there (an exclude line, a pre-push hook) is taken away.
    const root = k.get('env').o.projectRoot;
    if (resolve(path).toLowerCase() === resolve(root).toLowerCase()) { try { ignoreConsoleFolder(root); } catch { /* cosmetic: the first worktree tries again */ } }
    await dropLegacyExclude(path).catch(() => { /* cosmetic */ });
    await removeReleaseHook(path).catch(() => 'none');
  });

  c.provide('launchWatch', (k) => {
    const { o, shared } = k.get('env');
    const registry = k.get('registry');
    const inbox = k.get('inbox');
    const projectName = k.get('projectName');
    return new LaunchWatch({ registry, delayMs: () => o.launchCheckMs ?? 90_000, notifyMain: (text) => { inbox.push(projectName, text); shared.broadcastAll(); } });
  });
  c.provide('endTimers', () => new Set<ReturnType<typeof setTimeout>>()); // reviewers about to be ended; cancelled at shutdown
  /**
   * Ends a session on purpose: its state becomes "finished", not "interrupted". By default it ended for good (a merged ticket, a
   * finished review) and its own requests are cancelled; `stopped` (a budget or loop stop, a limit suspension, a replacement) means
   * its work goes on later, so its requests and their waiting steps stay for the resume or the replacement.
   */
  c.provide('finishAgent', (k) => {
    const registry = k.get('registry');
    const ptys = k.get('ptys');
    return async (slug: string, opts: { stopped?: boolean } = {}): Promise<void> => {
      const requests = k.get('requests');
      if (opts.stopped) requests.agentStopped(slug);
      else requests.agentGone(slug);
      registry.markFinished(slug, { stopped: opts.stopped === true });
      await ptys.killTree(slug);
    };
  });
  /**
   * A reviewer's or a recovery's work is done once it has spoken: end it a moment later (its tool answer still has to reach it) and
   * remove its checkout and its hook folder.
   */
  c.provide('endReadOnlySession', (k) => {
    const { o } = k.get('env');
    const registry = k.get('registry');
    const endTimers = k.get('endTimers');
    return (slug: string): void => {
      const git = registry.get(slug)?.git;
      const repo = git?.repo ?? o.projectRoot;
      const timer = setTimeout(() => {
        endTimers.delete(timer);
        void k.get('finishAgent')(slug).then(() => (git ? removeWorktree(repo, git.worktree) : undefined)).then(async () => { rmSync(join(await commonDir(repo), 'console-hooks', slug), { recursive: true, force: true }); }).catch(() => undefined);
      }, 3000);
      timer.unref?.();
      endTimers.add(timer);
    };
  });
  /** The handover note an agent wrote in its worktree (`.andromedaconsole/handover.md`), at most 4000 characters; undefined when none. */
  c.provide('readHandover', (k) => {
    const registry = k.get('registry');
    return (slug: string): string | undefined => {
      const worktree = registry.get(slug)?.git?.worktree;
      if (!worktree) return undefined;
      return readHandoverNote(worktree);
    };
  });
  /** At a stop the note goes into the ticket while the worktree is still there (a recovery reads it, a replacement gets it). */
  c.provide('keepHandover', (k) => {
    const tickets = k.get('tickets');
    const readHandover = k.get('readHandover');
    return (slug: string): void => {
      const text = readHandover(slug);
      if (!text) return;
      try { tickets.setHandover(slug, text); } catch { /* no ticket: nothing to keep it in */ }
    };
  });
  /** The repository a ticket belongs to, as a spawn request field (nothing for a project folder that is itself the repository). */
  c.provide('repoOfTicket', (k) => {
    const tickets = k.get('tickets');
    return (slug: string): { repo?: string } => { const repo = tickets.get(slug)?.repo; return repo === undefined ? {} : { repo }; };
  });
  // The quota step the scheduler reads on every decision; the quota service writes it (applyLimits).
  c.provide('quotaStepRef', () => ({ value: 'none' as QuotaStep }));
  // The scheduler's callbacks reach `ctx` lazily, only once the server is running.
  c.provide('scheduler', (k) => {
    const { shared, limits } = k.get('env');
    const registry = k.get('registry');
    const store = k.get('store');
    const ref = k.get('quotaStepRef');
    return new Scheduler({
      registry, limits: () => ({ global: limits.global, perProject: store.fields().maxActive ?? limits.perProject }), multiplier: () => ref.value,
      // The global limit counts the active agents of every open project.
      globalActive: () => shared.runtimes.reduce((n, r) => n + r.parts.scheduler.activeCount(), 0),
      start: (r) => launchAgent(k.get('ctx'), r),
      onStartError: (r) => failQueuedStart(k.get('ctx'), r),
    });
  });
  /**
   * Starts the main session: at startup, and again at a wake-up when its process had ended (`resumeId`: its last session, so it keeps
   * its context). A start after the first one is a new launch: it gets a new token and the settings of this moment.
   */
  c.provide('launchMain', (k) => {
    const { o, shared, config, runtime } = k.get('env');
    const ptys = k.get('ptys');
    const registry = k.get('registry');
    const projectName = k.get('projectName');
    const sessionGuardMode = k.get('sessionGuardMode');
    const tokens = k.get('tokens');
    const launchLog = k.get('launchLog');
    const repos = k.get('repos');
    const store = k.get('store');
    return (resumeId: string | undefined): void => {
      const ctx = k.get('ctx');
      if (ptys.status(projectName) !== 'unknown') {
        // Its last session id is kept: a relaunch that fails before reporting in is followed by a `--resume` on the next probe.
        const sessionId = registry.get(projectName)?.sessionId;
        registry.register({ slug: projectName, role: 'main', profile: 'main', ...(sessionId !== undefined ? { sessionId } : {}) });
        sessionGuardMode.set(projectName, runtime.guardMode);
      }
      const launch = buildClaudeLaunch({
        command: ctx.claudeCommand, role: 'main', slug: projectName, project: projectName,
        url: `http://127.0.0.1:${shared.getPort()}`, token: tokens.issue(projectName), bypass: ctx.bypass, baseEnv: process.env,
        pluginDir: ctx.modDir, displayName: `${projectName} AndromedaConsole`,
        ...(ctx.modDir ? { settingsFile: writeSessionSettings(o.projectRoot) } : {}),
        allowedTools: ctx.modDir ? [...MAIN_TOOLS, ...(config.notifications.mainPush ? ['PushNotification'] : [])] : undefined,
        appendPromptFile: renderMainPrompt({ project: projectName, workLanguage: languageName(config.language), outDir: ctx.promptsDir, projectRoot: o.projectRoot, repos: repos(), profiles: pickableProfiles(store.fields().profiles, listProfileNames(o.projectRoot, join(o.configDir, 'profiles'))), helpers: helperToolsText(shared.getPrereq()), mainPush: config.notifications.mainPush,
          noGitignore: new GitignoreAsked(join(o.projectRoot, '.andromedaconsole', 'state', 'gitignore-asked.json')).take(repos().filter((rel) => !hasGitignore(repoPathOf(o.projectRoot, rel)))) }),
        ...(resumeId !== undefined ? { resumeId } : {}),
      });
      ptys.spawn({ id: projectName, ...launch, cwd: resolve(o.projectRoot), cols: 120, rows: 30 });
      launchLog.set(projectName, launch.args);
    };
  });
  c.provide('staleChecker', (k) => {
    const { shared, runtime } = k.get('env');
    const repos = k.get('repos');
    const store = k.get('store');
    const registry = k.get('registry');
    const ptys = k.get('ptys');
    const tickets = k.get('tickets');
    const inbox = k.get('inbox');
    const projectName = k.get('projectName');
    const ticketStatusOf = (slug: string) => { try { return tickets.get(slug)?.status; } catch { return undefined; } };
    return new StaleChecker({
      enabled: () => repos().length > 0 && runtime.git.worktrees && runtime.git.staleCheck,
      days: () => runtime.git.staleWorktreeDays,
      now: () => Date.now(),
      candidates: () => {
        const records = new Map(store.listAgents().map((a) => [a.slug, a]));
        return registry.list()
          .filter((a) => a.role === 'agent' && a.git !== undefined && ptys.status(a.slug) !== 'running' && a.state !== 'queued' && ticketStatusOf(a.slug) !== 'merged' && ticketStatusOf(a.slug) !== 'released')
          .map((a) => ({ slug: a.slug, worktree: a.git!.worktree, ...(records.get(a.slug)?.lastActiveAt ? { lastActiveAt: records.get(a.slug)!.lastActiveAt } : {}), ...(records.get(a.slug)?.stale ? { stale: true } : {}) }));
      },
      latestCommitMs,
      setStale: (slug, stale) => { store.updateAgent(slug, { stale: stale ? true : undefined }); },
      tellMain: (text) => { inbox.push(projectName, text); },
      changed: () => shared.broadcastAll(),
    });
  });
}
