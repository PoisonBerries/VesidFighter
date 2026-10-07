// Online one-on-one: both players press Ready and the match starts; after the match both get Rematch / Change
// Characters / Main Menu, and a rematch starts when both are ready. Two real browser pages talk through the real
// relay server (server/server.js) running locally.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const net = require('net');
const puppeteer = require('puppeteer-core');
const { ROOT, startServer, findChrome } = require('./helpers');

let web, gameServer, browser, browser2, port;

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });

before(async () => {
  web = await startServer();
  port = await freePort();
  gameServer = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), STATS_FILE: path.join(os.tmpdir(), 'vf-ready-test-' + port + '.jsonl') }),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => gameServer.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); }));
  // One browser per player: a page in the background stops running its game loop.
  const launch = () => puppeteer.launch({ executablePath: findChrome(), headless: 'new', protocolTimeout: 30000, args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'] });
  browser = await launch();
  browser2 = await launch();
});
after(async () => {
  if (browser) await browser.close();
  if (browser2) await browser2.close();
  if (gameServer) gameServer.kill();
  if (web) web.close();
});

const click = (page, sel) => page.click(sel);
const visible = (page, id) => page.waitForFunction((i) => !document.getElementById(i).classList.contains('hidden'), { timeout: 15000, polling: 200 }, id);
const text = (page, id) => page.$eval('#' + id, (e) => e.textContent);
const inMatch = (page) => page.waitForFunction(() => ['countdown', 'fight'].includes(Game.getState()), { timeout: 15000, polling: 200 });

test('online: ready up to start, then the post-match options and a ready-up rematch', async () => {
  const url = `http://127.0.0.1:${web.port}/index.html?renderer=2d&server=ws://127.0.0.1:${port}`;
  const a = await browser.newPage(), b = await browser2.newPage();
  const errors = [];
  for (const p of [a, b]) p.on('pageerror', (e) => errors.push(e.message));
  await a.goto(url, { waitUntil: 'load' }); await b.goto(url, { waitUntil: 'load' });

  for (const p of [a, b]) { // remember the game's end-of-match callback so the test can end a match instantly
    await p.evaluate(() => { const start = Game.startMatch; Game.startMatch = (x, y, onEnd, o) => { window.__endMatch = onEnd; window.__starts = (window.__starts || 0) + 1; return start(x, y, onEnd, o); }; });
  }
  await click(a, '#btn-online'); await click(a, '#btn-host');
  await a.waitForSelector('.room-code', { timeout: 15000, polling: 200 });
  const code = await a.$eval('.room-code', (e) => e.textContent);
  await click(b, '#btn-online'); await b.type('#join-code', code); await click(b, '#btn-join');
  await visible(a, 'screen-select'); await visible(b, 'screen-select');

  // Either player can ready up (not only the host); nothing starts until both have.
  assert.strictEqual((await text(a, 'btn-fight')), 'Ready');
  await click(b, '#btn-fight');
  assert.ok((await text(b, 'btn-fight')).includes('Ready ✓'), 'guest sees themself as ready');
  await a.waitForFunction(() => document.getElementById('select-online-note').textContent.includes('opponent is ready'), { timeout: 10000, polling: 200 });
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(await a.evaluate(() => Game.getState()), 'idle', 'not started with only one ready');
  // Changing the pick takes the ready back.
  await b.evaluate(() => document.querySelectorAll('#p2-cards .roster-icon')[3].click());
  assert.strictEqual(await text(b, 'btn-fight'), 'Ready', 'a new pick cancels your ready');
  await a.waitForFunction(() => !document.getElementById('select-online-note').textContent.includes('opponent is ready'), { timeout: 10000, polling: 200 });
  await click(b, '#btn-fight'); // ready again
  await click(a, '#btn-fight');
  await inMatch(a); await inMatch(b);

  // End the match the way the game does (its own end-of-match callback), then check the post-match screen.
  for (const p of [a, b]) await p.evaluate(() => window.__endMatch('p1'));
  await visible(a, 'screen-matchend'); await visible(b, 'screen-matchend');
  for (const p of [a, b]) {
    assert.strictEqual(await p.$eval('#btn-rematch', (e) => e.disabled), false, 'both can press Rematch');
    assert.strictEqual(await text(p, 'btn-rematch'), 'Rematch');
    for (const id of ['btn-change-chars', 'btn-main-menu']) assert.strictEqual(await p.$eval('#' + id, (e) => e.offsetParent !== null), true, id + ' is there');
  }
  // Rematch: the guest readies first, then the host; the match restarts.
  await click(b, '#btn-rematch');
  await a.waitForFunction(() => document.getElementById('matchend-status').textContent.includes('ready for a rematch'), { timeout: 10000, polling: 200 });
  const startsBefore = await a.evaluate(() => window.__starts);
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(await a.evaluate(() => window.__starts), startsBefore, 'not restarted with only one ready');
  await click(a, '#btn-rematch');
  for (const p of [a, b]) await p.waitForFunction((n) => window.__starts > n, { timeout: 15000, polling: 200 }, startsBefore);
  for (const p of [a, b]) assert.strictEqual(await p.$eval('#screen-matchend', (e) => e.classList.contains('hidden')), true, 'the post-match screen is gone');
  assert.deepStrictEqual(errors, [], 'no page errors');
});
