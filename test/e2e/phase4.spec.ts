// Phase 4 acceptance (SPEC 24): Edge against a real server, a real temporary git repository with a bare remote, fake agent
// processes and a "fake mod" that speaks /v1 with each session's own token. Run with: npx tsx test/e2e/phase4.spec.ts
// (after `npm run build`).
import { chromium, type Browser, type Page } from 'playwright-core';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo, gitSync, type TestRepo } from '../git-helpers';
import { untilEnd } from '../until-end';

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
async function until(f: () => Promise<boolean> | boolean, ms = 20000): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await f()) return true; await sleep(100); }
  return false;
}
const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];
const NOTES = [{ severity: 'high', where: 'src/math.js:3', text: 'negative input is not handled' }];
const worktreeOf = (t: TestRepo, slug: string): string => join(t.base, 'my repo', '.andromedaconsole', 'worktrees', slug);
const gitFails = (cwd: string, ...args: string[]): boolean => {
  try { execFileSync('git', args, { cwd, stdio: 'ignore' }); return false; } catch { return true; }
};

const cleanups: (() => void)[] = [];
async function boot() {
  const t = makeRepo({ remote: true });
  const configDir = mkdtempSync(join(tmpdir(), 'e2e4-cfg-'));
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ schema: 1, language: 'en' }));
  const s = await startServer({ port: 0, projectRoot: t.repo, configDir, projectName: 'shop-api', claudeCommand: [process.execPath, fixture], modDir: null });
  s.setLimits({ global: 20, perProject: 20 });
  const projectFile = join(t.repo, '.andromedaconsole', 'project.json');
  writeFileSync(projectFile, JSON.stringify({ ...JSON.parse(readFileSync(projectFile, 'utf8')), testCommand: 'node -e "process.exit(0)"' }));
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
  const tool = (slug: string, name: string, body: unknown = {}) => asMod(slug, `/v1/tools/${name}`, 'POST', body);
  const spawn = (name: string, goal = 'Do the work') => tool('shop-api', 'spawn_agent', { name, profile: 'developer', goal });
  const inbox = async (slug: string): Promise<string[]> => (await asMod(slug, '/v1/inbox')).json.messages.map((m: any) => m.text as string);
  /** The Phase 3 flow, end to end: spawn, checklist, six steps. The ticket ends delivered. */
  const deliver = async (slug: string, files: Record<string, string>, goal = 'Add the feature'): Promise<void> => {
    const sp = await spawn(slug, goal);
    if (sp.json.status !== 'started') throw new Error(`spawn ${slug}: ${JSON.stringify(sp.json)}`);
    await tool(slug, 'checklist_set', { items: ITEMS });
    const wt = worktreeOf(t, slug);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(wt, name), content);
    for (let n = 1; n <= 6; n++) {
      if (n === 6) writeFileSync(join(wt, 'README.md'), `docs by ${slug}\n`);
      const r = await tool(slug, 'step_done', { n, note: 'a decent note for this step' });
      if (r.json.status !== 'closed') throw new Error(`step ${n} of ${slug}: ${JSON.stringify(r.json)}`);
    }
  };
  const rework = async (slug: string, from: number): Promise<void> => {
    const wt = worktreeOf(t, slug);
    writeFileSync(join(wt, `fix-${from}.js`), `fix ${from}\n`);
    for (let n = from; n <= from + 2; n++) {
      if (n === from + 2) writeFileSync(join(wt, 'README.md'), `docs ${from}\n`);
      const r = await tool(slug, 'step_done', { n, note: 'a decent note for this step' });
      if (r.json.status !== 'closed') throw new Error(`rework step ${n} of ${slug}: ${JSON.stringify(r.json)}`);
    }
  };
  cleanups.push(() => rmSync(t.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));
  return { s, t, call, asMod, asUi, tool, spawn, inbox, deliver, rework };
}

const browser: Browser = await chromium.launch({ channel: 'msedge', headless: true });
const open = async (url: string): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, locale: 'en-US' });
  await page.goto(url);
  return page;
};
const panel = (slug: string) => `.panel[data-slug="${slug}"]`;
// Past four live agents the rest are bars: look for the slug in a panel header or in a bar.
const row = (page: Page, slug: string) => page.locator(`.panel[data-slug="${slug}"] .panel-header, .bar:has(.panel-title:text-is("${slug}"))`).first();
const chip = (page: Page, slug: string) => row(page, slug).locator('.panel-ticket');
const stateChip = (page: Page, slug: string) => row(page, slug).locator('.panel-state');

