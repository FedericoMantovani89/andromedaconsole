import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnAgent } from '../agents/spawn';
import { budgetAnswerHandler } from '../budget/answers';
import { commonDir, removeWorktree } from '../git/worktree';
import { KeyedQueue } from '../keyed-queue';
import { CONSOLE_FROM } from '../questions/queue';
import { RequestService } from '../requests/service';
import { CentralRun } from '../tickets/central';
import { createCentralGit } from '../tickets/central-git';
import { MergeService } from '../tickets/merge';
import { RecoveryService, replacementCheckout } from '../tickets/recovery';
import { ReleaseService } from '../tickets/release';
import { ReviewService } from '../tickets/review';
import { StepService } from '../tickets/steps';
import { authorActive, authorRunning, spawnResult, wipCommitFor } from './helpers';
import type { ProjectContainer } from './services';

/** How long after the last merge the central full run waits for another one: merges that follow each other share one run. */
const CENTRAL_SETTLE_MS = 120_000;

/** The services that carry a ticket from its steps to the release: the shared queue, review, central run, merge, release, recovery, and the requests between agents. */
export function registerTicketFlow(c: ProjectContainer): void {
  c.provide('ticketQueue', () => new KeyedQueue()); // one queue per ticket, shared by every service that changes it
  c.provide('review', (k) => {
    const { o, runtime } = k.get('env');
    const ticketQueue = k.get('ticketQueue');
    const tickets = k.get('tickets');
    const projectName = k.get('projectName');
    const registry = k.get('registry');
    const testCommandAt = k.get('testCommandAt');
    const testRunnerAt = k.get('testRunnerAt');
    const testsDisabled = k.get('testsDisabled');
    const reportLanguage = k.get('reportLanguage');
    const repoOfTicket = k.get('repoOfTicket');
    const store = k.get('store');
    const inbox = k.get('inbox');
    const questions = k.get('questions');
    const endReadOnlySession = k.get('endReadOnlySession');
    return new ReviewService({
      queue: ticketQueue,
      tickets, root: o.projectRoot, project: projectName,
      worktreeOf: (slug) => registry.get(slug)?.git,
      testCommand: testCommandAt('ticket'),
      runTests: testRunnerAt('ticket'),
      testsDisabled,
      testTimeoutMs: () => runtime.git.testTimeoutMinutes * 60_000,
      // Report headings follow the interface language; "auto" is resolved by the browser, so the server uses English for it.
      language: reportLanguage,
      spawnReviewer: async (r) => {
        const out = await spawnAgent(k.get('ctx'), { slug: r.slug, profile: 'reviewer', goal: r.goal, model: r.model, source: 'main', review: { ticket: r.ticket, sha: r.sha }, ...repoOfTicket(r.ticket) });
        return spawnResult(out);
      },
      existingSlugs: () => [projectName, ...store.listAgents().map((a) => a.slug)],
      authorAlive: authorRunning(k),
      notifyMain: (text) => { inbox.push(projectName, text); },
      notifyAuthor: (slug, text) => { inbox.push(slug, text); },
      askUser: (q, onAnswer) => { questions.ask({ from: CONSOLE_FROM, text: q.text, kind: 'decision', options: q.options, payload: q.payload }, onAnswer); },
      endReviewer: (slug) => endReadOnlySession(slug),
    });
  });
  // The full run on the merged project branch: after the merges settle, one run for the whole batch, through the queue.
  c.provide('central', (k) => {
    const { o, shared, runtime } = k.get('env');
    const tickets = k.get('tickets');
    const projectName = k.get('projectName');
    const stateProblems = k.get('stateProblems');
    const testCommandAt = k.get('testCommandAt');
    const inbox = k.get('inbox');
    const questions = k.get('questions');
    return new CentralRun({
      root: o.projectRoot, project: projectName, tickets, report: stateProblems.add,
      command: testCommandAt('release'),
      mergeCommand: testCommandAt('merge'),
      testsDisabled: k.get('testsDisabled'),
      timeoutMs: () => runtime.git.testTimeoutMinutes * 60_000,
      settleMs: CENTRAL_SETTLE_MS,
      merging: () => k.get('merge').inFlight(),
      git: createCentralGit({ root: o.projectRoot, project: projectName, runTests: (job) => shared.testQueue.run(job), timeoutMs: () => runtime.git.testTimeoutMinutes * 60_000 }),
      runTests: (job) => shared.testQueue.run({ ...job, onWait: () => shared.broadcastAll() }),
      authorAlive: authorActive(k),
      notifyAuthor: (slug, text) => { inbox.push(slug, text); },
      notifyMain: (text) => { inbox.push(projectName, text); },
      askUser: (q, onAnswer) => { questions.ask({ from: CONSOLE_FROM, text: q.text, kind: 'decision', options: q.options, payload: q.payload }, onAnswer); },
      changed: () => shared.broadcastAll(),
    });
  });
  c.provide('merge', (k) => {
    const { o, runtime } = k.get('env');
    const tickets = k.get('tickets');
    const projectName = k.get('projectName');
    const registry = k.get('registry');
    const testCommandAt = k.get('testCommandAt');
    const testRunnerAt = k.get('testRunnerAt');
    const testsDisabled = k.get('testsDisabled');
    const store = k.get('store');
    const reportLanguage = k.get('reportLanguage');
    const inbox = k.get('inbox');
    const finishAgent = k.get('finishAgent');
    return new MergeService({
      tickets, root: o.projectRoot, project: projectName,
      worktreeOf: (slug) => registry.get(slug)?.git,
      testCommand: testCommandAt('merge'),
      runTests: testRunnerAt('merge'),
      testsDisabled,
      testTimeoutMs: () => runtime.git.testTimeoutMinutes * 60_000,
      squash: () => store.project.squash !== false,
      language: reportLanguage,
      authorAlive: authorActive(k),
      notifyMain: (text) => { inbox.push(projectName, text); },
      notifyAuthor: (slug, text) => { inbox.push(slug, text); },
      needsUser: (slug, reason) => { k.get('review').askUserAboutTicket(slug, reason); },
      merged: () => k.get('central').merged(),
      finishAgent: async (slug) => { await finishAgent(slug); registry.setGit(slug, undefined); },
    });
  });
  c.provide('release', (k) => {
    const { o, shared, runtime } = k.get('env');
    const tickets = k.get('tickets');
    const projectName = k.get('projectName');
    const testCommandAt = k.get('testCommandAt');
    const testRunnerAt = k.get('testRunnerAt');
    const reportLanguage = k.get('reportLanguage');
    const inbox = k.get('inbox');
    const questions = k.get('questions');
    const tokens = k.get('tokens');
    return new ReleaseService({
      tickets, root: o.projectRoot, project: projectName,
      testCommand: testCommandAt('release'),
      runTests: testRunnerAt('release'),
      greenFor: (repo, tip, command) => k.get('central').greenFor(repo, tip, command),
      testTimeoutMs: () => runtime.git.testTimeoutMinutes * 60_000,
      language: reportLanguage,
      notifyMain: (text) => { inbox.push(projectName, text); },
      askConfirm: (q, onAnswer) => questions.ask({ from: CONSOLE_FROM, text: q.text, kind: 'confirm', payload: q.payload }, onAnswer).id,
      isOpen: (id) => questions.pending().some((q) => q.id === id),
      answer: (id, answer) => questions.answer(id, answer),
      // The main's mod got its release key at start (the token is the main's current one): only then can a dialog answer reach the console.
      dialogReadable: () => { const t = tokens.tokenFor(projectName); return t !== undefined && tokens.hasReleaseKey(t); },
      changed: () => shared.broadcastAll(),
    });
  });
  // Recovery after a stop (SPEC 16.5): a read-only session diagnoses, then a NEW agent takes the ticket over on the same branch.
  c.provide('recovery', (k) => {
    const { o, shared, runtime, ledger } = k.get('env');
    const ticketQueue = k.get('ticketQueue');
    const tickets = k.get('tickets');
    const projectName = k.get('projectName');
    const registry = k.get('registry');
    const testCommandAt = k.get('testCommandAt');
    const testRunnerAt = k.get('testRunnerAt');
    const repoOfTicket = k.get('repoOfTicket');
    const restrictions = k.get('restrictions');
    const ptys = k.get('ptys');
    const finishAgent = k.get('finishAgent');
    const store = k.get('store');
    const inbox = k.get('inbox');
    const questions = k.get('questions');
    const endReadOnlySession = k.get('endReadOnlySession');
    const budget = k.get('budget');
    const readHandover = k.get('readHandover');
    return new RecoveryService({
      queue: ticketQueue,
      tickets, ledger, root: resolve(o.projectRoot), project: projectName,
      worktreeOf: (slug) => registry.get(slug)?.git,
      testCommand: testCommandAt('ticket'),
      runTests: testRunnerAt('ticket'),
      testTimeoutMs: () => runtime.git.testTimeoutMinutes * 60_000,
      spawnRecovery: async (r) => {
        const out = await spawnAgent(k.get('ctx'), { slug: r.slug, profile: 'recovery', goal: r.goal, model: r.model, source: 'main', recovery: { ticket: r.ticket, sha: r.sha }, ...repoOfTicket(r.ticket) });
        return spawnResult(out);
      },
      spawnReplacement: async (r) => {
        // The stopped agent's restriction goes with its session; the new name never inherits one.
        restrictions.clear(r.from);
        if (ptys.status(r.from) === 'running') await finishAgent(r.from, { stopped: true });
        const old = registry.get(r.from)?.git;
        // No fallback to a normal spawn: without the stopped agent's worktree the new one would start on a NEW branch.
        const checkout = replacementCheckout(runtime.git.worktrees, old);
        if (!checkout.ok) return { ok: false, code: checkout.code, detail: `the worktree of ${r.from} is not known` };
        if (old) {
          // Whatever is still uncommitted is kept on the branch before the folder goes (git refuses a branch checked out twice).
          const wip = await wipCommitFor(k)(r.from, 'handover');
          if (!wip.ok) return { ok: false, code: 'wip_failed', detail: wip.detail };
          const oldRepo = old.repo ?? o.projectRoot;
          await removeWorktree(oldRepo, old.worktree);
          rmSync(join(await commonDir(oldRepo), 'console-hooks', r.from), { recursive: true, force: true });
          registry.setGit(r.from, undefined);
        }
        const out = await spawnAgent(k.get('ctx'), {
          slug: r.slug, profile: r.profile, goal: r.goal, model: r.model, source: 'main',
          ...(r.budget !== undefined ? { budget: r.budget } : {}), ...(old ? { resumeBranch: old.branch } : {}), ...repoOfTicket(r.slug),
        });
        return spawnResult(out);
      },
      existingSlugs: () => [projectName, ...store.listAgents().map((a) => a.slug)],
      notifyMain: (text) => { inbox.push(projectName, text); },
      askUser: (q, onAnswer) => { questions.ask({ from: CONSOLE_FROM, text: q.text, kind: 'decision', options: q.options, payload: q.payload }, onAnswer); },
      endRecovery: (slug) => endReadOnlySession(slug),
      budget,
      profileOf: (ticket) => store.listAgents().find((a) => a.slug === ticket)?.profile ?? registry.get(ticket)?.profile ?? 'developer',
      readHandover,
      // The live requests follow the ticket to the replacement's name (and back, when its start fails).
      renamed: (from, to) => { k.get('requests').rename(from, to); },
      changed: () => shared.broadcastAll(),
    });
  });
  c.provide('onBudgetAnswer', (k) => {
    const { shared } = k.get('env');
    const budget = k.get('budget');
    const tickets = k.get('tickets');
    const recovery = k.get('recovery');
    const inbox = k.get('inbox');
    const projectName = k.get('projectName');
    return budgetAnswerHandler({ budget, tickets, recovery, tellMain: (text) => { inbox.push(projectName, text); }, changed: () => shared.broadcastAll() });
  });
  c.provide('steps', (k) => {
    const { shared, runtime } = k.get('env');
    const ticketQueue = k.get('ticketQueue');
    const tickets = k.get('tickets');
    const projectName = k.get('projectName');
    const registry = k.get('registry');
    const testCommandAt = k.get('testCommandAt');
    const testRunnerAt = k.get('testRunnerAt');
    const testsDisabled = k.get('testsDisabled');
    const secretPatterns = k.get('secretPatterns');
    const inbox = k.get('inbox');
    return new StepService({
      queue: ticketQueue,
      tickets, project: projectName,
      worktreeOf: (slug) => registry.get(slug)?.git,
      testCommand: testCommandAt('ticket'),
      runTests: testRunnerAt('ticket'),
      testsDisabled,
      testTimeoutMs: () => runtime.git.testTimeoutMinutes * 60_000,
      queuePosition: (slug) => shared.testQueue.position(slug),
      secretPatterns,
      notifyMain: (_slug, text) => { inbox.push(projectName, text); },
      changed: () => shared.broadcastAll(),
      stepClosed: (slug, o) => k.get('loop').onStepDone(slug, o),
      // The request service is created just below; these are only called when a tool runs.
      debts: (slug) => k.get('requests').debts(slug),
      requestIds: (slug) => k.get('requests').idsFrom(slug),
    });
  });
  // Requests between agents (SPEC 10). Persisted per project: a restart keeps ids, deadlines and the waiting steps.
  c.provide('requests', (k) => {
    const { o, config, shared } = k.get('env');
    const requestStore = k.get('requestStore');
    const projectName = k.get('projectName');
    const registry = k.get('registry');
    const tickets = k.get('tickets');
    const inbox = k.get('inbox');
    return new RequestService({
      store: requestStore, mainSlug: projectName,
      agent: (slug) => { const a = registry.get(slug); return a ? { role: a.role, state: a.state } : undefined; },
      ticketStatus: (slug) => tickets.get(slug)?.status,
      push: (slug, text) => inbox.push(slug, text),
      markWaiting: (slug, n, w) => k.get('steps').markWaiting(slug, n, w),
      clearWaiting: (slug, id) => k.get('steps').clearWaiting(slug, id),
      timeoutMs: () => config.agents.requestTimeoutMinutes * 60_000,
      maxHops: () => config.agents.requestMaxHops,
      now: o.requestNow ?? Date.now,
      changed: () => shared.broadcastAll(),
    });
  });
}
