import { describe, it, expect } from 'vitest';
import { QuotaService, QuotaState, effectiveLimits, quotaStepFor, type QuotaDeps, type QuotaStep, type RateLimit } from '../src/server/budget/quota';

const Q = { halvePercent: 70, freezePercent: 85, stopPercent: 95, staggerSeconds: 60, staggerGroup: 2 };

describe('QuotaState', () => {
  it('keeps the worst limit and its reset time', () => {
    const s = new QuotaState(() => 123);
    s.update([{ kind: 'five_hour', percentUsed: 72, resetsAt: '2026-10-05T15:00:00Z' }, { kind: 'seven_day', percentUsed: 10 }]);
    expect(s.worst()).toEqual({ kind: 'five_hour', percent: 72, resetsAt: '2026-10-05T15:00:00Z' });
    expect(s.all()).toHaveLength(2);
    expect(s.updatedAt()).toBe(123);
  });
  it('has no worst (n/a) when nothing valid was ever reported, never zero', () => {
    for (const bad of [undefined, null, [], 'x', {}, [{ kind: 'five_hour', percentUsed: 'x' }], [{ kind: 'five_hour', percentUsed: -5 }], [{ kind: 'nope', percentUsed: 5 }], [null, 3]]) {
      const s = new QuotaState();
      s.update(bad);
      expect(s.worst(), JSON.stringify(bad)).toBeUndefined();
      expect(s.all()).toEqual([]);
      expect(s.updatedAt()).toBeUndefined();
    }
  });
  it('clamps a value above 100 to 100 and drops an unparseable resetsAt', () => {
    const s = new QuotaState();
    s.update([{ kind: 'seven_day', percentUsed: 500, resetsAt: 'not a date' }]);
    expect(s.worst()).toEqual({ kind: 'seven_day', percent: 100 });
  });
  it('drops only the malformed entries', () => {
    const s = new QuotaState();
    s.update([{ kind: 'five_hour', percentUsed: -5 }, { kind: 'spend_limit', percentUsed: 40 }, { kind: 'seven_day', percentUsed: Number.NaN }]);
    expect(s.all()).toEqual([{ kind: 'spend_limit', percentUsed: 40 }]);
  });
  it('the worst ignores a spend limit: only the five-hour and weekly windows count', () => {
    const s = new QuotaState();
    s.update([{ kind: 'spend_limit', percentUsed: 100 }, { kind: 'five_hour', percentUsed: 20 }]);
    expect(s.worst()).toEqual({ kind: 'five_hour', percent: 20 });
    s.update([{ kind: 'spend_limit', percentUsed: 90 }]);
    expect(s.worst()).toBeUndefined(); // n/a, never the spend limit
    expect(s.all()).toHaveLength(1);
  });
  it('an empty or fully invalid payload keeps the previous data', () => {
    const s = new QuotaState();
    s.update([{ kind: 'five_hour', percentUsed: 80 }]);
    s.update([]);
    s.update('x');
    s.update([{ kind: 'five_hour', percentUsed: 'x' }]);
    expect(s.worst()).toEqual({ kind: 'five_hour', percent: 80 });
  });
  it('a new valid payload replaces the old one', () => {
    const s = new QuotaState();
    s.update([{ kind: 'five_hour', percentUsed: 80 }]);
    s.update([{ kind: 'five_hour', percentUsed: 20 }]);
    expect(s.worst()?.percent).toBe(20);
  });
});

describe('quotaStepFor', () => {
  it('maps the percent to the step, unknown to none', () => {
    expect(quotaStepFor(undefined, Q)).toBe('none');
    expect(quotaStepFor(69, Q)).toBe('none');
    expect(quotaStepFor(70, Q)).toBe('halve');
    expect(quotaStepFor(84, Q)).toBe('halve');
    expect(quotaStepFor(85, Q)).toBe('freeze');
    expect(quotaStepFor(94, Q)).toBe('freeze');
    expect(quotaStepFor(95, Q)).toBe('stop');
    expect(quotaStepFor(100, Q)).toBe('stop');
  });
  it('honours a custom configuration', () => {
    const c = { ...Q, halvePercent: 50, freezePercent: 60, stopPercent: 90 };
    expect(quotaStepFor(49, c)).toBe('none');
    expect(quotaStepFor(50, c)).toBe('halve');
    expect(quotaStepFor(60, c)).toBe('freeze');
    expect(quotaStepFor(90, c)).toBe('stop');
  });
});

describe('effectiveLimits', () => {
  it('halves rounding up, freezes to zero, leaves none alone', () => {
    expect(effectiveLimits({ global: 4, perProject: 3 }, 'halve')).toEqual({ global: 2, perProject: 2 });
    expect(effectiveLimits({ global: 3, perProject: 3 }, 'halve')).toEqual({ global: 2, perProject: 2 });
    expect(effectiveLimits({ global: 4, perProject: 3 }, 'freeze')).toEqual({ global: 0, perProject: 0 });
    expect(effectiveLimits({ global: 4, perProject: 3 }, 'stop')).toEqual({ global: 0, perProject: 0 });
    expect(effectiveLimits({ global: 4, perProject: 3 }, 'none')).toEqual({ global: 4, perProject: 3 });
  });
});

