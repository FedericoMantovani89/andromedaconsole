export interface CommentSyntax { line: string[]; block?: [string, string] }

const C_LIKE: CommentSyntax = { line: ['//'], block: ['/*', '*/'] };
const HASH: CommentSyntax = { line: ['#'] };
const DASH: CommentSyntax = { line: ['--'] };
const MARKUP: CommentSyntax = { line: [], block: ['<!--', '-->'] };

/** Comment syntax by file extension: a small table, not a parser. A file with another extension has no comment metrics (n/a). */
const BY_EXTENSION: Record<string, CommentSyntax> = {
  ts: C_LIKE, tsx: C_LIKE, js: C_LIKE, jsx: C_LIKE, mjs: C_LIKE, cjs: C_LIKE, java: C_LIKE, c: C_LIKE, h: C_LIKE, cpp: C_LIKE, hpp: C_LIKE, cs: C_LIKE,
  go: C_LIKE, rs: C_LIKE, kt: C_LIKE, swift: C_LIKE, php: C_LIKE, scala: C_LIKE, css: { line: [], block: ['/*', '*/'] },
  py: HASH, rb: HASH, sh: HASH, bash: HASH, yml: HASH, yaml: HASH, toml: HASH, ps1: HASH,
  sql: DASH, lua: DASH,
  html: MARKUP, xml: MARKUP, md: MARKUP,
};

export function commentSyntaxFor(path: string): CommentSyntax | undefined {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return BY_EXTENSION[base.slice(dot + 1).toLowerCase()];
}
