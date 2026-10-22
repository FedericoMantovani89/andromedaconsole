import { baseName } from './paths';

export type ShellKind = 'posix' | 'powershell';
export interface Segment {
  argv: string[]; raw: string; pipeFromPrev: boolean;
  /** The `VAR=value` words that stood before the command (`GIT_DIR=x git status`), also after a wrapper such as `env`. */
  env?: string[];
}

const MAX_DEPTH = 5;
const OPERATOR_LOOKALIKE = /^(\d*|&)?>{1,2}$/;
/** Appended to a quoted token that looks like a redirection operator (analysis only; nothing is ever executed from these tokens). */
export const QUOTED_MARK = String.fromCharCode(0x200b);
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'sudo', 'nice', 'timeout', 'xargs', 'watch']);
const CONTROL = new Set(['if', 'then', 'do', 'else', 'elif', 'while', 'until', '!', '{', '}']);
const XARGS_WITH_ARG = new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a']);
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/** Lower-case command name without directory or `.exe`. */
export function commandName(token: string): string {
  return baseName(token).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

/** Index just after the `)` matching the `(` at `open`, or the end of the text. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i + 1;
  }
  return text.length;
}

interface Raw { tokens: string[]; raw: string; pipe: boolean }

/** First pass: quotes, separators, substitutions. Substitution bodies are returned separately and stay in the token text. */
function tokenize(command: string, shell: ShellKind): { segments: Raw[]; inner: string[] } {
  const segments: Raw[] = [];
  const inner: string[] = [];
  let tokens: string[] = [];
  let cur = '';
  let inToken = false;
  let single = false;
  let double = false;
  let segStart = 0;
  let nextPipe = false;
  let quoted = false; // the current token had quote marks
  const flushToken = (): void => {
    // A quoted ">" is text (grep -n ">" f), not a redirection: the analysis marks it so no rule mistakes it for an operator.
    if (inToken) tokens.push(quoted && OPERATOR_LOOKALIKE.test(cur) ? cur + QUOTED_MARK : cur);
    cur = '';
    inToken = false;
    quoted = false;
  };
  const endSegment = (end: number, pipeNext: boolean): void => {
    flushToken();
    if (tokens.length > 0) segments.push({ tokens, raw: command.slice(segStart, end).trim(), pipe: nextPipe });
    tokens = [];
    nextPipe = pipeNext;
    segStart = end + 1;
  };
  const escape = shell === 'powershell' ? '`' : '\\';

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const n = command[i + 1];
    if (single) {
      if (c === "'") single = false;
      else cur += c;
      continue;
    }
    if (c === '$' && n === '(' || (shell === 'posix' && (c === '<' || c === '>') && n === '(' && !double)) {
      const open = i + 1;
      const end = closeParen(command, open);
      inner.push(command.slice(open + 1, end - 1));
      cur += command.slice(i, end);
      inToken = true;
      i = end - 1;
      continue;
    }
    if (shell === 'posix' && c === '`') {
      const end = command.indexOf('`', i + 1);
      const stop = end === -1 ? command.length : end;
      inner.push(command.slice(i + 1, stop));
      cur += command.slice(i, Math.min(stop + 1, command.length));
      inToken = true;
      i = stop;
      continue;
    }
    if (double) {
      if (c === '"') double = false;
      else if (c === escape && n !== undefined && (n === '"' || n === escape || n === '$' || n === '`')) { cur += n; i++; }
      else cur += c;
      continue;
    }
    if (c === "'") { single = true; inToken = true; quoted = true; continue; }
    if (c === '"') { double = true; inToken = true; quoted = true; continue; }
    if (c === escape && n !== undefined) {
      if (shell === 'powershell' || /[\s"'\\$`]/.test(n)) { cur += n; inToken = true; i++; continue; }
      cur += c;
      inToken = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { flushToken(); continue; }
    // A brace group or a script block (`{ cmd }`, `if (...) { cmd }`): its commands are commands of their own.
    if ((c === '{' || c === '}') && cur === '' && !inToken && (n === undefined || /[\s;]/.test(n))) { endSegment(i, false); continue; }
    if (c === '\n' || c === ';') { endSegment(i, false); continue; }
    if (c === '|') {
      if (n === '|') { endSegment(i, false); i++; segStart = i + 1; } else endSegment(i, true);
      continue;
    }
    if (c === '&') {
      if (n === '&') { endSegment(i, false); i++; segStart = i + 1; continue; }
      const prev = command[i - 1];
      if (prev === '>' || prev === '<' || n === '>') { cur += c; inToken = true; continue; }
      endSegment(i, false);
      continue;
    }
    cur += c;
    inToken = true;
  }
  endSegment(command.length, false);
  return { segments, inner };
}

/** Drops leading `VAR=value` words and wrappers such as `env`, `sudo`, `nohup`. */
function stripPrefix(tokens: string[]): { argv: string[]; env: string[] } {
  let t = tokens;
  let opened = false;
  const env: string[] = [];
  for (;;) {
    while (t.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]!)) { env.push(t[0]!); t = t.slice(1); }
    // A subshell: `(cmd args)` arrives as `(cmd` ... `args)`.
    if (t.length > 0 && t[0]!.startsWith('(') && !t[0]!.startsWith('((')) {
      opened = true;
      t = [t[0]!.replace(/^\(+/, ''), ...t.slice(1)].filter((x, i) => i > 0 || x !== '');
      continue;
    }
    // Control words that only introduce the real command: `then git push`, `! git push`, `do rm -rf x`.
    if (t.length > 0 && CONTROL.has(t[0]!)) { t = t.slice(1); continue; }
    if (t.length > 0 && WRAPPERS.has(commandName(t[0]!))) {
      const wrapper = commandName(t[0]!);
      t = t.slice(1);
      while (t.length > 0 && /^-/.test(t[0]!)) {
        // `env -i` and `env -u NAME` / `--unset=NAME` take variables away from the command: that is reported like an assignment of a git variable,
        // so the guard sees an attempt to drop the session's git settings (its push hook). `-u` takes the next word with it.
        if (wrapper === 'env' && /^(-i|--ignore-environment|-0|-u|--unset)/.test(t[0]!)) env.push('GIT_CONFIG_UNSET=1');
        t = t.slice(wrapper === 'xargs' && XARGS_WITH_ARG.has(t[0]!) ? 2 : wrapper === 'env' && t[0] === '-u' ? 2 : 1);
      }
      if (wrapper === 'timeout' && t.length > 0 && /^\d+(\.\d+)?[smhd]?$/.test(t[0]!)) t = t.slice(1);
      continue;
    }
    break;
  }
  if (opened && t.length > 0) t = [...t.slice(0, -1), t[t.length - 1]!.replace(/\)+$/, '')].filter((x, i, a) => i < a.length - 1 || x !== '');
  return { argv: t, env };
}

/** Scripts a shell or interpreter will run, so they are examined as commands too. */
function nestedScripts(argv: string[]): { text: string; shell: ShellKind }[] {
  const name = commandName(argv[0] ?? '');
  const rest = argv.slice(1);
  const out: { text: string; shell: ShellKind }[] = [];
  if (POSIX_SHELLS.has(name)) {
    const i = rest.findIndex((t) => /^-[a-z]*c[a-z]*$/.test(t));
    if (i !== -1 && rest[i + 1] !== undefined) out.push({ text: rest[i + 1]!, shell: 'posix' });
  } else if (name === 'iex' || name === 'invoke-expression') {
    out.push({ text: rest.join(' '), shell: 'powershell' });
  } else if (name === 'eval') {
    out.push({ text: rest.join(' '), shell: 'posix' });
  } else if (name === 'cmd') {
    const i = rest.findIndex((t) => /^\/[ckr]$/i.test(t));
    if (i !== -1) out.push({ text: rest.slice(i + 1).join(' '), shell: 'posix' });
  } else if (name === 'powershell' || name === 'pwsh') {
    const cmd = rest.findIndex((t) => /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(t));
    const enc = rest.findIndex((t) => /^-e(n(c(o(d(e(d(c(o(m(m(a(n(d)?)?)?)?)?)?)?)?)?)?)?)?)?$/i.test(t));
    if (cmd !== -1) out.push({ text: rest.slice(cmd + 1).join(' '), shell: 'powershell' });
    else if (enc !== -1 && rest[enc + 1] !== undefined) {
      out.push({ text: Buffer.from(rest[enc + 1]!, 'base64').toString('utf16le'), shell: 'powershell' });
    } else {
      const script = rest.find((t) => !t.startsWith('-'));
      if (script !== undefined) out.push({ text: script, shell: 'powershell' });
    }
  }
  return out;
}

/**
 * Splits a shell command into simple commands: on `; && || | &` and newlines, inside `$( )`, backticks, `<( )` and the
 * script argument of `bash -c`, `cmd /c`, `powershell -Command`/`-EncodedCommand`, `eval`. Tokens respect quotes; Windows
 * backslashes survive. Never throws, and an unbalanced quote just runs to the end.
 */
export function splitCommand(command: string, shell: ShellKind = 'posix', depth = 0): Segment[] {
  if (depth > MAX_DEPTH || command.trim() === '') return [];
  const { segments, inner } = tokenize(command, shell);
  const out: Segment[] = [];
  for (const s of segments) {
    const { argv, env } = stripPrefix(s.tokens);
    if (argv.length === 0) continue;
    out.push({ argv, env, raw: s.raw, pipeFromPrev: s.pipe });
    for (const n of nestedScripts(argv)) out.push(...splitCommand(n.text, n.shell, depth + 1));
  }
  for (const text of inner) out.push(...splitCommand(text, shell, depth + 1));
  return out;
}
