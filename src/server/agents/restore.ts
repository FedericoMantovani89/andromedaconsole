import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resourcePath } from '../paths';
import type { AgentRecord } from '../project-store';
import type { AgentRegistry, Role } from './registry';
import type { TicketStore, Ticket } from '../tickets/store';
import { canMove, type TicketStatus } from '../tickets/flow';
import { SESSION_ID_RE } from '../claude-code/launch';

export type InterruptedReason = 'no_worktree' | 'no_session' | 'turn_lost';
export interface RestoredAgent { slug: string; ticket?: TicketStatus }
export interface RestoreResult {
  /** Registered dormant: no process, wakes on demand. */
  dormant: RestoredAgent[];
  /** Registered interrupted: cannot or must not simply go on (see `reason`). */
  interrupted: (RestoredAgent & { reason: InterruptedReason })[];
  /** Stopped for the budget, a loop or the usage limit: they restart through their own flows. */
  stopped: RestoredAgent[];
  /** Tickets whose reviewer or recovery session did not survive the restart: given back as for a dead session. */
  repaired: string[];
}

export interface RestoreDeps {
  records: AgentRecord[];
  registry: AgentRegistry;
  tickets: TicketStore;
  /** `git.worktrees`: with it on, the record's worktree must exist on disk. */
  worktrees: boolean;
  /** The previous run ended through `close()` (`state/run.json`). */
  cleanStop: boolean;
  worktreeExists(path: string): boolean;
  /** `ReviewService.abandonReview`: a ticket in review whose reviewer is gone is delivered again. */
  abandonReview(reviewer: string): boolean;
}

const STOPPED: readonly TicketStatus[] = ['suspended_budget', 'suspended_limit', 'blocked'];

const roleOf = (r: AgentRecord): Role => r.role ?? (r.profile === 'reviewer' ? 'reviewer' : r.profile === 'recovery' ? 'recovery' : r.profile === 'auditor' ? 'auditor' : 'agent');

/**
 * Brings the agents of an earlier run back into the registry without starting a process (SPEC 19). Pure bookkeeping: the caller
 * tells the main what it returns. Reviewers and recoveries are never restored; their tickets are repaired.
 */
export function restoreAgents(d: RestoreDeps): RestoreResult {
  const out: RestoreResult = { dormant: [], interrupted: [], stopped: [], repaired: [] };
  const ticketOf = (slug: string): Ticket | undefined => { try { return d.tickets.get(slug); } catch { return undefined; } };

  // A reviewer or a recovery that was running is gone: its ticket must not wait for it for ever.
  for (const t of d.tickets.list()) {
    try {
      if (t.status === 'in_review' && t.reviewer !== undefined && t.reviewer !== 'main' && d.abandonReview(t.reviewer)) out.repaired.push(t.slug);
      else if (t.status === 'recovering') {
        // Back to the status it was stopped in (the recovery's own memory of it did not survive).
        const to: TicketStatus = t.stopCause === 'loop' ? 'blocked' : 'suspended_budget';
        if (canMove('recovering', to)) { d.tickets.move(t.slug, to); out.repaired.push(t.slug); }
      }
    } catch { /* the ticket stays as it is; the agent is still restored below */ }
  }

  for (const r of d.records) {
    if (roleOf(r) !== 'agent') continue;
    const ticket = ticketOf(r.slug);
    if (ticket?.status === 'merged' || ticket?.status === 'released') continue; // history: the name stays reserved, nothing to restore
    if (!ticket && r.sessionId === undefined && !r.worktree) continue; // no ticket, no session, no worktree (an old record): nothing to resume
    const git = r.worktree && r.branch ? { worktree: r.worktree, branch: r.branch, ...(r.repo ? { repo: r.repo } : {}) } : undefined;
    const base = {
      slug: r.slug, role: 'agent' as const, profile: r.profile,
      ...(ticket?.goal ? { goal: ticket.goal } : {}),
      ...(r.sessionId !== undefined && SESSION_ID_RE.test(r.sessionId) ? { sessionId: r.sessionId } : {}),
      ...(git ? { git } : {}),
      ...(r.cwd !== undefined ? { cwd: r.cwd } : {}),
    };
    const entry: RestoredAgent = { slug: r.slug, ...(ticket ? { ticket: ticket.status } : {}) };
    if (ticket && STOPPED.includes(ticket.status)) {
      d.registry.registerRestored({ ...base, state: 'finished' });
      out.stopped.push(entry);
      continue;
    }
    let reason: InterruptedReason | undefined;
    if (d.worktrees && !(git && d.worktreeExists(git.worktree))) reason = 'no_worktree';
    else if (!base.sessionId) reason = 'no_session';
    else if (!d.cleanStop && (r.lastState === 'working' || r.lastState === 'starting')) reason = 'turn_lost';
    if (reason) {
      d.registry.registerRestored({ ...base, state: 'interrupted' });
      out.interrupted.push({ ...entry, reason });
    } else {
      d.registry.registerDormant({ ...base, ...(r.archived ? { archived: true, ...(r.archivedAt !== undefined ? { archivedAt: r.archivedAt } : {}) } : {}) });
      out.dormant.push(entry);
    }
  }
  return out;
}

const REASON_TEXT: Record<InterruptedReason, string> = {
  no_worktree: 'its worktree is gone, so it cannot be resumed (it needs a recovery or the user)',
  no_session: 'it never reported a session, so it cannot be resumed (it needs a recovery or the user)',
  turn_lost: 'the turn in progress was lost; commits already made are intact; decide whether to wake it with resume_agent or to start a recovery',
};

const list = (items: string[]): string => (items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : '- none');
const label = (a: RestoredAgent): string => `${a.slug}${a.ticket ? ` (ticket: ${a.ticket})` : ''}`;

/** The one message the main gets after a restart (`prompts/restart-notice.md` filled with the lists); undefined when nothing needs saying. */
export function renderRestartNotice(r: RestoreResult, o: { promptsDir?: string } = {}): string | undefined {
  if (r.dormant.length + r.interrupted.length + r.stopped.length + r.repaired.length === 0) return undefined;
  const dir = o.promptsDir ?? resourcePath('prompts');
  const template = readFileSync(join(dir, 'restart-notice.md'), 'utf8').trim();
  const values: Record<string, string> = {
    dormant: list(r.dormant.map(label)),
    interrupted: list(r.interrupted.map((a) => `${label(a)}: ${REASON_TEXT[a.reason]}`)),
    stopped: list(r.stopped.map(label)),
    repaired: list(r.repaired),
  };
  return Object.entries(values).reduce((text, [key, v]) => text.split(`{${key}}`).join(v), template);
}
