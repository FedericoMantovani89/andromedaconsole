export interface Frontmatter {
  /** Top-level `key: value` lines. */
  meta: Record<string, string>;
  /** A `key:` with no value opens a block; its indented `sub: value` lines land here. */
  blocks: Record<string, Record<string, string>>;
  body: string;
}

/**
 * Frontmatter subset shared by the role profiles and the style profiles: flat `key: value` lines and one level of nested blocks.
 * A leading BOM and CRLF (a file saved by Notepad) are accepted; text with no closed front matter is all body.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { meta: {}, blocks: {}, body: normalized.trim() };
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return { meta: {}, blocks: {}, body: normalized.trim() };
  const meta: Record<string, string> = {};
  const blocks: Record<string, Record<string, string>> = {};
  let block = '';
  for (const line of normalized.slice(4, end).split('\n')) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line); // indented lines do not match: they belong to a nested block
    if (m) {
      block = m[2] === '' ? m[1]! : '';
      if (m[2] !== '') meta[m[1]!] = m[2]!.trim();
      continue;
    }
    const nested = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (nested && block !== '') (blocks[block] ??= {})[nested[1]!] = nested[2]!.trim();
  }
  return { meta, blocks, body: normalized.slice(end + 4).replace(/^\n+/, '').trim() };
}
