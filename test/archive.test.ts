// Archiving agents that ended for good: the flag in the registry, what un-archives, what is persisted and restored, and the rules of
// the by-hand archive. Nothing is deleted: only a flag moves.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { archiveAgent, archiveFinished, forceArchiveAgent, deleteAllArchived, deleteArchived, unarchiveAgent } from '../src/server/agents/archive';
import { AgentPersister } from '../src/server/agents/persist';
import { AgentRegistry } from '../src/server/agents/registry';
import { restoreAgents } from '../src/server/agents/restore';
import type { AgentPatch, AgentRecord } from '../src/server/project-store';
import { TicketStore } from '../src/server/tickets/store';
import { canArchive } from '../src/shared/archive';

let registry: AgentRegistry;
let tickets: TicketStore;
beforeEach(() => {
  registry = new AgentRegistry();
  tickets = new TicketStore(mkdtempSync(join(tmpdir(), 'archive-')));
});

const start = (slug: string): void => {
  registry.register({ slug, role: 'agent', profile: 'developer', goal: 'g' });
  registry.onSpawned(slug);
  registry.onModEvent(slug, { type: 'session.start', sessionId: `sess-${slug}` });
};

describe('automatic archive', () => {
  it('an agent whose session ended for good is archived when its process exits', () => {
    start('a');
    registry.markFinished('a');
    expect(registry.get('a')?.archived).toBeUndefined(); // not before the process is gone
    registry.onProcessExit('a');
    expect(registry.get('a')).toMatchObject({ state: 'finished', archived: true });
    expect(typeof registry.get('a')?.archivedAt).toBe('string');
  });
  it('an agent stopped on purpose (budget, loop, limit, replacement) is finished but not archived', () => {
    start('a');
    registry.markFinished('a', { stopped: true });
    registry.onProcessExit('a');
    expect(registry.get('a')).toMatchObject({ state: 'finished' });
    expect(registry.get('a')?.archived).toBeFalsy();
  });
  it('a crash (interrupted) and a running agent are never archived', () => {
    start('a'); start('b');
    registry.onProcessExit('a');
    expect(registry.get('a')).toMatchObject({ state: 'interrupted' });
    expect(registry.get('a')?.archived).toBeFalsy();
    expect(registry.get('b')?.archived).toBeFalsy();
  });
  it('an archive makes the registry notify, so it is persisted', () => {
    start('a');
    const seen: string[] = [];
    registry.on((s) => seen.push(s));
    registry.markFinished('a');
    registry.onProcessExit('a');
    expect(seen).toContain('a');
  });
});

describe('un-archive on new work', () => {
  const archived = (): void => { start('a'); registry.markFinished('a'); registry.onProcessExit('a'); };
  it('a revive (resume, recovery restart, send-back after a wake) clears the flag', () => {
    archived();
    registry.revive('a');
    expect(registry.get('a')?.archived).toBeFalsy();
    expect(registry.get('a')?.archivedAt).toBeUndefined();
  });
  it('a by-hand archive of an idle agent is cleared by its next turn', () => {
    start('a');
    registry.onModEvent('a', { type: 'turn.complete', sessionId: 's' });
    expect(registry.get('a')?.state).toBe('idle');
    expect(registry.setArchived('a', true)).toBe(true);
    registry.onModEvent('a', { type: 'turn.start', sessionId: 's' });
    expect(registry.get('a')?.archived).toBeFalsy();
  });
  it('a new registration of the same name starts not archived', () => {
    archived();
    registry.register({ slug: 'a', role: 'agent', profile: 'developer', goal: 'again' });
    expect(registry.get('a')?.archived).toBeFalsy();
  });
});

describe('canArchive (by hand)', () => {
  it('idle with a delivered or merged ticket, or finished without a waiting ticket', () => {
    expect(canArchive('idle', 'delivered')).toBe(true);
    expect(canArchive('idle', 'merged')).toBe(true);
    expect(canArchive('idle', 'released')).toBe(true);
    expect(canArchive('finished', undefined)).toBe(true);
    expect(canArchive('finished', 'merged')).toBe(true);
  });
  it('never a running, queued, dormant, interrupted or suspended agent, nor a stopped or waiting ticket', () => {
    for (const s of ['starting', 'working', 'waiting_user', 'queued', 'dormant', 'interrupted', 'studying', 'blocked', 'suspended'] as const) {
      expect(canArchive(s, 'merged')).toBe(false);
    }
    expect(canArchive('idle', undefined)).toBe(false);
    expect(canArchive('idle', 'in_progress')).toBe(false);
    for (const t of ['suspended_budget', 'suspended_limit', 'blocked', 'needs_user', 'recovering']) expect(canArchive('finished', t)).toBe(false);
  });
});

