import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Inbox } from './agents/inbox';
import type { AgentRegistry, Role } from './agents/registry';
import type { ModEvent } from '../shared/activity';
import { extractToken, type SessionTokens } from './security';
import { fail, readBodyOr400, readObjectBody, send } from './http-util';
import type { QuestionQueue } from './questions/queue';

export type ToolHandler = (slug: string, body: unknown) => Promise<unknown>;
export type GuardAnswer = { decision: 'allow' } | { decision: 'deny'; reason: string; rule: string };

export interface V1Context {
  tokens: SessionTokens;
  inbox: Inbox;
  registry: AgentRegistry;
  questions: QuestionQueue;
  /** Everything that must react to a mod event (registry, reading store, scheduler...). */
  handleModEvent(slug: string, e: ModEvent): void;
  tools: Record<string, ToolHandler>;
  /** A console tool finished: whatever it changed (tickets, queue) is worth pushing to the UI. */
  afterTool?(name: string): void;
  /** The guard's verdict for a tool call of this session (SPEC 14): rules, mode (enforce/shadow) and log live behind it. */
  guard(slug: string, tool: string, input: Record<string, unknown>): GuardAnswer;
  /** A sign of life of the session that is not an event (a guard question, a console tool call): it ends a silence. */
  activity?(slug: string): void;
}

const EVENT_TYPES: ModEvent['type'][] = ['session.start', 'session.end', 'turn.start', 'turn.complete', 'quota'];

/** Which role may call which console tool (SPEC 13.4). An agent's native AskUserQuestion reaches ask_user through the mod. */
const TOOL_ROLES: Record<string, Role[]> = {
  spawn_agent: ['main'],
  list_agents: ['main', 'agent', 'reviewer', 'recovery'],
  ask_user: ['main', 'agent', 'reviewer', 'recovery'],
  // The ticket flow belongs to agents: the console commits, validates and pushes on their behalf (SPEC 8.4).
  checklist_set: ['agent'],
  step_done: ['agent'],
  report_blocked: ['agent'],
  // Requests between agents (SPEC 10): the console routes, checks the rules and keeps the clock.
  send_message: ['main', 'agent'],
  // The review and merge flow (SPEC 15): the main asks, the reviewer answers once, the console does the rest.
  ticket_report: ['main'],
  request_review: ['main'],
  send_back_ticket: ['main'],
  merge_ticket: ['main'],
  propose_release: ['main'],
  review_verdict: ['reviewer'],
  // Recovery after a stop (SPEC 16.5): the main asks, the recovery reports once, the console restarts the ticket.
  start_recovery: ['main'],
  recovery_report: ['recovery'],
  // After a usage limit only the main decides what to resume (SPEC 18.4); the console staggers it and checks the quota.
  resume_agent: ['main'],
  archive_agent: ['main'],
  // Phase 6A (SPEC 9.9): the console saves, pushes and removes a stale worktree on the main's request.
  worktree_cleanup: ['main'],
  // SPEC 15.5: the mod posts the user's answer to the main's release dialog. No session has it as a tool, and it needs the release key.
  release_answer: ['main'],
};

/** Console tools that only the mod itself may call: the body carries the release key the console handed it at session start. */
const RELEASE_KEY_TOOLS = ['release_answer'];

/**
 * The channel mod -> console. Authenticated by the per-session token only: the UI token does not work here, and the
 * caller can only ever act as the session its token was issued to (the body never names the actor).
 */
export async function handleV1(ctx: V1Context, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const token = extractToken(req.headers, url);
  const slug = token ? ctx.tokens.slugFor(token) : undefined;
  if (!slug) return fail(res, 401, 'unauthorized');
  const path = url.pathname;

  // The release key (SPEC 15.5): only the main, only once, only before its token did anything but session.start.
  if (req.method === 'POST' && path === '/v1/release_key') {
    if (ctx.registry.get(slug)?.role !== 'main') { ctx.tokens.touch(token!); return fail(res, 403, 'forbidden'); }
    const key = ctx.tokens.issueReleaseKey(token!);
    return key ? send(res, 200, { key }) : fail(res, 409, 'already_issued');
  }

  if (req.method === 'POST' && path === '/v1/events') {
    // turn.complete carries the whole final answer: allow well above the 200 KiB the reading store keeps (JSON escaping adds more).
    const body = await readBodyOr400(req, res, 2 * 1024 * 1024);
    if (body === undefined) return;
    const b = (typeof body === 'object' && body !== null ? body : {}) as { type?: unknown; sessionId?: unknown; data?: unknown };
    if (b.type !== 'session.start') ctx.tokens.touch(token!);
    if (!EVENT_TYPES.includes(b.type as ModEvent['type']) || typeof b.sessionId !== 'string') return fail(res, 400, 'bad_request');
    const data = typeof b.data === 'object' && b.data !== null ? (b.data as Record<string, unknown>) : undefined;
    ctx.handleModEvent(slug, { type: b.type as ModEvent['type'], sessionId: b.sessionId, data });
    res.writeHead(204);
    res.end();
    return;
  }

  ctx.tokens.touch(token!); // anything but session.start spends the chance to get a release key

  if (req.method === 'GET' && path === '/v1/inbox') return send(res, 200, { messages: ctx.inbox.pending(slug) });

  if (req.method === 'POST' && path === '/v1/guard') {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return;
    const b = (typeof body === 'object' && body !== null ? body : {}) as { tool?: unknown; input?: unknown };
    if (typeof b.tool !== 'string' || typeof b.input !== 'object' || b.input === null || Array.isArray(b.input)) return fail(res, 400, 'bad_request');
    try { ctx.activity?.(slug); } catch { /* bookkeeping must not change the verdict */ }
    try {
      return send(res, 200, ctx.guard(slug, b.tool, b.input as Record<string, unknown>));
    } catch {
      return fail(res, 500, 'internal');
    }
  }

  if (req.method === 'POST' && path === '/v1/ack') {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return;
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !ctx.inbox.ack(slug, id)) return fail(res, 404, 'not_found');
    res.writeHead(204);
    res.end();
    return;
  }

  const question = /^\/v1\/questions\/([\w-]+)$/.exec(path);
  if (req.method === 'GET' && question) {
    // Short long-polls (at most 20 s each): the mod repeats them, so no single call hangs for long.
    const seconds = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), 20);
    return send(res, 200, await ctx.questions.wait(question[1]!, seconds * 1000, slug));
  }

  const tool = /^\/v1\/tools\/(\w+)$/.exec(path);
  if (req.method === 'POST' && tool) {
    const name = tool[1]!;
    const allowed = TOOL_ROLES[name];
    if (!allowed) return fail(res, 404, 'not_found');
    const role = ctx.registry.get(slug)?.role;
    if (!role || !allowed.includes(role)) return fail(res, 403, 'forbidden');
    const handler = ctx.tools[name];
    if (!handler) return fail(res, 404, 'not_found');
    const body = await readBodyOr400(req, res);
    if (body === undefined) return;
    // The user's answer to a release, read by the mod from the main's own dialog: it needs the release key, which the model never sees.
    if (RELEASE_KEY_TOOLS.includes(name) && !ctx.tokens.checkReleaseKey(token!, (body as { key?: unknown } | null)?.key)) return fail(res, 403, 'forbidden');
    try { ctx.activity?.(slug); } catch { /* bookkeeping must not change the answer */ }
    try {
      const result = await handler(slug, body);
      ctx.afterTool?.(name);
      return send(res, 200, result);
    } catch {
      return fail(res, 500, 'internal');
    }
  }

  return fail(res, 404, 'not_found');
}
