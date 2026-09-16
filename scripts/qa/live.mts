// Drives the real frontend bundle against a real fluentd (private socket and state, stand-in
// provider CLIs) in headless Chromium. The Tauri bridge is replaced by a page↔Node shim, so every
// RPC, subscription, and pushed event is the daemon's own. Run: node --import tsx scripts/qa/live.mts
import {chromium, type Page} from 'playwright';
import {spawn, type ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {connect, type Socket} from 'node:net';
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {delimiter, extname, join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);
const root = process.cwd();
const out = process.argv[2] ?? '/private/tmp/claude-501/-Users-billy-WORK-fluent-code/223cd769-627d-40d3-8d6a-2c0b00f0ee2f/scratchpad/live';
await run('mkdir', ['-p', out]);
// macOS Unix socket paths max out at 104 bytes, so everything lives under a short /tmp prefix.
const scratch = await mkdtemp('/tmp/fluent-qa-');
const socketPath = join(scratch, 'fluent.sock');
const state = join(scratch, 'state');
const worktrees = join(scratch, 'worktrees');
const bin = join(scratch, 'bin');
const project = join(scratch, 'project');
for (const dir of [state, worktrees, bin, project]) await run('mkdir', ['-p', dir]);

// A stand-in CLI that behaves enough like a coding-agent TUI to exercise the lanes: a banner, the
// positional prompt echoed back, a prompt line, and a reply to every line typed.
const coordCli = join(root, 'dist', 'coord-cli.js');
const fakeCli = (name: string) => `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('${name} 9.9.9-qa'); process.exit(0); }
if (process.argv[2] === 'app-server') process.exit(1);
const {execFileSync} = require('node:child_process');
const esc = '\\u001b[';
const args = process.argv.slice(2);
const prompt = args.filter(a => !a.startsWith('-')).join(' ');
const isLead = /lane start PROVIDER/.test(args.join(' '));
process.stdout.write(esc + '1m╭─ ${name} ─ stand-in' + (isLead ? ' · main agent' : '') + ' ─╮' + esc + '0m\\r\\n');
process.stdout.write(esc + '2mcwd ' + process.cwd() + esc + '0m\\r\\n\\r\\n');
if (prompt) process.stdout.write(esc + '1m> ' + esc + '0m' + prompt.slice(-300) + '\\r\\n\\r\\n' + esc + '2m⏺ thinking about it…' + esc + '0m\\r\\n\\r\\n');
const coord = (...a) => { try { return execFileSync(process.execPath, [${JSON.stringify(coordCli)}, ...a], {encoding: 'utf8', env: process.env}).trim(); } catch (e) { return 'coord failed: ' + (e.stderr || e.message); } };
if (isLead) {
  // What a real orchestrator does with its briefing: split the work and start subagents from the
  // pool, each with its own prompt, then read what they show.
  setTimeout(() => {
    const started = [coord('lane', 'start', 'codex', 'Write the integration test for the health endpoint'), coord('lane', 'start', 'glm', 'Write the docs page for the health endpoint')];
    for (const line of started) process.stdout.write(esc + '36m⏺ fluent-coord${'\\u0020'}' + esc + '0m' + line.replace(/\\n/g, '\\r\\n') + '\\r\\n');
    setTimeout(() => {
      process.stdout.write(esc + '36m⏺ lane list${'\\u0020'}' + esc + '0m' + coord('lane', 'list').replace(/\\n/g, '\\r\\n') + '\\r\\n');
      const first = (started[0].match(/^started ([0-9a-f]{8})/) || [])[1];
      if (first) process.stdout.write(esc + '36m⏺ lane read ' + first + esc + '0m\\r\\n' + coord('lane', 'read', first, '--lines', '6').replace(/\\n/g, '\\r\\n') + '\\r\\n');
      process.stdout.write('\\r\\n' + esc + '32m❯' + esc + '0m ');
    }, 4000);
  }, 1500);
}
process.stdout.write(esc + '32m❯' + esc + '0m ');
process.stdin.setRawMode && process.stdin.setRawMode(true);
process.stdin.resume();
let line = '';
process.stdin.on('data', chunk => {
  const text = chunk.toString();
  for (const ch of text) {
    if (ch === '\\u0003') process.exit(0);
    if (ch === '\\r' || ch === '\\n') {
      const said = line.trim(); line = '';
      process.stdout.write('\\r\\n');
      if (said) process.stdout.write(esc + '36m${name}:' + esc + '0m you said “' + said + '” — on it.\\r\\n');
      process.stdout.write(esc + '32m❯' + esc + '0m ');
    } else if (ch === '\\u007f') { line = line.slice(0, -1); process.stdout.write('\\b \\b'); }
    else if (ch >= ' ') { line += ch; process.stdout.write(ch); }
  }
});
setInterval(() => {}, 1 << 30);
`;
for (const name of ['claude', 'codex', 'opencode']) {
  await writeFile(join(bin, name), fakeCli(name));
  await chmod(join(bin, name), 0o755);
}
await run('git', ['-C', project, 'init', '--initial-branch=main']);
await run('git', ['-C', project, 'config', 'user.email', 'qa@example.com']);
await run('git', ['-C', project, 'config', 'user.name', 'QA']);
await writeFile(join(project, 'README.md'), '# qa project\n');
await run('git', ['-C', project, 'add', '-A']);
await run('git', ['-C', project, 'commit', '-m', 'base']);

process.env.FLUENT_SOCKET = socketPath;
const daemon: ChildProcess = spawn(process.execPath, ['--import', 'tsx', join(root, 'src', 'daemon.ts')], {
  env: {...process.env, FLUENT_SOCKET: socketPath, FLUENT_STATE_DIR: state, FLUENT_WORKTREE_DIR: worktrees, FLUENT_SECRET_STORE: 'memory', PATH: [bin, process.env.PATH].join(delimiter)},
  stdio: ['ignore', 'pipe', 'pipe']
});
daemon.stderr?.on('data', chunk => process.stderr.write(`[fluentd] ${chunk}`));

function request<T>(method: string, params?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    socket.once('error', reject);
    socket.on('data', chunk => {
      buffer += chunk.toString();
      const line = buffer.indexOf('\n');
      if (line < 0) return;
      const response = JSON.parse(buffer.slice(0, line));
      socket.end();
      if (response.ok) resolve(response.result as T); else reject(new Error(response.error));
    });
    socket.once('connect', () => socket.write(`${JSON.stringify({id: randomUUID(), method, ...(params ? {params} : {})})}\n`));
  });
}
for (let attempt = 0; attempt < 100; attempt++) {
  try { await request('ping'); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
}
console.log('fluentd up at', socketPath);
// A GLM account with a model makes the OpenCode provider launchable, exactly as a user's would.
{
  const approval = await request<{id: string}>('approvals.issue', {action: 'credential.change', target: 'glm:glm-qa', command: 'credential api-key'});
  await request('credentials.upsertAccount', {provider: 'glm', id: 'glm-qa', mode: 'api-key', label: 'z.ai qa', apiKey: 'qa-key', model: 'GLM-4.7', baseUrl: 'https://api.z.ai/api/coding/paas/v4', approvalId: approval.id});
}

// --- Serve the real bundle with the bridge shim in place of Tauri's internals ----------------------
const types: Record<string, string> = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2'};
const shim = `<script>
(() => {
  let callbackId = 0;
  const callbacks = new Map();
  const listeners = [];
  window.__emitTauriEvent = (event, payload) => { for (const l of listeners) if (l.event === event) callbacks.get(l.handler)?.({event, payload, id: 0}); };
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args = {}) => {
      if (command === 'daemon_request') return window.__bridge('request', args.method, args.params ?? undefined);
      if (command === 'sessions_subscribe') return window.__bridge('subscribe', args.sessionId);
      if (command === 'sessions_unsubscribe') return window.__bridge('unsubscribe', args.sessionId);
      if (command === 'plugin:dialog|open') return ${JSON.stringify(project)};
      if (command === 'plugin:notification|is_permission_granted') return true;
      if (command === 'plugin:notification|notify') return null;
      if (command === 'plugin:event|listen') { listeners.push({event: args.event, handler: args.handler}); return ++callbackId; }
      if (command.startsWith('plugin:event|')) return ++callbackId;
      return null;
    },
    transformCallback: callback => { const id = ++callbackId; callbacks.set(id, callback); return id; },
    unregisterCallback: () => {},
    convertFileSrc: value => value
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener: () => {}};
})();
</script>`;
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  try {
    if (path === '/' || path === '/index.html') {
      const html = (await readFile(join(root, 'app', 'index.html'), 'utf8')).replace('<script type="module"', `${shim}\n  <script type="module"`);
      res.writeHead(200, {'content-type': 'text/html'});
      return res.end(html);
    }
    const body = await readFile(join(root, 'app', path));
    res.writeHead(200, {'content-type': types[extname(path)] ?? 'application/octet-stream'});
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
const port = (server.address() as {port: number}).port;

const exe = '/Users/billy/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const browser = await chromium.launch({executablePath: exe});
const page: Page = await browser.newPage({viewport: {width: 1440, height: 900}});
const errors: string[] = [];
page.on('pageerror', error => { errors.push(error.message); console.log('pageerror', error.message); });
page.on('console', message => { if (message.type() === 'error') console.log('console.error', message.text()); });

const subscriptions = new Map<string, Socket>();
await page.exposeFunction('__bridge', async (kind: string, a: unknown, b: unknown) => {
  if (kind === 'request') return request(a as string, b);
  if (kind === 'unsubscribe') { subscriptions.get(a as string)?.end(); subscriptions.delete(a as string); return null; }
  const sessionId = a as string;
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    subscriptions.set(sessionId, socket);
    let buffer = '';
    let acked = false;
    socket.once('error', reject);
    socket.once('connect', () => socket.write(`${JSON.stringify({id: randomUUID(), method: 'sessions.subscribe', params: {sessionId}})}\n`));
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        if (!acked && 'id' in parsed) { acked = true; if (parsed.ok) resolve(parsed.result); else reject(new Error(parsed.error)); continue; }
        if (parsed.event === 'sessions.output') void page.evaluate(([id, text]) => (window as any).__emitTauriEvent('session-output', {sessionId: id, chunk: text}), [parsed.sessionId, parsed.chunk]).catch(() => undefined);
        if (parsed.event === 'sessions.status') void page.evaluate(([id, summary]) => (window as any).__emitTauriEvent('session-status', {sessionId: id, summary}), [parsed.sessionId, parsed.summary]).catch(() => undefined);
        if (parsed.event === 'sessions.attention') void page.evaluate(payload => (window as any).__emitTauriEvent('session-attention', payload), parsed).catch(() => undefined);
      }
    });
  });
});

