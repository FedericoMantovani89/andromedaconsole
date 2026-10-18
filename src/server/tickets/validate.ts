import { execFile, spawn } from 'node:child_process';
import { errorMessage } from '../../shared/guards';

export interface ValidationResult { ok: boolean; code: number | null; tail: string; timedOut?: boolean; /** Stopped (or never started) because its owner is gone. */ cancelled?: boolean; /** Never started: the caller's `skip` said so when its turn came (the tests were inhibited meanwhile). */ notRun?: boolean }

const TAIL_BYTES = 4096;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

/**
 * Runs the project's test command (the user wrote it, so it goes through the platform shell: `cmd` on Windows) in `cwd`, with a
 * timeout, and keeps the last 4 KiB of the combined output with colour codes removed. The console's own variables are not passed on.
 */
export function runValidation(o: { cwd: string; command: string; timeoutMs: number; signal?: AbortSignal }): Promise<ValidationResult> {
  return new Promise((resolve) => {
    if (o.signal?.aborted) return resolve({ ok: false, code: null, tail: '', cancelled: true });
    // Not passed on: the console's own variables, and its protection of the program search (see exe-search.ts). The project's
    // command is written for a plain Windows shell, where `mvnw.cmd test` finds mvnw.cmd in the project folder.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CONSOLE_') && k.toLowerCase() !== 'nodefaultcurrentdirectoryinexepath'));
    let out = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const finish = (code: number | null, extra = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = `${out}${extra}`.replace(ANSI, '').replace(/\r\n/g, '\n');
      resolve({ ok: code === 0 && !timedOut && !cancelled, code, tail: text.slice(-TAIL_BYTES), ...(timedOut ? { timedOut: true } : {}), ...(cancelled ? { cancelled: true } : {}) });
    };
    const keep = (b: Buffer): void => { out = (out + b.toString('utf8')).slice(-4 * TAIL_BYTES); };

    let child;
    try {
      child = spawn(o.command, { cwd: o.cwd, shell: true, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, code: null, tail: errorMessage(e) });
    }
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e) => finish(null, `\n${e.message}`));
    child.on('close', (code) => finish(code));

    const stop = (): void => {
      if (child.pid !== undefined) killTree(child.pid);
      setTimeout(() => finish(null), 5000).unref(); // never wait forever for a process that will not die
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, o.timeoutMs);
    o.signal?.addEventListener('abort', () => { cancelled = true; stop(); }, { once: true });
  });
}

function killTree(pid: number): void {
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
}
