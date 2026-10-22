export interface LaunchOptions {
  command: string[]; role: 'main' | 'agent' | 'reviewer' | 'recovery'; slug: string; project: string;
  /** For a launched session this is its own session token (never the UI token). */
  url: string; token: string; bypass: boolean; baseEnv: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
  /** The console mod to load (--plugin-dir). Omitted: no mod (fake agents in tests, or mod disabled). */
  pluginDir?: string;
  /** Text appended to the system prompt (profile, main instructions). */
  appendPromptFile?: string;
  /** Extra settings for this session only (--settings): the console's deny rules, kept under the project's .andromedaconsole. */
  settingsFile?: string;
  /** Model alias or id (--model). Omitted: Claude Code's default. */
  model?: string;
  /** Tools approved without a permission prompt (the console's own tools). */
  allowedTools?: string[];
  /** Resumes this Claude Code session (--resume <id>): it keeps its own context. Plain characters only (SESSION_ID_RE). */
  resumeId?: string;
  /** Session display name (--name): what Remote Control and the session picker show. Omitted: Claude Code's default. */
  displayName?: string;
}

/**
 * A Claude Code session id that may become a command-line argument: letters, digits and dashes only (no shell metacharacters), and
 * not starting with a dash (it would read as another flag).
 */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Windows paths go through cmd.exe and node-pty: forward slashes survive both. */
const fwd = (p: string): string => p.replace(/\\/g, '/');

// Phase 0: an inherited CLAUDE_CODE_CHILD_SESSION marker turns transcript saving off in the child.
const STRIP = /^CLAUDE_CODE_|^CLAUDECODE$|^CLAUDE_PID$/;

export function buildClaudeLaunch(o: LaunchOptions): { file: string; args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.baseEnv)) {
    if (v !== undefined && !STRIP.test(k)) env[k] = v;
  }
  env.NoDefaultCurrentDirectoryInExePath = '1'; // cmd.exe would run a claude.cmd that sits in the working folder before the real one
  env.CONSOLE_URL = o.url;
  env.CONSOLE_TOKEN = o.token;
  env.CONSOLE_ROLE = o.role;
  env.CONSOLE_AGENT = o.slug;
  const [cmd, ...rest] = o.command;
  if (o.resumeId !== undefined && !SESSION_ID_RE.test(o.resumeId)) throw new Error(`invalid session id: ${JSON.stringify(o.resumeId)}`);
  const flags = [
    ...(o.resumeId !== undefined ? ['--resume', o.resumeId] : []),
    ...(o.displayName ? ['--name', o.displayName] : []),
    ...(o.model ? ['--model', o.model] : []),
    ...(o.pluginDir ? ['--plugin-dir', fwd(o.pluginDir)] : []),
    ...(o.appendPromptFile ? ['--append-system-prompt-file', fwd(o.appendPromptFile)] : []),
    ...(o.allowedTools && o.allowedTools.length > 0 ? ['--allowedTools', o.allowedTools.join(',')] : []),
    ...(o.settingsFile ? ['--settings', fwd(o.settingsFile)] : []),
    ...(o.bypass ? ['--dangerously-skip-permissions'] : []),
  ];
  const bareName = !/[\\/]/.test(cmd!) && !/\.exe$/i.test(cmd!);
  if ((o.platform ?? process.platform) === 'win32' && bareName) {
    // A bare `claude` resolves through a .cmd shim on Windows: go through cmd.exe (proven in Phase 0).
    // node-pty only quotes arguments that contain whitespace, so cmd.exe would read & | < > ^ % in the others as commands.
    for (const a of [cmd!, ...rest, ...flags]) {
      if (/[&|<>^%"]/.test(a) || a.includes(String.fromCharCode(10)) || a.includes(String.fromCharCode(13))) throw new Error(`unsafe argument for cmd.exe: ${JSON.stringify(a)}`);
    }
    return { file: 'cmd.exe', args: ['/c', cmd!, ...rest, ...flags], env };
  }
  return { file: cmd!, args: [...rest, ...flags], env };
}
