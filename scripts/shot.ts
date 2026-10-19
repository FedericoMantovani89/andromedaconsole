// `npm run shot -- <options>`: a screenshot of the real UI in Edge, from a throw-away console (fake agent, a temporary config and project).
//   --tab <name>      open the Options dialog on that tab (models, profiles, budget, guard, notifications, language, prerequisites, plugins, projects, git)
//   --lang <code>     interface language (default en)
//   --folder <kind>   the project folder: plain (not a repository, default), repo (a repository with one commit; the default with --states, --many or --agents), mixed (not a repository, holds one), multi (not a repository, holds abc-be and abc-fe)
//   --split <pct>     the main column's share of the width (what dragging the divider remembers), for example 30 or 75
//   --states          one agent per state (the page's state messages are rewritten: starting, working, waiting, idle with a merged ticket, studying, blocked,
//                     interrupted, finished, suspended, dormant, queued), to see every button and chip; four are real panels, the rest bars
//   --fake-mic        a fake microphone (Edge plays a beep into it) with the permission already given, for the dictation dialog
//   --wait <ms>       wait this long after the clicks and before the shot (a recording running for a while, for example)
//   --groq            answer that a Groq key is set (the dictation dialog then shows its recording form)
//   --fill <css::text> type text into an element after the clicks (repeatable)
//   --scroll          scroll the agents column to its end before the shot
//   --many <n>        n agents in the list: four are real (panels), the rest exist only in the page's state messages (bars); prints how the agents column scrolls
//   --agents <n>      start n fake agents (the limits on running agents are raised for the shot) and wait for their panels
//   --update <phase>  show the update chip as the desktop app would offer it: available, downloading or ready (version 0.0.2)
//   --hover <css>     hover this element before the shot (a tooltip, for example)
//   --click <css>     click this element first (repeatable)
//   --out <file>      where to write the PNG (default: shot.png in the temp folder; the path is printed)
// It writes a config file first (without one the first-start wizard covers the page), waits for the splash to go, and always ends the
// process itself (closing a server with a PTY child can hang on Windows).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

process.env.CONSOLE_TEST = '1';

const args = process.argv.slice(2);
const one = (name: string, fallback?: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const many = (name: string): string[] => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []));
const tab = one('tab');
const lang = one('lang', 'en')!;
// Agents need a git repository to start in (a plain folder answers 422 git.notRepo), so asking for agents makes the folder one.
const wantsAgents = args.includes('--states') || Number(one('many', '0')) > 0 || Number(one('agents', '0')) > 0;
const kind = one('folder', wantsAgents ? 'repo' : 'plain')!;
const split = one('split');
const manyCount = Number(one('many', '0'));
const states = args.includes('--states') || manyCount > 0;
const agentCount = states ? 4 : Number(one('agents', '0'));
if (!Number.isInteger(agentCount) || agentCount < 0 || agentCount > 9) { console.error('--agents is a number from 0 to 9'); process.exit(1); }
const updatePhase = one('update') as 'available' | 'downloading' | 'ready' | undefined;
if (updatePhase !== undefined && !['available', 'downloading', 'ready'].includes(updatePhase)) { console.error('--update is available, downloading or ready'); process.exit(1); }
const out = resolve(one('out') ?? join(tmpdir(), 'shot.png'));
if (!['plain', 'repo', 'mixed', 'multi'].includes(kind)) { console.error('--folder is plain, repo, mixed or multi'); process.exit(1); }

const { startServer } = await import('../src/server/index');
const root = resolve(import.meta.dirname, '..');
const fixture = join(root, 'test', 'fixtures', 'fake-agent.cjs');
const git = (cwd: string, ...a: string[]): void => { execFileSync('git', ['-c', 'user.name=Shot', '-c', 'user.email=shot@example.com', ...a], { cwd, stdio: 'ignore' }); };

