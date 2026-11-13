import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../src/server/frontmatter';

describe('parseFrontmatter', () => {
  it('reads a BOM + CRLF file with a nested block and a non-English body', () => {
    const text = '﻿---\r\nname: x\r\nlimits:\r\n  diff_lines: 250\r\n---\r\nCorpo in italiano: è già così';
    const r = parseFrontmatter(text);
    expect(r.meta.name).toBe('x');
    expect(r.blocks.limits?.diff_lines).toBe('250');
    expect(r.body).toBe('Corpo in italiano: è già così');
  });

  it('returns the trimmed text as body when there is no front matter', () => {
    expect(parseFrontmatter('  just text \n')).toEqual({ meta: {}, blocks: {}, body: 'just text' });
  });

  it('treats an unterminated front matter as plain body', () => {
    const r = parseFrontmatter('---\nname: x\nno end');
    expect(r.meta).toEqual({});
    expect(r.body).toBe('---\nname: x\nno end');
  });

  it('keeps several blocks apart and ignores indented lines outside a block', () => {
    const r = parseFrontmatter('---\nconsole:\n  read_only: true\ncommands:\n  lint: npx eslint {files}\n---\nbody');
    expect(r.blocks.console?.read_only).toBe('true');
    expect(r.blocks.commands?.lint).toBe('npx eslint {files}');
  });
});
