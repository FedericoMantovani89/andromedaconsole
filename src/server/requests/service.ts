import { randomBytes } from 'node:crypto';
import type { Activity } from '../../shared/activity';
import type { EscalationReason, RequestRow, RequestsInfo } from '../../shared/requests';
import type { Role } from '../agents/registry';
import type { TicketStatus } from '../tickets/flow';
import { badRequest } from '../tool-errors';
import type { RequestRecord, RequestStore } from './store';
import { answeredAfterAllText, answerText, cancelledText, escalatedText, infoText, passedOnText, questionText } from './texts';

export const MAX_TEXT = 8000;
const TYPES = ['question', 'answer', 'info', 'unknown', 'escalate'] as const;
type MessageType = (typeof TYPES)[number];
/** A ticket in these statuses has finished being written: its author takes no new questions (SPEC 10.1 rule 4). */
const WORK_CLOSED: readonly TicketStatus[] = ['delivered', 'in_review', 'approved', 'merged', 'released'];
/** A message that is never acknowledged goes to the main after this many timeouts. */
const UNDELIVERED_FACTOR = 2;
/** The settled requests the drawer keeps showing. */
const RECENT = 20;

export type SendRefusal =
  | 'not_peer' | 'self' | 'unknown_recipient' | 'too_many_hops' | 'cycle' | 'unknown_request' | 'already_closed' | 'not_addressee'
  | 'bad_step' | 'top_of_chain' | 'text_too_long';
export type SendResult =
  | { status: 'ok'; requestId?: string; escalated?: EscalationReason }
  | { status: 'refused'; code: SendRefusal; detail?: string }
  | { status: 'error'; code: 'bad_request'; detail: string };
export type WaitResult = { ok: true } | { ok: false; detail: string };

export interface RequestDeps {
  store: RequestStore;
  /** The main session's name (the project name). */
  mainSlug: string;
  /** Role and state of a session; undefined when there is none with that name. */
  agent(slug: string): { role: Role; state: Activity } | undefined;
  ticketStatus(slug: string): TicketStatus | undefined;
  /** `Inbox.push`: returns the message id. */
  push(slug: string, text: string): string;
  /** Marks a step of the sender's ticket as waiting (`StepService.markWaiting`). */
  markWaiting(slug: string, step: number, w: { requestId: string; to: string }): Promise<WaitResult>;
  /** Clears the waiting mark of the request in the sender's ticket; returns the step it was on (`StepService.clearWaiting`). */
  clearWaiting(slug: string, requestId: string): Promise<{ n: number; title: string } | undefined>;
  timeoutMs(): number;
  maxHops(): number;
  now(): number;
  /** Something visible changed: the state is pushed to the UI. */
  changed(): void;
}

const refuse = (code: SendRefusal, detail?: string): SendResult => ({ status: 'refused', code, ...(detail ? { detail } : {}) });

/**
 * The rules of the messages between sessions (SPEC 10): who may write to whom, the chain limit and cycles, the clock that sends an
 * unanswered question to the main, and the debts that keep an agent from delivering with a question open. The console routes every
 * message; the sender is always the session of the call, never a name written in the text.
 */
export class RequestService {
  constructor(private readonly d: RequestDeps) {}

  async send(from: string, body: unknown): Promise<SendResult> {
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const type = b.type as MessageType;
    if (!TYPES.includes(type)) return badRequest(`type must be one of ${TYPES.join(', ')}`);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (text.length > MAX_TEXT) return refuse('text_too_long', `at most ${MAX_TEXT} characters`);
    if (type === 'question' || type === 'info') {
      if (typeof b.to !== 'string' || b.to === '') return badRequest(`to is required for type "${type}"`);
      if (text === '') return badRequest('text is required');
      if (type === 'info') return this.info(from, b.to, text);
      if (b.step !== undefined && !(typeof b.step === 'number' && Number.isInteger(b.step) && b.step >= 1)) return badRequest('step must be a whole number of 1 or more');
      if (b.because !== undefined && typeof b.because !== 'string') return badRequest('because must be a request id');
      return this.question(from, b.to, text, b.step as number | undefined, b.because as string | undefined);
    }
    if (typeof b.in_reply_to !== 'string' || b.in_reply_to === '') return badRequest(`in_reply_to is required for type "${type}"`);
    if (type === 'answer') return text === '' ? badRequest('text is required') : this.answer(from, b.in_reply_to, text);
    if (type === 'escalate' && text === '') return badRequest('text is required');
    return this.passUp(from, b.in_reply_to, type === 'unknown' ? 'unknown' : 'explicit', text);
  }

