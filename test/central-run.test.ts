import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CentralRun, type CentralDeps, type CentralGit, type CentralTicket } from '../src/server/tickets/central';
import type { TestRun } from '../src/server/tickets/test-queue';
import { removeDir } from './git-helpers';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'central-')); });
afterEach(() => removeDir(dir));

const ok: TestRun = { ok: true, code: 0, tail: '' };
const red = (tail: string): TestRun => ({ ok: false, code: 1, tail });

interface Rig { c: CentralRun; deps: CentralDeps; tickets: CentralTicket[]; runs: { command: string; cwd: string; label: string; heavy: boolean }[]; told: string[]; asked: { text: string; payload: any; options: string[]; answer: (a: string) => void }[]; lockedDuringRun: boolean[]; main: string[]; marks: Map<string, unknown>; setTip(t: string): void; result: { v: TestRun }; reruns: string[]; merging: { n: number } }

function rig(o: { tickets: CentralTicket[]; touched?: Record<string, string[]>; alive?: boolean; mergeCommand?: string; rerun?: (sha: string) => boolean | undefined; command?: string | undefined }): Rig {
  const tickets = o.tickets;
  const runs: Rig['runs'] = [];
  const told: string[] = [];
  const asked: Rig['asked'] = [];
  const main: string[] = [];
  const marks = new Map<string, unknown>();
  const reruns: string[] = [];
  const result = { v: ok };
  const merging = { n: 0 };
  let tip = 'tip1';
  let locked = false;
  const lockedDuringRun: boolean[] = [];
  const git: CentralGit = {
    lock: async (_rel, fn) => { locked = true; try { return await fn(); } finally { locked = false; } },
    withCheckout: async (_rel, _sha, fn) => fn('P'),
    prepare: async () => ({ path: 'P', tip }),
    order: async (_rel, ts) => ts,
    touched: async (_rel, t) => o.touched?.[t.slug] ?? [],
    rerun: async (_rel, sha) => { reruns.push(sha); return o.rerun?.(sha); },
  };
  const deps: CentralDeps = {
    root: dir, project: 'p',
    tickets: { list: () => tickets, setCentral: (slug, c) => { marks.set(slug, c); const t = tickets.find((x) => x.slug === slug); if (t) t.central = { ...t.central, ...c }; } },
    command: () => ('command' in o ? o.command : 'full-suite'),
    mergeCommand: () => o.mergeCommand,
    timeoutMs: () => 1000, settleMs: 0, merging: () => merging.n, git,
    runTests: async (j) => { lockedDuringRun.push(locked); runs.push({ command: j.command, cwd: j.cwd, label: j.label, heavy: j.heavy }); return result.v; },
    authorAlive: () => o.alive === true,
    notifyAuthor: (slug, text) => { told.push(`${slug}: ${text}`); },
    notifyMain: (text) => { main.push(text); },
    askUser: (q, answer) => { asked.push({ ...q, answer }); },
  };
  return { c: new CentralRun(deps), deps, tickets, runs, told, asked, lockedDuringRun, main, marks, setTip: (t) => { tip = t; }, result, reruns, merging };
}

const merged = (slug: string, sha: string, extra: Partial<CentralTicket> = {}): CentralTicket => ({ slug, status: 'merged', mergedSha: sha, ...extra });

