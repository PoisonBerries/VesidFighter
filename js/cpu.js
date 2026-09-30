// Computer opponent. Each tick a "brain" looks at the match and produces the
// same input bits a player's keyboard would (see Rollback.BIT), so the CPU
// plays by exactly the rules a person does -- no peeking at the future and
// no special moves outside its character's kit.
//
// It plays like a person rather than a machine:
//  - It sees the opponent through a reaction delay (about 13 frames at
//    Normal): it can't block an attack before a human could have noticed it.
//  - It keeps a preferred spacing for its character, punishes moves that
//    whiff, blocks (crouches under) attacks it sees coming, avoids getting
//    pinned at the edge and recovers when knocked off the stage.
//  - It uses each character's special/ultimate where that move is good.
//  - Difficulty changes reaction time, how often it blocks and punishes, and
//    how often it just makes a mistake.
//
// Randomness comes from its own seeded generator, so a match with the same
// inputs plays out the same way (useful for tests).

const Cpu = (() => {
  const LEVELS = {
    easy: { reaction: 28, block: 0.2, punish: 0.15, iq: 0.35, mistake: 0.3, aggression: 0.35, spacing: 0.4, replan: [16, 32] },
    normal: { reaction: 13, block: 0.62, punish: 0.6, iq: 0.8, mistake: 0.07, aggression: 0.55, spacing: 0.85, replan: [8, 18] },
    hard: { reaction: 8, block: 0.85, punish: 0.9, iq: 1, mistake: 0.02, aggression: 0.62, spacing: 1, replan: [5, 12] },
  };

  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const ACTING = new Set(['attack', 'special', 'ultimate']);
  const MID = (STAGE_LEFT_EDGE + STAGE_RIGHT_EDGE) / 2;

  // What the brain remembers about the opponent each frame.
  function viewOf(f) {
    return {
      x: f.x, y: f.y, vx: f.vx, vy: f.vy, state: f.state, t: f.actionTimer,
      grounded: f.grounded, crouching: f.isCrouching, blocking: f.blocking,
      facing: f.facing, width: f.width, height: f.height, hp: f.hp,
      invuln: f.invulnerableTimer > 0, reflecting: f.reflectTimer > 0,
      ability: f._ability ? { diving: f._ability.diving, fired: f._ability.fired, phase: f._ability.phase } : {},
    };
  }

  // Reach of a forward box: how far (centre to centre) it can connect.
  const reachOf = (offset, width, targetHalfW) => offset + width + targetHalfW;

  function createBrain(slot, levelName, seed) {
    const L = LEVELS[levelName] || LEVELS.normal;
    const rand = rng(seed || 1);
    const history = [];
    let plan = { kind: 'neutral', until: 0, dir: 0 };
    let blockUntil = 0;
    let holdSpecial = 0;   // frames left to keep the special held (Owen's charge)
    let lastPress = -99;   // no button mashing: at most one press every few frames
    let oppAttacks = [];   // ticks when we saw the opponent start an attack (to read spamming)
    let tick = 0;
    const B = Rollback.BIT;

    const chance = (p) => rand() < p;
    const between = (a, b) => a + Math.floor(rand() * (b - a + 1));

    // The opponent as the brain perceives them: `reaction` frames ago.
    function seen() {
      return history[Math.max(0, history.length - 1 - L.reaction)];
    }

    // How dangerous is what the opponent is doing (as perceived)? Returns
    // { frames, low, kind } for an attack about to land on us, or null.
    function threatFrom(me, o) {
      if (!ACTING.has(o.state)) return null;
      const oc = CHARACTERS[opp.character.id];
      const dx = me.x - o.x;
      const dist = Math.abs(dx);
      const toward = Math.sign(dx) === o.facing || dist < 20;
      const halfMe = me.width / 2;
      if (o.state === 'attack') {
        const a = oc.attack;
        if (o.t > a.startup + a.active) return null;
        if (!toward || dist > reachOf(a.offset, a.width, halfMe) + 25) return null;
        return { frames: a.startup - o.t, low: a.high === false, kind: 'melee' };
      }
      const def = o.state === 'ultimate' ? oc.ultimate : oc.special;
      switch (def.type) {
        case 'lunge': case 'growRoll':
          return toward && dist < 380 ? { frames: 6, kind: 'dash' } : null;
        case 'dive':
          if (def.angle === 'down') return dist < 140 ? { frames: 4, kind: 'dive' } : null;
          return toward && dist < def.speed * def.travel + 60 ? { frames: 4, kind: 'dash' } : null;
        case 'poisonBurst': case 'multiHit':
          return toward && dist < reachOf(def.offset, def.width, halfMe) + 20 ? { frames: 4, kind: 'melee', low: def.type === 'poisonBurst' } : null;
        case 'slam':
          return dist < def.radius + halfMe + 30 ? { frames: 6, kind: 'slam' } : null;
        case 'nuke':
          return !o.ability.fired && dist < def.radius + 80 ? { frames: 10, kind: 'nuke' } : null;
        case 'counterDodge':
          return o.ability.phase === 'counter' && dist < 160 ? { frames: 2, kind: 'melee' } : null;
        default:
          return null;
      }
    }

    // A projectile heading our way that we've had time to notice.
    function incomingProjectile(me, projectiles) {
      for (const p of projectiles) {
        if (p.owner === me) continue;
        if (90 - p.life < L.reaction) continue; // too new to have reacted to
        const dx = me.x - p.x;
        if (Math.sign(dx) !== Math.sign(p.vx) || Math.abs(dx) > 520) continue;
        const frames = Math.abs(dx) / Math.max(1, Math.abs(p.vx));
        if (frames < 40) return { frames, p };
      }
      return null;
    }

    let opp = null;

    function think(me, other, projectiles, matchState) {
      tick++;
      opp = other;
      history.push(viewOf(other));
      if (history.length > 60) history.shift();
      // Notice (with the usual delay) each time the opponent starts an attack.
      const cur = history[Math.max(0, history.length - 1 - L.reaction)];
      const prev = history[Math.max(0, history.length - 2 - L.reaction)];
      if (cur !== prev && ACTING.has(cur.state) && (!ACTING.has(prev.state) || cur.t < prev.t)) oppAttacks.push(tick);
      oppAttacks = oppAttacks.filter((t) => tick - t < 180);
      if (matchState !== 'fight') return 0;

      const c = me.character;
      const o = seen();
      // Anticipate: someone walking in keeps coming, so judge distance from
      // where they are *now* (probably), not where we last saw them.
      const moving = o.state === 'walk' || o.state === 'jump' || o.state === 'fall' || o.state === 'block';
      const ox = moving ? o.x + o.vx * L.reaction * 0.85 : o.x;
      const dx = ox - me.x;
      const dir = Math.sign(dx) || me.facing;
      const dist = Math.abs(dx);
      // ...and swing so the punch is out when they arrive, not when it starts.
      const st = c.attack.startup;
      const hitDist = Math.abs((ox + (moving ? o.vx * st : 0)) - (me.x + me.vx * st));
      const toward = dir < 0 ? B.left : B.right;
      const away = dir < 0 ? B.right : B.left;
      const toCenter = me.x < MID ? B.right : B.left;
      const canAct = !ACTING.has(me.state) && me.state !== 'hitstun' && me.state !== 'knockdown' && me.state !== 'ko';
      const press = (bit) => { if (tick - lastPress < 4) return 0; lastPress = tick; return bit; };
      const oppHalf = o.width / 2;
      const myReach = reachOf(c.attack.offset, c.attack.width, oppHalf) - 8;
      const specialReady = me.specialCooldownTimer <= 0;
      const ultReady = me.ultCharge >= ULT_METER_MAX;

      // Owen's charge: keep holding special until the timer runs out.
      if (holdSpecial > 0) {
        holdSpecial--;
        return B.specialHeld | (me.x < STAGE_LEFT_EDGE + 60 ? B.right : me.x > STAGE_RIGHT_EDGE - 60 ? B.left : 0);
      }

      // ---- 1. Get back on the stage ----
      const overVoid = me.x < STAGE_LEFT_EDGE + 4 || me.x > STAGE_RIGHT_EDGE - 4;
      if (!me.grounded && (overVoid || me.y > GROUND_Y)) {
        let b = toCenter;
        const jumpsLeft = me.jumpsUsed < c.maxJumps;
        if (me.vy > 0 && jumpsLeft && me.y > GROUND_Y - 150) b |= press(B.jump);
        if (c.hover && me.vy > -1) b |= B.jumpHeld;
        return b;
      }
      if (!canAct) return 0;

      // Where would we land from here? Never ride a jump off the stage.
      const landX = (x, vx, vy) => {
        const g = GRAVITY * (c.gravityMul || 1);
        const t = (-vy + Math.sqrt(Math.max(0, vy * vy + 2 * g * Math.max(0, GROUND_Y - me.y)))) / g; // frames until back at floor height
        return x + vx * t;
      };
      const safeX = (x) => x > STAGE_LEFT_EDGE + 40 && x < STAGE_RIGHT_EDGE - 40;
      // Dash moves carry you a long way: only from the ground, and only if
      // the dash would end on the stage even if it misses.
      const dashSafe = (distance) => me.grounded && safeX(me.x + dir * distance);
      if (!me.grounded && !safeX(landX(me.x, me.vx, me.vy))) return toCenter;

      // ---- 2. Defend what we can see coming ----
      const threat = threatFrom(me, o);
      const shot = incomingProjectile(me, projectiles);
      if (tick < blockUntil && (threat || shot)) return B.block;

      if ((threat || shot) && !chance(L.mistake)) {
        // Character tools first.
        if (specialReady && c.special.type === 'counterDodge' && threat && threat.kind !== 'nuke' && chance(L.iq)) return press(B.special);
        if (specialReady && c.special.type === 'reflectStance' && chance(L.iq * 0.8)) return press(B.special);
        if (ultReady && c.ultimate.type === 'phase' && threat && (threat.kind !== 'melee' || me.hp < me.maxHp * 0.4)) return press(B.ultimate);
        if (threat && threat.kind === 'nuke') return away | (chance(0.5) ? press(B.jump) : 0);
        if (threat && threat.low) {
          // Low hits go under a guard: hop over or back off.
          if (chance(L.block)) return (me.grounded ? press(B.jump) : 0) | away;
        } else if (chance(L.block)) {
          blockUntil = tick + between(10, 22);
          return B.block;
        }
        if (shot && me.grounded && chance(L.block * 0.6)) return press(B.jump) | toward;
      }

      // They keep swinging up close: crouch under the next one (punches go
      // over a crouch) and punish the whiff below.
      const oc0 = CHARACTERS[opp.character.id];
      const spamming = oppAttacks.length >= 3 && oc0.attack.high !== false;
      if (spamming && !ACTING.has(o.state) && dist < reachOf(oc0.attack.offset, oc0.attack.width, me.width / 2) + 30 && chance(L.block * 0.5)) {
        blockUntil = tick + between(6, 14);
        return B.block;
      }

      // ---- 3. Punish a move that missed (it's recovering, we're close) ----
      if (ACTING.has(o.state) && !threat) {
        const vulnerable = o.state === 'attack'
          ? o.t > CHARACTERS[opp.character.id].attack.startup + CHARACTERS[opp.character.id].attack.active
          : true;
        if (vulnerable && chance(L.punish)) {
          if (hitDist <= myReach) return press(B.attack);
          if (dist <= myReach + 90) return toward;
        }
      }

      // ---- 4. Specials and ultimates where they shine ----
      const oBusyOrOpen = o.state === 'idle' || o.state === 'walk' || ACTING.has(o.state);
      if (ultReady && chance(L.iq * 0.25)) {
        const u = c.ultimate;
        let go = false;
        switch (u.type) {
          case 'poisonBurst': go = dist < reachOf(u.offset, u.width, oppHalf) - 20; break;
          case 'dive': go = u.angle === 'down' ? dist < 70 : (dist > 60 && dist < u.speed * u.travel * 0.8 && o.grounded && !o.crouching && dashSafe(u.speed * u.travel)); break;
          case 'nuke': go = dist < u.radius - 20 && !o.invuln; break;
          case 'growRoll': go = dist > 80 && dist < 380 && o.grounded && dashSafe(u.dashSpeed * u.active); break;
          case 'buff': go = dist > 180; break;
          default: break;
        }
        if (go) return press(B.ultimate);
      }
      if (specialReady && chance(L.iq * 0.18)) {
        const s = c.special;
        switch (s.type) {
          case 'poisonBurst': case 'multiHit':
            if (dist < reachOf(s.offset, s.width, oppHalf) - 15 && oBusyOrOpen) return press(B.special);
            break;
          case 'slam':
            if (dist > 40 && dist < s.radius + 30 && o.grounded) return press(B.special);
            break;
          case 'lunge':
            if (dist > 90 && dist < 250 && o.grounded && dashSafe(s.dashSpeed * s.active + 40)) return press(B.special);
            break;
          case 'soundwaveProjectile':
            if (dist > 180 || ACTING.has(o.state)) return press(B.special);
            break;
          case 'projectileCharge':
            if (dist > 230) {
              if (dist > 430 && !ACTING.has(o.state) && chance(0.6)) holdSpecial = 38; // full charge
              return press(B.special) | B.specialHeld;
            }
            break;
          case 'dive':
            if (s.angle === 'down' && !me.grounded && dist < 70) return press(B.special);
            break;
          default: break;
        }
      }

      // ---- 5. Movement and basic attacks ----
      if (tick >= plan.until) {
        plan = choosePlan(me, o, dist, myReach);
        plan.until = tick + between(L.replan[0], L.replan[1]);
      }

      // Don't walk off the stage.
      const nearLeft = me.x < STAGE_LEFT_EDGE + 70, nearRight = me.x > STAGE_RIGHT_EDGE - 70;
      const guard = (b) => {
        if (nearLeft && (b & B.left) && me.grounded) b &= ~B.left;
        if (nearRight && (b & B.right) && me.grounded) b &= ~B.right;
        return b;
      };

      const oOpen = !o.crouching && !o.invuln && !o.reflecting;
      switch (plan.kind) {
        case 'pressure':
          if (hitDist <= myReach && oOpen) return press(B.attack);
          return guard(toward);
        case 'space': {
          // Hover just outside our own reach; step in when they drift close.
          const want = myReach + 25 + (1 - L.spacing) * 60;
          if (hitDist <= myReach && oOpen && chance(L.aggression)) return press(B.attack);
          if (dist > want + 20) return guard(toward);
          if (dist < want - 30) return guard(away);
          return 0;
        }
        case 'escape':
          // Pinned at the edge: jump over them back towards the middle.
          if (me.grounded) return press(B.jump) | toCenter;
          return toCenter;
        case 'jumpIn':
          if (me.grounded) {
            const jumpVx = (dir < 0 ? -1 : 1) * me.moveSpeedEff;
            if (!safeX(landX(me.x, jumpVx, -c.jumpForce))) { plan.until = 0; return 0; }
            return press(B.jump) | toward;
          }
          if (c.special.type === 'dive' && c.special.angle === 'down' && specialReady && dist < 70) return press(B.special);
          if (dist <= myReach + 10 && me.vy > 0) return press(B.attack) | toward;
          return toward;
        case 'bait':
          // Opponent is turtling: back off a little and wait for them to stand up.
          return dist < myReach + 60 ? guard(away) : 0;
        default:
          return 0;
      }
    }

    function choosePlan(me, o, dist, myReach) {
      const cornered = (me.x < STAGE_LEFT_EDGE + 110 && o.x > me.x) || (me.x > STAGE_RIGHT_EDGE - 110 && o.x < me.x);
      if (cornered && chance(0.5)) return { kind: 'escape' };
      if (o.crouching && dist < myReach + 40 && me.character.attack.high !== false && chance(0.7)) return { kind: 'bait' };
      const c = me.character;
      const jumpy = c.special.type === 'dive' && c.special.angle === 'down';
      if (dist < 260 && chance(jumpy ? 0.35 : 0.08)) return { kind: 'jumpIn' };
      // Push harder when ahead or when they're near the edge (ring-out chance).
      const oNearEdge = o.x < STAGE_LEFT_EDGE + 140 || o.x > STAGE_RIGHT_EDGE - 140;
      const ahead = me.hp / me.maxHp > opp.hp / opp.maxHp + 0.1;
      const aggro = L.aggression + (oNearEdge ? 0.2 : 0) + (ahead ? 0 : 0.1);
      return { kind: chance(aggro) ? 'pressure' : 'space' };
    }

    return { think, level: L };
  }

  // ---- Vs-CPU game mode (the browser) ----
  let brain = null;
  let cpuSlot = 'p2';

  function start(slot, level, seed) {
    cpuSlot = slot;
    brain = createBrain(slot, level, seed);
    Net.setLocalVirtual(true);
  }

  function stop() {
    brain = null;
    Net.setLocalVirtual(false);
  }

  // One fixed tick: the player (either key set) and the CPU both drive
  // virtual keys, then the game steps.
  function tick() {
    const humanSlot = cpuSlot === 'p1' ? 'p2' : 'p1';
    Rollback.applyInput(humanSlot, Rollback.inputBits());
    const w = Game.world();
    const bits = w.p1 && w.p2
      ? brain.think(cpuSlot === 'p1' ? w.p1 : w.p2, cpuSlot === 'p1' ? w.p2 : w.p1, w.projectiles, w.matchState)
      : 0;
    Rollback.applyInput(cpuSlot, bits);
    Game.update(FIXED_STEP);
  }

  return { LEVELS, createBrain, start, stop, tick, isActive: () => !!brain };
})();