const configDir = mkdtempSync(join(tmpdir(), 'shot-cfg-'));
const project = mkdtempSync(join(tmpdir(), 'shot-proj-'));
writeFileSync(join(configDir, 'config.json'), JSON.stringify({ schema: 1, language: lang, ...(agentCount > 0 ? { agents: { maxActiveGlobal: 12, maxActivePerProject: 12 } } : {}) })); // a saved config: no first-start wizard
if (kind === 'repo') { git(project, 'init', '-q', '-b', 'main'); writeFileSync(join(project, 'README.md'), 'hello\n'); git(project, 'add', '-A'); git(project, 'commit', '-q', '-m', 'init'); }
if (kind === 'mixed') { const sub = join(project, 'sub-repo'); mkdirSync(sub); git(sub, 'init', '-q', '-b', 'main'); }
if (kind === 'multi') {
  // abc-be detects nothing (no build file), abc-fe detects `npm test`: the Project tab shows a row per repository, one with n/a.
  for (const name of ['abc-be', 'abc-fe']) { const sub = join(project, name); mkdirSync(sub); git(sub, 'init', '-q', '-b', 'main'); }
  writeFileSync(join(project, 'abc-fe', 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  // A first commit and the project branch in each: the Git tab's try checkouts can be prepared (`--click 'button[name="tryPrepare"]'`).
  for (const name of ['abc-be', 'abc-fe']) { const sub = join(project, name); git(sub, 'add', '-A'); git(sub, 'commit', '-q', '--allow-empty', '-m', 'init'); git(sub, 'branch', 'project/shot-demo'); }
}

const server = await startServer({ port: 0, projectRoot: project, projectName: 'shot-demo', configDir, claudeCommand: [process.execPath, fixture], modDir: null, projectsDir: tmpdir(),
  ...(updatePhase ? { updates: { state: () => ({ phase: updatePhase, version: '0.0.2', ...(updatePhase === 'downloading' ? { percent: 40 } : {}) }), download: () => undefined, install: () => undefined, onChange: () => undefined } } : {}) } as Parameters<typeof startServer>[0]);
const fakeMic = args.includes('--fake-mic');
const browser = await chromium.launch({ channel: 'msedge', headless: true, ...(fakeMic ? { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } : {}) });
let failed = false;
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, ...(fakeMic ? { permissions: ['microphone'] } : {}) });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') console.error(`console error: ${m.text()}`); });
  if (args.includes('--groq')) await page.route((url) => url.pathname === '/api/secrets', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ groq: { set: true, preview: 'gsk_a*****' } }) }));
  if (split) await page.addInitScript((v) => { try { localStorage.setItem('console.split', v); } catch { /* not remembered */ } }, split);
  if (states) {
    // The first four agents are real (panels); the page is told they, and seven more that exist only in the message, are in one state each.
    type Row = { slug: string; state: string; status?: string; ticket?: { status: string; round: number; maxRounds: number }; progress?: { done: number; total: number }; waiting?: number; budget?: { used: number; limit: number; step: string }; stale?: true };
    const DEMO: Row[] = [
      { slug: 'starting-agent', state: 'starting' },
      { slug: 'working-agent', state: 'working', progress: { done: 2, total: 6 }, budget: { used: 40_000, limit: 100_000, step: 'ok' } },
      { slug: 'waiting-agent', state: 'waiting_user', waiting: 1, progress: { done: 3, total: 6 } },
      { slug: 'merged-idle-agent', state: 'idle', ticket: { status: 'merged', round: 0, maxRounds: 2 }, progress: { done: 6, total: 6 } },
      { slug: 'studying-agent', state: 'studying' },
      { slug: 'blocked-agent', state: 'blocked', progress: { done: 1, total: 5 } },
      { slug: 'interrupted-agent', state: 'interrupted', status: 'exited' },
      { slug: 'finished-agent', state: 'finished', status: 'exited', ticket: { status: 'released', round: 0, maxRounds: 2 } },
      { slug: 'suspended-agent', state: 'suspended', status: 'exited', ticket: { status: 'suspended_limit', round: 0, maxRounds: 2 }, progress: { done: 2, total: 5 }, budget: { used: 100_000, limit: 100_000, step: 'stopped' } },
      { slug: 'dormant-agent', state: 'dormant', status: 'exited', stale: true },
      { slug: 'queued-agent', state: 'queued', status: 'pending' },
    ];
    if (manyCount > 0) {
      const CYCLE: Row[] = [
        { slug: '', state: 'working', progress: { done: 2, total: 6 }, budget: { used: 40_000, limit: 100_000, step: 'ok' } },
        { slug: '', state: 'idle', ticket: { status: 'merged', round: 0, maxRounds: 2 }, progress: { done: 6, total: 6 } },
        { slug: '', state: 'finished', status: 'exited', ticket: { status: 'released', round: 0, maxRounds: 2 } },
        { slug: '', state: 'dormant', status: 'exited', stale: true },
        { slug: '', state: 'waiting_user', waiting: 1, progress: { done: 3, total: 6 } },
        { slug: '', state: 'suspended', status: 'exited', ticket: { status: 'suspended_limit', round: 0, maxRounds: 2 }, progress: { done: 2, total: 5 } },
      ];
      DEMO.length = 0;
      for (let i = 0; i < manyCount; i++) DEMO.push({ ...CYCLE[i % CYCLE.length]!, slug: `job-${String(i + 1).padStart(2, '0')}-${['login', 'billing', 'search', 'export', 'upload', 'audit'][i % 6]}` });
    }
    // What the dormant demo agent last said, for its expanded panel (the read panel's entries).
    await page.route((url) => url.pathname === '/api/reading/dormant-agent', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [
      { text: 'Step 3 of 5 done: the CSV export endpoint returns the rows in the order of the table and the tests for it pass.' },
      { text: 'Next I was going to add the pagination parameters (page and size) to the same endpoint and cover them with tests. I stopped because the console restarted; nothing is uncommitted, the last commit is the step 3 one.' },
    ] }) }));
    await page.routeWebSocket((url) => url.pathname === '/ws/ui', (ws) => {
      const upstream = ws.connectToServer();
      ws.onMessage((m) => upstream.send(m));
      upstream.onMessage((m) => {
        try {
          const msg = JSON.parse(String(m)) as { type: string; agents?: Array<Record<string, unknown>> };
          if (msg.type === 'state' && Array.isArray(msg.agents)) {
            const main = msg.agents.filter((a) => a.role === 'main');
            const real = msg.agents.filter((a) => a.role !== 'main');
            const rows = DEMO.map((d, i) => ({ ...(real[i] ?? { profile: 'developer', role: 'agent', status: 'running' }), ...d, slug: real[i]?.slug ?? d.slug }));
            msg.agents = [...main, ...rows];
          }
          ws.send(JSON.stringify(msg));
        } catch { ws.send(m); }
      });
    });
  }
  await page.goto(server.loginUrl()); // the real way in: a single-use code the page swaps for the token
  await page.waitForSelector('#splash', { state: 'hidden', timeout: 40_000 });
  console.log(`address after load: ${page.url()}`);
  const NAMES = ['fix-login-timeout', 'add-export-csv', 'refactor-billing-api', 'update-readme-docs', 'speed-up-search-index', 'migrate-user-table', 'cleanup-old-jobs', 'add-dark-mode', 'harden-upload-limits'];
  for (const slug of NAMES.slice(0, agentCount)) {
    const r = await fetch(`${server.url}/api/agents`, { method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ slug, profile: 'developer' }) });
    if (!r.ok) throw new Error(`could not start ${slug}: ${r.status}`);
  }
  if (agentCount > 0) await page.waitForTimeout(6000);
  if (tab) {
    await page.click('#settings-btn');
    await page.click(`.options-tab[data-tab="${tab}"]`);
    await page.waitForTimeout(600);
  }
  for (const sel of many('click')) await page.click(sel);
  for (const f of many('fill')) { const at = f.indexOf('::'); await page.fill(f.slice(0, at), f.slice(at + 2)); }
  if (manyCount > 0 || agentCount > 0) {
    await page.waitForTimeout(1500);
    console.log(JSON.stringify(await page.evaluate(() => {
      const col = document.querySelector('.project-agents') as HTMLElement;
      const cs = getComputedStyle(col);
      return { agentsColumn: { clientHeight: col.clientHeight, scrollHeight: col.scrollHeight, overflowY: cs.overflowY, children: col.children.length }, panels: Array.from(col.querySelectorAll(':scope > .panel')).map((p) => (p as HTMLElement).offsetHeight), newAgent: (col.querySelector('.new-agent-wrap') as HTMLElement | null)?.offsetHeight, page: { innerHeight: innerHeight, documentScrollHeight: document.documentElement.scrollHeight, bodyScrollHeight: document.body.scrollHeight } };
    })));
  }
  if (args.includes('--scroll')) { await page.evaluate(() => { const col = document.querySelector('.project-agents') as HTMLElement; col.scrollTop = col.scrollHeight; }); await page.waitForTimeout(300); }
  if (one('wait')) await page.waitForTimeout(Number(one('wait')));
  const hover = one('hover');
  if (hover) { await page.hover(hover); await page.waitForTimeout(300); }
  await page.screenshot({ path: out });
  console.log(out);
} catch (e) {
  failed = true;
  console.error(`shot failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
} finally {
  setTimeout(() => process.exit(failed ? 1 : 0), 3000).unref();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
