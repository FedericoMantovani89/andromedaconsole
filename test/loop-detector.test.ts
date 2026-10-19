import { describe, expect, it } from 'vitest';
import { LoopDetector, type LoopConfig } from '../src/server/budget/loop-detector';
import { callSignature } from '../src/server/guard/rules';
import type { TranscriptEvent } from '../src/server/claude-code/transcript';

const MIN = 60_000;
const CFG: LoopConfig = { sameCall: 5, sameError: 3, compactions: 2, stepMinutes: 30, silenceMinutes: 5 };

let n = 0;
const call = (name: string, input: Record<string, unknown>): TranscriptEvent => ({ kind: 'tool_use', id: `u${++n}`, name, input });
const ok = (id: string): TranscriptEvent => ({ kind: 'tool_result', toolUseId: id, isError: false, text: 'fine' });
const err = (id: string, text: string): TranscriptEvent => ({ kind: 'tool_result', toolUseId: id, isError: true, text });
const compact = (): TranscriptEvent => ({ kind: 'compact' });
const bash = (command: string): TranscriptEvent => call('Bash', { command });
const times = (k: number, make: () => TranscriptEvent): TranscriptEvent[] => Array.from({ length: k }, make);

function make(): { d: LoopDetector; clock: { t: number } } {
  const clock = { t: 1_000_000 };
  return { d: new LoopDetector(() => CFG, () => clock.t), clock };
}

