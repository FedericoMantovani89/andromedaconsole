import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '../http';
import { ModelCatalog } from '../catalog/models';
import { PluginCatalog } from '../catalog/plugins';
import { GuardLog } from '../guard/log';
import { repoPathOf } from '../git/repos';
import { TryCheckoutService } from '../git/try-checkout';
import { NullNotifier, ToastNotifier, type Notifier } from '../notify/notifier';
import { Presence } from '../notify/presence';
import { NotificationService, realNotifyClock, type NotifyClock } from '../notify/service';
import { appRoot, resourcePath } from '../paths';
import { resolveVersion } from '../version';
import { applyConfig } from './apply-config';
import { guardCall } from './guard-call';
import { handleModEvent } from './mod-events';
import type { ProjectContainer } from './services';
import { agentTools } from './tools/agents';
import { messageTools } from './tools/messages';
import { ticketTools } from './tools/tickets';

/** The clock of the notification grouping and quiet hours (a test seam, else the real one). */
const clockOf = (k: ProjectContainer): NotifyClock => k.get('env').o.notifyClock ?? realNotifyClock;

/** What the HTTP layer sees: the notifications, the guard log, the push to the UI, and the `Context` itself with its tool handlers. */
export function registerHttpContext(c: ProjectContainer): void {
  // The port, the prerequisite checks and the language are console-wide (see `shared`); any change pushes to every UI socket.
  c.provide('broadcast', (k) => (): void => k.get('env').shared.broadcastAll());
  c.provide('guardLog', (k) => new GuardLog(join(k.get('env').o.projectRoot, '.andromedaconsole', 'state', 'guard.jsonl')));
  // Notifications (SPEC 20): the server raises a native toast for what needs the user, also with the browser closed.
  c.provide('notifier', (k): Notifier => k.get('env').o.notifier ?? (process.env.CONSOLE_TEST === '1' || process.env.VITEST ? new NullNotifier() : new ToastNotifier()));
  c.provide('presence', (k) => { const notifyClock = clockOf(k); return new Presence(() => notifyClock.now()); });
  c.provide('notify', (k) => {
    const { shared, config } = k.get('env');
    const notifyClock = clockOf(k);
    const notifier = k.get('notifier');
    const presence = k.get('presence');
    const reportLanguage = k.get('reportLanguage');
    const projectName = k.get('projectName');
    const questions = k.get('questions');
    const broadcast = k.get('broadcast');
    return new NotificationService({
      config: () => config.notifications, notifier, presence, clock: notifyClock,
      translate: () => reportLanguage().t,
      clickUrl: (itemId) => `http://127.0.0.1:${shared.getPort()}/?code=${shared.loginCode()}&project=${encodeURIComponent(projectName)}${itemId ? `#queue=${encodeURIComponent(itemId)}` : ''}`,
      isPending: (id) => questions.pending().some((q) => q.id === id),
      pushBrowser: (m) => shared.pushToProject(projectName, m),
      changed: () => broadcast(),
    });
  });
  c.provide('ctx', (k): Context => {
    const { shared, o, configPath, config, token, bundles, ledger, quotaState, sleep, runtime } = k.get('env');
    const notifier = k.get('notifier');
    const presence = k.get('presence');
    const notify = k.get('notify');
    const stateProblems = k.get('stateProblems');
    const ptys = k.get('ptys');
    const store = k.get('store');
    const tokens = k.get('tokens');
    const inbox = k.get('inbox');
    const registry = k.get('registry');
    const scheduler = k.get('scheduler');
    const launchLog = k.get('launchLog');
    const questions = k.get('questions');
    const reading = k.get('reading');
    const tickets = k.get('tickets');
    const steps = k.get('steps');
    const requests = k.get('requests');
    const launchWatch = k.get('launchWatch');
    const review = k.get('review');
    const recovery = k.get('recovery');
    const budget = k.get('budget');
    const restrictions = k.get('restrictions');
    const loop = k.get('loop');
    const waker = k.get('waker');
    const detectedTestCommand = k.get('detectedTestCommand');
    const sessionGuardMode = k.get('sessionGuardMode');
    const projectName = k.get('projectName');
    const repos = k.get('repos');
    const forgetRepos = k.get('forgetRepos');
    const prepareRepo = k.get('prepareRepo');
    const broadcast = k.get('broadcast');
    const ctx: Context = {
      getPort: () => shared.getPort(),
      utilityPtys: shared.utilityPtys, installer: shared.installer, update: () => o.updates?.state(),
      notifier, presence, notify,
      get notificationsConfig() { return config.notifications; },
      applyNotifications: (n) => { config.notifications = n; },
      version: o.version ?? resolveVersion(appRoot()),
      testPosition: (slug) => shared.testQueue.position(slug),
      testQueue: () => shared.testQueue.snapshot(),
      stateProblems,
      token, ptys, store, tokens, inbox, registry, scheduler, launchLog, questions, reading, tickets, steps, requests, launchWatch, review, recovery,
      budget, restrictions, loop, ledger, quotaState, sleep, wake: waker,
      afterWorktreeCreated: o.afterWorktreeCreated,
      get git() { return runtime.git; },
      get budgetConfig() { return config.budget; },
      get guardMode() { return runtime.guardMode; },
      detectedTestCommand,
      modDir: o.modDir === null ? undefined : (o.modDir ?? (config.mod.enabled ? resourcePath('mod') : undefined)),
      promptsDir: join(o.projectRoot, '.andromedaconsole', 'state', 'prompts'),
      guard: guardCall(k),
      afterTool: () => broadcast(),
      // A guard question or a console tool call is a sign of life too: a long turn without events is not a silence.
      activity: (slug) => { const role = registry.get(slug)?.role; if (role !== undefined && role !== 'main') { loop.detector.onModEvent(slug); k.get('refreshSilence')(); } },
      handleModEvent: handleModEvent(k),
      tools: { ...agentTools(k), ...ticketTools(k), ...messageTools(k) },
      projectName,
      projectRoot: o.projectRoot,
      claudeCommand: o.claudeCommand ?? config.claude.command,
      ...(o.prereqRunner ? { commandRunner: o.prereqRunner } : {}),
      get bypass() { return runtime.bypass; },
      get language() { return shared.language(); },
      bundles,
      testMode: process.env.CONSOLE_TEST === '1',
      configPath,
      repos, forgetRepos, prepareRepo,
      tryCheckouts: new TryCheckoutService({ projectRoot: o.projectRoot, project: projectName, repos: () => repos().map((name) => ({ name, path: repoPathOf(o.projectRoot, name) })) }),
      getPrereq: () => shared.getPrereq(),
      getHelperUse: () => shared.helperUsage.state(),
      ensurePrereq: () => shared.ensurePrereq(),
      refreshPrereq: () => shared.refreshPrereq(),
      setLanguage: (l) => { shared.setLanguage(l); },
      applySettings: (s) => {
        if (s.bypass !== undefined) runtime.bypass = s.bypass;
        if (s.guardMode !== undefined) runtime.guardMode = s.guardMode;
      },
      noteLaunch: (slug) => {
        sessionGuardMode.set(slug, runtime.guardMode);
        return { bypass: runtime.bypass };
      },
      needsSetup: () => !existsSync(configPath),
      broadcastState: () => broadcast(),
      projects: shared.projectsApi,
      models: new ModelCatalog({ configDir: o.configDir, config: () => config.models }),
      plugins: new PluginCatalog({ configDir: o.configDir, config: () => config.plugins }),
      applyConfig: applyConfig(k),
    };
    return ctx;
  });
}
