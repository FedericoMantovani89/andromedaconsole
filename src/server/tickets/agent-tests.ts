import type { AgentTests } from './store';

const MAX_COMMAND = 500;
const MAX_SUMMARY = 500;

export type ParsedAgentTests = { ok: true; tests: AgentTests } | { ok: false; detail: string };

/**
 * The `tests` an agent passes to `step_done`: what it ran itself and how it ended. The console never checks it; the shape is
 * validated so a malformed claim is refused with the field named instead of being stored.
 */
export function parseAgentTests(raw: unknown): ParsedAgentTests {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, detail: 'tests must be an object { command, result, summary? }' };
  const r = raw as Record<string, unknown>;
  const command = typeof r.command === 'string' ? r.command.trim() : '';
  if (command === '') return { ok: false, detail: 'tests.command is required: the command you ran' };
  if (/[\r\n]/.test(command)) return { ok: false, detail: 'tests.command must be one line' };
  if (command.length > MAX_COMMAND) return { ok: false, detail: `tests.command is longer than ${MAX_COMMAND} characters` };
  if (r.result !== 'passed' && r.result !== 'failed') return { ok: false, detail: 'tests.result must be "passed" or "failed"' };
  if (r.summary !== undefined && typeof r.summary !== 'string') return { ok: false, detail: 'tests.summary must be text' };
  const summary = typeof r.summary === 'string' ? r.summary.trim() : '';
  if (summary.length > MAX_SUMMARY) return { ok: false, detail: `tests.summary is longer than ${MAX_SUMMARY} characters` };
  return { ok: true, tests: { command, result: r.result, ...(summary !== '' ? { summary } : {}) } };
}
