import type { createTranslator } from '../../shared/i18n';
import type { Inbox } from '../agents/inbox';
import type { AgentRegistry } from '../agents/registry';
import type { ProjectStore, TestMoment } from '../project-store';
import type { PtyManager } from '../pty/pty-manager';
import type { TestRunner } from '../tickets/test-queue';
import type { PermissionMemory } from '../questions/permission-memory';
import type { QuestionQueue } from '../questions/queue';
import type { ReadingStore } from '../reading/store';
import type { RequestStore } from '../requests/store';
import type { LaunchWatch } from '../agents/launch-watch';
import type { Scheduler } from '../agents/scheduler';
import type { QuotaService, QuotaStep } from '../budget/quota';
import type { TranscriptReader } from '../claude-code/transcript';
import type { ResumeService, WakeResult } from '../agents/resume';
import type { WakeService } from '../agents/wake';
import type { AgentPersister } from '../agents/persist';
import type { TicketStatus } from '../tickets/flow';
import type { Context } from '../http';
import type { StaleChecker } from '../git/stale';
import type { RequestService } from '../requests/service';
import type { SessionTokens } from '../security';
import type { StateProblems } from '../state-problems';
import type { TicketStore } from '../tickets/store';
import type { KeyedQueue } from '../keyed-queue';
import type { StepService } from '../tickets/steps';
import type { ReviewService } from '../tickets/review';
import type { CentralRun } from '../tickets/central';
import type { MergeService } from '../tickets/merge';
import type { ReleaseService } from '../tickets/release';
import type { RecoveryService } from '../tickets/recovery';
import type { BudgetService } from '../budget/service';
import type { Restrictions } from '../budget/restrictions';
import type { LoopService } from '../budget/loop-service';
import type { GuardLog } from '../guard/log';
import type { Notifier } from '../notify/notifier';
import type { Presence } from '../notify/presence';
import type { NotificationService } from '../notify/service';
import type { ProjectTab } from '../../shared/protocol';
import type { Container } from './container';
import type { Env } from './env';

/** Every service of a project, by name. Each area adds its own (see the register of the area). */
export interface Services {
  env: Env;
  // state (runtime/state.ts)
  stateProblems: StateProblems;
  store: ProjectStore;
  previousRunWasClean: boolean;
  projectName: string;
  inbox: Inbox;
  questions: QuestionQueue;
  permissions: PermissionMemory;
  reading: ReadingStore;
  tickets: TicketStore;
  requestStore: RequestStore;
  secretPatterns: () => string[];
  // tests (runtime/tests.ts)
  /** The command a folder's files suggest: `cwd` (a repository folder a run happens in), else the project folder. */
  detectedTestCommand: (cwd?: string) => string | undefined;
  testsDisabled: () => boolean;
  /** The command of a moment for a run in `cwd` (the repository folder it runs in); without `cwd`, detection looks at the project folder. */
  testCommandAt: (moment: TestMoment) => (cwd?: string) => string | undefined;
  testRunnerAt: (moment: TestMoment) => TestRunner;
  reportLanguage: () => { lang: string; t: ReturnType<typeof createTranslator> };
  // agents (runtime/agents.ts)
  ptys: PtyManager;
  tokens: SessionTokens;
  mainResumeId: () => string | undefined;
  registry: AgentRegistry;
  sessionGuardMode: Map<string, 'enforce' | 'shadow'>;
  launchLog: Map<string, string[]>;
  repos: () => string[];
  forgetRepos: () => void;
  prepareRepo: (path: string) => Promise<void>;
  launchWatch: LaunchWatch;
  endTimers: Set<ReturnType<typeof setTimeout>>;
  finishAgent: (slug: string, opts?: { stopped?: boolean }) => Promise<void>;
  endReadOnlySession: (slug: string) => void;
  readHandover: (slug: string) => string | undefined;
  keepHandover: (slug: string) => void;
  repoOfTicket: (slug: string) => { repo?: string };
  quotaStepRef: { value: QuotaStep };
  scheduler: Scheduler;
  launchMain: (resumeId: string | undefined) => void;
  staleChecker: StaleChecker;
  // ticket-flow (runtime/ticket-flow.ts)
  ticketQueue: KeyedQueue;
  review: ReviewService;
  central: CentralRun;
  merge: MergeService;
  release: ReleaseService;
  recovery: RecoveryService;
  onBudgetAnswer: (answer: string, payload: { ticket: string }) => Promise<void>;
  steps: StepService;
  requests: RequestService;
  // budget (runtime/budget.ts)
  reader: TranscriptReader;
  restrictions: Restrictions;
  turns: Map<string, number>;
  budget: BudgetService;
  loop: LoopService;
  quota: QuotaService;
  quotaWaiters: Set<() => void>;
  wakeTimers: Set<unknown>;
  resumedAwaitingStart: Set<string>;
  wakeMain: () => Promise<WakeResult>;
  weeklyNotice: (resetsAt: string | undefined) => void;
  resumer: ResumeService;
  waker: WakeService;
  persister: AgentPersister;
  ticketStatusOf: (slug: string) => TicketStatus | undefined;
  onQuotaReading: (rateLimits: unknown) => void;
  // http-context (runtime/http-context.ts)
  broadcast: () => void;
  guardLog: GuardLog;
  notifier: Notifier;
  presence: Presence;
  notify: NotificationService;
  ctx: Context;
  // lifecycle (runtime/lifecycle.ts)
  refreshSilence: () => void;
  budgetTick: ReturnType<typeof setInterval>;
  /** The daily stale-branch check, armed by `startProject` and cleared by `close`. */
  staleTimerRef: { value: ReturnType<typeof setInterval> | undefined };
  startProject: () => void;
  summary: () => ProjectTab;
  close: () => Promise<void>;
}
export type ProjectContainer = Container<Services>;
