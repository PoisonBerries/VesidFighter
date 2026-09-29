// Match/round flow: countdown -> fight -> round end -> (next round or match
// end). Also owns hit-detection between the two fighters each tick, the
// projectile list (ranged specials/ultimates), and the ultimate-meter economy.

const Game = (() => {
  let p1 = null;
  let p2 = null;
  let matchState = 'idle'; // idle | countdown | fight | roundEnd | matchEnd
  let stateTimer = 0; // seconds remaining in current non-fight state
  let roundTimeLeft = ROUND_TIME;
  let roundMessage = '';
  let onMatchEnd = null; // callback(winnerSlot)
  let projectiles = [];

  function aabbOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function startMatch(char1Id, char2Id, matchEndCallback) {
    onMatchEnd = matchEndCallback;
    const startX1 = STAGE_LEFT_EDGE + 220;
    const startX2 = STAGE_RIGHT_EDGE - 220;
    p1 = new Fighter('p1', CHARACTERS[char1Id], startX1, 1);
    p2 = new Fighter('p2', CHARACTERS[char2Id], startX2, -1);
    p1.roundsWon = 0;
    p2.roundsWon = 0;
    Effects.reset();
    startRound();
  }

  function startRound() {
    const startX1 = STAGE_LEFT_EDGE + 220;
    const startX2 = STAGE_RIGHT_EDGE - 220;
    p1.x = startX1; p1.y = GROUND_Y; p1.vx = 0; p1.vy = 0;
    p1.hp = p1.maxHp; p1.state = 'idle'; p1.facing = 1; p1.specialCooldownTimer = 0; p1.ultCharge = 0; p1._visualPose = null;
    p2.x = startX2; p2.y = GROUND_Y; p2.vx = 0; p2.vy = 0;
    p2.hp = p2.maxHp; p2.state = 'idle'; p2.facing = -1; p2.specialCooldownTimer = 0; p2.ultCharge = 0; p2._visualPose = null;
    roundTimeLeft = ROUND_TIME;
    matchState = 'countdown';
    stateTimer = 3.0;
    projectiles = [];
    Effects.reset();
  }

  function endRound(winnerSlot) {
    matchState = 'roundEnd';
    stateTimer = 2.2;
    if (winnerSlot === 'p1') {
      p1.roundsWon++;
      roundMessage = (p1.character.name + ' WINS THE ROUND');
      p2.state = 'ko';
    } else if (winnerSlot === 'p2') {
      p2.roundsWon++;
      roundMessage = (p2.character.name + ' WINS THE ROUND');
      p1.state = 'ko';
    } else {
      roundMessage = "TIME'S UP -- DRAW";
    }
  }

  function checkMatchWinner() {
    if (p1.roundsWon >= ROUNDS_TO_WIN) return 'p1';
    if (p2.roundsWon >= ROUNDS_TO_WIN) return 'p2';
    return null;
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
      if (stateTimer <= 0 && onMatchEnd) {
        const winner = p1.roundsWon > p2.roundsWon ? 'p1' : 'p2';
        matchState = 'idle';
        onMatchEnd(winner);
      }
      return;
    }

    if (matchState !== 'fight') return;

    roundTimeLeft -= dt;

    p1.update(CONTROLS.p1, p2);
    p2.update(CONTROLS.p2, p1);
    InputManager.endFrame();

    resolveCombat();
    updateProjectiles();
    checkTransforms();
    Effects.update();

    if (p1.hasFallenOff() && p1.state !== 'ko') {
      p1.koByRingOut();
      endRound('p2');
      return;
    }
    if (p2.hasFallenOff() && p2.state !== 'ko') {
      p2.koByRingOut();
      endRound('p1');
      return;
    }
    if (p1.hp <= 0) {
      p1.state = 'ko';
      endRound('p2');
      return;
    }
    if (p2.hp <= 0) {
      p2.state = 'ko';
      endRound('p1');
      return;
    }
    if (roundTimeLeft <= 0) {
      if (p1.hp > p2.hp) endRound('p1');
      else if (p2.hp > p1.hp) endRound('p2');
      else endRound(null);
    }
  }

  function checkTransforms() {
    for (const f of [p1, p2]) {
      if (f.consumeTransformFlag()) {
        Effects.shake(14, 20);
        Effects.spawnHitSpark(f.x, f.y - f.height * 0.5, f.displayAccent);
        Effects.spawnHitSpark(f.x, f.y - f.height * 0.5, f.displayColor);
      }
    }
  }

  function resolveCombat() {
    tryHit(p1, p2);
    tryHit(p2, p1);
  }

  function grantUltCharge(attacker, defender, landedSpecial) {
    attacker.ultCharge = Math.min(ULT_METER_MAX, attacker.ultCharge + (landedSpecial ? ULT_GAIN_ON_LAND_SPECIAL : ULT_GAIN_ON_LAND_NORMAL));
    defender.ultCharge = Math.min(ULT_METER_MAX, defender.ultCharge + ULT_GAIN_ON_TAKEN);
  }

  function tryHit(attacker, defender) {
    const box = attacker.getHitbox();
    if (!box) return;
    const hurt = defender.getHurtbox();
    if (!aabbOverlap(box, hurt)) return;

    attacker.markHit();

    const isUlt = attacker.state === 'ultimate';
    const isSpecial = attacker.state === 'special';
    let stats = attacker.state === 'attack' ? attacker.character.attack
      : (isUlt ? attacker.character.ultimate : attacker.character.special);

    let dmg = stats.damage, kb = stats.knockback, kbUp = stats.knockbackUp, hs = stats.hitstun;
    let knockdown = false, knockdownDuration = 0;

    // Keenan's counter-dodge swings for its own (bigger) numbers, not the base special's.
    if (isSpecial && stats.type === 'counterDodge' && attacker._ability.phase === 'counter') {
      dmg = stats.counterDamage; kb = stats.counterKnockback; kbUp = stats.counterKnockbackUp; hs = stats.counterHitstun;
    }
    if (stats.type === 'dive' && stats.knockdownOnHit) {
      knockdown = true;
      knockdownDuration = stats.knockdownDuration;
    }

    dmg *= attacker.damageMultiplier;

    const result = defender.applyHit({
      damage: dmg, knockback: kb, knockbackUp: kbUp, hitstun: hs,
      fromFacing: attacker.facing, knockdown, knockdownDuration,
    });

    if (result === 'reflected') {
      reflectBack(attacker, defender, dmg, kb, kbUp, hs);
      return;
    }

    if (result === 'hit' && stats.poisonDamage) {
      defender.applyPoison(stats);
    }

    if (result === 'hit' || result === 'blocked') {
      grantUltCharge(attacker, defender, isSpecial || isUlt);
    }

    spawnImpactEffect(attacker, defender, box, hurt, result, isSpecial || isUlt);
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

  function spawnImpactEffect(attacker, defender, box, hurt, result, big) {
    const impactX = (box.x + box.w / 2 + hurt.x + hurt.w / 2) / 2;
    const impactY = hurt.y + hurt.h * 0.4;
    let color = '#ffe066';
    if (result === 'blocked') color = '#9fd8ff';
    else if (result === 'dodged' || result === 'phased') color = '#ffffff';
    Effects.spawnHitSpark(impactX, impactY, color);
    Effects.shake(big ? 10 : 5, big ? 16 : 8);
  }

  // ---- Projectiles (Owen's plasma, Ryan's soundwave) ----
  function spawnProjectile(owner, stats, opts) {
    opts = opts || {};
    const spawnX = owner.x + owner.facing * (owner.width * 0.5 + 8);
    const spawnY = owner.y - owner.height * 0.55;
    projectiles.push({
      owner,
      x: spawnX, y: spawnY,
      vx: owner.facing * stats.speed,
      w: stats.width, h: stats.height,
      damage: stats.damage, knockback: stats.knockback, knockbackUp: stats.knockbackUp, hitstun: stats.hitstun,
      color: opts.color || '#bfefff',
      life: 90,
      parryKnockdown: !!opts.parryKnockdown,
      knockdownDuration: opts.knockdownDuration || 0,
    });
    Effects.spawnHitSpark(spawnX, spawnY, opts.color || '#bfefff');
  }

  function updateProjectiles() {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      p.x += p.vx;
      p.life--;
      if (p.life <= 0 || p.x < -80 || p.x > CANVAS_WIDTH + 80) {
        projectiles.splice(i, 1);
        continue;
      }

      const defender = p.owner === p1 ? p2 : p1;
      if (defender.state === 'ko') continue;

      const hurt = defender.getHurtbox();
      const pbox = { x: p.x - p.w / 2, y: p.y - p.h / 2, w: p.w, h: p.h };
      if (!aabbOverlap(pbox, hurt)) continue;

      if (defender.invulnerableTimer > 0) {
        if (defender._dodging) {
          defender._dodgeSuccess = true;
          projectiles.splice(i, 1);
        }
        // Phased (non-dodging invulnerability): projectile passes straight through.
        continue;
      }

      if (defender.reflectTimer > 0) {
        p.vx = -p.vx;
        p.owner = defender;
        Effects.spawnHitSpark(p.x, p.y, '#ff3b3b');
        continue;
      }

      let knockdown = false;
      if (p.parryKnockdown && (defender.state === 'attack' || defender.state === 'special' || defender.state === 'ultimate')) {
        knockdown = true;
      }

      const dmg = p.damage * p.owner.damageMultiplier;
      const result = defender.applyHit({
        damage: dmg, knockback: p.knockback, knockbackUp: p.knockbackUp, hitstun: p.hitstun,
        fromFacing: p.vx >= 0 ? 1 : -1,
        knockdown, knockdownDuration: p.knockdownDuration,
      });

      if (result === 'hit' || result === 'blocked') {
        grantUltCharge(p.owner, defender, true);
      }

      Effects.spawnHitSpark(p.x, p.y, p.color);
      Effects.shake(6, 10);
      projectiles.splice(i, 1);
    }
  }

  function render(ctx) {
    Renderer.drawStage(ctx);
    if (!p1 || !p2) return;

    const shakeOffset = Effects.getShakeOffset();
    ctx.save();
    ctx.translate(shakeOffset.x, shakeOffset.y);

    Renderer.drawFighter(ctx, p1);
    Renderer.drawFighter(ctx, p2);
    Renderer.drawProjectiles(ctx, projectiles);
    Effects.draw(ctx);

    ctx.restore();

    Renderer.drawHUD(ctx, p1, p2);

    if (matchState === 'fight') {
      Renderer.drawTimer(ctx, roundTimeLeft);
    } else if (matchState === 'countdown') {
      const n = Math.ceil(stateTimer);
      Renderer.drawCenteredMessage(ctx, n > 0 ? String(n) : 'FIGHT!');
    } else if (matchState === 'roundEnd') {
      Renderer.drawCenteredMessage(ctx, 'KO!', roundMessage);
    } else if (matchState === 'matchEnd') {
      const winner = p1.roundsWon > p2.roundsWon ? p1 : p2;
      Renderer.drawCenteredMessage(ctx, winner.character.name + ' WINS!', 'Match Over');
    }
  }

  function getState() {
    return matchState;
  }

  return { startMatch, update, render, getState, spawnProjectile };
})();
