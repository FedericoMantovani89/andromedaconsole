import http from 'node:http';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalFolder } from './canonical-path';
import type { AddressInfo } from 'node:net';
import { createRequestHandler, type Context, type HostContext } from './http';
import { attachWebSockets } from './ws';
import { loadBundles, type Bundles } from './i18n-bundles';
import { loadConfig } from './config';
import { PROJECT_NAME_RE, ProjectError, type AddProjectOptions, type ProjectsApi } from './projects-api';
import { projectNameFromDir } from './cli-args';
import { ProjectStore } from './project-store';
import { PtyManager, type PtySpawn } from './pty/pty-manager';
import { hardenExecutableSearch } from './exe-search';
import { installProcessGuards } from './crash-log';
import { detectProject } from './templates/detect';
import { createToken, LoginCodes } from './security';
import { appRoot, resourcePath } from './paths';
import { UiAssets } from './ui-assets';
import type { UpdateControl } from '../shared/update';
import { TestQueue } from './tickets/test-queue';
import { createTranslator } from '../shared/i18n';
import { resolveVersion } from './version';
import { repoPathOf } from './git/repos';
import { HelperUsage, type HelperUse } from './helper-usage';
import { runChecks, type Runner } from './prereq/checks';
import type { ProjectTab, PrereqResult } from '../shared/protocol';
import { Ledger } from './budget/ledger';
import { QuotaState } from './budget/quota';
import { SleepTimer, type SleepClock, type SleepState } from './budget/sleep';
import { writeJsonAtomic } from './fs-atomic';
import { InstallService, type InstallEntry } from './prereq/install';
import type { Notifier } from './notify/notifier';
import type { NotifyClock } from './notify/service';
import { createFolderPicker, type PickFolderResult } from './pick-folder';
import { readJsonFile, readJsonState } from './json-file';
import { errorMessage } from '../shared/guards';
import { Container, boot } from './runtime/container';
import type { Services, ProjectContainer } from './runtime/services';
import { registerState } from './runtime/state';
import { registerTests } from './runtime/tests';
import { registerAgents } from './runtime/agents';
import { registerTicketFlow } from './runtime/ticket-flow';
import { registerBudget, WAKE_MESSAGE } from './runtime/budget';
import { registerHttpContext } from './runtime/http-context';
import { registerLifecycle } from './runtime/lifecycle';
import { wire } from './runtime/wiring';
import { BOOT_BEFORE_PREPARE, BOOT_AFTER_PREPARE } from './runtime/boot-order';
import type { Env } from './runtime/env';
import type { Shared, ProjectRuntime } from './runtime/types';
export type { ProjectRuntime } from './runtime/types';

