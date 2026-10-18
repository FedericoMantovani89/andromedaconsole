import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitSync, makeRepo, removeDir, type TestRepo } from './git-helpers';
import { createAgentWorktree } from '../src/server/git/worktree';
import { Ledger, type LedgerEntry } from '../src/server/budget/ledger';
import { TicketStore } from '../src/server/tickets/store';
import { validateChecklist } from '../src/server/tickets/checklist';
import {
  MAX_RECOVERIES, RecoveryService, recoveryFacts, recoverySlugFor, replacementCheckout, replacementSlugFor, type RecoveryDeps,
} from '../src/server/tickets/recovery';

vi.setConfig({ testTimeout: 60_000 });

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
let t: TestRepo;
let wt: string;
let branch: string;
let wipSha: string;
let tickets: TicketStore;
let ledger: Ledger;
let deps: RecoveryDeps;
let svc: RecoveryService;
let command: string | undefined;
let recoveries: { slug: string; ticket: string; sha: string; goal: string; model?: string }[];
let replacements: { slug: string; profile: string; goal: string; model?: string; budget?: number; from: string }[];
let recoveryResult: { ok: true } | { ok: false; code: string; detail?: string };
let replacementResult: { ok: true } | { ok: false; code: string; detail?: string };
let main: string[];
let asked: { text: string; options: string[]; payload: unknown; answer: (a: string) => void }[];
let ended: string[];
let restarted: { slug: string; limit: number }[];
let usage: { used: number; limit: number } | undefined;
let existing: string[];

const entry = (turn: number, tokens: number, tools: string[], o: Partial<LedgerEntry> = {}): LedgerEntry => ({
  ts: '2026-10-05T10:00:00Z', project: 'p', root: t.repo, agent: 'a-job', session: 's1', turn, in: 0, out: tokens, cache_creation: 0, cache_read: 999_999, tools, cost: null, ...o,
});

beforeEach(async () => {
  t = makeRepo();
  const w = await createAgentWorktree({ repo: t.repo, project: 'p', slug: 'a-job' });
  wt = w.path;
  branch = w.branch;
  writeFileSync(join(wt, 'half.js'), 'half done\n');
  gitSync(wt, 'add', '-A');
  gitSync(wt, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'wip: budget stop');
  wipSha = gitSync(wt, 'rev-parse', 'HEAD');

  tickets = new TicketStore(t.repo);
  const r = validateChecklist(['Study the code', 'Tests first', 'Implement a', 'Implement b', 'Validation', 'Update documentation']);
  if (!r.ok) throw new Error(r.code);
  tickets.setChecklist('a-job', r.steps.map((s) => ({ ...s, done: s.n <= 2 })));
  tickets.setGoal('a-job', 'Add multiply to src/math.js');
  tickets.setBudget('a-job', { limit: 1000, step: 'stopped' });
  tickets.setStopCause('a-job', 'budget');
  tickets.setHandover('a-job', 'HANDOVER: step 3 half done, avoid reading dist/');
  tickets.move('a-job', 'suspended_budget');

  ledger = new Ledger(mkdtempSync(join(tmpdir(), 'rec-ledger-')));
  // eight turns: Read in six of them, Grep in two; turn 7 is the heaviest
  const project: [number, number, string[]][] = [
    [1, 100, ['Read']], [2, 300, ['Read', 'Grep']], [3, 50, ['Read']], [4, 700, ['Read', 'Bash']],
    [5, 200, ['Read']], [6, 400, ['Read', 'Grep']], [7, 900, ['Bash']], [8, 10, []],
  ];
  for (const [turn, tokens, tools] of project) ledger.append(entry(turn, tokens, tools));
  ledger.append(entry(9, 99_999, ['Read'], { project: 'other-project' })); // another project's agent of the same name never counts
  ledger.append(entry(10, 88_888, ['Read'], { agent: 'someone-else' }));

  command = undefined;
  recoveries = []; replacements = []; main = []; asked = []; ended = []; restarted = [];
  recoveryResult = { ok: true }; replacementResult = { ok: true };
  usage = { used: 1060, limit: 1000 };
  existing = ['a-job'];
  deps = {
    tickets, ledger, root: t.repo, project: 'p',
    worktreeOf: (slug) => (slug === 'a-job' ? { worktree: wt, branch } : undefined),
    testCommand: () => command, testTimeoutMs: () => 30_000,
    spawnRecovery: async (rq) => { recoveries.push(rq); return recoveryResult; },
    spawnReplacement: async (rq) => { replacements.push(rq); return replacementResult; },
    existingSlugs: () => existing,
    notifyMain: (text) => { main.push(text); },
    askUser: (q, answer) => { asked.push({ ...q, answer }); },
    endRecovery: (slug) => { ended.push(slug); },
    budget: { restart: (slug, limit) => { restarted.push({ slug, limit }); }, usage: () => usage },
    profileOf: () => 'developer',
    changed: () => {},
  };
  svc = new RecoveryService(deps);
}, 60_000); // a real git repo and worktree: plain slowness on a loaded machine, the default 10 s is not enough
afterEach(() => removeDir(t.base));

