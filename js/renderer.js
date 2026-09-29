// All drawing: background/stage, fighters (custom sprite or procedural
// placeholder), and in-fight HUD (health bars, timer, round pips).

const Renderer = (() => {
  function drawStage(ctx) {
    // Sky
    const sky = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT);
    sky.addColorStop(0, '#2b1b3d');
    sky.addColorStop(1, '#6b3fa0');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Distant crowd dots for a bit of arena atmosphere
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    for (let i = 0; i < 40; i++) {
      const x = (i * 97) % CANVAS_WIDTH;
      const y = 60 + ((i * 53) % 120);
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
    }

    // The pit on either side of the platform (just more sky/void showing through)
    ctx.fillStyle = '#1a1025';
    ctx.fillRect(0, GROUND_Y, CANVAS_WIDTH, CANVAS_HEIGHT - GROUND_Y);

    // Platform
    const platGrad = ctx.createLinearGradient(0, GROUND_Y, 0, CANVAS_HEIGHT);
    platGrad.addColorStop(0, '#4a4063');
    platGrad.addColorStop(1, '#241c33');
    ctx.fillStyle = platGrad;
    ctx.fillRect(STAGE_LEFT_EDGE, GROUND_Y, STAGE_RIGHT_EDGE - STAGE_LEFT_EDGE, CANVAS_HEIGHT - GROUND_Y);

    // Top edge highlight
    ctx.fillStyle = '#8a7cae';
    ctx.fillRect(STAGE_LEFT_EDGE, GROUND_Y, STAGE_RIGHT_EDGE - STAGE_LEFT_EDGE, 6);

    // Cliff edge caps
    ctx.fillStyle = '#8a7cae';
    ctx.fillRect(STAGE_LEFT_EDGE - 4, GROUND_Y, 4, 40);
    ctx.fillRect(STAGE_RIGHT_EDGE, GROUND_Y, 4, 40);

    // Center line decoration
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.setLineDash([10, 10]);
    ctx.beginPath();
    ctx.moveTo(CANVAS_WIDTH / 2, GROUND_Y + 10);
    ctx.lineTo(CANVAS_WIDTH / 2, CANVAS_HEIGHT);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const RANGED_ABILITY_TYPES = new Set(['projectileCharge', 'soundwaveProjectile', 'nuke']);

  // Auras: any active special/ultimate glows in the character's own accent
  // color, except ranged abilities (icy white-blue) and Nathan's reflect
  // stance (always red, regardless of his own palette) per the "glow when
  // using specials, and differently for ranged attacks" brief.
  function getAuraColor(fighter) {
    if (fighter.reflectTimer > 0) return '#ff3b3b';
    if (fighter.invulnerableTimer > 0 && fighter._dodging) return '#ffffff';
    const def = fighter.state === 'special' ? fighter.character.special
      : fighter.state === 'ultimate' ? fighter.character.ultimate : null;
    if (!def) return null;
    return RANGED_ABILITY_TYPES.has(def.type) ? '#bfefff' : fighter.displayAccent;
  }

  function drawAura(ctx, fighter, color) {
    const cx = fighter.x;
    const cy = fighter.y - fighter.height * 0.55;
    const pulse = 0.75 + Math.sin(performance.now() / 60) * 0.25;
    const radius = fighter.width * 0.7 * pulse;
    ctx.save();
    const grad = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    Effects.spawnAuraPuff(fighter.x + (Math.random() * 2 - 1) * fighter.width * 0.3, fighter.y - fighter.height * 0.9, color);
  }

  function drawFighter(ctx, fighter) {
    const pose = fighter.currentPose();
    const customImg = SpriteManager.getImage(fighter.slot, pose)
      || SpriteManager.getImage(fighter.slot, 'idle');

    const auraColor = getAuraColor(fighter);
    if (auraColor) drawAura(ctx, fighter, auraColor);
    if (fighter.poisonTicksLeft > 0) {
      Effects.spawnAuraPuff(fighter.x + (Math.random() * 2 - 1) * fighter.width * 0.25, fighter.y - fighter.height * 0.3, '#6bbf59');
    }
    if (fighter.character.id === 'owen' && fighter._ability && fighter._ability.charging) {
      const chargeColor = fighter._ability.chargeFrames >= 10 ? '#ffe066' : '#e0aaff';
      Effects.spawnAuraPuff(fighter.x + fighter.facing * fighter.width * 0.4, fighter.y - fighter.height * 0.55, chargeColor);
    }

    ctx.save();
    ctx.translate(fighter.x, fighter.y);

    if (fighter.state === 'ko' || fighter.state === 'knockdown') {
      ctx.rotate(fighter.facing * Math.PI / 2 * (fighter.state === 'ko' ? 1 : 0.82));
    }

    ctx.scale(fighter.facing, 1);

    if (fighter.isPhased) ctx.globalAlpha = 0.35;

    const flashing = fighter.hitFlashTimer > 0 && Math.floor(fighter.hitFlashTimer / 3) % 2 === 0;
    if (flashing) ctx.filter = 'brightness(2.2) saturate(0.4)';
    else if (fighter.reflectTimer > 0) ctx.filter = 'brightness(1.2) hue-rotate(-20deg) saturate(1.6)';
    else if (fighter.state === 'special' || fighter.state === 'ultimate') ctx.filter = 'brightness(1.3) saturate(1.4)';
    else if (fighter.state === 'block') ctx.filter = 'brightness(0.9)';
    else if (fighter.poisonTicksLeft > 0) ctx.filter = 'saturate(0.7) hue-rotate(60deg)';

    if (customImg) {
      drawCustomSprite(ctx, customImg, fighter);
    } else {
      drawPlaceholder(ctx, fighter, pose);
    }

    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.restore();

    if (fighter.blocking) {
      drawShieldIcon(ctx, fighter.x, fighter.y - fighter.height - 18);
    }
  }

  function drawProjectiles(ctx, projectiles) {
    for (const p of projectiles) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(p.w, p.h) * 0.6);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.4, p.color);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(0, 0, p.w / 2, p.h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawCustomSprite(ctx, img, fighter) {
    const aspect = img.width / img.height;
    const targetHeight = fighter.height * 1.08;
    const targetWidth = targetHeight * aspect;
    ctx.drawImage(img, -targetWidth / 2, -targetHeight, targetWidth, targetHeight);
  }

  function drawShieldIcon(ctx, x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#ffd166';
    ctx.strokeStyle = '#5c4400';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(9, -4);
    ctx.lineTo(9, 6);
    ctx.lineTo(0, 12);
    ctx.lineTo(-9, 6);
    ctx.lineTo(-9, -4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // ---- Procedural placeholder figure (used until real sprites are uploaded) ----
  function drawPlaceholder(ctx, fighter, pose) {
    const color = fighter.displayColor;
    const accent = fighter.displayAccent;
    const H = fighter.height;
    const hipY = -H * 0.38;
    const shoulderY = -H * 0.72;
    const headY = -H * 0.86;
    const headR = H * 0.14;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 14;

    let legSpread = 10;
    let armSwing = 0;
    let armsForward = false;
    let armsCrossed = false;
    let armsUp = false;
    let lean = 0;
    let crouch = 0;

    switch (pose) {
      case 'walk':
        legSpread = 22 + Math.sin(fighter.walkCycle) * 14;
        armSwing = Math.sin(fighter.walkCycle) * 18;
        break;
      case 'jump':
        legSpread = -6;
        armsUp = true;
        break;
      case 'attack':
        armsForward = true;
        lean = 6;
        break;
      case 'special':
        armsForward = true;
        lean = 10;
        break;
      case 'block':
        armsCrossed = true;
        crouch = 10;
        break;
      case 'hit':
        lean = -14;
        armSwing = 30;
        break;
      case 'knockdown':
        legSpread = 26;
        armSwing = 40;
        crouch = 6;
        break;
      case 'victory':
        armsUp = true;
        break;
      default:
        break;
    }

    ctx.save();
    ctx.rotate(lean * Math.PI / 180);
    ctx.translate(0, crouch);

    // Back leg
    ctx.beginPath();
    ctx.moveTo(-legSpread * 0.5, hipY);
    ctx.lineTo(-legSpread, 0);
    ctx.stroke();
    // Front leg
    ctx.beginPath();
    ctx.moveTo(legSpread * 0.5, hipY);
    ctx.lineTo(legSpread, 0);
    ctx.stroke();

    // Torso
    ctx.beginPath();
    ctx.moveTo(0, hipY);
    ctx.lineTo(0, shoulderY);
    ctx.stroke();

    // Arms
    if (armsForward) {
      // back arm, pulled back
      ctx.beginPath();
      ctx.moveTo(0, shoulderY + 6);
      ctx.lineTo(-18, shoulderY + 20);
      ctx.stroke();
      // front arm, extended out (the "punch")
      ctx.beginPath();
      ctx.moveTo(0, shoulderY + 6);
      ctx.lineTo(46, shoulderY - 4);
      ctx.stroke();
      ctx.beginPath();
      ctx.fillStyle = accent;
      ctx.arc(50, shoulderY - 4, 10, 0, Math.PI * 2);
      ctx.fill();
    } else if (armsCrossed) {
      ctx.beginPath();
      ctx.moveTo(0, shoulderY + 6);
      ctx.lineTo(22, shoulderY + 18);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, shoulderY + 6);
      ctx.lineTo(-6, shoulderY + 30);
      ctx.stroke();
    } else if (armsUp) {
      ctx.beginPath();
      ctx.moveTo(0, shoulderY + 6);
      ctx.lineTo(-16, shoulderY - 26);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, shoulderY + 6);
      ctx.lineTo(16, shoulderY - 26);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(0, shoulderY + 6);
      ctx.lineTo(-14 + armSwing * 0.3, shoulderY + 26);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, shoulderY + 6);
      ctx.lineTo(14 - armSwing * 0.3, shoulderY + 26);
      ctx.stroke();
    }

    // Head -- a real portrait if one's been shipped for this character,
    // otherwise the plain colored circle.
    const headImg = CharacterHeads.getImage(fighter.character.id);
    if (headImg) {
      drawHeadImage(ctx, headImg, 0, headY, headR);
    } else {
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(0, headY, headR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, headY, headR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  function drawHeadImage(ctx, img, cx, cy, radius) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    const aspect = img.width / img.height;
    let dw, dh;
    if (aspect > 1) { dh = radius * 2.1; dw = dh * aspect; } else { dw = radius * 2.1; dh = dw / aspect; }
    ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
    ctx.restore();
  }

  // ---- HUD ----
  function drawHealthBar(ctx, x, y, w, h, hp, maxHp, flip) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x, y, w, h);
    const pct = Math.max(0, hp / maxHp);
    const barColor = pct > 0.5 ? '#4caf50' : pct > 0.2 ? '#ffb300' : '#e53935';
    ctx.fillStyle = barColor;
    if (flip) {
      ctx.fillRect(x + w * (1 - pct), y, w * pct, h);
    } else {
      ctx.fillRect(x, y, w * pct, h);
    }
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  function drawRoundPips(ctx, x, y, won, flip) {
    const spacing = 18;
    for (let i = 0; i < ROUNDS_TO_WIN; i++) {
      const px = flip ? x - i * spacing : x + i * spacing;
      ctx.beginPath();
      ctx.arc(px, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = i < won ? '#ffd166' : 'rgba(255,255,255,0.25)';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  function drawSpecialGauge(ctx, x, y, w, h, cooldownRemaining, cooldownMax, flip) {
    const ready = cooldownRemaining <= 0;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x, y, w, h);
    const pct = ready ? 1 : 1 - cooldownRemaining / cooldownMax;
    ctx.fillStyle = ready ? '#7ee8fa' : '#3d5a80';
    if (flip) {
      ctx.fillRect(x + w * (1 - pct), y, w * pct, h);
    } else {
      ctx.fillRect(x, y, w * pct, h);
    }
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  function drawUltGauge(ctx, x, y, w, h, charge, flip) {
    const ready = charge >= ULT_METER_MAX;
    const pct = charge / ULT_METER_MAX;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = ready ? '#ffd166' : '#a88a3d';
    if (flip) {
      ctx.fillRect(x + w * (1 - pct), y, w * pct, h);
    } else {
      ctx.fillRect(x, y, w * pct, h);
    }
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    if (ready) {
      const pulse = 0.5 + Math.sin(performance.now() / 120) * 0.5;
      ctx.strokeStyle = `rgba(255, 230, 102, ${0.4 + pulse * 0.6})`;
      ctx.lineWidth = 3;
      ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
    }
    ctx.restore();
  }

  function drawHUD(ctx, p1, p2) {
    const barW = 380;
    const barH = 26;
    const margin = 30;

    drawHealthBar(ctx, margin, 30, barW, barH, p1.hp, p1.maxHp, false);
    drawHealthBar(ctx, CANVAS_WIDTH - margin - barW, 30, barW, barH, p2.hp, p2.maxHp, true);

    drawSpecialGauge(ctx, margin, 60, 160, 8, p1.specialCooldownTimer, p1.character.special.cooldown, false);
    drawSpecialGauge(ctx, CANVAS_WIDTH - margin - 160, 60, 160, 8, p2.specialCooldownTimer, p2.character.special.cooldown, true);

    drawUltGauge(ctx, margin, 71, 160, 10, p1.ultCharge, false);
    drawUltGauge(ctx, CANVAS_WIDTH - margin - 160, 71, 160, 10, p2.ultCharge, true);

    drawRoundPips(ctx, margin, 96, p1.roundsWon, false);
    drawRoundPips(ctx, CANVAS_WIDTH - margin, 96, p2.roundsWon, true);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(p1.character.name + ' (P1)' + (p1.transformed ? ' – TRANSFORMED' : ''), margin, 4);
    ctx.textAlign = 'right';
    ctx.fillText(p2.character.name + ' (P2)' + (p2.transformed ? ' – TRANSFORMED' : ''), CANVAS_WIDTH - margin, 4);
    ctx.textAlign = 'left';
  }

  function drawTimer(ctx, seconds) {
    ctx.save();
    ctx.font = 'bold 44px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const text = Math.max(0, Math.ceil(seconds)).toString();
    ctx.strokeText(text, CANVAS_WIDTH / 2, 20);
    ctx.fillText(text, CANVAS_WIDTH / 2, 20);
    ctx.restore();
  }

  function drawCenteredMessage(ctx, text, subtext) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = 'bold 72px sans-serif';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 6;
    ctx.fillStyle = '#ffd166';
    ctx.strokeText(text, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 40);
    ctx.fillText(text, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 40);
    if (subtext) {
      ctx.font = 'bold 28px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.lineWidth = 4;
      ctx.strokeText(subtext, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 30);
      ctx.fillText(subtext, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 30);
    }
    ctx.restore();
  }

  return {
    drawStage,
    drawFighter,
    drawProjectiles,
    drawHUD,
    drawTimer,
    drawCenteredMessage,
  };
})();
