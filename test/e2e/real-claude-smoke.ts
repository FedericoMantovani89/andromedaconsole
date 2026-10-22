// Manual-ish smoke test with the REAL Claude Code (costs a few cents of quota).
// Run: npx tsx test/e2e/real-claude-smoke.ts <already-trusted-project-folder>
import { chromium } from 'playwright-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CONSOLE_TEST = '1';
const { startServer } = await import('../../src/server/index');
const projectRoot = process.argv[2];
if (!projectRoot) throw new Error('usage: real-claude-smoke.ts <trusted-folder>');

const configDir = mkdtempSync(join(tmpdir(), 'smoke-cfg-'));
writeFileSync(join(configDir, 'config.json'), JSON.stringify({ schema: 1, language: 'en', git: { worktrees: false } }));
const s = await startServer({ port: 0, projectRoot, configDir, projectName: 'smoke-run' });
const snap = async (id: string): Promise<string> => {
  const r = await fetch(`${s.url}/api/debug/snapshot/${id}`, { headers: { authorization: `Bearer ${s.token}` } });
  return ((await r.json()) as { text: string }).text;
};
const strip = (t: string) => t.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => Promise<boolean>, ms: number): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await f()) return true; await sleep(500); }
  return false;
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, locale: 'en-US' });
await page.goto(`${s.url}/?token=${s.token}`);
const results: [string, boolean][] = [];
const rec = (label: string, ok: boolean) => { results.push([label, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); };

// The snapshot text has no spaces between the words of the banner ("ClaudeCodev2.1.308"), so the match ignores whitespace.
const showsBanner = (t: string): boolean => strip(t).replace(/\s/g, '').includes('ClaudeCode');
rec('main shows the real Claude Code TUI', await until(async () => showsBanner(await snap('smoke-run')), 60000));
await sleep(3000);
await page.keyboard.type('Reply with exactly the word console-ok and nothing else.');
await page.keyboard.press('Enter');
rec('main answers a prompt typed in the browser', await until(async () => /console-ok/.test(strip(await snap('smoke-run')).split('Reply with exactly')[1] ?? ''), 90000));

await page.click('#new-agent-btn');
await page.fill('input[name="slug"]', 'prova-1');
await page.click('.new-agent-form button[type="submit"]');
rec('"prova-1" is rejected', await until(async () => (await page.locator('.form-error').innerText()).includes('too generic'), 5000));
await page.fill('input[name="slug"]', 'prova-della-console');
await page.click('.new-agent-form button[type="submit"]');
rec('"prova-della-console" is accepted and gets a panel', await until(async () => (await page.locator('.panel[data-slug="prova-della-console"]').count()) > 0, 10000));
const ownerNow = () => page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName}|${(a.closest('.panel') as HTMLElement | null)?.dataset.slug ?? 'none'}` : 'null'; });
console.log(`INFO  active element right after the agent panel appeared: ${await ownerNow()}`);
const tuiOk = await until(async () => showsBanner(await snap('prova-della-console')), 60000);
rec('the new agent shows the real TUI', tuiOk);
if (!tuiOk) console.log('INFO  agent snapshot tail: ' + JSON.stringify(strip(await snap('prova-della-console')).slice(-600)));
const owner = await ownerNow();
console.log(`INFO  active element owner after creating the agent: ${owner} (the form was just submitted, focus returns to the active panel)`);

await page.close();
const again = await browser.newPage({ viewport: { width: 1500, height: 900 }, locale: 'en-US' });
await again.goto(`${s.url}/?token=${s.token}`);
rec('reopened tab shows both sessions again', await until(async () =>
  (await again.locator('.panel[data-slug="smoke-run"]').count()) > 0 && (await again.locator('.panel[data-slug="prova-della-console"]').count()) > 0, 15000));
const text = await again.locator('.panel[data-slug="smoke-run"] .xterm-rows').innerText();
rec('main scrollback restored (contains the earlier answer)', /console-ok/.test(text));
await again.screenshot({ path: join(process.env.SMOKE_SHOT_DIR ?? tmpdir(), 'console-smoke.png') });

await browser.close();
await s.close();
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? 'SMOKE PASSED' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
