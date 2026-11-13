import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProfile, pickableProfiles, renderAgentPrompt } from '../src/server/profiles';
import { AGENT_TOOLS, AUDITOR_TOOLS, MAIN_TOOLS, RECOVERY_TOOLS, REVIEWER_TOOLS } from '../src/server/agents/spawn';
import { TOOL_ROLES } from '../src/server/v1';

const tmp = () => mkdtempSync(join(tmpdir(), 'audit-role-'));

describe('the auditor profile', () => {
  it('is shipped, read-only, has a token budget, and says what it must not do', () => {
    const p = loadProfile('auditor', tmp(), tmp());
    expect(p?.source).toBe('shipped');
    expect(p?.readOnly).toBe(true);
    expect(p?.budgetTokens).toBeGreaterThanOrEqual(1000);
    expect(p?.body).toContain('audit_report');
    expect(p?.body).toMatch(/correctness/i);
    expect(p?.body).toMatch(/exactly once/i);
    expect(p?.body).toMatch(/language/i);
  });

  it('is never offered for starting by hand', () => {
    expect(pickableProfiles(undefined, ['developer', 'reviewer', 'recovery', 'auditor'])).toEqual(['developer']);
  });

  it('its prompt replaces the author rules: a read-only checkout and audit_report, no step_done', () => {
    const out = tmp();
    const text = readFileSync(renderAgentPrompt({ profile: loadProfile('auditor', tmp(), tmp())!, slug: 'audit-x', project: 'shop-api', outDir: out, git: { worktree: 'D:/w/a', branch: 'audit/audit-x' }, audit: true }), 'utf8');
    expect(text).toContain('D:/w/a');
    expect(text).toContain('audit_report');
    expect(text).toMatch(/read-only/i);
    expect(text).not.toContain('step_done');
    expect(text).not.toContain('review_verdict');
  });
});

describe('the auditor\'s tools', () => {
  it('are list_agents and audit_report, nothing that spawns, reviews, releases or writes tickets', () => {
    expect(AUDITOR_TOOLS).toEqual(['mcp__andromeda-mcp__list_agents', 'mcp__andromeda-mcp__audit_report']);
    for (const t of ['spawn_agent', 'review_verdict', 'release_answer', 'step_done', 'request_audit']) expect(AUDITOR_TOOLS.some((x) => x.endsWith(t)), t).toBe(false);
  });

  it('request_audit is the main\'s, audit_report is nobody else\'s tool', () => {
    expect(MAIN_TOOLS).toContain('mcp__andromeda-mcp__request_audit');
    for (const list of [AGENT_TOOLS, REVIEWER_TOOLS, RECOVERY_TOOLS]) expect(list.some((t) => t.endsWith('audit_report') || t.endsWith('request_audit'))).toBe(false);
  });

  it('the console accepts audit_report only from an auditor and request_audit only from the main', () => {
    expect(TOOL_ROLES.audit_report).toEqual(['auditor']);
    expect(TOOL_ROLES.request_audit).toEqual(['main']);
    expect(TOOL_ROLES.list_agents).toContain('auditor');
    expect(TOOL_ROLES.ask_user).toContain('auditor');
    expect(TOOL_ROLES.review_verdict).not.toContain('auditor');
  });
});
