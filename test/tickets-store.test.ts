import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateChecklist, type Step } from '../src/server/tickets/checklist';
import { TicketStore } from '../src/server/tickets/store';
import { removeDir } from './git-helpers';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tickets-')); });
afterEach(() => removeDir(root));

const steps = (): Step[] => {
  const r = validateChecklist(['Study', 'Tests first', 'Implement a', 'Implement b', 'Validation', 'Update docs']);
  if (!r.ok) throw new Error(r.code);
  return r.steps;
};
const dir = (): string => join(root, '.andromedaconsole', 'state', 'tickets');

describe('TicketStore', () => {
  it('has nothing for an unknown ticket', () => {
    const s = new TicketStore(root);
    expect(s.get('a')).toBeUndefined();
    expect(s.progress('a')).toBeUndefined();
  });
  it('persists a checklist across re-creation', () => {
    new TicketStore(root).setChecklist('a', steps());
    const again = new TicketStore(root).get('a');
    expect(again?.steps).toHaveLength(6);
    expect(again?.status).toBe('in_progress');
    expect(new TicketStore(root).progress('a')).toEqual({ done: 0, total: 6, blocked: false, status: 'in_progress' });
  });
  it('writes atomically: no temp files are left behind', () => {
    const s = new TicketStore(root);
    s.setChecklist('a', steps());
    s.markDone('a', 1, { note: 'found it' });
    expect(readdirSync(dir())).toEqual(['a.json']);
    expect(() => JSON.parse(readFileSync(join(dir(), 'a.json'), 'utf8'))).not.toThrow();
  });
  it('markDone closes steps in order and records note, sha, skipped', () => {
    const s = new TicketStore(root);
    s.setChecklist('a', steps());
    s.markDone('a', 1, { note: 'n1', sha: 'abc' });
    s.markDone('a', 2, { skipped: true, note: 'merged into 3' });
    const st = s.get('a')!.steps;
    expect(st[0]).toMatchObject({ done: true, note: 'n1', sha: 'abc' });
    expect(st[1]).toMatchObject({ done: true, skipped: true });
    expect(s.progress('a')?.done).toBe(2);
  });
  it('markDone rejects a step that is not the next open one', () => {
    const s = new TicketStore(root);
    s.setChecklist('a', steps());
    expect(() => s.markDone('a', 2, {})).toThrow('step.out_of_order');
    s.markDone('a', 1, {});
    expect(() => s.markDone('a', 1, {})).toThrow('step.out_of_order');
    expect(() => s.markDone('a', 99, {})).toThrow('step.out_of_order');
    expect(() => s.markDone('a', 0, {})).toThrow('step.out_of_order');
    expect(s.progress('a')?.done).toBe(1);
  });
  it('markDone on a ticket without checklist throws ticket.missing', () => {
    expect(() => new TicketStore(root).markDone('nope', 1, {})).toThrow('ticket.missing');
  });
  it('blocks and unblocks, also before a checklist exists', () => {
    const s = new TicketStore(root);
    s.block('a', 'need the schema');
    expect(s.progress('a')).toMatchObject({ blocked: true, total: 0 });
    expect(s.get('a')?.blockedReason).toBe('need the schema');
    s.setChecklist('a', steps());
    expect(s.progress('a')?.blocked).toBe(true);
    s.unblock('a');
    expect(s.progress('a')?.blocked).toBe(false);
    expect(s.get('a')?.blockedReason).toBeUndefined();
  });
  it('move goes to delivered and keeps the delivered commit', () => {
    const s = new TicketStore(root);
    s.setChecklist('a', steps());
    s.move('a', 'delivered', { deliveredSha: 'abc' });
    expect(s.progress('a')?.status).toBe('delivered');
  });
  it('a re-set replaces the steps but keeps status and blocked flag', () => {
    const s = new TicketStore(root);
    s.setChecklist('a', steps());
    s.block('a', 'x');
    s.setChecklist('a', steps());
    expect(s.progress('a')).toMatchObject({ blocked: true, status: 'in_progress' });
  });
  it('rejects slugs that could leave the folder', () => {
    const s = new TicketStore(root);
    expect(() => s.setChecklist('../evil', steps())).toThrow();
    expect(() => s.get('a/b')).toThrow();
    expect(() => s.get('')).toThrow();
  });
  it('a damaged file reads as no ticket instead of crashing', () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), 'a.json'), '{not json');
    expect(new TicketStore(root).get('a')).toBeUndefined();
  });
});

