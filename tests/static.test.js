// Static checks: things that break the page without any code "running wrong".
// (A missing element id or a misspelled script path only shows up at runtime,
// on the one screen that uses it.)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { ROOT } = require('./helpers');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const html = read('index.html');
const localScripts = (page, re) => [...page.matchAll(re)].map((m) => m[1]).filter((s) => !/^https?:/.test(s));
const scripts = localScripts(html, /<script src="([^"]+)"/g);
// ES modules (the 3D view, which imports Three.js).
const modules = localScripts(html, /<script type="module" src="([^"]+)"/g);
// The sprite planner is its own page, sharing the game's scripts.
const plannerHtml = fs.existsSync(path.join(ROOT, 'sprite-planner.html')) ? read('sprite-planner.html') : '';
const plannerScripts = localScripts(plannerHtml, /<script src="([^"]+)"/g);
// The Body Part Studio is its own page too.
const studioHtml = fs.existsSync(path.join(ROOT, 'studio.html')) ? read('studio.html') : '';
const studioScripts = localScripts(studioHtml, /<script src="([^"]+)"/g);

// vm.Script can't parse import/export, so modules get node's own syntax check.
function moduleSyntaxError(file) {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check', '-'], { input: read(file), encoding: 'utf8' });
  return r.status === 0 ? null : r.stderr;
}

test('every local <script src> exists and parses', () => {
  assert.ok(scripts.length > 5);
  for (const s of scripts) {
    assert.ok(fs.existsSync(path.join(ROOT, s)), `missing script ${s}`);
    assert.doesNotThrow(() => new vm.Script(read(s), { filename: s }), `syntax error in ${s}`);
  }
  for (const s of modules) {
    assert.ok(fs.existsSync(path.join(ROOT, s)), `missing module ${s}`);
    assert.strictEqual(moduleSyntaxError(s), null, `syntax error in module ${s}`);
  }
});

test('every local <script src> in the sprite planner and the Body Part Studio exists', () => {
  for (const s of plannerScripts) assert.ok(fs.existsSync(path.join(ROOT, s)), `sprite-planner.html: missing script ${s}`);
  for (const s of studioScripts) assert.ok(fs.existsSync(path.join(ROOT, s)), `studio.html: missing script ${s}`);
});

test('assets/anim/moves.json: every assigned clip is listed and converted (tools/convert-mocap.js)', () => {
  const file = path.join(ROOT, 'assets/anim/moves.json');
  if (!fs.existsSync(file)) return;
  const moves = JSON.parse(fs.readFileSync(file, 'utf8'));
  const clips = moves.clips || {};
  const states = ['stance', 'attack', 'hitstun', 'idle', 'walk', 'jump', 'jump2', 'block', 'knockdown', 'ko', 'victory'];
  for (const [who, uses] of Object.entries(moves.use || {})) {
    for (const [state, id] of Object.entries(uses)) {
      assert.ok(states.includes(state), `moves.json: ${who} assigns a clip to "${state}", which isn't a move clips can drive (${states.join(', ')})`);
      assert.ok(clips[id], `moves.json: ${who}.${state} uses "${id}", which isn't in "clips"`);
      assert.ok(fs.existsSync(path.join(ROOT, 'assets/anim', id + '.json')), `assets/anim/${id}.json is missing -- run node tools/convert-mocap.js`);
    }
  }
});

test('assets/parts/manifest.json lists only body-part drawings that exist (run tools/update-parts.py)', () => {
  const file = path.join(ROOT, 'assets/parts/manifest.json');
  if (!fs.existsSync(file)) return;
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [id, parts] of Object.entries(manifest)) {
    for (const part of parts) {
      const file = part === 'body' ? 'body.json' : part + '.png';
      assert.ok(fs.existsSync(path.join(ROOT, 'assets/parts', id, file)), `manifest lists assets/parts/${id}/${file}, which doesn't exist`);
    }
  }
});

test('every js file in js/ is loaded by index.html (no orphaned or forgotten scripts)', () => {
  const files = fs.readdirSync(path.join(ROOT, 'js')).map((f) => 'js/' + f);
  const loaded = new Set([...scripts, ...modules, ...plannerScripts]);
  for (const f of files) assert.ok(loaded.has(f), `${f} is not included in index.html (or sprite-planner.html)`);
});

test('every literal getElementById target exists in index.html', () => {
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = [];
  for (const s of [...scripts, ...modules]) {
    for (const m of read(s).matchAll(/getElementById\('([^']+)'\)/g)) {
      if (!ids.has(m[1])) missing.push(`${s}: #${m[1]}`);
    }
  }
  assert.deepStrictEqual(missing, []);
});

test('the screens the UI manager toggles all exist', () => {
  for (const id of ['screen-title', 'screen-select', 'screen-online', 'screen-matchend', 'pause-menu', 'game-canvas']) {
    assert.ok(html.includes(`id="${id}"`), `index.html is missing #${id}`);
  }
});

test('every character has a head image', () => {
  const src = read('js/characters.js');
  const ids = [...src.matchAll(/^\s{2}(\w+): \{\n\s+id: '(\w+)'/gm)].map((m) => m[2]);
  assert.ok(ids.length >= 9, 'expected the full roster');
  for (const id of ids) assert.ok(fs.existsSync(path.join(ROOT, 'assets/heads', id + '.png')), `assets/heads/${id}.png is missing`);
});

test('playlist.json lists only files that exist', () => {
  const dir = path.join(ROOT, 'assets/music');
  const list = JSON.parse(fs.readFileSync(path.join(dir, 'playlist.json'), 'utf8'));
  assert.ok(Array.isArray(list));
  for (const item of list) {
    const file = typeof item === 'string' ? item : item.file;
    assert.ok(fs.existsSync(path.join(dir, file)), `playlist entry ${file} not found in assets/music`);
  }
});

test('the online server can load the sim files it needs (no client-only globals at load time)', () => {
  const serverSrc = read('server/server.js');
  const list = serverSrc.match(/SIM_FILES = \[([^\]]+)\]/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  const ctx = vm.createContext({ console, performance, window: { addEventListener() {} } });
  for (const f of list) {
    assert.doesNotThrow(() => vm.runInContext(read('js/' + f), ctx, { filename: f }), `${f} failed to load in the server sandbox`);
  }
});

test('transformed head images belong to characters that transform, and Robert has his', () => {
  const src = read('js/characters.js');
  const files = fs.readdirSync(path.join(ROOT, 'assets/heads')).filter((f) => f.endsWith('-transformed.png'));
  assert.ok(files.includes('robert-transformed.png'), 'assets/heads/robert-transformed.png is missing');
  for (const f of files) {
    const id = f.replace('-transformed.png', '');
    const start = src.indexOf(`id: '${id}'`);
    assert.ok(start >= 0, `${f}: no character "${id}"`);
    const next = src.indexOf("id: '", start + 6);
    const block = src.slice(start, next < 0 ? undefined : next);
    assert.ok(/transform:\s*\{/.test(block), `${f}: "${id}" has no transformation, so the image would never be used`);
  }
});
