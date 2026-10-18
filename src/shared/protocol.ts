/** Wire types shared by the server and the browser UI. Codes are English constants, never sentences (P11). */
import type { Activity } from './activity';
import type { RequestRow, RequestsInfo } from './requests';
import type { UpdateState } from './update';
import type { NotificationsConfig, ToastStatus } from './notify';

export const PROFILES = ['developer', 'reviewer', 'recovery'] as const;
export type Profile = (typeof PROFILES)[number];

/** Error codes the user can act on: each one needs an `error.<code>` text in every language (checked at build). */
export const USER_ERROR_CODES = [
  'slug.missing', 'slug.format', 'slug.length', 'slug.generic', 'slug.reserved', 'slug.duplicate',
  'profile.invalid', 'profile.fieldInvalid', 'profile.notFound', 'model.invalid', 'prereq.blocked', 'agent.spawnFailed',
  'git.notRepo', 'git.alreadyRepo', 'git.noCommits', 'git.worktreeExists', 'project.testCommandInvalid', 'project.repoUnknown', 'project.repoUnknownNone', 'config.unreadable', 'review.useRequestReview', 'project.squashInvalid', 'recovery.useRecoveryTool',
  'folder.pickBusy', 'project.duplicate', 'project.badRoot', 'project.badName', 'project.notFound',
  'install.busy', 'install.unavailable',
  'agent.notDormant', 'agent.notArchivable', 'agent.notArchived', 'agent.noSession', 'agent.noWorktree', 'agent.quotaHigh', 'agent.wakeFailed',
  'project.fieldInvalid', 'project.badRoot', 'template.notFound', 'template.invalid', 'template.exists', 'template.idInvalid',
  'git.notRepo', 'git.noCommits', 'git.repoRequired', 'git.unknownRepo', 'git.worktreeExists', 'project.testCommandInvalid', 'config.unreadable', 'config.invalid', 'config.outOfRange', 'project.testsDisabledInvalid', 'git.cloneUrlInvalid', 'git.cloneFolderNotEmpty', 'git.cloneFailed', 'review.useRequestReview', 'project.squashInvalid', 'recovery.useRecoveryTool',
  'dictation.noKey', 'dictation.tooLarge', 'dictation.emptyAudio', 'dictation.badType', 'dictation.groqRejected', 'dictation.timeout', 'dictation.noSpeech', 'dictation.network', 'dictation.keyInvalid', 'dictation.mainNotRunning', 'dictation.textEmpty',
] as const;

/** `pending`: no process yet (the agent waits in the queue for a free slot). */
export type SessionStatus = 'running' | 'exited' | 'pending';

export interface SessionInfo {
  slug: string;
  profile: string;
  role: 'main' | 'agent';
  /** Process status (is the process alive). */
  status: SessionStatus;
  /** What the session is doing, from mod events (plus `studying`/`blocked`, derived from the ticket). */
  state: Activity;
  /** Closed steps of the agent's checklist; absent until it has one. */
  progress?: { done: number; total: number };
  /** Where the ticket is in the review/merge pipeline; absent while the author is still writing it for the first time. */
  ticket?: { status: string; round: number; maxRounds: number; /** Waiting for the machine's test queue: the place of its run (1 = next). */ testQueue?: number };
  /** The launch check found the agent not started or not working on its goal; clears when it starts working. */
  launchStalled?: true;
  /** Why `launchStalled` is set: Claude Code never reported in (often a trust dialog), or it runs but has not taken its goal. */
  launchProblem?: 'no_session' | 'goal_not_taken';
  /** Minutes without a sign of life of a working agent, once past `budget.loop.silenceMinutes`; absent otherwise (SPEC 32.2). */
  silentMinutes?: number;
  /** Items of this agent waiting in the queue (questions, permissions); absent when none. */
  waiting?: number;
  /** Loop handling (Phase 5): 1 corrected, 2 limited, 3 stopped; absent when none. */
  loop?: 1 | 2 | 3;
  /** Token budget of the agent's ticket (Phase 5); absent when the agent has none (no worktree, a reviewer): shown as n/a. */
  budget?: { used: number; limit: number; step: 'ok' | 'alert' | 'limit' | 'stopped' };
  /** Phase 6A: the agent's worktree has not been touched for longer than `git.staleWorktreeDays`. */
  stale?: true;
  /** Out of the agents column, listed in the archive (the session ended for good, or the user archived it); `archivedAt` is when. */
  archived?: true;
  archivedAt?: string;
  /** Requests between agents (SPEC 10): steps waiting for an answer and requests this agent still owes; absent when none. */
  requests?: RequestsInfo;
}

export interface PrereqResult {
  id: 'node' | 'git' | 'claude' | 'gh' | 'python' | 'rg' | 'ctags' | 'jq' | 'fd' | 'shellcheck' | 'uv';
  required: boolean;
  status: 'ok' | 'outdated' | 'missing' | 'error' | 'not_required' | 'restart';
  version?: string;
  message?: string;
}