describe('LoopDetector same_call', () => {
  it('does not fire at 4 identical Bash calls and fires at the 5th with the signature', () => {
    const { d } = make();
    expect(d.feed('a', times(4, () => bash('npm test')))).toEqual([]);
    const f = d.feed('a', [bash('npm test')]);
    expect(f).toHaveLength(1);
    expect(f[0]?.signal).toBe('same_call');
    expect(f[0]?.warnOnly).toBe(false);
    expect(f[0]?.signature).toBe(callSignature('Bash', { command: 'npm test' }));
    expect(f[0]?.coarse).toBe(false);
  });

  it('a different call in the middle restarts the run', () => {
    const { d } = make();
    expect(d.feed('a', [...times(3, () => bash('x')), bash('y'), ...times(4, () => bash('x'))])).toEqual([]);
    expect(d.feed('a', [bash('x')])).toHaveLength(1);
  });

  it('fires again for a new run that follows a different call inside the SAME batch (one turn)', () => {
    const { d } = make();
    expect(d.feed('a', times(5, () => bash('npm test')))).toHaveLength(1);
    // one later turn: a different call, then five identical ones again
    const again = d.feed('a', [bash('ls'), ...times(5, () => bash('npm test'))]);
    expect(again).toHaveLength(1);
    expect(again[0]?.signal).toBe('same_call');
    // the run goes on in the next turn without a break: no new finding
    expect(d.feed('a', times(3, () => bash('npm test')))).toEqual([]);
  });

  it('the same tool with different arguments never fires', () => {
    const { d } = make();
    const evs = [...times(3, () => call('Read', { file_path: 'a.ts' })), ...times(3, () => call('Read', { file_path: 'b.ts' }))];
    expect(d.feed('a', evs)).toEqual([]);
  });

  it('key order in the input does not matter', () => {
    const { d } = make();
    const evs = [
      call('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }), call('Edit', { new_string: 'y', old_string: 'x', file_path: 'a.ts' }),
      call('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }), call('Edit', { old_string: 'x', file_path: 'a.ts', new_string: 'y' }),
      call('Edit', { new_string: 'y', file_path: 'a.ts', old_string: 'x' }),
    ];
    expect(d.feed('a', evs)).toHaveLength(1);
  });

  it('five identical WebFetch calls (no signature key) fire as coarse', () => {
    const { d } = make();
    const f = d.feed('a', times(5, () => call('WebFetch', { url: 'https://example.com', prompt: 'p' })));
    expect(f).toHaveLength(1);
    expect(f[0]?.coarse).toBe(true);
    expect(f[0]?.signature).toBe(callSignature('WebFetch', {}));
  });

  it('two Grep calls with different patterns on the same path are not the same call', () => {
    const { d } = make();
    const evs: TranscriptEvent[] = [];
    for (let i = 0; i < 6; i++) evs.push(call('Grep', { pattern: `p${i}`, path: 'src' }));
    expect(d.feed('a', evs)).toEqual([]);
  });

  it('identical Grep calls (same pattern and path) fire, and the signature is the coarse path one but not coarse', () => {
    const { d } = make();
    const f = d.feed('a', times(5, () => call('Grep', { pattern: 'foo', path: 'src' })));
    expect(f).toHaveLength(1);
    expect(f[0]?.coarse).toBe(false);
    expect(f[0]?.signature).toBe(callSignature('Grep', { path: 'src' }));
  });

  it('a run that goes on fires again every 5 more repeats (10, 15...), and reset starts the count again', () => {
    const { d } = make();
    expect(d.feed('a', times(5, () => bash('x')))).toHaveLength(1);
    expect(d.feed('a', [bash('x')])).toEqual([]);
    const tenth = d.feed('a', times(4, () => bash('x')));
    expect(tenth).toHaveLength(1);
    expect(tenth[0]?.evidence).toContain('10 times');
    d.reset('a', 'same_call');
    expect(d.feed('a', times(4, () => bash('x')))).toEqual([]);
    expect(d.feed('a', [bash('x')])).toHaveLength(1);
  });

  it('15 identical calls in a row give three findings', () => {
    const { d } = make();
    expect(d.feed('a', times(15, () => bash('npm test'))).map((f) => f.signal)).toEqual(['same_call', 'same_call', 'same_call']);
  });

  it('fires again once the condition has cleared', () => {
    const { d } = make();
    expect(d.feed('a', times(5, () => bash('x')))).toHaveLength(1);
    expect(d.feed('a', [bash('other')])).toEqual([]);
    expect(d.feed('a', times(5, () => bash('x')))).toHaveLength(1);
  });

  it('slugs are independent', () => {
    const { d } = make();
    expect(d.feed('a', times(4, () => bash('x')))).toEqual([]);
    expect(d.feed('b', [bash('x')])).toEqual([]);
    expect(d.feed('a', [bash('x')])).toHaveLength(1);
  });
});

describe('LoopDetector same_error', () => {
  it('fires on 3 identical error results', () => {
    const { d } = make();
    const f = d.feed('a', [err('1', 'boom'), err('2', 'boom'), err('3', 'boom')]);
    expect(f).toHaveLength(1);
    expect(f[0]?.signal).toBe('same_error');
    expect(f[0]?.warnOnly).toBe(false);
  });

  it('counts the same error since the last step, also with successful results between them (edit ok, test fails, ...)', () => {
    const { d } = make();
    const f = d.feed('a', [ok('0'), err('1', 'FAIL x'), ok('2'), err('3', 'FAIL x'), ok('4'), err('5', 'FAIL x')]);
    expect(f).toHaveLength(1);
    expect(f[0]?.signal).toBe('same_error');
  });

  it('the error count is spread over turns and cleared by a finished step', () => {
    const { d } = make();
    expect(d.feed('a', [err('1', 'boom')])).toEqual([]);
    expect(d.feed('a', [ok('2'), err('3', 'boom')])).toEqual([]);
    d.onStepDone('a');
    expect(d.feed('a', [err('4', 'boom')])).toEqual([]);
    expect(d.feed('a', [err('5', 'boom')])).toEqual([]);
    expect(d.feed('a', [err('6', 'boom')])).toHaveLength(1);
  });

  it('does not fire on two different errors', () => {
    const { d } = make();
    expect(d.feed('a', [err('1', 'boom'), err('2', 'bang'), err('3', 'boom')])).toEqual([]);
  });

  it('does not fire on 2 identical errors', () => {
    const { d } = make();
    expect(d.feed('a', [err('1', 'boom'), err('2', 'boom')])).toEqual([]);
  });

  it('compares only the last 200 characters (an unknown call id falls back to the text alone)', () => {
    const { d } = make();
    const tail = 'x'.repeat(200);
    const f = d.feed('a', [err('1', `a${tail}`), err('2', `b${tail}`), err('3', `c${tail}`)]);
    expect(f).toHaveLength(1);
  });

  const run = (id: string, command: string, text: string, isError = true): TranscriptEvent[] => [
    { kind: 'tool_use', id, name: 'Bash', input: { command } },
    { kind: 'tool_result', toolUseId: id, isError, text },
  ];
  const editOk = (id: string): TranscriptEvent[] => [call('Edit', { file_path: `f${id}.ts` }), ok('nope')];

  it('three runs of the same command with the same opening but different tails do not fire', () => {
    const { d } = make();
    const head = 'Exit code 1\n> pkg@1 test\n> vitest run\n'.padEnd(300, '-');
    const evs = [
      ...run('r1', 'npm test', `${head}${'a'.repeat(200)}`), ...editOk('1'),
      ...run('r2', 'npm test', `${head}${'b'.repeat(200)}`), ...editOk('2'),
      ...run('r3', 'npm test', `${head}${'c'.repeat(200)}`),
    ];
    expect(d.feed('a', evs)).toEqual([]);
  });

  it('three runs of the same command with identical tails fire', () => {
    const { d } = make();
    const tail = 'z'.repeat(200);
    const evs = [
      ...run('s1', 'npm test', `1${tail}`), ...editOk('1'), ...run('s2', 'npm test', `2${tail}`), ...editOk('2'), ...run('s3', 'npm test', `3${tail}`),
    ];
    expect(d.feed('a', evs).map((f) => f.signal)).toEqual(['same_error']);
  });

  it('two different commands with identical error tails do not fire', () => {
    const { d } = make();
    const tail = 'y'.repeat(200);
    const evs = [...run('c1', 'npm test', tail), ...run('c2', 'npm run lint', tail), ...run('c3', 'tsc', tail)];
    expect(d.feed('a', evs)).toEqual([]);
  });

  it('fires again at every 3 more occurrences, and reset starts the count again', () => {
    const { d } = make();
    expect(d.feed('a', [err('1', 'boom'), err('2', 'boom'), err('3', 'boom')])).toHaveLength(1);
    expect(d.feed('a', [err('4', 'boom')])).toEqual([]);
    expect(d.feed('a', [err('5', 'boom'), err('6', 'boom')])).toHaveLength(1);
    d.reset('a', 'same_error');
    expect(d.feed('a', [err('7', 'boom'), err('8', 'boom')])).toEqual([]);
    expect(d.feed('a', [err('9', 'boom')])).toHaveLength(1);
  });
});

describe('LoopDetector compactions', () => {
  it('fires at 2 compactions', () => {
    const { d } = make();
    expect(d.feed('a', [compact()])).toEqual([]);
    const f = d.feed('a', [compact()]);
    expect(f).toHaveLength(1);
    expect(f[0]?.signal).toBe('compactions');
    expect(f[0]?.warnOnly).toBe(false);
  });

  it('does not fire when a step finished between them', () => {
    const { d } = make();
    expect(d.feed('a', [compact()])).toEqual([]);
    d.onStepDone('a');
    expect(d.feed('a', [compact()])).toEqual([]);
  });

  it('fires at 2, not at 3, and again at 4 (compactions that go on keep escalating)', () => {
    const { d } = make();
    expect(d.feed('a', [compact(), compact()])).toHaveLength(1);
    expect(d.feed('a', [compact()])).toEqual([]);
    expect(d.feed('a', [compact()])).toHaveLength(1);
  });
});

describe('LoopDetector no_step', () => {
  it('does not fire at +29 min, fires once at +31 min as a warning', () => {
    const { d, clock } = make();
    d.feed('a', []);
    clock.t += 29 * MIN;
    d.onModEvent('a');
    expect(d.tick(['a'])).toEqual([]);
    clock.t += 2 * MIN;
    d.onModEvent('a');
    const r = d.tick(['a']);
    expect(r).toHaveLength(1);
    expect(r[0]?.slug).toBe('a');
    expect(r[0]?.finding.signal).toBe('no_step');
    expect(r[0]?.finding.warnOnly).toBe(true);
    expect(d.tick(['a'])).toEqual([]);
  });

  it('onStepDone resets the step clock', () => {
    const { d, clock } = make();
    d.feed('a', []);
    clock.t += 31 * MIN;
    d.onModEvent('a');
    expect(d.tick(['a']).map((x) => x.finding.signal)).toEqual(['no_step']);
    d.onStepDone('a');
    clock.t += 29 * MIN;
    d.onModEvent('a');
    expect(d.tick(['a'])).toEqual([]);
    clock.t += 2 * MIN;
    d.onModEvent('a');
    expect(d.tick(['a']).map((x) => x.finding.signal)).toEqual(['no_step']);
  });

  it('an agent that is not working never fires', () => {
    const { d, clock } = make();
    d.feed('a', []);
    clock.t += 60 * MIN;
    expect(d.tick([])).toEqual([]);
  });
});

describe('LoopDetector silence', () => {
  it('names the command still running when the silence fires', () => {
    const { d, clock } = make();
    const c = bash('npm run build:all');
    d.feed('a', [c]);
    d.onModEvent('a');
    clock.t += 7 * MIN;
    const r = d.tick(['a']);
    expect(r[0]?.finding.evidence).toContain('no event from the agent for 5 minutes');
    expect(r[0]?.finding.evidence).toContain('Bash: npm run build:all');
    expect(r[0]?.finding.evidence).toContain('running for 7 minutes');
  });

  it('a finished call is not reported as running', () => {
    const { d, clock } = make();
    const c = bash('npm run build:all');
    d.feed('a', [c, ok((c as { id: string }).id)]);
    d.onModEvent('a');
    clock.t += 5 * MIN;
    expect(d.tick(['a'])[0]?.finding.evidence).not.toContain('Bash');
    expect(d.runningTool('a')).toBeUndefined();
  });

  it('fires a warning once after 5 minutes without a mod event', () => {
    const { d, clock } = make();
    d.onModEvent('a');
    clock.t += 4 * MIN;
    expect(d.tick(['a'])).toEqual([]);
    clock.t += 1 * MIN;
    const r = d.tick(['a']);
    expect(r).toHaveLength(1);
    expect(r[0]?.finding.signal).toBe('silence');
    expect(r[0]?.finding.warnOnly).toBe(true);
    expect(d.tick(['a'])).toEqual([]);
  });

  it('a mod event resets the silence clock and allows it to fire again', () => {
    const { d, clock } = make();
    d.onModEvent('a');
    clock.t += 5 * MIN;
    expect(d.tick(['a'])).toHaveLength(1);
    d.onModEvent('a');
    clock.t += 4 * MIN;
    expect(d.tick(['a'])).toEqual([]);
    clock.t += 1 * MIN;
    expect(d.tick(['a'])).toHaveLength(1);
  });

  it('an agent not in workingSlugs never fires (waiting for the user is not a block)', () => {
    const { d, clock } = make();
    d.onModEvent('a');
    clock.t += 10 * MIN;
    expect(d.tick([])).toEqual([]);
    expect(d.tick(['b']).map((x) => x.slug)).toEqual([]);
  });
});

describe('LoopDetector forget', () => {
  it('clears everything for the slug', () => {
    const { d, clock } = make();
    expect(d.feed('a', times(5, () => bash('x')))).toHaveLength(1);
    d.feed('a', [compact()]);
    d.forget('a');
    expect(d.feed('a', times(4, () => bash('x')))).toEqual([]);
    expect(d.feed('a', [compact()])).toEqual([]);
    expect(d.feed('a', [bash('x')])).toHaveLength(1);
    clock.t += 40 * MIN;
    d.forget('a');
    expect(d.tick(['a'])).toEqual([]);
  });
});

describe('LoopDetector silentMinutes', () => {
  it('is undefined before the threshold, whole minutes after it, and undefined again after a sign of life', () => {
    const { d, clock } = make();
    d.onModEvent('a');
    clock.t += 4 * MIN;
    expect(d.silentMinutes('a')).toBeUndefined();
    clock.t += 3 * MIN + 30_000;
    expect(d.silentMinutes('a')).toBe(7);
    d.onModEvent('a');
    expect(d.silentMinutes('a')).toBeUndefined();
  });
});
