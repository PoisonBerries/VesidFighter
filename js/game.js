// Match/round flow: countdown -> fight -> round end -> (next round or match
// end). Also owns hit-detection between the fighters each tick, the
// projectile list (ranged specials/ultimates), the ball and the
// ultimate-meter economy.
//
// Usually two fighters (p1, p2). Online free-for-all has up to four: a
// fighter who is KO'd or falls off is out for the round, and the last one
// standing wins it.

const Game = (() => {
  let fighters = []; // everyone in the match, in slot order
  let p1 = null; // fighters[0] and fighters[1]: the two-player code, the CPU and the HUD use these
  let p2 = null;
  let ffa = false; // free-for-all: double health, eliminations, longer rounds
  let roundTime = ROUND_TIME;
  let roundsToWin = ROUNDS_TO_WIN;
  let matchState = 'idle'; // idle | countdown | fight | roundEnd | matchEnd
  let stateTimer = 0; // seconds remaining in current non-fight state
  let roundTimeLeft = ROUND_TIME;
  let roundMessage = '';
  let onMatchEnd = null; // callback(winnerSlot)
  let projectiles = [];
  let ball = null; // see "The ball" below; null when off
  let ballMode = BALL_MODE; // 'rally' | 'bomb' | 'off' (constants.js)
  // How each round of this match ended, for the stats (ui.js reports it):
  // { w: winner slot or null, how: 'ko' | 'ringout' | 'time' | 'draw', t: seconds fought }.
  let roundLog = [];

  const bySlot = (slot) => fighters.find((f) => f.slot === slot) || null;
  // Still in the round. (Two-player rounds end on the first KO, so there
  // nobody is ever out while the fight goes on.)
  const alive = () => fighters.filter((f) => !f.out);
  // Not fallen off the stage: still simulated and drawn (a KO'd fighter
  // lies where they dropped).
  const onStage = () => fighters.filter((f) => f.out !== 'ringout');

  // Who a fighter is up against: the other one, or in a free-for-all the
  // nearest fighter still in (ties go to the lower slot, so every machine
  // picks the same one).
  function foeOf(f) {
    if (fighters.length === 2) return f === p1 ? p2 : p1;
    let best = null, bestD = Infinity;
    for (const o of fighters) {
      if (o === f || o.out) continue;
      const d = Math.abs(o.x - f.x);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best || fighters.find((o) => o !== f);
  }

  function aabbOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // startMatch(char1Id, char2Id, onEnd, opts), or for more than two
  // fighters startMatch([charIds...], onEnd, opts).
  // opts.ball: 'rally' | 'bomb' | 'off' (or false) -- defaults to BALL_MODE.
  // opts.balance: balance mode (no KOs, ring-outs only) -- defaults to BALANCE_ENABLED.
  // opts.stage: a stage id (stages.js) -- defaults to DEFAULT_STAGE.
  // opts.ffa: free-for-all rules (double health, last one standing, one round).
  // opts.slots: the fighters' slot names (default p1, p2, p3...); online
  //   free-for-all uses the players' room slots, which can have gaps.
  function startMatch(a, b, c, d) {
    if (Array.isArray(a)) return begin(a, b, c);
    return begin([a, b], c, d);
  }

  function begin(charIds, matchEndCallback, opts) {
    opts = opts || {};
    onMatchEnd = matchEndCallback;
    const m = opts.ball;
    ballMode = m === false ? 'off' : BALL_MODES.includes(m) ? m : BALL_MODE;
    ffa = !!opts.ffa;
    roundTime = ffa ? FFA_ROUND_TIME : ROUND_TIME;
    roundsToWin = ffa ? FFA_ROUNDS_TO_WIN : ROUNDS_TO_WIN;
    Stage.use(opts.stage);
    const balance = opts.balance !== undefined ? !!opts.balance : BALANCE_ENABLED;
    const slots = opts.slots || charIds.map((_, i) => 'p' + (i + 1));
    const spawns = spawnPoints(charIds.length);
    fighters = charIds.map((id, i) => {
      const f = new Fighter(slots[i], CHARACTERS[id], spawns[i].x, spawns[i].facing);
      // Mirror match: the second (or later) copy of a character gets the alternate colours.
      f.paletteSwap = charIds.indexOf(id) < i;
      f.balanceMode = balance;
      f.roundsWon = 0;
      f.out = false;
      if (ffa) {
        f.hpMul = FFA_HP_MUL;
        f.maxHp = f.character.maxHp * FFA_HP_MUL;
        f.hp = f.maxHp;
      }
      return f;
    });
    p1 = fighters[0];
    p2 = fighters[1];
    roundLog = [];
    Effects.reset();
    if (!ffa) {
      const [char1Id, char2Id] = charIds;
      // Matchup lines, once per match (not every round): each fighter's "vs:<opponent>" line, if it has one.
      Effects.voice(char1Id, 'vs:' + char2Id);
      if (char2Id !== char1Id) Effects.voice(char2Id, 'vs:' + char1Id);
    }
    // Then each fighter's general match-start line (skipped by the audio if a matchup line is already playing).
    for (const id of new Set(charIds)) Effects.voice(id, 'matchStart');
    startRound();
  }

  // Where each fighter starts: the stage's two spawn points, or with more
  // fighters, spread evenly from a little outside them (so everyone starts
  // in shot), facing the middle.
  function spawnPoints(n) {
    const def = Stage.def();
    if (n <= 2) return def.spawns.slice(0, n).map((x, i) => ({ x, facing: i === 0 ? 1 : -1 }));
    const lo = Math.max(def.left + 120, def.spawns[0] - 100), hi = Math.min(def.right - 120, def.spawns[1] + 100);
    const mid = (def.left + def.right) / 2;
    const out = [];
    for (let i = 0; i < n; i++) {
      const x = Math.round(lo + (hi - lo) * (i / (n - 1)));
      out.push({ x, facing: x <= mid ? 1 : -1 });
    }
    return out;
  }

  function startRound() {
    const spawns = spawnPoints(fighters.length);
    Stage.reset();
    fighters.forEach((f, i) => {
      f.resetForRound();
      f.x = spawns[i].x; f.y = GROUND_Y; f.vx = 0; f.vy = 0;
      f.hp = f.maxHp; f.state = 'idle'; f.facing = spawns[i].facing; f.specialCooldownTimer = 0; f.ultCharge = 0; f._visualPose = null;
      f.out = false;
    });
    roundTimeLeft = roundTime;
    matchState = 'countdown';
    stateTimer = 3.0;
    projectiles = [];
    ball = ballMode === 'off' ? null : freshBall(ballMode === 'rally' ? 1 : BALL_FIRST_SPAWN);
    Effects.reset();
  }

  function endRound(winnerSlot, how) {
    roundLog.push({ w: winnerSlot, how, t: Math.round((roundTime - roundTimeLeft) * 10) / 10 });
    matchState = 'roundEnd';
    stateTimer = 2.2;
    const w = winnerSlot ? bySlot(winnerSlot) : null;
    if (w) {
      w.roundsWon++;
      roundMessage = (w.character.name + ' WINS THE ROUND');
      for (const f of fighters) if (f !== w) f.state = 'ko';
      // A finishing ultimate (Carlos's dive) that ended the round still plays out before the victory pose.
      if (w.state === 'ultimate' && w.character.ultimate.finishOnKo) w.finishUltimate = true;
      else w.state = 'victory';
    } else {
      roundMessage = how === 'time' || how === 'draw' ? "TIME'S UP -- DRAW" : 'DOUBLE KO -- DRAW';
    }
    // Winning the whole match (not just a round): the winner's victory line.
    if (w && w.roundsWon >= roundsToWin) {
      if (!ffa) Effects.voice(w.character.id, 'beats:' + foeOf(w).character.id); // a line for beating that particular fighter
      Effects.voice(w.character.id, 'victory');
    } else if (w) {
      Effects.voice(w.character.id, 'roundWin'); // won the round, match goes on
    }
  }

  function checkMatchWinner() {
    const w = fighters.find((f) => f.roundsWon >= roundsToWin);
    return w ? w.slot : null;
  }

  function update(dt) {
    // Drain "just pressed" input every tick, even outside active fight
    // frames -- otherwise a key pressed during a countdown or round-end
    // screen stays queued and fires the instant the next fight begins.
    if (matchState !== 'fight') {
      InputManager.endFrame();
    }

    if (matchState === 'idle') return;

    if (matchState === 'countdown') {
      stateTimer -= dt;
      if (stateTimer <= 0) matchState = 'fight';
      return;
    }

    if (matchState === 'roundEnd') {
      for (const f of fighters) {
        if (!f.finishUltimate) continue;
        f.update(Net.controlsFor(f.slot), foeOf(f));
        if (f.state !== 'ultimate') { f.finishUltimate = false; f.state = 'victory'; }
      }
      stateTimer -= dt;
      if (stateTimer <= 0) {
        const winner = checkMatchWinner();
        if (winner) {
          matchState = 'matchEnd';
          stateTimer = 4;
        } else {
          startRound();
        }
      }
      return;
    }

    if (matchState === 'matchEnd') {
      stateTimer -= dt;
      if (stateTimer <= 0) {
        const winner = checkMatchWinner();
        matchState = 'idle';
        // Once per match, even if rollback netcode replays these frames.
        const done = onMatchEnd;
        onMatchEnd = null;
        if (done) done(winner);
      }
      return;
    }

    if (matchState !== 'fight') return;

    roundTimeLeft -= dt;

    Stage.update(alive());
    // Everyone still on the stage moves (a KO'd fighter still drops to the
    // floor; with no input), each against their nearest opponent.
    for (const f of onStage()) f.update(Net.controlsFor(f.slot), foeOf(f));
    InputManager.endFrame();

    // "Runs away after a hit": a fighter who just landed a hit gets a voice occasion if the
    // opponent then backs off (running or jumping away) before the window closes.
    for (const me of alive()) {
      if (me.foeHitTimer > 0) {
        me.foeHitTimer--;
        const foe = foeOf(me), away = foe.x >= me.x ? 1 : -1;
        if (foe.state !== 'hitstun' && foe.state !== 'knockdown' && foe.state !== 'ko' && foe.vx * away >= 3 && Math.abs(foe.x - me.x) > 150) {
          me.foeHitTimer = 0;
          Effects.voice(me.character.id, 'foeRunsAway');
        }
      }
    }

    // Lingering fart clouds: whoever is standing in one is poisoned, even if they walked in after it went off.
    updateClouds();

    // Toxic Rush: poison damage ticking this frame feeds whoever's cloud it is.
    for (const v of fighters) {
      const from = v.poisonTickDamage > 0 && v.poisonFrom ? bySlot(v.poisonFrom) : null;
      if (from) from.gainFartPower(v.poisonTickDamage);
    }

    resolveCombat();
    updateProjectiles();
    updateBall();
    checkTransforms();
    Effects.update();

    // Falling off, then (balance mode aside) an empty health bar, puts a
    // fighter out. Two players: the first one out ends the round. More:
    // the round goes on until one is left -- and if the last ones all go
    // out on the same frame, nobody wins it.
    let lastHow = null;
    for (const f of alive()) {
      if (!f.hasFallenOff() || f.state === 'ko') continue;
      f.koByRingOut();
      Effects.voice(f.character.id, 'fallOff'); // the one who fell
      if (!ffa) Effects.voice(foeOf(f).character.id, 'enemyFall');
      if (!ffa) { loseRound(f, 'ringout'); return; }
      lastHow = 'ringout';
      f.out = 'ringout';
    }
    // Balance mode: an empty bar doesn't KO -- it just leaves you easy to knock off.
    for (const f of alive()) {
      if (f.hp > 0 || f.balanceMode) continue;
      f.state = 'ko';
      if (!ffa) { loseRound(f, 'ko'); return; }
      lastHow = 'ko';
      f.out = 'ko';
    }
    if (lastHow) {
      const left = alive();
      if (left.length <= 1) { endRound(left.length ? left[0].slot : null, lastHow); return; }
      Effects.shake(10, 14);
    }
    if (roundTimeLeft <= 0) {
      // Time up: whoever has more of their health left (not raw HP, which
      // would hand every timeout to the big characters).
      let best = null, bestR = -1, tie = false;
      for (const f of alive()) {
        const r = f.hp / f.maxHp;
        if (r > bestR) { best = f; bestR = r; tie = false; } else if (r === bestR) tie = true;
      }
      if (best && !tie) endRound(best.slot, 'time');
      else endRound(null, 'draw');
    }
  }

  // Two players: the first one out loses the round.
  function loseRound(f, how) {
    f.out = how;
    endRound(foeOf(f).slot, how);
  }

  function checkTransforms() {
    for (const f of fighters) {
      if (f.consumeTransformFlag()) {
        Effects.shake(14, 20);
        Effects.spawnHitSpark(f.x, f.y - f.height * 0.5, f.displayAccent);
        Effects.spawnHitSpark(f.x, f.y - f.height * 0.5, f.displayColor);
      }
    }
  }

  // Every fighter's attack against every other fighter still in. A swing
  // that connects is spent (getHitbox goes null), so it hits one fighter.
  function updateClouds() {
    for (const owner of fighters) {
      const c = owner.cloud;
      if (!c) continue;
      if (--c.life <= 0) { owner.cloud = null; continue; }
      for (const foe of fighters) {
        if (foe === owner || foe.state === 'ko' || foe.invulnerableTimer > 0) continue;
        const h = foe.getHurtbox();
        if (!(h.x < c.x + c.w && h.x + h.w > c.x && h.y < c.y + c.h && h.y + h.h > c.y)) continue;
        const same = foe.poisonTicksLeft > 0 && foe.poisonBox && foe.poisonBox.x === c.x && foe.poisonBox.y === c.y && foe.poisonFrom === owner.slot;
        if (!same) foe.applyPoison(c, c, owner.slot); // starts from a full tick interval; applyPoison reads poison* from its first argument
        foe.poisonLife = Math.max(foe.poisonLife, c.life); // lasts as long as the cloud does
        foe.poisonTicksLeft = Math.max(foe.poisonTicksLeft, 1);
      }
    }
  }

  function resolveCombat() {
    const live = alive();
    for (const a of live) for (const d of live) if (a !== d) tryHit(a, d);
  }

  // `noAttackerGain`: the hit gives the attacker nothing (Keenan's flurry, the tail of his own ultimate, doesn't refill his meter).
  function grantUltCharge(attacker, defender, landedSpecial, noAttackerGain) {
    // (a character with an ultChargeMul fills the meter faster, from landing hits and from taking them)
    if (!noAttackerGain) attacker.ultCharge = Math.min(ULT_METER_MAX, attacker.ultCharge + (landedSpecial ? ULT_GAIN_ON_LAND_SPECIAL : ULT_GAIN_ON_LAND_NORMAL) * (attacker.character.ultChargeMul || 1));
    defender.ultCharge = Math.min(ULT_METER_MAX, defender.ultCharge + ULT_GAIN_ON_TAKEN * (defender.character.ultChargeMul || 1));
  }

  function tryHit(attacker, defender) {
    const box = attacker.getHitbox();
    if (!box) return;
    const hurt = defender.getHurtbox();
    if (!aabbOverlap(box, hurt)) return;

    attacker.markHit();

    const isUlt = attacker.state === 'ultimate';
    const isSpecial = attacker.state === 'special';
    let stats = attacker.state === 'attack' || attacker.state === 'whirlwind' ? attacker.attackBox(attacker.attackDef)
      : attacker.state === 'hoverdive' ? attacker.character.hoverDive
      : attacker.state === 'flurry' ? attacker.flurryStats()
      : (isUlt ? attacker.character.ultimate : attacker.character.special);

    let dmg = stats.damage, kb = stats.knockback, kbUp = stats.knockbackUp, hs = stats.hitstun;
    let knockdown = false, knockdownDuration = 0;
    // Ryan's Finale kick: more damage and knockback.
    const fin = attacker.character.finale;
    if (fin && attacker.state === 'attack' && attacker.finaleKick) { dmg *= fin.damage; kb *= fin.knockback; kbUp *= fin.knockback; }

    // Keenan's counter-dodge swings for its own (bigger) numbers, not the base special's.
    if (isSpecial && stats.type === 'counterDodge' && attacker._ability.phase === 'counter') {
      dmg = stats.counterDamage; kb = stats.counterKnockback; kbUp = stats.counterKnockbackUp; hs = stats.counterHitstun;
    }
    if (stats.knockdownOnHit) {
      knockdown = true;
      knockdownDuration = stats.knockdownDuration;
    }

    dmg *= attacker.damageMultiplier * fightDamageMul();

    const result = defender.applyHit({
      damage: dmg, knockback: kb, knockbackUp: kbUp, hitstun: hs,
      blockDamageMul: stats.blockDamageMul, blockKnockbackMul: stats.blockKnockbackMul,
      fromFacing: attacker.facing, knockdown, knockdownDuration,
    });

    if (result === 'reflected') {
      reflectBack(attacker, defender, dmg, kb, kbUp, hs);
      return;
    }

    // Unanswered combo: hits in a row that aren't blocked or hit back.
    let comboNote = null;
    if (result === 'hit') {
      if (attacker.airAttackActive) attacker.hangAfterKick(); // (Keenan) a landed air kick leaves him suspended
      attacker.foeHitTimer = 150;
      attacker.comboHits++;
      // Ryan: the shockwave landing, or the combo tune getting going, arms his Finale kick.
      if (fin && !(attacker.state === 'attack' && attacker.finaleKick) && ((attacker.state === 'attack' && attacker.downAttackActive) || attacker.comboHits >= fin.combo)) attacker.finaleArmed = fin.frames;
      attacker.comboTimer = 100;
      if (attacker.character.comboSong) comboNote = attacker.comboHits - 1;
    } else if (result === 'blocked') {
      attacker.comboHits = 0;
    }
    // John's Takedown: the charge connecting with someone standing starts the hip slam.
    if (result === 'hit' && isUlt && attacker.character.ultimate.type === 'takedown' && attacker.grounded && defender.y >= GROUND_Y - 1 && defender.hp > 0) {
      attacker.startTakedown(defender);
    }
    const gs = attacker.character.grabSlam || attacker.character.grabBeat;
    if (result === 'hit' && gs && attacker.comboHits >= gs.hits && attacker.state === 'attack' && attacker.grounded && defender.y >= GROUND_Y - 1 && defender.hp > 0) {
      attacker.startGrabSlam(defender);
    }

    // The defender's voice line for being hit: a punch or kick is 'hitTaken'; specials and ultimates
    // have their own occasions (a character without a line for one falls back to its hitTaken).
    // A heavy blow (15% of max health or more) gets the defender's 'bigHit' line when they have one;
    // otherwise the usual one below plays.
    if (result === 'hit' && dmg >= defender.maxHp * 0.15) {
      Effects.voice(attacker.character.id, 'dealsBigDamage'); // the attacker's line for landing a heavy blow
      Effects.voice(defender.character.id, 'bigHit');
    }
    if (result === 'blocked') Effects.voice(defender.character.id, 'block');
    if (result === 'hit') {
      // Most specific first: 'hitByUltimate:<attacker>', then the attacker's element (Sam's water), then the general kind.
      const kind = isUlt ? 'hitByUltimate' : 'hitBySpecial';
      Effects.voice(defender.character.id, attacker.state === 'attack' ? 'hitTaken'
        : [kind + ':' + attacker.character.id, attacker.character.id === 'sam' ? 'hitByWater' : null, kind].filter(Boolean).join('|'));
    }
    if ((result === 'hit' || result === 'blocked') && stats.poisonDamage) attacker.gainFartPower(dmg);
    // Sam's Second Wind: landing a hit from the air heals a little.
    if (result === 'hit' && attacker.character.airLeech && !attacker.grounded) attacker.hp = Math.min(attacker.maxHp, attacker.hp + attacker.character.airLeech);

    if (result === 'hit' && stats.poisonDamage) {
      defender.applyPoison(stats, box, attacker.slot);
    }

    if (result === 'hit' || result === 'blocked') {
      grantUltCharge(attacker, defender, isSpecial || isUlt, attacker.state === 'flurry');
    }

    spawnImpactEffect(attacker, defender, box, hurt, result, isSpecial || isUlt, comboNote);
  }

  // In rally mode the ball is the main weapon; hitting each other does less.
  function fightDamageMul() {
    return ballMode === 'rally' ? RALLY_FIGHT_DAMAGE : 1;
  }

  function reflectBack(attacker, defender, dmg, kb, kbUp, hs) {
    attacker.applyHit({
      damage: dmg * (defender.reflectMultiplier || 1),
      knockback: kb, knockbackUp: kbUp, hitstun: hs,
      fromFacing: -attacker.facing,
    });
    Effects.spawnHitSpark(defender.x, defender.y - defender.height * 0.5, '#ff3b3b');
    Effects.shake(8, 10);
  }

  function spawnImpactEffect(attacker, defender, box, hurt, result, big, comboNote) {
    const impactX = (box.x + box.w / 2 + hurt.x + hurt.w / 2) / 2;
    const impactY = hurt.y + hurt.h * 0.4;
    let color = '#ffe066';
    if (result === 'blocked') color = '#9fd8ff';
    else if (result === 'dodged' || result === 'phased') color = '#ffffff';
    Effects.spawnHitSpark(impactX, impactY, color, comboNote !== null && comboNote !== undefined ? 'note:' + comboNote : undefined);
    Effects.shake(big ? 10 : 5, big ? 16 : 8);
  }

  // ---- Projectiles (Owen's plasma, Ryan's soundwave) ----
  function spawnProjectile(owner, stats, opts) {
    opts = opts || {};
    const spawnX = opts.x !== undefined ? opts.x : owner.x + owner.facing * (owner.width * 0.5 + 8);
    const spawnY = opts.y !== undefined ? opts.y : owner.y - owner.height * 0.55;
    projectiles.push({
      owner,
      x: spawnX, y: spawnY,
      vx: opts.vx !== undefined ? opts.vx : owner.facing * stats.speed,
      vy: opts.vy || 0,
      poison: opts.poison || null, // (poisonDamage / poisonTicks / poisonTickInterval) applied on a hit
      w: stats.width, h: stats.height,
      damage: stats.damage, knockback: stats.knockback, knockbackUp: stats.knockbackUp, hitstun: stats.hitstun,
      color: opts.color || '#bfefff',
      kind: opts.kind || null,
      life: opts.life || 90,
      parryKnockdown: !!opts.parryKnockdown,
      knockdownDuration: opts.knockdownDuration || 0,
    });
    Effects.spawnHitSpark(spawnX, spawnY, opts.color || '#bfefff', 'muzzle');
  }

  function updateProjectiles() {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      p.x += p.vx;
      p.y += p.vy || 0;
      p.life--;
      // Darts that come down (or are fired down) stop at the floor.
      if (p.vy > 0 && p.y >= GROUND_Y - 4) {
        Effects.spawnHitSpark(p.x, GROUND_Y - 6, p.color, 'muzzle');
        Effects.spawnDust(p.x, GROUND_Y, 4, 2);
        projectiles.splice(i, 1);
        continue;
      }
      if (p.life <= 0 || p.x < WORLD_LEFT - 40 || p.x > WORLD_RIGHT + 40) {
        projectiles.splice(i, 1);
        continue;
      }

      // Hits the first fighter (other than whoever fired it) in its way.
      const pbox = { x: p.x - p.w / 2, y: p.y - p.h / 2, w: p.w, h: p.h };
      const defender = alive().find((f) => f !== p.owner && f.state !== 'ko' && aabbOverlap(pbox, f.getHurtbox()));
      if (!defender) continue;

      if (defender.invulnerableTimer > 0) {
        if (defender._dodging) {
          defender._dodgeSuccess = true;
          projectiles.splice(i, 1);
        }
        // Phased (non-dodging invulnerability): projectile passes straight through.
        continue;
      }

      if (defender.reflectTimer > 0) {
        defender.noteImpact('reflected', p.vx >= 0 ? 1 : -1, 0.9);
        p.vx = -p.vx;
        p.owner = defender;
        Effects.spawnHitSpark(p.x, p.y, '#ff3b3b');
        continue;
      }

      let knockdown = false;
      if (p.parryKnockdown && (defender.state === 'attack' || defender.state === 'special' || defender.state === 'ultimate')) {
        knockdown = true;
      }

      const dmg = p.damage * p.owner.damageMultiplier * fightDamageMul();
      const result = defender.applyHit({
        damage: dmg, knockback: p.knockback, knockbackUp: p.knockbackUp, hitstun: p.hitstun,
        fromFacing: p.vx >= 0 ? 1 : -1, projectile: true,
        knockdown, knockdownDuration: p.knockdownDuration,
      });

      if (result === 'hit') Effects.voice(defender.character.id, 'hitByProjectile');
      if (result === 'hit' && p.poison) { // a fart dart: poisons them (and feeds Toxic Rush)
        defender.applyPoison(p.poison, null, p.owner.slot);
        p.owner.gainFartPower(dmg);
      }
      if (result === 'hit' || result === 'blocked') {
        grantUltCharge(p.owner, defender, true);
      }

      Effects.spawnHitSpark(p.x, p.y, p.color);
      Effects.shake(6, 10);
      projectiles.splice(i, 1);
    }
  }

  // ---- The ball ----
  // One ball shared by both fighters; any attack that connects with it
  // launches it toward whoever the attacker faces. Holding toward the
  // opponent drives it flatter, holding away pops it up.
  //
  // 'rally' mode: the ball stays in play all round and is the main weapon.
  // Each hit makes it hotter (faster, harder hitting) and "live" for the
  // hitter: a live ball hurts the other fighter, more the hotter it is, then
  // goes loose and cools off. A loose ball, or your own live one, is
  // harmless. Blocking just as a live ball arrives catches it; your next
  // attack throws it back. Late blocks only deflect it.
  //
  // 'bomb' mode: the hot potato. Touching it is harmless (it bounces off
  // you), but it explodes when its fuse runs out or it touches the floor,
  // then another comes after a pause.
  //
  // Plain data, so rollback can save it. phase: 'waiting' (timer until the
  // next one), 'appearing' (hovering, harmless), 'live'. grace: frames a
  // fighter can't touch it. hitstop: frames it hangs frozen after a hit.
  // heat/live/liveBounces/cool/heldBy/holdT: rally state. blast*: the last
  // explosion (bomb mode), for the renderers' flash.
  function freshBall(delay, blast) {
    return {
      phase: 'waiting', timer: delay, x: 0, y: 0, vx: 0, vy: 0, spin: 0,
      fuse: BALL_FUSE, lastHit: null, grace: Object.fromEntries(fighters.map((f) => [f.slot, 0])), hitstop: 0,
      heat: 0, live: false, liveBounces: 0, cool: 0, heldBy: null, holdT: 0, wallHit: false,
      blastX: blast ? blast.x : 0, blastY: blast ? blast.y : 0, blastT: blast ? 30 : 0,
    };
  }

  // Squared distance from a point to the nearest point of a rect.
  function distSqToRect(px, py, r) {
    const dx = Math.max(r.x - px, 0, px - (r.x + r.w));
    const dy = Math.max(r.y - py, 0, py - (r.y + r.h));
    return dx * dx + dy * dy;
  }

  const overStage = (x) => x > STAGE_LEFT_EDGE && x < STAGE_RIGHT_EDGE;

  // One frame of flight. Also used by the CPU (cpu.js) to predict the ball.
  function ballStep(b, mode) {
    if (b.hitstop > 0) { b.hitstop--; return; } // frozen for a beat on impact
    const live = mode === 'rally' && b.live;
    if (live) b.vy += RALLY_LIVE_GRAVITY;
    else if (b.vy < BALL_MAX_FALL) b.vy = Math.min(BALL_MAX_FALL, b.vy + BALL_GRAVITY);
    b.vx *= live ? 0.998 : BALL_DRAG;
    const prevY = b.y;
    b.x += b.vx;
    b.y += b.vy;
    b.spin += b.vx * 0.04;

    // Invisible walls and a ceiling keep it in play: at the world's edges for
    // the bomb, at the platform edges in rally (it never leaves the stage).
    const keep = live ? 0.95 : 0.8;
    const left = mode === 'rally' ? STAGE_LEFT_EDGE + BALL_RADIUS : WORLD_LEFT + 40 + BALL_RADIUS;
    const right = mode === 'rally' ? STAGE_RIGHT_EDGE - BALL_RADIUS : WORLD_RIGHT - 40 - BALL_RADIUS;
    if (b.x < left) { b.x = left; b.vx = Math.abs(b.vx) * keep; b.wallHit = true; }
    if (b.x > right) { b.x = right; b.vx = -Math.abs(b.vx) * keep; b.wallHit = true; }
    if (b.y < BALL_RADIUS + 10) { b.y = BALL_RADIUS + 10; b.vy = Math.abs(b.vy) * (live ? 0.9 : 0.5); }

    // Rally: the floor bounces it. A loose ball never settles (it keeps
    // bouncing to punching height); a live one goes loose after a bounce or two.
    if (mode === 'rally' && overStage(b.x) && b.y + BALL_RADIUS >= GROUND_Y) {
      if (prevY + BALL_RADIUS <= GROUND_Y + 1) {
        b.y = GROUND_Y - BALL_RADIUS;
        b.vy = -Math.max(Math.abs(b.vy) * (live ? 0.8 : 0.7), RALLY_MIN_BOUNCE);
        b.vx *= 0.9;
        if (live && --b.liveBounces <= 0) b.live = false;
        if (b.heat > 0) { b.heat = Math.max(0, b.heat - RALLY_FLOOR_HEAT); b.cool = 0; }
      } else {
        // Came up under the lip from the void side: the stage is a wall.
        const leftSide = b.x < (STAGE_LEFT_EDGE + STAGE_RIGHT_EDGE) / 2;
        b.x = leftSide ? STAGE_LEFT_EDGE : STAGE_RIGHT_EDGE;
        b.vx = (leftSide ? -1 : 1) * Math.abs(b.vx) * 0.5;
      }
    }
  }

  // How a hit launches the ball: [vx away from the hitter, vy]. Rally mode
  // keeps the direction but sets the speed from the heat.
  function ballLaunch(grounded, aim, strong, mode, heat) {
    const t = BALL_HITS[grounded ? 'ground' : 'air'];
    const v = aim > 0 ? t.toward : aim < 0 ? t.away : t.neutral;
    if (mode === 'rally') {
      const speed = RALLY_SPEED + RALLY_SPEED_PER_HEAT * heat;
      const len = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
      return [v[0] / len * speed, v[1] / len * speed];
    }
    const k = strong ? BALL_STRONG_HIT : 1;
    return [v[0] * k, v[1] * k];
  }

  function updateBall() {
    if (!ball) return;
    const b = ball;
    if (b.blastT > 0) b.blastT--;
    for (const k of Object.keys(b.grace)) if (b.grace[k] > 0) b.grace[k]--;

    if (b.phase === 'waiting') {
      if (--b.timer > 0) return;
      // Materialise above the middle (rally) or between the fighters (bomb).
      b.phase = 'appearing';
      b.timer = BALL_APPEAR;
      const live = alive();
      const mid = ballMode === 'rally' || !live.length ? (STAGE_LEFT_EDGE + STAGE_RIGHT_EDGE) / 2 : live.reduce((sum, f) => sum + f.x, 0) / live.length;
      b.x = Math.max(STAGE_LEFT_EDGE + 120, Math.min(STAGE_RIGHT_EDGE - 120, mid));
      b.y = BALL_SPAWN_Y;
      b.vx = 0; b.vy = 0;
      b.fuse = BALL_FUSE;
      b.lastHit = null;
      return;
    }
    if (b.phase === 'appearing') {
      if (--b.timer > 0) return;
      b.phase = 'live';
    }

    if (b.heldBy) { updateHeldBall(b); return; }

    if (ballMode === 'bomb') b.fuse--;
    if (ballMode === 'rally' && !b.live && b.heat > 0 && ++b.cool >= RALLY_HEAT_DECAY) {
      b.cool = 0;
      b.heat--; // a loose ball cools off
    }
    b.wallHit = false;
    ballStep(b, ballMode);
    if (b.wallHit && Math.abs(b.vx) > 2) Effects.spawnHitSpark(b.x + Math.sign(b.vx) * -BALL_RADIUS, b.y, '#b3a5d9', 'muzzle');

    const live = alive();
    for (const f of live) ballVsAttack(f);
    ballVsProjectiles();
    for (const f of live) {
      if (ball !== b) break;
      if (ballMode === 'rally') ballVsBodyRally(f); else ballVsBody(f);
    }
    if (ball !== b) return;

    if (ballMode === 'bomb' && (b.fuse <= 0 || (overStage(b.x) && b.y + BALL_RADIUS >= GROUND_Y))) {
      if (overStage(b.x)) b.y = Math.min(b.y, GROUND_Y - BALL_RADIUS);
      explodeBall();
    } else if (b.y > RING_OUT_Y + 100) {
      // Fell into the void: gone, no blast.
      ball = freshBall(ballMode === 'rally' ? RALLY_RESPAWN : BALL_RESPAWN);
    }
  }

  function ballVsAttack(f) {
    const b = ball;
    if (b.grace[f.slot] > 0) return;
    // An attack that already hit the opponent is spent (getHitbox is null);
    // hitting the ball doesn't spend it, so one swing can do both.
    const box = f.getHitbox();
    if (!box || distSqToRect(b.x, b.y, box) > BALL_HIT_RADIUS * BALL_HIT_RADIUS) return;
    launchBall(f, f.state !== 'attack');
  }

  function launchBall(f, strong) {
    const b = ball;
    if (ballMode === 'rally') {
      b.heat = Math.min(RALLY_MAX_HEAT, b.heat + (strong ? 2 : 1));
      b.live = true;
      b.liveBounces = RALLY_LIVE_BOUNCES;
      b.cool = 0;
      b.hitstop = 3 + Math.round(b.heat * 0.6); // hotter hits hang longer
    } else {
      b.hitstop = BALL_HITSTOP;
    }
    const [vx, vy] = ballLaunch(f.grounded, f.aim, strong, ballMode, b.heat);
    b.vx = f.facing * vx;
    b.vy = vy;
    b.lastHit = f.slot;
    for (const o of fighters) b.grace[o.slot] = 0;
    b.grace[f.slot] = 14 + b.hitstop;
    Effects.spawnHitSpark(b.x, b.y, '#fff3b0', 'ball:' + b.heat);
    Effects.spawnHitSpark(b.x, b.y, ballColor(b), 'muzzle');
    Effects.shake(4 + b.heat * 0.6, 7);
  }

  // Owen's plasma and Ryan's soundwave knock it away too (and are used up).
  function ballVsProjectiles() {
    const b = ball;
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      const pbox = { x: p.x - p.w / 2, y: p.y - p.h / 2, w: p.w, h: p.h };
      if (distSqToRect(b.x, b.y, pbox) > BALL_RADIUS * BALL_RADIUS) continue;
      const [vx, vy] = ballLaunch(true, 0, false, ballMode, b.heat);
      b.vx = (p.vx >= 0 ? 1 : -1) * vx;
      b.vy = vy;
      b.lastHit = p.owner.slot;
      if (ballMode === 'rally') { b.live = true; b.liveBounces = RALLY_LIVE_BOUNCES; b.cool = 0; }
      Effects.spawnHitSpark(b.x, b.y, p.color, 'ball:' + b.heat);
      projectiles.splice(i, 1);
    }
  }

  // Running into it (or it landing on you) doesn't hurt: it bounces off
  // your body, keeping some of its speed, plus a bit of your movement.
  function ballVsBody(f) {
    const b = ball;
    if (f.state === 'ko' || b.grace[f.slot] > 0) return;
    const r = f.getHurtbox();
    if (distSqToRect(b.x, b.y, r) > BALL_RADIUS * BALL_RADIUS) return;

    // Surface normal at the closest point of the body (straight out if the
    // ball's centre is already inside it).
    const cx = Math.max(r.x, Math.min(r.x + r.w, b.x));
    const cy = Math.max(r.y, Math.min(r.y + r.h, b.y));
    let nx = b.x - cx, ny = b.y - cy;
    if (nx === 0 && ny === 0) { nx = b.x >= f.x ? 1 : -1; ny = -0.5; }
    const len = Math.sqrt(nx * nx + ny * ny);
    nx /= len; ny /= len;

    const dot = b.vx * nx + b.vy * ny;
    if (dot < 0) {
      b.vx = (b.vx - 2 * dot * nx) * BALL_BODY_BOUNCE;
      b.vy = (b.vy - 2 * dot * ny) * BALL_BODY_BOUNCE;
    }
    b.vx += f.vx * 0.5;
    // Always leave with some speed, and pop up off heads so it can't sit there.
    const out = b.vx * nx + b.vy * ny;
    if (out < 3) { b.vx += nx * (3 - out); b.vy += ny * (3 - out); }
    if (ny < -0.7) b.vy = Math.min(b.vy, -6);
    b.x = cx + nx * (BALL_RADIUS + 1);
    b.y = cy + ny * (BALL_RADIUS + 1);
    b.grace[f.slot] = 8;
    Effects.spawnHitSpark(b.x, b.y, '#d8cfee', 'ball:0');
  }

  // Rally: a live ball from the other fighter hits (or is caught); anything
  // else just bounces off harmlessly.
  function ballVsBodyRally(f) {
    const b = ball;
    if (f.state === 'ko' || b.grace[f.slot] > 0) return;
    if (!b.live) { ballVsBody(f); return; }
    if (b.lastHit === f.slot) return; // your own shot passes through you

    const r2 = BALL_RADIUS * BALL_RADIUS;
    // A fresh block catches it -- judged against the standing body, so
    // crouching into the block can't let it sail overhead.
    const standing = { x: f.x - f.width / 2, y: f.y - f.height, w: f.width, h: f.height };
    if (f.blocking && f.blockFrames <= RALLY_CATCH_WINDOW && distSqToRect(b.x, b.y, standing) <= r2) {
      catchBall(f);
      return;
    }
    if (distSqToRect(b.x, b.y, f.getHurtbox()) > r2) return;

    if (f.invulnerableTimer > 0) {
      // Dodged or phased: it flies through.
      if (f._dodging) f._dodgeSuccess = true;
      b.grace[f.slot] = 20;
      return;
    }
    if (f.reflectTimer > 0) {
      // Nathan's Rubber Guard fires it straight back, hotter.
      f.noteImpact('reflected', b.vx >= 0 ? 1 : -1, 0.9);
      b.heat = Math.min(RALLY_MAX_HEAT, b.heat + 1);
      b.vx = -b.vx * 1.1;
      b.vy = Math.min(b.vy, -3);
      b.lastHit = f.slot;
      b.liveBounces = RALLY_LIVE_BOUNCES;
      b.grace[f.slot] = 20;
      Effects.spawnHitSpark(b.x, b.y, '#ff3b3b');
      return;
    }

    const owner = bySlot(b.lastHit) || foeOf(f);
    const heat = b.heat;
    const dir = b.vx >= 0 ? 1 : -1;
    const result = f.applyHit({
      damage: (RALLY_DAMAGE + RALLY_DAMAGE_PER_HEAT * heat) * owner.damageMultiplier,
      knockback: 5 + heat * 1.2, knockbackUp: 5 + heat * 0.6, hitstun: 16 + heat * 2,
      fromFacing: dir, projectile: true,
    });
    if (result === 'hit') Effects.voice(f.character.id, 'hitByBall');
    b.grace[f.slot] = 20;
    b.live = false;
    b.vx = -dir * 2.5;
    b.vy = -8;
    grantUltCharge(owner, f, heat >= 5);
    if (result === 'blocked') {
      // Blocked late: it's deflected (the heat survives, the shot doesn't).
      Effects.spawnHitSpark(b.x, b.y, '#9fd8ff');
      return;
    }
    b.heat = 0;
    b.hitstop = 3 + Math.round(heat * 0.5);
    Effects.spawnHitSpark(b.x, b.y, '#ffe066');
    Effects.spawnHitSpark(b.x, b.y, ballColor({ heat }), 'muzzle');
    Effects.shake(6 + heat, 8 + heat);
  }

  function catchBall(f) {
    const b = ball;
    b.heldBy = f.slot;
    b.holdT = RALLY_HOLD;
    b.live = false;
    b.vx = 0; b.vy = 0;
    b.lastHit = f.slot;
    Effects.spawnHitSpark(b.x, b.y, '#9fd8ff'); // block sound
  }

  // Held in front of the catcher. Their next attack (or running out of time)
  // throws it; getting hit drops it.
  function updateHeldBall(b) {
    const f = bySlot(b.heldBy);
    if (!f || f.out || f.state === 'hitstun' || f.state === 'knockdown' || f.state === 'ko') {
      b.heldBy = null;
      b.vx = 0; b.vy = -5;
      if (f) b.grace[f.slot] = 20;
      return;
    }
    b.x = f.x + f.facing * (f.width / 2 + BALL_RADIUS - 6);
    b.y = f.y - f.height * 0.62;
    b.holdT--;
    const swinging = f.state === 'attack' || f.state === 'special' || f.state === 'ultimate';
    if (swinging || b.holdT <= 0) {
      b.heldBy = null;
      launchBall(f, swinging && f.state !== 'attack');
    }
  }

  function explodeBall() {
    const b = ball;
    for (const f of alive()) {
      if (f.state === 'ko') continue;
      const d2 = distSqToRect(b.x, b.y, f.getHurtbox());
      if (d2 > BALL_BLAST_RADIUS * BALL_BLAST_RADIUS) continue;
      const k = 1 - 0.4 * Math.sqrt(d2) / BALL_BLAST_RADIUS; // 1 at the centre, 0.6 at the edge
      const result = f.applyHit({
        damage: BALL_BLAST_DAMAGE * k, knockback: 14 * k, knockbackUp: 10 * k, hitstun: 28,
        blockDamageMul: 0.4, blockKnockbackMul: 0.6, fromFacing: f.x >= b.x ? 1 : -1,
      });
      const other = bySlot(b.lastHit);
      if ((result === 'hit' || result === 'blocked') && other && other !== f) grantUltCharge(other, f, true);
    }
    Effects.spawnHitSpark(b.x, b.y, '#ff8a3d', 'boom');
    // Extra rings of sparks; 'muzzle' keeps them silent (one boom is enough).
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      Effects.spawnHitSpark(b.x + Math.cos(a) * 60, b.y + Math.sin(a) * 45, i % 2 ? '#ffe066' : '#ff5a36', 'muzzle');
    }
    Effects.shake(16, 22);
    ball = freshBall(BALL_RESPAWN, { x: b.x, y: b.y });
  }

  // Countdown beeps and the FIGHT! cue, keyed off what's on screen so they
  // play the same for the host, the guest and local play.
  let lastBeat = null, lastMatchState = null;
  function playCountdownSounds() {
    if (typeof Sfx === 'undefined') return;
    if (matchState === 'countdown') {
      const n = Math.ceil(stateTimer);
      if (n > 0 && n !== lastBeat) Sfx.tick();
      lastBeat = n;
    } else if (matchState === 'fight' && lastMatchState === 'countdown') {
      Sfx.go();
    }
    lastMatchState = matchState;
  }

  // The stage's own sounds (the car's horn as it comes), also keyed off
  // what's on screen.
  let lastCarPhase = null;
  function playStageSounds() {
    const car = Stage.car();
    const phase = car && matchState === 'fight' ? car.phase : null;
    if (phase === 'warn' && lastCarPhase !== 'warn' && typeof Sfx !== 'undefined' && Sfx.horn) Sfx.horn(car.dir > 0 ? -1 : 1);
    lastCarPhase = phase;
  }

  // A small chance, every so often during a fight, that a fighter breaks into song (client-side only:
  // it's flavour, not part of the simulation, so each player's machine rolls for itself).
  let lastSingRoll = 0;
  function maybeRandomVoice() {
    if (matchState !== 'fight' || typeof Sfx === 'undefined' || !Sfx.voice) return;
    const now = performance.now();
    if (now - lastSingRoll < 1000) return;
    lastSingRoll = now;
    for (const f of alive()) if (Math.random() < 0.007) Sfx.voice(f.character.id, 'sing');
  }

  function render(ctx) {
    if (p1 && p2) {
      maybeRandomVoice();
      playCountdownSounds();
      playStageSounds();
      for (const f of fighters) AbilityFX.update(f);
    }

    // 3D view (renderer3d.js) draws the world; this canvas becomes a
    // transparent overlay for the HUD only.
    if (window.Renderer3D && Renderer3D.isActive()) {
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      Renderer3D.render(p1 && p2 ? { p1, p2, fighters: onStage(), projectiles, ball: visibleBall(), ballMode } : null);
      if (p1 && p2) drawOverlay(ctx);
      return;
    }

    // Stages bigger than the screen get a simple camera (the arena fits as is).
    const view = Stage.id() === 'arena' ? null : view2D();
    if (view) drawStage2D(ctx, view); else Renderer.drawStage(ctx);
    if (!p1 || !p2) return;

    const shakeOffset = Effects.getShakeOffset();
    ctx.save();
    ctx.translate(shakeOffset.x, shakeOffset.y);
    if (view) ctx.transform(view.zoom, 0, 0, view.zoom, CANVAS_WIDTH / 2 - view.cx * view.zoom, GROUND_Y * (1 - view.zoom));

    const shown = onStage();
    for (const f of shown) AbilityFX.drawBack(ctx, f);
    for (const f of shown) Renderer.drawFighter(ctx, f);
    for (const f of shown) AbilityFX.drawFront(ctx, f);
    AbilityFX.drawTimed(ctx);
    Renderer.drawProjectiles(ctx, projectiles);
    drawBall2D(ctx, visibleBall());
    Effects.draw(ctx);

    ctx.restore();

    drawOverlay(ctx);
  }

  // Fallback 2D camera for big stages: follows the fighters, zooming out to
  // fit them all (the floor stays put on screen).
  function view2D() {
    const xs = alive().map((f) => f.x);
    if (!xs.length) xs.push(640);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const zoom = Math.max(0.45, Math.min(1, CANVAS_WIDTH / (maxX - minX + 520)));
    const w = CANVAS_WIDTH / zoom, lo = STAGE_LEFT_EDGE - 120 + w / 2, hi = STAGE_RIGHT_EDGE + 120 - w / 2;
    const cx = lo > hi ? (STAGE_LEFT_EDGE + STAGE_RIGHT_EDGE) / 2 : Math.max(lo, Math.min(hi, (minX + maxX) / 2));
    return { zoom, cx };
  }

  // Fallback 2D look for the other stages: sky, floor, platforms, the car.
  function drawStage2D(ctx, view) {
    ctx.save();
    const sky = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT);
    sky.addColorStop(0, '#5fa8f0');
    sky.addColorStop(0.7, '#dcecf2');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.transform(view.zoom, 0, 0, view.zoom, CANVAS_WIDTH / 2 - view.cx * view.zoom, GROUND_Y * (1 - view.zoom));
    ctx.fillStyle = '#9a7652';
    ctx.fillRect(STAGE_LEFT_EDGE, GROUND_Y, STAGE_RIGHT_EDGE - STAGE_LEFT_EDGE, 600);
    ctx.fillStyle = '#86b35a';
    ctx.fillRect(STAGE_LEFT_EDGE, GROUND_Y, STAGE_RIGHT_EDGE - STAGE_LEFT_EDGE, 14);
    const plats = Stage.def().platforms;
    if (plats.length) {
      const top = Math.min(...plats.map((p) => p.y));
      const mid = (Math.min(...plats.map((p) => p.x1)) + Math.max(...plats.map((p) => p.x2))) / 2;
      ctx.fillStyle = '#4f8f3a';
      ctx.beginPath();
      ctx.arc(mid, top - 40, 110, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#7a5634';
      ctx.fillRect(mid - 16, top, 32, GROUND_Y - top);
    }
    for (const p of plats) {
      ctx.fillStyle = p.id === 'crown' ? '#5d9c44' : '#7a5634';
      ctx.fillRect(p.x1, p.y, p.x2 - p.x1, 12);
    }
    const car = Stage.car(), c = Stage.def().car;
    if (car && car.phase === 'drive') {
      ctx.fillStyle = '#8aa1b8';
      ctx.fillRect(car.x - c.width / 2, GROUND_Y - c.height, c.width, c.height - 12);
      ctx.fillStyle = '#2b3440';
      ctx.fillRect(car.x + car.dir * (c.width / 2 - 70) - 30, GROUND_Y - c.height + 12, 60, 28);
      ctx.fillStyle = '#222';
      for (const k of [-1, 1]) { ctx.beginPath(); ctx.arc(car.x + k * (c.width / 2 - 55), GROUND_Y - 14, 18, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore();
  }

  // The ball freezes with the round, so it's only shown mid-fight.
  function visibleBall() {
    return matchState === 'fight' ? ball : null;
  }

  // How close the ball is to going off, 0 (fresh) to 1 (about to blow), and
  // whether its warning light is lit this frame (blinks faster as it burns).
  function ballDanger(b) {
    const heat = 1 - Math.max(0, b.fuse) / BALL_FUSE;
    const period = Math.max(6, Math.round(50 * (1 - heat)));
    return { heat, lit: b.fuse % period < period / 2 };
  }

  // Rally ball colour by heat: pale rubber, through yellow, orange and red,
  // to magenta and finally white-hot.
  const HEAT_COLORS = ['#e9e4f5', '#fff0b3', '#ffd84d', '#ffb52e', '#ff901f', '#ff6a14', '#ff4512', '#ff2a24', '#ff1f5a', '#ff3de0', '#ffffff'];
  function ballColor(b) {
    return HEAT_COLORS[Math.max(0, Math.min(HEAT_COLORS.length - 1, b.heat))];
  }

  // Fallback 2D look (the 3D view has its own mesh, see renderer3d.js).
  function drawBall2D(ctx, b) {
    if (b && ballMode === 'rally') {
      if (b.phase === 'waiting') return;
      ctx.save();
      ctx.translate(b.x, b.y);
      if (b.phase === 'appearing') ctx.globalAlpha = 1 - b.timer / BALL_APPEAR;
      ctx.fillStyle = ballColor(b);
      ctx.strokeStyle = b.live || b.heldBy ? PLAYER_COLORS[b.lastHit] : '#6b5f8f';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      return;
    }
    drawBomb2D(ctx, b);
  }

  function drawBomb2D(ctx, b) {
    if (!b) return;
    if (b.blastT > 0) {
      const t = 1 - b.blastT / 30;
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = '#ffb347';
      ctx.beginPath();
      ctx.arc(b.blastX, b.blastY, BALL_BLAST_RADIUS * (0.4 + 0.6 * t), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (b.phase === 'waiting') return;
    const d = ballDanger(b);
    ctx.save();
    ctx.translate(b.x, b.y);
    if (b.phase === 'appearing') ctx.globalAlpha = 1 - b.timer / BALL_APPEAR;
    ctx.fillStyle = d.lit ? '#ff3b3b' : '#2b2440';
    ctx.strokeStyle = '#fff3b0';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Fuse ring: how much time is left.
    ctx.strokeStyle = '#ffb347';
    ctx.beginPath();
    ctx.arc(0, 0, BALL_RADIUS + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - d.heat));
    ctx.stroke();
    ctx.restore();
  }

  function drawOverlay(ctx) {
    if (fighters.length > 2) Renderer.drawHUDMulti(ctx, fighters); else Renderer.drawHUD(ctx, p1, p2);
    if (matchState === 'fight') drawCarWarning(ctx);

    if (matchState === 'fight') {
      Renderer.drawTimer(ctx, roundTimeLeft);
    } else if (matchState === 'countdown') {
      const n = Math.ceil(stateTimer);
      Renderer.drawCenteredMessage(ctx, n > 0 ? String(n) : 'FIGHT!');
    } else if (matchState === 'roundEnd') {
      Renderer.drawCenteredMessage(ctx, 'KO!', roundMessage);
    } else if (matchState === 'matchEnd') {
      const winner = bySlot(checkMatchWinner()) || p1;
      Renderer.drawCenteredMessage(ctx, winner.character.name + ' WINS!', 'Match Over');
    }
  }

  // The orchard car's warning: a flashing sign on the side it's coming from.
  function drawCarWarning(ctx) {
    const car = Stage.car();
    if (!car || car.phase !== 'warn' || car.timer % 20 >= 14) return;
    const left = car.dir > 0;
    const x = left ? 70 : CANVAS_WIDTH - 70, y = 330, a = left ? 1 : -1;
    ctx.save();
    ctx.fillStyle = 'rgba(255, 214, 64, 0.95)';
    ctx.strokeStyle = '#2b1d00';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x - a * 44, y - 34);
    ctx.lineTo(x + a * 18, y - 34);
    ctx.lineTo(x + a * 52, y);
    ctx.lineTo(x + a * 18, y + 34);
    ctx.lineTo(x - a * 44, y + 34);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#2b1d00';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CAR!', x - a * 8, y + 1);
    ctx.restore();
  }

  // ---- Online sync (see net.js) ----
  // Fields the guest must not receive: object refs and renderer-local caches.
  const SNAPSHOT_SKIP = new Set(['character', '_controls', '_visualPose']);

  function serializeFighter(f) {
    const o = {};
    for (const k of Object.keys(f)) {
      if (!SNAPSHOT_SKIP.has(k)) o[k] = f[k];
    }
    return o;
  }

  function getSnapshot() {
    return {
      m: matchState, st: stateTimer, rt: roundTimeLeft, rm: roundMessage,
      f: p1 && p2 ? fighters.map(serializeFighter) : null,
      pr: projectiles.map(p => Object.assign({}, p, { owner: p.owner.slot })),
      bl: ball,
      sg: Stage.save(),
      fx: Effects.drainEvents(),
    };
  }

  // Accepts full snapshots (P2P) or deltas (server): absent fields are unchanged.
  function applySnapshot(s) {
    if (s.m !== undefined) matchState = s.m;
    if (s.st !== undefined) stateTimer = s.st;
    if (s.rt !== undefined) roundTimeLeft = s.rt;
    if (s.rm !== undefined) roundMessage = s.rm;
    if (s.f && p1 && p2) s.f.forEach((o, i) => { if (fighters[i]) Object.assign(fighters[i], o); });
    if (s.pr) projectiles = s.pr.map(p => Object.assign(p, { owner: bySlot(p.owner) || p1 }));
    if (s.bl !== undefined) ball = s.bl;
    if (s.sg !== undefined) Stage.load(s.sg);
    Effects.replayEvents(s.fx);
  }

  // ---- Rollback netcode (see rollback.js) ----
  // A complete, independent copy of the simulation: restoring it and running
  // the same inputs again must give exactly the same result. Plain data only
  // (JSON-safe), so a peer can also send one over to repair a desync.
  function saveState() {
    return {
      m: matchState, st: stateTimer, rt: roundTimeLeft, rm: roundMessage,
      f: p1 && p2 ? fighters.map((f) => JSON.parse(JSON.stringify(serializeFighter(f)))) : null,
      pr: projectiles.map((p) => Object.assign({}, p, { owner: p.owner.slot })),
      bl: ball ? JSON.parse(JSON.stringify(ball)) : null,
      sg: Stage.save(),
      rl: roundLog.map((r) => Object.assign({}, r)),
    };
  }

  function loadState(s) {
    matchState = s.m; stateTimer = s.st; roundTimeLeft = s.rt; roundMessage = s.rm;
    if (s.f && p1 && p2) {
      fighters.forEach((f, i) => {
        const saved = s.f[i];
        // Drop fields added since the save, then copy (never share) the rest.
        for (const k of Object.keys(f)) if (!SNAPSHOT_SKIP.has(k) && !(k in saved)) delete f[k];
        Object.assign(f, JSON.parse(JSON.stringify(saved)));
      });
    }
    projectiles = s.pr.map((p) => Object.assign({}, p, { owner: bySlot(p.owner) || p1 }));
    ball = s.bl ? JSON.parse(JSON.stringify(s.bl)) : null;
    Stage.load(s.sg);
    roundLog = (s.rl || []).map((r) => Object.assign({}, r));
  }

  function getState() {
    return matchState;
  }

  // Read-only view of the live match, for the CPU opponent (cpu.js).
  function world() {
    return { p1, p2, fighters, projectiles, ball, ballMode, matchState, stage: Stage.id(), car: Stage.car(), platforms: Stage.platforms() };
  }

  // The finished match, for the stats: how each round ended and how much
  // health (0-1) each fighter had left when the last round ended.
  function matchSummary() {
    if (!p1 || !p2) return null;
    const left = (f) => f.state === 'ko' ? 0 : Math.max(0, Math.round((f.hp / f.maxHp) * 100) / 100);
    return { rounds: roundLog.map((r) => Object.assign({}, r)), hp: fighters.map(left) };
  }

  // Freeze the sim (e.g. opponent disconnected mid-match).
  function stop() {
    matchState = 'idle';
  }

  // Ball physics for the CPU's predictions (same code the game runs).
  const ballPhysics = {
    step: (b) => ballStep(b, ballMode),
    launch: (grounded, aim, strong, heat) => ballLaunch(grounded, aim, strong, ballMode, heat),
  };

  return { fightDamageMul, startMatch, update, render, getState, spawnProjectile, getSnapshot, applySnapshot, saveState, loadState, world, matchSummary, stop, ballDanger,
    fighter: bySlot, fighters: () => fighters, isFfa: () => ffa, ballColor, ballPhysics };
})();
