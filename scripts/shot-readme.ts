// `npm run shot:readme`: the screenshots of the README, in `assets/screenshots/`, from a throw-away console running a made-up demo
// project (an Android dice app). The agents are `scripts/demo-agent.cjs`, which prints staged screens, and the page's state messages are
// rewritten so each agent is in the state the picture needs. Nothing here is a real Claude run.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

process.env.CONSOLE_TEST = '1';

const { startServer } = await import('../src/server/index');
const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'assets', 'screenshots');
mkdirSync(outDir, { recursive: true });
const git = (cwd: string, ...a: string[]): void => { execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', ...a], { cwd, stdio: 'ignore' }); };

const configDir = mkdtempSync(join(tmpdir(), 'readme-cfg-'));
const project = mkdtempSync(join(tmpdir(), 'readme-proj-'));
writeFileSync(join(configDir, 'config.json'), JSON.stringify({ schema: 1, language: 'en', agents: { maxActiveGlobal: 12, maxActivePerProject: 12 } }));
git(project, 'init', '-q', '-b', 'main');
writeFileSync(join(project, 'README.md'), '# dice-roller\n');
git(project, 'add', '-A');
git(project, 'commit', '-q', '-m', 'init');

const server = await startServer({
  port: 0, projectRoot: project, projectName: 'dice-roller', configDir, modDir: null, projectsDir: tmpdir(),
  claudeCommand: [process.execPath, join(root, 'scripts', 'demo-agent.cjs')],
} as Parameters<typeof startServer>[0]);

type Row = Record<string, unknown> & { slug: string };
const AGENTS: Row[] = [
  { slug: 'dice-logic', state: 'working', progress: { done: 3, total: 5 }, budget: { used: 152_000, limit: 400_000, step: 'ok' } },
  { slug: 'dice-ui', state: 'waiting_user', waiting: 1, progress: { done: 2, total: 6 } },
  { slug: 'dice-tests', state: 'idle', ticket: { status: 'in_review', round: 0, maxRounds: 2 }, progress: { done: 4, total: 4 } },
  { slug: 'dice-docs', state: 'idle', ticket: { status: 'merged', round: 0, maxRounds: 2 }, progress: { done: 3, total: 3 } },
];
const QUESTION = { id: 'q1', from: 'dice-ui', kind: 'question', text: 'Should the die vibrate when it lands?', options: ['Yes, a short tick', 'No', 'Only on a 6'], createdAt: new Date().toISOString() };

const browser = await chromium.launch({ channel: 'msedge', headless: true });
let failed = false;
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  let bypass = false;
  await page.routeWebSocket((url) => url.pathname === '/ws/ui', (ws) => {
    const upstream = ws.connectToServer();
    ws.onMessage((m) => upstream.send(m));
    upstream.onMessage((m) => {
      try {
        const msg = JSON.parse(String(m)) as { type: string; main?: Record<string, unknown>; agents?: Array<Record<string, unknown>>; queue?: unknown[]; quota?: unknown; settings?: Record<string, unknown> };
        if (msg.type === 'state' && Array.isArray(msg.agents)) {
          if (msg.main) msg.main = { ...msg.main, state: 'idle' };
          const main = msg.agents.filter((a) => a.role === 'main').map((a) => ({ ...a, state: 'idle' }));
          const real = msg.agents.filter((a) => a.role !== 'main');
          msg.agents = [...main, ...AGENTS.map((d, i) => ({ ...(real[i] ?? { profile: 'developer', role: 'agent', status: 'running' }), ...d }))];
          msg.queue = [QUESTION];
          msg.quota = { percent: 34, kind: 'five_hour' };
          if (bypass && msg.settings) msg.settings = { ...msg.settings, bypassPermissions: true };
        }
        ws.send(JSON.stringify(msg));
      } catch { ws.send(m); }
    });
  });
  await page.goto(server.loginUrl());
  await page.waitForSelector('#splash', { state: 'hidden', timeout: 40_000 });
  for (const slug of AGENTS.map((a) => a.slug)) {
    const r = await fetch(`${server.url}/api/agents`, { method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ slug, profile: 'developer' }) });
    if (!r.ok) throw new Error(`could not start ${slug}: ${r.status} ${await r.text()}`);
  }
  await page.waitForTimeout(6000);

  await page.screenshot({ path: join(outDir, 'console.png') });
  console.log('console.png');

  // The checklist an agent keeps: the demo agent writes none, so the endpoint answers with staged steps.
  await page.route(/\/api\/agents\/dice-logic\/checklist(\?|$)/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ steps: [
      { n: 1, title: 'DiceRoller.roll() returns a face', done: true },
      { n: 2, title: 'Unit tests for the 1-6 range', done: true },
      { n: 3, title: 'Seed the random source so a test can fix a roll', done: true },
      { n: 4, title: 'Expose the last roll to the screen', done: false },
      { n: 5, title: 'Run the module tests and deliver', done: false },
    ] }),
  }));
  await page.getByText('3/5', { exact: true }).click();
  await page.waitForSelector('.checklist-dialog');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, 'checklist.png') });
  console.log('checklist.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  await page.click('#queue-btn');
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(outDir, 'queue.png') });
  console.log('queue.png');
  await page.keyboard.press('Escape');
  await page.click('#queue-btn').catch(() => undefined);

  bypass = true;
  await page.reload();
  await page.waitForSelector('#splash', { state: 'hidden', timeout: 40_000 });
  await page.waitForTimeout(2500);
  await page.click('#settings-btn');
  await page.click('.options-tab[data-tab="guard"]');
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(outDir, 'guard.png') });
  console.log('guard.png');
} catch (e) {
  failed = true;
  console.error(`shot failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
} finally {
  setTimeout(() => process.exit(failed ? 1 : 0), 3000).unref();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
