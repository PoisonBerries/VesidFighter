// Graphics settings: Low / Medium / High presets, or Auto (the default),
// which guesses a tier from the GPU and then steps down on its own if a
// fight runs slowly. The 3D view (renderer3d.js) reads Graphics.config()
// and listens for changes; the settings panel (the gear by the sound
// button) writes them. Saved in localStorage.
//
// Some things only take effect on the next page load (the stage model file
// and antialiasing, which is fixed when the WebGL context is made):
// Graphics.needsReload() says when that's pending.

const Graphics = (() => {
  const KEY = 'vesid.graphics';
  const AUTO_KEY = 'vesid.graphics.auto';
  const TIERS = ['cartoon', 'low', 'medium', 'high'];

  // What each tier turns on. `scale` multiplies the render resolution
  // (after capping the screen's pixel ratio at `maxPixelRatio`).
  const PRESETS = {
    // The simplest: the Orchard as low-poly cartoon shapes (the original
    // grey-box scenery, toon-shaded) instead of the Blender scene -- so cheap
    // it can run at full resolution, with shadows.
    cartoon: {
      maxPixelRatio: 1, scale: 1, antialias: false,
      shadows: 'low', grassLayers: 0, grassFar: 0,
      materials: 'simple', stageFile: 'none', cardRes: 1, fxRes: 0.75, reflections: false, farTrees: false,
      cartoon: true,
    },
    low: {
      maxPixelRatio: 1, scale: 0.75, antialias: false,
      shadows: 'off', grassLayers: 0, grassFar: 0,
      materials: 'simple', stageFile: 'lite', cardRes: 0.75, fxRes: 0.5, reflections: false, farTrees: false,
    },
    medium: {
      maxPixelRatio: 1.5, scale: 1, antialias: false,
      shadows: 'low', grassLayers: 6, grassFar: 22,
      materials: 'standard', stageFile: 'lite', cardRes: 1, fxRes: 0.75, reflections: true, farTrees: true,
    },
    high: {
      maxPixelRatio: 2, scale: 1, antialias: true,
      shadows: 'high', grassLayers: 14, grassFar: 32,
      materials: 'full', stageFile: 'full', cardRes: 1.25, fxRes: 1, reflections: true, farTrees: true,
    },
  };

  const read = (k, fallback) => {
    try { return JSON.parse(localStorage.getItem(k)) || fallback; } catch (e) { return fallback; }
  };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };

  // preset: 'auto' | tier. scale: null (the preset's own) or 0.5..1. fps: show the counter.
  const settings = Object.assign({ preset: 'auto', scale: null, fps: false }, read(KEY, {}));
  // What Auto has settled on (from the GPU, then from how fights actually ran).
  let auto = read(AUTO_KEY, null);

  // ---- Guessing a tier from the GPU ----
  function gpuName() {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return '';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return String(name || '');
    } catch (e) {
      return '';
    }
  }

  function guessTier(gpu) {
    const g = gpu.toLowerCase();
    let tier;
    if (/swiftshader|llvmpipe|software|basic render|microsoft basic/.test(g)) tier = 'low';
    else if (/geforce|rtx|gtx|quadro|radeon rx|radeon pro|radeon r9|arc\b|apple m\d (pro|max|ultra)/.test(g)) tier = 'high';
    else if (/apple m\d|apple gpu/.test(g)) tier = 'high';
    else if (/iris|radeon\(tm\) graphics|radeon graphics|vega/.test(g)) tier = 'medium';
    else if (/intel|uhd|hd graphics|mali|adreno|powervr|videocore/.test(g)) tier = 'low';
    else tier = 'medium';
    // Few cores or little memory: hold back a step.
    const weakBox = (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) || (navigator.deviceMemory && navigator.deviceMemory <= 4);
    if (weakBox && tier === 'high') tier = 'medium';
    return tier;
  }

  if (!auto || !TIERS.includes(auto.tier)) {
    const gpu = gpuName();
    auto = { tier: guessTier(gpu), scale: null, gpu };
    write(AUTO_KEY, auto);
  }

  const tier = () => (settings.preset === 'auto' ? auto.tier : settings.preset);

  // The settings the renderer actually uses.
  function config() {
    const t = tier();
    const c = Object.assign({ tier: t }, PRESETS[t]);
    if (settings.scale) c.scale = settings.scale;
    else if (settings.preset === 'auto' && auto.scale) c.scale = auto.scale;
    return c;
  }

  // What the page was loaded with (for the reload-only settings). Going
  // down to Cartoon is live (the low-poly orchard is always there); a
  // different scene file needs a reload.
  const loaded = config();
  const needsReload = () => {
    const c = config();
    return (c.stageFile !== 'none' && c.stageFile !== loaded.stageFile) || c.antialias !== loaded.antialias;
  };

  const listeners = [];
  const onChange = (fn) => listeners.push(fn);
  function changed() {
    write(KEY, settings);
    const c = config();
    for (const fn of listeners) fn(c);
  }

  function set(patch) {
    Object.assign(settings, patch);
    if (patch.preset === 'auto') { // choosing Auto again starts the learning over
      auto = { tier: guessTier(auto.gpu || gpuName()), scale: null, gpu: auto.gpu };
      write(AUTO_KEY, auto);
      perf.reset();
    }
    changed();
  }

  // ---- Auto: step down when fights run slowly ----
  // The renderer reports each frame (fight frames only). Every few seconds,
  // if the average is under the target, take one step: render resolution
  // first (cheap and hard to notice), then a whole tier.
  const SCALE_STEPS = [1, 0.85, 0.7];
  const perf = {
    frames: 0, time: 0, warm: 0,
    reset() { this.frames = 0; this.time = 0; this.warm = 0; },
  };
  function frame(dt, fighting) {
    fps.tick(dt);
    if (!fighting || settings.preset !== 'auto' || settings.scale) { perf.reset(); return; }
    if (dt >= 0.25) return; // a hitch (tab switch, loading), not the steady rate
    perf.warm += dt;
    if (perf.warm < 2) return; // settle in first
    perf.frames++; perf.time += dt;
    if (perf.time < 3) return;
    const rate = perf.frames / perf.time;
    perf.frames = 0; perf.time = 0;
    if (rate >= 48) return;
    const cur = auto.scale || PRESETS[auto.tier].scale;
    const next = SCALE_STEPS.find((s) => s < cur - 0.01);
    if (next && cur > 0.7) {
      auto.scale = next;
    } else if (auto.tier !== TIERS[0]) {
      auto.tier = TIERS[TIERS.indexOf(auto.tier) - 1];
      auto.scale = null;
    } else {
      return; // nothing left to give
    }
    write(AUTO_KEY, auto);
    perf.warm = 0;
    console.info(`[graphics] running at ${rate.toFixed(0)} fps -- stepping down to ${auto.tier}, resolution ${Math.round((auto.scale || PRESETS[auto.tier].scale) * 100)}%`);
    changed();
  }

  // ---- FPS counter ----
  const fps = {
    el: null, n: 0, t: 0,
    tick(dt) {
      if (!settings.fps) { if (this.el) this.el.hidden = true; return; }
      if (!this.el) {
        this.el = document.createElement('div');
        this.el.id = 'fps-counter';
        document.body.appendChild(this.el);
      }
      this.el.hidden = false;
      this.n++; this.t += dt;
      if (this.t >= 0.5) {
        const c = config();
        this.el.textContent = `${Math.round(this.n / this.t)} fps · ${c.tier} · ${Math.round(c.scale * 100)}%`;
        this.n = 0; this.t = 0;
      }
    },
  };

  return { PRESETS, TIERS, settings, config, set, onChange, frame, needsReload, guessTier, autoInfo: () => auto };
})();

