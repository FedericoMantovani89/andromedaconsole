// Counts the native worker crashes of the ci workflow on main, so nobody tallies them by hand.
//   npm run ci-crash-stats -- [--limit 10] [--since <sha>]
// For each finished run it reads the log of the job and lists the test files named in "Worker exited unexpectedly ... while running test
// file <path>" and the files with a failing test. It then says how many crashes fell in the files that run on plain pipes (they call
// usePipePty()): the test of the ConPTY hypothesis, where about five clean runs support it and one crash there disproves it.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const limit = Number(arg('limit') ?? 10);
const since = arg('since');

const gh = (args: string[]): string => execFileSync('gh', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
// The log without colors: a real escape, or its caret form (^[[39m) in a saved log.
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\^\[\[[0-9;]*m/g, '');
const fileOf = (p: string): string => p.replace(/\\/g, '/').replace(/.*\/test\//, 'test/');

const pipeFiles = new Set(readdirSync(resolve(root, 'test'))
  .filter(n => n.endsWith('.test.ts') && /usePipePty|pipePty: true/.test(readFileSync(resolve(root, 'test', n), 'utf8')))
  .map(n => `test/${n}`));

interface Run { databaseId: number; headSha: string; conclusion: string; status: string; createdAt: string }
let runs = JSON.parse(gh(['run', 'list', '--workflow', 'ci', '--branch', 'main', '--event', 'push', '--limit', String(limit), '--json', 'databaseId,headSha,conclusion,status,createdAt'])) as Run[];
if (since) {
  const i = runs.findIndex(r => r.headSha.startsWith(since));
  if (i < 0) { console.error(`no run for ${since} in the last ${limit} runs: raise --limit`); process.exit(1); }
  runs = runs.slice(0, i + 1);
}

let clean = 0, crashed = 0, inPipe = 0, other = 0;
for (const r of runs.reverse()) {
  if (r.status !== 'completed') { console.log(`${r.headSha.slice(0, 7)}  still ${r.status}`); continue; }
  const log = plain(gh(['run', 'view', String(r.databaseId), '--log']));
  const crashes = [...new Set([...log.matchAll(/while running test file (\S+)/g)].map(m => fileOf(m[1]!)))].sort();
  const failed = [...new Set([...log.matchAll(/^.*?\bFAIL\s+(\S*test\/\S+\.test\.ts)/gm)].map(m => fileOf(m[1]!)))].sort();
  const hit = crashes.filter(f => pipeFiles.has(f));
  if (crashes.length) crashed++; else if (r.conclusion === 'success') clean++; else other++;
  inPipe += hit.length;
  console.log(`${r.headSha.slice(0, 7)}  ${r.conclusion.padEnd(9)} crash: ${crashes.join(' ') || '-'}${hit.length ? `  (on pipes: ${hit.join(' ')})` : ''}${failed.length ? `  failed: ${failed.join(' ')}` : ''}`);
}
console.log(`\n${runs.length} runs: ${clean} clean, ${crashed} with a native crash, ${other} failed otherwise; ${inPipe} crashes in the ${pipeFiles.size} files on pipes.`);