const shot = (name: string) => page.screenshot({path: join(out, `${name}.png`)});
const step = (name: string) => console.log('·', name);
const cleanup = async () => {
  await browser.close().catch(() => undefined);
  server.close();
  for (const socket of subscriptions.values()) socket.end();
  if (daemon.exitCode === null) {
    const exited = new Promise(resolve => daemon.once('exit', resolve));
    daemon.kill('SIGTERM');
    await exited;
  }
  await rm(scratch, {recursive: true, force: true});
};
process.on('uncaughtException', async error => {
  console.log('FAILED:', error.message.split('\n')[0]);
  await page.screenshot({path: join(out, 'failure.png')}).catch(() => undefined);
  const notices = await page.evaluate(() => [...document.querySelectorAll('.action-notice')].map(el => el.textContent)).catch(() => []);
  console.log('notices:', JSON.stringify(notices));
  await cleanup();
  process.exit(1);
});

await page.addInitScript(([path]) => { localStorage.setItem('fluent.workspace-path', path); }, [project]);
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForSelector('.splash .prompt', {timeout: 20000});
await page.keyboard.press('Enter');
// A fresh state has no credentials, so the splash goes to onboarding; the rail takes us on.
await page.waitForSelector('.rail');
await page.locator('.rail .rail-item').filter({hasText: /^orchestrate$/}).click();
await page.waitForSelector('.ws-empty-inner .launch-form', {timeout: 20000});
await shot('01-empty');
step('empty state with the launch form');