  private peer(from: string, to: string): SendResult | undefined {
    if (to === from) return refuse('self', 'you cannot write to yourself');
    const target = this.d.agent(to);
    if (!target) return refuse('unknown_recipient', `there is no session named "${to}": list_agents shows who exists`);
    if (target.role !== 'main' && target.role !== 'agent') return refuse('not_peer', 'only the main and the agents of this project can be written to');
    return undefined;
  }

  /** The recipient cannot take a question: not running, interrupted, or its ticket is already delivered. */
  private gone(slug: string): boolean {
    const a = this.d.agent(slug);
    if (!a) return true;
    if (a.role === 'main') return false;
    if (a.state === 'finished' || a.state === 'interrupted') return true;
    const t = this.d.ticketStatus(slug);
    return t !== undefined && WORK_CLOSED.includes(t);
  }

  private newId(): string {
    for (;;) {
      const id = `TODO-${randomBytes(3).toString('hex')}`;
      if (!this.d.store.get(id)) return id;
    }
  }

  private async question(from: string, to: string, text: string, step: number | undefined, because: string | undefined): Promise<SendResult> {
    const bad = this.peer(from, to);
    if (bad) return bad;
    let hops = 0;
    if (because !== undefined) {
      const parent = this.d.store.get(because);
      const holder = parent?.state === 'escalated' ? this.d.mainSlug : parent?.to;
      if (!parent || (parent.state !== 'open' && parent.state !== 'escalated') || holder !== from) {
        return refuse('unknown_request', `"${because}" is not an open request you are handling`);
      }
      hops = parent.hops + 1;
      if (hops > this.d.maxHops()) return refuse('too_many_hops', `a chain of requests is limited to ${this.d.maxHops()} steps: ask the main`);
      for (let a: RequestRecord | undefined = parent; a; a = a.parent ? this.d.store.get(a.parent) : undefined) {
        if (a.from === to) return refuse('cycle', `"${to}" is already waiting for this chain of requests`);
      }
    }
    if (step !== undefined && this.d.agent(from)?.role !== 'agent') return refuse('bad_step', 'only an agent has a checklist');
    const id = this.newId();
    if (step !== undefined) {
      const w = await this.d.markWaiting(from, step, { requestId: id, to });
      if (!w.ok) return refuse('bad_step', w.detail);
    }
    const now = this.d.now();
    this.d.store.add({ id, from, to, text, state: 'open', hops, ...(because !== undefined ? { parent: because } : {}), createdAt: now });
    if (this.gone(to)) {
      this.escalate(id, 'recipient_gone');
      this.d.changed();
      return { status: 'ok', requestId: id, escalated: 'recipient_gone' };
    }
    const messageId = this.d.push(to, questionText({ id, from, text, toMain: to === this.d.mainSlug }));
    this.d.store.update(id, { messageId, ...(to === this.d.mainSlug ? {} : { deadline: now + UNDELIVERED_FACTOR * this.d.timeoutMs() }) });
    this.d.changed();
    return { status: 'ok', requestId: id };
  }

  private info(from: string, to: string, text: string): SendResult {
    const bad = this.peer(from, to);
    if (bad) return bad;
    if (this.gone(to)) return refuse('unknown_recipient', `"${to}" is not working any more`);
    this.d.push(to, infoText({ from, text }));
    return { status: 'ok' };
  }

