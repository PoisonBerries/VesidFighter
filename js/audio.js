// Sound: synthesized sound effects (WebAudio, no asset files needed) and a
// soundtrack player that plays whatever mp3s are listed in
// assets/music/playlist.json. Client-only; the sim never calls into this.
// Browsers block audio until the user interacts, so everything stays silent
// until the first click or keypress.

const Sfx = (() => {
  const STORE_KEY = 'vf_audio_v1';
  const settings = { music: 0.5, sfx: 0.7, muted: false };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch (e) { /* private mode */ }
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ } }

  let ac = null, sfxBus = null, noiseBuf = null;
  const lastPlayed = {};

  function ensure() {
    if (!ac) {
      try {
        ac = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) { return false; }
      sfxBus = ac.createGain();
      sfxBus.connect(ac.destination);
      applyVolumes();
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ac.state === 'suspended') ac.resume();
    return true;
  }

  function applyVolumes() {
    if (sfxBus) sfxBus.gain.value = settings.muted ? 0 : settings.sfx;
    Music.applyVolume();
  }

  // Skip a sound that already fired a moment ago (both peers' events,
  // multi-hit sparks, etc. shouldn't stack into a louder blast).
  function gate(name, ms) {
    const now = performance.now();
    if (now - (lastPlayed[name] || 0) < ms) return false;
    lastPlayed[name] = now;
    return !!ac && !settings.muted;
  }

  function out(pan, when) {
    if (pan && ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = Math.max(-0.8, Math.min(0.8, pan * 0.6));
      p.connect(sfxBus);
      return p;
    }
    return sfxBus;
  }

  // One oscillator with a pitch sweep and a fast attack / exponential decay.
  function tone(o) {
    const t0 = ac.currentTime + (o.delay || 0);
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f0, t0);
    if (o.f1 && o.f1 !== o.f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t0 + o.dur);
    const peak = o.vol || 0.3, atk = o.attack || 0.004;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    osc.connect(g);
    g.connect(out(o.pan));
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.03);
  }

  // Filtered noise with a cutoff sweep -- whooshes, thumps' bodies, dust.
  function noise(o) {
    const t0 = ac.currentTime + (o.delay || 0);
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ac.createBiquadFilter();
    f.type = o.filter || 'bandpass';
    f.Q.value = o.q || 0.8;
    f.frequency.setValueAtTime(o.f0, t0);
    if (o.f1 && o.f1 !== o.f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + o.dur);
    const g = ac.createGain();
    const peak = o.vol || 0.3, atk = o.attack || 0.006;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    src.connect(f);
    f.connect(g);
    g.connect(out(o.pan));
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + o.dur + 0.03);
  }

  const SOUNDS = {
    swing(pan) {
      noise({ f0: 500, f1: 2600, q: 1.1, dur: 0.15, vol: 0.22, attack: 0.03, pan });
    },
    hit(strength, pan) {
      const s = Math.max(0.3, Math.min(1, strength || 0.6));
      noise({ filter: 'lowpass', f0: 3200, f1: 260, q: 0.5, dur: 0.11 + 0.1 * s, vol: 0.5 * s + 0.15, pan });
      tone({ f0: 230, f1: 48, dur: 0.14 + 0.12 * s, vol: 0.55 * s + 0.15, pan });
      tone({ type: 'square', f0: 950, f1: 180, dur: 0.035, vol: 0.12, pan });
    },
    block(pan) {
      tone({ type: 'triangle', f0: 1500, f1: 880, dur: 0.11, vol: 0.25, pan });
      tone({ type: 'square', f0: 640, f1: 600, dur: 0.06, vol: 0.09, pan });
      noise({ filter: 'highpass', f0: 3200, dur: 0.05, vol: 0.14, pan });
    },
    dodge(pan) {
      noise({ f0: 1400, f1: 5200, q: 0.9, dur: 0.26, vol: 0.16, attack: 0.05, pan });
      tone({ f0: 500, f1: 1250, dur: 0.22, vol: 0.09, attack: 0.05, pan });
    },
    reflect(pan) {
      tone({ type: 'sawtooth', f0: 1900, f1: 380, dur: 0.2, vol: 0.2, pan });
      tone({ f0: 2500, f1: 900, dur: 0.15, vol: 0.12, pan });
    },
    jump(n, pan) {
      const up = n >= 2;
      tone({ f0: up ? 380 : 250, f1: up ? 780 : 520, dur: 0.13, vol: 0.16, pan });
      noise({ filter: 'highpass', f0: 2400, dur: 0.06, vol: 0.07, pan });
    },
    land(impact, pan) {
      noise({ filter: 'lowpass', f0: 1000, f1: 200, dur: 0.11, vol: 0.14 + 0.25 * impact, pan });
      tone({ f0: 130, f1: 58, dur: 0.11, vol: 0.14 + 0.3 * impact, pan });
    },
    thud(pan) {
      tone({ f0: 100, f1: 32, dur: 0.3, vol: 0.7, pan });
      noise({ filter: 'lowpass', f0: 700, f1: 120, dur: 0.22, vol: 0.4, pan });
    },
    ko(pan) {
      tone({ type: 'sawtooth', f0: 520, f1: 70, dur: 0.6, vol: 0.22, pan });
      noise({ filter: 'lowpass', f0: 2500, f1: 200, dur: 0.4, vol: 0.3, pan });
      tone({ f0: 90, f1: 30, dur: 0.4, vol: 0.6, delay: 0.08, pan });
    },
    fall(pan) {
      tone({ f0: 950, f1: 140, dur: 0.95, vol: 0.12, attack: 0.05, pan });
    },
    victory() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone({ type: 'triangle', f0: f, dur: 0.28, vol: 0.2, delay: i * 0.11 }));
      tone({ type: 'triangle', f0: 1046.5, dur: 0.6, vol: 0.18, delay: 0.5 });
    },
    tick() { tone({ type: 'square', f0: 520, dur: 0.11, vol: 0.13 }); },
    go() {
      tone({ type: 'square', f0: 780, dur: 0.32, vol: 0.16 });
      tone({ type: 'square', f0: 1170, dur: 0.32, vol: 0.1 });
      noise({ f0: 400, f1: 3000, dur: 0.3, vol: 0.14, attack: 0.05 });
    },
    click() { tone({ type: 'square', f0: 720, f1: 480, dur: 0.045, vol: 0.09 }); },
    transform() {
      tone({ type: 'sawtooth', f0: 70, f1: 140, dur: 0.6, vol: 0.3, attack: 0.05 });
      noise({ f0: 200, f1: 1600, dur: 0.6, vol: 0.2, attack: 0.1 });
    },
  };

  // Specials/ultimates keyed by ability type (shared across characters).
  function ability(type, isUlt, pan) {
    switch (type) {
      case 'projectileCharge':
      case 'soundwaveProjectile':
        tone({ type: 'sawtooth', f0: 1500, f1: 300, dur: 0.2, vol: 0.18, pan });
        tone({ f0: 700, f1: 200, dur: 0.22, vol: 0.14, pan });
        break;
      case 'nuke':
        tone({ f0: 180, f1: 900, dur: 0.5, vol: 0.2, attack: 0.1, pan });
        tone({ f0: 70, f1: 28, dur: 0.6, vol: 0.5, delay: 0.5, pan });
        break;
      case 'dive':
      case 'slam':
      case 'lunge':
      case 'growRoll':
        noise({ f0: 250, f1: 2000, q: 1, dur: 0.34, vol: 0.28, attack: 0.05, pan });
        tone({ f0: 120, f1: 70, dur: 0.3, vol: 0.2, pan });
        break;
      case 'multiHit':
        noise({ f0: 700, f1: 3000, q: 1.2, dur: 0.12, vol: 0.22, pan });
        noise({ f0: 3000, f1: 700, q: 1.2, dur: 0.12, vol: 0.22, delay: 0.12, pan });
        break;
      case 'counterDodge':
        SOUNDS.dodge(pan);
        break;
      case 'buff':
        [392, 493.9, 587.3].forEach((f, i) => tone({ type: 'triangle', f0: f, f1: f * 1.01, dur: 0.3, vol: 0.16, delay: i * 0.08, pan }));
        break;
      case 'reflectStance':
        tone({ type: 'triangle', f0: 1200, f1: 1180, dur: 0.4, vol: 0.16, pan });
        tone({ type: 'triangle', f0: 1810, f1: 1790, dur: 0.35, vol: 0.1, pan });
        break;
      case 'poisonBurst':
        tone({ type: 'sawtooth', f0: 150, f1: 62, dur: 0.38, vol: 0.28, pan });
        tone({ type: 'square', f0: 155, f1: 66, dur: 0.38, vol: 0.12, pan });
        noise({ filter: 'lowpass', f0: 600, f1: 200, dur: 0.35, vol: 0.2, pan });
        break;
      default:
        noise({ f0: 400, f1: 2400, dur: 0.25, vol: 0.2, pan });
    }
    if (isUlt) {
      tone({ f0: 200, f1: 1000, dur: 0.5, vol: 0.14, attack: 0.15, pan });
      tone({ f0: 80, f1: 35, dur: 0.5, vol: 0.4, pan });
    }
  }

  // Hit sparks carry their result in the colour (see game.js resolveCombat).
  function impact(color, kind) {
    if (kind === 'muzzle' || !ensure()) return;
    const c = (color || '').toLowerCase();
    if (c === '#9fd8ff') { if (gate('block', 40)) SOUNDS.block(0); }
    else if (c === '#ffffff') { if (gate('dodge', 80)) SOUNDS.dodge(0); }
    else if (c === '#ff3b3b') { if (gate('reflect', 60)) SOUNDS.reflect(0); }
    else if (gate('hit', 45)) SOUNDS.hit(0.7, 0);
  }

  function play(name, ...args) {
    if (!ensure() || !gate(name, 25)) return;
    SOUNDS[name](...args);
  }

  const api = {
    swing: (pan) => play('swing', pan),
    jump: (n, pan) => play('jump', n, pan),
    land: (impactAmt, pan) => play('land', impactAmt, pan),
    thud: (pan) => play('thud', pan),
    ko: (pan) => play('ko', pan),
    fall: (pan) => play('fall', pan),
    victory: () => play('victory'),
    tick: () => play('tick'),
    go: () => play('go'),
    click: () => play('click'),
    transform: () => play('transform'),
    ability(type, isUlt, pan) { if (ensure() && gate('ability', 40)) ability(type, isUlt, pan); },
    impact,
    settings, save, applyVolumes, ensure,
    toggleMute() { settings.muted = !settings.muted; save(); applyVolumes(); return settings.muted; },
  };

  // ---- Soundtrack ----------------------------------------------------
  const Music = (() => {
    let tracks = [];      // [{ url, title }]
    let order = [];
    let idx = -1;
    let el = null;
    let started = false;
    let loaded = false;
    const DIR = 'assets/music/';

    function titleOf(file) {
      return decodeURIComponent(file).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
    }

    async function load() {
      if (loaded) return;
      loaded = true;
      let files = [];
      try {
        const res = await fetch(DIR + 'playlist.json', { cache: 'no-cache' });
        if (res.ok) files = await res.json();
      } catch (e) { /* no playlist */ }
      if (!Array.isArray(files) || !files.length) {
        // Local dev servers with directory listings: pick up mp3s directly.
        try {
          const res = await fetch(DIR);
          if (res.ok) {
            const html = await res.text();
            files = [...html.matchAll(/href="([^"?#]+\.(?:mp3|ogg|wav|m4a))"/gi)].map((m) => decodeURIComponent(m[1]).split('/').pop());
          }
        } catch (e) { /* none */ }
      }
      tracks = files
        .map((f) => (typeof f === 'string' ? { file: f } : f))
        .filter((f) => f && f.file)
        .map((f) => ({ url: DIR + encodeURIComponent(f.file), title: f.title || titleOf(f.file) }));
      order = tracks.map((_, i) => i).sort(() => Math.random() - 0.5);
      updateLabel();
    }

    function applyVolume() {
      if (el) el.volume = settings.muted ? 0 : settings.music;
    }

    function updateLabel() {
      const label = document.getElementById('now-playing');
      if (!label) return;
      if (!tracks.length) label.textContent = 'Add mp3s to assets/music/';
      else if (idx >= 0) label.textContent = '♪ ' + tracks[order[idx]].title;
      else label.textContent = tracks.length + ' track' + (tracks.length > 1 ? 's' : '');
    }

    function next() {
      if (!tracks.length) return;
      idx = (idx + 1) % order.length;
      if (!el) {
        el = new Audio();
        el.preload = 'auto';
        el.addEventListener('ended', next);
        el.addEventListener('error', () => setTimeout(next, 500)); // skip an unplayable file
      }
      el.src = tracks[order[idx]].url;
      applyVolume();
      el.play().catch(() => { /* blocked until a gesture; retried on the next one */ });
      updateLabel();
    }

    async function start() {
      if (started) return;
      started = true;
      await load();
      next();
    }

    return { start, next, applyVolume, load };
  })();

  api.Music = Music;
  return api;
})();

