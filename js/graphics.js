// Graphics settings: Cartoon / Low / Medium / High. The first visit starts
// on a tier guessed from the GPU; if a fight runs slowly on any of them, it
// drops to Cartoon on its own. Always full resolution. The 3D view
// (renderer3d.js) reads Graphics.config()
// and listens for changes; the settings panel (the gear by the sound
// button) writes them. Saved in localStorage.
//
// Some things only take effect on the next page load (the stage model file
// and antialiasing, which is fixed when the WebGL context is made):
// Graphics.needsReload() says when that's pending.

const Graphics = (() => {
  const KEY = 'vesid.graphics';
  const TIERS = ['cartoon', 'low', 'medium', 'high'];

  // What each tier turns on. (`maxPixelRatio` caps the screen's pixel ratio.)
  const PRESETS = {
    // The simplest: the Orchard as low-poly cartoon shapes (the original
    // grey-box scenery, toon-shaded) instead of the Blender scene -- so cheap
    // it can run at full resolution, with shadows.
    cartoon: {
      maxPixelRatio: 1, antialias: false,
      shadows: 'low', grassLayers: 0, grassFar: 0,
      materials: 'simple', stageFile: 'none', cardRes: 1, fxRes: 0.75, reflections: false, farTrees: false,
      cartoon: true,
    },
    low: {
      maxPixelRatio: 1, antialias: false,
      shadows: 'off', grassLayers: 0, grassFar: 0,
      materials: 'simple', stageFile: 'lite', cardRes: 0.75, fxRes: 0.5, reflections: false, farTrees: false,
    },
    medium: {
      maxPixelRatio: 1.5, antialias: false,
      shadows: 'low', grassLayers: 6, grassFar: 22,
      materials: 'standard', stageFile: 'lite', cardRes: 1, fxRes: 0.75, reflections: true, farTrees: true,
    },
    high: {
      maxPixelRatio: 2, antialias: true,
      shadows: 'high', grassLayers: 14, grassFar: 32,
      materials: 'full', stageFile: 'full', cardRes: 1.25, fxRes: 1, reflections: true, farTrees: true,
    },
  };

  const read = (k, fallback) => {
    try { return JSON.parse(localStorage.getItem(k)) || fallback; } catch (e) { return fallback; }
  };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };

  // preset: a tier. fps: show the counter. (Older saves had 'auto' and a
  // resolution; those start over from the GPU guess, at full resolution.)
  const saved = read(KEY, {});
  const settings = { preset: saved.preset, fps: !!saved.fps };

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

  if (!TIERS.includes(settings.preset)) {
    settings.preset = guessTier(gpuName());
    write(KEY, settings);
  }

  const tier = () => settings.preset;

  // The settings the renderer actually uses.
  function config() {
    const t = tier();
    return Object.assign({ tier: t }, PRESETS[t]);
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
    if (patch.preset) { perf.reset(); slowedDown = false; }
    changed();
  }

  // ---- Slow fights drop to Cartoon ----
  // The renderer reports each frame (fight frames only). Every few seconds,
  // if the average is under the target, switch to Cartoon (and save it).
  const perf = {
    frames: 0, time: 0, warm: 0,
    reset() { this.frames = 0; this.time = 0; this.warm = 0; },
  };
  let slowedDown = false; // (for the settings panel's note)
  function frame(dt, fighting) {
    fps.tick(dt);
    if (!fighting || settings.preset === 'cartoon') { perf.reset(); return; }
    if (dt >= 0.25) return; // a hitch (tab switch, loading), not the steady rate
    perf.warm += dt;
    if (perf.warm < 2) return; // settle in first
    perf.frames++; perf.time += dt;
    if (perf.time < 3) return;
    const rate = perf.frames / perf.time;
    perf.frames = 0; perf.time = 0;
    if (rate >= 48) return;
    console.info(`[graphics] running at ${rate.toFixed(0)} fps on ${settings.preset} -- switching to cartoon`);
    settings.preset = 'cartoon';
    slowedDown = true;
    perf.reset();
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
        this.el.textContent = `${Math.round(this.n / this.t)} fps · ${c.tier}`;
        this.n = 0; this.t = 0;
      }
    },
  };

  return { PRESETS, TIERS, settings, config, set, onChange, frame, needsReload, guessTier, slowedDown: () => slowedDown };
})();

// ---- The settings panel (the gear by the sound button) ----
(function () {
  const btn = document.getElementById('btn-gfx');
  const panel = document.getElementById('gfx-panel');
  if (!btn || !panel) return;
  const presets = [...panel.querySelectorAll('[data-gfx]')];
  const fps = document.getElementById('gfx-fps');
  const note = document.getElementById('gfx-note');
  const reload = document.getElementById('gfx-reload');

  function refresh() {
    const s = Graphics.settings;
    for (const b of presets) b.classList.toggle('active', b.dataset.gfx === s.preset);
    note.textContent = Graphics.slowedDown() ? 'Switched to Cartoon: fights were running slowly' : '';
    note.hidden = !note.textContent;
    fps.checked = !!s.fps;
    reload.hidden = !Graphics.needsReload();
  }

  btn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { document.getElementById('audio-panel').hidden = true; refresh(); }
  });
  document.getElementById('btn-audio').addEventListener('click', () => { panel.hidden = true; });
  for (const b of presets) b.addEventListener('click', () => Graphics.set({ preset: b.dataset.gfx }));
  fps.addEventListener('change', () => Graphics.set({ fps: fps.checked }));
  document.getElementById('btn-gfx-reload').addEventListener('click', () => location.reload());
  Graphics.onChange(refresh);
  refresh();
})();