type Role = 'main' | 'agent' | 'reviewer' | 'recovery';

function harness(opts: { agents?: { slug: string; role: Role; priority: number }[]; failWip?: string; failSuspend?: string } = {}) {
  const log: string[] = [];
  const applied: QuotaStep[] = [];
  const main: string[] = [];
  const told: [string, string][] = [];
  const reached: [string | undefined, RateLimit['kind']][] = [];
  const agents = opts.agents ?? [
    { slug: 'main-project', role: 'main' as const, priority: 100 },
    { slug: 'old', role: 'agent' as const, priority: 3 },
    { slug: 'mid', role: 'agent' as const, priority: 2 },
    { slug: 'new', role: 'agent' as const, priority: 1 },
  ];
  const deps: QuotaDeps = {
    state: new QuotaState(), config: () => Q,
    tellMain: (t) => { main.push(t); log.push('tellMain'); },
    tellAgent: (s, t) => { told.push([s, t]); },
    agents: () => agents,
    wipCommit: async (s) => { log.push(`wip ${s}`); if (s === opts.failWip) throw new Error('boom'); return { ok: true }; },
    restrict: (s, r) => { log.push(`restrict ${s} ${r.reason}`); },
    clearRestriction: (s) => { log.push(`clear ${s}`); },
    suspendForLimit: async (s) => { log.push(`suspend ${s}`); if (s === opts.failSuspend) throw new Error('stuck'); },
    applyLimits: (st) => { applied.push(st); },
    onLimitReached: (r, k) => { reached.push([r, k]); },
    changed: () => { log.push('changed'); },
  };
  return { svc: new QuotaService(deps), log, applied, main, told, reached };
}
const five = (p: number, resetsAt?: string) => [{ kind: 'five_hour', percentUsed: p, ...(resetsAt ? { resetsAt } : {}) }];