describe('archiveAgent / unarchiveAgent', () => {
  it('archives an idle agent with a delivered ticket and un-archives it again', () => {
    start('a');
    registry.onModEvent('a', { type: 'turn.complete', sessionId: 's' });
    tickets.setChecklist('a', []);
    tickets.move('a', 'delivered');
    expect(archiveAgent({ registry, ticketStatus: (s) => tickets.get(s)?.status }, 'a')).toEqual({ ok: true });
    expect(registry.get('a')?.archived).toBe(true);
    expect(unarchiveAgent({ registry }, 'a')).toEqual({ ok: true });
    expect(registry.get('a')?.archived).toBeFalsy();
  });
  it('refuses with a code: unknown name, the main, and an agent that is not finished-like', () => {
    registry.register({ slug: 'main', role: 'main', profile: 'main' });
    start('w');
    registry.onModEvent('w', { type: 'turn.start', sessionId: 's' });
    const d = { registry, ticketStatus: () => undefined };
    expect(archiveAgent(d, 'nobody')).toEqual({ ok: false, code: 'not_found' });
    expect(archiveAgent(d, 'main')).toEqual({ ok: false, code: 'agent.notArchivable' });
    expect(archiveAgent(d, 'w')).toEqual({ ok: false, code: 'agent.notArchivable' });
    expect(unarchiveAgent({ registry }, 'nobody')).toEqual({ ok: false, code: 'not_found' });
  });
});

describe('deleteArchived / deleteAllArchived', () => {
  const finish = (slug: string): void => { start(slug); registry.markFinished(slug); registry.onProcessExit(slug); };
  it('deletes an archived agent through forget, and refuses the unknown, the main and one that is not archived', async () => {
    registry.register({ slug: 'main', role: 'main', profile: 'main' });
    finish('a');
    start('w');
    const forgotten: string[] = [];
    const d = { registry, forget: async (s: string) => { forgotten.push(s); registry.remove(s); } };
    expect(await deleteArchived(d, 'nobody')).toEqual({ ok: false, code: 'not_found' });
    expect(await deleteArchived(d, 'main')).toEqual({ ok: false, code: 'agent.notArchived' });
    expect(await deleteArchived(d, 'w')).toEqual({ ok: false, code: 'agent.notArchived' });
    expect(await deleteArchived(d, 'a')).toEqual({ ok: true });
    expect(forgotten).toEqual(['a']);
    expect(registry.get('a')).toBeUndefined();
    expect(registry.get('w')).toBeDefined();
  });
  it('"delete all" takes only the archived ones', async () => {
    finish('a'); finish('b'); start('w');
    const d = { registry, forget: async (s: string) => { registry.remove(s); } };
    expect(await deleteAllArchived(d)).toEqual({ count: 2, slugs: ['a', 'b'] });
    expect(registry.list().map((x) => x.slug)).toEqual(['w']);
    expect(await deleteAllArchived(d)).toEqual({ count: 0, slugs: [] });
  });
});