// ---- Wiring: unlock on first gesture, button click sounds, volume panel ----
(function () {
  function unlock() {
    Sfx.ensure();
    Sfx.Music.start();
  }
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('button') && !e.target.closest('#audio-ctl')) Sfx.click();
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyM' && !/INPUT|TEXTAREA/.test((e.target.tagName || ''))) {
      Sfx.toggleMute();
      refresh();
    }
  });

  const btn = document.getElementById('btn-audio');
  const panel = document.getElementById('audio-panel');
  const musicVol = document.getElementById('vol-music');
  const sfxVol = document.getElementById('vol-sfx');
  const skip = document.getElementById('btn-skip-track');
  if (!btn) return;

  function refresh() {
    btn.textContent = Sfx.settings.muted ? '🔇' : '🔊';
  }
  musicVol.value = Sfx.settings.music * 100;
  sfxVol.value = Sfx.settings.sfx * 100;
  refresh();

  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; });
  btn.addEventListener('contextmenu', (e) => { e.preventDefault(); Sfx.toggleMute(); refresh(); });
  musicVol.addEventListener('input', () => { Sfx.settings.music = musicVol.value / 100; Sfx.save(); Sfx.applyVolumes(); });
  sfxVol.addEventListener('input', () => { Sfx.settings.sfx = sfxVol.value / 100; Sfx.save(); Sfx.applyVolumes(); });
  sfxVol.addEventListener('change', () => Sfx.click());
  skip.addEventListener('click', () => Sfx.Music.next());
  document.getElementById('btn-mute').addEventListener('click', () => { Sfx.toggleMute(); refresh(); });
})();