describe('QuotaService', () => {
  it('does nothing below the first threshold', async () => {
    const h = harness();
    await h.svc.onQuota(five(60));
    expect(h.svc.step()).toBe('none');
    expect(h.applied).toEqual([]);
    expect(h.main).toEqual([]);
  });
  it('halve: tells the main once and applies the step once', async () => {
    const h = harness();
    await h.svc.onQuota(five(72));
    expect(h.svc.step()).toBe('halve');
    expect(h.applied).toEqual(['halve']);
    expect(h.main).toHaveLength(1);
    await h.svc.onQuota(five(72));
    await h.svc.onQuota(five(75));
    expect(h.applied).toEqual(['halve']);
    expect(h.main).toHaveLength(1);
  });
  it('freeze: applies the step and tells each active agent once (never the main)', async () => {
    const h = harness();
    await h.svc.onQuota(five(72));
    await h.svc.onQuota(five(88));
    expect(h.applied).toEqual(['halve', 'freeze']);
    expect(h.told.map(([s]) => s).sort()).toEqual(['mid', 'new', 'old']);
    await h.svc.onQuota(five(90));
    expect(h.told).toHaveLength(3);
  });
  it('stop: restrict, then wipCommit, then suspend, in ascending priority, the main told but never suspended or restricted', async () => {
    const h = harness();
    await h.svc.onQuota(five(96));
    expect(h.svc.step()).toBe('stop');
    expect(h.applied).toEqual(['stop']);
    const stops = h.log.filter((l) => /^(wip|restrict|suspend) /.test(l));
    expect(stops).toEqual([
      'restrict new limit', 'wip new', 'suspend new',
      'restrict mid limit', 'wip mid', 'suspend mid',
      'restrict old limit', 'wip old', 'suspend old',
    ]);
    expect(h.log.join('|')).not.toContain('main-project');
    expect(h.main).toHaveLength(1);
    await h.svc.onQuota(five(97));
    expect(h.log.filter((l) => l.startsWith('suspend'))).toHaveLength(3);
  });
  it('stop: a reviewer is restricted and ended without a WIP commit', async () => {
    const h = harness({ agents: [{ slug: 'm', role: 'main', priority: 9 }, { slug: 'rev', role: 'reviewer', priority: 1 }] });
    await h.svc.onQuota(five(96));
    expect(h.log.filter((l) => /^(wip|restrict|suspend) /.test(l))).toEqual(['restrict rev limit', 'suspend rev']);
  });
  it('stop: a failing effect is told to the main once and the rest carries on', async () => {
    const h = harness({ failWip: 'new', failSuspend: 'mid' });
    await h.svc.onQuota(five(96));
    const suspended = h.log.filter((l) => l.startsWith('suspend'));
    expect(suspended).toEqual(['suspend new', 'suspend mid', 'suspend old']);
    expect(h.main).toHaveLength(3); // the step itself, plus one report for new and one for mid
    expect(h.main.filter((t) => /failed/.test(t))).toHaveLength(2);
  });
  it('at 100 the limit is exhausted: onLimitReached gets the reset time, once per kind and reset', async () => {
    const h = harness();
    await h.svc.onQuota(five(100, '2026-10-05T15:00:00Z'));
    expect(h.reached).toEqual([['2026-10-05T15:00:00Z', 'five_hour']]);
    await h.svc.onQuota(five(100, '2026-10-05T15:00:00Z'));
    expect(h.reached).toHaveLength(1);
    await h.svc.onQuota(five(100, '2026-10-05T20:00:00Z'));
    expect(h.reached).toHaveLength(2);
  });
  it('a drop below the first threshold lifts the step and the limit restrictions', async () => {
    const h = harness();
    await h.svc.onQuota(five(96));
    h.log.length = 0;
    await h.svc.onQuota(five(40));
    expect(h.svc.step()).toBe('none');
    expect(h.applied.at(-1)).toBe('none');
    expect(h.log).toContain('clear old');
    expect(h.log).not.toContain('clear main-project');
  });
  it('a drop that stays above the first threshold comes down to the step the reading says', async () => {
    const h = harness();
    await h.svc.onQuota(five(88));
    await h.svc.onQuota(five(75));
    expect(h.svc.step()).toBe('halve');
    expect(h.applied).toEqual(['freeze', 'halve']);
    expect(h.main.at(-1)).toContain('resume_agent');
  });
  it('after a stop, a reading with the five-hour window reset and the weekly one at 76% comes down to halve (not stop for ever)', async () => {
    const h = harness();
    await h.svc.onQuota(five(96));
    h.log.length = 0;
    await h.svc.onQuota([{ kind: 'five_hour', percentUsed: 2 }, { kind: 'seven_day', percentUsed: 76 }]);
    expect(h.svc.step()).toBe('halve');
    expect(h.applied.at(-1)).toBe('halve');
    expect(h.log).toContain('clear old'); // launches are allowed again: the limit restrictions go
    expect(h.main.at(-1)).toContain('mcp__andromeda-mcp__resume_agent');
  });
  it('a stop that comes down to freeze keeps the restrictions and still admits no launch', async () => {
    const h = harness();
    await h.svc.onQuota(five(96));
    h.log.length = 0;
    await h.svc.onQuota(five(88));
    expect(h.svc.step()).toBe('freeze');
    expect(h.applied.at(-1)).toBe('freeze');
    expect(h.log.filter((l) => l.startsWith('clear'))).toEqual([]);
  });
  it('the 95% stop with a known reset time starts the sleep once; without a time it does not', async () => {
    const h = harness();
    await h.svc.onQuota(five(96, '2026-10-05T15:00:00Z'));
    expect(h.reached).toEqual([['2026-10-05T15:00:00Z', 'five_hour']]);
    await h.svc.onQuota(five(100, '2026-10-05T15:00:00Z')); // the same window and reset at 100%: not a new one
    expect(h.reached).toHaveLength(1);
    const n = harness();
    await n.svc.onQuota(five(96));
    await n.svc.onQuota(five(99));
    expect(n.reached).toEqual([]);
  });
  it('every window at or above the stop threshold is reported, not only the worst', async () => {
    const h = harness();
    await h.svc.onQuota([{ kind: 'seven_day', percentUsed: 96, resetsAt: '2026-10-08T00:00:00Z' }, { kind: 'five_hour', percentUsed: 97, resetsAt: '2026-10-05T15:00:00Z' }]);
    expect(h.reached.map(([, k]) => k).sort()).toEqual(['five_hour', 'seven_day']);
  });
  it('a spend limit drives neither the steps nor the sleep (it stays in the readings for display)', async () => {
    const h = harness();
    await h.svc.onQuota([{ kind: 'spend_limit', percentUsed: 100, resetsAt: '2026-10-05T15:00:00Z' }, { kind: 'five_hour', percentUsed: 20 }]);
    expect(h.svc.step()).toBe('none');
    expect(h.reached).toEqual([]);
    expect(h.applied).toEqual([]);
  });
  it('a malformed payload after a stop changes nothing (unknown never lowers the step)', async () => {
    const h = harness();
    await h.svc.onQuota(five(96));
    const before = h.applied.length;
    await h.svc.onQuota(undefined);
    await h.svc.onQuota([]);
    await h.svc.onQuota([{ kind: 'five_hour', percentUsed: 'x' }]);
    expect(h.svc.step()).toBe('stop');
    expect(h.applied).toHaveLength(before);
  });
  it('never rejects even when a dependency throws', async () => {
    const h = harness();
    (h.svc as unknown as { d: QuotaDeps }).d.applyLimits = () => { throw new Error('x'); };
    await expect(h.svc.onQuota(five(72))).resolves.toBeUndefined();
  });
});