const started = async (): Promise<string> => {
  const r = await svc.start('a-job');
  if (!r.ok) throw new Error(r.code);
  existing.push(r.recovery);
  main.length = 0;
  return r.recovery;
};
const REPORT = { verified_steps: [1, 2], diagnosis: 'It read dist/ again and again.', remedy: 'exclude_paths', notes: 'skip dist/' };

describe('slugs', () => {
  it('recover-<ticket>, then -r2; never longer than 40 characters, always a valid slug', () => {
    expect(recoverySlugFor('fix-x', [])).toBe('recover-fix-x');
    expect(recoverySlugFor('fix-x', ['recover-fix-x'])).toBe('recover-fix-x-r2');
    for (const taken of [[], ['recover-' + 'a'.repeat(32)]]) {
      const s = recoverySlugFor('a'.repeat(40), taken);
      expect(s.length).toBeLessThanOrEqual(40);
      expect(s).toMatch(SLUG_RE);
      expect(taken).not.toContain(s);
    }
  });
  it('the replacement agent is the ticket name suffixed -rN, counted on the base name', () => {
    expect(replacementSlugFor('fix-x', ['fix-x'])).toBe('fix-x-r2');
    expect(replacementSlugFor('fix-x-r2', ['fix-x', 'fix-x-r2'])).toBe('fix-x-r3');
    const s = replacementSlugFor('b'.repeat(40), ['b'.repeat(40)]);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s).toMatch(SLUG_RE);
  });
});

describe('start', () => {
  it('refuses a ticket that is not stopped', async () => {
    tickets.setChecklist('busy', []);
    expect(await svc.start('busy')).toEqual({ ok: false, code: 'not_stopped' });
    expect(await svc.start('ghost')).toEqual({ ok: false, code: 'not_stopped' });
    expect(recoveries).toEqual([]);
  });
  it('on a suspended_budget ticket: recovering, one attempt counted, a read-only session on the WIP commit with the facts', async () => {
    const r = await svc.start('a-job');
    expect(r).toEqual({ ok: true, recovery: 'recover-a-job', attempt: 1 });
    expect(tickets.get('a-job')).toMatchObject({ status: 'recovering', recoveries: 1 });
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]).toMatchObject({ slug: 'recover-a-job', ticket: 'a-job', sha: wipSha });
    const goal = recoveries[0]!.goal;
    expect(goal).toMatch(/budget/i);
    expect(goal).toMatch(/turn 7: 900 tokens/);
    expect(goal).toContain('HANDOVER: step 3 half done');
    expect(goal).toContain('Add multiply to src/math.js');
    expect(goal).toContain('mcp__console-mod__recovery_report');
    expect(goal).toContain('select:mcp__console-mod__recovery_report');
    expect(goal).toMatch(/read-only/i);
  });
  it('a blocked ticket can be recovered too', async () => {
    tickets.restart('a-job');
    tickets.setStopCause('a-job', 'loop');
    tickets.move('a-job', 'blocked');
    expect(await svc.start('a-job')).toMatchObject({ ok: true });
    expect(recoveries[0]!.goal).toMatch(/loop/i);
  });
  it(`after ${MAX_RECOVERIES} attempts the ticket goes to the user: too_many, nothing started`, async () => {
    tickets.addRecovery('a-job');
    tickets.addRecovery('a-job');
    expect(await svc.start('a-job')).toEqual({ ok: false, code: 'too_many' });
    expect(tickets.get('a-job')!.status).toBe('needs_user');
    expect(recoveries).toEqual([]);
    expect(main.join('\n')).toMatch(/a-job/);
  });
  it('needs the worktree of the stopped agent', async () => {
    deps.worktreeOf = () => undefined;
    expect(await svc.start('a-job')).toMatchObject({ ok: false, code: 'no_worktree' });
    expect(tickets.get('a-job')).toMatchObject({ status: 'suspended_budget', recoveries: 0 });
  });
  it('a refused spawn leaves the ticket as it was, so the main can try again', async () => {
    recoveryResult = { ok: false, code: 'agent.spawnFailed', detail: 'no room' };
    expect(await svc.start('a-job')).toMatchObject({ ok: false, code: 'spawn_failed', detail: 'no room' });
    expect(tickets.get('a-job')).toMatchObject({ status: 'suspended_budget', recoveries: 0 });
    expect(await svc.report('recover-a-job', REPORT)).toEqual({ ok: false, code: 'not_recovery' });
  });
  it('two starts at the same moment start one recovery', async () => {
    const [a, b] = await Promise.all([svc.start('a-job'), svc.start('a-job')]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(recoveries).toHaveLength(1);
  });
});

