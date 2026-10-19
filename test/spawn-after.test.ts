import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { autoClose, bootServer, mod, modEvent, modToolUntilEnd, state, ui, until, usePipePty, type Running } from './helpers';
import { gitSync, makeMultiRepo, makeRepo, removeDir, type MultiRepo, type TestRepo, worktreePathFor } from './git-helpers';
import { agentBranchFor, worktreePathFor as pathFor, worktreesDirFor } from '../src/server/git/worktree';
import { transcriptPath } from '../src/server/claude-code/transcript';

// Real git and real processes: slow on a busy machine.
vi.setConfig({ testTimeout: 120_000 });
process.env.CONSOLE_TEST = '1';
usePipePty(); // this file never reads the terminal: its sessions run on plain pipes

const scratch: string[] = [];
afterEach(() => { while (scratch.length) removeDir(scratch.pop()!); });
autoClose();

const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];

async function boot(o: { projectsDir?: string; config?: Record<string, unknown> } = {}): Promise<{ s: Running; t: TestRepo }> {
  const t = makeRepo({ remote: true });
  scratch.push(t.base);
  const s = await bootServer({ projectRoot: t.repo, ...(o.projectsDir ? { projectsDir: o.projectsDir } : {}), config: { git: { worktrees: true }, ...o.config } });
  s.setLimits({ global: 20, perProject: 20 }); // fake agents never report events, so they stay active and would hold the slots
  const file = join(t.repo, '.andromedaconsole', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), testCommand: 'node -e "process.exit(0)"' }));
  return { s, t };
}
const tool = (s: Running, slug: string, name: string, body: unknown = {}) => mod(s, slug, `/v1/tools/${name}`, 'POST', body);
const REASON = 'the API tests need the real migration, a mock would not catch a schema mismatch';
/** spawn_agent; with `after` it passes REASON as `after_reason` unless the test gives its own (or `null` to leave it out). */
const spawn = (s: Running, name: string, extra: Record<string, unknown> = {}) => {
  const body: Record<string, unknown> = { name, profile: 'developer', goal: `the work of ${name}`, ...(extra.after !== undefined ? { after_reason: REASON } : {}), ...extra };
  if (body.after_reason === null) delete body.after_reason;
  return tool(s, 'shop-api', 'spawn_agent', body);
};
const ticketFile = (t: TestRepo, slug: string): any => JSON.parse(readFileSync(join(t.repo, '.andromedaconsole', 'state', 'tickets', `${slug}.json`), 'utf8'));
const branches = (repo: string): string[] => gitSync(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);

/** Closes the first step with `file` written: the console commits it on the agent's branch. */
async function commitFirstStep(s: Running, t: TestRepo, slug: string, file: string): Promise<void> {
  expect((await tool(s, slug, 'checklist_set', { items: ITEMS })).body.status).toBe('ok');
  writeFileSync(join(worktreePathFor(t.repo, slug), file), `${slug}\n`);
  const r = await tool(s, slug, 'step_done', { n: 1, note: 'a decent note for this step' });
  expect(r.body.status, JSON.stringify(r.body)).toBe('closed');
}
/** The remaining steps of a ticket whose first step is closed: delivered. */
async function deliverRest(s: Running, t: TestRepo, slug: string): Promise<void> {
  const wt = worktreePathFor(t.repo, slug);
  for (let n = 2; n <= 6; n++) {
    if (n === 6) writeFileSync(join(wt, `README-${slug}.md`), 'docs\n');
    const r = await tool(s, slug, 'step_done', { n, note: 'a decent note for this step' });
    expect(r.body.status, `step ${n}: ${JSON.stringify(r.body)}`).toBe('closed');
  }
  expect(ticketFile(t, slug).status).toBe('delivered');
}
async function approve(s: Running, slug: string): Promise<void> {
  const r = await tool(s, 'shop-api', 'request_review', { name: slug });
  expect(r.body, JSON.stringify(r.body)).toMatchObject({ status: 'ok', result: 'in_review' });
  expect((await tool(s, r.body.reviewer, 'review_verdict', { pass: true })).body.outcome).toBe('approved');
}

