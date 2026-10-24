export const CLIP_MARK = ' [truncated]';

/**
 * A text of at most `max` characters (the mark included) for a message another session reads: it is cut at the end of a line, or of a
 * word when the first `max` characters hold no line break past their middle, never in the middle of a word, and says it was cut.
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = max - CLIP_MARK.length;
  const head = text.slice(0, room);
  const nextIsBreak = /\s/.test(text[room] ?? '');
  const line = head.lastIndexOf('\n');
  const word = nextIsBreak ? head.length : head.search(/\s\S*$/);
  const cut = line > room / 2 ? line : word > 0 ? word : head.length;
  return `${head.slice(0, cut).trimEnd()}${CLIP_MARK}`;
}