describe('facts (git, the console test run and the ledger only)', () => {
  it('the heaviest turns are sorted by budget tokens and capped at 5; repeated tools are those seen in more than 5 turns', async () => {
    const f = await recoveryFacts(deps, 'a-job');
    expect(f.heaviestTurns.map((h) => [h.turn, h.tokens])).toEqual([[7, 900], [4, 700], [6, 400], [2, 300], [5, 200]]);
    expect(f.heaviestTurns[0]!.tools).toEqual(['Bash']);
    expect(f.repeatedTools).toEqual([{ tool: 'Read', count: 6 }]);
    expect(f.cause).toBe('budget');
    expect(f.checklist.map((s) => s.done)).toEqual([true, true, false, false, false, false]);
    expect(f.commits.join('\n')).toContain('wip: budget stop');
    expect(f.diffStat).toContain('half.js');
    expect(f.handover).toContain('HANDOVER');
  });
  it('with no test command testsOk is undefined and the goal says "unknown", never "PASSED"', async () => {
    const f = await recoveryFacts(deps, 'a-job');
    expect(f.testsOk).toBeUndefined();
    await svc.start('a-job');
    expect(recoveries[0]!.goal).toMatch(/tests[^\n]*unknown/i);
    expect(recoveries[0]!.goal).not.toMatch(/PASSED/);
  });
  it('with a test command the console runs it on the WIP', async () => {
    command = 'node -e "console.log(\'3 failing\'); process.exit(1)"';
    const f = await recoveryFacts(deps, 'a-job');
    expect(f.testsOk).toBe(false);
    expect(f.testTail).toContain('3 failing');
  });
});