describe('TicketStore suspension', () => {
  it('suspends, counts recoveries and restarts with the checklist kept', () => {
    const s = new TicketStore(root);
    s.setChecklist('a', [{ n: 1, title: 'one', done: true }, { n: 2, title: 'two', done: false }] as never);
    s.setBudget('a', { limit: 1000, step: 'stopped' });
    s.setStopCause('a', 'budget');
    s.move('a', 'suspended_budget');
    expect(s.get('a')).toMatchObject({ status: 'suspended_budget', stopCause: 'budget', recoveries: 0 });
    s.move('a', 'recovering');
    expect(s.addRecovery('a').recoveries).toBe(1);
    const t = s.restart('a');
    expect(t.status).toBe('in_progress');
    expect(t.stopCause).toBeUndefined();
    expect(t.steps).toHaveLength(2);
    expect(() => s.restart('a')).toThrow('ticket.badTransition');
  });
  it('restart drops a stale blocked reason, like reopen', () => {
    const s = new TicketStore(root);
    s.setChecklist('a', [{ n: 1, title: 'one', done: false }] as never);
    s.block('a', 'the API key is missing');
    s.move('a', 'blocked');
    const t = s.restart('a');
    expect(t.blocked).toBe(false);
    expect(t.blockedReason).toBeUndefined();
    expect(s.get('a')!.blockedReason).toBeUndefined();
  });
});

describe('TicketStore agent tests', () => {
  const claim = { command: 'npx vitest run test/a.test.ts', result: 'passed' as const };
  const write = (t: Record<string, unknown>): void => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), 'a.json'), JSON.stringify({ slug: 'a', steps: [{ n: 1, title: 'one', done: true }], blocked: false, updatedAt: '', round: 0, recoveries: 0, verdicts: [], ...t }));
  };
  it('a reopened ticket forgets the claim of the round before', () => {
    write({ status: 'changes_requested', agentTests: claim });
    expect(new TicketStore(root).reopen('a').agentTests).toBeUndefined();
    expect(new TicketStore(root).get('a')!.agentTests).toBeUndefined();
  });
  it('a restarted ticket forgets the claim of the agent that stopped', () => {
    write({ status: 'blocked', agentTests: claim });
    expect(new TicketStore(root).restart('a').agentTests).toBeUndefined();
  });
  it('a damaged claim on disk reads as no claim; a sound one is kept', () => {
    write({ status: 'delivered', agentTests: { command: 42, result: 'maybe' } });
    expect(new TicketStore(root).get('a')!.agentTests).toBeUndefined();
    write({ status: 'delivered', agentTests: 'passed' });
    expect(new TicketStore(root).get('a')!.agentTests).toBeUndefined();
    write({ status: 'delivered', agentTests: claim });
    expect(new TicketStore(root).get('a')!.agentTests).toEqual(claim);
  });
});

describe('TicketStore.rename', () => {
  it('moves the whole record to the new name: steps, recoveries, handover, budget, goal and status', () => {
    const s = new TicketStore(root);
    s.setChecklist('a', [{ n: 1, title: 'one', done: true, sha: 'abc' }, { n: 2, title: 'two', done: false }] as never);
    s.setGoal('a', 'Add multiply');
    s.setBudget('a', { limit: 1000, step: 'stopped' });
    s.setHandover('a', 'half done');
    s.move('a', 'suspended_budget');
    s.move('a', 'recovering');
    s.addRecovery('a');
    const before = s.get('a')!;
    const t = s.rename('a', 'a-r2');
    expect(t.slug).toBe('a-r2');
    expect(s.get('a')).toBeUndefined();
    expect(existsSync(join(dir(), 'a.json'))).toBe(false);
    const { updatedAt: _u1, slug: _s1, ...was } = before;
    const { updatedAt: _u2, slug: _s2, ...now } = s.get('a-r2')!;
    expect(now).toEqual(was);
  });
  it('refuses a missing source, a taken target and bad names, and changes nothing', () => {
    const s = new TicketStore(root);
    s.setChecklist('a', []);
    s.setChecklist('b', []);
    expect(() => s.rename('ghost', 'c')).toThrow('ticket.missing');
    expect(() => s.rename('a', 'b')).toThrow('ticket.exists');
    expect(() => s.rename('a', 'Bad Name')).toThrow('ticket.badSlug');
    expect(s.get('a')).toBeDefined();
    expect(s.get('b')).toBeDefined();
  });
});

describe('TicketStore.list', () => {
  it('lists every ticket, and ignores damaged files and strangers', () => {
    const s = new TicketStore(root);
    expect(s.list()).toEqual([]);
    s.setChecklist('a', steps());
    s.setChecklist('b', steps());
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), 'broken.json'), '{nope');
    writeFileSync(join(dir(), 'notes.txt'), 'hello');
    writeFileSync(join(dir(), 'Bad_Name.json'), '{}');
    expect(s.list().map((t) => t.slug).sort()).toEqual(['a', 'b']);
  });
});
