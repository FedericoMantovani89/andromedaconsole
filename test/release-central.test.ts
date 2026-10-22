import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gitSync, makeRepo, removeDir, type TestRepo } from './git-helpers';
import { ensureProjectWorktree } from '../src/server/git/merge';
import { loadBundles } from '../src/server/i18n-bundles';
import { createTranslator } from '../src/shared/i18n';
import { TicketStore } from '../src/server/tickets/store';
import { ReleaseService } from '../src/server/tickets/release';
import type { TestRun } from '../src/server/tickets/test-queue';

vi.setConfig({ testTimeout: 90_000 });

const bundles = loadBundles();
let t: TestRepo;

beforeEach(() => { t = makeRepo({ remote: true }); });
afterEach(() => removeDir(t.base));

async function merged(tickets: TicketStore): Promise<void> {
  const project = await ensureProjectWorktree(t.repo, 'p');
  if (!project.ok) throw new Error(project.code);
  writeFileSync(join(project.path, 'a.txt'), 'a\n');
  gitSync(project.path, 'add', '-A');
  gitSync(project.path, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'ticket a: work');
  const sha = gitSync(project.path, 'rev-parse', 'HEAD');
  tickets.setChecklist('a', [{ n: 1, title: 'Study', done: true, note: 'note' }]);
  tickets.move('a', 'delivered', { deliveredSha: sha });
  tickets.move('a', 'in_review', { reviewer: 'r' });
  tickets.move('a', 'approved');
  tickets.move('a', 'merged', { mergedSha: sha });
}

function service(tickets: TicketStore, over: { greenFor?: (repo: string, tip: string, command: string) => boolean }, runs: string[]): ReleaseService {
  return new ReleaseService({
    tickets, root: t.repo, project: 'p',
    testCommand: () => 'full-suite', testTimeoutMs: () => 30_000,
    runTests: async (o): Promise<TestRun> => { runs.push(`${o.owner}:${o.command}`); return { ok: true, code: 0, tail: 'ran' }; },
    ...over,
    language: () => ({ lang: 'en', t: createTranslator({ lang: 'en', messages: bundles.get('en') ?? {}, fallback: bundles.get('en') }) }),
    notifyMain: () => {}, askConfirm: () => 'q1',
  });
}

it('the proposal runs the full command through the queue as the release\'s own run', async () => {
  const tickets = new TicketStore(t.repo);
  await merged(tickets);
  const runs: string[] = [];
  expect(await service(tickets, {}, runs).proposeRelease()).toMatchObject({ status: 'asked' });
  expect(runs).toEqual(['release:p:full-suite']);
});

it('the proposal does not run the full command again on a tip the central run already passed', async () => {
  const tickets = new TicketStore(t.repo);
  await merged(tickets);
  const runs: string[] = [];
  const seen: string[] = [];
  const svc = service(tickets, { greenFor: (repo, tip, command) => { seen.push(`${repo}|${tip}|${command}`); return true; } }, runs);
  expect(await svc.proposeRelease()).toMatchObject({ status: 'asked' });
  expect(runs).toEqual([]);
  expect(seen).toEqual([`|${gitSync(t.repo, 'rev-parse', 'project/p')}|full-suite`]);
});