// Scenario A — the flow the product is for: brief one main agent, give it a pool of subagents from
// other models, and watch it delegate. The stand-in lead starts one codex and one glm lane through
// the real fluent-coord CLI, then reads a subagent's screen.
await page.locator('.launch-task').fill('Add a health endpoint: implement it, cover it with a test, and document it.');
const stepper = (label: string) => page.locator('.stepper-row').filter({hasText: label});
await stepper('Claude Code').locator('input.stepper-value').fill('0');
await stepper('Codex').locator('input.stepper-value').fill('2');
await stepper('GLM').locator('input.stepper-value').fill('2');
await page.waitForFunction(() => document.querySelector('.launch-summary')?.textContent?.includes('pool 2 codex · 2 glm'));
await shot('01b-orchestrate-form');
await page.locator('.launch-start').click();
await page.waitForFunction(() => document.querySelectorAll('.lane-stage .lane, .lane-strip .lane').length === 1, null, {timeout: 60000});
step('main agent started with a pool of 2 codex + 2 glm');
await page.waitForFunction(() => document.querySelectorAll('.lane-stage .lane, .lane-strip .lane').length === 3, null, {timeout: 60000});
await page.waitForFunction(() => document.querySelector('.lane-stage .lane .xterm-rows')?.textContent?.includes('screen '), null, {timeout: 30000});
await page.waitForTimeout(600);
await shot('02a-orchestrator');
const roster = await page.evaluate(() => [...document.querySelectorAll('.lane')].map(el => `${el.querySelector('.lane-provider')?.textContent}:${[...el.querySelectorAll('.lane-attention .pill')].map(p => p.textContent).join('|')}`));
console.log('roster', JSON.stringify(roster));
if (!roster.some(entry => entry.startsWith('claude:main · 2/4 subagents'))) throw new Error('the main agent tile does not show its pool');
if (!roster.some(entry => /^codex( · [^:]+)?:↳ subagent/.test(entry)) || !roster.some(entry => /^glm( · [^:]+)?:↳ subagent/.test(entry))) throw new Error('subagents of two models were not started under the main agent');
const railProjects = await page.evaluate(() => [...document.querySelectorAll('.rail-project-row')].map(el => el.textContent));
console.log('rail projects', JSON.stringify(railProjects));
step('main agent delegated to codex and glm subagents and read a subagent screen');

