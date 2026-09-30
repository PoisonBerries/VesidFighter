// Real-browser tests: load the actual page in headless Chrome, click through
// the UI, and check that fighters are really drawn on the canvas -- not just
// that the code ran without throwing.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const puppeteer = require('puppeteer-core');
const { startServer, findChrome } = require('./helpers');

let server, browser, browser3d, base;

before(async () => {
  server = await startServer();
  base = `http://127.0.0.1:${server.port}`;
  browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (browser3d) await browser3d.close();
  if (server) server.close();
});

// Opens the game and records every page error, console error and failed
// local request. External requests (the PeerJS CDN) are ignored so the tests
// also work offline.
// The 2D/3D choice is remembered in localStorage; the pixel checks below read
// the 2D canvas, so pages open in the 2D view unless a test asks for 3D.
async function openGame({ view3d = false, on = browser } = {}) {
  const page = await on.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument((v) => { try { localStorage.setItem('vf_view3d', v); } catch (e) { /* ignore */ } }, view3d ? '1' : '0');
  const errors = [];
  const local = (url) => url.startsWith(base);
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console.error: ' + m.text()); });
  page.on('response', (r) => { if (local(r.url()) && r.status() >= 400 && !r.url().endsWith('favicon.ico')) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(base + '/index.html', { waitUntil: 'load' });
  return { page, errors };
}

// Injected helpers, defined inside the page (they need the game's globals).
const PAGE_HELPERS = `
  window.__t = {
    ctx: document.getElementById('game-canvas').getContext('2d'),
    key(code, down) { window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code })); },
    step(n = 1) { for (let i = 0; i < n; i++) { Game.update(FIXED_STEP); Game.render(this.ctx); } },
    // Fraction of pixels around a fighter's torso that differ from the bare stage.
    visible(idx) {
      const f = Game.getSnapshot().f[idx];
      Game.render(this.ctx);
      const x = Math.round(f.x) - 26, w = 52;
      const y = Math.round(f.y) - 130, h = 90;
      const live = this.ctx.getImageData(x, y, w, h).data;
      const off = document.createElement('canvas'); off.width = 1280; off.height = 720;
      const octx = off.getContext('2d'); Renderer.drawStage(octx);
      const bare = octx.getImageData(x, y, w, h).data;
      let diff = 0;
      for (let i = 0; i < live.length; i += 4) {
        if (Math.abs(live[i] - bare[i]) + Math.abs(live[i + 1] - bare[i + 1]) + Math.abs(live[i + 2] - bare[i + 2]) > 60) diff++;
      }
      return diff / (w * h);
    },
  };
`;

test('the page loads cleanly and shows the title screen', async () => {
  const { page, errors } = await openGame();
  const shown = await page.$$eval('.screen', (els) => els.filter((e) => !e.classList.contains('hidden')).map((e) => e.id));
  assert.deepStrictEqual(shown, ['screen-title']);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test('starting a local game from the menus puts both fighters on screen', async () => {
  const { page, errors } = await openGame();
  await page.click('#btn-start');
  await page.waitForSelector('#screen-select:not(.hidden)');
  await page.click('#btn-fight');
  await page.waitForFunction(() => Game.getState() === 'fight', { timeout: 15000 });
  const shown = await page.$$eval('.screen', (els) => els.filter((e) => !e.classList.contains('hidden')).map((e) => e.id));
  assert.deepStrictEqual(shown, [], 'no menu should be covering the fight');
  await page.evaluate(PAGE_HELPERS);
  await page.evaluate(() => window.__t.step(10));
  for (const idx of [0, 1]) {
    const v = await page.evaluate((i) => window.__t.visible(i), idx);
    assert.ok(v > 0.15, `fighter ${idx + 1} is not visibly drawn (only ${(v * 100).toFixed(1)}% of pixels differ from the bare stage)`);
  }
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test('every character is drawn, and survives attack/special/ultimate/jump/block/hit/KO with rendering on', async () => {
  const { page, errors } = await openGame();
  await page.evaluate(PAGE_HELPERS);
  const results = await page.evaluate(() => {
    const T = window.__t, out = [];
    const ids = CHARACTER_LIST.map((c) => c.id);
    const tap = (code, frames = 1) => { T.key(code, true); T.step(1); T.key(code, false); T.step(frames); };
    ids.forEach((id, n) => {
      const foe = ids[(n + 4) % ids.length];
      Game.startMatch(id, id === foe ? 'sam' : foe, () => {});
      T.step(200); // countdown -> fight
      const r = { id, state: Game.getState(), visible: [T.visible(0), T.visible(1)] };
      tap('KeyF', 40);                                        // attack
      tap('KeyW', 30);                                        // jump
      T.key('KeyS', true); T.step(15); T.key('KeyS', false);  // block
      tap('KeyG', 100);                                       // special
      Game.applySnapshot({ f: [{ ultCharge: 100 }, {}] });
      tap('KeyH', 140);                                       // ultimate
      Game.applySnapshot({ f: [{ state: 'knockdown', actionTimer: 0, knockdownTimer: 40, grounded: false, vy: -8, vx: -6 }, {}] });
      T.step(120);                                            // fly back, land, lie, get up
      T.step(60);
      r.afterVisible = T.visible(0);
      Game.applySnapshot({ f: [{ state: 'ko', actionTimer: 0 }, {}] });
      T.step(60);
      out.push(r);
    });
    return out;
  });
  for (const r of results) {
    assert.strictEqual(r.state, 'fight', `${r.id}: match did not reach the fight state`);
    assert.ok(r.visible[0] > 0.15 && r.visible[1] > 0.15, `${r.id}: fighters not drawn at fight start (${r.visible.map((v) => (v * 100).toFixed(0) + '%')})`);
    assert.ok(r.afterVisible > 0.05, `${r.id}: fighter vanished after the move set`);
  }
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test('the guest path renders: a host snapshot applied to a fresh match still draws both fighters', async () => {
  const { page, errors } = await openGame();
  await page.evaluate(PAGE_HELPERS);
  const v = await page.evaluate(() => {
    const T = window.__t;
    Game.startMatch('carlos', 'nathan', () => {});
    T.step(260);
    const wire = JSON.parse(JSON.stringify(Game.getSnapshot()));
    Game.startMatch('carlos', 'nathan', () => {});
    Game.applySnapshot(wire);
    T.step(3);
    return [T.visible(0), T.visible(1)];
  });
  assert.ok(v[0] > 0.15 && v[1] > 0.15, `snapshot-driven fighters not visible: ${v}`);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test('a mirror match gives player 2 a different colour scheme from player 1', async () => {
  const { page, errors } = await openGame();
  await page.evaluate(PAGE_HELPERS);
  const [c1, c2] = await page.evaluate(() => {
    Game.startMatch('sam', 'sam', () => {});
    window.__t.step(200);
    const f = Game.getSnapshot().f;
    return [f[0].paletteSwap, f[1].paletteSwap];
  });
  assert.strictEqual(c1, false);
  assert.strictEqual(c2, true);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test('sound: every effect can play without throwing, and the soundtrack playlist loads', async () => {
  const { page, errors } = await openGame();
  await page.click('#btn-start'); // a user gesture, so audio may start
  const info = await page.evaluate(async () => {
    Sfx.ensure();
    Sfx.swing(0); Sfx.jump(1, 0); Sfx.jump(2, 0); Sfx.land(0.8, 0); Sfx.thud(0); Sfx.ko(0); Sfx.fall(0);
    Sfx.victory(); Sfx.tick(); Sfx.go(); Sfx.click(); Sfx.transform();
    for (const c of CHARACTER_LIST) {
      Sfx.ability(c.special.type, false, 0.2);
      Sfx.ability(c.ultimate.type, true, -0.2);
    }
    for (const col of ['#9fd8ff', '#ffffff', '#ff3b3b', '#ffe066']) Sfx.impact(col);
    await new Promise((r) => setTimeout(r, 600));
    return document.getElementById('now-playing').textContent;
  });
  assert.ok(info.length > 0);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

// ---- 3D view ----
// A second browser with software WebGL (SwiftShader), since the main one runs
// with the GPU disabled. The 3D view loads Three.js from a CDN; if it can't
// load (offline) this test skips rather than fails.
test('3D view: every character is drawn in 3D and survives their move set, and the view toggle works', async (t) => {
  browser3d = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'new',
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const { page, errors } = await openGame({ view3d: true, on: browser3d });
  const ready = await page.waitForFunction(() => !!window.Renderer3D, { timeout: 20000 }).then(() => true, () => false);
  if (!ready) {
    assert.deepStrictEqual(errors, [], 'the 3D view failed to start');
    t.skip('3D view did not load (Three.js CDN unreachable?)');
    await page.close();
    return;
  }
  await page.setViewport({ width: 640, height: 360 }); // software WebGL: keep frames cheap
  await page.evaluate(PAGE_HELPERS);
  await page.evaluate(() => {
    const T = window.__t;
    const gl = document.getElementById('game-canvas-3d');
    const grab = () => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 180;
      const g = c.getContext('2d'); g.drawImage(gl, 0, 0, 320, 180);
      return g.getImageData(0, 0, 320, 180).data;
    };
    // Fraction of the WebGL frame (per half: P1 starts left, P2 right) that
    // changes when the fighters are hidden. Rendering twice in the same task
    // keeps the camera still, so only the fighters/effects differ.
    T.visible3d = () => {
      Game.render(T.ctx);
      const withF = grab();
      Renderer3D.render(null);
      const without = grab();
      const half = [0, 0];
      for (let i = 0; i < withF.length; i += 4) {
        const d = Math.abs(withF[i] - without[i]) + Math.abs(withF[i + 1] - without[i + 1]) + Math.abs(withF[i + 2] - without[i + 2]);
        if (d > 60) half[((i / 4) % 320) < 160 ? 0 : 1]++;
      }
      return half.map((n) => n / (160 * 180));
    };
    // Every sim frame runs; every 8th is rendered (a full software-WebGL
    // frame is slow), which still exercises the 3D path all through each move.
    T.step3d = (n = 1) => { for (let i = 0; i < n; i++) { Game.update(FIXED_STEP); if (i % 8 === 7 || i === n - 1) Game.render(T.ctx); } };
  });
  const ids = await page.evaluate(() => CHARACTER_LIST.map((c) => c.id));
  const results = [];
  for (const [n, id] of ids.entries()) {
    const foe = ids[(n + 4) % ids.length];
    results.push(await page.evaluate((id, foe) => {
      const T = window.__t;
      const tap = (code, frames = 1) => { T.key(code, true); T.step3d(1); T.key(code, false); T.step3d(frames); };
      Game.startMatch(id, id === foe ? 'sam' : foe, () => {});
      T.step3d(200);
      const r = { id, active: Renderer3D.isActive(), start: T.visible3d() };
      tap('KeyF', 40);
      tap('KeyW', 30);
      T.key('KeyS', true); T.step3d(15); T.key('KeyS', false);
      tap('KeyG', 100);
      Game.applySnapshot({ f: [{ ultCharge: 100 }, {}] });
      tap('KeyH', 140);
      Game.applySnapshot({ f: [{ state: 'knockdown', actionTimer: 0, knockdownTimer: 40, grounded: false, vy: -8, vx: -6 }, {}] });
      T.step3d(180);
      const after = T.visible3d();
      r.after = after[0] + after[1];
      Game.applySnapshot({ f: [{ state: 'ko', actionTimer: 0 }, {}] });
      T.step3d(60);
      return r;
    }, id, foe));
  }
  for (const r of results) {
    assert.ok(r.active, `${r.id}: 3D view was not active`);
    assert.ok(r.start[0] > 0.01 && r.start[1] > 0.01, `${r.id}: fighters not drawn in 3D at fight start (${r.start.map((v) => (v * 100).toFixed(1) + '%')})`);
    assert.ok(r.after > 0.01, `${r.id}: fighters vanished from the 3D view after the move set`);
  }

  // The title-screen toggle switches back to the 2D renderer and remembers it.
  const toggled = await page.evaluate(() => {
    const btn = document.getElementById('btn-view-toggle');
    const shown = !btn.classList.contains('hidden');
    btn.click();
    return { shown, label: btn.textContent, active: Renderer3D.isActive(), saved: localStorage.getItem('vf_view3d') };
  });
  assert.deepStrictEqual(toggled, { shown: true, label: '3D View: Off', active: false, saved: '0' });
  assert.deepStrictEqual(errors, []);
  await page.close();
});
