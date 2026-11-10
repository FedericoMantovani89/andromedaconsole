import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoopDetector } from '../src/server/budget/loop-detector';
import { LoopService, type LoopDeps } from '../src/server/budget/loop-service';
import { Restrictions } from '../src/server/budget/restrictions';
import type { TranscriptEvent } from '../src/server/claude-code/transcript';
import { callSignature } from '../src/server/guard/rules';
import { DEFAULT_CONFIG } from '../src/server/config';
import { TicketStore } from '../src/server/tickets/store';

const MINUTE = 60_000;

const call = (command: string, id = 'x'): TranscriptEvent => ({ kind: 'tool_use', id, name: 'Bash', input: { command } });
const repeat = (n: number, command = 'npm test'): TranscriptEvent[] => Array.from({ length: n }, (_, i) => call(command, `c${i}`));

function rig(o: { restrictThrows?: boolean; stopThrows?: boolean; wip?: { ok: true } | { ok: false; detail: string }; alive?: boolean; onWip?: (tickets: TicketStore) => void; isWorking?: (slug: string) => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'h-loop-'));
  const tickets = new TicketStore(dir);
  tickets.setChecklist('a', [{ n: 1, title: 'x', done: false }] as never);
  let now = 1_000_000;
  const detector = new LoopDetector(() => DEFAULT_CONFIG.budget.loop, () => now);
  const restrictions = new Restrictions();
  const agent: string[] = [];
  const mains: string[] = [];
  const calls: string[] = [];
  let working: string[] = ['a'];
  const d: LoopDeps = {
    detector, tickets,
    tellAgent: (_s, t) => { agent.push(t); calls.push('agent'); },
    tellMain: (t) => { mains.push(t); calls.push('main'); },
    restrict: (slug, r) => {
      if (o.restrictThrows) throw new Error('restrict boom');
      restrictions.set(slug, r);
      calls.push('restrict');
    },
    clearRestriction: (slug) => { if (restrictions.get(slug)?.reason === 'loop') restrictions.clear(slug); },
    wipCommit: async (_s, reason) => { calls.push(`wip:${reason}`); o.onWip?.(tickets); return o.wip ?? { ok: true }; },
    stop: async () => { calls.push('stop'); if (o.stopThrows) throw new Error('stop boom'); },
    workingSlugs: () => working,
    ...(o.isWorking ? { isWorking: o.isWorking } : {}),
    processAlive: () => o.alive ?? true,
    changed: () => { calls.push('changed'); },
  };
  const svc = new LoopService(d);
  return {
    svc, tickets, restrictions, agent, mains, calls, detector,
    advance: (ms: number) => { now += ms; },
    setWorking: (w: string[]) => { working = w; },
  };
}

/** One burst: a different call first (so an earlier burst's signal clears), then five identical ones. */
const burst = async (r: ReturnType<typeof rig>, command = 'npm test', mark = 'ls'): Promise<void> => {
  await r.svc.onEvents('a', [call(mark, 'mark')]);
  await r.svc.onEvents('a', repeat(5, command));
};