// Scenario B — the plain fan-out, from the sheet: 2 claude + 2 codex with one brief.
await page.locator('.ws-actions .btn.primary').click();
await page.locator('.sheet .seg').filter({hasText: 'same brief'}).click();
await page.locator('.sheet .launch-task').fill('Add a health endpoint and cover it with a test.');
await page.locator('.sheet .stepper-row').filter({hasText: 'Claude Code'}).locator('input.stepper-value').fill('2');
await page.locator('.sheet .stepper-row').filter({hasText: 'Codex'}).locator('input.stepper-value').fill('2');
await page.locator('.sheet .stepper-row').filter({hasText: 'GLM'}).locator('input.stepper-value').fill('0');
await page.locator('.sheet .launch-start').click();
await page.waitForFunction(() => document.querySelectorAll('.lane-stage .lane, .lane-strip .lane').length === 7, null, {timeout: 60000});
await page.waitForFunction(() => [...document.querySelectorAll('.lane .xterm-rows')].filter(rows => rows.textContent?.includes('❯')).length >= 6, null, {timeout: 30000});
await page.keyboard.press('Escape');
await page.locator('.ws-actions .seg').filter({hasText: 'grid'}).click();
await page.waitForTimeout(800);
await shot('02-seven-lanes');
step('four parallel lanes joined the main agent and its subagents');
const tileIds = await page.evaluate(() => [...document.querySelectorAll('.lane-stage .lane')].map(el => (el as HTMLElement).dataset.sessionId));
console.log('lanes', tileIds.length);
const sessions = await request<Array<{id: string; provider: string; status: string; worktreePath?: string; task?: string; lead?: unknown; parentSessionId?: string}>>('sessions.list');
console.log('daemon sees', sessions.map(s => `${s.provider}:${s.status}${s.lead ? ':main' : s.parentSessionId ? ':sub' : ''}`).join(' '));