it('an agent spawned after another starts from that agent\'s branch and sees its committed work; one without after does not', async () => {
  const { s, t } = await boot();
  expect((await spawn(s, 'dba-schema')).body.status).toBe('started');
  await commitFirstStep(s, t, 'dba-schema', 'migration.sql');
  const aTip = gitSync(t.repo, 'rev-parse', agentBranchFor('shop-api', 'dba-schema'));
  expect((await spawn(s, 'be-api', { after: 'dba-schema' })).body).toEqual({ status: 'started', name: 'be-api' });
  const b = worktreePathFor(t.repo, 'be-api');
  expect(readFileSync(join(b, 'migration.sql'), 'utf8')).toBe('dba-schema\n');
  expect(gitSync(t.repo, 'rev-parse', agentBranchFor('shop-api', 'be-api'))).toBe(aTip);
  expect(ticketFile(t, 'be-api')).toMatchObject({ after: 'dba-schema', afterReason: REASON });
  // the main (and so the user) sees the dependency and its reason in list_agents
  const rows = (await tool(s, 'shop-api', 'list_agents')).body.agents;
  expect(rows.find((a: any) => a.slug === 'be-api')).toMatchObject({ after: 'dba-schema', afterReason: REASON });
  expect(rows.find((a: any) => a.slug === 'dba-schema').after).toBeUndefined();
  expect(rows.find((a: any) => a.slug === 'dba-schema').afterReason).toBeUndefined();
  // without after: the project branch, as before
  expect((await spawn(s, 'fe-page')).body.status).toBe('started');
  expect(existsSync(join(worktreePathFor(t.repo, 'fe-page'), 'migration.sql'))).toBe(false);
  expect(gitSync(t.repo, 'rev-parse', agentBranchFor('shop-api', 'fe-page'))).toBe(gitSync(t.repo, 'rev-parse', 'project/shop-api'));
  expect(ticketFile(t, 'fe-page').after).toBeUndefined();
});

it('after an unknown name, the main, itself or an agent with no branch yet is refused and nothing is created', async () => {
  const { s, t } = await boot();
  const refusedWith = async (name: string, after: unknown, code: string): Promise<void> => {
    const r = await spawn(s, name, { after });
    expect(r.body, JSON.stringify(r.body)).toMatchObject({ status: 'error', code, params: { after } });
    expect(existsSync(worktreePathFor(t.repo, name))).toBe(false);
    expect(branches(t.repo)).not.toContain(agentBranchFor('shop-api', name));
    expect((await state(s)).agents.map((a: any) => a.slug)).not.toContain(name);
  };
  await refusedWith('be-api', 'nobody', 'after_unknown');
  await refusedWith('be-api', 'shop-api', 'after_not_agent');
  await refusedWith('be-api', 'be-api', 'after_self');
  // an agent waiting in the queue has no branch yet
  s.setLimits({ global: 1, perProject: 1 });
  expect((await spawn(s, 'first-job')).body.status).toBe('started');
  expect((await spawn(s, 'dba-schema')).body.status).toBe('queued');
  await refusedWith('be-api', 'dba-schema', 'after_no_branch');
  expect((await spawn(s, 'be-api', { after: 42 })).body).toMatchObject({ status: 'error', code: 'bad_request' });
});

it('after is a last resort: without a reason of 20 to 500 characters it is refused and nothing is created', async () => {
  const { s, t } = await boot();
  await spawn(s, 'dba-schema');
  await commitFirstStep(s, t, 'dba-schema', 'migration.sql');
  const nothingFor = async (name: string): Promise<void> => {
    expect(existsSync(worktreePathFor(t.repo, name))).toBe(false);
    expect(branches(t.repo)).not.toContain(agentBranchFor('shop-api', name));
    expect((await state(s)).agents.map((a: any) => a.slug)).not.toContain(name);
  };
  expect((await spawn(s, 'be-api', { after: 'dba-schema', after_reason: null })).body).toEqual({ status: 'error', code: 'after_reason_required' });
  await nothingFor('be-api');
  for (const reason of ['   too short      ', 'x'.repeat(501)]) {
    expect((await spawn(s, 'be-api', { after: 'dba-schema', after_reason: reason })).body).toEqual({ status: 'error', code: 'after_reason_required', detail: expect.stringContaining('after_reason') });
    await nothingFor('be-api');
  }
  expect((await spawn(s, 'be-api', { after: 'dba-schema', after_reason: `  ${REASON}  ` })).body.status).toBe('started');
  expect(ticketFile(t, 'be-api').afterReason).toBe(REASON); // trimmed
  await commitFirstStep(s, t, 'be-api', 'api.js');
  await deliverRest(s, t, 'be-api');
  expect((await tool(s, 'shop-api', 'ticket_report', { name: 'be-api' })).body.facts).toMatchObject({ after: { name: 'dba-schema' }, afterReason: REASON });
});

