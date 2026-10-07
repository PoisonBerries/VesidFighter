// Graphics settings (js/graphics.js) without a browser: the tier guessed from
// the GPU, what each preset turns on, and what's saved -- and that slow
// fights never change the setting.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT } = require('./helpers');

// A fresh copy of graphics.js with a fake GPU name and localStorage.
function load({ gpu = 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', stored = {}, cores = 8 } = {}) {
  const store = { ...stored };
  const gl = {
    getExtension: (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 1 } : null),
    getParameter: () => gpu,
  };
  const ctx = vm.createContext({
    console: { info() {}, log() {} }, Math, JSON, Object,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
    navigator: { hardwareConcurrency: cores },
    document: { createElement: () => ({ getContext: () => gl }), getElementById: () => null, body: { appendChild() {} } },
  });
  const Graphics = vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'graphics.js'), 'utf8') + '\n;Graphics', ctx);
  return { Graphics, store };
}

test('the tier is guessed from the GPU: integrated Intel and software rendering start on Low, Apple and discrete cards on High', () => {
  const { Graphics } = load();
  const cases = {
    'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)': 'low',
    'ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11)': 'low',
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)), SwiftShader driver)': 'low',
    'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)': 'medium',
    'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11)': 'medium',
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)': 'high',
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)': 'high',
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU Direct3D11)': 'high',
    'Some GPU nobody has heard of': 'medium',
  };
  for (const [gpu, tier] of Object.entries(cases)) assert.strictEqual(Graphics.guessTier(gpu), tier, gpu);
});

test('a weak machine (few cores) holds High back to Medium', () => {
  const { Graphics } = load({ cores: 4 });
  assert.strictEqual(Graphics.guessTier('NVIDIA GeForce GTX 1050'), 'medium');
});

test('each step down the presets costs less: pixel ratio, shadows, grass, materials, scene file', () => {
  const { Graphics } = load();
  const [low, med, high] = ['low', 'medium', 'high'].map((t) => Graphics.PRESETS[t]);
  assert.ok(low.maxPixelRatio <= med.maxPixelRatio && med.maxPixelRatio <= high.maxPixelRatio);
  assert.ok(low.grassLayers < med.grassLayers && med.grassLayers < high.grassLayers);
  assert.deepStrictEqual([low.shadows, med.shadows, high.shadows], ['off', 'low', 'high']);
  assert.deepStrictEqual([low.materials, med.materials, high.materials], ['simple', 'standard', 'full']);
  assert.deepStrictEqual([low.stageFile, high.stageFile], ['lite', 'full']);
  assert.ok(low.fxRes < high.fxRes && low.cardRes < high.cardRes);
  assert.ok(!low.antialias && high.antialias);
});

test('Cartoon, below Low, swaps the scenery for low-poly shapes instead of blurring it: no scene file, full resolution', () => {
  const { Graphics } = load();
  const toon = Graphics.PRESETS.cartoon;
  assert.strictEqual(Graphics.TIERS[0], 'cartoon');
  assert.ok(toon.cartoon);
  assert.strictEqual(toon.stageFile, 'none');
  // Dropping to it is live; going back up to a scene file it never loaded needs a reload.
  Graphics.set({ preset: 'medium' }); // the page "loaded" on Low (UHD 620), lite scene
  assert.strictEqual(Graphics.needsReload(), false);
  Graphics.set({ preset: 'cartoon' });
  assert.strictEqual(Graphics.needsReload(), false);
  const fromToon = load({ stored: { 'vesid.graphics': JSON.stringify({ preset: 'cartoon' }) } });
  fromToon.Graphics.set({ preset: 'low' });
  assert.strictEqual(fromToon.Graphics.needsReload(), true);
});

test('the first visit starts on the guessed tier; picking a preset is saved and reported to listeners', () => {
  const { Graphics, store } = load();
  assert.strictEqual(Graphics.config().tier, 'low'); // UHD 620
  assert.strictEqual(JSON.parse(store['vesid.graphics']).preset, 'low', 'the guess is saved as the choice');
  const seen = [];
  Graphics.onChange((c) => seen.push(c.tier));
  Graphics.set({ preset: 'high' });
  assert.strictEqual(Graphics.config().tier, 'high');
  assert.deepStrictEqual(seen, ['high']);
  assert.deepStrictEqual(JSON.parse(store['vesid.graphics']), { preset: 'high', fps: false });
  // A reload keeps it.
  const again = load({ stored: store });
  assert.strictEqual(again.Graphics.config().tier, 'high');
  // The scene file and antialiasing only change on the next load.
  assert.strictEqual(again.Graphics.needsReload(), false);
  again.Graphics.set({ preset: 'low' });
  assert.strictEqual(again.Graphics.needsReload(), true);
});

test('an old save (Auto, or a lower resolution) starts over from the GPU guess', () => {
  const { Graphics } = load({ gpu: 'NVIDIA GeForce RTX 3060', stored: { 'vesid.graphics': JSON.stringify({ preset: 'auto', scale: 0.7, fps: true }) } });
  assert.strictEqual(Graphics.config().tier, 'high');
  assert.strictEqual(Graphics.settings.fps, true);
  assert.ok(!('scale' in Graphics.config()), 'no resolution setting: always full');
});

test('a fight that runs slowly keeps the chosen setting (it just runs at a lower frame rate)', () => {
  const { Graphics, store } = load({ gpu: 'NVIDIA GeForce RTX 3060' });
  assert.strictEqual(Graphics.config().tier, 'high');
  for (let i = 0; i < 20 * 60; i++) Graphics.frame(1 / 20);   // a minute at 20 fps
  assert.strictEqual(Graphics.config().tier, 'high');
  assert.strictEqual(JSON.parse(store['vesid.graphics']).preset, 'high');
});
