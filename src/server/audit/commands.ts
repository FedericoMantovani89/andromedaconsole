import { runDirect, type TestRunner } from '../tickets/test-queue';

export type LayerTwoId = 'lint' | 'format_check';

/** What one project command said about the changed files. `ran: false` is "not run" (with the reason), never "ok". */
export interface LayerTwoResult {
  id: LayerTwoId;
  ran: boolean;
  ok?: boolean;
  output: string;
  reason?: 'no_command' | 'no_files' | 'timeout' | 'spawn_failed' | 'cancelled';
}

const MAX_OUTPUT = 20_000;
const MAX_COMMAND_LINE = 7000; // cmd.exe stops at 8191 characters
const NOT_FOUND_CODES = new Set([127, 9009]); // sh and cmd: the program is not there
const UNSAFE_NAME = /["%\r\n\0]/; // cannot be quoted for every shell: the file is skipped and named

export function quoteForShell(file: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `"${file}"` : `'${file.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs the project's own lint or format-check command on the changed files only. The command is the user's (it goes through the platform
 * shell, like the test command); the files are passed quoted, one by one, never joined into the text of another command.
 */
export async function runStyleCommand(o: {
  id: LayerTwoId; command: string | undefined; files: string[]; cwd: string; timeoutMs: number; run?: TestRunner; owner: string; platform?: NodeJS.Platform;
}): Promise<LayerTwoResult> {
  const notRun = (reason: NonNullable<LayerTwoResult['reason']>, output = ''): LayerTwoResult => ({ id: o.id, ran: false, output, reason });
  const command = o.command?.trim();
  if (!command) return notRun('no_command');

  const usesFiles = command.includes('{files}');
  const safe = o.files.filter((f) => !UNSAFE_NAME.test(f));
  const skipped = o.files.filter((f) => UNSAFE_NAME.test(f));
  const note = skipped.length > 0 ? `skipped (the name cannot be passed to a shell safely): ${skipped.join(', ')}\n` : '';
  if (usesFiles && safe.length === 0) return notRun('no_files', note);

  const commands: string[] = [];
  if (!usesFiles) commands.push(command);
  else {
    const room = MAX_COMMAND_LINE - command.length;
    let batch: string[] = [];
    let used = 0;
    for (const f of safe) {
      const q = quoteForShell(f, o.platform);
      if (batch.length > 0 && used + q.length + 1 > room) { commands.push(command.split('{files}').join(batch.join(' '))); batch = []; used = 0; }
      batch.push(q);
      used += q.length + 1;
    }
    commands.push(command.split('{files}').join(batch.join(' '))); // split/join: a name with $& or $$ is not a replacement pattern, and every {files} gets the names
  }

  const run = o.run ?? runDirect;
  const outputs: string[] = [];
  let allOk = true;
  for (const c of commands) {
    const r = await run({ cwd: o.cwd, command: c, timeoutMs: o.timeoutMs, owner: o.owner });
    if (r.timedOut) return notRun('timeout', note + r.tail);
    if (r.cancelled || r.notRun) return notRun('cancelled', note + r.tail);
    if (r.code !== null && NOT_FOUND_CODES.has(r.code)) return notRun('spawn_failed', note + r.tail);
    outputs.push(r.tail);
    if (!r.ok) allOk = false;
  }
  const joined = note + outputs.join('\n');
  return { id: o.id, ran: true, ok: allOk, output: joined.length > MAX_OUTPUT ? `${joined.slice(0, MAX_OUTPUT)}\n[output cut]` : joined };
}