it('after an agent of another repository is after_other_repo', async () => {
  const m: MultiRepo = makeMultiRepo(['abc-fe', 'abc-be'], { remote: true });
  scratch.push(m.base);
  const s = await bootServer({ projectRoot: m.root, config: { git: { worktrees: true } } });
  expect((await spawn(s, 'dba-schema', { repo: 'abc-be' })).body.status).toBe('started');
  const r = await spawn(s, 'fe-page', { repo: 'abc-fe', after: 'dba-schema' });
  expect(r.body).toMatchObject({ status: 'error', code: 'after_other_repo', params: { after: 'dba-schema' } });
  const fe = m.repos['abc-fe']!.repo;
  expect(existsSync(pathFor(fe, 'fe-page', worktreesDirFor(m.root, fe)))).toBe(false);
  expect(branches(fe)).not.toContain(agentBranchFor('shop-api', 'fe-page'));
  expect((await spawn(s, 'be-api', { repo: 'abc-be', after: 'dba-schema' })).body.status).toBe('started'); // the same repo is fine
});

it('the dependent ticket cannot be reviewed or merged before the other one is merged; then it can', async () => {
  const { s, t } = await boot();
  await spawn(s, 'dba-schema');
  await commitFirstStep(s, t, 'dba-schema', 'migration.sql');
  await spawn(s, 'be-api', { after: 'dba-schema' });
  await commitFirstStep(s, t, 'be-api', 'api.js');
  await deliverRest(s, t, 'be-api');
  // ticket_report names the dependency
  const report = await tool(s, 'shop-api', 'ticket_report', { name: 'be-api' });
  expect(report.body.status).toBe('ok');
  expect(report.body.facts.after).toEqual({ name: 'dba-schema', status: 'in_progress', merged: false });
  expect(report.body.facts.files.map((f: any) => f.path).sort()).toEqual(['README-be-api.md', 'api.js']); // its own work, not the other agent's
  const notMerged = (status: string) => ({ status: 'refused', code: 'after_not_merged', params: { after: 'dba-schema', status }, detail: expect.stringContaining(`whose ticket is ${status}`) });
  expect((await tool(s, 'shop-api', 'request_review', { name: 'be-api' })).body).toEqual(notMerged('in_progress'));
  expect((await tool(s, 'shop-api', 'merge_ticket', { name: 'be-api' })).body).toEqual(notMerged('in_progress'));
  expect(ticketFile(t, 'be-api').status).toBe('delivered');
  // the other ticket delivered, reviewed and approved is still not enough
  await deliverRest(s, t, 'dba-schema');
  await approve(s, 'dba-schema');
  expect((await tool(s, 'shop-api', 'request_review', { name: 'be-api' })).body).toEqual(notMerged('approved'));
  // a reviewer has no branch of its own to start from
  expect((await spawn(s, 'x-job', { after: 'review-dba-schema' })).body).toMatchObject({ status: 'error', code: 'after_not_agent' });
  expect(existsSync(worktreePathFor(t.repo, 'x-job'))).toBe(false);
  expect((await modToolUntilEnd(s, 'shop-api', 'merge_ticket', { name: 'dba-schema' })).body).toMatchObject({ status: 'merged' });
  // merged: the dependent ticket goes through
  await approve(s, 'be-api');
  expect((await modToolUntilEnd(s, 'shop-api', 'merge_ticket', { name: 'be-api' })).body).toMatchObject({ status: 'merged' });
  expect(gitSync(t.repo, 'show', 'project/shop-api:migration.sql')).toBe('dba-schema');
  expect(gitSync(t.repo, 'show', 'project/shop-api:api.js')).toBe('be-api');
});

it('when the other ticket is gone, the gate asks git: its branch merged into the project branch lets the dependent one through', async () => {
  const { s, t } = await boot();
  await spawn(s, 'dba-schema');
  await commitFirstStep(s, t, 'dba-schema', 'migration.sql');
  await spawn(s, 'be-api', { after: 'dba-schema' });
  await commitFirstStep(s, t, 'be-api', 'api.js');
  await deliverRest(s, t, 'be-api');
  const ticketPath = join(t.repo, '.andromedaconsole', 'state', 'tickets', 'dba-schema.json');
  removeDir(ticketPath);
  expect((await tool(s, 'shop-api', 'request_review', { name: 'be-api' })).body).toMatchObject({ code: 'after_not_merged', params: { after: 'dba-schema', status: 'missing' }, detail: expect.stringContaining('merge its branch, or ask the user') });
  // the other agent's branch reaches the project branch by hand: the gate opens
  gitSync(t.repo, 'branch', '-f', 'project/shop-api', agentBranchFor('shop-api', 'dba-schema'));
  expect((await tool(s, 'shop-api', 'request_review', { name: 'be-api' })).body).toMatchObject({ status: 'ok', result: 'in_review' });
});