export interface StartOptions {
  port: number;
  /** The project folder to open first. Absent: only the projects remembered in `<configDir>/projects.json` are opened (possibly none: the welcome screen). */
  projectRoot?: string;
  configDir: string;
  projectName?: string;
  /** A test seam: replaces the native "choose a folder" window. */
  pickFolder?: () => Promise<PickFolderResult>;
  /** The desktop app's update control (SPEC 33.4); absent when the console runs from a terminal. */
  updates?: UpdateControl;
  /** A test seam: replaces the network call to Groq of the voice dictation. */
  groqFetch?: typeof fetch;
  /** Folder with messages_<lang>.properties (default: the shipped ones; tests). */
  i18nDir?: string;
  claudeCommand?: string[];
  /** Folder of the console mod. Default: the shipped one when `mod.enabled`; `null` launches sessions without the mod. */
  modDir?: string | null;
  /** Injectable command runner for the prerequisite checks (tests). */
  prereqRunner?: Runner;
  /** Build version override (tests); default: the latest tag on main of the console's own repository. */
  version?: string;
  /** How long after a launch the console checks that the agent started and took its goal (default 90 s; tests use less). */
  launchCheckMs?: number;
  /** Overrides `git.worktrees` from the configuration (embedding and tests: agents share the project folder when false). */
  worktrees?: boolean;
  /** A test seam: runs once an agent's worktree exists, before its process starts; a throw simulates a failed start. */
  afterWorktreeCreated?: (slug: string) => void | Promise<void>;
  /** Where Claude Code keeps its transcripts (default `~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects`); tests use a temp folder. */
  projectsDir?: string;
  /** How often the budget grace period is checked without a turn (default 30 s; tests use less). */
  tickMs?: number;
  /** A test seam: the clock of the requests between agents (the timeout is counted on it). */
  requestNow?: () => number;
  /** A test seam: the clock of the sleep timer (the real one is used by default). */
  sleepClock?: SleepClock;
  /** A test seam: replaces the shipped table of installable tools (Phase 6F), so a test runs a trivial command instead of winget. */
  installTable?: readonly InstallEntry[];
  /** A test seam: the runner that probes for winget/npm before an install is offered. */
  installRunner?: Runner;
  /** A test seam: what raises the toasts (default: the native toast, or nothing under tests). */
  notifier?: Notifier;
  /** A test seam: the clock of the notification grouping and quiet hours. */
  notifyClock?: NotifyClock;
  /** A test seam: starts the sessions' processes with this instead of a pseudo terminal (plain pipes: tests that never read the screen). */
  ptySpawn?: PtySpawn;
  /** A test seam: hears each service of a project as the container creates it (the creation order). */
  containerOnCreate?: (key: string) => void;
}
export interface RunningServer {
  port: number;
  address: string;
  token: string;
  url: string;
  /** The address that opens the page: it carries a new single-use code, never the token. */
  loginUrl(): string;
  /** Token a launched session uses on /v1 (tests and in-process callers). */
  sessionTokenFor(slug: string): string | undefined;
  /** Queues a message for a session; the mod delivers it as a new turn. Returns the message id. */
  sendMessage(slug: string, text: string): string;
  writeToSession(slug: string, data: string): void;
  /** Changes the active-agent limits at runtime (SPEC 16.7); running agents are never stopped. */
  setLimits(l: { global: number; perProject: number }): void;
  /** Changes the token budget of an agent's ticket (a test seam, like `setLimits`); the step is recomputed from the usage. */
  setBudgetLimit(slug: string, limit: number): void;
  /** Arguments the session was launched with (a test seam). */
  lastLaunchArgs(slug: string): string[] | undefined;
  /** Opens another project (Phase 6C), as `POST /api/projects` does; refuses with a `ProjectError`. */
  addProject(root: string, name?: string): Promise<{ name: string }>;
  /** Closes a project (its sessions end; nothing is deleted on disk); refused for the last open project. */
  closeProject(name: string, purge?: boolean): Promise<void>;
  /** The open projects, in the order they were opened. */
  projects(): ProjectTab[];
  /** Agent sessions (not the mains) whose process is running, over every project: the desktop app asks before closing with any. */
  runningAgentCount(): number;
  close(): Promise<void>;
}

/** The one message the main gets when a usage limit resets (SPEC 18.4). */
export { WAKE_MESSAGE };

/** The options and shared parts a project's services read as `env`. */
function envOf(shared: Shared, o: StartOptions & { projectRoot: string; projectName: string }): Env {
  const { configPath, config, token, bundles, ledger, quotaState, sleep, sleepClock, runtime, limits } = shared;
  return { shared, o, configPath, config, token, bundles, ledger, quotaState, sleep, sleepClock, runtime, limits };
}

/** The per-project part of the console: everything bound to one folder (Phase 6C: a project runtime; `startServer` hosts the first one). */
async function createProjectRuntime(shared: Shared, p: { projectRoot: string; projectName: string }): Promise<ProjectRuntime> {
  const o: StartOptions & { projectRoot: string; projectName: string } = { ...shared.o, projectRoot: canonicalFolder(p.projectRoot), projectName: p.projectName };
  const c: ProjectContainer = new Container<Services>(shared.o.containerOnCreate ? { onCreate: (key) => shared.o.containerOnCreate?.(String(key)) } : {});
  c.provide('env', () => envOf(shared, o));
  registerState(c);
  registerTests(c);
  registerAgents(c);
  registerTicketFlow(c);
  registerBudget(c);
  registerHttpContext(c);
  registerLifecycle(c);
  boot(c, BOOT_BEFORE_PREPARE);
  for (const rel of c.get('repos')()) await c.get('prepareRepo')(repoPathOf(o.projectRoot, rel));
  boot(c, BOOT_AFTER_PREPARE);
  await c.get('ctx').tryCheckouts.refresh(); // what git has registered: the try checkouts outlive a restart of the console
  wire(c);
  return {
    ctx: c.get('ctx'), name: c.get('projectName'), root: o.projectRoot,
    // The prerequisite checks start with the console (background; unknown is null in the state and agent creation waits for it).
    start: () => { c.get('startProject')(); },
    summary: c.get('summary'),
    onQuota: c.get('onQuotaReading'),
    wakeMain: c.get('wakeMain'),
    weeklyNotice: c.get('weeklyNotice'),
    parts: { budget: c.get('budget'), scheduler: c.get('scheduler') },
    close: c.get('close'),
  };
}

