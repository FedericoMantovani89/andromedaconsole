import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { autoClose, usePipePty, bootServer, mod, modToolUntilEnd, ui, until, type Running } from './helpers';
import { gitSync, makeRepo, type TestRepo, removeDir, worktreePathFor } from './git-helpers';
import { git } from '../src/server/git/git';

vi.setConfig({ testTimeout: 120_000 });
process.env.CONSOLE_TEST = '1';

const repos: TestRepo[] = [];
afterEach(() => { while (repos.length) removeDir(repos.pop()!.base); });
autoClose();
usePipePty(); // this file never reads the terminal: its sessions run on plain pipes

const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];

async function boot(config: Record<string, unknown> = {}): Promise<{ s: Running; t: TestRepo }> {
  const t = makeRepo({ remote: true });
  repos.push(t);
  const s = await bootServer({ projectRoot: t.repo, config: { git: { worktrees: true }, ...config } });
  s.setLimits({ global: 20, perProject: 20 });
  const file = join(t.repo, '.andromedaconsole', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), testCommand: 'node -e "process.exit(0)"' }));
  return { s, t };
}
const tool = (s: Running, slug: string, name: string, body: unknown = {}) => mod(s, slug, `/v1/tools/${name}`, 'POST', body);
const inbox = async (s: Running, slug: string): Promise<string[]> => (await mod(s, slug, '/v1/inbox')).body.messages.map((m: { text: string }) => m.text);
const queue = async (s: Running): Promise<any[]> => (await ui(s, '/api/state')).body.queue;

/** Spawn, work, deliver, review (pass), merge: the whole pipeline up to "merged". */
async function mergedTicket(s: Running, t: TestRepo, slug: string, file: string): Promise<void> {
  expect((await tool(s, 'shop-api', 'spawn_agent', { name: slug, profile: 'developer', goal: `Work of ${slug}` })).body.status).toBe('started');
  await tool(s, slug, 'checklist_set', { items: ITEMS });
  const wt = worktreePathFor(t.repo, slug);
  writeFileSync(join(wt, file), `${slug}\n`);
  for (let n = 1; n <= 6; n++) {
    if (n === 6) writeFileSync(join(wt, 'README.md'), `docs by ${slug}\n`);
    expect((await tool(s, slug, 'step_done', { n, note: 'a decent note for this step' })).body.status).toBe('closed');
  }
  expect((await tool(s, 'shop-api', 'request_review', { name: slug })).body.status).toBe('ok');
  expect((await tool(s, `review-${slug}`, 'review_verdict', { pass: true, notes: [] })).body.outcome).toBe('approved');
  expect((await modToolUntilEnd(s, 'shop-api', 'merge_ticket', { name: slug })).body.status).toBe('merged');
}

it('the console puts no git hook in the user\'s repository: the user\'s own push of main goes through', async () => {
  const { s, t } = await boot();
  expect(existsSync(join(t.repo, '.git', 'hooks', 'pre-push'))).toBe(false);
  writeFileSync(join(t.repo, 'x.txt'), 'x');
  gitSync(t.repo, 'add', '-A');
  gitSync(t.repo, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'local');
  expect((await git(t.repo, ['push', 'origin', 'main'])).code).toBe(0);
  void s;
});
it('the main\'s own attempts to push main are refused by the guard, force or not', async () => {
  const { s, t } = await boot();
  gitSync(t.repo, 'tag', 'v1'); // the guard knows a name is a tag when the tag exists
  for (const command of ['git push origin main', 'git push --force origin main', 'git push origin HEAD:main', 'git push', 'git push origin v1']) {
    const d = (await mod(s, 'shop-api', '/v1/guard', 'POST', { tool: 'Bash', input: { command } })).body;
    expect(d.decision, command).toBe('deny');
  }
});
it('propose_release with nothing merged says so and bothers nobody', async () => {
  const { s } = await boot();
  expect((await tool(s, 'shop-api', 'propose_release')).body).toEqual({ status: 'nothing_to_release' });
  expect(await queue(s)).toEqual([]);
});
it('a merged ticket becomes one confirmation in the queue; Reject touches nothing; Approve pushes main through the console', async () => {
  const { s, t } = await boot();
  await mergedTicket(s, t, 'fix-login', 'login.js');
  const remoteBefore = gitSync(t.remote, 'rev-parse', 'main');
  const r = await tool(s, 'shop-api', 'propose_release');
  expect(r.body).toMatchObject({ status: 'asked' });
  const q = await queue(s);
  expect(q).toHaveLength(1);
  expect(q[0]).toMatchObject({ kind: 'confirm', from: '@console', options: ['approve', 'reject'] });
  expect(q[0].payload).toMatchObject({ project: 'shop-api', branch: 'main' });
  expect(q[0].payload.tickets[0]).toMatchObject({ slug: 'fix-login' });
  expect(q[0].payload.tickets[0].report).toContain('## Objective');
  expect(q[0].payload.files.map((f: any) => f.path).sort()).toEqual(['README.md', 'login.js']);
  expect((await tool(s, 'shop-api', 'propose_release')).body).toMatchObject({ status: 'already_asked' });

  expect((await ui(s, `/api/queue/${q[0].id}/answer`, 'POST', { answer: 'yes' })).status).toBe(400);
  expect((await ui(s, `/api/queue/${q[0].id}/answer`, 'POST', { answer: 'reject' })).status).toBe(200);
  expect(gitSync(t.remote, 'rev-parse', 'main')).toBe(remoteBefore);
  expect((await inbox(s, 'shop-api')).join('\n')).toMatch(/rejected/);
  expect(await queue(s)).toEqual([]);

  expect((await tool(s, 'shop-api', 'propose_release')).body).toMatchObject({ status: 'asked' });
  const again = (await queue(s))[0];
  expect((await ui(s, `/api/queue/${again.id}/answer`, 'POST', { answer: 'approve' })).status).toBe(200);
  await until(() => gitSync(t.remote, 'rev-parse', 'main') === gitSync(t.repo, 'rev-parse', 'project/shop-api'), 30_000);
  expect(gitSync(t.repo, 'rev-parse', 'main')).toBe(gitSync(t.repo, 'rev-parse', 'project/shop-api'));
  expect(existsSync(join(t.repo, 'login.js'))).toBe(true);
  await until(async () => (await inbox(s, 'shop-api')).join('\n').includes('released'), 10_000);
});