describe('report', () => {
  it('is refused from a session that is not the recorded recovery', async () => {
    await started();
    expect(await svc.report('a-job', REPORT)).toEqual({ ok: false, code: 'not_recovery' });
    expect(await svc.report('recover-other', REPORT)).toEqual({ ok: false, code: 'not_recovery' });
  });
  it('an unknown remedy, an empty or oversized diagnosis, or bad steps are bad_request and change nothing', async () => {
    const rec = await started();
    for (const body of [
      { ...REPORT, remedy: 'banana' }, { ...REPORT, diagnosis: '  ' }, { ...REPORT, diagnosis: 'x'.repeat(4001) },
      { ...REPORT, verified_steps: ['one'] }, { ...REPORT, verified_steps: [1.5] }, { remedy: 'split' }, null,
    ]) {
      expect(await svc.report(rec, body), JSON.stringify(body)?.slice(0, 80)).toEqual({ ok: false, code: 'bad_request', detail: expect.any(String) });
    }
    expect(tickets.get('a-job')!.status).toBe('recovering');
    expect(ended).toEqual([]);
    expect(replacements).toEqual([]);
  });
  it('the recovery session is ended only after the report work is done: a slow replacement must not outlast the session grace', async () => {
    const rec = await started();
    let release!: () => void;
    deps.spawnReplacement = async (rq) => { replacements.push(rq); await new Promise<void>((res) => { release = res; }); return replacementResult; };
    const pending = svc.report(rec, { ...REPORT, remedy: 'split' });
    await vi.waitFor(() => expect(replacements).toHaveLength(1));
    expect(ended).toEqual([]); // the 3 s grace to end the session must not be running while the replacement starts
    release();
    expect(await pending).toEqual({ ok: true, ticket: 'a-job', outcome: 'restarted' });
    expect(ended).toEqual([rec]);
    expect(await svc.report(rec, { ...REPORT, remedy: 'split' })).toEqual({ ok: false, code: 'not_recovery' });
  });
  it('remedy split: a new agent takes the ticket over on the same branch; steps, recoveries and goal are kept', async () => {
    const rec = await started();
    const r = await svc.report(rec, { ...REPORT, remedy: 'split' });
    expect(r).toEqual({ ok: true, ticket: 'a-job', outcome: 'restarted' });
    expect(ended).toEqual([rec]);
    expect(replacements).toHaveLength(1);
    expect(replacements[0]).toMatchObject({ slug: 'a-job-r2', from: 'a-job', profile: 'developer', budget: 1000 });
    const goal = replacements[0]!.goal;
    expect(goal).toContain('Add multiply to src/math.js');
    expect(goal).toContain('It read dist/ again and again.');
    expect(goal).toContain('HANDOVER: step 3 half done');
    expect(goal).toMatch(/checklist_set/);
    expect(goal).toMatch(/step_done/);
    expect(tickets.get('a-job')).toBeUndefined();
    const moved = tickets.get('a-job-r2')!;
    expect(moved).toMatchObject({ slug: 'a-job-r2', status: 'in_progress', recoveries: 1, goal: 'Add multiply to src/math.js' });
    expect(moved.steps.map((s) => s.done)).toEqual([true, true, false, false, false, false]);
    expect(moved.stopCause).toBeUndefined();
    expect(restarted).toEqual([{ slug: 'a-job-r2', limit: 1000 }]);
    expect(main.join('\n')).toContain('a-job-r2');
    // the report counts once
    expect(await svc.report(rec, REPORT)).toEqual({ ok: false, code: 'not_recovery' });
    expect(replacements).toHaveLength(1);
  });
  it('a replacement that cannot start hands the ticket to the user under its old name', async () => {
    const rec = await started();
    replacementResult = { ok: false, code: 'agent.spawnFailed', detail: 'boom' };
    expect(await svc.report(rec, REPORT)).toEqual({ ok: true, ticket: 'a-job', outcome: 'needs_user' });
    expect(tickets.get('a-job-r2')).toBeUndefined();
    expect(tickets.get('a-job')).toMatchObject({ status: 'needs_user', recoveries: 1 });
    expect(main.join('\n')).toMatch(/boom/);
  });
  it('a replacement that cannot start gives the ticket back its stop cause (R6)', async () => {
    const rec = await started();
    replacementResult = { ok: false, code: 'agent.spawnFailed', detail: 'boom' };
    await svc.report(rec, REPORT);
    expect(tickets.get('a-job')).toMatchObject({ status: 'needs_user', stopCause: 'budget', blocked: false });
    expect(tickets.get('a-job-r2')).toBeUndefined();
  });
  it('a replacement that cannot start puts the ticket\'s budget back as it was (B5)', async () => {
    deps.budget.restart = (slug, limit) => { restarted.push({ slug, limit }); tickets.setBudget(slug, { limit, step: 'ok' }); }; // what the real one does
    const rec = await started();
    replacementResult = { ok: false, code: 'agent.spawnFailed', detail: 'boom' };
    await svc.report(rec, REPORT);
    expect(tickets.get('a-job')?.budget).toEqual({ limit: 1000, step: 'stopped' });
  });
  it('a replacement that cannot start leaves the stopped agent\'s worktree where it was (pinned: the report said it is lost)', async () => {
    const rec = await started();
    replacementResult = { ok: false, code: 'agent.spawnFailed', detail: 'boom' };
    await svc.report(rec, REPORT);
    expect(existsSync(wt)).toBe(true);
  });
  it('remedy raise_budget asks the user first: nothing is spent until "approve"', async () => {
    const rec = await started();
    const r = await svc.report(rec, { ...REPORT, remedy: 'raise_budget' });
    expect(r).toEqual({ ok: true, ticket: 'a-job', outcome: 'asked_user' });
    expect(ended).toEqual([rec]);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.options).toEqual(['approve', 'decline']);
    expect(asked[0]!.payload).toMatchObject({ ticket: 'a-job', reason: 'recovery_raise' });
    expect(replacements).toEqual([]);
    expect(restarted).toEqual([]);
    asked[0]!.answer('approve');
    await vi.waitFor(() => expect(replacements).toHaveLength(1));
    expect(restarted).toEqual([{ slug: 'a-job-r2', limit: 1590 }]); // 1.5 x the usage, which went past the limit
    expect(replacements[0]).toMatchObject({ slug: 'a-job-r2', budget: 1590, from: 'a-job' });
    expect(tickets.get('a-job-r2')!.status).toBe('in_progress');
    asked[0]!.answer('approve'); // a second answer acts on nothing
    await new Promise((res) => setTimeout(res, 50));
    expect(replacements).toHaveLength(1);
  });
  it('remedy raise_budget declined: the ticket waits for the user', async () => {
    const rec = await started();
    await svc.report(rec, { ...REPORT, remedy: 'raise_budget' });
    asked[0]!.answer('decline');
    await vi.waitFor(() => expect(tickets.get('a-job')!.status).toBe('needs_user'));
    expect(replacements).toEqual([]);
    expect(restarted).toEqual([]);
  });
  it('the third stop after two recoveries goes to the user', async () => {
    let rec = await started();
    await svc.report(rec, REPORT); // attempt 1 -> a-job-r2
    tickets.setStopCause('a-job-r2', 'budget');
    tickets.move('a-job-r2', 'suspended_budget');
    existing.push('a-job-r2');
    deps.worktreeOf = () => ({ worktree: wt, branch });
    const second = await svc.start('a-job-r2');
    expect(second).toMatchObject({ ok: true, recovery: 'recover-a-job-r2', attempt: 2 });
    rec = (second as { recovery: string }).recovery;
    existing.push(rec);
    await svc.report(rec, REPORT); // attempt 2 -> a-job-r3
    expect(tickets.get('a-job-r3')).toMatchObject({ status: 'in_progress', recoveries: 2 });
    tickets.move('a-job-r3', 'suspended_budget');
    expect(await svc.start('a-job-r3')).toEqual({ ok: false, code: 'too_many' });
    expect(tickets.get('a-job-r3')!.status).toBe('needs_user');
  });
});