describe('CentralRun', () => {
  it('runs the release command once on the tip for the whole batch of merged tickets, through the queue as a heavy run', async () => {
    const r = rig({ tickets: [merged('a', 'sa'), merged('b', 'sb'), { slug: 'c', status: 'in_progress' }] });
    await r.c.runNow();
    expect(r.runs).toEqual([{ command: 'full-suite', cwd: 'P', label: 'central:p', heavy: true }]);
    const rec = r.c.record('')!;
    expect(rec).toMatchObject({ tip: 'tip1', command: 'full-suite', ok: true, tickets: ['a', 'b'] });
    expect(r.marks.get('a')).toMatchObject({ checkedTip: 'tip1' });
    expect(r.c.greenFor('', 'tip1', 'full-suite')).toBe(true);
    expect(r.c.greenFor('', 'tip2', 'full-suite')).toBe(false);
    expect(r.c.greenFor('', 'tip1', 'other')).toBe(false);
  });

  it('does not run twice on a tip it already checked, nor when there is nothing new', async () => {
    const r = rig({ tickets: [merged('a', 'sa')] });
    await r.c.runNow();
    await r.c.runNow();
    expect(r.runs).toHaveLength(1);
    r.tickets.push(merged('b', 'sb'));
    r.setTip('tip2');
    await r.c.runNow();
    expect(r.runs).toHaveLength(2);
    expect(r.c.record('')!.tickets).toEqual(['b']);
  });

  it('batches: after a merge it waits until no merge is in flight, then one run covers them all', async () => {
    const r = rig({ tickets: [merged('a', 'sa'), merged('b', 'sb')] });
    r.merging.n = 1;
    r.c.merged();
    await new Promise((x) => setTimeout(x, 30));
    expect(r.runs).toHaveLength(0);
    r.merging.n = 0;
    await new Promise((x) => setTimeout(x, 30));
    await r.c.idle();
    expect(r.runs).toHaveLength(1);
    expect(r.c.record('')!.tickets).toEqual(['a', 'b']);
  });

  it('does nothing when the tests are off (no command)', async () => {
    const r = rig({ tickets: [merged('a', 'sa')], command: undefined });
    await r.c.runNow();
    expect(r.runs).toHaveLength(0);
    expect(r.c.record('')).toBeUndefined();
  });

  it('with the tests inhibited it neither takes the project lock nor reads a repository\'s tip', async () => {
    const r = rig({ tickets: [merged('a', 'sa'), merged('b', 'sb', { repo: 'abc-be' })] });
    const touched: string[] = [];
    const git: CentralGit = { ...r.deps.git, lock: async (rel, fn) => { touched.push(`lock:${rel}`); return fn(); }, prepare: async (rel) => { touched.push(`prepare:${rel}`); return { path: 'P', tip: 'tip1' }; } };
    const c = new CentralRun({ ...r.deps, git, testsDisabled: () => true });
    await c.runNow();
    expect(touched).toEqual([]);
    expect(r.runs).toHaveLength(0);
  });

  it("asks for the command of the repository's project worktree, so a folder of several repositories finds each one's own", async () => {
    const r = rig({ tickets: [merged('a', 'sa')] });
    const asked: (string | undefined)[] = [];
    const c = new CentralRun({ ...r.deps, command: (cwd) => { asked.push(cwd); return cwd === 'P' ? 'mvn test' : undefined; } });
    await c.runNow();
    expect(asked).toEqual(['P']);
    expect(r.runs).toEqual([{ command: 'mvn test', cwd: 'P', label: 'central:p', heavy: true }]);
  });

  it('names the repository when it asks for the command (its own command, set in the options, comes first)', async () => {
    const r = rig({ tickets: [merged('a', 'sa', { repo: 'abc-be' })] });
    const asked: [string | undefined, string | undefined][] = [];
    const merges: [string | undefined, string | undefined][] = [];
    const c = new CentralRun({ ...r.deps, command: (cwd, repo) => { asked.push([cwd, repo]); return 'mvn -q test'; }, mergeCommand: (cwd, repo) => { merges.push([cwd, repo]); return undefined; } });
    await c.runNow();
    expect(asked).toEqual([['P', 'abc-be']]);
    expect(merges).toEqual([['P', 'abc-be']]);
  });

  it('runs the suite on a checkout of the tip, never while holding the project lock (a merge is not blocked by it)', async () => {
    const r = rig({ tickets: [merged('a', 'sa')] });
    await r.c.runNow();
    expect(r.lockedDuringRun).toEqual([false]);
  });

  it('after a red run no ticket of the batch is blamed again: the next merge brings a new batch', async () => {
    const r = rig({ tickets: [merged('a', 'sa'), merged('b', 'sb')], touched: { a: ['src/server/tickets/merge.ts'] } });
    r.result.v = red(' FAIL  test/merge-ticket.test.ts > merges\n');
    await r.c.runNow();
    expect(r.asked).toHaveLength(1);
    r.tickets.push(merged('c', 'sc'));
    r.setTip('tip2');
    r.result.v = ok;
    await r.c.runNow();
    expect(r.c.record('')!.tickets).toEqual(['c']);
    expect(r.asked).toHaveLength(1);
    expect(r.main.length).toBe(1);
  });

  it('does not ask the user again for a break that was already red before the new batch (same failing tests, red base)', async () => {
    const r = rig({ tickets: [merged('a', 'sa'), merged('b', 'sb')], touched: {}, rerun: () => false });
    r.result.v = red(' FAIL  test/x.test.ts > y\n');
    await r.c.runNow();
    expect(r.asked).toHaveLength(1);
    expect(r.c.record('')).toMatchObject({ undecided: 'base_red' });
    r.tickets.push(merged('c', 'sc'), merged('d', 'sd'));
    r.setTip('tip2');
    await r.c.runNow();
    expect(r.c.record('')).toMatchObject({ tip: 'tip2', ok: false });
    expect(r.asked).toHaveLength(1);
  });

  it('a console start covers merges nobody checked yet', async () => {
    const r = rig({ tickets: [merged('a', 'sa')] });
    r.c.start();
    await new Promise((x) => setTimeout(x, 60));
    await r.c.idle();
    expect(r.runs).toHaveLength(1);
    const none = rig({ tickets: [merged('a', 'sa', { central: { checkedTip: 'x' } })] });
    none.c.start();
    await new Promise((x) => setTimeout(x, 60));
    expect(none.runs).toHaveLength(0);
  });

  it('with one command for merge and release, the merge of the last ticket already tested the tip: no second run', async () => {
    const r = rig({ tickets: [merged('a', 'tip1')], mergeCommand: 'full-suite' });
    await r.c.runNow();
    expect(r.runs).toHaveLength(0);
    expect(r.c.record('')).toMatchObject({ ok: true, reusedMerge: true, tip: 'tip1' });
    expect(r.marks.get('a')).toMatchObject({ checkedTip: 'tip1' });
    const other = rig({ tickets: [merged('a', 'tip9')], mergeCommand: 'smoke' });
    other.setTip('tip9'); // a different merge command: the merge did not run the full suite
    await other.c.runNow();
    expect(other.runs).toHaveLength(1);
  });

  it('an author who is gone gets an actionable choice: a follow-up agent is requested from the main with the goal, the tests and the output', async () => {
    const r = rig({ tickets: [merged('a', 'sa')], touched: {} });
    r.result.v = red(' FAIL  test/x.test.ts > y\nAssertionError: boom\n');
    await r.c.runNow();
    expect(r.asked[0]!.options).toEqual(['follow_up', 'leave']);
    r.asked[0]!.answer('leave');
    expect(r.main).toHaveLength(1);
    r.asked[0]!.answer('follow_up');
    expect(r.main).toHaveLength(2);
    expect(r.main[1]).toContain('follow-up');
    expect(r.main[1]).toContain('test/x.test.ts');
    expect(r.main[1]).toContain('AssertionError: boom');
  });

  it('keeps the record across restarts', async () => {
    const r = rig({ tickets: [merged('a', 'sa')] });
    await r.c.runNow();
    const again = rig({ tickets: [merged('a', 'sa')] });
    expect(again.c.record('')).toMatchObject({ tip: 'tip1', ok: true });
  });

  it('red run: blames the ticket whose files match, tells the main and, with the author gone, puts one decision in the user queue', async () => {
    const r = rig({ tickets: [merged('a', 'sa'), merged('b', 'sb')], touched: { a: ['src/server/tickets/merge.ts'], b: ['src/ui/panels.ts'] } });
    r.result.v = red(' FAIL  test/merge-ticket.test.ts > merges\n');
    await r.c.runNow();
    const rec = r.c.record('')!;
    expect(rec).toMatchObject({ ok: false, culprit: 'a', by: 'files', failing: ['test/merge-ticket.test.ts'] });
    expect(r.marks.get('a')).toMatchObject({ red: { tip: 'tip1', tests: ['test/merge-ticket.test.ts'] } });
    expect(r.marks.get('b')).toEqual({ checkedTip: 'tip1' }); // handed over with the batch, never blamed again
    expect(r.reruns).toEqual([]);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]!.payload).toMatchObject({ ticket: 'a', reason: 'central_red_author_gone', failing: ['test/merge-ticket.test.ts'] });
    expect(r.main.join('\n')).toContain('a');
    expect(r.told).toEqual([]);
  });

  it('red run with a live author: the author gets the failing tests and the tail, the user queue stays empty', async () => {
    const r = rig({ tickets: [merged('a', 'sa'), merged('b', 'sb')], touched: { a: ['src/server/tickets/merge.ts'] }, alive: true });
    r.result.v = red(' FAIL  test/merge-ticket.test.ts > merges\nAssertionError: boom\n');
    await r.c.runNow();
    expect(r.asked).toEqual([]);
    expect(r.told).toHaveLength(1);
    expect(r.told[0]).toContain('a:');
    expect(r.told[0]).toContain('test/merge-ticket.test.ts');
    expect(r.told[0]).toContain('AssertionError: boom');
  });

  it('red run the files cannot explain: bisects the batch and blames the first bad merge', async () => {
    const r = rig({
      tickets: [merged('a', 'sa'), merged('b', 'sb'), merged('c', 'sc')], touched: {},
      rerun: (sha) => (sha === 'sb' || sha === 'sc' || sha === 'tip1' ? false : true),
    });
    r.result.v = red(' FAIL  test/x.test.ts > y\n');
    await r.c.runNow();
    expect(r.c.record('')).toMatchObject({ culprit: 'b', by: 'bisect' });
    expect(r.reruns[0]).toBe('sa^'); // the base is checked first: the parent of the first merge of the batch
  });

  it('red run nobody can be blamed for: one decision in the user queue with the facts, no ticket marked', async () => {
    const r = rig({ tickets: [merged('a', 'sa'), merged('b', 'sb')], touched: {}, rerun: () => undefined });
    r.result.v = red(' FAIL  test/x.test.ts > y\n');
    await r.c.runNow();
    expect(r.c.record('')).toMatchObject({ ok: false });
    expect(r.c.record('')!.culprit).toBeUndefined();
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]!.payload).toMatchObject({ reason: 'central_red_undecided', tickets: ['a', 'b'], failing: ['test/x.test.ts'] });
    expect([...r.marks.values()].some((m) => (m as { red?: unknown }).red)).toBe(false);
  });
});