/** The console's own worktree of the project branch, where merges happen. */
const projectWorktree = (repo: string): string => {
  const blocks = gitSync(repo, 'worktree', 'list', '--porcelain').split(/\r?\n\r?\n/);
  const block = blocks.find((b) => b.includes('branch refs/heads/project/shop-api'))!;
  return /^worktree (.+)$/m.exec(block)![1]!.trim();
};

it('a dependent ticket is squash-merged with its own work only, even when the other agent changed its files after it started', async () => {
  const { s, t } = await boot();
  await spawn(s, 'dba-schema');
  await commitFirstStep(s, t, 'dba-schema', 'migration.sql');
  await spawn(s, 'be-api', { after: 'dba-schema' });
  const base = ticketFile(t, 'be-api').baseSha;
  expect(base).toBe(gitSync(t.repo, 'rev-parse', agentBranchFor('shop-api', 'dba-schema')));
  await commitFirstStep(s, t, 'be-api', 'api.js');
  await deliverRest(s, t, 'be-api');
  // the other agent changes its file after the dependent one started, then is squash-merged
  writeFileSync(join(worktreePathFor(t.repo, 'dba-schema'), 'migration.sql'), 'dba-schema v2\n');
  await deliverRest(s, t, 'dba-schema');
  await approve(s, 'dba-schema');
  expect((await modToolUntilEnd(s, 'shop-api', 'merge_ticket', { name: 'dba-schema' })).body).toMatchObject({ status: 'merged' });
  // the report and the review see only the dependent ticket's own files
  const report = await tool(s, 'shop-api', 'ticket_report', { name: 'be-api' });
  expect(report.body.facts.files.map((f: any) => f.path).sort()).toEqual(['README-be-api.md', 'api.js']);
  expect(report.body.facts).toMatchObject({ base, after: { name: 'dba-schema', status: 'merged', merged: true } });
  const r = await tool(s, 'shop-api', 'request_review', { name: 'be-api' });
  expect(r.body).toMatchObject({ status: 'ok', result: 'in_review' });
  const goal = (await mod(s, r.body.reviewer, '/v1/inbox')).body.messages.map((m: { text: string }) => m.text).join('\n');
  expect(goal).toContain(`git diff ${base.slice(0, 12)}..HEAD`);
  expect((await tool(s, r.body.reviewer, 'review_verdict', { pass: true })).body.outcome).toBe('approved');
  // the squash merge applies its own commits: clean, the other agent's later change kept
  expect((await modToolUntilEnd(s, 'shop-api', 'merge_ticket', { name: 'be-api' })).body).toMatchObject({ status: 'merged' });
  expect(gitSync(t.repo, 'show', 'project/shop-api:migration.sql')).toBe('dba-schema v2');
  expect(gitSync(t.repo, 'show', 'project/shop-api:api.js')).toBe('be-api');
  expect(gitSync(t.repo, 'show', '--name-only', '--format=', 'project/shop-api').split('\n').filter(Boolean).sort()).toEqual(['README-be-api.md', 'api.js']);
  expect(gitSync(t.repo, 'log', '-1', '--format=%B', 'project/shop-api')).toContain('Files: 2 changed');
});

it('with squash off the dependent ticket is merged as before: the other agent\'s commits are already its merge base', async () => {
  const { s, t } = await boot();
  const file = join(t.repo, '.andromedaconsole', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), squash: false }));
  await spawn(s, 'dba-schema');
  await commitFirstStep(s, t, 'dba-schema', 'migration.sql');
  await spawn(s, 'be-api', { after: 'dba-schema' });
  await commitFirstStep(s, t, 'be-api', 'api.js');
  await deliverRest(s, t, 'be-api');
  writeFileSync(join(worktreePathFor(t.repo, 'dba-schema'), 'migration.sql'), 'dba-schema v2\n');
  await deliverRest(s, t, 'dba-schema');
  await approve(s, 'dba-schema');
  expect((await modToolUntilEnd(s, 'shop-api', 'merge_ticket', { name: 'dba-schema' })).body).toMatchObject({ status: 'merged' });
  await approve(s, 'be-api');
  expect((await modToolUntilEnd(s, 'shop-api', 'merge_ticket', { name: 'be-api' })).body).toMatchObject({ status: 'merged' });
  expect(gitSync(t.repo, 'rev-list', '--parents', '-n', '1', 'project/shop-api').split(' ')).toHaveLength(3); // a merge commit
  expect(gitSync(t.repo, 'show', 'project/shop-api:migration.sql')).toBe('dba-schema v2');
  expect(gitSync(t.repo, 'show', 'project/shop-api:api.js')).toBe('be-api');
});

