// Screenshots the frontend through the QA harness fixture. Usage:
//   node scripts/qa/shoot.mjs [outDir]            every scenario
//   ONLY=workspace-6,palette node scripts/qa/shoot.mjs   a subset
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join} from 'node:path';

const root = '/Users/billy/WORK/fluent-code';
const out = process.argv[2] ?? '/private/tmp/claude-501/-Users-billy-WORK-fluent-code/223cd769-627d-40d3-8d6a-2c0b00f0ee2f/scratchpad/shots';
const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2', '.png': 'image/png'};
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, {'content-type': types[extname(path)] ?? 'application/octet-stream'});
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const exe = '/Users/billy/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const browser = await chromium.launch({executablePath: exe});
const width = Number(process.env.W ?? 1440), height = Number(process.env.H ?? 900);
const errors = [];

async function open(query, {viewport} = {}) {
  const page = await browser.newPage({viewport: viewport ?? {width, height}, deviceScaleFactor: 1});
  page.on('pageerror', e => { errors.push(e.message); console.log('pageerror', e.message); });
  page.on('console', m => { if (m.type() === 'error') console.log('console.error', m.text()); });
  await page.goto(`http://127.0.0.1:${port}/scripts/ui-qa-harness.html${query}`);
  await page.waitForSelector('.splash .prompt, .splash .error', {timeout: 15000});
  await page.keyboard.press('Enter');
  await page.waitForSelector('.rail', {timeout: 15000});
  await page.waitForTimeout(700);
  return page;
}
const nav = async (page, label) => { await page.locator('.rail .rail-item').filter({hasText: new RegExp(`^${label}$`)}).first().click(); await page.waitForTimeout(800); };
const shot = (page, name, opts = {}) => page.screenshot({path: `${out}/${name}.png`, ...opts});

const scenarios = {
  async 'workspace-3'() { const p = await open('?lanes=3'); await shot(p, 'workspace-3'); await p.close(); },
  async 'workspace-6'() { const p = await open('?lanes=6'); await shot(p, 'workspace-6'); await p.close(); },
  async 'workspace-12'() { const p = await open('?lanes=12'); await shot(p, 'workspace-12'); await p.close(); },
  async 'workspace-12-nosidebar'() { const p = await open('?lanes=12'); await p.keyboard.press('Meta+j'); await p.waitForTimeout(400); await shot(p, 'workspace-12-nosidebar'); await p.close(); },
  async 'rows-12'() { const p = await open('?lanes=12'); await p.locator('.ws-actions .seg').filter({hasText: 'rows'}).click(); await p.waitForTimeout(600); await shot(p, 'rows-12'); await p.close(); },
  async 'shortcuts'() { const p = await open('?lanes=6'); await p.keyboard.press('Meta+k'); await p.locator('.palette-input').fill('shortcuts'); await p.keyboard.press('Enter'); await p.waitForTimeout(500); await shot(p, 'shortcuts'); await p.close(); },
  async 'palette-commands'() { const p = await open('?lanes=6'); await p.keyboard.press('Meta+k'); await p.locator('.palette-input').fill('la'); await p.waitForTimeout(300); await shot(p, 'palette-commands'); await p.close(); },
  async 'focus-6'() { const p = await open('?lanes=6'); await p.keyboard.press('Meta+2'); await p.keyboard.press('Meta+Enter'); await p.waitForTimeout(500); await shot(p, 'focus-6'); await p.close(); },
  async 'empty'() { const p = await open('?lanes=0'); await p.waitForTimeout(600); await shot(p, 'empty'); await p.close(); },
  async 'sheet'() { const p = await open('?lanes=6'); await p.locator('.ws-actions .btn.primary').click(); await p.waitForTimeout(600); await shot(p, 'sheet'); await p.close(); },
  async 'sheet-parallel'() { const p = await open('?lanes=6'); await p.locator('.ws-actions .btn.primary').click(); await p.waitForTimeout(400); await p.locator('.sheet .seg').filter({hasText: 'same brief'}).click(); await p.waitForTimeout(300); await shot(p, 'sheet-parallel'); await p.close(); },
  async 'palette'() { const p = await open('?lanes=6'); await p.keyboard.press('Meta+k'); await p.waitForTimeout(400); await shot(p, 'palette'); await p.close(); },
  async 'ticket-menu'() { const p = await open('?lanes=6'); const row = p.locator('.coord-row.ticket').first(); await row.hover(); await row.locator('.row-menu').click(); await p.waitForTimeout(300); await shot(p, 'ticket-menu'); await p.close(); },
  async 'sidebar-setup'() { const p = await open('?lanes=6'); await p.locator('.coord-tab').filter({hasText: 'setup'}).click(); await p.waitForTimeout(500); await shot(p, 'sidebar-setup'); await p.close(); },
  async 'sessions'() { const p = await open('?lanes=6'); await nav(p, 'sessions'); await shot(p, 'sessions'); await p.close(); },
  async 'session'() { const p = await open('?lanes=6'); await nav(p, 'sessions'); await p.locator('table.sessions tbody tr').first().click(); await p.waitForTimeout(900); await shot(p, 'session'); await p.close(); },
  async 'new-session'() { const p = await open('?lanes=6'); await nav(p, 'sessions'); await p.locator('.btn.primary').filter({hasText: 'new session'}).click(); await p.waitForTimeout(700); await shot(p, 'new-session'); await p.close(); },
  async 'usage'() { const p = await open('?lanes=6'); await nav(p, 'usage'); await shot(p, 'usage'); await p.close(); },
  async 'spend'() { const p = await open('?lanes=6'); await nav(p, 'spend'); await shot(p, 'spend'); await p.close(); },
  async 'credentials'() { const p = await open('?lanes=6'); await nav(p, 'credentials'); await shot(p, 'credentials'); await p.close(); },
  async 'catalog'() { const p = await open('?lanes=6'); await nav(p, 'catalog'); await shot(p, 'catalog'); await p.close(); },
  async 'themes'() { const p = await open('?lanes=6'); await nav(p, 'themes'); await shot(p, 'themes'); await p.close(); },
  async 'light'() { const p = await open('?lanes=6'); await p.evaluate(() => { localStorage.setItem('fluent.appearance', 'light'); }); await p.reload(); await p.waitForSelector('.splash .prompt'); await p.keyboard.press('Enter'); await p.waitForSelector('.rail'); await p.waitForTimeout(800); await shot(p, 'light'); await p.close(); },
  async 'narrow'() { const p = await open('?lanes=6', {viewport: {width: 1180, height: 760}}); await shot(p, 'narrow'); await p.close(); },
  async 'onboarding'() { const p = await open('?lanes=6&onboarding'); await shot(p, 'onboarding'); await p.close(); }
};
const only = process.env.ONLY ? process.env.ONLY.split(',') : Object.keys(scenarios);
for (const name of only) {
  try { await scenarios[name](); console.log('ok', name); }
  catch (error) { console.log('FAIL', name, error.message.split('\n')[0]); errors.push(`${name}: ${error.message}`); }
}
await browser.close();
server.close();
console.log(errors.length ? `errors: ${errors.length}` : 'no page errors');
