// The console must never touch the user's global Claude configuration (`~/.claude`, `$CLAUDE_CONFIG_DIR`, `~/.claude.json`): it is the
// user's own Claude Code, shared with every other project and tool, and a console that wrote there could change sessions it does not own.
// The one use allowed today is READING the transcripts (src/server/claude-code/transcript.ts, defaultProjectsDir). This static check keeps
// it that way: a source file that names the Claude home may not call any file-writing API, and no line may write to the transcripts folder.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
/** What names the user's Claude home in code (comments are stripped first). */
const CLAUDE_HOME = /\bhomedir\b|CLAUDE_CONFIG_DIR|\.claude\.json|~[\\/]\.claude/;
const WRITE_API = /\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|mkdir|mkdirSync|copyFile|copyFileSync|createWriteStream|cp|cpSync)\s*\(/;
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
  if (CLAUDE_HOME.test(c)) for (const line of c.split('\n')) if (WRITE_API.test(line)) problems.push(`names the Claude home and writes: ${line.trim()}`);
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
});
