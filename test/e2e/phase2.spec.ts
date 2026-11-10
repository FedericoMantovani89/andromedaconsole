// Phase 2 acceptance (SPEC 24): Edge against a real server; the agents are fake processes and a "fake mod" speaks /v1 with
// each session's own token, exactly as the real mod does. Run with: npx tsx test/e2e/phase2.spec.ts (after `npm run build`).
import { chromium, type Browser, type Page } from 'playwright-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
async function until(f: () => Promise<boolean> | boolean, ms = 10000): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await f()) return true; await sleep(50); }
  return false;
}

async function boot(limit = 4) {
  const configDir = mkdtempSync(join(tmpdir(), 'e2e2-cfg-'));
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ schema: 1, language: 'en', git: { worktrees: false } }));
  const s = await startServer({
    port: 0, projectRoot: mkdtempSync(join(tmpdir(), 'e2e2-project-')), configDir, projectName: 'shop-api',
    claudeCommand: [process.execPath, fixture], modDir: null,
  });
  s.setLimits({ global: limit, perProject: limit });
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
  const spawn = (name: string, goal = 'Do the work', profile = 'developer') => asMod('shop-api', '/v1/tools/spawn_agent', 'POST', { name, profile, goal });
  const agents = async () => (await asUi('/api/state')).json.agents as { slug: string; status: string; state: string }[];
  return { s, asMod, asUi, event, spawn, agents };
}

const browser: Browser = await chromium.launch({ channel: 'msedge', headless: true });
const open = async (url: string): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, locale: 'en-US' });
  await page.goto(url);
  return page;
};
const panel = (slug: string) => `.panel[data-slug="${slug}"]`;
const owner = (page: Page) => page.evaluate(() => (document.activeElement?.closest('.panel') as HTMLElement | null)?.dataset.slug ?? 'none');

