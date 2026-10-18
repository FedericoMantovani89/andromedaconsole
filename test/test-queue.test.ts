import { describe, expect, it } from 'vitest';
import { TestQueue, type TestJob, type TestRun } from '../src/server/tickets/test-queue';

/** A fake test command: it ends when the test says so, so no real suite and no real time is needed. */
function fakeRunner() {
  const started: string[] = [];
  const finish = new Map<string, (r: { ok: boolean; tail?: string }) => void>();
  const aborted: string[] = [];
  const run = (o: { command: string; timeoutMs: number; signal?: AbortSignal }): Promise<TestRun> => new Promise((resolve) => {
    started.push(o.command);
    finish.set(o.command, (r) => resolve({ ok: r.ok, code: r.ok ? 0 : 1, tail: r.tail ?? '' }));
    o.signal?.addEventListener('abort', () => { aborted.push(o.command); resolve({ ok: false, code: null, tail: '', cancelled: true }); });
  });
  return { run, started, aborted, end: (command: string, ok = true) => finish.get(command)?.({ ok }) };
}

const job = (command: string, extra: Partial<TestJob> = {}): TestJob => ({ cwd: '.', command, timeoutMs: 1000, heavy: true, label: command, ...extra });
const tick = () => new Promise((r) => setTimeout(r, 15));

