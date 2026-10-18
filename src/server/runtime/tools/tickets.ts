import type { Context } from '../../http';
import { badRequest } from '../../tool-errors';
import type { ProjectContainer } from '../services';

/** How long one step_done request waits for the step (the validation can take tens of minutes): the host cuts a request that stays open for about a minute. */
const STEP_DONE_WAIT_MS = 15_000;

/** The console tools of a ticket's life: steps, review, recovery, release and merge. */
export function ticketTools(k: ProjectContainer): Pick<Context['tools'], 'checklist_set' | 'step_done' | 'report_blocked' | 'ticket_report' | 'request_review' | 'send_back_ticket' | 'review_verdict' | 'propose_release' | 'release_answer' | 'start_recovery' | 'recovery_report' | 'merge_ticket'> {
  const restrictions = k.get('restrictions');
  const steps = k.get('steps');
  const review = k.get('review');
  const release = k.get('release');
  const recovery = k.get('recovery');
  const merge = k.get('merge');
  return {
    checklist_set: async (slug, body) => {
      const items = (body as { items?: unknown } | null)?.items;
      if (!Array.isArray(items)) return badRequest('items must be a list of step titles');
      // A restricted agent may only close its step: a new checklist would let it escape the restriction with an empty step.
      if (restrictions.get(slug)) return { status: 'refused', code: 'restricted' };
      return steps.checklistSet(slug, items as string[]);
    },
    step_done: async (slug, body) => {
      const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
      if (typeof b.n !== 'number' || !Number.isInteger(b.n)) return badRequest('n must be the whole number of the step');
      return steps.stepDone(slug, {
        n: b.n, note: typeof b.note === 'string' ? b.note : undefined, skip: b.skip === true,
      }, { waitMs: STEP_DONE_WAIT_MS }); // longer than this and the host drops the request; the mod asks again on "running"
    },
    report_blocked: async (slug, body) => {
      const reason = (body as { reason?: unknown } | null)?.reason;
      if (typeof reason !== 'string' || reason.trim() === '') return badRequest('reason is required');
      steps.reportBlocked(slug, reason.trim().slice(0, 500));
      return { status: 'ok' };
    },
    ticket_report: async (_slug, body) => {
      const name = (body as { name?: unknown } | null)?.name;
      if (typeof name !== 'string' || name === '') return badRequest('name is required');
      const r = await review.ticketReport(name, { rerun: (body as { rerun?: unknown }).rerun === true });
      return r.ok ? { status: 'ok', facts: r.facts, report: r.report, reportFile: r.reportFile } : { status: 'refused', code: r.code, ...(r.detail ? { detail: r.detail } : {}) };
    },
    request_review: async (_slug, body) => {
      const b = (typeof body === 'object' && body !== null ? body : {}) as { name?: unknown; model?: unknown };
      if (typeof b.name !== 'string' || b.name === '') return badRequest('name is required');
      const r = await review.requestReview(b.name, { model: typeof b.model === 'string' && b.model !== '' ? b.model : undefined });
      if (!r.ok) return { status: 'refused', code: r.code, ...(r.detail ? { detail: r.detail } : {}) };
      const { ok: _ok, status: result, ...rest } = r;
      return { status: 'ok', result, ...rest };
    },
    send_back_ticket: async (_slug, body) => {
      const b = (typeof body === 'object' && body !== null ? body : {}) as { name?: unknown; note?: unknown };
      if (typeof b.name !== 'string' || b.name === '') return badRequest('name is required');
      if (typeof b.note !== 'string') return badRequest('note is required');
      const r = await review.sendBack(b.name, b.note);
      if (!r.ok) return { status: 'refused', code: r.code };
      const { ok: _ok, status: result, ...rest } = r;
      return { status: 'ok', result, ...rest };
    },
    review_verdict: async (slug, body) => {
      const r = await review.reviewVerdict(slug, body);
      if (!r.ok) return r.code === 'bad_request' ? badRequest(r.detail ?? 'the verdict is malformed') : { status: 'refused', code: r.code };
      const { ok: _ok, ...rest } = r;
      return { status: 'ok', ...rest };
    },
    propose_release: async () => release.proposeRelease(),
    // Called by the mod alone (v1 checks the release key): the user's answer to the main's AskUserQuestion release dialog.
    release_answer: async (_slug, body) => {
      const b = (typeof body === 'object' && body !== null ? body : {}) as { id?: unknown; answer?: unknown; question?: unknown };
      if (typeof b.id !== 'string' || (b.answer !== 'approve' && b.answer !== 'reject') || typeof b.question !== 'string') return badRequest('id and question are required and answer must be "approve" or "reject"');
      return release.answerFromDialog(b.id, b.answer, b.question);
    },
    start_recovery: async (_slug, body) => {
      const name = (body as { name?: unknown } | null)?.name;
      if (typeof name !== 'string' || name === '') return badRequest('name is required');
      const r = await recovery.start(name);
      if (!r.ok) return { status: 'refused', code: r.code, ...(r.detail ? { detail: r.detail } : {}) };
      const { ok: _ok, ...rest } = r;
      return { status: 'ok', ...rest };
    },
    recovery_report: async (slug, body) => {
      const r = await recovery.report(slug, body);
      if (!r.ok) return r.code === 'bad_request' ? badRequest(r.detail ?? 'the report is malformed') : { status: 'refused', code: r.code };
      const { ok: _ok, ...rest } = r;
      return { status: 'ok', ...rest };
    },
    merge_ticket: async (_slug, body) => {
      const name = (body as { name?: unknown } | null)?.name;
      if (typeof name !== 'string' || name === '') return badRequest('name is required');
      return merge.mergeTicket(name);
    },
  };
}
