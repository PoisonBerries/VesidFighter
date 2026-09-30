// The list of hand-drawn sprite frames each character needs, derived from
// their move data in characters.js (so frame counts track each move's
// actual timing). Used by tools/sprite-planner.html to build templates and
// a checklist, and meant to be the contract a future sprite loader reads.
//
// Conventions for drawn art:
//   - One horizontal PNG strip per animation:
//       assets/sprites/<characterId>/<animation>.png
//   - Every frame is one cell (cell size per character, below), frames laid
//     left to right with no gaps.
//   - Draw facing RIGHT (the game mirrors for left).
//   - Feet on the baseline, body centered on the center line.
//   - Drawn at PX drawing pixels per game pixel, so art stays crisp when
//     the 3D camera zooms in.
//
// Each frame carries a `setup` describing the simulation state it depicts;
// the planner applies it to a real Fighter to draw a reference ghost and
// the true hitbox for that moment.

const SpritePlan = (() => {
  const PX = 2;
  const MS_PER_TICK = 1000 / 60;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Cell geometry for a character, in drawing pixels.
  function cellFor(char) {
    const bodyH = Math.round(FIGHTER_HEIGHT * char.sizeScale * PX);
    const size = Math.ceil((bodyH * 1.6) / 64) * 64;
    return {
      w: size,
      h: size,
      baseline: Math.round(size * 0.86), // feet y
      centerX: size / 2,
      bodyH,
      bodyW: Math.round(FIGHTER_WIDTH * char.sizeScale * PX),
      px: PX,
    };
  }

  // Split a span of game ticks [t0, t1) into `count` drawn frames.
  function span(phase, t0, t1, count, setup, extra) {
    const out = [];
    const len = Math.max(1, t1 - t0);
    for (let i = 0; i < count; i++) {
      const t = t0 + ((i + 0.5) * len) / count;
      out.push(Object.assign({
        phase,
        ms: Math.round((len / count) * MS_PER_TICK),
        setup: Object.assign({ t: Math.floor(t) }, setup ? setup(t, i) : {}),
      }, extra || {}));
    }
    return out;
  }

  function held(phase, count, ms, setup, extra) {
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push(Object.assign({ phase, ms, setup: Object.assign({ t: 0 }, setup ? setup(i) : {}) }, extra || {}));
    }
    return out;
  }

  // ---- Shared animations ----
  function common(char) {
    const anims = [
      { name: 'idle', label: 'Idle', loop: true, priority: 1,
        note: 'Standing, breathing. Loops.',
        frames: held('idle', 4, 150, () => ({ state: 'idle' })) },
      { name: 'walk', label: 'Walk', loop: true, priority: 1,
        note: 'One full stride (left foot + right foot). Loops.',
        frames: held('walk', 6, 90, (i) => ({ state: 'walk', walkCycle: (i / 6) * Math.PI * 2 })) },
      { name: 'jump', label: 'Jump', loop: false, priority: 2,
        note: 'Not timed: frame 1 shows while rising, 2 at the peak, 3 while falling.',
        frames: [
          { phase: 'rising', ms: 0, setup: { state: 'jump', vy: -10, grounded: false } },
          { phase: 'peak', ms: 0, setup: { state: 'jump', vy: 0, grounded: false } },
          { phase: 'falling', ms: 0, setup: { state: 'fall', vy: 10, grounded: false } },
        ] },
    ];
    if (char.doubleJumpFlip) {
      anims.push({ name: 'jump2', label: 'Double-jump flip', loop: false, priority: 3,
        note: 'Mid-air front flip on the second jump. Draw the body upright; you can rotate it yourself per frame.',
        frames: held('flip', 4, 60, (i) => ({ state: 'jump', vy: -6, grounded: false, doubleJumpFlipTimer: 24 - i * 6 })) });
    }
    anims.push(
      { name: 'block', label: 'Block', loop: false, priority: 2,
        note: 'Held while blocking.',
        frames: held('hold', 1, 0, () => ({ state: 'block', blocking: true })) },
      { name: 'hit', label: 'Hit reaction', loop: false, priority: 1,
        note: 'Frame 1 is the recoil, frame 2 recovering.',
        frames: held('recoil', 1, 100, () => ({ state: 'hitstun', hitFlashTimer: 0 }))
          .concat(held('recover', 1, 120, () => ({ state: 'hitstun' }))) },
      { name: 'knockdown', label: 'Knockdown', loop: false, priority: 3,
        note: 'Knocked off your feet, then lying on the ground before getting up.',
        frames: held('falling', 1, 120, () => ({ state: 'knockdown' }))
          .concat(held('down', 1, 0, () => ({ state: 'knockdown' }))) },
      { name: 'ko', label: 'KO', loop: false, priority: 2,
        note: 'Final hit: reel back, fall, lie still.',
        frames: held('reel', 1, 120, () => ({ state: 'ko' }))
          .concat(held('falling', 1, 120, () => ({ state: 'ko' })))
          .concat(held('down', 1, 0, () => ({ state: 'ko' }))) },
      { name: 'victory', label: 'Victory', loop: true, priority: 3,
        note: 'Winning pose. Loops.',
        frames: held('cheer', 4, 150, () => ({ state: 'victory' })) },
    );

    const a = char.attack;
    anims.push({ name: 'attack', label: 'Basic attack', loop: false, priority: 1,
      note: `Wind-up ${a.startup}f, hit ${a.active}f, recovery ${a.recovery}f (at 60fps). The red box is where the hit lands.`,
      frames: [].concat(
        span('windup', 0, a.startup, clamp(Math.round(a.startup / 4), 1, 3), () => ({ state: 'attack' })),
        span('hit', a.startup, a.startup + a.active, clamp(Math.round(a.active / 3), 1, 2), () => ({ state: 'attack' })),
        span('recovery', a.startup + a.active, a.startup + a.active + a.recovery, clamp(Math.round(a.recovery / 6), 1, 3), () => ({ state: 'attack' })),
      ) });

    return anims;
  }

  // ---- Specials / ultimates, by ability type ----
  function abilityFrames(def, isUlt) {
    const state = isUlt ? 'ultimate' : 'special';
    const S = (fn) => (t, i) => Object.assign({ state }, fn ? fn(t, i) : {});

    switch (def.type) {
      case 'counterDodge':
        return [].concat(
          span('dodge', 0, def.dodgeWindow, 2, S(() => ({ ability: { phase: 'dodge' } }))),
          span('counter strike', 0, def.counterActive, 2, S(() => ({ ability: { phase: 'counter' } }))),
          span('counter recovery', def.counterActive, def.counterActive + def.counterRecovery, 2, S(() => ({ ability: { phase: 'recover' } }))),
          span('whiff (no counter)', 0, def.whiffRecovery, 1, S(() => ({ ability: { phase: 'whiff' } }))),
        );
      case 'phase':
        return span('phased', 0, 24, 2, S(() => ({ invulnerableTimer: 50 })), { loop: true });
      case 'poisonBurst':
      case 'lunge': {
        const end = def.startup + def.active;
        const mid = def.type === 'lunge'
          ? span('roll (game spins this)', def.startup, end, 1, S())
          : span('burst', def.startup, end, 2, S());
        return [].concat(
          span('windup', 0, def.startup, clamp(Math.round(def.startup / 5), 1, 3), S()),
          mid,
          span('recovery', end, end + def.recovery, 2, S()),
        );
      }
      case 'multiHit': {
        let out = [];
        let prev = 0;
        def.hits.forEach((h, idx) => {
          out = out.concat(
            span(`windup ${idx + 1}`, prev, h.start, 1, S()),
            span(`slash ${idx + 1}`, h.start, h.end, 1, S()),
          );
          prev = h.end;
        });
        return out.concat(span('recovery', prev, prev + def.recovery, 2, S()));
      }
      case 'dive': {
        const t1 = def.startup, t2 = def.startup + def.travel;
        const travelName = def.angle === 'down' ? 'diving down' : 'diving forward';
        return [].concat(
          span('windup', 0, t1, 1, S(() => ({ ability: { diving: false } }))),
          span(travelName, t1, t2, 2, S(() => ({ ability: { diving: true }, grounded: def.angle !== 'down' })), { loopPhase: true }),
          span('landing / recovery', t2, t2 + def.recovery, 2, S(() => ({ ability: { diving: false, hasHitOrLanded: true } }))),
        );
      }
      case 'reflectStance':
        return [].concat(
          span('raise guard', 0, def.startup, 1, S()),
          span('reflect stance', def.startup, def.startup + def.duration, 2, S(() => ({ reflectTimer: 20 })), { loopPhase: true }),
          span('recovery', def.startup + def.duration, def.startup + def.duration + def.recoveryAfter, 1, S()),
        );
      case 'buff':
        return span('power up', 0, def.castFrames, 4, S());
      case 'projectileCharge':
        return [].concat(
          span('windup', 0, def.startup, 1, S(() => ({ ability: { charging: true, chargeFrames: 0 } }))),
          span('charging', def.startup, def.startup + 20, 2, S((t) => ({ ability: { charging: true, chargeFrames: Math.floor(t) } })), { loopPhase: true }),
          span('fire', 0, 4, 1, S(() => ({ ability: { charging: false } }))),
          span('recovery', 4, 4 + def.recovery, 2, S(() => ({ ability: { charging: false } }))),
        );
      case 'nuke':
        return [].concat(
          span('channel', 0, def.channel, 3, S(() => ({ ability: { fired: false } })), { loopPhase: true }),
          span('release', def.channel, def.channel + 1, 1, S((t) => ({ ability: { fired: true, firedFrame: Math.floor(t) } }))),
          span('recovery', def.channel + 1, def.channel + 1 + def.recovery, 1, S(() => ({ ability: { fired: true } }))),
        );
      case 'slam':
        return [].concat(
          span('leap up', 0, def.riseFrames, 2, S(() => ({ ability: { launched: true }, grounded: false, vy: -8 }))),
          span('fists down', def.riseFrames, def.riseFrames + 8, 1, S(() => ({ ability: { launched: true }, grounded: false, vy: 12 }))),
          span('impact', 0, 12, 2, S(() => ({ ability: { launched: true, justLanded: true, hasLanded: true } }))),
        );
      case 'soundwaveProjectile':
        return [].concat(
          span('inhale', 0, def.startup, 2, S(() => ({ ability: { fired: false } }))),
          span('shout', def.startup, def.startup + 6, 2, S(() => ({ ability: { fired: true } }))),
          span('recovery', def.startup + 6, def.startup + def.recovery, 1, S(() => ({ ability: { fired: true } }))),
        );
      case 'growRoll': {
        const g = def.growFrames, r = g + def.active, sEnd = r + def.shrinkFrames;
        const ab = { tGrowEnd: g, tRollEnd: r, tShrinkEnd: sEnd, tTotal: sEnd + def.recovery };
        return [].concat(
          span('grow (game scales you up)', 0, g, 1, S(() => ({ ability: ab }))),
          span('roll (game spins this)', g, r, 1, S(() => ({ ability: ab }))),
          span('shrink / recovery', r, sEnd + def.recovery, 2, S(() => ({ ability: ab }))),
        );
      }
      default:
        return span('action', 0, 20, 3, S());
    }
  }

  const TYPE_NOTES = {
    lunge: 'The roll frame is spun by the game, so draw one tucked "ball" pose.',
    growRoll: 'The game scales and spins you; draw normal-size poses.',
    phase: 'The game makes you see-through; draw a normal pose.',
    projectileCharge: 'The plasma bolt itself is drawn by the game. Charging frames loop while the button is held.',
    soundwaveProjectile: 'The soundwave itself is drawn by the game.',
    nuke: 'The blast is drawn by the game. Channel frames loop.',
    poisonBurst: 'The fart cloud is drawn by the game; draw the body.',
    reflectStance: 'Stance frames loop for the whole reflect window.',
    dive: 'Travel frames loop until landing or hitting.',
    buff: 'The size/speed boost is applied by the game; draw the power-up gesture.',
    counterDodge: 'Dodge plays first; if the dodge catches an attack it goes to the counter, otherwise to the whiff frame.',
  };

  function abilityAnim(def, isUlt) {
    return {
      name: isUlt ? 'ultimate' : 'special',
      label: (isUlt ? 'Ultimate: ' : 'Special: ') + def.name,
      loop: false,
      priority: 2,
      note: TYPE_NOTES[def.type] || '',
      frames: abilityFrames(def, isUlt),
    };
  }

  function planFor(char) {
    const anims = common(char);
    anims.push(abilityAnim(char.special, false), abilityAnim(char.ultimate, true));
    return { id: char.id, name: char.name, cell: cellFor(char), anims };
  }

  function all() {
    return CHARACTER_LIST.map(planFor);
  }

  function spritePath(charId, animName) {
    return `assets/sprites/${charId}/${animName}.png`;
  }

  function templatePath(charId, animName) {
    return `assets/sprites/${charId}/_templates/${animName}.png`;
  }

  return { PX, cellFor, planFor, all, spritePath, templatePath };
})();
