import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { autoClose, bootServer, mod, modToolUntilEnd, state, usePipePty, type Running } from './helpers';
import { gitSync, makeMultiRepo, makeRepo, removeDir, type MultiRepo, type TestRepo, worktreePathFor } from './git-helpers';
import { agentBranchFor, worktreePathFor as pathFor, worktreesDirFor } from '../src/server/git/worktree';

// Real git and real processes: slow on a busy machine.
vi.setConfig({ testTimeout: 120_000 });
process.env.CONSOLE_TEST = '1';
usePipePty(); // this file never reads the terminal: its sessions run on plain pipes

const scratch: string[] = [];
afterEach(() => { while (scratch.length) removeDir(scratch.pop()!); });
autoClose();

const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];

async function boot(): Promise<{ s: Running; t: TestRepo }> {
  const t = makeRepo({ remote: true });
  scratch.push(t.base);
  const s = await bootServer({ projectRoot: t.repo, config: { git: { worktrees: true } } });
  s.setLimits({ global: 20, perProject: 20 }); // fake agents never report events, so they stay active and would hold the slots
  const file = join(t.repo, '.andromedaconsole', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), testCommand: 'node -e "process.exit(0)"' }));
  return { s, t };
}
const tool = (s: Running, slug: string, name: string, body: unknown = {}) => mod(s, slug, `/v1/tools/${name}`, 'POST', body);
const spawn = (s: Running, name: string, extra: Record<string, unknown> = {}) =>
  tool(s, 'shop-api', 'spawn_agent', { name, profile: 'developer', goal: `the work of ${name}`, ...extra });
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
  expect(ticketFile(t, 'be-api').after).toBe('dba-schema');
  // the main sees the dependency in list_agents
  const rows = (await tool(s, 'shop-api', 'list_agents')).body.agents;
  expect(rows.find((a: any) => a.slug === 'be-api').after).toBe('dba-schema');
  expect(rows.find((a: any) => a.slug === 'dba-schema').after).toBeUndefined();
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
  expect(report.body.facts.after).toEqual({ name: 'dba-schema', status: 'in_progress' });
  const notMerged = (status: string) => ({ status: 'refused', code: 'after_not_merged', params: { after: 'dba-schema', status } });
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
  expect((await tool(s, 'shop-api', 'request_review', { name: 'be-api' })).body).toMatchObject({ code: 'after_not_merged', params: { after: 'dba-schema', status: 'missing' } });
  // the other agent's branch reaches the project branch by hand: the gate opens
  gitSync(t.repo, 'branch', '-f', 'project/shop-api', agentBranchFor('shop-api', 'dba-schema'));
  expect((await tool(s, 'shop-api', 'request_review', { name: 'be-api' })).body).toMatchObject({ status: 'ok', result: 'in_review' });
});