describe('restart (the user raised the budget without a recovery)', () => {
  it('starts a new agent on the same branch with the given limit', async () => {
    const r = await svc.restart('a-job', { limit: 1500 });
    expect(r).toEqual({ ok: true, agent: 'a-job-r2' });
    expect(replacements[0]).toMatchObject({ slug: 'a-job-r2', from: 'a-job', budget: 1500 });
    expect(replacements[0]!.goal).toContain('HANDOVER: step 3 half done');
    expect(restarted).toEqual([{ slug: 'a-job-r2', limit: 1500 }]);
    expect(tickets.get('a-job-r2')).toMatchObject({ status: 'in_progress', recoveries: 0 });
  });
  it('refuses a ticket that is not stopped', async () => {
    tickets.restart('a-job');
    expect(await svc.restart('a-job', { limit: 1500 })).toMatchObject({ ok: false, code: 'not_stopped' });
    expect(replacements).toEqual([]);
  });
});

describe('abandon (the recovery session ended without a report)', () => {
  it('puts the ticket back to its stop status and tells the main once', async () => {
    const rec = await started();
    expect(svc.abandon(rec)).toBe(true);
    expect(tickets.get('a-job')).toMatchObject({ status: 'suspended_budget', recoveries: 1 });
    expect(main).toHaveLength(1);
    expect(main[0]).toMatch(/recover-a-job/);
    expect(svc.abandon(rec)).toBe(false);
    expect(main).toHaveLength(1);
    expect(svc.abandon('nobody')).toBe(false);
  });
  it('a blocked ticket goes back to blocked', async () => {
    tickets.restart('a-job');
    tickets.move('a-job', 'blocked');
    const rec = await started();
    svc.abandon(rec);
    expect(tickets.get('a-job')!.status).toBe('blocked');
  });
  it('does nothing after the report', async () => {
    const rec = await started();
    await svc.report(rec, REPORT);
    expect(svc.abandon(rec)).toBe(false);
  });
});

