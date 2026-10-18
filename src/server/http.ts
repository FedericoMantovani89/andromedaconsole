import type { IncomingMessage, ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { buildClaudeLaunch } from './claude-code/launch';
import { PtyManager } from './pty/pty-manager';
import { ProjectStore } from './project-store';
import { bundlePayload, type Bundles } from './i18n-bundles';
import { extractToken, PAGE_CSP, isAllowedHost, isAllowedOrigin, tokensEqual, type LoginCodes } from './security';
import { validateSlug } from '../shared/slug';
import { type HostInfo, type ProjectTab, type PrereqResult, type SessionInfo, type StateMessage } from '../shared/protocol';
import { applyConfigPatch, loadConfig } from './config';
import type { PickFolderResult } from './pick-folder';
import type { Notifier } from './notify/notifier';
import { parsePresence, type Presence } from './notify/presence';
import type { NotificationService } from './notify/service';
import { describeProfiles, listProfileNames, loadProfile, pickableProfiles, removeUserProfile, restoreShippedProfiles, saveUserProfile, validateProfileInput } from './profiles';
import type { ModelCatalog } from './catalog/models';
import type { PluginCatalog } from './catalog/plugins';
import { fail, readBodyOr400, readObjectBody, send } from './http-util';
import { handleV1, type V1Context } from './v1';
import { archiveAgent, archiveFinished, deleteAllArchived, deleteArchived, unarchiveAgent } from './agents/archive';
import { spawnAgent } from './agents/spawn';
import type { Scheduler } from './agents/scheduler';
import type { ReadingStore } from './reading/store';
import type { TicketStore } from './tickets/store';
import type { StepService } from './tickets/steps';
import type { RequestService } from './requests/service';
import type { ReviewService } from './tickets/review';
import type { RecoveryService } from './tickets/recovery';
import type { LaunchWatch } from './agents/launch-watch';
import { renderIndex } from './version';
import type { UiAssets } from './ui-assets';
import type { UpdateControl, UpdateState } from '../shared/update';
import { isValidProjectField, isValidRepoTestCommands, isValidTestCommand, isValidTestCommands, type ProjectInfo, PROJECT_FIELDS, PROJECT_RANGES, unknownRepos } from './project-store';
import { repoPathOf } from './git/repos';
import { loadTemplates } from './templates/load';
import { detectProject } from './templates/detect';
import { saveTemplate } from './templates/save';
import { MAX_REWORK_ROUNDS } from './tickets/review';
import type { Config } from './config';
import type { BudgetService } from './budget/service';
import type { Restrictions } from './budget/restrictions';
import type { LoopService } from './budget/loop-service';
import type { Ledger } from './budget/ledger';
import type { QuotaState } from './budget/quota';
import type { SleepTimer } from './budget/sleep';
import type { StateProblems } from './state-problems';
import { handleDictationRoute } from './dictation-api';
import { typeIntoSession } from './dictation';
import { failProject, handleProjectsRoute, type ProjectsApi } from './projects-api';

/** Finds the project a request or socket asked for with `?project=<name>`; no name means the first project; undefined when it is not open. */
export type ProjectResolver = (name?: string) => Context | undefined;
import type { InstallService } from './prereq/install';
import type { Runner } from './prereq/checks';
import type { HelperUse } from './helper-usage';
import type { WakeService } from './agents/wake';

export interface Context extends V1Context {
  getPort(): number;
  token: string;
  ptys: PtyManager;
  store: ProjectStore;
  projectName: string;
  projectRoot: string;
  claudeCommand: string[];
  /** Runs a command to read its output (the plugin list); tests inject a fake one. */
  commandRunner?: Runner;
  /** Mod folder passed to launched sessions (--plugin-dir), when enabled. */
  modDir?: string;
  scheduler: Scheduler;
  /** The place (1 = next) of this agent's run in the machine's test queue, when it waits for it. */
  testPosition?(slug: string): number | undefined;
  /** Who runs and who waits in the machine's test queue. */
  testQueue?(): { running: { label: string; owner?: string }[]; waiting: { label: string; owner?: string; position: number }[] };
  reading: ReadingStore;
  /** Last launch arguments per session (a test seam; contains no secrets). */
  launchLog: Map<string, string[]>;
  /** Where rendered system-prompt files are written (under the project's .andromedaconsole/state). */
  promptsDir: string;
  bypass: boolean;
  language: string;
  bundles: Bundles;
  testMode: boolean;
  configPath: string;
  /** The repositories agents can work in (see `discoverRepos`), read at each use: a repo made later is seen. */
  repos(): string[];
  /** Drops the remembered list of repositories (one was just made). */
  forgetRepos(): void;
  /** Once per repository: keeps `.andromedaconsole/` out of its git status and installs the release hook. Never rejects. */
  prepareRepo(path: string): Promise<void>;
  /** Build version (latest tag on main), shown on the splash and in the tab title. */
  version: string;
  tickets: TicketStore;
  steps: StepService;
  /** Requests between agents (SPEC 10). */
  requests: RequestService;
  launchWatch: LaunchWatch;
  review: ReviewService;
  /** Recovery after a stop (SPEC 16.5). */
  recovery: RecoveryService;
  /** Token budgets (Phase 5): limits, steps and the usage shown in the state. */
  budget: BudgetService;
  /** What the guard holds against each session (budget, loop, limit). */
  restrictions: Restrictions;
  /** Loop handling: the level shown in the state. */
  loop: LoopService;
  ledger: Ledger;
  /** The subscription's usage limits as the engine last reported them (SPEC 18.1). */
  quotaState: QuotaState;
  /** Sleep until a usage limit lifts (SPEC 18.4). */
  sleep: SleepTimer;
  /** What this project's stores set aside because they could not read it (listed in the state until dismissed). */
  stateProblems: StateProblems;
  /** Console-wide terminals that are not agent sessions (assisted installs, Phase 6F); served on /ws/term/<id> after the project's own. */
  utilityPtys: PtyManager;
  /** Assisted installation of prerequisites: console-wide, one install at a time. */
  installer: InstallService;
  /** A newer version of the desktop app, if the app found one (SPEC 33.4). */
  update(): UpdateState | undefined;
  /** Wakes a dormant agent (Phase 6A). */
  wake: WakeService;
  /** Read at each use: a change made in the Settings dialog applies to the sessions launched afterwards. */
  readonly git: Config['git'];
  /** The budget thresholds and the default token limit, read at each launch. */
  readonly budgetConfig: Config['budget'];
  readonly guardMode: Config['guard']['mode'];
  /** The test command a folder's files suggest (pom.xml, build.gradle, package.json): `cwd`, else the project folder; used while none is saved. */
  detectedTestCommand(cwd?: string): string | undefined;
  /** A test seam: runs after an agent's worktree exists and before its process starts (a throw simulates a failed start). */
  afterWorktreeCreated?: (slug: string) => void | Promise<void>;
  getPrereq(): PrereqResult[] | null;
  /** The count of shell commands that used each optional helper (console-wide). */
  getHelperUse(): HelperUse;
  /** Resolves with the checks, waiting for the startup run if it has not finished (unknown is never ok, P7). */
  ensurePrereq(): Promise<PrereqResult[]>;
  refreshPrereq(): Promise<PrereqResult[]>;
  setLanguage(language: string): void;
  /** Changes what sessions launched from now on get (the bypass switch, the guard mode). Running sessions are untouched. */
  applySettings(s: { bypass?: boolean; guardMode?: 'enforce' | 'shadow' }): void;
  /** Called when a session is launched: fixes the settings that session will live with and returns what the launch needs. */
  noteLaunch(slug: string): { bypass: boolean };
  needsSetup(): boolean;
  broadcastState(): void;
  /** The console's open projects (Phase 6C); set by the host, shared by every project's Context. */
  projects?: ProjectsApi;
  /** Phase 6B: unique for the whole console (6C shares it between projects). */
  notifier: Notifier;
  /** What the user is looking at, as the UI last reported it. */
  presence: Presence;
  notify: NotificationService;
  /** Read at each event. */
  readonly notificationsConfig: Config['notifications'];
  applyNotifications(n: Config['notifications']): void;
  /** The model menu (aliases plus the remote or shipped catalog) and the saved agent model (SPEC 12). */
  models: ModelCatalog;
  /** The plugin catalog, read-only (SPEC 30). */
  plugins: PluginCatalog;
  /** Makes a saved config patch live: limits, budget, git, models, plugins (the language and the bypass/guard switches go through their own setters). */
  applyConfig(config: Config, applied: Record<string, unknown>): void;
}

/** The built UI files the page may ask for: the entry, its lazy chunks, the styles, the splash and the favicon (a `.map` exists only in a build made with --map). */
const STATIC_FILE = /^\/(app\.js|styles\.css|xterm\.css|splash\.jpg|favicon\.png|chunks\/[\w.-]+\.js)(\.map)?$/;

/** The state is built on every push and lists the profile folders each time: a few seconds of memory is plenty (SPEC 33.2). */
const profileNamesMemo = new Map<string, { at: number; names: string[] }>();
const forgetProfileNames = (): void => profileNamesMemo.clear();
function profileNamesOf(projectRoot: string, userDir: string): string[] {
  const key = `${projectRoot}|${userDir}`;
  const hit = profileNamesMemo.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.names;
  const names = listProfileNames(projectRoot, userDir);
  profileNamesMemo.set(key, { at: Date.now(), names });
  return names;
}

/** A folder just became a repository: forget what was known about its repositories and keep `.andromedaconsole/` out of its status. */
async function afterRepoMade(ctx: Pick<Context, 'forgetRepos' | 'prepareRepo' | 'projectRoot' | 'broadcastState'>): Promise<void> {
  ctx.forgetRepos();
  await ctx.prepareRepo(ctx.projectRoot);
  ctx.broadcastState();
}

export function buildState(ctx: Context): StateMessage {
  const status = (slug: string): SessionInfo['status'] => {
    const p = ctx.ptys.status(slug);
    return p === 'running' ? 'running' : p === 'exited' ? 'exited' : 'pending';
  };
  const stateOf = (slug: string) => ctx.registry.get(slug)?.state ?? 'starting';
  // studying / blocked / progress come from the agent's ticket, never from the terminal.
  const derived = (slug: string): Pick<SessionInfo, 'state' | 'progress' | 'ticket' | 'budget'> => {
    const rt = ctx.registry.get(slug);
    const ticket = rt ? ctx.tickets.get(slug) : undefined;
    // A ticket stopped by its budget or by the usage limit, whose process is gone, waits for a decision: not finished, not failed.
    const suspended = (ticket?.status === 'suspended_budget' || ticket?.status === 'suspended_limit') && ctx.ptys.status(slug) !== 'running';
    const base = suspended ? 'suspended' : stateOf(slug);
    // Where the ticket is in the review pipeline: kept after the worktree is gone (a merged ticket still says "Merged").
    const pipeline = ticket && rt?.role === 'agent' && (ticket.status !== 'in_progress' || ticket.round > 0 || ctx.testPosition?.(slug) !== undefined)
      ? { ticket: { status: ticket.status, round: ticket.round, maxRounds: MAX_REWORK_ROUNDS, ...(ctx.testPosition?.(slug) !== undefined ? { testQueue: ctx.testPosition(slug) } : {}) } }
      : {};
    // No budget (a reviewer, an agent without a worktree) is left out, so the UI shows n/a rather than zero.
    const usage = rt?.role === 'agent' ? ctx.budget.usage(slug, ticket) : undefined;
    const budget = usage ? { budget: usage } : {};
    if (!rt?.git) return { state: base, ...pipeline, ...budget };
    const total = ticket?.steps.length ?? 0;
    const progress = total > 0 ? { done: ticket!.steps.filter((x) => x.done).length, total } : undefined;
    let state = base;
    if (ticket?.blocked && base !== 'interrupted' && base !== 'queued' && base !== 'waiting_user' && base !== 'suspended') state = 'blocked';
    else if (total === 0 && base === 'working') state = 'studying';
    return { state, ...(progress ? { progress } : {}), ...pipeline, ...budget };
  };
  const launchOf = (slug: string): Pick<SessionInfo, 'launchStalled' | 'launchProblem'> => {
    const problem = ctx.launchWatch.reason(slug);
    return problem ? { launchStalled: true, launchProblem: problem } : {};
  };
  const silenceOf = (slug: string): Pick<SessionInfo, 'silentMinutes'> => {
    const minutes = ctx.loop.silentFor(slug);
    return minutes !== undefined ? { silentMinutes: minutes } : {};
  };
  const waitingOf = (slug: string): Pick<SessionInfo, 'waiting'> => {
    const n = ctx.questions.pendingCount(slug);
    return n > 0 ? { waiting: n } : {};
  };
  // Steps waiting for an answer come from the ticket (the record that survives a restart); what the agent owes, from the requests.
  const requestsOf = (slug: string): Pick<SessionInfo, 'requests'> => {
    const waiting = (ctx.tickets.get(slug)?.steps ?? []).filter((s) => !s.done && s.waitingOn).map((s) => s.waitingOn!);
    const info = ctx.requests.infoFor(slug, waiting);
    return info ? { requests: info } : {};
  };
  const archiveOf = (slug: string): Pick<SessionInfo, 'archived' | 'archivedAt'> => {
    const rt = ctx.registry.get(slug);
    return rt?.archived ? { archived: true, ...(rt.archivedAt !== undefined ? { archivedAt: rt.archivedAt } : {}) } : {};
  };
  const main: SessionInfo = { slug: ctx.projectName, profile: 'main', role: 'main', status: status(ctx.projectName), state: stateOf(ctx.projectName) };
  // Only sessions of this run: agents saved by an earlier run are history (resume is Phase 6) and keep their slug reserved.
  const agents: SessionInfo[] = ctx.store.listAgents()
    .filter((a) => ctx.ptys.status(a.slug) !== 'unknown' || ctx.registry.get(a.slug) !== undefined)
    .map((a) => ({ slug: a.slug, profile: a.profile, role: 'agent', status: status(a.slug), ...derived(a.slug), ...launchOf(a.slug), ...silenceOf(a.slug), ...waitingOf(a.slug), ...requestsOf(a.slug), ...(a.stale ? { stale: true as const } : {}), ...archiveOf(a.slug), ...(ctx.loop.level(a.slug) > 0 ? { loop: ctx.loop.level(a.slug) as 1 | 2 | 3 } : {}) }));
  let testCommand: string | undefined;
  let testsDisabled: boolean | undefined;
  let testCommands: ProjectInfo['testCommands'];
  let repoTestCommands: ProjectInfo['repoTestCommands'];
  let squash: boolean | undefined;
  let model: string | undefined;
  let maxActive: number | undefined;
  let offeredProfiles: string[] | undefined;
  try { ({ testCommand, testCommands, repoTestCommands, testsDisabled, squash, model, maxActive, profiles: offeredProfiles } = ctx.store.project); } catch { /* a damaged project.json: shown as not set */ }
  const repos = ctx.repos();
  // A folder that holds several repositories: each one has its own row in Options, with what its own files suggest.
  const repoNames = repos.filter((r) => r !== '');
  const detectedRepos = Object.fromEntries(repoNames.flatMap((r) => { const d = ctx.detectedTestCommand(repoPathOf(ctx.projectRoot, r)); return d ? [[r, d]] : []; }));
  const worst = ctx.quotaState.worst();
  const slept = ctx.sleep.state();
  const installed = ctx.installer.state();
  const update = ctx.update();
  return {
    ...(installed ? { install: installed } : {}),
    ...(update ? { update } : {}),
    ...(() => { const q = ctx.testQueue?.(); return q && (q.running.length > 0 || q.waiting.length > 0) ? { testQueue: q } : {}; })(),
    ...(worst ? { quota: { percent: worst.percent, kind: worst.kind } } : {}),
    ...(slept.phase !== 'awake' ? { sleep: { ...(slept.until !== undefined ? { until: slept.until } : {}), phase: slept.phase, attempt: slept.attempt, weekly: slept.kind === 'seven_day' } } : {}),
    // One project per console today: the stricter of the global and the per-project limit is the one that holds.
    limits: { active: ctx.scheduler.activeCount(), max: (({ global, perProject }) => Math.min(global, perProject))(ctx.scheduler.effectiveLimits()) },
    type: 'state', project: { name: ctx.projectName, ...(testCommand ? { testCommand } : {}), ...(testCommands ? { testCommands } : {}), ...(ctx.detectedTestCommand() ? { detectedTestCommand: ctx.detectedTestCommand() } : {}), repos: repoNames, ...(repoTestCommands ? { repoTestCommands } : {}), ...(Object.keys(detectedRepos).length > 0 ? { detectedRepoTestCommands: detectedRepos } : {}), ...(squash !== undefined ? { squash } : {}), ...(testsDisabled ? { testsDisabled } : {}), ...(model ? { model } : {}), ...(maxActive !== undefined ? { maxActive } : {}) }, settings: { bypassPermissions: ctx.bypass, guardMode: ctx.guardMode, worktrees: ctx.git.worktrees }, main, agents, language: ctx.language, languages: [...ctx.bundles.keys()].sort(), profiles: pickableProfiles(offeredProfiles, profileNamesOf(ctx.projectRoot, join(dirname(ctx.configPath), 'profiles'))),
    prereq: ctx.getPrereq(), helperUse: ctx.getHelperUse(), needsSetup: ctx.needsSetup(), projectIsRepo: repos.length > 0, repos, projectRoot: ctx.projectRoot,
    ...(() => { const rows = ctx.requests.rows(); return rows.length > 0 ? { requests: rows } : {}; })(),
    queue: ctx.questions.pending(),
    ...(ctx.projects ? { projects: ctx.projects.list() } : {}),
    notifications: { toast: ctx.notify.toast(), config: ctx.notificationsConfig },
    ...(() => { const p = ctx.stateProblems.list(); return p.length > 0 ? { stateProblems: p } : {}; })(),
  };
}

/** The console-wide part the request handler needs; unlike a project's Context it exists even when no project is open. */
export interface HostContext {
  getPort(): number;
  token: string;
  /** The single-use codes the page swaps for the token (`POST /api/session`). */
  loginCodes: LoginCodes;
  /** The built UI files (SPEC 33.2). */
  assets: UiAssets;
  /** The user's config folder (templates live under it). */
  configDir: string;
  version: string;
  bundles: Bundles;
  projects: ProjectsApi;
  ensurePrereq(): Promise<PrereqResult[]>;
  info(): HostInfo;
  /** The native "choose a folder" window (the server runs on the user's own machine). */
  pickFolder(): Promise<PickFolderResult>;
  /** The desktop app's update control; absent when the console runs from a terminal. */
  updates?: UpdateControl;
  /** A test seam: replaces the network call of the voice dictation. */
  groqFetch?: typeof fetch;
}

export function createRequestHandler(source: Context | ProjectResolver, host: HostContext) {
  const resolve: ProjectResolver = typeof source === 'function' ? source : () => source;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isAllowedHost(req.headers.host, host.getPort())) return fail(res, 403, 'forbidden');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${host.getPort()}`);
    const path = url.pathname;

    // Static UI files: no token needed, the page itself carries the token in its URL.
    if (req.method === 'GET' && path === '/') {
      const index = host.assets.get('index.html');
      if (!index) return fail(res, 404, 'not_found');
      res.writeHead(200, { 'content-type': index.type, 'cache-control': 'no-cache', 'content-security-policy': PAGE_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); // the page carries the version and links the hashed chunks
      res.end(renderIndex(index.body.toString('utf8'), host.version));
      return;
    }
    const file = req.method === 'GET' && STATIC_FILE.test(path) ? host.assets.get(path.slice(1), String(req.headers['accept-encoding'] ?? '')) : undefined;
    if (file) {
      // `no-cache` means "ask again with the ETag": a new build is seen at once, an unchanged file costs a 304 and no bytes.
      const headers: Record<string, string> = { 'content-type': file.type, 'cache-control': 'no-cache', etag: file.etag, vary: 'accept-encoding', ...(file.encoding ? { 'content-encoding': file.encoding } : {}) };
      if (req.headers['if-none-match'] === file.etag) { res.writeHead(304, headers); res.end(); return; }
      res.writeHead(200, { ...headers, 'content-length': String(file.body.length) });
      res.end(file.body);
      return;
    }

    // UI texts are not secret and the page needs them to explain a wrong token, so they only need the Host check.
    const i18n = /^\/i18n\/(\w+)$/.exec(path);
    if (req.method === 'GET' && i18n) {
      const payload = bundlePayload(host.bundles, i18n[1]!);
      return payload ? send(res, 200, payload) : fail(res, 404, 'not_found');
    }

    // The mod channel has its own authentication (per-session tokens); the UI token is not valid there.
    if (path.startsWith('/v1/')) {
      // The project that issued the session token is the one that answers (tokens are random, no project can use another's).
      const t = extractToken(req.headers, url);
      const owner = t ? host.projects.contexts().find((c) => c.tokens.slugFor(t) !== undefined) : undefined;
      return owner ? handleV1(owner, req, res, url) : fail(res, 401, 'unauthorized');
    }

    // The page swaps the single-use code of its opening address for the token. Only a request of the console's own page (a browser always
    // sends Origin on a POST) may ask; nothing else is accepted here, so another site cannot make the page's code be spent.
    if (req.method === 'POST' && path === '/api/session') {
      if (!isAllowedOrigin(req.headers.origin, host.getPort())) return fail(res, 403, 'forbidden');
      const body = await readObjectBody(req, res);
      if (body === undefined) return;
      return typeof body.code === 'string' && host.loginCodes.redeem(body.code) ? send(res, 200, { token: host.token }) : fail(res, 401, 'unauthorized');
    }

    const token = extractToken(req.headers, url);
    if (!token || !tokensEqual(token, host.token)) return fail(res, 401, 'unauthorized');

    // Opening and closing projects are not about one project; every other route below is, and takes it from `?project=` (absent: the first).
    if ((req.method === 'POST' && path === '/api/projects') || (req.method === 'DELETE' && /^\/api\/projects\/[^/]+$/.test(path))) return handleProjectsRoute(host, req, res, path);
    // The desktop app's update (SPEC 33.4): the user chooses to download, then to restart; nothing happens on its own.
    if (req.method === 'POST' && (path === '/api/update/download' || path === '/api/update/install')) {
      if (!host.updates) return fail(res, 404, 'not_found');
      if (path === '/api/update/download') host.updates.download();
      // Not awaited: the install asks the user, then stops this very server, which would wait for this request to end.
      else void Promise.resolve(host.updates.install()).catch(() => undefined);
      res.writeHead(204);
      res.end();
      return;
    }
    // The sessions of every project start again with the settings saved so far (Options asks after a change they only read at launch).
    if (req.method === 'POST' && path === '/api/restart') {
      try {
        await host.projects.restart();
        return send(res, 200, {});
      } catch (e) {
        return failProject(res, e);
      }
    }
    // What the console knows without any project: the welcome screen asks this before anything else.
    if (req.method === 'GET' && path === '/api/host') return send(res, 200, host.info());
    if (req.method === 'POST' && path === '/api/pick-folder') {
      const picked = await host.pickFolder();
      return picked.status === 'busy' ? fail(res, 409, 'folder.pickBusy') : send(res, 200, picked);
    }
    // Voice dictation: the console-wide secrets (the Groq key) and the transcription, which the server does so the key never reaches the browser.
    if (path === '/api/secrets' || path === '/api/dictation/transcribe') {
      if (await handleDictationRoute(host, req, res, path, url)) return;
    }
    // Project templates and project detection are project-independent (the welcome screen needs them with no project open); saving a template is not.
    if (req.method === 'GET' && path === '/api/templates') {
      return send(res, 200, loadTemplates({ configDir: host.configDir }).map((t) => ({
        id: t.id, name: t.name, description: t.description, source: t.source, valid: t.valid, ...(t.reason ? { reason: t.reason } : {}),
      })));
    }
    // What the project in a folder suggests (SPEC 21): read-only, no process is run.
    if (req.method === 'GET' && path === '/api/projects/detect') {
      const root = url.searchParams.get('root') ?? '';
      let isDir = false;
      try { isDir = isAbsolute(root) && statSync(root).isDirectory(); } catch { /* not there */ }
      if (!isDir) return fail(res, 422, 'project.badRoot');
      return send(res, 200, detectProject(resolvePath(root)));
    }
    const asked = url.searchParams.get('project');
    const projectCtx = asked !== null ? resolve(asked) : resolve();
    if (!projectCtx) return fail(res, 404, 'project.notFound');
    const ctx: Context = projectCtx;

    if (req.method === 'GET' && path === '/api/state') return send(res, 200, buildState(ctx));

    if (req.method === 'GET' && ctx.testMode) {
      const snap = /^\/api\/debug\/snapshot\/([a-z0-9-]+)$/.exec(path);
      if (snap) return send(res, 200, { text: ctx.ptys.snapshot(snap[1]!).toString('utf8') });
      const size = /^\/api\/debug\/size\/([a-z0-9-]+)$/.exec(path);
      if (size) return send(res, 200, ctx.ptys.size(size[1]!) ?? {});
    }

    // Types text into the main's input without pressing Enter (the voice dictation's "Send to main"): the user confirms in the terminal.
    if (req.method === 'POST' && path === '/api/main/input') {
      const body = await readBodyOr400(req, res);
      if (body === undefined) return;
      const text = typeof body === 'object' && body !== null ? (body as { text?: unknown }).text : undefined;
      if (typeof text !== 'string') return fail(res, 400, 'bad_request');
      const typed = typeIntoSession(ctx.ptys, ctx.projectName, text);
      return typed.status === 'ok' ? send(res, 200, typed) : fail(res, typed.code === 'dictation.textEmpty' ? 422 : 409, typed.code);
    }

    if (req.method === 'POST' && path === '/api/agents') {
      const body = await readBodyOr400(req, res);
      if (body === undefined) return;
      const b = (typeof body === 'object' && body !== null ? body : {}) as { slug?: unknown; profile?: unknown; repo?: unknown };
      // The UI button (a user) and the main's spawn_agent tool share one flow: validation, name reservation, limits.
      const out = await spawnAgent(ctx, { slug: String(b.slug ?? ''), profile: String(b.profile ?? ''), source: 'user', ...(typeof b.repo === 'string' ? { repo: b.repo } : {}) });
      if (!out.ok) return fail(res, out.httpStatus, out.code, out.params);
      return out.status === 'started' ? send(res, 201, { slug: out.slug }) : send(res, 202, { slug: out.slug, status: 'queued', position: out.position });
    }

    const reading = /^\/api\/reading\/([\w-]+)$/.exec(path);
    if (req.method === 'GET' && reading) return send(res, 200, { entries: ctx.reading.list(reading[1]!) });

    const answer = /^\/api\/queue\/([\w-]+)\/answer$/.exec(path);
    if (req.method === 'POST' && answer) {
      const body = await readBodyOr400(req, res);
      if (body === undefined) return;
      const text = (body as { answer?: unknown } | null)?.answer;
      if (typeof text !== 'string') return fail(res, 400, 'bad_request');
      const outcome = ctx.questions.answer(answer[1]!, text);
      if (outcome === 'ok') return send(res, 200, { ok: true });
      return outcome === 'unknown' ? fail(res, 404, 'not_found') : outcome === 'already' ? fail(res, 409, 'already_answered') : fail(res, 400, 'bad_request');
    }

    // "Resume now": one probe at once instead of waiting for the reset time. The token check above already ran.
    if (req.method === 'POST' && path === '/api/state-problems/dismiss') {
      ctx.stateProblems.clear();
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && path === '/api/sleep/resume') {
      ctx.sleep.resumeNow();
      res.writeHead(204);
      res.end();
      return;
    }

    // Wakes a dormant agent: the dormant panel's button, an explicit action of the user.
    const wake = /^\/api\/agents\/([a-z0-9]+(?:-[a-z0-9]+)*)\/wake$/.exec(path);
    if (req.method === 'POST' && wake) {
      const out = await ctx.wake.wake(wake[1]!, 'user');
      return out.ok ? send(res, 200, { status: out.status }) : fail(res, 409, out.code);
    }

    // Archive everything archivable right now, in one request (the "Archive all finished" button); not an /api/projects/ route.
    if (req.method === 'POST' && path === '/api/agents/archive-finished') {
      const ticketStatus = (s: string): string | undefined => { try { return ctx.tickets.get(s)?.status; } catch { return undefined; } };
      const out = archiveFinished({ registry: ctx.registry, ticketStatus });
      if (out.count > 0) ctx.broadcastState();
      return send(res, 200, out);
    }

    // Archive: only a flag moves, nothing is closed or deleted (the panel's button and the archive list).
    const archive = /^\/api\/agents\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(archive|unarchive)$/.exec(path);
    if (req.method === 'POST' && archive) {
      const slug = archive[1]!;
      const ticketStatus = (s: string): string | undefined => { try { return ctx.tickets.get(s)?.status; } catch { return undefined; } };
      const out = archive[2] === 'archive' ? archiveAgent({ registry: ctx.registry, ticketStatus }, slug) : unarchiveAgent({ registry: ctx.registry }, slug);
      if (!out.ok) return out.code === 'not_found' ? fail(res, 404, 'not_found') : fail(res, 409, out.code);
      ctx.broadcastState();
      return send(res, 200, { ok: true });
    }

    // Deleting archived agents from the list (the archive dialog): record and session go, the work (worktree, ticket, ledger) stays.
    const forgetAgent = async (s: string): Promise<void> => {
      await ctx.ptys.discard(s);
      ctx.tokens.revoke(s);
      ctx.registry.remove(s);
      ctx.store.removeAgent(s);
    };
    if (req.method === 'POST' && path === '/api/agents/delete-archived') {
      const out = await deleteAllArchived({ registry: ctx.registry, forget: forgetAgent });
      if (out.count > 0) ctx.broadcastState();
      return send(res, 200, out);
    }
    const deleteOne = /^\/api\/agents\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(path);
    if (req.method === 'DELETE' && deleteOne) {
      const out = await deleteArchived({ registry: ctx.registry, forget: forgetAgent }, deleteOne[1]!);
      if (!out.ok) return out.code === 'not_found' ? fail(res, 404, 'not_found') : fail(res, 409, out.code);
      ctx.broadcastState();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/api/prereq/recheck') return send(res, 200, await ctx.refreshPrereq());

    // Assisted install (Phase 6F): the request names a tool, the shipped table names the command.
    const install = /^\/api\/prereq\/([a-z]+)\/install$/.exec(path);
    if (req.method === 'GET' && install) {
      const d = await ctx.installer.describe(install[1]!);
      if (d.ok) return send(res, 200, d.info);
      return d.code === 'not_found' ? fail(res, 404, 'not_found') : send(res, 200, { unavailable: d.unavailable });
    }
    if (req.method === 'POST' && install) {
      const body = await readBodyOr400(req, res);
      if (body === undefined) return;
      const b = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
      const out = await ctx.installer.start(install[1]!, b);
      if (!out.ok) return fail(res, out.httpStatus, out.code, out.params);
      return send(res, 202, { terminal: out.terminal });
    }
    // Phase 6B: what the user is looking at (heartbeat of the UI), and the "send a test toast" button.
    if (req.method === 'POST' && path === '/api/presence') {
      const body = await readBodyOr400(req, res);
      if (body === undefined) return;
      const report = parsePresence(body);
      if (!report) return fail(res, 400, 'bad_request');
      ctx.presence.report(report);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && path === '/api/notifications/test') {
      const ok = await ctx.notify.test();
      ctx.broadcastState();
      return send(res, 200, { ok });
    }

    if (req.method === 'PUT' && path === '/api/config') {
      const body = await readBodyOr400(req, res);
      if (body === undefined) return;
      const b = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
      // The language must have a bundle (the file check alone only knows its shape); everything else is validated against the merged file.
      if ('language' in b && (typeof b.language !== 'string' || (b.language !== 'auto' && !ctx.bundles.has(b.language)))) return fail(res, 422, 'config.invalid', { path: 'language' });
      // `?dryRun=1`: only says whether the patch would be accepted; nothing is written or applied (Options checks everything before it saves anything).
      const dry = new URL(req.url ?? '/', 'http://x').searchParams.get('dryRun') === '1';
      const saved = applyConfigPatch(ctx.configPath, b, dry);
      if (!saved.ok) return saved.code === 'config.invalid' ? (saved.range ? fail(res, 422, 'config.outOfRange', { path: saved.path, ...saved.range }) : fail(res, 422, saved.code, { path: saved.path })) : fail(res, 409, saved.code);
      if (dry) return send(res, 200, {});
      const applied = saved.applied as { language?: string; agents?: { bypassPermissions?: boolean }; guard?: { mode?: 'enforce' | 'shadow' } };
      if (applied.language !== undefined) ctx.setLanguage(applied.language);
      if (applied.agents?.bypassPermissions !== undefined || applied.guard?.mode !== undefined) ctx.applySettings({ bypass: applied.agents?.bypassPermissions, guardMode: applied.guard?.mode });
      ctx.applyConfig(saved.config, saved.applied);
      if ((saved.applied as { notifications?: unknown }).notifications !== undefined) ctx.applyNotifications(saved.config.notifications);
      ctx.broadcastState();
      return send(res, 200, saved.applied);
    }

    // The Options dialog (SPEC 5.8): the effective configuration and the read-only facts it shows.
    if (req.method === 'GET' && path === '/api/options') {
      const { config, errors } = loadConfig(ctx.configPath);
      const dir = dirname(ctx.configPath);
      const profilesDir = join(dir, 'profiles');
      return send(res, 200, {
        config, errors, paths: { configDir: dir, profilesDir, templatesDir: join(dir, 'templates') }, server: { port: ctx.getPort() },
        profiles: listProfileNames(ctx.projectRoot, profilesDir).map((name) => ({ name, source: loadProfile(name, ctx.projectRoot, profilesDir)?.source ?? null })),
      });
    }
    // Profiles (Options, Profiles): the user's own files in the config folder; a shipped name is edited as a copy and restored by removing it.
    const userProfiles = join(dirname(ctx.configPath), 'profiles');
    if (req.method === 'GET' && path === '/api/profiles') return send(res, 200, describeProfiles(ctx.projectRoot, userProfiles));
    if (req.method === 'POST' && path === '/api/profiles/restore') {
      const restored = restoreShippedProfiles(userProfiles);
      forgetProfileNames();
      ctx.broadcastState();
      return send(res, 200, { restored });
    }
    const oneProfile = /^\/api\/profiles\/([a-z0-9-]+)$/.exec(path);
    if (oneProfile && req.method === 'PUT') {
      const body = await readBodyOr400(req, res);
      if (body === undefined) return;
      const checked = validateProfileInput(body);
      if (!checked.ok) return fail(res, 422, 'profile.fieldInvalid', { field: checked.field });
      if (checked.input.name !== oneProfile[1]) return fail(res, 422, 'profile.fieldInvalid', { field: 'name' });
      saveUserProfile(userProfiles, checked.input);
      forgetProfileNames();
      ctx.broadcastState();
      return send(res, 200, describeProfiles(ctx.projectRoot, userProfiles).find((p) => p.name === checked.input.name) ?? {});
    }
    if (oneProfile && req.method === 'DELETE') {
      if (!removeUserProfile(userProfiles, oneProfile[1]!)) return fail(res, 404, 'profile.notFound');
      forgetProfileNames();
      ctx.broadcastState();
      return send(res, 200, { name: oneProfile[1] });
    }
    if (req.method === 'GET' && path === '/api/models') return send(res, 200, await ctx.models.list());
    if (req.method === 'POST' && path === '/api/models/refresh') return send(res, 200, await ctx.models.list(true));
    if (req.method === 'GET' && path === '/api/plugins') return send(res, 200, await ctx.plugins.list(ctx.getPrereq()?.find((r) => r.id === 'claude')?.version));
    // Which catalog plugins are installed for this project, asked of Claude Code itself; `installed: null` when it cannot tell.
    if (req.method === 'GET' && path === '/api/plugins/installed') {
      const { readInstalled, statusOf } = await import('./catalog/installed');
      const listed = await readInstalled(ctx.claudeCommand, ctx.commandRunner);
      const ids = (await ctx.plugins.list(undefined)).plugins.map((p) => p.id);
      return send(res, 200, { installed: listed === null ? null : Object.fromEntries(ids.map((id) => [id, statusOf(id, listed, ctx.projectRoot)])) });
    }
    if (req.method === 'POST' && path === '/api/plugins/refresh') return send(res, 200, await ctx.plugins.list(ctx.getPrereq()?.find((r) => r.id === 'claude')?.version, true));

    if (req.method === 'PUT' && path === '/api/project') {
      const b = await readObjectBody(req, res);
      if (!b) return;
      const hasCommand = 'testCommand' in b;
      const hasSquash = 'squash' in b;
      const hasTests = 'testsDisabled' in b;
      const hasMoments = 'testCommands' in b;
      const hasRepos = 'repoTestCommands' in b;
      const knownProfiles = listProfileNames(ctx.projectRoot, join(dirname(ctx.configPath), 'profiles'));
      const projectFields = PROJECT_FIELDS.filter((f) => f in b); // Phase 6D: build/lint commands, profiles, model, budget, limit, docs, secrets
      if (!hasCommand && !hasSquash && !hasTests && !hasMoments && !hasRepos && projectFields.length === 0) return fail(res, 400, 'bad_request');
      // Everything is checked before anything is written: a bad entry changes nothing.
      if (hasSquash && typeof b.squash !== 'boolean') return fail(res, 422, 'project.squashInvalid');
      if (hasTests && typeof b.testsDisabled !== 'boolean') return fail(res, 422, 'project.testsDisabledInvalid');
      if (hasCommand && !isValidTestCommand(b.testCommand)) return fail(res, 422, 'project.testCommandInvalid');
      if (hasMoments && !isValidTestCommands(b.testCommands)) return fail(res, 422, 'project.testCommandInvalid');
      if (hasRepos && !isValidRepoTestCommands(b.repoTestCommands)) return fail(res, 422, 'project.testCommandInvalid');
      const knownRepos = ctx.repos().filter((r) => r !== '');
      const strangers = hasRepos ? unknownRepos(b.repoTestCommands as Record<string, string>, knownRepos) : [];
      // The text names the repositories that can be used; a folder that is itself the repository has none to name.
      if (strangers.length > 0) {
        return knownRepos.length > 0
          ? fail(res, 422, 'project.repoUnknown', { repos: strangers.join(', '), available: knownRepos.join(', ') })
          : fail(res, 422, 'project.repoUnknownNone', { repos: strangers.join(', ') });
      }
      for (const f of projectFields) {
        const v = typeof b[f] === 'string' ? (b[f] as string).trim() : b[f];
        const clears = v === null || v === '' || (Array.isArray(v) && v.length === 0);
        if (!clears && !isValidProjectField(f, v, knownProfiles)) {
          const lim = PROJECT_RANGES[f];
          if (lim && typeof v === 'number') return fail(res, 422, 'config.outOfRange', { path: `project.${f}`, min: lim[0], max: lim[1] });
          return fail(res, 422, 'project.fieldInvalid', { field: f });
        }
      }
      if (new URL(req.url ?? '/', 'http://x').searchParams.get('dryRun') === '1') return send(res, 200, {}); // checked, nothing written
      if (hasCommand) ctx.store.setTestCommand(b.testCommand as string);
      if (hasMoments) ctx.store.setTestCommands(b.testCommands);
      if (hasRepos) ctx.store.setRepoTestCommands(b.repoTestCommands, knownRepos);
      if (hasSquash) ctx.store.setSquash(b.squash as boolean);
      if (hasTests) ctx.store.setTestsDisabled(b.testsDisabled as boolean);
      if (projectFields.length > 0) ctx.store.setFields(Object.fromEntries(projectFields.map((f) => [f, b[f]])), knownProfiles);
      ctx.broadcastState();
      const saved = ctx.store.project;
      return send(res, 200, { ...(hasCommand && saved.testCommand ? { testCommand: saved.testCommand } : {}), ...(hasMoments && saved.testCommands ? { testCommands: saved.testCommands } : {}), ...(hasRepos && saved.repoTestCommands ? { repoTestCommands: saved.repoTestCommands } : {}), ...(hasSquash ? { squash: b.squash } : {}), ...(hasTests ? { testsDisabled: b.testsDisabled } : {}), ...Object.fromEntries(projectFields.filter((f) => saved[f] !== undefined).map((f) => [f, saved[f]])) });
    }

    if (req.method === 'POST' && path === '/api/projects/save-template') {
      const b = (await readObjectBody(req, res)) as { id?: unknown; name?: unknown; overwrite?: unknown } | undefined;
      if (!b) return;
      let project;
      try { project = ctx.store.project; } catch { return fail(res, 422, 'template.invalid'); }
      const saved = saveTemplate({ projectRoot: ctx.projectRoot, project, configDir: dirname(ctx.configPath), id: String(b.id ?? ''), name: b.name, overwrite: b.overwrite === true });
      if (!saved.ok) return fail(res, saved.code === 'template.exists' ? 409 : 422, saved.code);
      return send(res, 201, { id: String(b.id) });
    }

    // Changes the template of the open project: the profiles, main.md and rules.md of the new one replace the files of the same name; the
    // commands already set stay (what the user typed beats the template's).
    if (req.method === 'POST' && path === '/api/projects/apply-template') {
      const body = await readBodyOr400(req, res);
      if (body === undefined) return;
      if (typeof body !== 'object' || body === null || Array.isArray(body) || typeof (body as { templateId?: unknown }).templateId !== 'string') return fail(res, 400, 'bad_request');
      let current;
      try { current = ctx.store.project; } catch { return fail(res, 422, 'template.invalid'); }
      const { applyTemplate } = await import('./templates/apply');
      const done = await applyTemplate({
        templateId: (body as { templateId: string }).templateId, root: ctx.projectRoot, name: ctx.projectName, create: false,
        build: current.buildCommand, test: current.testCommand, lint: current.lintCommand, configDir: dirname(ctx.configPath),
      });
      if (!done.ok) return fail(res, 422, done.code);
      ctx.broadcastState();
      return send(res, 200, { templateId: (body as { templateId: string }).templateId });
    }

    // Copies the settings of another open project onto this one (profiles, rules and project.json fields; nothing of its agents or tickets).
    if (req.method === 'POST' && path === '/api/projects/copy-settings') {
      const body = await readBodyOr400(req, res);
      if (body === undefined) return;
      const from = typeof body === 'object' && body !== null ? (body as { from?: unknown }).from : undefined;
      if (typeof from !== 'string') return fail(res, 400, 'bad_request');
      const source = ctx.projects?.contexts().find((c) => c.projectName === from);
      if (!source || source === ctx) return fail(res, 404, 'project.notFound');
      const { copyProjectSettings } = await import('./templates/copy');
      const done = copyProjectSettings(source.projectRoot, ctx.projectRoot, ctx.projectName);
      if (!done.ok) return fail(res, 422, done.code);
      ctx.broadcastState();
      return send(res, 200, { from });
    }

    // Makes the project folder a git repository (`git init -b main` and an empty first commit). Refused when it already is, or holds repositories.
    if (req.method === 'POST' && path === '/api/projects/git-init') {
      if (ctx.repos().includes('')) return fail(res, 409, 'git.alreadyRepo'); // the folder itself is a repository (one that only holds repositories may still become one)
      const { initRepo } = await import('./templates/apply');
      const made = await initRepo(ctx.projectRoot);
      if (!made.ok) return fail(res, 422, made.code, made.detail ? { reason: made.detail } : undefined);
      await afterRepoMade(ctx);
      return send(res, 200, { ok: true });
    }

    // Makes the project folder a clone of a remote repository (the folder must hold nothing but the console's own files). Refused when it is
    // already a repository, or holds repositories. The address is checked first: https, ssh or git@host:path only.
    if (req.method === 'POST' && path === '/api/projects/git-clone') {
      const body = await readBodyOr400(req, res);
      if (body === undefined) return;
      const url = typeof body === 'object' && body !== null ? (body as { url?: unknown }).url : undefined;
      if (typeof url !== 'string') return fail(res, 400, 'bad_request');
      if (ctx.repos().includes('')) return fail(res, 409, 'git.alreadyRepo');
      const { cloneIntoFolder, validCloneUrl } = await import('./git/clone');
      if (!validCloneUrl(url.trim())) return fail(res, 422, 'git.cloneUrlInvalid');
      const done = await cloneIntoFolder(ctx.projectRoot, url.trim());
      if (!done.ok) return fail(res, done.code === 'git.cloneFolderNotEmpty' ? 409 : 422, done.code, done.detail ? { reason: done.detail } : undefined);
      await afterRepoMade(ctx);
      return send(res, 200, { ok: true, ...(done.branch ? { branch: done.branch } : {}) });
    }

    return fail(res, 404, 'not_found');
  };
}