  private async answer(from: string, id: string, text: string): Promise<SendResult> {
    const r = this.d.store.get(id);
    if (!r) return refuse('unknown_request');
    if (r.state !== 'open' && r.state !== 'escalated') return refuse('already_closed');
    // After an escalation the original recipient may still answer late: that settles it, and the main is told.
    if (from !== r.to && from !== this.d.mainSlug) return refuse('not_addressee');
    const late = r.state === 'escalated' && from === r.to && from !== this.d.mainSlug;
    // Settled before anything is awaited: a second answer arriving meanwhile finds it closed.
    this.d.store.update(id, { state: 'answered', deadline: undefined });
    let step: { n: number; title: string } | undefined;
    try { step = await this.d.clearWaiting(r.from, id); } catch { step = undefined; /* the answer matters more than the step mark */ }
    this.d.push(r.from, answerText({ id, from, text, ...(step ? { step } : {}) }));
    if (late) this.d.push(this.d.mainSlug, answeredAfterAllText({ id, to: r.to }));
    this.d.changed();
    return { status: 'ok' };
  }

  private passUp(from: string, id: string, reason: 'unknown' | 'explicit', note: string): SendResult {
    const r = this.d.store.get(id);
    if (!r) return refuse('unknown_request');
    if (r.state !== 'open') return refuse('already_closed', r.state === 'escalated' ? 'the main already has it' : undefined);
    if (from !== r.to) return refuse('not_addressee');
    if (r.to === this.d.mainSlug) return refuse('top_of_chain', 'the main is the top of the chain: verify the fact yourself or ask the user with AskUserQuestion');
    this.escalate(id, reason, note);
    this.d.changed();
    return { status: 'ok' };
  }

  private escalate(id: string, reason: EscalationReason, note = ''): void {
    const r = this.d.store.update(id, { state: 'escalated', escalatedBy: reason, deadline: undefined });
    if (!r) return;
    this.d.push(this.d.mainSlug, escalatedText({ id, from: r.from, to: r.to, text: r.text, reason, note }));
    if (r.from !== this.d.mainSlug) this.d.push(r.from, passedOnText({ id, to: r.to, reason }));
  }

  /** The mod acknowledged an inbox message: if it carries a question, the recipient has it now and the clock starts. */
  onDelivered(slug: string, messageId: string): void {
    const r = this.d.store.list().find((x) => x.messageId === messageId && x.to === slug);
    if (!r || r.state !== 'open' || r.deliveredAt !== undefined) return;
    const now = this.d.now();
    this.d.store.update(r.id, { deliveredAt: now, deadline: r.to === this.d.mainSlug ? undefined : now + this.d.timeoutMs() });
    this.d.changed();
  }

  /** At start: the time the console was off does not count, so every open request with a deadline gets a fresh one. */
  restartClocks(): void {
    const now = this.d.now();
    this.sweep((r) => {
      if (r.state !== 'open' || r.deadline === undefined) return false;
      this.d.store.update(r.id, { deadline: now + (r.deliveredAt !== undefined ? 1 : UNDELIVERED_FACTOR) * this.d.timeoutMs() });
      return true;
    });
  }

  /** Visits every request; `visit` answers whether it changed one, and the console is told once if any changed. */
  private sweep(visit: (r: RequestRecord) => boolean): void {
    let any = false;
    for (const r of this.d.store.list()) if (visit(r)) any = true;
    if (any) this.d.changed();
  }

  /** Sends the requests whose time is up to the main. Called from the console's timer. */
  tick(): void {
    const now = this.d.now();
    this.sweep((r) => {
      if (r.state !== 'open' || r.deadline === undefined || now < r.deadline) return false;
      this.escalate(r.id, 'timeout');
      return true;
    });
  }

  /**
   * A session ended for good (ticket merged, read-only session done): what was asked of it goes to the main; what it asked is
   * cancelled, its waiting steps are released, and whoever holds the request is told it need not answer.
   */
  agentGone(slug: string): void {
    this.sweep((r) => {
      if (r.state === 'open' && r.to === slug) { this.escalate(r.id, 'recipient_gone'); return true; }
      if ((r.state === 'open' || r.state === 'escalated') && r.from === slug) {
        const holder = r.state === 'escalated' ? this.d.mainSlug : r.to;
        this.d.store.update(r.id, { state: 'cancelled', deadline: undefined });
        void this.d.clearWaiting(slug, r.id).catch(() => undefined);
        if (this.running(holder)) this.d.push(holder, cancelledText({ id: r.id, from: slug }));
        return true;
      }
      return false;
    });
  }