/** A question waiting for the human (SPEC 5.6). */
export interface QueueItem {
  id: string;
  from: string;
  /** `confirm` and `decision` come from the console itself (from "console"): a release to approve, a ticket that needs the user. */
  kind: 'question' | 'permission' | 'confirm' | 'decision';
  text: string;
  /** Data of a console item (tickets, report text, review notes); shape depends on the item. */
  payload?: unknown;
  tool?: string;
  detail?: string;
  options?: string[];
  multiSelect?: boolean;
  createdAt: string;
}

export interface StateMessage {
  type: 'state';
  /** The machine's queue of long test runs (shared by every project); absent while it is empty. */
  testQueue?: { running: { label: string; owner?: string }[]; waiting: { label: string; owner?: string; position: number }[] };
  project: { name: string; /** What the console runs for the validation step of every ticket. */ testCommand?: string; /** Commands for single moments (`ticket`, `merge`, `release`); a missing one uses `testCommand`. */ testCommands?: { ticket?: string; merge?: string; release?: string }; /** What the project's files suggest (used while `testCommand` is empty). */ detectedTestCommand?: string; /** The repository folder names of a project folder that holds several (`Ticket.repo`); empty for a folder that is one repository. */ repos: string[]; /** A command per repository (keyed by folder name), before every other. */ repoTestCommands?: Record<string, string>; /** What each repository's files suggest; a repository with nothing detected is left out. */ detectedRepoTestCommands?: Record<string, string>; /** One commit per merged ticket (default true). */ squash?: boolean; /** The tests are switched off for this project: no test run, and the reports say so. */ testsDisabled?: boolean; /** The model this project's agents get (empty: the one of Options, Models). */ model?: string; /** The most agents running at once in this project. */ maxActive?: number };
  /** What the Settings dialog shows; a change applies to sessions launched afterwards. */
  settings: { bypassPermissions: boolean; guardMode: 'enforce' | 'shadow'; worktrees: boolean };
  main: SessionInfo;
  agents: SessionInfo[];
  language: string;
  /** Every language that has a bundle file (a new language is just a new file, SPEC 5.9). */
  languages: string[];
  profiles: readonly string[];
  /** null until the startup checks finish (unknown is not "ok", P7). */
  prereq: PrereqResult[] | null;
  /** Shell commands that used each optional helper since `since` (counters only, never the commands). */
  helperUse?: { since: string; counts: Partial<Record<'python' | 'rg' | 'ctags' | 'jq' | 'fd' | 'shellcheck' | 'uv', number>> };
  /** true until the first-start wizard saved a configuration file. */
  needsSetup: boolean;
  projectIsRepo: boolean;
  /** The git repositories agents can work in, relative to the project folder (`['']` when the project folder is one); empty when there is none. */
  repos: string[];
  projectRoot: string;
  /** Everything that waits for the user: questions from the main and the agents. */
  queue: QueueItem[];
  /** The live requests between agents and the latest settled ones (SPEC 10); absent when there are none. */
  requests?: RequestRow[];
  /** The console is waiting for a usage limit to lift (Phase 5); absent when it is not. `until` is when the next probe is due. */
  sleep?: { until?: string; phase: 'sleeping' | 'probing' | 'awake'; attempt: number; weekly: boolean };
  /** The most used usage limit of the subscription; ABSENT when unknown (shown as n/a, never as zero). */
  quota?: { percent: number; kind: string };
  /** Agents counting against the active-agent limit, and that limit as it is now (the quota step may have cut it). */
  limits?: { active: number; max: number };
  /** Every open project, in the order they were opened (Phase 6C): the tabs. */
  projects?: ProjectTab[];
  /** The last assisted install that ended (Phase 6F); absent until one did since the console started. */
  install?: { id: string; result: 'needs_admin' | 'failed' | 'done'; exitCode: number };
  /** A newer version of the desktop app (SPEC 33.4); absent when there is none or the console is not the desktop app. */
  update?: UpdateState;
  /** Phase 6B: whether a native toast can be shown (`unknown` until checked, shown as n/a) and the notification settings. */
  notifications?: { toast: ToastStatus; config: NotificationsConfig };
  /** State files the console could not read and set aside (newest last); absent when there are none. The page offers to dismiss them. */
  stateProblems?: { file: string; movedTo: string; at: string }[];
}

/** One tab: `waiting` is the length of that project's queue (a dot when above zero). */
export interface ProjectTab { name: string; root: string; waiting: number; mainStatus: SessionStatus }

export interface ApiError {
  code: string;
  params?: Record<string, string | number>;
}

/** Control message the browser sends as a text frame on a terminal socket; keyboard input is a binary frame. */
export interface ResizeMessage { type: 'resize'; cols: number; rows: number }

/** What the console knows about itself with or without a project (`GET /api/host`): the welcome screen asks this first. */
export interface HostInfo {
  projects: ProjectTab[];
  language: string;
  languages: string[];
  needsSetup: boolean;
}
