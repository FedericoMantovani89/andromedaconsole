// Manual contract test of the requests between agents with the REAL Claude Code and the REAL mod (a little quota: a main and two
// agents on haiku). Run: npx tsx test/e2e/requests-real-claude.ts <already-trusted-project-folder>
// The folder is the agents' working folder (no worktrees); never this repository. It proves what simulated events cannot: the engine
// finds send_message by its full name, a question reaches an agent that may be in the middle of a long turn (the mod injects it when
// the session is free), the answer comes back, and the asker removes its TODO comment.
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = process.argv[2];
if (!projectRoot) throw new Error('usage: requests-real-claude.ts <trusted-folder>');
// The run deletes files in the folder: never this repository, nor any checkout of it.
{
  const repo = resolve(import.meta.dirname, '..', '..').toLowerCase();
  const target = resolve(projectRoot);
  let name: unknown;
  try { name = (JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as { name?: unknown }).name; } catch { name = undefined; }
  const why = target.toLowerCase() === repo ? 'it is this repository' : name === 'multiconsole' ? 'it holds a copy of this repository (package.json name "multiconsole")' : undefined;
  if (why) {
    console.error(`refused: ${target} cannot be the working folder because ${why}; pass a throw-away folder Claude Code trusts`);
    process.exit(2);
  }
}

process.env.CONSOLE_TEST = '1';
const { startServer } = await import('../../src/server/index');

const configDir = mkdtempSync(join(tmpdir(), 'real-req-cfg-'));
writeFileSync(join(configDir, 'config.json'), JSON.stringify({ schema: 1, language: 'en', git: { worktrees: false }, claude: { command: ['claude', '--model', 'haiku'] } }));
rmSync(join(projectRoot, '.andromedaconsole'), { recursive: true, force: true });
for (const f of ['notes.txt', 'result.txt']) rmSync(join(projectRoot, f), { force: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ESC = String.fromCharCode(27);
const strip = (t: string) => t.replace(new RegExp(`${ESC}\\[[0-9;?<>=]*[ -/]*[@-~]`, 'g'), '').replace(new RegExp(`${ESC}\\][^\\x07]*\\x07`, 'g'), '');
async function until(f: () => Promise<boolean>, ms: number): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await f()) return true; await sleep(1000); }
  return false;
}

const started = Date.now();
const s = await startServer({ port: 0, projectRoot, configDir, projectName: 'reqtest' });
const ui = async (path: string, method = 'GET', body?: unknown) => {
  const r = await fetch(`${s.url}${path}`, {
    method, headers: { authorization: `Bearer ${s.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return r.json() as Promise<any>;
};
const snapshot = async (slug: string) => strip((await ui(`/api/debug/snapshot/${slug}`)).text ?? '');
const answers = async (slug: string): Promise<string> => ((await ui(`/api/reading/${slug}`)).entries as { text: string }[]).map((e) => e.text).join('\n---\n');
async function type(slug: string, text: string): Promise<void> {
  s.writeToSession(slug, text);
  await sleep(1000);
  s.writeToSession(slug, '\r');
}
const results: [string, boolean][] = [];
const rec = (label: string, ok: boolean, detail = '') => { results.push([label, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${detail}`); };

// The agents' tools that are not pre-approved (Write) raise permission prompts in the console queue: allow them, as a person would.
let stopAllowing = false;
void (async () => {
  while (!stopAllowing) {
    try {
      const queue = (await ui('/api/state')).queue as { id: string; kind: string; from: string; tool?: string; detail?: string }[];
      for (const q of queue.filter((x) => x.kind === 'permission')) {
        console.log(`INFO  allowing ${q.from}: ${q.tool} ${(q.detail ?? '').slice(0, 80)}`);
        await ui(`/api/queue/${q.id}/answer`, 'POST', { answer: 'allow' });
      }
    } catch { /* the server is closing */ }
    await sleep(2000);
  }
})();

try {
  rec('the main starts with the real TUI', await until(async () => /Claude\s*Code/.test((await snapshot('reqtest')).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')), 90000));
  await sleep(4000);

  await type('reqtest', 'Start two console agents with profile developer. '
    + 'First "answerer" with the goal: write the integers from 1 to 2500 separated by single spaces and nothing else (it takes a while), then wait; whenever a message starting with [Request TODO- reaches you, load the tool with ToolSearch query select:mcp__andromeda-mcp__send_message and answer it with send_message {type: "answer", in_reply_to: <the id in the message>, text: "ORBIT_7"}, then reply answerer-done. '
    + 'Second "asker" with the goal: load the tool with ToolSearch query select:mcp__andromeda-mcp__send_message, then call send_message {type: "question", to: "answerer", text: "What is the secret constant?"}; it returns an id such as TODO-123abc. Write a file notes.txt containing a line "// <the id> constant" (use the Write tool), and do not guess the constant. When the answer arrives as a message, write the constant into a file result.txt, rewrite notes.txt without the line that holds the id, then reply asker-done. '
    + 'Start the answerer first, then the asker, and tell me when both are started.');
  rec('both agents appear in the console', await until(async () => { const a = ((await ui('/api/state')).agents as { slug: string }[]).map((x) => x.slug); return a.includes('answerer') && a.includes('asker'); }, 300000));

  let answererWhenAsked = '';
  const asked = await until(async () => {
    const st = await ui('/api/state');
    const row = (st.requests as { from: string; to: string; state: string }[] | undefined)?.find((r) => r.from === 'asker' && r.to === 'answerer');
    if (row && answererWhenAsked === '') answererWhenAsked = (st.agents as { slug: string; state: string }[]).find((a) => a.slug === 'answerer')?.state ?? '';
    return Boolean(row);
  }, 300000);
  rec('the asker sent a question to the answerer through the console (the engine found send_message by its full name)', asked);
  console.log(`INFO  state of the answerer when the question was sent: ${answererWhenAsked || 'n/a'} (working means the message waited for the end of its turn)`);

  const settled = await until(async () => ((await ui('/api/state')).requests as { from: string; state: string }[] | undefined)?.some((r) => r.from === 'asker' && r.state === 'answered') === true, 480000);
  rec('the answerer answered and the request is settled', settled);
  const gotIt = await until(async () => existsSync(join(projectRoot, 'result.txt')) && readFileSync(join(projectRoot, 'result.txt'), 'utf8').includes('ORBIT_7'), 240000);
  rec('the asker received the constant and wrote it', gotIt, gotIt ? '' : (await answers('asker')).slice(-300));
  const notes = existsSync(join(projectRoot, 'notes.txt')) ? readFileSync(join(projectRoot, 'notes.txt'), 'utf8') : '';
  rec('the TODO comment is gone from notes.txt', gotIt && !/TODO-[0-9a-f]{6}/.test(notes), notes.slice(0, 200));
  rec('the asker finished', await until(async () => (await answers('asker')).includes('asker-done'), 240000));
} finally {
  stopAllowing = true;
  await s.close();
  rmSync(join(projectRoot, '.andromedaconsole'), { recursive: true, force: true });
  for (const f of ['notes.txt', 'result.txt']) rmSync(join(projectRoot, f), { force: true });
}
const failed = results.filter(([, ok]) => !ok).length;
console.log(`${failed === 0 ? 'REAL REQUESTS CONTRACT PASSED' : `${failed} FAILED`} in ${Math.round((Date.now() - started) / 1000)} s`);
process.exit(failed === 0 ? 0 : 1);