describe('fix wave', () => {
  it('remedy change_model never restarts by itself: the user chooses restart (same model) or leave', async () => {
    const rec = await started();
    const r = await svc.report(rec, { ...REPORT, remedy: 'change_model', notes: 'too subtle for this model' });
    expect(r).toEqual({ ok: true, ticket: 'a-job', outcome: 'asked_user' });
    expect(replacements).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.options).toEqual(['restart', 'leave']);
    expect(asked[0]!.payload).toMatchObject({ ticket: 'a-job', reason: 'recovery_change_model', remedy: 'change_model' });
    expect(JSON.stringify(asked[0]!.payload)).toContain('too subtle for this model');
    asked[0]!.answer('restart');
    await vi.waitFor(() => expect(replacements).toHaveLength(1));
    expect(replacements[0]).toMatchObject({ slug: 'a-job-r2', from: 'a-job' });
    expect(replacements[0]!.model).toBeUndefined(); // the same model: choosing another is out of scope
    expect(tickets.get('a-job-r2')!.status).toBe('in_progress');
  });

  it('remedy change_model answered leave: the ticket waits for the user, nothing starts', async () => {
    const rec = await started();
    await svc.report(rec, { ...REPORT, remedy: 'change_model' });
    asked[0]!.answer('leave');
    await vi.waitFor(() => expect(tickets.get('a-job')!.status).toBe('needs_user'));
    expect(replacements).toEqual([]);
  });

  it('the handover note the stopped agent left in its worktree reaches the new agent\'s goal', async () => {
    deps.readHandover = (slug) => (slug === 'a-job' ? 'FROM THE FILE: half of step 3, see notes.md' : undefined);
    const r = await svc.restart('a-job', { limit: 1500 });
    expect(r).toEqual({ ok: true, agent: 'a-job-r2' });
    expect(replacements[0]!.goal).toContain('FROM THE FILE: half of step 3');
    expect(tickets.get('a-job-r2')!.handover).toBe('FROM THE FILE: half of step 3, see notes.md');
  });

  it('a replacement tells who follows the name, and the undo after a failed start too', async () => {
    const renames: [string, string][] = [];
    deps.renamed = (from, to) => { renames.push([from, to]); };
    expect(await svc.restart('a-job', { limit: 1500 })).toEqual({ ok: true, agent: 'a-job-r2' });
    expect(renames).toEqual([['a-job', 'a-job-r2']]);
  });
  it('a replacement that cannot start tells that the name went back', async () => {
    const renames: [string, string][] = [];
    deps.renamed = (from, to) => { renames.push([from, to]); };
    replacementResult = { ok: false, code: 'agent.spawnFailed', detail: 'boom' };
    await svc.restart('a-job', { limit: 1500 });
    expect(renames).toEqual([['a-job', 'a-job-r2'], ['a-job-r2', 'a-job']]);
  });
});

describe('replacementCheckout', () => {
  it('with worktrees on, a replacement needs the worktree of the stopped agent (never a new branch); with them off it needs none', () => {
    expect(replacementCheckout(true, undefined)).toEqual({ ok: false, code: 'no_worktree' });
    expect(replacementCheckout(true, { worktree: 'w', branch: 'agent/p/a' })).toEqual({ ok: true });
    expect(replacementCheckout(false, undefined)).toEqual({ ok: true });
  });
});

describe('a step waiting for an answer (SPEC 10)', () => {
  it('the facts, the recovery goal and the take-over goal say which step waits and for what', async () => {
    tickets.setWaiting('a-job', 3, { requestId: 'TODO-7f3a15', to: 'be-orders' });
    const f = await recoveryFacts(deps, 'a-job');
    expect(f.checklist[2]).toMatchObject({ n: 3, done: false, waitingOn: { requestId: 'TODO-7f3a15', to: 'be-orders' } });
    expect(f.checklist[0]!.waitingOn).toBeUndefined();
    const rec = await started();
    expect(recoveries.at(-1)!.goal).toContain('3. [ ] Implement a (waiting for TODO-7f3a15 (be-orders))');
    expect(await svc.report(rec, { ...REPORT, remedy: 'split' })).toMatchObject({ ok: true, outcome: 'restarted' });
    expect(replacements[0]!.goal).toContain('3. [ ] Implement a (waiting for TODO-7f3a15 (be-orders))');
    expect(tickets.get('a-job-r2')!.steps[2]!.waitingOn).toEqual({ requestId: 'TODO-7f3a15', to: 'be-orders' });
  });
});
