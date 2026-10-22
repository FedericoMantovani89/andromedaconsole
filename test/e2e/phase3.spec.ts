// Phase 3 acceptance (SPEC 24): Edge against a real server, a real temporary git repository with a bare remote, fake agent
// processes and a "fake mod" that speaks /v1 with each session's own token. Run with: npx tsx test/e2e/phase3.spec.ts
// (after `npm run build`).
import { chromium, type Browser, type Page } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeRepo, branchesOf, gitSync, type TestRepo } from '../git-helpers';

process.env.CONSOLE_TEST = '1';
const { startServer } = await import('../../src/server/index');

const root = resolve(import.meta.dirname, '..', '..');
const fixture = join(root, 'test', 'fixtures', 'fake-agent.cjs').replace(/\\/g, '/');
let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label} ${detail}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => Promise<boolean> | boolean, ms = 15000): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await f()) return true; await sleep(50); }
  return false;
}
const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];
const worktreeOf = (t: TestRepo, slug: string): string => join(t.base, 'my repo', '.andromedaconsole', 'worktrees', slug);
const gitFails = (cwd: string, ...args: string[]): boolean => {
  try { execFileSync('git', args, { cwd, stdio: 'ignore' }); return false; } catch { return true; }
};

const cleanups: (() => void)[] = [];
async function boot(o: { config?: Record<string, unknown>; testCommand?: string } = {}) {
  const t = makeRepo({ remote: true });
  const configDir = mkdtempSync(join(tmpdir(), 'e2e3-cfg-'));
  const configFile = join(configDir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ schema: 1, language: 'en', ...o.config }));
  const s = await startServer({
    port: 0, projectRoot: t.repo, configDir, projectName: 'shop-api', claudeCommand: [process.execPath, fixture], modDir: null,
  });
  const projectFile = join(t.repo, '.andromedaconsole', 'project.json');
  writeFileSync(projectFile, JSON.stringify({ ...JSON.parse(readFileSync(projectFile, 'utf8')), testCommand: o.testCommand ?? `node -e "require('fs').writeFileSync('validated.txt','ran')"` }));
  const call = async (token: string | undefined, path: string, method = 'GET', body?: unknown) => {
    const r = await fetch(`${s.url}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json: any = null;
    try { json = await r.json(); } catch { /* 204 */ }
    return { status: r.status, json };
  };
  const asMod = (slug: string, path: string, method = 'GET', body?: unknown) => call(s.sessionTokenFor(slug), path, method, body);
  const asUi = (path: string, method = 'GET', body?: unknown) => call(s.token, path, method, body);
  const event = (slug: string, type: string, data?: unknown) => asMod(slug, '/v1/events', 'POST', { type, sessionId: `sess-${slug}`, data });
  const spawn = (name: string, goal = 'Do the work') => asMod('shop-api', '/v1/tools/spawn_agent', 'POST', { name, profile: 'developer', goal });
  const tool = (slug: string, name: string, body: unknown) => asMod(slug, `/v1/tools/${name}`, 'POST', body);
  const guard = (slug: string, toolName: string, input: unknown) => asMod(slug, '/v1/guard', 'POST', { tool: toolName, input });
  const snapshot = async (slug: string): Promise<string> => (await asUi(`/api/debug/snapshot/${slug}`)).json.text;
  cleanups.push(() => rmSync(t.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));
  return { s, t, configFile, call, asMod, asUi, event, spawn, tool, guard, snapshot };
}

const browser: Browser = await chromium.launch({ channel: 'msedge', headless: true });
const open = async (url: string): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, locale: 'en-US' });
  await page.goto(url);
  return page;
};
const panel = (slug: string) => `.panel[data-slug="${slug}"]`;

try {
  // (the splash and the version are checked in section 1, while the splash is still up)
  // 1. Spawn creates the branch and worktree; the agent runs inside it and shows Studying
  {
    const { s, t, event, spawn, snapshot } = await boot();
    const page = await open(`${s.url}/?token=${s.token}`);
    await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
    const started = await spawn('fix-login-timeout');
    check('the start-up splash is shown with the picture and does not take clicks', (await page.evaluate(() => { const el = document.getElementById('splash'); const img = el?.querySelector('img'); return Boolean(el && img && img.complete && img.naturalWidth > 0 && getComputedStyle(el).pointerEvents === 'none'); })) === true);
    check('the splash fades away by itself', await until(async () => await page.locator('#splash').isHidden(), 6000));
    check('the tab title is the commercial name and the build version', /^AndromedaConsole v\d+\.\d+\.\d+/.test(await page.title()), await page.title());
    check('the splash shows the same version over the picture', (await page.locator('#splash-version').textContent())?.trim() === (await page.title()).replace('AndromedaConsole ', ''), String(await page.locator('#splash-version').textContent()));
    check('spawn in a repository starts the agent', started.json.status === 'started', JSON.stringify(started.json));
    const wt = worktreeOf(t, 'fix-login-timeout');
    const branches = gitSync(t.repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n');
    check('the project branch and the agent branch exist', branches.includes('project/shop-api') && branches.includes('agent/shop-api/fix-login-timeout'), branches.join(','));
    check('the worktree is a sibling folder of the repository', existsSync(wt));
    check('the per-worktree pre-push script is written under .andromedaconsole', existsSync(join(t.repo, '.andromedaconsole', 'state', 'hooks', 'fix-login-timeout', 'pre-push')));
    check('the process runs inside the worktree', await until(async () => (await snapshot('fix-login-timeout')).toLowerCase().includes(`cwd ${wt}`.toLowerCase())), await snapshot('fix-login-timeout'));
    const chip = () => page.locator(`${panel('fix-login-timeout')} .panel-state`).innerText();
    await event('fix-login-timeout', 'session.start');
    await event('fix-login-timeout', 'turn.start');
    check('with no checklist yet the panel shows Studying', await until(async () => (await chip()) === 'Studying'), await chip());
    check('no progress chip before a checklist', (await page.locator(`${panel('fix-login-timeout')} .panel-progress`).isHidden()));
    await page.close();
    await s.close();
  }

  // 2. The whole ticket through the tools: commits, validation by the console, push, delivered
  {
    const { s, t, event, spawn, tool, asMod } = await boot();
    const page = await open(`${s.url}/?token=${s.token}`);
    await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
    await spawn('fix-login-timeout');
    await event('fix-login-timeout', 'session.start');
    await event('fix-login-timeout', 'turn.start');
    const wt = worktreeOf(t, 'fix-login-timeout');
    const bad = await tool('fix-login-timeout', 'checklist_set', { items: ['Implement', 'x'] });
    check('a checklist without the skeleton is refused with a code', bad.json.status === 'refused' && bad.json.code === 'too_short', JSON.stringify(bad.json));
    const set = await tool('fix-login-timeout', 'checklist_set', { items: ITEMS });
    check('a valid checklist is accepted', set.json.status === 'ok');
    const chip = () => page.locator(`${panel('fix-login-timeout')} .panel-state`).innerText();
    const progress = () => page.locator(`${panel('fix-login-timeout')} .panel-progress`).innerText();
    check('the panel shows Working and 0/6', await until(async () => (await chip()) === 'Working' && (await progress()) === '0/6'), `${await chip()} ${await progress()}`);
    for (let n = 1; n <= 6; n++) {
      if (n === 3) writeFileSync(join(wt, 'feature.txt'), 'implementation\n');
      if (n === 6) writeFileSync(join(wt, 'README.md'), 'hello docs\n');
      const r = await tool('fix-login-timeout', 'step_done', { n, note: 'a decent note for this step' });
      if (r.json.status !== 'closed') { check(`step ${n} closes`, false, JSON.stringify(r.json)); break; }
      if (n < 6) check(`progress shows ${n}/6`, await until(async () => (await progress()) === `${n}/6`), await progress());
    }
    const subjects = gitSync(wt, 'log', '--format=%s', 'project/shop-api..HEAD').split('\n').reverse();
    check('one commit per step with the spec messages', JSON.stringify(subjects) === JSON.stringify(ITEMS.map((x, i) => `step ${i + 1}/6: ${x}`)), subjects.join(' | '));
    const body = gitSync(wt, 'log', '-1', '--format=%B', 'HEAD');
    check('the commit carries the Agent, Ticket and Progetto trailers', body.includes('Agent: fix-login-timeout') && body.includes('Ticket: fix-login-timeout') && body.includes('Progetto: shop-api'), body);
    check('the validation really ran in the worktree (marker file)', existsSync(join(wt, 'validated.txt')));
    check('the branch reached the remote', branchesOf(t.remote).includes('agent/shop-api/fix-login-timeout'), branchesOf(t.remote).join(','));
    const inbox = (await asMod('shop-api', '/v1/inbox')).json.messages.map((m: any) => m.text as string);
    check('the main was told the ticket is delivered', inbox.some((x: string) => /delivered/.test(x) && x.includes('agent/shop-api/fix-login-timeout')), inbox.join(' | '));
    check('the agent never ran git commit: every commit is the console\'s', gitSync(wt, 'log', '--format=%an', 'project/shop-api..HEAD').split('\n').length === 6);
    await page.close();
    await s.close();
  }

  // 3. A secret in the worktree blocks the commit and the agent is told which file
  {
    const { s, t, spawn, tool } = await boot();
    await spawn('fix-login-timeout');
    const wt = worktreeOf(t, 'fix-login-timeout');
    await tool('fix-login-timeout', 'checklist_set', { items: ITEMS });
    await tool('fix-login-timeout', 'step_done', { n: 1, note: 'found it all in src' });
    writeFileSync(join(wt, '.env'), 'TOKEN=abc\n');
    const r = await tool('fix-login-timeout', 'step_done', { n: 2 });
    check('a staged .env refuses the step and names the file', r.json.status === 'refused' && r.json.code === 'secrets' && r.json.files?.length === 1 && r.json.files[0] === '.env', JSON.stringify(r.json));
    check('nothing was committed or left staged', gitSync(wt, 'log', '--format=%s', 'project/shop-api..HEAD').split('\n').length === 1 && gitSync(wt, 'diff', '--cached', '--name-only') === '');
    await s.close();
  }

  // 4. Pushes by hand from the worktree: the hook refuses everything but the agent's own branch
  {
    const { s, t, spawn, tool } = await boot();
    await spawn('fix-login-timeout');
    const wt = worktreeOf(t, 'fix-login-timeout');
    await tool('fix-login-timeout', 'checklist_set', { items: ITEMS });
    await tool('fix-login-timeout', 'step_done', { n: 1, note: 'found it all in src' });
    check('another ref is refused', gitFails(wt, 'push', 'origin', 'HEAD:refs/heads/other'));
    check('the project branch is refused', gitFails(wt, 'push', 'origin', 'HEAD:refs/heads/project/shop-api'));
    check('main is refused', gitFails(wt, 'push', 'origin', 'HEAD:refs/heads/main'));
    check('its own branch is accepted', !gitFails(wt, 'push', 'origin', 'HEAD'));
    gitSync(wt, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '--amend', '--allow-empty', '-m', 'rewritten');
    check('a forced rewrite of its own branch is refused', gitFails(wt, 'push', '--force', 'origin', 'HEAD'));
    check('a delete is refused', gitFails(wt, 'push', 'origin', '--delete', 'agent/shop-api/fix-login-timeout'));
    gitSync(wt, 'tag', 'v1');
    check('a tag is refused', gitFails(wt, 'push', 'origin', 'v1'));
    check('the remote only has the main branch and the agent branch', JSON.stringify(branchesOf(t.remote).sort()) === JSON.stringify(['agent/shop-api/fix-login-timeout', 'main']), branchesOf(t.remote).join(','));
    await s.close();
  }

  // 5. The guard through /v1/guard
  {
    const { s, t, spawn, guard } = await boot();
    await spawn('fix-login-timeout');
    const wt = worktreeOf(t, 'fix-login-timeout');
    const denied = async (tool: string, input: unknown): Promise<boolean> => (await guard('fix-login-timeout', tool, input)).json.decision === 'deny';
    check('git push --force is denied', await denied('Bash', { command: 'git push --force' }));
    check('a write outside the worktree is denied', await denied('Write', { file_path: join(t.base, 'outside.txt') }));
    check('a write with .. is denied', await denied('Write', { file_path: '..\\outside.txt' }));
    check('cat .env is denied', await denied('Bash', { command: 'cat .env' }));
    check('rm -rf .. is denied', await denied('Bash', { command: 'rm -rf ..' }));
    check('git commit by the agent is denied', await denied('Bash', { command: 'git commit -m x' }));
    check('git status is allowed', !(await denied('Bash', { command: 'git status' })));
    check('an edit inside the worktree is allowed', !(await denied('Edit', { file_path: join(wt, 'src', 'a.ts') })));
    check('npm test is allowed', !(await denied('PowerShell', { command: 'npm test' })));
    const log = readFileSync(join(t.repo, '.andromedaconsole', 'state', 'guard.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    check('every denial is in guard.jsonl and allows are not', log.length === 6 && log.every((l: any) => l.outcome === 'denied'), String(log.length));
    await s.close();
  }
  {
    const { s, t, spawn, guard } = await boot({ config: { guard: { mode: 'shadow' } } });
    await spawn('fix-login-timeout');
    const r = await guard('fix-login-timeout', 'Bash', { command: 'git push --force' });
    check('shadow mode allows what enforce would deny', r.json.decision === 'allow');
    const log = readFileSync(join(t.repo, '.andromedaconsole', 'state', 'guard.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    check('and logs it as shadow-allowed', log.length === 1 && log[0].outcome === 'shadow-allowed' && log[0].rule === 'git.force', JSON.stringify(log));
    await s.close();
  }

  // 6. report_blocked shows Blocked and clears on the next closed step
  {
    const { s, spawn, event, tool, asMod } = await boot();
    const page = await open(`${s.url}/?token=${s.token}`);
    await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
    await spawn('fix-login-timeout');
    await event('fix-login-timeout', 'session.start');
    await event('fix-login-timeout', 'turn.start');
    await tool('fix-login-timeout', 'checklist_set', { items: ITEMS });
    await tool('fix-login-timeout', 'report_blocked', { reason: 'need the database schema' });
    const chip = () => page.locator(`${panel('fix-login-timeout')} .panel-state`).innerText();
    check('the panel shows Blocked', await until(async () => (await chip()) === 'Blocked'), await chip());
    const inbox = (await asMod('shop-api', '/v1/inbox')).json.messages.map((m: any) => m.text as string);
    check('the main was told why', inbox.some((x: string) => x.includes('need the database schema')), inbox.join(' | '));
    await tool('fix-login-timeout', 'step_done', { n: 1, note: 'found it all in src' });
    check('the next closed step clears Blocked', await until(async () => (await chip()) === 'Working'), await chip());
    await page.close();
    await s.close();
  }

  // 7. A queued agent gets its worktree only when it starts
  {
    const { s, t, spawn, event } = await boot();
    s.setLimits({ global: 1, perProject: 1 });
    await spawn('first-job');
    const second = await spawn('second-job');
    check('the second agent is queued', second.json.status === 'queued', JSON.stringify(second.json));
    check('a queued agent has no worktree and no branch yet', !existsSync(worktreeOf(t, 'second-job')) && !gitSync(t.repo, 'branch', '--list', 'agent/*').includes('second-job'));
    await event('first-job', 'session.start'); await event('first-job', 'turn.start'); await event('first-job', 'turn.complete', { answer: 'done' });
    check('when its slot arrives it gets its worktree', await until(() => existsSync(worktreeOf(t, 'second-job'))));
    await s.close();
  }

  // 8. The Settings dialog: bypass switch with a warning, guard mode, test command; applies to later launches only
  {
    const { s, t, configFile, spawn } = await boot();
    const page = await open(`${s.url}/?token=${s.token}`);
    await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
    await spawn('first-job');
    await page.click('#settings-btn');
    await page.click('.options-tab[data-tab="guard"]');
    check('the dialog has a bypass switch that starts off', (await page.locator('input[name="bypass"]').count()) === 1 && !(await page.locator('input[name="bypass"]').isChecked()));
    check('the bypass warning is visible', (await page.locator('.settings-warning').innerText()).includes('guard is the only brake'));
    check('the dialog says, next to Save, that running agents are unaffected', (await page.locator('.options-foot .settings-note').innerText()).includes('restart to apply') || (await page.locator('.options-foot .settings-note').innerText()).includes('riavviare'));
    await page.check('input[name="bypass"]');
    await page.selectOption('select[name="guardMode"]', 'shadow');
    await page.click('.options-tab[data-tab="projects"]');
    await page.fill('input[name="testCommand"]', 'npx vitest run');
    check('nothing is saved before Save', JSON.parse(readFileSync(configFile, 'utf8')).agents?.bypassPermissions !== true);
    await page.click('button[name="saveOptions"]');
    check('the switch is saved in config.json', await until(() => JSON.parse(readFileSync(configFile, 'utf8')).agents?.bypassPermissions === true));
    check('the guard mode is saved', await until(() => JSON.parse(readFileSync(configFile, 'utf8')).guard?.mode === 'shadow'));
    check('the test command is saved in the project', await until(() => JSON.parse(readFileSync(join(t.repo, '.andromedaconsole', 'project.json'), 'utf8')).testCommand === 'npx vitest run'));
    check('the bypass change asks whether to restart the sessions', await until(async () => (await page.locator('.restart-dialog').count()) === 1));
    await page.click('button[name="restartNo"]');
    check('No closes the question and the dialog', await until(async () => await page.locator('#overlay').isHidden()));
    await spawn('second-job');
    check('the agent started before the change has no bypass', !s.lastLaunchArgs('first-job')!.includes('--dangerously-skip-permissions'));
    check('the agent started after it has', s.lastLaunchArgs('second-job')!.includes('--dangerously-skip-permissions'));
    await page.close();
    await s.close();
  }
} finally {
  await browser.close();
  await sleep(500);
  for (const c of cleanups) { try { c(); } catch { /* temp files */ } }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