  /**
   * A session was stopped but its work goes on (budget or loop stop, limit suspension, replacement): what was asked of it goes
   * to the main, what it asked stays as it is, with its waiting steps, so the answer still unlocks them after the resume.
   */
  agentStopped(slug: string): void {
    this.sweep((r) => {
      if (r.state !== 'open' || r.to !== slug) return false;
      this.escalate(r.id, 'recipient_gone');
      return true;
    });
  }

  /** A replacement took the ticket of `from` under the name `to`: the live requests follow it, both ways. */
  rename(from: string, to: string): void {
    let any = false;
    for (const r of this.d.store.list()) {
      if (r.state === 'answered' || r.state === 'cancelled') continue;
      if (r.from !== from && r.to !== from) continue;
      this.d.store.update(r.id, { ...(r.from === from ? { from: to } : {}), ...(r.to === from ? { to } : {}) });
      any = true;
    }
    if (any) this.d.changed();
  }

  /** The session exists and is running (the main always counts). */
  private running(slug: string): boolean {
    const a = this.d.agent(slug);
    return a !== undefined && (a.role === 'main' || (a.state !== 'finished' && a.state !== 'interrupted'));
  }

  /** What the main holds: the open requests addressed to it and every escalated one. */
  forMain(): { id: string; from: string; to: string; state: 'open' | 'escalated'; text: string }[] {
    return this.d.store.list()
      .filter((r) => r.state === 'escalated' || (r.state === 'open' && r.to === this.d.mainSlug))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({ id: r.id, from: r.from, to: r.to, state: r.state as 'open' | 'escalated', text: r.text.slice(0, 300) }));
  }

  get(id: string): RequestRecord | undefined { return this.d.store.get(id); }

  /** The open requests addressed to `slug`: what it still owes an answer to. */
  debts(slug: string): string[] {
    return this.d.store.list().filter((r) => r.state === 'open' && r.to === slug).map((r) => r.id);
  }

  /** Every request `slug` made, in any state: the comments of all of them must be gone before it delivers. */
  idsFrom(slug: string): string[] {
    return this.d.store.list().filter((r) => r.from === slug).map((r) => r.id);
  }

  /** Who holds the request now: the recipient, or the main after an escalation. */
  handlerOf(id: string): string | undefined {
    const r = this.d.store.get(id);
    return r ? (r.state === 'escalated' ? this.d.mainSlug : r.to) : undefined;
  }

  rows(): RequestRow[] {
    const all = this.d.store.list().sort((a, b) => b.createdAt - a.createdAt);
    const live = all.filter((r) => r.state === 'open' || r.state === 'escalated');
    const settled = all.filter((r) => r.state === 'answered' || r.state === 'cancelled').slice(0, RECENT);
    return [...live, ...settled].map((r) => ({
      id: r.id, from: r.from, to: r.to, state: r.state, handler: r.state === 'escalated' ? this.d.mainSlug : r.to,
      text: r.text.slice(0, 300), hops: r.hops, createdAt: new Date(r.createdAt).toISOString(),
      ...(r.deadline !== undefined ? { deadline: new Date(r.deadline).toISOString() } : {}),
      ...(r.escalatedBy ? { escalatedBy: r.escalatedBy } : {}),
    }));
  }

  /** The chips of one session: its waiting steps (against whoever holds the request now) and what it owes. */
  infoFor(slug: string, waitingSteps: { requestId: string; to: string }[]): RequestsInfo | undefined {
    const waiting = waitingSteps.map((w) => ({ id: w.requestId, to: this.handlerOf(w.requestId) ?? w.to }));
    const owed = this.debts(slug).map((id) => ({ id, from: this.d.store.get(id)!.from }));
    return waiting.length + owed.length > 0 ? { waiting, owed } : undefined;
  }
}