it('a real overlap of a dependent ticket with another merged ticket still goes through the conflict flow, and the project branch stays clean', async () => {
  const { s, t } = await boot();
  await spawn(s, 'dba-schema');
  await commitFirstStep(s, t, 'dba-schema', 'migration.sql');
  await spawn(s, 'be-api', { after: 'dba-schema' });
  await spawn(s, 'fe-page');
  await commitFirstStep(s, t, 'be-api', 'api.js');
  await commitFirstStep(s, t, 'fe-page', 'api.js'); // the same new file with other content
  for (const slug of ['be-api', 'fe-page', 'dba-schema']) await deliverRest(s, t, slug);
  for (const slug of ['dba-schema', 'fe-page']) {
    await approve(s, slug);
    expect((await modToolUntilEnd(s, 'shop-api', 'merge_ticket', { name: slug })).body).toMatchObject({ status: 'merged' });
  }
  await approve(s, 'be-api');
  const before = gitSync(t.repo, 'rev-parse', 'project/shop-api');
  expect((await modToolUntilEnd(s, 'shop-api', 'merge_ticket', { name: 'be-api' })).body).toEqual({ status: 'conflict', files: ['api.js'] });
  expect(gitSync(t.repo, 'rev-parse', 'project/shop-api')).toBe(before);
  expect(gitSync(projectWorktree(t.repo), 'status', '--porcelain')).toBe('');
  expect(ticketFile(t, 'be-api')).toMatchObject({ status: 'in_progress', round: 1 });
});

it('when the other agent is replaced, the dependent ticket follows the new name: refused while it is not merged, through once it is', async () => {
  const projectsDir = mkdtempSync(join(tmpdir(), 'after-proj-'));
  scratch.push(projectsDir);
  const { s, t } = await boot({ projectsDir, config: { budget: { graceMinutes: 0 } } });
  expect((await spawn(s, 'dba-schema', { budget: 1000 })).body.status).toBe('started');
  const wt = worktreePathFor(t.repo, 'dba-schema');
  await modEvent(s, 'dba-schema', 'session.start', { cwd: wt });
  await commitFirstStep(s, t, 'dba-schema', 'migration.sql');
  await spawn(s, 'be-api', { after: 'dba-schema' });
  await commitFirstStep(s, t, 'be-api', 'api.js');
  await deliverRest(s, t, 'be-api');
  // the other agent runs out of budget; the user raises it: a new agent takes its ticket over on the same branch
  const file = transcriptPath(projectsDir, wt, 'sess-dba-schema');
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-test', usage: { input_tokens: 0, output_tokens: 1050 }, content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] } })}\n`);
  for (let i = 0; i < 2; i++) { await modEvent(s, 'dba-schema', 'turn.start'); await modEvent(s, 'dba-schema', 'turn.complete', {}); }
  await until(() => ticketFile(t, 'dba-schema').status === 'suspended_budget', 30_000);
  await until(async () => (await state(s)).queue.length === 1, 20_000);
  const q = (await state(s)).queue[0];
  expect((await ui(s, `/api/queue/${q.id}/answer`, 'POST', { answer: 'raise' })).status).toBe(200);
  await until(() => existsSync(worktreePathFor(t.repo, 'dba-schema-r2')) && existsSync(join(t.repo, '.andromedaconsole', 'state', 'tickets', 'dba-schema-r2.json')), 30_000);
  await until(() => ticketFile(t, 'be-api').after === 'dba-schema-r2', 20_000);
  expect(ticketFile(t, 'be-api').afterReason).toBe(REASON); // the reason stays with the dependency
  expect((await tool(s, 'shop-api', 'list_agents')).body.agents.find((a: any) => a.slug === 'be-api').after).toBe('dba-schema-r2');
  expect((await tool(s, 'shop-api', 'request_review', { name: 'be-api' })).body).toMatchObject({ status: 'refused', code: 'after_not_merged', params: { after: 'dba-schema-r2', status: 'in_progress' } });
  // the replacement finishes the work and is merged: the dependent ticket goes through
  await until(async () => (await state(s)).agents.find((a: any) => a.slug === 'dba-schema-r2')?.status === 'running', 30_000);
  await deliverRest(s, t, 'dba-schema-r2');
  await approve(s, 'dba-schema-r2');
  expect((await modToolUntilEnd(s, 'shop-api', 'merge_ticket', { name: 'dba-schema-r2' })).body).toMatchObject({ status: 'merged' });
  await approve(s, 'be-api');
  expect((await modToolUntilEnd(s, 'shop-api', 'merge_ticket', { name: 'be-api' })).body).toMatchObject({ status: 'merged' });
});
