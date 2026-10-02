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
    protocolTimeout: 300000, // slow or busy machines
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
// The game renders in 3D; the pixel checks below read the 2D canvas, so
// pages use the 2D fallback (?renderer=2d) unless a test asks for 3D.
async function openGame({ view3d = false, on = browser } = {}) {
  const page = await on.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const errors = [];
  const local = (url) => url.startsWith(base);
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console.error: ' + m.text()); });
  page.on('response', (r) => { if (local(r.url()) && r.status() >= 400 && !r.url().endsWith('favicon.ico')) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(base + '/index.html' + (view3d ? '' : '?renderer=2d'), { waitUntil: 'load' });
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

test('a transforming character wears its transformed head (Robert), everyone else keeps theirs', async () => {
  const { page, errors } = await openGame();
  await page.waitForFunction(() => CharacterHeads.getImage('robert-transformed') && CharacterHeads.getImage('robert'), { timeout: 10000 });
  const r = await page.evaluate(() => ({
    normal: CharacterHeads.variantFor('robert', false),
    transformed: CharacterHeads.variantFor('robert', true),
    other: CharacterHeads.variantFor('sam', true),
    info: !!CharacterHeads.getInfo('robert-transformed'),
    differs: CharacterHeads.getImage('robert-transformed').src !== CharacterHeads.getImage('robert').src,
  }));
  assert.deepStrictEqual(r, { normal: 'robert', transformed: 'robert-transformed', other: 'sam', info: true, differs: true });
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test('character select: the layout never shifts as fighters are hovered, everything fits a laptop screen, and Random picks a fighter', async () => {
  const { page, errors } = await openGame();
  await page.setViewport({ width: 1366, height: 768 });
  await page.click('#btn-start');
  await page.waitForSelector('#screen-select:not(.hidden)');
  const layout = () => page.evaluate(() => {
    const tiles = [...document.querySelectorAll('#p1-cards .roster-icon, #p2-cards .roster-icon')].map((e) => `${e.offsetTop}:${e.offsetLeft}:${e.offsetWidth}`);
    const box = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return `${Math.round(b.top)}:${Math.round(b.height)}`; };
    const fight = document.getElementById('btn-fight').getBoundingClientRect();
    return { tiles: tiles.join(','), preview1: box('#preview-p1'), preview2: box('#preview-p2'), fight: Math.round(fight.top) + ':' + Math.round(fight.bottom) };
  });
  const icons = await page.$$('#p1-cards .roster-icon');
  assert.strictEqual(icons.length, 10, 'nine fighters plus the Random tile');
  const first = await layout();
  const seen = new Set();
  for (const icon of icons) {
    await icon.hover();
    seen.add(await page.evaluate(() => document.querySelector('#preview-p1 .preview-name').textContent));
    assert.deepStrictEqual(await layout(), first, 'hovering a fighter must not move the tiles, the preview or the Fight button');
  }
  assert.ok(seen.size >= 9, 'each hover shows that fighter');
  const bottom = Number(first.fight.split(':')[1]);
  assert.ok(bottom <= 768, `the Fight button should be on screen at 1366x768 (bottom edge ${bottom})`);
  // Random.
  const nameOf = () => page.evaluate(() => document.querySelector('#p1-cards .roster-icon.selected:not(.random) .roster-name').textContent);
  const before = await nameOf();
  await page.click('#p1-cards .roster-icon.random');
  await page.waitForFunction(() => !document.querySelector('#p1-cards .roster-icon.random.spinning'), { timeout: 5000 });
  const after = await nameOf();
  assert.notStrictEqual(after, before, 'Random should land on a different fighter');
  assert.strictEqual(await page.evaluate(() => document.querySelector('#preview-p1 .preview-name').textContent), after, 'and show them');
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('#p1-cards .roster-icon.selected').length), 1);
  assert.deepStrictEqual(await layout(), first, 'and nothing moved');
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test('character select: a big full-body fighter is drawn on each side and follows the hovered fighter', async () => {
  const { page, errors } = await openGame();
  await page.setViewport({ width: 1600, height: 900 });
  await page.click('#btn-start');
  await page.waitForSelector('#screen-select:not(.hidden)');
  await new Promise((r) => setTimeout(r, 700)); // the slide-in finishes
  const coverage = (id) => page.evaluate((id) => {
    const c = document.getElementById(id);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 200) n++;
    return { n, share: n / (c.width * c.height), url: c.toDataURL() };
  }, id);
  for (const id of ['select-art-p1', 'select-art-p2']) {
    const c = await coverage(id);
    assert.ok(c.share > 0.05, `${id}: the fighter should fill a real part of the panel (${(c.share * 100).toFixed(1)}%)`);
  }
  // Each side's art sits on its own side of the screen, big and full-height.
  const boxes = await page.evaluate(() => ['select-art-p1', 'select-art-p2'].map((id) => { const b = document.getElementById(id).getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height) }; }));
  assert.ok(boxes[0].left <= 1 && boxes[1].right >= 1599, 'left art at the left edge, right art at the right edge');
  assert.ok(boxes[0].h >= 890, 'full height');
  // Hovering another fighter swaps the art.
  const before = (await coverage('select-art-p1')).url;
  const icons = await page.$$('#p1-cards .roster-icon');
  await icons[6].hover(); // Ryan
  await new Promise((r) => setTimeout(r, 700));
  const hovered = await coverage('select-art-p1');
  assert.notStrictEqual(hovered.url, before, 'the left fighter should change with the hovered fighter');
  assert.ok(hovered.share > 0.05);
  // It goes away with the screen.
  await page.click('#btn-select-back');
  await page.waitForSelector('#screen-title:not(.hidden)');
  assert.strictEqual(await page.evaluate(() => document.getElementById('select-art-p1').offsetParent), null, 'hidden when the screen is');
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test('quitting to the main menu stops the match: nothing keeps running behind the title screen', async () => {
  for (const mode of ['#btn-start', '#btn-cpu']) {
    const { page, errors } = await openGame();
    await page.click(mode);
    await page.waitForSelector('#screen-select:not(.hidden)');
    await page.click('#btn-fight');
    await page.waitForFunction(() => Game.getState() === 'fight', { timeout: 15000 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('#pause-menu:not(.hidden)');
    await page.click('#btn-quit-to-menu');
    await page.waitForSelector('#screen-title:not(.hidden)');
    const state = await page.evaluate(() => Game.getState());
    assert.strictEqual(state, 'idle', `${mode}: the match must end when you quit to the menu`);
    assert.strictEqual(await page.evaluate(() => Cpu.isActive()), false, `${mode}: the CPU must stop`);
    // Let real time pass: the fighters must not move, take damage or change state.
    const snap = () => page.evaluate(() => JSON.stringify(Game.getSnapshot().f.map((f) => [f.x, f.y, f.hp, f.state, f.actionTimer])));
    const before = await snap();
    await new Promise((r) => setTimeout(r, 1500));
    assert.strictEqual(await snap(), before, `${mode}: fighters kept moving behind the title screen`);
    const shown = await page.$$eval('.screen', (els) => els.filter((e) => !e.classList.contains('hidden')).map((e) => e.id));
    assert.deepStrictEqual(shown, ['screen-title'], `${mode}: only the title screen should be showing`);
    assert.deepStrictEqual(errors, []);
    await page.close();
  }
});

test('every character is drawn, and survives attack/special/ultimate/jump/block/hit/KO with rendering on', async () => {
  const { page, errors } = await openGame();
  await page.evaluate(PAGE_HELPERS);
  // One browser call per character, so a slow machine (or CI) never has a single call
  // that runs past Puppeteer's protocol timeout.
  const ids = await page.evaluate(() => CHARACTER_LIST.map((c) => c.id));
  const results = [];
  for (const [n, id] of ids.entries()) {
    results.push(await page.evaluate((id, n) => {
      const T = window.__t;
      const ids = CHARACTER_LIST.map((c) => c.id);
      const tap = (code, frames = 1) => { T.key(code, true); T.step(1); T.key(code, false); T.step(frames); };
      const foe = ids[(n + 4) % ids.length];
      Game.startMatch(id, id === foe ? 'sam' : foe, () => {});
      T.step(200); // countdown -> fight
      const r = { id, state: Game.getState(), visible: [T.visible(0), T.visible(1)] };
      tap('KeyF', 40);                                        // attack
      tap('KeyW', 30);                                        // jump
      T.key('KeyW', true); T.step(70); T.key('KeyW', false); T.step(60); // held jump (Carlos hovers)
      T.key('KeyS', true); T.step(15); T.key('KeyS', false);  // block
      // Crouch and move (Sam swims, Artur rolls), then run into a crouch (Sam slides) -- with rendering on.
      T.key('KeyS', true); T.key('KeyD', true); T.step(40); T.key('KeyD', false); T.step(10); T.key('KeyS', false);
      T.key('KeyD', true); T.step(14); T.key('KeyD', false); T.key('KeyS', true); T.step(45); T.key('KeyS', false); T.step(10);
      tap('KeyG', 100);                                       // special
      Game.applySnapshot({ f: [{ ultCharge: 100 }, {}] });
      tap('KeyH', 140);                                       // ultimate
      Game.applySnapshot({ f: [{ state: 'knockdown', actionTimer: 0, knockdownTimer: 40, grounded: false, vy: -8, vx: -6 }, {}] });
      T.step(120);                                            // fly back, land, lie, get up
      T.step(60);
      r.afterVisible = T.visible(0);
      Game.applySnapshot({ f: [{ state: 'ko', actionTimer: 0 }, {}] });
      T.step(60);
      return r;
    }, id, n));
  }
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

test('voice lines are levelled: every file in assets/voice ends up at about the same loudness, without clipping', async () => {
  const fs = require('fs'), path = require('path');
  const { ROOT } = require('./helpers');
  const dir = path.join(ROOT, 'assets', 'voice');
  const files = fs.readdirSync(dir).flatMap((c) => (fs.statSync(path.join(dir, c)).isDirectory() ? fs.readdirSync(path.join(dir, c)).filter((f) => /\.(mp3|ogg|wav|m4a)$/i.test(f)).map((f) => `assets/voice/${c}/${f}`) : []));
  const { page, errors } = await openGame();
  const rows = await page.evaluate(async (files) => {
    Sfx.ensure();
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const out = [];
    for (const f of files) {
      const buf = await ac.decodeAudioData(await (await fetch(encodeURI(f))).arrayBuffer());
      const g = Sfx.loudnessGain(buf);
      const a = buf.getChannelData(0), win = Math.round(buf.sampleRate * 0.05), r = [];
      let peak = 0;
      for (let i = 0; i + win <= a.length; i += win) { let sum = 0; for (let j = i; j < i + win; j++) { sum += a[j] * a[j]; peak = Math.max(peak, Math.abs(a[j])); } r.push(Math.sqrt(sum / win)); }
      const top = Math.max(...r), live = r.filter((x) => x > top * 0.03);
      const mean = Math.sqrt(live.reduce((t, x) => t + x * x, 0) / live.length);
      out.push({ f, db: 20 * Math.log10(mean * g), peak: peak * g, gain: g });
    }
    return out;
  }, files);
  assert.ok(rows.length >= 20, `found ${rows.length} voice files`);
  for (const r of rows) assert.ok(r.peak <= 0.9, `${r.f} would clip (peak ${r.peak.toFixed(2)})`);
  // Everything lands within a few dB of the target (only a file too quiet to reach it without clipping may sit lower).
  for (const r of rows) assert.ok(r.db > -27 && r.db < -19.5, `${r.f} ends up at ${r.db.toFixed(1)} dB`);
  const spread = Math.max(...rows.map((r) => r.db)) - Math.min(...rows.map((r) => r.db));
  assert.ok(spread < 6, `levels still spread ${spread.toFixed(1)} dB apart`);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test('Robert\'s voice lines play deeper while he is transformed (and only then)', async () => {
  const { page, errors } = await openGame();
  const res = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    Sfx.ensure();
    Sfx.settings.muted = false; // (an earlier test may have muted it in this browser profile)
    Sfx.hitTakenChance = 1;     // (hit-taken lines are otherwise played only half the time)
    Sfx.voice('robert', 'selected'); // in the menus: never deep
    const menu = Sfx.lastVoice.deep;
    Game.startMatch('robert', 'keenan', () => {}, { ball: 'off' });
    await wait(800);
    Sfx.voice('robert', 'hitTaken');
    const normal = Sfx.lastVoice.deep;
    Game.applySnapshot({ f: [{ transformed: true }, {}] });
    await wait(800);
    Sfx.voice('robert', 'block');
    const deep = Sfx.lastVoice.deep;
    Sfx.voice('keenan', 'hitTaken');
    return { menu, normal, deep, keenan: Sfx.lastVoice.deep };
  });
  assert.deepStrictEqual(res, { menu: false, normal: false, deep: true, keenan: false });
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test('winning back to back plays the victory-streak line instead of the plain victory line', async () => {
  const { page, errors } = await openGame();
  const res = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    Sfx.ensure();
    Sfx.settings.muted = false;
    await wait(800);
    const seen = [];
    Sfx.voice('ryan', 'victory'); seen.push(Sfx.lastVoice.path.split('/').pop());
    await wait(800);
    Sfx.voice('ryan', 'victory'); seen.push(Sfx.lastVoice.path.split('/').pop());
    await wait(800);
    Sfx.voice('keenan', 'victory'); // someone else wins: the streak is broken
    await wait(800);
    Sfx.voice('ryan', 'victory'); seen.push(Sfx.lastVoice.path.split('/').pop());
    return seen;
  });
  assert.deepStrictEqual(res, ['RyanVictory.m4a', 'RyanVictoryStreak.m4a', 'RyanVictory.m4a']);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test('Ryan\'s voice gets a clear vocoder: a changed but still clearly voiced signal, same length, no bad samples', async () => {
  const { page, errors } = await openGame();
  const r = await page.evaluate(async () => {
    const ac = new AudioContext();
    const buf = await ac.decodeAudioData(await (await fetch('assets/voice/ryan/RyanVictory.m4a')).arrayBuffer());
    const out = await Sfx.vocode(buf, Sfx.voiceFx.ryan.vocoder);
    const a = buf.getChannelData(0), b = out.getChannelData(0);
    let sa = 0, sb = 0, sab = 0, bad = 0;
    for (let i = 0; i < a.length; i++) { sa += a[i] * a[i]; sb += b[i] * b[i]; sab += a[i] * b[i]; if (!isFinite(b[i])) bad++; }
    // And the real playback path processes Ryan's lines (and nobody else's).
    Sfx.settings.muted = false;
    await new Promise((r) => setTimeout(r, 800));
    Sfx.voice('ryan', 'victory');
    return { sameLength: out.length === buf.length, bad, corr: sab / Math.sqrt(sa * sb), level: Math.sqrt(sb / sa) };
  });
  assert.ok(r.sameLength && r.bad === 0);
  assert.ok(r.corr < 0.7, `barely changed (correlation ${r.corr.toFixed(2)})`);
  assert.ok(r.corr > 0.2, `no longer sounds like the same voice (correlation ${r.corr.toFixed(2)})`);
  assert.ok(r.level > 0.8 && r.level < 1.5, `loudness changed by x${r.level.toFixed(2)}`);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test('hit-taken lines only play about half the time; other lines always play', async () => {
  const { page, errors } = await openGame();
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise((x) => setTimeout(x, ms));
    Sfx.ensure(); Sfx.settings.muted = false;
    await wait(800);
    const seen = (occasion, charId = 'keenan') => { Sfx.lastVoice = null; Sfx.voice(charId, occasion); return !!Sfx.lastVoice; };
    const out = { chance: Sfx.hitTakenChance };
    Sfx.hitTakenChance = 1;
    out.always = seen('hitTaken');
    await wait(750);
    Sfx.hitTakenChance = 0;
    out.never = seen('hitTaken');
    out.fallbackNever = seen('hitByUltimate');   // a special/ult hit with no line of its own plays the hit-taken line, so it is chanced too
    out.otherLines = seen('hitByProjectile');    // Keenan has his own projectile line: always plays
    await wait(750);
    out.big = seen('bigHit', 'carlos');           // not a hit-taken line
    return out;
  });
  assert.strictEqual(r.chance, 0.5);
  assert.ok(r.always && !r.never && !r.fallbackNever);
  assert.ok(r.otherLines && r.big, 'only hit-taken lines are chanced');
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test('sound defaults: effects are boosted well past the old maximum and the music sits quieter than the effects', async () => {
  const { page, errors } = await openGame();
  const d = await page.evaluate(() => ({ music: Sfx.settings.music, sfx: Sfx.settings.sfx, boost: Sfx.sfxBoost, sliderMusic: +document.getElementById('vol-music').value, sliderSfx: +document.getElementById('vol-sfx').value }));
  assert.ok(d.sfx * d.boost > 1.5, `effects default should be well above the old 100% level (got ${(d.sfx * d.boost).toFixed(2)}x)`);
  assert.ok(d.boost > 1, 'the effects slider should reach above the old maximum');
  assert.ok(d.music <= 0.3, `music should default quiet (got ${d.music})`);
  assert.ok(d.music < d.sfx, 'music should sit below the effects');
  assert.strictEqual(d.sliderMusic, Math.round(d.music * 100));
  assert.strictEqual(d.sliderSfx, Math.round(d.sfx * 100));
  assert.deepStrictEqual(errors, []);
  await page.close();
});

// ---- 3D view ----
// A second browser with software WebGL (SwiftShader), since the main one runs
// with the GPU disabled. The 3D view loads Three.js from a CDN; if it can't
// load (offline) this test skips rather than fails.
// Slow (software WebGL), so it only runs on request: `npm run test:3d`, or
// `npm run test:all`. tools/needs-3d.js decides when a change makes it worth
// running (used by CI and before pushing).
const RUN_3D = process.env.RUN_3D === '1';
test('3D view: every character is drawn in 3D and survives their move set', { skip: RUN_3D ? false : 'slow: run with `npm run test:3d` (see tools/needs-3d.js)' }, async (t) => {
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

  assert.deepStrictEqual(errors, []);
  await page.close();
});

// The graphics settings on the Orchard (software WebGL, so it rides along
// with the 3D test). Low loads the lite scene and draws far less; switching
// presets mid-fight keeps drawing without errors.
test('graphics settings: the Orchard runs on Low (lite scene), Medium and High, switching live', { skip: RUN_3D ? false : 'slow: run with `npm run test:3d`' }, async (t) => {
  if (!browser3d) {
    browser3d = await puppeteer.launch({
      executablePath: findChrome(), headless: 'new',
      args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
    });
  }
  const page = await browser3d.newPage();
  await page.setViewport({ width: 640, height: 360 });
  await page.evaluateOnNewDocument(() => localStorage.setItem('vesid.graphics', JSON.stringify({ preset: 'low', scale: null, fps: true })));
  const errors = [];
  const scenes = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console.error: ' + m.text()); });
  page.on('response', (r) => { if (/assets\/stages\/.*\.glb$/.test(r.url())) scenes.push(r.url().split('/').pop()); });
  await page.goto(base + '/index.html', { waitUntil: 'load' });
  const ready = await page.waitForFunction(() => !!window.Renderer3D, { timeout: 20000 }).then(() => true, () => false);
  if (!ready) { t.skip('3D view did not load'); await page.close(); return; }
  await page.evaluate(() => { VF_setPaused(true); Game.startMatch('nathan', 'john', () => {}, { stage: 'orchard', ball: false }); });
  await page.waitForFunction(() => Renderer3D.stageReady(), { timeout: 240000, polling: 1000 });
  assert.deepStrictEqual(scenes, ['orchard-lite.glb'], 'Low loads the lite scene');

  const draw = () => page.evaluate(() => {
    Game.render(document.getElementById('game-canvas').getContext('2d'));
    const info = Renderer3D.info();
    const c = document.createElement('canvas'); c.width = 64; c.height = 36;
    const g = c.getContext('2d'); g.drawImage(document.getElementById('game-canvas-3d'), 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data;
    let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
    return { ...info, lit: lit / (64 * 36), tier: Graphics.config().tier };
  });
  const low = await draw();
  await page.evaluate(() => Graphics.set({ preset: 'medium', scale: null }));
  const medium = await draw();
  await page.evaluate(() => Graphics.set({ preset: 'high', scale: null }));
  const high = await draw();
  for (const r of [low, medium, high]) assert.ok(r.lit > 0.5, `${r.tier}: the scene should be drawn (only ${(r.lit * 100).toFixed(0)}% lit)`);
  assert.ok(low.pixelRatio < high.pixelRatio, 'Low renders at a lower resolution');
  assert.ok(low.calls < high.calls, `Low draws less (${low.calls} vs ${high.calls} draw calls)`);
  assert.ok(await page.evaluate(() => Graphics.needsReload()), 'High\'s full scene waits for a reload');
  // Cartoon, live: the low-poly orchard, a tiny fraction of the triangles.
  await page.evaluate(() => Graphics.set({ preset: 'cartoon', scale: null }));
  const toon = await draw();
  assert.ok(toon.lit > 0.5, 'Cartoon draws the scene');
  assert.ok(toon.triangles < low.triangles / 20, `Cartoon draws a tiny scene (${toon.triangles} vs Low's ${low.triangles} triangles)`);
  assert.ok(await page.$eval('#fps-counter', (e) => !e.hidden && /fps/.test(e.textContent)), 'the FPS counter shows');
  assert.deepStrictEqual(errors, []);
  await page.close();
});