/** Where the open projects are remembered between runs. */
const projectsFile = (configDir: string): string => join(configDir, 'projects.json');

/** The remembered projects; a damaged or missing file is no projects. */
function readProjectsFile(configDir: string): { root: string; name: string }[] {
  // A damaged file is set aside (never overwritten by the next save) and the console says so; it then opens without remembered projects.
  const s = readJsonState(projectsFile(configDir), (file, movedTo) => console.warn(`console: ${file} could not be read; it was kept as ${movedTo}`));
  const parsed = s.status === 'ok' ? s.value : undefined;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((p): p is { root: string; name: string } => typeof p?.root === 'string' && typeof p?.name === 'string');
}

/** The same folder, as the projects compare it: resolved, and case-insensitive on Windows. */
const sameFolder = (a: string, b: string): boolean => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/**
 * Starts the console: one HTTP+WebSocket server on 127.0.0.1 hosting the projects (Phase 6C). The project of `o.projectRoot` is opened
 * first, then the projects remembered in `<configDir>/projects.json` whose folder still exists; each has its own runtime and main session.
 */
export async function startServer(o: StartOptions): Promise<RunningServer> {
  hardenExecutableSearch(); // before the first git or claude is started
  const removeProcessGuards = installProcessGuards(join(o.configDir, 'errors.log')); // an unhandled rejection is logged there and does not stop the console
  const configPath = join(o.configDir, 'config.json');
  const { config } = loadConfig(configPath);
  const token = createToken();
  const loginCodes = new LoginCodes();
  const sleepFile = join(o.configDir, 'state', 'sleep.json');
  const sleepClock: SleepClock = o.sleepClock ?? {
    now: () => Date.now(),
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; },
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  let port = 0;
  let language: string = config.language;
  let prereq: PrereqResult[] | null = null;
  let startupChecks: Promise<PrereqResult[]> | undefined;
  const runtimes: ProjectRuntime[] = [];
  // Opening or closing a project is one at a time: two requests for the same folder must not both pass the duplicate check.
  let projectChain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = projectChain.then(fn);
    projectChain = run.catch(() => undefined);
    return run;
  };
  let closing = false;

  // What the request handler needs from the console itself: it answers even when no project is open.
  const host: HostContext = {
    getPort: () => port, token, loginCodes, assets: new UiAssets(resourcePath('dist', 'ui'), process.env.CONSOLE_APP_ROOT === undefined), configDir: o.configDir,
    version: o.version ?? resolveVersion(appRoot()),
    get bundles() { return shared.bundles; },
    get projects() { return shared.projectsApi; },
    ensurePrereq: () => shared.ensurePrereq(),
    // The window's title follows the interface language ("auto" is resolved by the browser, so the server uses English for it).
    ...(o.updates ? { updates: o.updates } : {}),
    ...(o.groqFetch ? { groqFetch: o.groqFetch } : {}),
    pickFolder: o.pickFolder ?? createFolderPicker({
      title: () => {
        const lang = shared.language() !== 'auto' && shared.bundles.has(shared.language()) ? shared.language() : 'en';
        const t = createTranslator({ lang, messages: shared.bundles.get(lang) ?? {}, fallback: shared.bundles.get('en') });
        return t('folder.pick.title');
      },
    }),
    info: () => ({ projects: runtimes.map((r) => r.summary()), language: shared.language(), languages: [...shared.bundles.keys()].sort(), needsSetup: !existsSync(configPath) }),
  };
  const server = http.createServer((req, res) => {
    void createRequestHandler(projectCtx, host)(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'internal' }));
    });
  });
  /** `?project=<name>`: the project with that name; no name is the first project. */
  function projectCtx(name?: string): Context | undefined {
    return name === undefined || name === '' ? runtimes[0]?.ctx : runtimes.find((r) => r.name === name)?.ctx;
  }
  const ws = attachWebSockets(server, projectCtx);
  o.updates?.onChange(() => ws.broadcastState()); // a found, downloading or downloaded version reaches the page at once

  const persistProjects = (): void => {
    writeJsonAtomic(projectsFile(o.configDir), runtimes.map((r) => ({ root: r.root, name: r.name })));
  };

  // The install runs from the console's own folder and records in the config dir; one at a time for the whole console.
  const utilityPtys = new PtyManager();
  const installer = new InstallService({
    ...(o.installTable ? { table: o.installTable } : {}),
    ptys: utilityPtys, cwd: appRoot(), logPath: join(o.configDir, 'install.log'),
    prereq: () => shared.ensurePrereq(), refresh: () => shared.refreshPrereq(), changed: () => ws.broadcastState(),
    ...(o.installRunner ?? o.prereqRunner ? { run: (o.installRunner ?? o.prereqRunner)! } : {}),
  });

  const shared: Shared = {
    utilityPtys, installer,
    o, configPath, config, token, loginCode: () => loginCodes.issue(), bundles: loadBundles(o.i18nDir),
    ledger: new Ledger(join(o.configDir, 'ledger')),
    quotaState: new QuotaState(),
    // Heavy runs go one at a time; `ANDROMEDACONSOLE_TEST_CONCURRENCY` raises the limit on a machine with cores to spare.
    testQueue: new TestQueue({ limit: () => Number(process.env.ANDROMEDACONSOLE_TEST_CONCURRENCY) || 1, changed: () => ws.broadcastState() }),
    // The sleep timer and the account's limits are one per console; at a reset every project's main wakes.
    sleep: new SleepTimer({
      clock: sleepClock,
      // Not async on purpose: every project sets its wait timer synchronously, inside the sleep timer's own call.
      wakeMain: () => Promise.all(runtimes.map((r) => r.wakeMain())).then((all) => (all.length === 0 || all.includes('running') ? 'running' : 'limited')),
      persist: (s) => writeJsonAtomic(sleepFile, s),
      changed: () => ws.broadcastState(),
      weeklyNotice: (resetsAt) => { for (const r of runtimes) r.weeklyNotice(resetsAt); },
    }),
    sleepClock,
    // Settings read when a session is launched: a change applies to the sessions started afterwards, never to running ones.
    runtime: { bypass: config.agents.bypassPermissions, guardMode: config.guard.mode, git: { ...config.git, ...(o.worktrees !== undefined ? { worktrees: o.worktrees } : {}) } },
    limits: { global: config.agents.maxActiveGlobal, perProject: config.agents.maxActivePerProject },
    runtimes,
    projectsApi: undefined as unknown as ProjectsApi, // set just below
    getPort: () => port,
    broadcastAll: () => ws.broadcastState(),
    pushToProject: (project, payload) => ws.broadcastJson(payload, project),
    language: () => language,
    setLanguage: (l) => { language = l; },
    getPrereq: () => prereq,
    helperUsage: new HelperUsage(join(o.configDir, 'state', 'helper-usage.json')),
    ensurePrereq: () => prereq ? Promise.resolve(prereq) : (startupChecks ??= shared.refreshPrereq()),
    refreshPrereq: async () => {
      // The Claude check runs the configured command (not the test override), so a custom install is judged fairly.
      prereq = await runChecks(o.prereqRunner, { claudeCommand: config.claude.command });
      ws.broadcastState();
      return prereq;
    },
  };
  // A sleep saved by an earlier run is re-armed once the projects run again (Phase 6A): a time still ahead gets its timer, a time that
  // has passed gets one probe at once. The timer is console-wide, so the host restores it, not a project.
  let savedSleep: SleepState | undefined;
  const saved = readJsonFile(sleepFile) as Partial<SleepState> | undefined; // no saved state, or unreadable: nothing to restore
  if (saved && (saved.phase === 'sleeping' || saved.phase === 'probing') && typeof saved.attempt === 'number') {
    savedSleep = { until: typeof saved.until === 'string' ? saved.until : undefined, ...(saved.kind ? { kind: saved.kind } : {}), attempt: saved.attempt, phase: saved.phase };
  }

  /** Checks a folder and a name, opens the project (runtime, main session) and remembers it. */
  const addProject = (a: AddProjectOptions): Promise<{ name: string }> => exclusive(async () => {
    if (closing) throw new ProjectError('project.badRoot', 409);
    const root = resolve(a.root);
    if (runtimes.some((r) => sameFolder(r.root, root))) throw new ProjectError('project.duplicate', 409);
    const wanted = a.name ?? projectNameFromDir(root);
    if (!PROJECT_NAME_RE.test(wanted)) throw new ProjectError('project.badName', 422);
    if (runtimes.some((r) => r.name === wanted)) throw new ProjectError('project.duplicate', 409);
    if (a.create) mkdirSync(root, { recursive: true });
    else if (!(existsSync(root) && statSync(root).isDirectory())) throw new ProjectError('project.badRoot', 422);
    const source = a.copyFrom ? runtimes.find((r) => r.name === a.copyFrom) : undefined;
    if (a.copyFrom && !source) throw new ProjectError('project.notFound', 404);
    if (a.auto && !a.templateId && !source) {
      // The dialog only asked for the folder: what it holds says the template and the commands (the user changes them in Options).
      const found = detectProject(root);
      a = { ...a, templateId: found.source === 'package.json' ? 'frontend-web' : found.source ? 'backend-java' : 'generic',
        build: a.build ?? found.build, test: a.test ?? found.test, lint: a.lint ?? found.lint };
    }
    if (a.templateId) {
      // The template (Phase 6D) prepares the folder: git init, profiles, rules, commands.
      const { applyTemplate } = await import('./templates/apply');
      const done = await applyTemplate({ templateId: a.templateId, root, name: wanted, create: a.create === true, build: a.build, test: a.test, lint: a.lint, configDir: o.configDir });
      if (!done.ok) throw new ProjectError(done.code, 422);
    }
    const store = new ProjectStore(root);
    store.init(wanted);
    if (source) {
      // Another project's settings instead of a template: its profiles, rules and project.json fields.
      const { copyProjectSettings } = await import('./templates/copy');
      const copied = copyProjectSettings(source.root, root, wanted);
      if (!copied.ok) throw new ProjectError(copied.code, 422);
    } else if (!a.templateId) {
      if (a.test !== undefined) store.setTestCommand(a.test);
      store.setCommands({ build: a.build, lint: a.lint });
    }
    // An existing project.json keeps the name it was created with: it is the one that must be free.
    const name = store.project.name;
    if (runtimes.some((r) => r.name === name)) throw new ProjectError('project.duplicate', 409);
    const rt = await createProjectRuntime(shared, { projectRoot: root, projectName: name });
    runtimes.push(rt);
    rt.start();
    persistProjects();
    ws.broadcastState();
    return { name };
  });

  const closeProject = (name: string, purge = false): Promise<void> => exclusive(async () => {
    const rt = runtimes.find((r) => r.name === name);
    if (!rt) throw new ProjectError('project.notFound', 404);
    // What the purge needs is read before the project closes: the records say where every agent's worktree was.
    const records = purge ? rt.ctx.store.listAgents() : [];
    runtimes.splice(runtimes.indexOf(rt), 1);
    persistProjects();
    try { await rt.close(); } catch { /* the sessions were killed as far as they could be */ }
    if (purge) {
      const { purgeProject } = await import('./git/purge');
      try {
        await purgeProject({ projectRoot: rt.root, project: rt.name, slugs: records.map((a) => a.slug), worktrees: records.flatMap((a) => (a.worktree ? [a.worktree] : [])) });
      } catch (e) {
        console.warn(`console: the data of the project "${name}" could not be removed completely: ${errorMessage(e)}`);
      }
    }
    ws.closeProject(name);
    // Its slots are free: the projects still open may start their queues.
    for (const r of runtimes) r.parts.scheduler.release();
    ws.broadcastState();
  });

  /**
   * One project at a time: the agents that have a process are noted, the project closes (the sessions end, the next start finds them
   * dormant), opens again (its main resumes its session) and the noted agents are woken, so everything runs with the settings of now. The
   * console, its port and its token stay, and so does the PATH it was started with: it is never read again from the system.
   */
  const restartSessions = (): Promise<void> => exclusive(async () => {
    if (closing) throw new ProjectError('project.badRoot', 409);
    for (const old of [...runtimes]) {
      const running = old.ctx.registry.list().filter((a) => a.role === 'agent' && old.ctx.ptys.status(a.slug) === 'running').map((a) => a.slug);
      try { await old.close(); } catch { /* the sessions were killed as far as they could be */ }
      let rt: ProjectRuntime;
      try {
        rt = await createProjectRuntime(shared, { projectRoot: old.root, projectName: old.name });
      } catch (e) {
        runtimes.splice(runtimes.indexOf(old), 1); // closed and not reopened: leaving it listed would answer requests with a dead runtime
        persistProjects();
        ws.broadcastState();
        throw e;
      }
      runtimes[runtimes.indexOf(old)] = rt;
      rt.start();
      for (const slug of running) await rt.ctx.wake.wake(slug, 'user'); // a refusal (no session yet, frozen quota) leaves it dormant
    }
    ws.broadcastState();
    void shared.refreshPrereq().catch(() => undefined); // a program installed meanwhile is "restart" until the new PATH is seen
  });

  shared.projectsApi = {
    list: () => runtimes.map((r) => r.summary()),
    contexts: () => runtimes.map((r) => r.ctx),
    add: addProject,
    close: closeProject,
    restart: restartSessions,
  };

  // The CLI's project first, then the remembered ones whose folder still exists (a missing one is skipped and reported once).
  if (o.projectRoot !== undefined) runtimes.push(await createProjectRuntime(shared, { projectRoot: o.projectRoot, projectName: o.projectName ?? projectNameFromDir(o.projectRoot) }));
  const given = o.projectRoot;
  const remembered = readProjectsFile(o.configDir).filter((p) => given === undefined || !sameFolder(p.root, given));
  const toOpen: { root: string; name: string }[] = [];
  for (const p of remembered) {
    if (existsSync(p.root) && statSync(p.root).isDirectory()) toOpen.push(p);
    else console.warn(`console: the project "${p.name}" was skipped: its folder ${p.root} does not exist any more`);
  }
  for (const p of toOpen) {
    try {
      if (runtimes.some((r) => r.name === p.name || sameFolder(r.root, p.root))) continue;
      const rt = await createProjectRuntime(shared, { projectRoot: resolve(p.root), projectName: p.name });
      if (runtimes.some((r) => r.name === rt.name)) { await rt.close(); continue; }
      runtimes.push(rt);
    } catch (e) {
      console.warn(`console: the project "${p.name}" could not be opened: ${errorMessage(e)}`);
    }
  }
  persistProjects();

  await new Promise<void>((ok, err) => {
    server.once('error', err);
    server.listen(o.port, '127.0.0.1', () => ok()); // never another interface (SPEC 4.5)
  });
  const addr = server.address() as AddressInfo;
  port = addr.port;
  const url = `http://127.0.0.1:${port}`;

  startupChecks = shared.refreshPrereq(); // background; unknown is null in the state and agent creation waits for it
  for (const r of runtimes) r.start();
  if (savedSleep) shared.sleep.restore(savedSleep);

  return {
    port, address: addr.address, token, url, loginUrl: () => `${url}/?code=${loginCodes.issue()}`,
    // The members below are bound to the first project (the one a request with no `?project=` gets).
    sessionTokenFor: (slug) => runtimes[0]?.ctx.tokens.tokenFor(slug),
    sendMessage: (slug, text) => runtimes[0]!.ctx.inbox.push(slug, text),
    writeToSession: (slug, data) => runtimes[0]!.ctx.ptys.write(slug, data),
    setLimits: (l) => { shared.limits.global = l.global; shared.limits.perProject = l.perProject; for (const r of runtimes) r.parts.scheduler.release(); },
    setBudgetLimit: (slug, limit) => runtimes[0]!.parts.budget.setLimit(slug, limit),
    lastLaunchArgs: (slug) => runtimes[0]?.ctx.launchLog.get(slug),
    addProject: (root, name) => addProject({ root, ...(name !== undefined ? { name } : {}) }),
    closeProject,
    projects: () => runtimes.map((r) => r.summary()),
    runningAgentCount: () => runtimes.reduce((n, r) => n + r.ctx.registry.list().filter((a) => a.role !== 'main' && r.ctx.ptys.status(a.slug) === 'running').length, 0),
    close: async () => {
      closing = true;
      shared.sleep.close();
      removeProcessGuards();
      shared.helperUsage.flush();
      await projectChain; // an opening or closing in progress ends first
      for (const r of [...runtimes]) await r.close();
      await utilityPtys.killAll();
      ws.closeAll();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
