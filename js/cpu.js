// Computer opponent. Each tick a "brain" looks at the match and produces the
// same input bits a player's keyboard would (see Rollback.BIT), so the CPU
// plays by exactly the rules a person does -- no peeking at the future and
// no special moves outside its character's kit.
//
// It plays like a person rather than a machine:
//  - It sees the opponent through a reaction delay (about half a second at
//    Normal): it can't block an attack before a human could have noticed it.
//  - It keeps a preferred spacing for its character, punishes moves that
//    whiff, blocks (crouches under) attacks it sees coming, avoids getting
//    pinned at the edge and recovers when knocked off the stage.
//  - It uses each character's special/ultimate where that move is good.
//  - It plays the ball: hits it at you, catches or dodges your shots
//    (rally), and gets clear of a bomb that's about to blow.
//  - Difficulty changes reaction time, how often it blocks and punishes, and
//    how often it just makes a mistake.
//
// Randomness comes from its own seeded generator, so a match with the same
// inputs plays out the same way (useful for tests).
//
// Unbeatable is a different brain (createSearchBrain, below): no reaction
// delay or deliberate mistakes, and instead of rules it plays the options
// out ahead of time in a copy of the fight and picks the best.

const Cpu = (() => {
  const LEVELS = {
    // reaction: frames of delay before it sees what you do. anticipate: how
    // well it predicts where a moving opponent will be (0-1). aim: how far
    // off (px) its sense of range can be, so it swings early/late sometimes.
    // pressGap: minimum frames between button presses (no chaining attacks).
    // idle: chance each new plan is to just stand there for a moment.
    easy: { reaction: 45, block: 0.05, punish: 0.05, iq: 0.15, mistake: 0.55, aggression: 0.2, spacing: 0.2, anticipate: 0.1, aim: 70, replan: [24, 48], pressGap: 22, idle: 0.4 },
    normal: { reaction: 34, block: 0.1, punish: 0.1, iq: 0.3, mistake: 0.38, aggression: 0.25, spacing: 0.4, anticipate: 0.3, aim: 50, replan: [18, 36], pressGap: 20, idle: 0.3 },
    hard: { reaction: 28, block: 0.2, punish: 0.2, iq: 0.45, mistake: 0.25, aggression: 0.3, spacing: 0.55, anticipate: 0.45, aim: 36, replan: [14, 28], pressGap: 16, idle: 0.2 },
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
  const midX = () => (STAGE_LEFT_EDGE + STAGE_RIGHT_EDGE) / 2; // (per stage)

  // What the brain remembers about the opponent each frame.
  function viewOf(f) {
    return {
      x: f.x, y: f.y, vx: f.vx, vy: f.vy, state: f.state, t: f.actionTimer,
      grounded: f.grounded, crouching: f.isCrouching, blocking: f.blocking,
      facing: f.facing, width: f.width, height: f.height, hp: f.hp,
      invuln: f.invulnerableTimer > 0, reflecting: f.reflectTimer > 0, airAttack: !!f.airAttackActive,
      ability: f._ability ? { diving: f._ability.diving, fired: f._ability.fired, phase: f._ability.phase } : {},
    };
  }

  // Reach of a forward box: how far (centre to centre) it can connect.
  const reachOf = (offset, width, targetHalfW) => offset + width + targetHalfW;

  function createBrain(slot, levelName, seed) {
    const L = LEVELS[levelName] || LEVELS.normal;
    const rand = rng(seed || 1);
    const history = [];
    let plan = { kind: 'neutral', until: 0, dir: 0, aimError: 0 };
    let blockUntil = 0;
    let holdSpecial = 0;   // frames left to keep the special held (Owen's charge)
    let lastPress = -99;   // no button mashing: at most one press every few frames
    let oppAttacks = [];   // ticks when we saw the opponent start an attack (to read spamming)
    let ballKey = '';      // the ball's current flight, to decide once per flight...
    let ballWill = false;  // ...whether we'll deal with it properly this time
    let ballCatch = false; // ...and whether we'd try to catch it (rally)
    let ballAim = 0, ballAimUntil = 0; // direction to keep holding through a swing at it
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
      if (o.state === 'hoverdive') { // Carlos's claw dive: forward and down
        const dd = me.x - o.x;
        return Math.sign(dd) === o.facing && Math.abs(dd) < 300 ? { frames: 5, kind: 'dash' } : null;
      }
      if (!ACTING.has(o.state)) return null;
      const oc = CHARACTERS[opp.character.id];
      const dx = me.x - o.x;
      const dist = Math.abs(dx);
      const toward = Math.sign(dx) === o.facing || dist < 20;
      const halfMe = me.width / 2;
      if (o.state === 'attack') {
        const a = o.airAttack ? oc.airAttack : oc.attack;
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
        case 'poisonBurst': case 'multiHit': {
          // A slow single slash (Carlos) telegraphs itself: the real frames until it lands.
          const wind = def.type === 'multiHit' && def.hits.length === 1 ? Math.max(1, def.hits[0].start - o.t) : 4;
          return toward && dist < reachOf(def.offset, def.width, halfMe) + 20 ? { frames: wind, kind: 'melee', low: def.type === 'poisonBurst' } : null;
        }
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

    // A copy of the ball stepped `n` frames ahead with the game's own physics.
    function ballAfter(b, n) {
      const s = { x: b.x, y: b.y, vx: b.vx, vy: b.vy, spin: 0, hitstop: b.hitstop || 0, live: b.live, liveBounces: b.liveBounces };
      for (let i = 0; i < n; i++) Game.ballPhysics.step(s);
      return s;
    }

    const distSqToRect = (px, py, r) => {
      const dx = Math.max(r.x - px, 0, px - (r.x + r.w));
      const dy = Math.max(r.y - py, 0, py - (r.y + r.h));
      return dx * dx + dy * dy;
    };

    // Which way to hold (toward 1 / neutral 0 / away -1) so a hit from `from`
    // does the most damage: rally aims the shot through them, bomb drops it
    // on them.
    function bestAim(me, o, from, rally) {
      if (!chance(L.iq)) return 0;
      const target = { x: o.x, y: o.y - o.height / 2 };
      let best = Infinity, pick = 0;
      for (const aim of [0, 1, -1]) {
        const [vx, vy] = Game.ballPhysics.launch(me.grounded, aim, false, (from.heat || 0) + 1);
        const b = { x: from.x, y: from.y, vx: me.facing * vx, vy, hitstop: 0, live: true, liveBounces: RALLY_LIVE_BOUNCES, spin: 0 };
        let score = Infinity;
        for (let n = 0; n < 90; n++) {
          Game.ballPhysics.step(b);
          if (rally) {
            const d = Math.hypot(b.x - target.x, b.y - target.y);
            if (d < score) score = d;
          } else if (b.y + BALL_RADIUS >= GROUND_Y) {
            score = Math.abs(b.x - o.x);
            break;
          }
        }
        if (score < best) { best = score; pick = aim; }
      }
      return pick;
    }

    // The ball. Returns input bits, or null to carry on as usual.
    function playBall(me, o, ball, c, press, safeX) {
      if (!ball || ball.phase !== 'live') return null;
      const rally = Game.world().ballMode === 'rally';
      // Decide once per flight (each hit starts a new one) whether we read it
      // right, and whether we'd try to catch it.
      const key = (ball.lastHit || '-') + (ball.vy < 0 ? 'u' : 'd') + (ball.live ? 'L' : '') + (ball.heldBy || '');
      if (key !== ballKey) {
        ballKey = key;
        // Rally: the ball is the game, so every level goes for it (skill shows
        // in aim and catching); bomb: it's a hazard only smarter CPUs play.
        ballWill = (Game.world().ballMode === 'rally' || chance(L.iq)) && !chance(L.mistake);
        ballCatch = chance(L.block);
      }

      const walk = (target) => {
        if (Math.abs(target - me.x) < 10 || !safeX(target)) return 0;
        return target < me.x ? B.left : B.right;
      };

      // Holding a caught ball: a short wind-up, then throw it at them.
      if (ball.heldBy === me.slot) {
        if (RALLY_HOLD - ball.holdT < 10) return 0;
        ballAim = bestAim(me, o, ball, true);
        ballAimUntil = tick + c.attack.startup + 2;
        return press(B.attack) | aimBits(me);
      }
      if (ball.heldBy) return null;
      if (!ballWill) return null;

      // Bomb about to go off nearby: get out of the blast.
      const dx = ball.x - me.x;
      if (!rally && ball.fuse < 75 && Math.abs(dx) < BALL_BLAST_RADIUS + 70) {
        const run = walk(me.x - Math.sign(dx || 1) * 200);
        return run || walk(me.x + Math.sign(dx || 1) * 400); // cornered: run past it
      }

      // Swing now if the punch would be out when the ball gets there.
      const a = c.attack;
      const bottom = a.high === false ? 0 : me.height * HIGH_ATTACK_BOTTOM;
      const cx = me.x + me.facing * a.offset;
      const box = { x: cx - (me.facing === 1 ? 0 : a.width), y: me.y - bottom - a.height, w: a.width, h: a.height };
      if (me.grounded) {
        for (const n of [a.startup + 1, a.startup + a.active]) {
          const p = ballAfter(ball, n);
          if (distSqToRect(p.x, p.y, box) < BALL_HIT_RADIUS * BALL_HIT_RADIUS * 0.7) {
            ballAim = bestAim(me, o, Object.assign(p, { heat: ball.heat }), rally);
            ballAimUntil = tick + a.startup + a.active + 2;
            return press(B.attack) | aimBits(me);
          }
        }
      }

      // Rally: a live shot of theirs coming at us -- catch it, or get out of the way.
      if (rally && ball.live && ball.lastHit !== me.slot) {
        const body = { x: me.x - me.width / 2, y: me.y - me.height, w: me.width, h: me.height };
        let arrive = -1;
        for (let n = 1; n <= 40; n++) {
          const p = ballAfter(ball, n);
          if (distSqToRect(p.x, p.y, body) <= BALL_RADIUS * BALL_RADIUS) { arrive = n; break; }
        }
        if (arrive > 0) {
          if (ballCatch && me.grounded && arrive <= RALLY_CATCH_WINDOW - 3) return B.block;
          if (!ballCatch && me.grounded && arrive <= 14) return press(B.jump, true) | (dx > 0 ? B.left : B.right);
          return ballCatch ? 0 : null;
        }
        return null;
      }
      if (!me.grounded) return null;

      if (rally) {
        // A loose ball: go get it, unless they're much nearer it.
        if (ball.live) return null;
        const soon = ballAfter(ball, 15);
        if (Math.abs(soon.x - me.x) > Math.abs(soon.x - o.x) + 220) return null;
        return walk(soon.x - me.facing * (a.offset + a.width * 0.45));
      }

      if (ball.vy <= 0 && ball.y < me.y - me.height * 1.6) return null; // still rising, far above
      // Bomb: where will it come down to punch height? Is it ours to take?
      const hitY = me.y - bottom - a.height * 0.5;
      let land = null;
      for (let n = 1; n < 150; n += 2) {
        const p = ballAfter(ball, n);
        if (p.vy > 0 && p.y >= hitY) { land = { x: p.x, n }; break; }
      }
      if (!land) return null;
      if (Math.abs(land.x - me.x) > 340 || Math.abs(land.x - me.x) > Math.abs(land.x - o.x) + 40) return null;
      // Stand so it drops just in front of us.
      return walk(land.x - me.facing * (a.offset + a.width * 0.45));
    }

    function aimBits(me) {
      if (!ballAim) return 0;
      return ballAim * me.facing > 0 ? B.right : B.left;
    }

    let opp = null;

    // Fighters only turn by moving the other way, so the CPU turns to face
    // the opponent first -- a tap towards them -- before swinging at them,
    // and when it's standing still with its back to them.
    function think(me, other, projectiles, matchState, ball) {
      const pressedBefore = lastPress;
      let b = decide(me, other, projectiles, matchState, ball);
      if (matchState !== 'fight' || me.facingLocked || me.state === 'block' || ACTING.has(me.state)) return b;
      const dx = other.x - me.x, want = dx >= 0 ? 1 : -1;
      if (me.facing === want || Math.abs(dx) < 8) return b;
      const towardBit = want > 0 ? B.right : B.left;
      const swing = B.attack | B.special | B.ultimate;
      const reach = reachOf(me.character.attack.offset, me.character.attack.width, other.width / 2);
      // (up close, turning to face them beats backing off with its back turned)
      if (me.grounded && Math.abs(dx) < reach + 40 && !(b & B.jump)) {
        if (b & swing) lastPress = pressedBefore;
        return (b & ~swing & ~(B.left | B.right)) | towardBit;
      }
      if ((b & swing) && Math.abs(dx) < reach + 60) {
        lastPress = pressedBefore; // the swing didn't happen: it can come right after the turn
        return (b & ~swing & ~(B.left | B.right)) | towardBit;
      }
      if (!(b & (B.left | B.right | swing))) b |= towardBit;
      return b;
    }

    function decide(me, other, projectiles, matchState, ball) {
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
      const ox = moving ? o.x + o.vx * L.reaction * L.anticipate : o.x;
      const dx = ox - me.x;
      const dir = Math.sign(dx) || me.facing;
      const dist = Math.abs(dx);
      // ...and swing so the punch is out when they arrive, not when it starts.
      const st = c.attack.startup;
      // A misjudged range, re-rolled every plan change (not every frame).
      const hitDist = Math.max(0, Math.abs((ox + (moving ? o.vx * st : 0)) - (me.x + me.vx * st)) + plan.aimError);
      const toward = dir < 0 ? B.left : B.right;
      const away = dir < 0 ? B.right : B.left;
      const toCenter = me.x < midX() ? B.right : B.left;
      const canAct = !ACTING.has(me.state) && me.state !== 'hitstun' && me.state !== 'knockdown' && me.state !== 'ko';
      // Recovering (getting back on the stage) isn't held back by pressGap.
      const press = (bit, urgent) => { if (tick - lastPress < (urgent ? 4 : L.pressGap)) return 0; lastPress = tick; return bit; };
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
        if (me.vy > 0 && jumpsLeft && me.y > GROUND_Y - 150) b |= press(B.jump, true);
        if (c.hover && me.vy > -1) b |= B.jumpHeld;
        return b;
      }
      if (ACTING.has(me.state) && tick < ballAimUntil) return aimBits(me);
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

      // ---- The stage (stages.js): the car, and platforms ----
      const car = Stage.car(), cd = Stage.def().car;
      if (car && me.platform === 'car') return press(B.jump, true); // hop off before it carries us away
      if (car && car.phase === 'drive' && me.grounded && me.y > GROUND_Y - cd.height && !chance(L.mistake)) {
        // Jump just before it reaches us: over it, or onto the roof.
        const gap = (me.x - (car.x + car.dir * cd.width / 2)) * car.dir; // > 0 while it's still coming
        if (gap > -me.width / 2 && gap < Math.max(Math.abs(car.dx), cd.speed * 0.5) * 8 + me.width / 2) return press(B.jump, true);
      }
      if (me.grounded && o.grounded && o.y < me.y - 60 && dist < 170) return press(B.jump) | toward; // up after them
      if (me.platform && me.platform !== 'car' && o.y > me.y + 60 && dist < 110) return B.block | press(B.jump); // drop down to them

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

      const ballBits = playBall(me, o, ball, c, press, safeX);
      if (ballBits !== null && (ballBits !== 0 || (ball && ball.heldBy === me.slot))) return ballBits;

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
            // A long, telegraphed wind-up only lands on someone who can't get out of the way
            // (in hitstun, or committed to a move), so wait for that instead of throwing it at range.
            if (s.type === 'multiHit' && s.hits.length === 1 && s.hits[0].start >= 20) {
              if (dist < reachOf(s.offset, s.width, oppHalf) - 40 && (o.state === 'hitstun' || ACTING.has(o.state) || o.state === 'knockdown')) return press(B.special);
              break;
            }
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
        plan.aimError = (rand() * 2 - 1) * L.aim;
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
      if (chance(L.idle)) return { kind: 'idle' };
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

  // ---- Unbeatable: search instead of rules ----
  // The game is deterministic and can save and restore its whole state (the
  // rollback netcode relies on that), so this brain doesn't guess: every few
  // frames it tries each thing it could do right now -- the same buttons a
  // player has -- against each of a handful of things the opponent might be
  // doing, plays every pair out a short way into the future in a copy of the
  // fight, and does whatever comes out best even when the opponent picks
  // their best answer to it.
  //
  // It sees what a player sees (where everyone is, what move they're in,
  // health, meters, the ball) and never reads the opponent's controls: their
  // side of each future is a guess from that list. What makes it so hard to
  // beat is that it reacts on the frame and never misjudges a range.
  const SEARCH = {
    every: 3,     // frames between decisions
    horizon: 32,  // frames each future is played out
  };

  // opts: override SEARCH (tests pit it against a stronger version of itself).
  function createSearchBrain(slot, opts) {
    const cfg = Object.assign({}, SEARCH, opts);
    const B = Rollback.BIT;
    const oppSlot = slot === 'p1' ? 'p2' : 'p1';
    let plan = null, planAt = 0, tick = 0;

    // A plan: inputs frame by frame, `hold` held throughout, `taps` pressed
    // on the frames listed ({ frame: bits }).
    const mk = (name, hold, taps) => ({ name, hold, taps: taps || {} });
    const bitsAt = (p, t) => p.hold | (p.taps[t] || 0);

    function myPlans(me, o) {
      const toward = o.x >= me.x ? B.right : B.left, away = toward === B.right ? B.left : B.right;
      const c = me.character;
      const plans = [
        mk('wait', 0),
        mk('walk in', toward),
        mk('back off', away),
        mk('crouch', B.block),
        mk('guard', B.guard),
        mk('attack', 0, { 0: B.attack }),
        mk('step in + attack', toward, { 0: B.attack }),
        mk('down + attack', B.block, { 0: B.attack }),
        mk('jump in', toward | B.jumpHeld, { 0: B.jump }),
        mk('jump back', away | B.jumpHeld, { 0: B.jump }),
        mk('jump in + air attack', toward | B.jumpHeld, { 0: B.jump, 8: B.attack }),
        mk('jump + late air attack', toward | B.jumpHeld, { 0: B.jump, 16: B.attack }),
      ];
      if (!me.grounded) {
        // In the air: drift, a (double) jump towards the middle, air attacks.
        const toMid = me.x < (STAGE_LEFT_EDGE + STAGE_RIGHT_EDGE) / 2 ? B.right : B.left;
        plans.push(mk('jump to the middle', toMid | B.jumpHeld, { 0: B.jump }));
        plans.push(mk('drift to the middle', toMid));
        plans.push(mk('down + air attack', B.block, { 0: B.attack }));
      }
      if (me.specialCooldownTimer <= 0) {
        plans.push(mk('special', 0, { 0: B.special }));
        plans.push(mk('special toward', toward, { 0: B.special }));
        if (c.special.type === 'projectileCharge') plans.push(mk('charged special', B.specialHeld, { 0: B.special }));
        if (!me.grounded) plans.push(mk('special to the middle', me.x < (STAGE_LEFT_EDGE + STAGE_RIGHT_EDGE) / 2 ? B.right : B.left, { 0: B.special }));
      }
      if (me.ultCharge >= ULT_METER_MAX) {
        plans.push(mk('ultimate', 0, { 0: B.ultimate }));
        plans.push(mk('ultimate toward', toward, { 0: B.ultimate }));
      }
      return plans;
    }

    // What the opponent might do over the same stretch. Only what they could
    // plausibly be doing: not reading their keys.
    function theirPlans(me, o) {
      const toward = me.x >= o.x ? B.right : B.left, away = toward === B.right ? B.left : B.right;
      const plans = [
        mk('wait', 0),
        mk('attack', toward, { 0: B.attack }),
        mk('walk in', toward),
        mk('crouch', B.block),
        mk('jump in + air attack', toward | B.jumpHeld, { 0: B.jump, 8: B.attack }),
      ];
      if (o.specialCooldownTimer <= 0) plans.push(mk('special', toward, { 0: B.special }));
      if (o.ultCharge >= ULT_METER_MAX) plans.push(mk('ultimate', toward, { 0: B.ultimate }));
      if (Math.abs(o.x - me.x) > 420) plans.length = Math.min(plans.length, 3); // far apart: less can happen
      return plans.concat(o.grounded ? [] : [mk('drift back', away)]);
    }

    // How good a position is for us (bigger is better).
    function score(me, o, t0, result) {
      if (result) return result === 'win' ? 10000 - t0 : result === 'lose' ? -10000 + t0 : 0;
      const L = STAGE_LEFT_EDGE, R = STAGE_RIGHT_EDGE;
      const health = (f) => Math.max(0, f.hp) / f.maxHp;
      // Off the stage and below the floor: in danger of a ring-out.
      const danger = (f) => {
        const over = f.x > L && f.x < R;
        if (over && f.y <= GROUND_Y + 1) return 0;
        return (over ? 10 : 40) + Math.max(0, f.y - GROUND_Y) * 0.5 + (over ? 0 : Math.min(Math.abs(f.x < L ? L - f.x : f.x - R), 300) * 0.15);
      };
      // Room to the nearest edge (being pushed out is how rounds are lost in balance mode).
      const room = (f) => Math.min(300, Math.max(0, Math.min(f.x - L, R - f.x)));
      const stunned = (f) => (f.state === 'hitstun' || f.state === 'knockdown' || f.state === 'grabbed' ? 1 : 0);
      let v = 0;
      v += 400 * (health(me) - health(o));
      v -= 4 * danger(me);
      v += 4 * danger(o);
      v += 0.08 * (room(me) - room(o));
      v += 12 * (stunned(o) - stunned(me));
      v += 0.05 * (me.ultCharge - o.ultCharge);
      v -= 1.5 * me.specialCooldownTimer;
      // Stay where it's our move to make: close enough to hit, so it doesn't
      // stand off forever.
      const reach = me.character.attack.offset + me.character.attack.width + o.width / 2;
      v -= 0.03 * Math.abs(Math.abs(me.x - o.x) - reach * 0.8);
      return v;
    }

    function outcome(me) {
      if (Game.getState() === 'fight') return null;
      return me.state === 'victory' ? 'win' : me.state === 'ko' ? 'lose' : 'draw';
    }

    // One future: our inputs (what we've already committed to for the next
    // frames, then the plan being tried) against one guess at theirs.
    function playOut(me, o, prefix, mine, theirs) {
      for (let t = 0; t < cfg.horizon; t++) {
        Rollback.applyInput(slot, t < prefix.length ? prefix[t] : bitsAt(mine, t - prefix.length));
        Rollback.applyInput(oppSlot, bitsAt(theirs, t));
        Game.update(FIXED_STEP);
        const r = outcome(me);
        if (r) return score(me, o, t, r);
      }
      return score(me, o, cfg.horizon, null);
    }

    // A decision is worked out over `every` frames, a share each frame, so
    // no single frame has to do it all (the game would stutter). It starts
    // from the fight as it is on the first of those frames; the inputs we
    // send meanwhile are already known (the current plan), so each future
    // starts with them and the new plan takes over exactly when it's ready.
    let job = null;

    function startJob(me, o) {
      const prefix = [];
      for (let n = 0; n < cfg.every - 1; n++) prefix.push(plan ? bitsAt(plan, tick - planAt + n) : 0);
      const mine = myPlans(me, o), theirs = theirPlans(me, o);
      job = { root: Game.saveState(), prefix, mine, theirs, k: 0, worst: mine.map(() => Infinity), total: mine.map(() => 0) };
    }

    function work(me, o, count) {
      const keys = InputManager.snapshot();
      const now = Game.saveState();
      const n = job.mine.length * job.theirs.length;
      Effects.setSuppressed(true);
      try {
        for (let c = 0; c < count && job.k < n; c++, job.k++) {
          const i = Math.floor(job.k / job.theirs.length), j = job.k % job.theirs.length;
          Game.loadState(job.root);
          const v = playOut(me, o, job.prefix, job.mine[i], job.theirs[j]);
          job.total[i] += v;
          if (v < job.worst[i]) job.worst[i] = v;
        }
      } finally {
        Game.loadState(now);
        Effects.setSuppressed(false);
        InputManager.restore(keys);
      }
      return job.k >= n;
    }

    function pick() {
      let best = 0, bestValue = -Infinity;
      job.mine.forEach((p, i) => {
        // Mostly the opponent's best answer, partly the average (pure
        // worst-case would never commit to anything).
        const value = 0.6 * job.worst[i] + 0.4 * job.total[i] / job.theirs.length;
        if (value > bestValue) { bestValue = value; best = i; }
      });
      return job.mine[best];
    }

    function think(me, o, projectiles, matchState) {
      tick++;
      if (matchState !== 'fight') { plan = null; job = null; return 0; }
      if (!job) startJob(me, o);
      const n = job.mine.length * job.theirs.length;
      if (work(me, o, Math.ceil(n / cfg.every))) {
        plan = pick();
        planAt = tick;
        job = null;
      }
      return plan ? bitsAt(plan, tick - planAt) : 0;
    }

    return { think, level: { name: 'unbeatable' }, plan: () => plan && plan.name };
  }

  // ---- Vs-CPU game mode (the browser) ----
  let brain = null;
  let cpuSlot = 'p2';

  function start(slot, level, seed) {
    cpuSlot = slot;
    brain = level === 'unbeatable' ? createSearchBrain(slot) : createBrain(slot, level, seed);
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
      ? brain.think(cpuSlot === 'p1' ? w.p1 : w.p2, cpuSlot === 'p1' ? w.p2 : w.p1, w.projectiles, w.matchState, w.ball)
      : 0;
    Rollback.applyInput(cpuSlot, bits);
    Game.update(FIXED_STEP);
  }

  return { LEVELS, createBrain, createSearchBrain, start, stop, tick, isActive: () => !!brain };
})();
