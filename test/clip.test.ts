import { describe, expect, it } from 'vitest';
import { CLIP_MARK, clipText } from '../src/server/clip';

describe('clipText', () => {
  it('leaves a short text alone', () => {
    expect(clipText('need the schema', 100)).toBe('need the schema');
  });

  it('cuts at a word, never inside one, and says so', () => {
    const out = clipText('I ask to free some memory (stop the other Maven jobs) and then retry', 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith(CLIP_MARK)).toBe(true);
    const body = out.slice(0, -CLIP_MARK.length);
    expect('I ask to free some memory (stop the other Maven jobs) and then retry'.startsWith(`${body} `)).toBe(true);
  });

  it('prefers the end of a line when one falls in the second half', () => {
    const text = `first line of the reason\nsecond line that is long enough to be cut somewhere`;
    expect(clipText(text, 50)).toBe(`first line of the reason${CLIP_MARK}`);
  });

  it('cuts a text with no space at the limit', () => {
    const out = clipText('x'.repeat(100), 40);
    expect(out).toBe(`${'x'.repeat(40 - CLIP_MARK.length)}${CLIP_MARK}`);
  });
});