describe('LoopService steps', () => {
  it('level 1: five identical calls tell the agent and the main once each', async () => {
    const r = rig();
    await r.svc.onEvents('a', repeat(5));
    expect(r.svc.level('a')).toBe(1);
    expect(r.agent).toHaveLength(1);
    expect(r.agent[0]).toContain('report_blocked');
    expect(r.mains).toHaveLength(1);
    expect(r.calls).not.toContain('restrict');
    expect(r.calls).not.toContain('stop');
  });

  it('under the threshold nothing happens', async () => {
    const r = rig();
    await r.svc.onEvents('a', repeat(4));
    expect(r.svc.level('a')).toBe(0);
    expect(r.agent).toEqual([]);
    expect(r.mains).toEqual([]);
  });

  it('level 2: a second burst restricts exactly the repeated call', async () => {
    const r = rig();
    await r.svc.onEvents('a', repeat(5));
    await burst(r);
    expect(r.svc.level('a')).toBe(2);
    expect(r.restrictions.get('a')).toEqual({ reason: 'loop', signature: callSignature('Bash', { command: 'npm test' }) });
    expect(r.agent).toHaveLength(2);
    expect(r.mains).toHaveLength(2);
    expect(r.calls).not.toContain('stop');
  });

  it('level 3: a third burst commits, marks the ticket blocked, stops and names start_recovery to the main', async () => {
    const r = rig();
    await r.svc.onEvents('a', repeat(5));
    await burst(r);
    await burst(r);
    expect(r.svc.level('a')).toBe(3);
    expect(r.calls).toContain('wip:loop stop');
    expect(r.calls.indexOf('wip:loop stop')).toBeLessThan(r.calls.indexOf('stop'));
    expect(r.tickets.get('a')?.status).toBe('blocked');
    expect(r.tickets.get('a')?.stopCause).toBe('loop');
    expect(r.calls).toContain('stop');
    expect(r.calls).not.toContain('recovery'); // started by the main, never automatically
    const last = r.mains[r.mains.length - 1]!;
    expect(last).toContain('mcp__andromeda-mcp__start_recovery');
    expect(last).toContain('name a');
  });

  it('onStepDone drops the level to 0 and clears a loop restriction', async () => {
    const r = rig();
    await r.svc.onEvents('a', repeat(5));
    await burst(r);
    expect(r.restrictions.get('a')?.reason).toBe('loop');
    r.svc.onStepDone('a');
    expect(r.svc.level('a')).toBe(0);
    expect(r.restrictions.get('a')).toBeUndefined();
  });

  it('onStepDone never lifts a budget restriction', async () => {
    const r = rig();
    await r.svc.onEvents('a', repeat(5));
    await burst(r);
    r.restrictions.set('a', { reason: 'budget' }); // the stronger one replaces the loop one
    r.svc.onStepDone('a');
    expect(r.svc.level('a')).toBe(0);
    expect(r.restrictions.get('a')).toEqual({ reason: 'budget' });
  });

  it('a coarse finding (no discriminating key) does not restrict: it only warns again', async () => {
    const r = rig();
    const grep = (n: number): TranscriptEvent[] => Array.from({ length: n }, (_, i) => ({ kind: 'tool_use', id: `g${i}`, name: 'Grep', input: { pattern: 'x' } }));
    await r.svc.onEvents('a', grep(5));
    await r.svc.onEvents('a', [call('ls', 'mark')]);
    await r.svc.onEvents('a', grep(5));
    expect(r.svc.level('a')).toBe(2);
    expect(r.restrictions.get('a')).toBeUndefined();
    expect(r.calls).not.toContain('restrict');
    expect(r.agent).toHaveLength(2);
    expect(r.mains).toHaveLength(2);
  });

  it('a ticket that is not in_progress is ignored: no effects, no level', async () => {
    const r = rig();
    r.tickets.move('a', 'delivered');
    await r.svc.onEvents('a', repeat(5));
    expect(r.svc.level('a')).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it('an agent without a ticket is ignored', async () => {
    const r = rig();
    await r.svc.onEvents('nobody', repeat(5));
    expect(r.svc.level('nobody')).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it('same_error from the transcript also escalates', async () => {
    const r = rig();
    const err = (i: number): TranscriptEvent => ({ kind: 'tool_result', toolUseId: `e${i}`, isError: true, text: 'ENOENT: no such file' });
    await r.svc.onEvents('a', [err(1), err(2), err(3)]);
    expect(r.svc.level('a')).toBe(1);
    expect(r.agent[0]).toContain('same error');
  });

  it('a failing effect does not skip the rest, and is told to the main once', async () => {
    const r = rig({ restrictThrows: true });
    await r.svc.onEvents('a', repeat(5));
    await burst(r); // level 2: restrict throws
    expect(r.svc.level('a')).toBe(2);
    expect(r.agent).toHaveLength(2); // the warning still went out
    const failures = r.mains.filter((t) => t.includes('failed'));
    expect(failures).toHaveLength(1);
    await burst(r); // level 3
    expect(r.svc.level('a')).toBe(3);
    expect(r.calls).toContain('stop');
  });

  it('level 3 stops even when the WIP commit is refused, and tells the main why', async () => {
    const r = rig({ wip: { ok: false, detail: 'merging: a merge is in progress' } });
    await r.svc.onEvents('a', repeat(5));
    await burst(r);
    await burst(r);
    expect(r.mains.some((t) => t.includes('WIP commit') && t.includes('merging'))).toBe(true);
    expect(r.calls).toContain('stop');
    expect(r.tickets.get('a')?.status).toBe('blocked');
  });

  it('level 3 still moves the ticket and tells the main when stop throws', async () => {
    const r = rig({ stopThrows: true });
    await r.svc.onEvents('a', repeat(5));
    await burst(r);
    await burst(r);
    expect(r.tickets.get('a')?.status).toBe('blocked');
    expect(r.mains[r.mains.length - 1]).toContain('start_recovery');
  });
});

describe('LoopService time signals', () => {
  it('silence only tells the main and leaves the level untouched', () => {
    const r = rig();
    r.detector.onModEvent('a');
    r.advance(6 * MINUTE);
    r.svc.tick();
    expect(r.mains).toHaveLength(1);
    expect(r.agent).toEqual([]);
    expect(r.svc.level('a')).toBe(0);
    expect(r.calls).not.toContain('stop');
    r.svc.tick(); // fires once
    expect(r.mains).toHaveLength(1);
  });

  it('no_step only tells the main', () => {
    const r = rig();
    r.detector.onModEvent('a'); // the agent's clock starts here
    r.advance(31 * MINUTE);
    r.detector.onModEvent('a'); // not silent, only slow
    r.svc.tick();
    expect(r.mains).toHaveLength(1);
    expect(r.mains[0]).toContain('no step finished');
    expect(r.svc.level('a')).toBe(0);
  });

  it('an agent that is not working (waiting for the user) never produces a time finding', () => {
    const r = rig();
    r.setWorking([]);
    r.advance(40 * MINUTE);
    r.svc.tick();
    expect(r.mains).toEqual([]);
  });

  it('a ticket that is not in_progress produces no time finding', () => {
    const r = rig();
    r.tickets.move('a', 'delivered');
    r.advance(40 * MINUTE);
    r.svc.tick();
    expect(r.mains).toEqual([]);
  });
});

describe('LoopService fix wave', () => {
  it('a loop that goes on without a break escalates: 15 identical calls over three turns end at level 3', async () => {
    const r = rig();
    for (let i = 0; i < 3; i++) await r.svc.onEvents('a', repeat(5));
    expect(r.svc.level('a')).toBe(3);
    expect(r.calls).toContain('stop');
    expect(r.tickets.get('a')?.status).toBe('blocked');
  });

  it('a skipped step or one whose commit changed nothing does not reset the level nor lift the restriction', async () => {
    const r = rig();
    await r.svc.onEvents('a', repeat(5));
    await burst(r);
    expect(r.restrictions.get('a')?.reason).toBe('loop');
    r.svc.onStepDone('a', { skipped: true, empty: false });
    expect(r.svc.level('a')).toBe(2);
    expect(r.restrictions.get('a')?.reason).toBe('loop');
    r.svc.onStepDone('a', { skipped: false, empty: true });
    expect(r.svc.level('a')).toBe(2);
    expect(r.restrictions.get('a')?.reason).toBe('loop');
    r.svc.onStepDone('a', { skipped: false, empty: false });
    expect(r.svc.level('a')).toBe(0);
    expect(r.restrictions.get('a')).toBeUndefined();
  });

  it('a silence is told with the state of the process: alive (nothing done) or no longer running', () => {
    const alive = rig({ alive: true });
    alive.detector.onModEvent('a');
    alive.advance(6 * MINUTE);
    alive.svc.tick();
    expect(alive.mains).toHaveLength(1);
    expect(alive.mains[0]).toMatch(/process is alive/);
    alive.svc.tick();
    expect(alive.mains).toHaveLength(1); // one notice per silence
    const dead = rig({ alive: false });
    dead.detector.onModEvent('a');
    dead.advance(6 * MINUTE);
    dead.svc.tick();
    expect(dead.mains[0]).toMatch(/no longer running/);
  });

  it('a ticket the budget stopped meanwhile keeps its own cause: the loop stop neither blocks it nor marks it a loop', async () => {
    const r = rig({
      onWip: (tickets) => {
        if (tickets.get('a')?.status !== 'in_progress') return;
        tickets.setStopCause('a', 'budget');
        tickets.move('a', 'suspended_budget');
      },
    });
    for (let i = 0; i < 3; i++) await r.svc.onEvents('a', repeat(5));
    expect(r.tickets.get('a')).toMatchObject({ status: 'suspended_budget', stopCause: 'budget' });
  });

  it('forget drops the level of an agent whose process ended', async () => {
    const r = rig();
    await r.svc.onEvents('a', repeat(5));
    expect(r.svc.level('a')).toBe(1);
    r.svc.forget('a');
    expect(r.svc.level('a')).toBe(0);
  });
});

describe('LoopService.silentFor', () => {
  it('uses isWorking when the host provides it, so a reviewer or recovery session is covered too', () => {
    const r = rig({ isWorking: (s) => s === 'reviewer-x' });
    r.detector.onModEvent('reviewer-x');
    r.advance(7 * MINUTE);
    expect(r.svc.silentFor('reviewer-x')).toBe(7);
    expect(r.svc.silentFor('a')).toBeUndefined(); // in workingSlugs, but isWorking says no
  });
  it('reports the silence of a working agent only; a waiting one (not working) is not silent', () => {
    const r = rig();
    r.detector.onModEvent('a');
    r.detector.onModEvent('b');
    r.advance(7 * MINUTE);
    expect(r.svc.silentFor('a')).toBe(7);
    expect(r.svc.silentFor('b')).toBeUndefined(); // 'b' is not in workingSlugs()
    r.setWorking([]);
    expect(r.svc.silentFor('a')).toBeUndefined();
  });
});
