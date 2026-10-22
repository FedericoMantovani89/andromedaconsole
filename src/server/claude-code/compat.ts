// What the console relies on in Claude Code and cannot read from any documentation: kept in one place with the adapter files
// (launch.ts: the command line and the environment; transcript.ts: the session files; mod/hooks/register.js: the mod API).
// `test/e2e/claude-contract.ts` checks every item here against the real `claude`; run it for each new Claude Code version.

/** The newest Claude Code a real contract run (`test/e2e/claude-contract.ts`, the `*-real-claude.ts` scripts) was last made with: a newer one works until proven otherwise, and `doctor` says it is untested. */
export const TESTED_CLAUDE_MAX = '2.1.300';

/** Every command-line flag launch.ts can pass: `claude --help` must still list each one. */
export const CLAUDE_FLAGS = ['--resume', '--name', '--model', '--plugin-dir', '--append-system-prompt-file', '--allowedTools', '--settings', '--dangerously-skip-permissions'] as const;

/** Where Claude Code files a session: `<config dir>/projects/<working folder, non-alphanumerics as dashes>/<session id>.jsonl` (transcript.ts). */
export const TRANSCRIPT_LAYOUT = 'projects/<encoded cwd>/<session id>.jsonl';
