// The console must never touch the user's global Claude configuration (`~/.claude`, `$CLAUDE_CONFIG_DIR`, `~/.claude.json`): it is the
// user's own Claude Code, shared with every other project and tool, and a console that wrote there could change sessions it does not own.
// The one use allowed today is READING the transcripts (src/server/claude-code/transcript.ts, defaultProjectsDir). This static check keeps
// it that way: a source file that names the Claude home may not call any file-writing API, and no line may write to the transcripts folder.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
/**
 * Whether code names the user's Claude home (comments are stripped first): `CLAUDE_CONFIG_DIR`, `.claude.json`, a `~/.claude` path, or
 * `homedir` together with a `.claude` string. `homedir` alone is not enough: config.ts uses it as the APPDATA fallback for the console's
 * OWN configuration folder, which it writes on purpose.
 */
const namesClaudeHome = (c: string): boolean =>
  /CLAUDE_CONFIG_DIR|\.claude\.json|~[\\/]\.claude/.test(c) || (/\bhomedir\b/.test(c) && /['"`](?:[^'"`\n]*[\\/])?\.claude\b[^'"`\n]*['"`]/.test(c)); // a string that is or holds a `.claude` path part (not `raw.claude`)
/** Node's write calls, and the repo's own helpers that write files (src/server/fs-atomic.ts and the savers built on it). */
const WRITE_API = new RegExp('\\b(' + [
  'writeFile', 'writeFileSync', 'writeSync', 'appendFile', 'appendFileSync', 'rename', 'renameSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
  'unlink', 'unlinkSync', 'mkdir', 'mkdirSync', 'copyFile', 'copyFileSync', 'createWriteStream', 'cp', 'cpSync',
  'writeJsonAtomic', 'saveConfigAtomic', 'saveTemplate', 'saveUserProfile', 'writeGroqKey', 'writeReport', '\\w+Atomic',
].join('|') + ')\\s*\\(');
const TRANSCRIPTS = /\b(defaultProjectsDir|projectsDir)\b/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? sources(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
}
/** Code without comments: block comments, and line comments that start a line or follow a space (not `http://` in a string). */
const stripComments = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

/** The problems of one file's code, empty when it keeps away from the Claude home. */
function globalClaudeWrites(code: string): string[] {
  const c = stripComments(code);
  const problems: string[] = [];
  if (namesClaudeHome(c)) for (const line of c.split('\n')) if (WRITE_API.test(line)) problems.push(`names the Claude home and writes: ${line.trim()}`);
  for (const line of c.split('\n')) if (TRANSCRIPTS.test(line) && WRITE_API.test(line)) problems.push(`writes to the transcripts folder: ${line.trim()}`);
  return problems;
}

it('no source file writes to the user\'s Claude home (only transcript.ts reads from it)', () => {
  const found = sources(SRC).flatMap((f) => globalClaudeWrites(readFileSync(f, 'utf8')).map((p) => `${relative(SRC, f)}: ${p}`));
  expect(found).toEqual([]);
});

it('the check catches a write under the Claude home, and leaves reads and comments alone', () => {
  expect(globalClaudeWrites("import { homedir } from 'node:os';\nwriteFileSync(join(homedir(), '.claude', 'x'), 'y');")).toHaveLength(1);
  expect(globalClaudeWrites("const d = process.env.CLAUDE_CONFIG_DIR;\nmkdirSync(d);")).toHaveLength(1);
  expect(globalClaudeWrites("rmSync(join(defaultProjectsDir(), 'a'));")).toHaveLength(1);
  expect(globalClaudeWrites("const p = join(homedir(), '.claude', 'projects');\nconst t = readFileSync(p, 'utf8');")).toEqual([]);
  expect(globalClaudeWrites("// default ~/.claude/projects\nwriteFileSync(join(stateDir, 'x'), 'y');")).toEqual([]);
  // the repo's own write helpers count as writes; homedir alone (the console's own config folder) does not name the Claude home
  expect(globalClaudeWrites("import { homedir } from 'node:os';\nwriteJsonAtomic(join(homedir(), '.claude', 'settings.json'), {});")).toHaveLength(1);
  expect(globalClaudeWrites("const p = join(homedir(), '.claude.json');\nsaveConfigAtomic(p, c);")).toHaveLength(1);
  expect(globalClaudeWrites("const base = process.env.APPDATA ?? homedir();\nwriteJsonAtomic(join(base, 'andromeda', 'config.json'), c);")).toEqual([]);
});