try {
  // 1-2. The main launches an agent; the state comes from events, not from the terminal
  {
    const { s, event, spawn, agents } = await boot();
    const page = await open(`${s.url}/?token=${s.token}`);
    await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);

    const started = await spawn('fix-login-timeout', 'Fix the login timeout');
    check('main launches an agent with a valid name', started.json.status === 'started' && started.json.name === 'fix-login-timeout', JSON.stringify(started));
    const refused = await spawn('agent-1');
    check('a generic name is refused with its code', refused.json.status === 'error' && refused.json.code === 'slug.generic', JSON.stringify(refused));
    check('the new agent gets a panel', await until(async () => (await page.locator(panel('fix-login-timeout')).count()) > 0));
    const chip = () => page.locator(`${panel('fix-login-timeout')} .panel-state`).innerText();
    check('chip says Starting', await until(async () => (await chip()) === 'Starting'), await chip());

    await event('fix-login-timeout', 'session.start');
    check('session.start -> Idle', await until(async () => (await chip()) === 'Idle'), await chip());
    await event('fix-login-timeout', 'turn.start');
    check('turn.start -> Working', await until(async () => (await chip()) === 'Working'), await chip());
    // Misleading terminal text must not change the state: the terminal is a monitor, not a source
    await page.click(`${panel('fix-login-timeout')} .xterm`);
    await page.keyboard.type('Idle');
    await page.keyboard.press('Enter');
    await until(async () => ((await page.locator(`${panel('fix-login-timeout')} .xterm-rows`).innerText()) as string).includes('ECHO:Idle'));
    check('text printed in the terminal does not change the state', (await chip()) === 'Working', await chip());
    await event('fix-login-timeout', 'turn.complete', { answer: 'done' });
    check('turn.complete -> Idle', await until(async () => (await chip()) === 'Idle'), await chip());
    s.writeToSession('fix-login-timeout', 'quit\r');
    check('a dead process -> Interrupted', await until(async () => (await chip()) === 'Interrupted'), await chip());
    check('state API agrees', (await agents())[0]!.state === 'interrupted');
    await page.close();
    await s.close();
  }

  // 3. A question reaches the queue and the answer reaches the agent without touching the keyboard focus
  {
    const { s, asMod, event, spawn } = await boot();
    const page = await open(`${s.url}/?token=${s.token}`);
    await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
    await spawn('ask-agent');
    await event('ask-agent', 'session.start'); await event('ask-agent', 'turn.start');
    await until(async () => (await owner(page)) === 'shop-api');
    const q = await asMod('ask-agent', '/v1/tools/ask_user', 'POST', { question: 'Existing table or a new one?', options: ['Existing', 'New'] });
    const polling = asMod('ask-agent', `/v1/questions/${q.json.id}?wait=15`);
    check('the project tab shows a dot and the button counts the question',
      await until(async () => (await page.locator('#tabs .tab.attention').count()) === 1 && (await page.locator('#queue-btn').getAttribute('aria-label')) === 'Queue (1)'));
    check('the agent shows Waiting for you', await until(async () => (await page.locator(`${panel('ask-agent')} .panel-state`).innerText()) === 'Waiting for you'));
    await page.keyboard.press('Alt+Q');
    check('Alt+Q opens the queue with the question', await until(async () => (await page.locator('#drawer .queue-item').count()) === 1));
    check('the question text and its asker are shown', (await page.locator('#drawer .queue-text').innerText()) === 'Existing table or a new one?' && (await page.locator('#drawer .queue-from').innerText()) === 'From ask-agent');
    const before = await owner(page);
    await page.click('#drawer .queue-options button:has-text("New")');
    const answer = await polling;
    check('the answer reaches the waiting agent', answer.json.answered === true && answer.json.answer === 'New', JSON.stringify(answer.json));
    check('answering from the queue did not move the keyboard focus', before === 'shop-api' && (await owner(page)) === 'shop-api', `${before} -> ${await owner(page)}`);
    check('the queue empties and the agent works again', await until(async () => (await page.locator('#drawer .queue-item').count()) === 0 && (await page.locator(`${panel('ask-agent')} .panel-state`).innerText()) === 'Working'));
    await page.close();
    await s.close();
  }

  // 3b. An agent's permission prompt is routed to the queue and answered from there
  {
    const { s, asMod, event, spawn } = await boot();
    const page = await open(`${s.url}/?token=${s.token}`);
    await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
    await spawn('perm-agent');
    await event('perm-agent', 'session.start'); await event('perm-agent', 'turn.start');
    const q = await asMod('perm-agent', '/v1/tools/ask_user', 'POST', { kind: 'permission', tool: 'Bash', detail: 'echo hi > <b>out</b>.txt', key: JSON.stringify({ command: 'echo hi > <b>out</b>.txt' }), question: 'Bash needs approval' });
    const polling = asMod('perm-agent', `/v1/questions/${q.json.id}?wait=15`);
    await page.keyboard.press('Alt+Q');
    check('the permission shows the tool and exactly what it would do', await until(async () => (await page.locator('#drawer .queue-permission').innerText().catch(() => '')) === 'Permission for Bash'));
    check('the command is plain text, not HTML', (await page.locator('#drawer .queue-detail').innerText()) === 'echo hi > <b>out</b>.txt' && (await page.locator('#drawer .queue-detail b').count()) === 0);
    check('only Allow, Deny and their "always" forms are offered', (await page.locator('#drawer .queue-options button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')))).join('|') === 'Allow|Deny|Always allow|Always deny' && (await page.locator('#drawer .queue-free').count()) === 0);
    const before = await owner(page);
    await page.click('#drawer .queue-options button[data-answer="allow"]');
    const answer = await polling;
    check('Allow reaches the waiting permission check', answer.json.answered === true && answer.json.answer === 'allow', JSON.stringify(answer.json));
    check('answering a permission did not move the keyboard focus', before === (await owner(page)), `${before} -> ${await owner(page)}`);
    await page.close();
    await s.close();
  }

  // 4. The read panel: Markdown, normal scrolling, no script execution, live updates
  {
    const { s, event } = await boot();
    const page = await open(`${s.url}/?token=${s.token}`);
    await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i + 1} of a long answer`).join('\n\n');
    const hostile = '## What I found\n\nThe timeout was **30 s**.\n\n<script>window.__pwned = 1</script>\n\n<img src=x onerror="window.__pwned = 2">\n\n[click](javascript:window.__pwned=3)\n\n';
    await event('shop-api', 'turn.complete', { answer: 'first answer' });
    await event('shop-api', 'turn.complete', { answer: `${hostile}${lines}` });
    await page.keyboard.press('Alt+L');
    check('Alt+L opens the read panel for the active session', await until(async () => (await page.locator('#reader:not([hidden]) .reader-content h2').count()) === 1));
    check('Markdown is rendered', (await page.locator('#reader .reader-content h2').innerText()) === 'What I found' && (await page.locator('#reader .reader-content strong').innerText()) === '30 s');
    check('no script, image or javascript link survives', (await page.locator('#reader .markdown script, #reader .markdown img').count()) === 0
      && !(await page.locator('#reader .markdown a').evaluateAll((as) => as.some((a) => (a as HTMLAnchorElement).href.startsWith('javascript:')))));
    check('nothing from the answer ran as code', (await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)) === undefined);
    const scroll = await page.locator('#reader .reader-content').evaluate((el) => { const before = el.scrollTop; el.scrollTop = 600; return { max: el.scrollHeight - el.clientHeight, before, after: el.scrollTop }; });
    check('the long answer scrolls normally', scroll.max > 600 && scroll.after >= 500 && scroll.before === 0, JSON.stringify(scroll));
    check('both turns are listed, newest first', (await page.locator('#reader .reader-turns button').count()) === 2);
    await event('shop-api', 'turn.complete', { answer: 'a live answer' });
    check('a new answer appears live', await until(async () => (await page.locator('#reader .reader-turns button').count()) === 3));
    check('the view follows the latest answer', (await page.locator('#reader .reader-content').innerText()).includes('a live answer'));
    await page.fill('#reader input', 'timeout');
    check('the filter keeps only matching turns', (await page.locator('#reader .reader-turns button').count()) === 1);
    await page.close();
    await s.close();
  }

  // 5. Limit on active agents: queued, starts by itself, lowering stops nothing
  {
    const { s, event, spawn, agents } = await boot(2);
    const page = await open(`${s.url}/?token=${s.token}`);
    await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
    await spawn('a-job'); await spawn('b-job');
    const third = await spawn('c-job', 'Third goal');
    check('over the limit the answer is queued with its position', third.json.status === 'queued' && third.json.position === 1, JSON.stringify(third.json));
    check('a queued agent is a bar with Queued and has no terminal', await until(async () => (await page.locator('.bar:has-text("c-job") .panel-state').innerText().catch(() => '')) === 'Queued') && (await page.locator(panel('c-job')).count()) === 0);
    check('a queued name is reserved', (await spawn('c-job')).json.code === 'slug.duplicate');
    await event('a-job', 'session.start'); await event('a-job', 'turn.start'); await event('a-job', 'turn.complete', { answer: 'done' });
    check('it starts by itself when a slot frees', await until(async () => (await page.locator(panel('c-job')).count()) === 1 && (await agents()).find((a) => a.slug === 'c-job')?.status === 'running'));
    s.setLimits({ global: 1, perProject: 1 });
    await sleep(300);
    check('lowering the limit stops nothing', (await agents()).every((a) => a.status === 'running'));
    check('and the next request waits', (await spawn('d-job')).json.status === 'queued');
    await page.close();
    await s.close();
  }

  // 6. A process that dies while working frees its slot
  {
    const { s, event, spawn, agents } = await boot(1);
    await spawn('a-job'); await spawn('b-job');
    await event('a-job', 'turn.start');
    s.writeToSession('a-job', 'quit\r');
    check('the queue advances when a working process dies', await until(async () => (await agents()).find((a) => a.slug === 'b-job')?.status === 'running'));
    await s.close();
  }

  // 8. The new-agent form when the agent has to wait behind the limit (reviewer finding): not an error
  {
    const { s } = await boot(1);
    const page = await open(`${s.url}/?token=${s.token}`);
    await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
    const create = async (slug: string) => {
      await page.click('#new-agent-btn');
      await page.fill('input[name="slug"]', slug);
      await page.click('.new-agent-form button[type="submit"]');
    };
    await create('first-job');
    check('the first agent starts', await until(async () => (await page.locator(panel('first-job')).count()) === 1 && (await page.locator('.new-agent-form').count()) === 0));
    await create('second-job');
    check('a queued agent closes the form without an error', await until(async () => (await page.locator('.new-agent-form').count()) === 0), await page.locator('.form-error').innerText().catch(() => ''));
    check('and shows up as Queued', await until(async () => (await page.locator('.bar:has-text("second-job") .panel-state').innerText().catch(() => '')) === 'Queued'));
    await page.close();
    await s.close();
  }

  // 7. Tokens: each side only works on its own surface
  {
    const { s, asMod, asUi } = await boot();
    check('a session token is refused by the UI API', (await asMod('shop-api', '/api/state')).status === 401);
    check('the UI token is refused by the mod channel', (await asUi('/v1/inbox')).status === 401);
    await s.close();
  }
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
