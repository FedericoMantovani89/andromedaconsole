import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchResume } from '../agents/spawn';
import { AgentPersister } from '../agents/persist';
import { ResumeService, type WakeResult } from '../agents/resume';
import { WakeService } from '../agents/wake';
import { SESSION_ID_RE } from '../claude-code/launch';
import { BudgetService } from '../budget/service';
import { LoopDetector } from '../budget/loop-detector';
import { LoopService } from '../budget/loop-service';
import { QuotaService } from '../budget/quota';
import { Restrictions } from '../budget/restrictions';
import { defaultProjectsDir, pickTranscript, TranscriptReader } from '../claude-code/transcript';
import { CONSOLE_FROM } from '../questions/queue';
import { wipCommitFor } from './helpers';
import type { ProjectContainer } from './services';

/** The one message the main gets when a usage limit resets (SPEC 18.4). */
export const WAKE_MESSAGE = 'The subscription limit was reset. Check the suspended tickets with list_agents and resume them with mcp__andromeda-mcp__resume_agent.';
/** How long a wake-up probe waits for the next quota reading before it counts as still limited. */
const WAKE_WAIT_MS = 60_000;

/** The budget services: token budgets, loops, the usage-limit steps, and waking or resuming the agents after a limit. */
export function registerBudget(c: ProjectContainer): void {
  c.provide('reader', () => new TranscriptReader());
  c.provide('restrictions', () => new Restrictions());
  c.provide('turns', () => new Map<string, number>()); // turns started per session: the ledger's `turn`
  // Token budgets (SPEC 16): usage from the Claude Code transcript, recorded in the monthly ledger, steps on the ticket.
  c.provide('budget', (k) => {
    const { o, config, ledger, shared } = k.get('env');
    const projectsDir = o.projectsDir ?? defaultProjectsDir();
    const ticketQueue = k.get('ticketQueue');
    const tickets = k.get('tickets');
    const reader = k.get('reader');
    const projectName = k.get('projectName');
    const registry = k.get('registry');
    const inbox = k.get('inbox');
    const restrictions = k.get('restrictions');
    const keepHandover = k.get('keepHandover');
    const questions = k.get('questions');
    const budget: BudgetService = new BudgetService({
      queue: ticketQueue,
      tickets, ledger, reader, project: projectName, root: resolve(o.projectRoot),
      // The loaded object, read on every call. The Options dialog edits `budget` in place (applyConfig below), so a change is seen here
      // at once and applies to the sessions launched afterwards (a running agent keeps the limit it began with).
      config: () => config.budget,
      now: () => Date.now(),
      transcriptOf: (slug) => {
        const a = registry.get(slug);
        // Claude Code files the transcript under the session's folder: the worktree (where it was started), then the folder it reported.
        return a?.sessionId ? pickTranscript(projectsDir, [a.git?.worktree, a.cwd], a.sessionId) : undefined;
      },
      isLive: (slug) => registry.get(slug)?.role === 'agent',
      wipCommit: wipCommitFor(k),
      tellAgent: (slug, text) => { inbox.push(slug, text); },
      tellMain: (text) => { inbox.push(projectName, text); },
      restrict: (slug, why) => { restrictions.set(slug, { reason: why }); },
      stop: (slug) => { keepHandover(slug); return k.get('finishAgent')(slug, { stopped: true }); },
      // The answer handler lives in budget/answers.ts; the service only asks.
      askUser: (q) => {
        questions.ask({ from: CONSOLE_FROM, text: q.text, kind: 'decision', options: q.options, payload: q.payload }, (answer) => { void k.get('onBudgetAnswer')(answer, q.payload as { ticket: string }).catch((err) => budget.reportFailure('the budget answer', err)); });
      },
      changed: () => shared.broadcastAll(),
    });
    return budget;
  });
  // Loops and blocks (SPEC 17): found in the transcript events, handled in three steps; time signals only warn the main.
  c.provide('loop', (k) => {
    const { config, shared } = k.get('env');
    const ticketQueue = k.get('ticketQueue');
    const tickets = k.get('tickets');
    const inbox = k.get('inbox');
    const projectName = k.get('projectName');
    const restrictions = k.get('restrictions');
    const registry = k.get('registry');
    const keepHandover = k.get('keepHandover');
    const ptys = k.get('ptys');
    return new LoopService({
      queue: ticketQueue,
      detector: new LoopDetector(() => config.budget.loop, () => Date.now()),
      tickets,
      tellAgent: (slug, text) => { inbox.push(slug, text); },
      tellMain: (text) => { inbox.push(projectName, text); },
      restrict: (slug, r) => { restrictions.set(slug, r); },
      // Only a loop restriction goes when a step closes: one held for the budget or the usage limit stays.
      clearRestriction: (slug) => { if (restrictions.get(slug)?.reason === 'loop') restrictions.clear(slug); },
      wipCommit: (slug, reason) => wipCommitFor(k)(slug, reason).then((r) => (r.ok ? { ok: true as const } : r)),
      stop: (slug) => { keepHandover(slug); return k.get('finishAgent')(slug, { stopped: true }); },
      workingSlugs: () => registry.list().filter((a) => a.role === 'agent' && a.state === 'working').map((a) => a.slug),
      isWorking: (slug) => { const a = registry.get(slug); return a !== undefined && a.role !== 'main' && a.state === 'working'; },
      processAlive: (slug) => ptys.status(slug) === 'running',
      changed: () => shared.broadcastAll(),
    });
  });
  // The probe of a wake-up waits for the next quota reading (the main's next turn reports it), at most WAKE_WAIT_MS.
  c.provide('quotaWaiters', () => new Set<() => void>());
  c.provide('wakeTimers', () => new Set<unknown>());
  /**
   * The one check at the reset (SPEC 18.4): only the main wakes, with one message, never one per agent. A main whose process is gone
   * is started again with `--resume` of its last session. The result is "running" only if the next quota reading, within a minute,
   * is below the freeze threshold (the one resume_agent uses); anything else (no reading, still high) is "limited" and the sleep
   * timer backs off.
   * Not async on purpose: the wait timer is set synchronously, inside the sleep timer's own call.
   */
  c.provide('wakeMain', (k) => {
    const { config, quotaState, sleepClock, shared } = k.get('env');
    const ptys = k.get('ptys');
    const projectName = k.get('projectName');
    const registry = k.get('registry');
    const inbox = k.get('inbox');
    const quotaWaiters = k.get('quotaWaiters');
    const wakeTimers = k.get('wakeTimers');
    return (): Promise<WakeResult> => {
      let note = '';
      if (ptys.status(projectName) !== 'running') {
        const sid = registry.get(projectName)?.sessionId;
        const resumeId = sid !== undefined && SESSION_ID_RE.test(sid) ? sid : undefined;
        k.get('launchMain')(resumeId);
        if (!resumeId) note = ' Your earlier session had ended and could not be resumed (its id was unknown), so this is a new session: look at the project with list_agents before deciding anything.';
      }
      const result = new Promise<WakeResult>((done) => {
        let settled = false;
        let timer: unknown;
        const finish = (r: WakeResult): void => {
          if (settled) return;
          settled = true;
          quotaWaiters.delete(onQuota);
          sleepClock.clearTimeout(timer);
          wakeTimers.delete(timer);
          done(r);
        };
        const onQuota = (): void => {
          const worst = quotaState.worst();
          finish(worst !== undefined && worst.percent < config.budget.quota.freezePercent ? 'running' : 'limited');
        };
        quotaWaiters.add(onQuota);
        timer = sleepClock.setTimeout(() => finish('limited'), WAKE_WAIT_MS);
        wakeTimers.add(timer);
      });
      inbox.push(projectName, `${WAKE_MESSAGE}${note}`);
      shared.broadcastAll();
      return result;
    };
  });
  // The sleep timer is console-wide (see `shared`); it calls this project's `wakeMain` and `weeklyNotice` through the runtime.
  c.provide('weeklyNotice', (k) => {
    const inbox = k.get('inbox');
    const projectName = k.get('projectName');
    const questions = k.get('questions');
    return (resetsAt: string | undefined): void => {
      inbox.push(projectName, `The weekly usage limit is almost used up or reached${resetsAt ? ` (it resets at ${resetsAt})` : ''}: the agents were paused and nothing restarts by itself. The user was asked in the queue; the choices are to wait until the reset, to go on with fewer agents or a cheaper model (set in the configuration), or to stop the projects.`);
      // SPEC 18.5: the USER gets the choice (the main may not be able to run at all): one item to acknowledge, its text lists the choices.
      questions.ask({ from: CONSOLE_FROM, text: 'The weekly usage limit is almost used up or reached: nothing restarts by itself.', kind: 'decision', options: ['ok'], payload: { kind: 'weekly_limit', ...(resetsAt ? { resetsAt } : {}) } });
    };
  });
  c.provide('ticketStatusOf', (k) => {
    const tickets = k.get('tickets');
    return (slug: string) => { try { return tickets.get(slug)?.status; } catch { return undefined; } };
  });
  // Usage limits of the subscription (SPEC 18): the mod reports them, the service decides the step.
  // The quota state, the sleep timer and its clock are console-wide (the limits belong to the account): see `shared`.
  c.provide('quota', (k) => {
    const { config, quotaState, sleep, shared } = k.get('env');
    const inbox = k.get('inbox');
    const projectName = k.get('projectName');
    const registry = k.get('registry');
    const ticketStatusOf = k.get('ticketStatusOf');
    const restrictions = k.get('restrictions');
    const tickets = k.get('tickets');
    const quotaStepRef = k.get('quotaStepRef'); // read by the scheduler on every decision
    return new QuotaService({
      state: quotaState, config: () => config.budget.quota,
      tellMain: (text) => { inbox.push(projectName, text); },
      tellAgent: (slug, text) => { inbox.push(slug, text); },
      // Priority = creation order of the registry (a Map keeps registration order): the oldest session has the highest number and is stopped last.
      agents: () => {
        const live = registry.list().filter((a) => a.state !== 'finished' && a.state !== 'interrupted' && a.state !== 'queued' && a.state !== 'dormant');
        return live.map((a, i) => ({ slug: a.slug, role: a.role, priority: live.length - i }));
      },
      wipCommit: wipCommitFor(k, { onlyInProgress: true }),
      restrict: (slug, r) => { restrictions.set(slug, r); },
      clearRestriction: (slug) => { if (restrictions.get(slug)?.reason === 'limit') restrictions.clear(slug); },
      suspendForLimit: async (slug) => {
        // Only a ticket being written is suspended. A reviewer or a recovery is ended and its ticket given back (delivered, or the
        // status it was stopped in): it is ended on purpose, so its exit alone would not give it back.
        const role = registry.get(slug)?.role;
        if (role === 'agent' && ticketStatusOf(slug) === 'in_progress') tickets.move(slug, 'suspended_limit');
        // An agent is resumed later and keeps its requests; a reviewer or a recovery ends for good.
        await k.get('finishAgent')(slug, { stopped: role === 'agent' });
        if (role === 'reviewer') k.get('review').abandonReview(slug);
        else if (role === 'recovery') k.get('recovery').abandon(slug);
      },
      // A step back to 'none' must start the queue by itself: the scheduler only looks again when told.
      applyLimits: (s) => { quotaStepRef.value = s; k.get('scheduler').release(); shared.broadcastAll(); },
      onLimitReached: (resetsAt, kind) => sleep.sleepUntil(resetsAt, kind),
      changed: () => shared.broadcastAll(),
    });
  });
  // Resumed agents whose session has not reported in yet: one whose process ends first is suspended again (it never ran).
  c.provide('resumedAwaitingStart', () => new Set<string>());
  // Resuming suspended agents after a limit (SPEC 18.4): the main asks with resume_agent, the console staggers and checks the quota.
  c.provide('resumer', (k) => {
    const { config, quotaState, sleepClock, runtime, shared } = k.get('env');
    const tickets = k.get('tickets');
    const registry = k.get('registry');
    const resumedAwaitingStart = k.get('resumedAwaitingStart');
    const inbox = k.get('inbox');
    const projectName = k.get('projectName');
    return new ResumeService({
      tickets, registry,
      config: () => config.budget.quota,
      quotaWorst: () => quotaState.worst(),
      clock: sleepClock,
      launch: (slug, sessionId) => { resumedAwaitingStart.add(slug); return launchResume(k.get('ctx'), slug, sessionId); },
      suspendedTickets: () => tickets.list().filter((t) => t.status === 'suspended_limit').map((t) => t.slug),
      // With worktrees off the agents share the project folder: there is always somewhere to resume in.
      hasWorktree: (slug) => { if (!runtime.git.worktrees) return true; const w = registry.get(slug)?.git?.worktree; return w !== undefined && existsSync(w); },
      // Phase 6A: the main also wakes dormant and interrupted agents with resume_agent.
      wakeable: (slug) => { const s = registry.get(slug); return s?.role === 'agent' && (s.state === 'dormant' || s.state === 'interrupted'); },
      wake: async (slug, sessionId) => { const r = await launchResume(k.get('ctx'), slug, sessionId, 'main'); return r; },
      tellMain: (text) => { inbox.push(projectName, text); },
      changed: () => shared.broadcastAll(),
    });
  });
  // Waking a dormant agent (Phase 6A): the user opens it, work arrives for it, or the main asks (resume_agent, above).
  c.provide('waker', (k) => {
    const { config, quotaState, runtime, shared } = k.get('env');
    const registry = k.get('registry');
    return new WakeService({
      registry,
      launch: (slug, sessionId, reason) => launchResume(k.get('ctx'), slug, sessionId, reason),
      hasWorktree: (slug) => { if (!runtime.git.worktrees) return true; const w = registry.get(slug)?.git?.worktree; return w !== undefined && existsSync(w); },
      quotaHigh: () => { const w = quotaState.worst(); return w !== undefined && w.percent >= config.budget.quota.freezePercent; },
      changed: () => shared.broadcastAll(),
    });
  });
  // Messages and state kept for the next start (Phase 6A).
  c.provide('persister', (k) => {
    const registry = k.get('registry');
    const store = k.get('store');
    const projectName = k.get('projectName');
    return new AgentPersister({ registry, updateAgent: (slug, patch) => store.updateAgent(slug, patch), writeMainSession: (id) => store.writeMainSession(id), mainSlug: projectName });
  });
  /** One quota reading: a wake-up probe waiting for it judges it once the steps have been applied. */
  c.provide('onQuotaReading', (k) => {
    const { config, quotaState, sleep } = k.get('env');
    const quota = k.get('quota');
    const quotaWaiters = k.get('quotaWaiters');
    return (rateLimits: unknown): void => {
      void quota.onQuota(rateLimits).then(() => {
        for (const w of [...quotaWaiters]) w();
        // A low reading ends a sleep even when no probe is waiting (a probe that timed out, a main that reported by itself).
        const worst = quotaState.worst();
        if (worst !== undefined && worst.percent < config.budget.quota.freezePercent) sleep.lifted();
      });
    };
  });
}