try {
  // 1. A delivered ticket: the console's facts and report; the panel shows the pipeline status
  {
    const { s, t, tool, deliver } = await boot();
    const page = await open(`${s.url}/?token=${s.token}`);
    await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
    await deliver('fix-login', { 'math.js': 'module.exports = {};\n' }, 'Fix the login so negative ids are rejected');
    check('the delivered ticket shows as Delivered in its panel', await until(async () => (await chip(page, 'fix-login').innerText().catch(() => '')) === 'Delivered'), await chip(page, 'fix-login').innerText().catch(() => ''));
    const r = await tool('shop-api', 'ticket_report', { name: 'fix-login' });
    check('ticket_report gives the facts: tests rerun by the console, checklist complete, docs changed', r.json.status === 'ok' && r.json.facts.testsOk === true && r.json.facts.checklistComplete === true && r.json.facts.docsChanged === true, JSON.stringify(r.json.facts));
    check('report.md is written on disk with the objective', existsSync(join(t.repo, '.andromedaconsole', 'tickets', 'fix-login', 'report.md')) && readFileSync(join(t.repo, '.andromedaconsole', 'tickets', 'fix-login', 'report.md'), 'utf8').includes('Fix the login so negative ids are rejected'));
    await page.close();
    await s.close();
  }

  // 2. A known defect is rejected; after two rework rounds the third failure goes to the user (queue); the user decides
  {
    const { s, t, tool, deliver, rework, inbox, asUi } = await boot();
    const page = await open(`${s.url}/?token=${s.token}`);
    await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
    await deliver('fix-login', { 'math.js': 'module.exports = { half: (n) => n / 2 };\n' }, 'half(n) must reject negative numbers');
    const rv = await tool('shop-api', 'request_review', { name: 'fix-login' });
    check('request_review starts a reviewer', rv.json.status === 'ok' && rv.json.reviewer === 'review-fix-login', JSON.stringify(rv.json));
    check('the reviewer appears in the workspace', await until(async () => (await row(page, 'review-fix-login').count()) > 0));
    const rvwt = worktreeOf(t, 'review-fix-login');
    check('the reviewer works in a detached checkout of the delivered commit', gitSync(rvwt, 'rev-parse', 'HEAD') === gitSync(worktreeOf(t, 'fix-login'), 'rev-parse', 'HEAD') && gitFails(rvwt, 'symbolic-ref', '-q', 'HEAD'));
    const guard = async (tl: string, input: unknown) => (await asUi('/api/state')) && (await (await fetch(`${s.url}/v1/guard`, { method: 'POST', headers: { authorization: `Bearer ${s.sessionTokenFor('review-fix-login')}`, 'content-type': 'application/json' }, body: JSON.stringify({ tool: tl, input }) })).json());
    check('the reviewer cannot write a file (guard)', (await guard('Write', { file_path: 'x.md' })).rule === 'readonly.write' && (await guard('Bash', { command: 'echo x > y.txt' })).rule === 'readonly.write');
    check('the reviewer can read the diff (guard)', (await guard('Bash', { command: 'git diff project/shop-api...HEAD' })).decision === 'allow');

    const v1 = await tool('review-fix-login', 'review_verdict', { pass: false, notes: NOTES });
    check('a failed review returns the ticket to its author', v1.json.status === 'ok' && v1.json.outcome === 'sent_back', JSON.stringify(v1.json));
    const msg = (await inbox('fix-login')).find((m) => m.startsWith('Message from the main')) ?? '';
    check('the author gets the notes as a message from the main (not from the reviewer)', msg.includes('negative input is not handled') && !msg.includes('review-fix-login'), msg.slice(0, 120));
    check('the author panel shows Rework 1', await until(async () => (await chip(page, 'fix-login').innerText().catch(() => '')) === 'Rework 1'), await chip(page, 'fix-login').innerText().catch(() => ''));
    check('the reviewer session ended and its checkout is gone', await until(() => !existsSync(rvwt), 25000));
    await rework('fix-login', 7);
    await tool('shop-api', 'request_review', { name: 'fix-login' });
    await tool('review-fix-login-r2', 'review_verdict', { pass: false, notes: NOTES });
    await rework('fix-login', 10);
    await tool('shop-api', 'request_review', { name: 'fix-login' });
    const v3 = await tool('review-fix-login-r3', 'review_verdict', { pass: false, notes: NOTES });
    check('after two rework rounds the third failure goes to the user', v3.json.outcome === 'needs_user', JSON.stringify(v3.json));
    check('the panel shows Needs you', await until(async () => (await chip(page, 'fix-login').innerText().catch(() => '')) === 'Needs you'), await chip(page, 'fix-login').innerText().catch(() => ''));
    await page.keyboard.press('Alt+Q');
    check('the queue shows a decision with the reviewer notes', await until(async () => (await page.locator('#drawer .queue-decision').count()) === 1) && (await page.locator('#drawer .queue-decision').innerText()).includes('needs your decision'));
    await page.locator('#drawer .queue-decision details summary').first().click();
    check('the notes are readable in the decision', (await page.locator('#drawer .queue-decision').innerText()).includes('negative input is not handled'));
    await page.click('#drawer .queue-decision button[data-answer="approve"]');
    check('approving as it is moves the ticket to Approved', await until(async () => (await chip(page, 'fix-login').innerText().catch(() => '')) === 'Approved'), await chip(page, 'fix-login').innerText().catch(() => ''));
    check('the queue is empty again', await until(async () => (await page.locator('#drawer .queue-item').count()) === 0));
    await page.close();
    await s.close();
  }

  // 3. Merge in series; a conflict is never forced; the author is told and gets a ready conflict state
  {
    const { s, t, tool, deliver, inbox } = await boot();
    const page = await open(`${s.url}/?token=${s.token}`);
    await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
    await deliver('first-job', { 'src-a.js': 'a\n', 'shared.js': 'line from first\n' }, 'First change');
    await deliver('second-job', { 'src-b.js': 'b\n', 'shared.js': 'line from second\n' }, 'Second change');
    for (const slug of ['first-job', 'second-job']) {
      await tool('shop-api', 'request_review', { name: slug });
      await tool(`review-${slug}`, 'review_verdict', { pass: true, notes: [] });
    }
    const before = Number(gitSync(t.repo, 'rev-list', '--count', 'project/shop-api'));
    const m1 = await untilEnd(() => tool('shop-api', 'merge_ticket', { name: 'first-job' }), (r) => r.json?.status);
    check('the first ticket is squashed into the project branch as one commit', m1.json.status === 'merged' && Number(gitSync(t.repo, 'rev-list', '--count', 'project/shop-api')) === before + 1, JSON.stringify(m1.json));
    check('its message follows the console\'s format', gitSync(t.repo, 'log', '-1', '--format=%B', 'project/shop-api').startsWith('ticket first-job: First change') && gitSync(t.repo, 'log', '-1', '--format=%B', 'project/shop-api').includes('Reviewed-by: review-first-job (round 1)'));
    check('its session ended and its folder and local branch are gone', await until(async () => !existsSync(worktreeOf(t, 'first-job')) && gitSync(t.repo, 'branch', '--list', 'agent/shop-api/first-job') === ''));
    check('the first panel shows Finished and the ticket Merged', await until(async () => (await stateChip(page, 'first-job').innerText().catch(() => '')) === 'Finished' && (await chip(page, 'first-job').innerText().catch(() => '')) === 'Merged'));
    const tip = gitSync(t.repo, 'rev-parse', 'project/shop-api');
    const m2 = await untilEnd(() => tool('shop-api', 'merge_ticket', { name: 'second-job' }), (r) => r.json?.status);
    check('the conflicting ticket is not merged by force', m2.json.status === 'conflict' && m2.json.files.includes('shared.js') && gitSync(t.repo, 'rev-parse', 'project/shop-api') === tip, JSON.stringify(m2.json));
    check('the author got the files in a message from the main', (await inbox('second-job')).some((m) => m.startsWith('Message from the main') && m.includes('shared.js')));
    check('its folder is in the conflict state with markers it can edit', readFileSync(join(worktreeOf(t, 'second-job'), 'shared.js'), 'utf8').includes('<<<<<<<'));
    check('the panel shows Rework 1', await until(async () => (await chip(page, 'second-job').innerText().catch(() => '')) === 'Rework 1'), await chip(page, 'second-job').innerText().catch(() => ''));
    check('the main was told', (await inbox('shop-api')).some((m) => /second-job.*conflict/i.test(m)));
    await page.close();
    await s.close();
  }

  // 4. Release to origin/main: one confirmation in the queue, Reject touches nothing, Approve pushes through the console
  {
    const { s, t, tool, deliver, inbox } = await boot();
    const page = await open(`${s.url}/?token=${s.token}`);
    await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
    await deliver('fix-login', { 'login.js': 'login\n' }, 'Fix the login');
    await tool('shop-api', 'request_review', { name: 'fix-login' });
    await tool('review-fix-login', 'review_verdict', { pass: true, notes: [] });
    await untilEnd(() => tool('shop-api', 'merge_ticket', { name: 'fix-login' }), (r) => r.json?.status);
    const remoteBefore = gitSync(t.remote, 'rev-parse', 'main');

    check('the main cannot push main (guard): plain, forced, refspec, and by name from a tag', await (async () => {
      gitSync(t.repo, 'tag', 'v1');
      for (const command of ['git push origin main', 'git push --force origin main', 'git push origin HEAD:main', 'git push', 'git push origin v1']) {
        const d = (await (await fetch(`${s.url}/v1/guard`, { method: 'POST', headers: { authorization: `Bearer ${s.sessionTokenFor('shop-api')}`, 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'Bash', input: { command } }) })).json()) as { decision: string };
        if (d.decision !== 'deny') return false;
      }
      return true;
    })());
    writeFileSync(join(t.repo, 'local.txt'), 'x');
    gitSync(t.repo, 'add', '-A');
    gitSync(t.repo, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'a local commit');
    check('even without the guard, plain git refuses to push main from the checkout (hook)', gitFails(t.repo, 'push', 'origin', 'main') && gitFails(t.repo, 'push', '--force', 'origin', 'main') && gitFails(t.repo, 'push', 'origin', 'HEAD:main'));
    check('and refuses a tag', gitFails(t.repo, 'push', 'origin', 'v1'));
    check('origin/main did not move', gitSync(t.remote, 'rev-parse', 'main') === remoteBefore);
    gitSync(t.repo, 'reset', '-q', '--hard', 'HEAD~1');

    const r = await tool('shop-api', 'propose_release');
    check('propose_release asks the user', r.json.status === 'asked', JSON.stringify(r.json));
    await page.keyboard.press('Alt+Q');
    check('the queue shows one confirmation', await until(async () => (await page.locator('#drawer .queue-confirm').count()) === 1));
    const text = await page.locator('#drawer .queue-confirm').innerText();
    check('it names the project, the branch, the ticket and the test result', text.includes('shop-api') && text.includes('origin/main') && text.includes('fix-login') && /Tests of the project branch passed/.test(text), text.slice(0, 200));
    await page.locator('#drawer .queue-confirm details summary', { hasText: 'Ticket fix-login' }).click();
    await page.locator('#drawer .queue-confirm details details summary', { hasText: 'Report' }).click();
    check('the ticket report is readable inside the confirmation', (await page.locator('#drawer .queue-report').innerText()).includes('Fix the login'));
    await page.click('#drawer .queue-confirm button[data-answer="reject"]');
    check('Reject touches nothing', await until(async () => (await page.locator('#drawer .queue-confirm').count()) === 0) && gitSync(t.remote, 'rev-parse', 'main') === remoteBefore);
    check('the main is told it was rejected', await until(async () => (await inbox('shop-api')).some((m) => /rejected/i.test(m))));

    await tool('shop-api', 'propose_release');
    await until(async () => (await page.locator('#drawer .queue-confirm').count()) === 1);
    await page.click('#drawer .queue-confirm button[data-answer="approve"]');
    check('Approve moves origin/main to the project tip', await until(() => gitSync(t.remote, 'rev-parse', 'main') === gitSync(t.repo, 'rev-parse', 'project/shop-api'), 40000));
    check('the local main is the same and the file is in the checkout', gitSync(t.repo, 'rev-parse', 'main') === gitSync(t.remote, 'rev-parse', 'main') && existsSync(join(t.repo, 'login.js')));
    check('the ticket is Released', await until(async () => (await chip(page, 'fix-login').innerText().catch(() => '')) === 'Released'), await chip(page, 'fix-login').innerText().catch(() => ''));
    check('no release token is left behind', !existsSync(join(t.repo, '.git', 'console-hooks', 'release-token')));
    writeFileSync(join(t.repo, 'later.txt'), 'x');
    gitSync(t.repo, 'add', '-A');
    gitSync(t.repo, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'later');
    check('right after the release a plain push of main is refused again', gitFails(t.repo, 'push', 'origin', 'main'));
    await page.close();
    await s.close();
  }

  // 5. Settings: the squash switch is saved in the project
  {
    const { s, t } = await boot();
    const page = await open(`${s.url}/?token=${s.token}`);
    await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
    await page.click('#settings-btn');
    await page.click('.options-tab[data-tab="projects"]');
    check('the squash switch starts on', await page.locator('input[name="squash"]').isChecked());
    await page.uncheck('input[name="squash"]');
    await page.click('button[name="saveOptions"]');
    check('turning it off is saved in the project', await until(() => JSON.parse(readFileSync(join(t.repo, '.andromedaconsole', 'project.json'), 'utf8')).squash === false));
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