// Broadcast from the composer to every lane; each stand-in echoes it back.
await page.locator('.composer-targets .seg').filter({hasText: 'all'}).click();
await page.locator('.composer-input').fill('please claim src/health.ts first');
await page.keyboard.press('Enter');
await page.waitForFunction(() => [...document.querySelectorAll('.lane-stage .lane .xterm-rows')].every(rows => rows.textContent?.includes('you said')), null, {timeout: 20000});
await page.waitForTimeout(500);
await shot('03-broadcast');
step('composer broadcast reached every lane');

// Terminals must survive a sidebar action: tag the DOM nodes, add a ticket, check identity.
await page.evaluate(() => { document.querySelectorAll('.lane').forEach((el, index) => { (el as any).__tag = `tile-${index}`; }); });
await page.locator('.coord-head').filter({hasText: 'tasks'}).locator('button').click();
const ticketForm = page.locator('.coord-form:visible').first();
await ticketForm.locator('input[aria-label="Ticket title"]').fill('Write the health endpoint test');
await ticketForm.locator('button[type=submit]').click();
await page.waitForSelector('.coord-row.ticket', {timeout: 10000});
const tagsIntact = await page.evaluate(() => [...document.querySelectorAll('.lane')].every((el, index) => (el as any).__tag === `tile-${index}`));
console.log('tiles kept their DOM nodes across a board action:', tagsIntact);
await shot('04-ticket-added');

// Start a clean lane from the ticket menu (through the daemon, with a real worktree).
await page.locator('.coord-row.ticket').first().hover();
await page.locator('.coord-row.ticket .row-menu').first().click();
await page.locator('.menu-item').filter({hasText: 'start a clean claude lane'}).click();
await page.waitForFunction(() => document.querySelectorAll('.lane-stage .lane').length === 8, null, {timeout: 60000});
await page.waitForTimeout(1200);
await shot('05-ticket-lane');
step('a lane started from the ticket and was assigned to it');

// Focus mode: ⌘2 then ⌘⏎, then type straight into the focused terminal.
await page.keyboard.press('Meta+2');
await page.keyboard.press('Meta+Enter');
await page.waitForSelector('.lane-grid.focus');
await page.keyboard.type('typed directly into the lane');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelector('.lane-stage .lane .xterm-rows')?.textContent?.includes('typed directly'), null, {timeout: 20000});
await page.waitForTimeout(400);
await shot('06-focus-typed');
step('focus mode, keystrokes went to the PTY');
const focusedCols = await page.evaluate(() => (document.querySelector('.lane-stage .lane .xterm-rows')?.children.length ?? 0));
console.log('focused terminal rows rendered:', focusedCols);

// Stop a lane from its menu; the tile stays with its final screen and a footer.
await page.locator('.lane-stage .lane .lane-menu').first().click();
await page.locator('.menu-item').filter({hasText: 'stop lane'}).click();
await page.waitForSelector('.lane-stage .lane.ended', {timeout: 20000});
await page.waitForTimeout(400);
await shot('07-stopped-lane');
step('stopped lane kept its screen, footer offers resume/dismiss');

// Back to grid, open the full session view and come back — the workspace remounts cleanly.
await page.keyboard.press('Escape');
await page.locator('.lane-stage .lane .lane-menu').nth(1).click();
await page.locator('.menu-item').filter({hasText: 'open full view'}).click();
await page.waitForSelector('.session-view .xterm-rows', {timeout: 20000});
await page.waitForTimeout(600);
await shot('08-session-view');
await page.locator('.back-link').click();
await page.waitForSelector('.lane-grid.focus .lane-stage .lane', {timeout: 20000});
await page.waitForTimeout(600);
await shot('09-back-focused');
step('session view and back, landing focused on that lane');

// Palette lists the live lanes.
await page.keyboard.press('Meta+k');
await page.locator('.palette-input').fill('focus');
await page.waitForTimeout(200);
await shot('10-palette');
await page.keyboard.press('Escape');

const pty = await page.evaluate(() => [...document.querySelectorAll('.lane-stage .lane, .lane-strip .lane')].map(el => ({id: (el as HTMLElement).dataset.sessionId?.slice(0, 8), cols: el.querySelector('.xterm-rows')?.children[0]?.textContent?.length})));
console.log('pty widths after fit:', JSON.stringify(pty));
console.log(errors.length ? `page errors: ${errors.length}` : 'no page errors');

await cleanup();
console.log('done', out);