// ---- The settings panel (the gear by the sound button) ----
(function () {
  const btn = document.getElementById('btn-gfx');
  const panel = document.getElementById('gfx-panel');
  if (!btn || !panel) return;
  const presets = [...panel.querySelectorAll('[data-gfx]')];
  const scale = document.getElementById('gfx-scale');
  const scaleValue = document.getElementById('gfx-scale-value');
  const fps = document.getElementById('gfx-fps');
  const note = document.getElementById('gfx-auto-note');
  const reload = document.getElementById('gfx-reload');
  const name = (t) => t[0].toUpperCase() + t.slice(1);

  function refresh() {
    const s = Graphics.settings, c = Graphics.config();
    for (const b of presets) b.classList.toggle('active', b.dataset.gfx === s.preset);
    note.textContent = s.preset === 'auto' ? `Using ${name(c.tier)} on this computer` : '';
    scale.value = Math.round(c.scale * 100);
    scaleValue.textContent = `${scale.value}%`;
    fps.checked = !!s.fps;
    reload.hidden = !Graphics.needsReload();
  }

  btn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { document.getElementById('audio-panel').hidden = true; refresh(); }
  });
  document.getElementById('btn-audio').addEventListener('click', () => { panel.hidden = true; });
  for (const b of presets) b.addEventListener('click', () => Graphics.set({ preset: b.dataset.gfx, scale: null }));
  scale.addEventListener('input', () => Graphics.set({ scale: scale.value / 100 }));
  fps.addEventListener('change', () => Graphics.set({ fps: fps.checked }));
  document.getElementById('btn-gfx-reload').addEventListener('click', () => location.reload());
  // (arrow keys on the slider would also move the fighters)
  scale.addEventListener('keydown', (e) => e.stopPropagation());
  Graphics.onChange(refresh);
  refresh();
})();
