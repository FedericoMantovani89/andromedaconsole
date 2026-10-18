import { afterEach, expect, it, vi } from 'vitest';
import { autoClose, usePipePty, bootServer, mod, type Running } from './helpers';
import { makeRepo, removeDir, type TestRepo } from './git-helpers';

vi.setConfig({ testTimeout: 60_000 });

const repos: TestRepo[] = [];
afterEach(() => { while (repos.length) removeDir(repos.pop()!.base); });
autoClose();
usePipePty();

const tool = (s: Running, slug: string, name: string, body: unknown) => mod(s, slug, `/v1/tools/${name}`, 'POST', body);
const boot = async (): Promise<Running> => {
  const t = makeRepo({ remote: true });
  repos.push(t);
  return bootServer({ projectRoot: t.repo, config: { git: { worktrees: true } } });
};

it('a bad_request from a console tool names the missing or wrong field in `detail`, the code is unchanged', async () => {
  const s = await boot();
  const bad = (detail: string) => ({ status: 'error', code: 'bad_request', detail });
  expect((await tool(s, 'shop-api', 'merge_ticket', {})).body).toEqual(bad('name is required'));
  expect((await tool(s, 'shop-api', 'spawn_agent', { profile: 'developer', goal: 'g' })).body).toEqual(bad('name is required'));
  expect((await tool(s, 'shop-api', 'spawn_agent', { name: 'x', goal: 'g' })).body).toEqual(bad('profile is required'));
  expect((await tool(s, 'shop-api', 'spawn_agent', { name: 'x', profile: 'developer', goal: ' ' })).body).toEqual(bad('goal is required'));
  expect((await tool(s, 'shop-api', 'spawn_agent', { name: 'x', profile: 'developer', goal: 'g', budget: 5 })).body)
    .toEqual(bad('budget must be a whole number between 1000 and 100000000'));
  expect((await tool(s, 'shop-api', 'resume_agent', {})).body).toEqual(bad('names must be a list of 1 to 50 agent names'));
  expect((await tool(s, 'shop-api', 'worktree_cleanup', { name: 'x' })).body).toEqual(bad('action must be "remove"'));
  expect((await tool(s, 'shop-api', 'send_back_ticket', { name: 'x' })).body).toEqual(bad('note is required'));
  expect((await tool(s, 'shop-api', 'ticket_report', {})).body).toEqual(bad('name is required'));
  expect((await tool(s, 'shop-api', 'start_recovery', {})).body).toEqual(bad('name is required'));
});