describe('TestQueue', () => {
  it('runs one heavy job at a time, first come first served', async () => {
    const f = fakeRunner();
    const q = new TestQueue({ run: f.run });
    const a = q.run(job('a'));
    const b = q.run(job('b'));
    const c = q.run(job('c'));
    await tick();
    expect(f.started).toEqual(['a']);
    f.end('a');
    expect((await a).ok).toBe(true);
    await tick();
    expect(f.started).toEqual(['a', 'b']);
    f.end('b');
    await b;
    await tick();
    expect(f.started).toEqual(['a', 'b', 'c']);
    f.end('c', false);
    expect((await c).ok).toBe(false);
  });

  it('does not queue a fast job: it runs at once beside a heavy one', async () => {
    const f = fakeRunner();
    const q = new TestQueue({ run: f.run });
    void q.run(job('heavy'));
    const fast = q.run(job('fast', { heavy: false }));
    await tick();
    expect(f.started).toEqual(['heavy', 'fast']);
    f.end('fast');
    expect((await fast).ok).toBe(true);
  });

  it('honours a limit above one', async () => {
    const f = fakeRunner();
    const q = new TestQueue({ run: f.run, limit: () => 2 });
    void q.run(job('a')); void q.run(job('b')); void q.run(job('c'));
    await tick();
    expect(f.started).toEqual(['a', 'b']);
  });

  it('reports the position of a waiting owner (1 = next) and a snapshot for the UI', async () => {
    const f = fakeRunner();
    const q = new TestQueue({ run: f.run });
    void q.run(job('a', { owner: 'x' }));
    void q.run(job('b', { owner: 'y' }));
    void q.run(job('c', { owner: 'z' }));
    await tick();
    expect(q.position('x')).toBeUndefined();
    expect(q.position('y')).toBe(1);
    expect(q.position('z')).toBe(2);
    expect(q.snapshot()).toEqual({ running: [{ label: 'a', owner: 'x' }], waiting: [{ label: 'b', owner: 'y', position: 1 }, { label: 'c', owner: 'z', position: 2 }] });
    f.end('a');
    await tick();
    expect(q.position('z')).toBe(1);
  });

  it('tells the caller about its position and changes', async () => {
    const f = fakeRunner();
    const seen: number[] = [];
    let changes = 0;
    const q = new TestQueue({ run: f.run, changed: () => { changes += 1; } });
    void q.run(job('a'));
    void q.run(job('b', { onWait: (p) => seen.push(p) }));
    await tick();
    expect(seen).toEqual([1]);
    expect(changes).toBeGreaterThan(0);
  });

  it('the timeout belongs to the run: the runner gets it when the job starts, not the wait', async () => {
    const f = fakeRunner();
    const timeouts: number[] = [];
    const q = new TestQueue({ run: (o) => { timeouts.push(o.timeoutMs); return f.run(o); } });
    void q.run(job('a'));
    void q.run(job('b', { timeoutMs: 777 }));
    await tick();
    await new Promise((r) => setTimeout(r, 60)); // b has waited longer than any budget it could have had
    f.end('a');
    await tick();
    expect(timeouts).toEqual([1000, 777]);
  });

  it('frees the slot when a job ends red, times out, or the runner throws', async () => {
    const f = fakeRunner();
    let first = true;
    const q = new TestQueue({
      run: (o) => {
        if (o.command === 'boom' && first) { first = false; return Promise.reject(new Error('spawn failed')); }
        return f.run(o);
      },
    });
    const boom = await q.run(job('boom'));
    expect(boom.ok).toBe(false);
    expect(boom.tail).toContain('spawn failed');
    const next = q.run(job('next'));
    await tick();
    expect(f.started).toEqual(['next']);
    f.end('next', false);
    expect((await next).ok).toBe(false);
    const after = q.run(job('after'));
    await tick();
    expect(f.started).toEqual(['next', 'after']);
    f.end('after');
    await after;
  });

  it('drops a waiting job whose owner is gone, without taking the slot', async () => {
    const f = fakeRunner();
    let alive = true;
    const q = new TestQueue({ run: f.run, pollMs: 5 });
    void q.run(job('a'));
    const gone = q.run(job('b', { owner: 'dead', ownerAlive: () => alive }));
    const c = q.run(job('c'));
    await tick();
    alive = false;
    const r = await gone;
    expect(r.cancelled).toBe(true);
    expect(q.position('dead')).toBeUndefined();
    f.end('a');
    await tick();
    expect(f.started).toEqual(['a', 'c']); // b never ran
    f.end('c');
    await c;
  });

  it('stops a running job whose owner is gone and passes the slot on', async () => {
    const f = fakeRunner();
    let alive = true;
    const q = new TestQueue({ run: f.run, pollMs: 5 });
    const a = q.run(job('a', { owner: 'dead', ownerAlive: () => alive }));
    const b = q.run(job('b'));
    await tick();
    alive = false;
    expect((await a).cancelled).toBe(true);
    expect(f.aborted).toEqual(['a']);
    await tick();
    expect(f.started).toEqual(['a', 'b']);
    f.end('b');
    await b;
  });

  it('a waiting job whose skip turns true is answered "not run" at the next poll and frees its place', async () => {
    const f = fakeRunner();
    let skip = false;
    const q = new TestQueue({ run: f.run, pollMs: 5 });
    void q.run(job('long'));
    const skipped = q.run(job('v', { owner: 'a', skip: () => skip }));
    const c = q.run(job('c', { owner: 'c' }));
    await tick();
    expect(q.position('c')).toBe(2);
    skip = true;
    expect(await skipped).toMatchObject({ ok: false, notRun: true });
    expect(q.position('a')).toBeUndefined();
    expect(q.position('c')).toBe(1);
    f.end('long');
    await tick();
    expect(f.started).toEqual(['long', 'c']); // v never ran
    f.end('c');
    await c;
  });

  it('a running job whose skip turns true is stopped and passes the slot on', async () => {
    const f = fakeRunner();
    let skip = false;
    const q = new TestQueue({ run: f.run, pollMs: 5 });
    const a = q.run(job('a', { skip: () => skip }));
    const b = q.run(job('b'));
    await tick();
    skip = true;
    expect((await a).cancelled).toBe(true);
    expect(f.aborted).toEqual(['a']);
    await tick();
    expect(f.started).toEqual(['a', 'b']);
    f.end('b');
    await b;
  });
});