describe('persistence', () => {
  it('the persister writes archived and archivedAt, and clears them when the agent is revived', () => {
    const patches: AgentPatch[] = [];
    const persister = new AgentPersister({ registry, updateAgent: (_s, p) => { patches.push(p); }, writeMainSession: () => undefined, mainSlug: 'main', minIntervalMs: 0 });
    registry.on((s) => persister.onChange(s));
    start('a');
    registry.markFinished('a');
    registry.onProcessExit('a');
    const last = patches[patches.length - 1]!;
    expect(last).toMatchObject({ lastState: 'finished', archived: true });
    expect(typeof last.archivedAt).toBe('string');
    registry.revive('a');
    const after = patches[patches.length - 1]!;
    expect(after).toHaveProperty('archived', undefined);
    expect(after).toHaveProperty('archivedAt', undefined);
  });
  const rec = (slug: string, o: Partial<AgentRecord> = {}): AgentRecord => ({ slug, profile: 'developer', createdAt: '2026-10-05T10:00:00Z', role: 'agent', sessionId: `sess-${slug}`, lastState: 'idle', ...o });
  const run = (records: AgentRecord[]) => restoreAgents({ records, registry, tickets, worktrees: false, cleanStop: true, worktreeExists: () => true, abandonReview: () => false });
  it('a restored agent that was archived stays archived; one that was not stays visible', () => {
    tickets.setChecklist('kept', []); tickets.move('kept', 'delivered');
    run([rec('kept', { archived: true, archivedAt: '2026-10-09T08:00:00Z' }), rec('other')]);
    expect(registry.get('kept')).toMatchObject({ state: 'dormant', archived: true, archivedAt: '2026-10-09T08:00:00Z' });
    expect(registry.get('other')?.archived).toBeFalsy();
  });
  it('an agent whose ticket waits for a decision is restored finished and visible even if a stale flag is on its record', () => {
    tickets.setChecklist('s', []); tickets.move('s', 'suspended_budget');
    run([rec('s', { archived: true })]);
    expect(registry.get('s')).toMatchObject({ state: 'finished' });
    expect(registry.get('s')?.archived).toBeFalsy();
  });
  it('restore leaves no closed agent in the column: reviewers and merged developers are not brought back, stopped finishes stay visible', () => {
    tickets.setChecklist('m', []); for (const st of ['delivered', 'in_review', 'approved', 'merged'] as const) tickets.move('m', st);
    tickets.setChecklist('b', []); tickets.move('b', 'blocked');
    run([rec('m'), rec('rv', { role: 'reviewer', profile: 'reviewer' }), rec('b')]);
    expect(registry.get('m')).toBeUndefined();
    expect(registry.get('rv')).toBeUndefined();
    expect(registry.get('b')).toMatchObject({ state: 'finished' });
    expect(registry.get('b')?.archived).toBeFalsy();
  });
  it('waking a restored archived agent un-archives it', () => {
    tickets.setChecklist('k', []); tickets.move('k', 'delivered');
    run([rec('k', { archived: true })]);
    registry.revive('k');
    expect(registry.get('k')?.archived).toBeFalsy();
  });
});

describe('archiveFinished', () => {
  it('archives every archivable agent at once, leaves the rest, and returns the slugs', () => {
    registry.register({ slug: 'main', role: 'main', profile: 'main' });
    for (const n of ['done', 'delivered', 'busy', 'waits']) start(n);
    registry.markFinished('done'); registry.onProcessExit('done'); registry.setArchived('done', false);
    registry.onModEvent('delivered', { type: 'turn.complete', sessionId: 's' });
    tickets.setChecklist('delivered', []); tickets.move('delivered', 'delivered');
    registry.onModEvent('busy', { type: 'turn.start', sessionId: 's' });
    registry.markFinished('waits'); registry.onProcessExit('waits'); registry.setArchived('waits', false);
    tickets.setChecklist('waits', []); tickets.move('waits', 'suspended_budget');
    const out = archiveFinished({ registry, ticketStatus: (s) => { try { return tickets.get(s)?.status; } catch { return undefined; } } });
    expect(out.slugs.sort()).toEqual(['delivered', 'done']);
    expect(out.count).toBe(2);
    expect(registry.get('busy')?.archived).toBeFalsy();
    expect(registry.get('waits')?.archived).toBeFalsy();
    expect(registry.get('main')?.archived).toBeFalsy();
  });
  it('does nothing and counts zero when nothing is archivable', () => {
    expect(archiveFinished({ registry, ticketStatus: () => undefined })).toEqual({ count: 0, slugs: [] });
  });
});

describe('forced archive (the trash button)', () => {
  it('closes the session and archives an agent that is still "working", even if no process is left to exit', async () => {
    start('a');
    registry.onModEvent('a', { type: 'prompt.submit' } as never);
    let closed = 0;
    const out = await forceArchiveAgent({ registry, endSession: async () => { closed += 1; } }, 'a');
    expect(out).toEqual({ ok: true });
    expect(closed).toBe(1);
    expect(registry.get('a')).toMatchObject({ state: 'finished', archived: true });
  });
  it('archives even when closing the process fails', async () => {
    start('a');
    const out = await forceArchiveAgent({ registry, endSession: async () => { throw new Error('gone'); } }, 'a');
    expect(out).toEqual({ ok: true });
    expect(registry.get('a')).toMatchObject({ state: 'finished', archived: true });
  });
  it('refuses the main, an archived agent and an unknown name', async () => {
    registry.register({ slug: 'm', role: 'main', profile: 'main', goal: '' });
    start('b');
    registry.setArchived('b', true);
    const d = { registry, endSession: async () => undefined };
    expect(await forceArchiveAgent(d, 'm')).toEqual({ ok: false, code: 'agent.notArchivable' });
    expect(await forceArchiveAgent(d, 'b')).toEqual({ ok: false, code: 'agent.notArchivable' });
    expect(await forceArchiveAgent(d, 'zz')).toEqual({ ok: false, code: 'not_found' });
  });
});
