import { resolve } from 'node:path';
import { archiveAgent } from '../../agents/archive';
import { spawnAgent } from '../../agents/spawn';
import { cleanupWorktree } from '../../git/cleanup';
import type { Context } from '../../http';
import { badRequest } from '../../tool-errors';
import type { ProjectContainer } from '../services';

/** The goal length list_agents gives by default to the main. */
const SHORT_GOAL = 80;

/** The console tools that list, resume, archive, clean up and spawn agents. */
export function agentTools(k: ProjectContainer): Pick<Context['tools'], 'list_agents' | 'resume_agent' | 'archive_agent' | 'worktree_cleanup' | 'spawn_agent'> {
  const { o } = k.get('env');
  const projectName = k.get('projectName');
  const registry = k.get('registry');
  const requests = k.get('requests');
  const release = k.get('release');
  const scheduler = k.get('scheduler');
  const ticketStatusOf = k.get('ticketStatusOf');
  const resumer = k.get('resumer');
  const secretPatterns = k.get('secretPatterns');
  const ptys = k.get('ptys');
  const store = k.get('store');
  const broadcast = k.get('broadcast');
  const tickets = k.get('tickets');
  const afterOf = (slug: string): { after?: string; afterReason?: string } => {
    try {
      const t = tickets.get(slug);
      return t?.after ? { after: t.after, ...(t.afterReason ? { afterReason: t.afterReason } : {}) } : {};
    } catch { return {}; }
  };
  return {
    list_agents: async (caller, body) => {
      const b = (typeof body === 'object' && body !== null ? body : {}) as { filter?: unknown; goal?: unknown };
      if (b.filter !== undefined && b.filter !== 'active' && b.filter !== 'all') return badRequest('filter must be "active" or "all"');
      if (b.goal !== undefined && b.goal !== 'short' && b.goal !== 'full') return badRequest('goal must be "short" or "full"');
      const isMain = caller === projectName;
      // The main asks again and again (every message may need a look): by default it gets what is in hand, in short. The others see everyone, in full.
      const active = (b.filter ?? (isMain ? 'active' : 'all')) === 'active';
      const goalMax = (b.goal ?? (isMain ? 'short' : 'full')) === 'short' ? SHORT_GOAL : 300;
      // The main also sees what only it can settle (escalated requests, questions to it): a restart or a lost message forgets nothing.
      const held = isMain ? requests.forMain() : [];
      // An open release request waits for the user in the queue: the main sees it, so it does not ask again or forget it.
      const pendingRelease = isMain ? release.pendingRequest() : undefined;
      const all = registry.list();
      const shown = active ? all.filter((a) => !a.archived) : all;
      const hidden = all.length - shown.length;
      return {
        // Said when the filter left something out, so the main knows the list is not everything (filter: "all" shows it).
        ...(hidden > 0 ? { archivedHidden: hidden } : {}),
        agents: shown.map((a) => ({
          slug: a.slug, profile: a.profile, role: a.role, state: a.state,
          ...(a.goal ? { goal: a.goal.length > goalMax ? `${a.goal.slice(0, goalMax)}…` : a.goal } : {}),
          ...(a.state === 'queued' ? { queuedPosition: scheduler.position(a.slug) } : {}),
          // Where the ticket is when it is not simply being written (suspended, delivered...): the main decides what to resume from it.
          ...(() => { const t = a.role === 'agent' ? ticketStatusOf(a.slug) : undefined; return t && t !== 'in_progress' ? { ticket: t } : {}; })(),
          // The agent it was started after: the main knows this ticket waits for that one to be merged.
          ...(a.role === 'agent' ? afterOf(a.slug) : {}),
          // Out of the agents column (it ended for good, or the user archived it): the main does not count it as work in hand.
          ...(a.archived ? { archived: true } : {}),
          // Open requests with this session on either side: who is waiting for whom, so a stuck one is seen and chased.
          ...(() => { const r = requests.liveFor(a.slug); return r ? { requests: r } : {}; })(),
        })),
        ...(held.length > 0 ? { requests: held } : {}),
        ...(pendingRelease ? { release: { id: pendingRelease.id, status: 'pending' as const } } : {}),
      };
    },
    resume_agent: async (_slug, body) => {
      const names = (body as { names?: unknown } | null)?.names;
      if (!Array.isArray(names) || names.length === 0 || names.length > 50 || !names.every((n): n is string => typeof n === 'string' && n !== '')) {
        return badRequest('names must be a list of 1 to 50 agent names');
      }
      return resumer.resume(names);
    },
    // The main takes agents that are done out of the column and out of its own list (the same flag as the panel's button; nothing is closed or deleted).
    archive_agent: async (_slug, body) => {
      const names = (body as { names?: unknown } | null)?.names;
      if (!Array.isArray(names) || names.length === 0 || names.length > 50 || !names.every((n): n is string => typeof n === 'string' && n !== '')) {
        return badRequest('names must be a list of 1 to 50 agent names');
      }
      const results = names.map((name) => {
        const out = archiveAgent({ registry, ticketStatus: ticketStatusOf }, name);
        return out.ok ? { name, status: 'archived' as const } : { name, status: 'refused' as const, code: out.code };
      });
      return { status: 'ok', results };
    },
    // Phase 6A, SPEC 9.9: the console saves the work, pushes the branch and only then removes the folder; never a branch.
    worktree_cleanup: async (_slug, body) => {
      const b = (typeof body === 'object' && body !== null ? body : {}) as { name?: unknown; action?: unknown };
      if (typeof b.name !== 'string' || b.name === '') return badRequest('name is required');
      if (b.action !== 'remove') return badRequest('action must be "remove"');
      return cleanupWorktree({
        repo: registry.get(b.name)?.git?.repo ?? resolve(o.projectRoot), project: projectName, secretPatterns: secretPatterns(),
        agentGit: (s) => (registry.get(s)?.role === 'agent' ? registry.get(s)?.git : undefined),
        // A running agent, one waiting for a slot, or one under review (its branch must not move) is never touched.
        isActive: (s) => ptys.status(s) === 'running' || registry.get(s)?.state === 'queued' || ticketStatusOf(s) === 'in_review',
        removed: (s) => { registry.setGit(s, undefined); store.updateAgent(s, { worktree: undefined, stale: undefined }); broadcast(); },
      }, b.name);
    },
    spawn_agent: async (_slug, body) => {
      const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
      if (typeof b.name !== 'string') return badRequest('name is required');
      if (typeof b.profile !== 'string') return badRequest('profile is required');
      if (typeof b.goal !== 'string' || b.goal.trim() === '') return badRequest('goal is required');
      // An optional token budget for this ticket: an integer between 1000 and 100 000 000, anything else is refused.
      if (b.budget !== undefined && !(typeof b.budget === 'number' && Number.isInteger(b.budget) && b.budget >= 1000 && b.budget <= 100_000_000)) {
        return badRequest('budget must be a whole number between 1000 and 100000000');
      }
      // An optional other agent this one starts after (its branch, and its ticket merged before this one is reviewed or merged).
      if (b.after !== undefined && (typeof b.after !== 'string' || b.after === '')) return badRequest('after must be the name of another agent');
      // `after` is a last resort: the main says why no other way works, and the user sees it (report, list_agents).
      const afterReason = typeof b.after_reason === 'string' ? b.after_reason.trim() : undefined;
      if (b.after !== undefined && afterReason === undefined) return { status: 'error', code: 'after_reason_required' };
      if (b.after !== undefined && (afterReason!.length < 20 || afterReason!.length > 500)) {
        return { status: 'error', code: 'after_reason_required', detail: 'after_reason must be 20 to 500 characters saying why no other way works' };
      }
      const out = await spawnAgent(k.get('ctx'), {
        slug: b.name, profile: b.profile, goal: b.goal, model: typeof b.model === 'string' ? b.model : undefined, source: 'main',
        ...(b.budget !== undefined ? { budget: b.budget as number } : {}), ...(typeof b.repo === 'string' ? { repo: b.repo } : {}), ...(typeof b.after === 'string' ? { after: b.after, afterReason } : {}),
      });
      if (!out.ok) return { status: 'error', code: out.code, ...(out.params ? { params: out.params } : {}) };
      return out.status === 'started' ? { status: 'started', name: out.slug } : { status: 'queued', name: out.slug, position: out.position };
    },
  };
}
