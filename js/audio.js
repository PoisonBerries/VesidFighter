// Sound: synthesized sound effects (WebAudio, no asset files needed) and a
// soundtrack player that plays whatever mp3s are listed in
// assets/music/playlist.json. Client-only; the sim never calls into this.
// Browsers block audio until the user interacts, so everything stays silent
// until the first click or keypress.

const Sfx = (() => {
  // v2: new defaults (louder effects, quieter music). Bumping the key drops
  // volumes saved under the old defaults so everyone gets the new mix once.
  const STORE_KEY = 'vf_audio_v2';
  const settings = { music: 0.25, sfx: 0.8, muted: false };
  // The effects slider spans 0..SFX_BOOST times the raw synth level, so its
  // top end (and the default) sit well above what 100% used to be. A
  // compressor on the effects bus keeps the loud end from clipping.
  const SFX_BOOST = 2.5;
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
      const limiter = ac.createDynamicsCompressor();
      limiter.threshold.value = -14;
      limiter.knee.value = 12;
      limiter.ratio.value = 6;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.2;
      sfxBus.connect(limiter);
      limiter.connect(ac.destination);
      applyVolumes();
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ac.state === 'suspended') ac.resume();
    return true;
  }

  function applyVolumes() {
    if (sfxBus) sfxBus.gain.value = settings.muted ? 0 : settings.sfx * SFX_BOOST;
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
    // Ryan's combo tune (Ode to Joy): each hit in an unbroken string plays the next note.
    note(i, pan) {
      const MELODY = [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62, 64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 62, 60, 60];
      const m = MELODY[i % MELODY.length] + (Math.floor(i / MELODY.length) % 2) * 12;
      const f = 440 * Math.pow(2, (m - 69) / 12);
      tone({ type: 'triangle', f0: f, dur: 0.42, vol: 0.5, attack: 0.008, pan });
      tone({ type: 'sine', f0: f * 2, dur: 0.3, vol: 0.18, attack: 0.008, pan });
      tone({ type: 'square', f0: f * 0.5, dur: 0.18, vol: 0.07, pan });
      noise({ filter: 'lowpass', f0: 2400, f1: 300, q: 0.5, dur: 0.08, vol: 0.22, pan }); // a soft thump under it
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
    phasestep(pan) {
      noise({ f0: 1200, f1: 6500, q: 1.1, dur: 0.16, vol: 0.2, attack: 0.02, pan });
      tone({ f0: 1400, f1: 260, dur: 0.16, vol: 0.14, attack: 0.01, pan });
      tone({ type: 'triangle', f0: 620, f1: 1500, dur: 0.12, vol: 0.1, delay: 0.14, pan });
    },
    drill(pan) {
      noise({ f0: 500, f1: 3200, q: 1.3, dur: 0.4, vol: 0.24, attack: 0.03, pan });
      tone({ type: 'sawtooth', f0: 200, f1: 620, dur: 0.38, vol: 0.14, attack: 0.02, pan });
      tone({ type: 'square', f0: 900, f1: 1500, dur: 0.3, vol: 0.06, delay: 0.06, pan });
    },
    slide(pan) {
      noise({ f0: 500, f1: 2400, q: 0.9, dur: 0.5, vol: 0.2, attack: 0.04, pan });
      noise({ filter: 'lowpass', f0: 900, f1: 260, q: 0.6, dur: 0.45, vol: 0.14, pan });
    },
    swim(pan) {
      noise({ f0: 1300, f1: 3200, q: 1.2, dur: 0.1, vol: 0.09, attack: 0.01, pan });
      tone({ f0: 700, f1: 380, dur: 0.06, vol: 0.05, pan });
    },
    roll(pan) {
      noise({ filter: 'lowpass', f0: 700, f1: 240, q: 0.7, dur: 0.3, vol: 0.2, attack: 0.03, pan });
      tone({ f0: 120, f1: 70, dur: 0.16, vol: 0.16, pan });
    },
    hover(pan) {
      noise({ filter: 'lowpass', f0: 1100, f1: 380, q: 0.7, dur: 0.32, vol: 0.24, attack: 0.04, pan });
      tone({ type: 'sawtooth', f0: 85, f1: 120, dur: 0.3, vol: 0.1, attack: 0.05, pan });
    },
    boing(pan) {
      tone({ f0: 240, f1: 620, dur: 0.16, vol: 0.28, pan });
      tone({ f0: 620, f1: 260, dur: 0.22, vol: 0.22, delay: 0.14, pan });
      tone({ f0: 300, f1: 420, dur: 0.16, vol: 0.12, delay: 0.32, pan });
    },
    // Hot potato: a rubbery volley bonk, and the explosion.
    // heat (rally ball, 0-10) raises the pitch and adds a crack.
    bonk(pan, heat) {
      const k = 1 + (heat || 0) * 0.09;
      tone({ f0: 420 * k, f1: 180 * k, dur: 0.12, vol: 0.32, pan });
      tone({ type: 'triangle', f0: 880 * k, f1: 520 * k, dur: 0.07, vol: 0.12, pan });
      noise({ filter: 'lowpass', f0: 1800, f1: 400, dur: 0.06, vol: 0.12, pan });
      if (heat >= 4) noise({ filter: 'highpass', f0: 2500 + heat * 300, dur: 0.08, vol: 0.05 * heat, pan });
    },
    boom(pan) {
      noise({ filter: 'lowpass', f0: 2600, f1: 90, q: 0.4, dur: 0.9, vol: 0.7, pan });
      tone({ f0: 110, f1: 28, dur: 0.8, vol: 0.8, pan });
      tone({ type: 'sawtooth', f0: 70, f1: 30, dur: 0.5, vol: 0.2, pan });
    },
    tick() { tone({ type: 'square', f0: 520, dur: 0.11, vol: 0.13 }); },
    // The orchard car's horn: two honks, from the side it's coming in on.
    horn(pan) {
      for (const delay of [0, 0.32]) {
        tone({ type: 'sawtooth', f0: 392, dur: 0.22, vol: 0.13, attack: 0.02, delay, pan });
        tone({ type: 'sawtooth', f0: 494, dur: 0.22, vol: 0.1, attack: 0.02, delay, pan });
      }
    },
    go() {
      tone({ type: 'square', f0: 780, dur: 0.32, vol: 0.16 });
      tone({ type: 'square', f0: 1170, dur: 0.32, vol: 0.1 });
      noise({ f0: 400, f1: 3000, dur: 0.3, vol: 0.14, attack: 0.05 });
    },
    click() { tone({ type: 'square', f0: 720, f1: 480, dur: 0.045, vol: 0.09 }); },
    transform(pan) {
      // Building rumble and growl...
      tone({ type: 'sawtooth', f0: 55, f1: 110, dur: 0.55, vol: 0.32, attack: 0.08, pan });
      tone({ type: 'square', f0: 80, f1: 160, dur: 0.5, vol: 0.12, attack: 0.1, pan });
      noise({ filter: 'lowpass', f0: 300, f1: 1400, q: 0.7, dur: 0.55, vol: 0.25, attack: 0.1, pan });
      // ...cloth ripping...
      noise({ filter: 'highpass', f0: 2500, dur: 0.18, vol: 0.22, delay: 0.35, attack: 0.01, pan });
      noise({ f0: 3200, f1: 1200, q: 1.5, dur: 0.14, vol: 0.2, delay: 0.48, pan });
      // ...then the roar and a heavy landing.
      tone({ type: 'sawtooth', f0: 150, f1: 70, dur: 0.5, vol: 0.3, delay: 0.55, attack: 0.02, pan });
      tone({ f0: 90, f1: 30, dur: 0.45, vol: 0.65, delay: 0.58, pan });
      noise({ filter: 'lowpass', f0: 900, f1: 150, dur: 0.4, vol: 0.4, delay: 0.58, pan });
    },
  };

  // Specials/ultimates keyed by ability type (shared across characters).
  function ability(type, isUlt, pan, def) {
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
      case 'multiHit': {
        const wind = def && def.hits && def.hits.length === 1 ? def.hits[0].start / 60 : 0;
        if (wind) {
          // One huge slash: a rising, ominous charge (the audible tell)...
          noise({ f0: 250, f1: 1500, q: 0.9, dur: wind * 0.95, vol: 0.14, attack: wind * 0.7, pan });
          tone({ type: 'sawtooth', f0: 90, f1: 320, dur: wind * 0.95, vol: 0.11, attack: wind * 0.7, pan });
          tone({ f0: 900, f1: 1800, dur: 0.08, vol: 0.1, delay: wind * 0.85, pan });
          // ...then the heavy strike as it lands.
          noise({ f0: 600, f1: 3400, q: 1.1, dur: 0.18, vol: 0.34, delay: wind, pan });
          tone({ f0: 210, f1: 60, dur: 0.3, vol: 0.45, delay: wind + 0.02, pan });
        } else {
          noise({ f0: 700, f1: 3000, q: 1.2, dur: 0.12, vol: 0.22, pan });
          noise({ f0: 3000, f1: 700, q: 1.2, dur: 0.12, vol: 0.22, delay: 0.12, pan });
        }
        break;
      }
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
    if (kind && kind.startsWith('ball')) { if (gate('bonk', 40)) SOUNDS.bonk(0, Number(kind.split(':')[1]) || 0); return; }
    if (kind && kind.startsWith('note:')) { if (gate('note', 40)) SOUNDS.note(Number(kind.split(':')[1]) || 0, 0); return; }
    if (kind === 'boom') { if (gate('boom', 200)) SOUNDS.boom(0); return; }
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

  // ---- Voice lines (assets/voice/<character>/) ----
  // VOICE maps a character and an occasion to the file(s) that play; give a
  // list to pick one at random. 'vs:<character>' lines play once at the start
  // of a match against that character. Occasions are triggered from the sim through
  // Effects.voice(characterId, occasion) (see effects.js), so they work
  // online and are skipped when the game replays frames for rollback.
  const VOICE = {
    keenan: {
      enemyFall: 'KeenanEnemyFall.mp3',            // the opponent falls off the map
      hitByProjectile: 'KeenanHitByProjectile.mp3', // he's hit by a projectile
      phaseStep: 'KeenanPhaseStep.mp3',             // when he slips behind the opponent
      victory: 'KeenanVictory.mp3',                 // when he wins the match
      hitByWater: 'KeenanHitByWaterAttack.mp3',     // hit by one of Sam's water attacks (his special or ultimate)
      recovery: 'KeenanRecovery.mp3',               // when he gets back up after being knocked down
      hitTaken: 'KeenanHitTaken.mp3',               // someone lands a punch or kick on him
      selected: 'KeenanSelected.mp3',               // he's clicked on in the character select menu
      'vs:ryan': 'KeenanVsRyan.mp3',                // at the start of a match against Ryan (once per match)
      'vs:nathan': 'KeenanVsNathan.mp3',            // at the start of a match against Nathan (once per match)
      'vs:john': 'KeenanVsJohn.mp3',                // at the start of a match against John (once per match)
      'vs:robert': 'KeenanVsRob.mp3',               // at the start of a match against Robert (once per match)
    },
  };
  VOICE.artur = {
    fart: 'ArturFart.mp3',                          // when he lets one rip (special or ultimate)
    hitTaken: 'ArturHitTaken.mp3',                  // someone lands a punch or kick on him
    selected: 'ArturSelected.mp3',                  // he's clicked on in the character select menu
  };
  VOICE.carlos = {
    hitTaken: ['CarlosHitTaken.mp3', 'CarlosHitTaken2.mp3'], // someone lands a punch or kick on him (one of two, at random)
    selected: 'CarlosSelected.mp3',                 // he's clicked on in the character select menu
    bigHit: 'CarlosBigDamageTaken.mp3',             // a heavy blow: 15% of his health or more in one hit
    fallOff: 'CarlosFallsOffMap.mp3',               // he falls off the map
  };
  VOICE.nathan = {
    hitTaken: 'NathanHitTaken.mp3',                 // someone lands a punch or kick on him
    fallOff: 'NathanFallsOffMap.mp3',               // he falls off the map
    selected: 'NathanSelected.mp3',                 // he's clicked on in the character select menu
    'vs:john': 'NathanVsJohn.mp3',                  // at the start of a match against John (once per match)
    'vs:artur': 'NathanVsArtur.mp3',                // at the start of a match against Artur (once per match)
    knockedDown: ['NathanKnockedDown.mp3', 'NathanKnockedDown2.mp3'], // he's knocked down (one of two, at random)
    ultimate: 'NathanUlt.mp3',                      // when he uses his ultimate
    'beats:owen': 'NathanBeatsOwen.mp3',            // when he wins a match against Owen
  };
  VOICE.ryan = {
    'vs:john': 'RyanVsJohn.mp3',                    // at the start of a match against John (once per match)
    ultimate: 'RyanYeah.mp3',                       // "Yeah!" as he kicks off Encore
  };
  VOICE.robert = {
    selected: 'RobFunny.mp3',                       // he's clicked on in the character select menu
    hitTaken: 'RobHitTaken.mp3',                    // someone lands a punch or kick on him
    block: 'RobBlock.mp3',                          // he blocks a hit
    dealsBigDamage: 'RobDealsBigDamage.mp3',        // he lands a heavy blow (15% of the target's health or more)
    matchStart: 'RobMatchStart.mp3',                // at the start of a match (not if a matchup line is playing)
    transform: 'RobWowWow.mp3',                     // when he transforms
  };
  VOICE.owen = {
    'vs:john': 'OwenVsJohn.mp3',                    // at the start of a match against John (once per match)
    hitTaken: 'OwenHitTaken.mp3',                   // someone lands a punch or kick on him
    bigHit: 'OwenBigHitTaken.mp3',                  // a heavy blow: 15% of his health or more in one hit
    foeRunsAway: 'OwenOpponentRunsAwayAfterHit.mp3', // he lands a hit and the opponent backs off
    roundWin: 'OwenTaunting.mp3',                   // he wins a round (but not the match): a taunt
    ultimate: 'OwenFinisher.mp3',                   // his finishing move: the ultimate
    sing: 'OwenSmallChancetoSingAtRandom.mp3',      // a small chance, every so often in a fight, that he breaks into song
    selected: 'OwenSelected.mp3',                   // he's clicked on in the character select menu
    enemyFall: 'OwenLaugh.mp3',                     // he laughs when the opponent falls off the map
    victory: 'OwenVictory.mp3',                     // when he wins the match
    'vs:artur': 'artur/OwenVsArtur.mp3',            // (the file is in Artur's folder) at the start of a match against Artur (once per match)
  };
  // Voice files are recorded at very different levels, so each is levelled when
  // it's loaded: measure its loudness (RMS over the stretches that aren't
  // silence) and scale it to a common target, without letting the peaks clip.
  // Nothing is changed in the files themselves.
  const VOICE_TARGET_DB = -21;   // gated RMS every line is brought to
  const VOICE_MAX_PEAK = 0.89;   // about -1 dBFS
  const VOICE_MAX_GAIN = 12;     // (+21.6 dB) so a near-silent file isn't blown up into noise
  function loudnessGain(buf) {
    const a = buf.getChannelData(0), win = Math.max(1, Math.round(buf.sampleRate * 0.05));
    const rms = [];
    let peak = 0;
    for (let i = 0; i + win <= a.length; i += win) {
      let sum = 0;
      for (let j = i; j < i + win; j++) { const v = a[j]; sum += v * v; const m = v < 0 ? -v : v; if (m > peak) peak = m; }
      rms.push(Math.sqrt(sum / win));
    }
    const top = Math.max(1e-9, ...rms);
    const live = rms.filter((r) => r > top * 0.03); // skip silence and breaths
    if (!live.length || peak <= 0) return 1;
    const mean = Math.sqrt(live.reduce((t, r) => t + r * r, 0) / live.length);
    const want = Math.pow(10, VOICE_TARGET_DB / 20) / mean;
    return Math.min(want, VOICE_MAX_PEAK / peak, VOICE_MAX_GAIN);
  }
  const voiceBuffers = {}; // path -> decoded audio (or null if it can't be loaded)
  let voiceVsAt = -1e9;    // when a matchup line last started
  const voiceLast = {};    // character -> when its last line started

  // Whether this character is in the middle of a match in a transformed state (Robert): his
  // lines are then played deeper. (Not in the menus, where a stale match could still be loaded.)
  const DEEP_RATE = 0.8; // playback speed: lower and slower, a heavier voice
  function isTransformed(charId) {
    try {
      if (typeof Game === 'undefined' || Game.getState() === 'idle') return false;
      const w = Game.world();
      return [w.p1, w.p2].some((f) => f && f.character.id === charId && f.transformed && f.character.transform);
    } catch (e) { return false; }
  }

  function voice(charId, occasion) {
    const lines = VOICE[charId] || {};
    // A general match-start line gives way to a matchup line that's already playing.
    if (occasion === 'matchStart' && performance.now() - voiceVsAt < 300) return;
    // Being hit by anything (projectile, special, ultimate, the ball...) without a line of its own plays the plain hit-taken line.
    const entry = lines[occasion] || (occasion.startsWith('hitBy') ? lines.hitTaken : null);
    if (!entry || !ensure()) return;
    const file = Array.isArray(entry) ? entry[Math.floor(Math.random() * entry.length)] : entry;
    // (a file name with a folder in it, like 'artur/Line.mp3', is taken from that folder instead)
    const path = file.includes('/') ? `assets/voice/${file}` : `assets/voice/${charId}/${file}`;
    const now = performance.now();
    if (now - (voiceLast[charId] === undefined ? -1e9 : voiceLast[charId]) < 700 || settings.muted) return; // one voice at a time per fighter
    voiceLast[charId] = now;
    if (occasion.startsWith('vs:')) voiceVsAt = now;
    const deep = isTransformed(charId);
    api.lastVoice = { charId, occasion, path, deep }; // (for tests and debugging)
    const go = (buf) => {
      if (!buf) return;
      const src = ac.createBufferSource();
      src.buffer = buf;
      if (buf.leveled === undefined) buf.leveled = loudnessGain(buf);
      const g = ac.createGain();
      g.gain.value = buf.leveled;
      if (deep) {
        // Deepened: slowed down (which lowers the pitch), a boost to the low end and the top rolled off.
        src.playbackRate.value = DEEP_RATE;
        const low = ac.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 220; low.gain.value = 7;
        const top = ac.createBiquadFilter(); top.type = 'lowpass'; top.frequency.value = 4200;
        src.connect(low); low.connect(top); top.connect(g);
      } else {
        src.connect(g);
      }
      g.connect(sfxBus);
      src.start();
    };
    if (path in voiceBuffers) { go(voiceBuffers[path]); return; }
    voiceBuffers[path] = null;
    fetch(encodeURI(path))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('missing'))))
      .then((data) => new Promise((resolve, reject) => ac.decodeAudioData(data, resolve, reject)))
      .then((buf) => { voiceBuffers[path] = buf; go(buf); })
      .catch(() => { delete voiceBuffers[path]; });
  }

  const api = {
    voice, loudnessGain,
    swing: (pan) => play('swing', pan),
    hover: (pan) => play('hover', pan),
    roll: (pan) => play('roll', pan),
    slide: (pan) => play('slide', pan),
    swim: (pan) => play('swim', pan),
    drill: (pan) => play('drill', pan),
    phasestep: (pan) => play('phasestep', pan),
    boing: (pan) => play('boing', pan),
    jump: (n, pan) => play('jump', n, pan),
    land: (impactAmt, pan) => play('land', impactAmt, pan),
    thud: (pan) => play('thud', pan),
    ko: (pan) => play('ko', pan),
    fall: (pan) => play('fall', pan),
    victory: () => play('victory'),
    tick: () => play('tick'),
    horn: (pan) => play('horn', pan),
    go: () => play('go'),
    click: () => play('click'),
    transform: (pan) => play('transform', pan),
    ability(type, isUlt, pan, def) { if (ensure() && gate('ability', 40)) ability(type, isUlt, pan, def); },
    impact,
    settings, save, applyVolumes, ensure, sfxBoost: SFX_BOOST,
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
      else if (idx >= 0) label.textContent = '\u266A ' + tracks[order[idx]].title;
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
    btn.textContent = Sfx.settings.muted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
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
