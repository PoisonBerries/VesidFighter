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

    const spin = getSpinRadians(fighter);
    if (spin) ctx.rotate(spin);

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

  // A two-bone leg: hip -> knee -> foot, with the knee kicked forward by
  // `kneeForward` so standing/crouching/walking actually shows a bent joint
  // instead of a single rigid line.
  function drawLeg(ctx, hipX, hipY, footX, kneeForward) {
    const kneeX = (hipX + footX) / 2 + kneeForward;
    const kneeY = hipY * 0.5;
    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.lineTo(kneeX, kneeY);
    ctx.lineTo(footX, 0);
    ctx.stroke();
  }

  // A two-bone arm: shoulder -> elbow -> hand, elbow offset perpendicular to
  // the shoulder-hand line by `bend` (sign controls which way it bends).
  function drawArm(ctx, shX, shY, handX, handY, bend) {
    const mx = (shX + handX) / 2, my = (shY + handY) / 2;
    const dx = handX - shX, dy = handY - shY;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len, py = dx / len;
    ctx.beginPath();
    ctx.moveTo(shX, shY);
    ctx.lineTo(mx + px * bend, my + py * bend);
    ctx.lineTo(handX, handY);
    ctx.stroke();
  }

  // ---- Per-character build: differentiates silhouette/stance beyond just
  // sizeScale, so e.g. Carlos reads as a hovering claw-fighter and Robert
  // reads as stocky even before any custom sprite exists.
  const DEFAULT_BODY_PROFILE = { limbWidth: 1, headScale: 1, stanceMul: 1, idleCrouch: 0, floaty: false, clawHands: false, dancer: false, reachBoost: 0 };
  const BODY_PROFILES = {
    keenan: { limbWidth: 0.82, headScale: 1.05, stanceMul: 0.9 },
    artur: { limbWidth: 1.0, stanceMul: 1.3, idleCrouch: 0.14 }, // squat frog stance
    carlos: { limbWidth: 1.05, headScale: 0.95, floaty: true, clawHands: true },
    nathan: { limbWidth: 0.78, headScale: 0.95, reachBoost: 26 }, // stretchy long reach
    owen: { limbWidth: 0.85, stanceMul: 0.95 },
    robert: { limbWidth: 1.3, headScale: 0.95, stanceMul: 1.2 },
    ryan: { limbWidth: 0.78, dancer: true },
    sam: { limbWidth: 0.85, headScale: 1.05, stanceMul: 0.85 },
    john: { limbWidth: 1.4, headScale: 0.9, stanceMul: 1.3 },
  };
  function getBodyProfile(id) {
    return { ...DEFAULT_BODY_PROFILE, ...(BODY_PROFILES[id] || {}) };
  }

  // Fist for most characters; a small three-talon claw for Carlos (his
  // whole kit is "Iron Claw"), drawn in the accent color like the fist was.
  function drawHand(ctx, x, y, profile, accent) {
    if (profile.clawHands) {
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      for (const deg of [-16, 0, 16]) {
        const rad = deg * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(rad) * 15, y + Math.sin(rad) * 15 - 5);
        ctx.stroke();
      }
      ctx.restore();
    } else {
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // A full-body barrel-roll spin, used for the two moves that are explicitly
  // about spinning/rolling (John's Momentum Roll and Big Silb Roll). Wraps
  // the *entire* figure (including legs, and even a custom uploaded sprite)
  // rather than just the upper-body lean the other poses use.
  function getSpinRadians(fighter) {
    const def = fighter.state === 'special' ? fighter.character.special
      : fighter.state === 'ultimate' ? fighter.character.ultimate : null;
    if (!def) return 0;
    const t = fighter.actionTimer;
    if (def.type === 'lunge' && t > def.startup && t <= def.startup + def.active) {
      return ((t - def.startup) / def.active) * Math.PI * 4; // two full spins
    }
    if (def.type === 'growRoll') {
      const a = fighter._ability;
      if (a && a.tGrowEnd !== undefined && t > a.tGrowEnd && t <= a.tRollEnd) {
        return ((t - a.tGrowEnd) / (a.tRollEnd - a.tGrowEnd)) * Math.PI * 4;
      }
    }
    return 0;
  }

  // Picks a pose that actually looks like the special/ultimate being
  // performed, keyed off the ability's `type` (shared across whichever
  // characters use that type) plus its live sub-phase where it matters
  // (e.g. Keenan mid-dodge vs mid-counter). Reads fighter._ability directly
  // -- an intentional, low-risk coupling to fighter.js's internal timing so
  // the visual always matches the mechanic exactly.
  function choreographAbility(def, fighter) {
    if (!def) return {};
    const a = fighter._ability || {};
    const t = fighter.actionTimer;
    switch (def.type) {
      case 'lunge':
        return { lean: 12, elbowBend: 4, armPose: 'forward' };
      case 'multiHit': {
        const idx = def.hits.findIndex((w) => t > w.start && t <= w.end);
        const upcoming = def.hits.findIndex((w) => t <= w.start);
        return { lean: 8, elbowBend: 6, armPose: idx === 1 ? 'slash2' : 'slash1', crouchAmount: upcoming === 0 ? 0.05 : 0 };
      }
      case 'slam':
        return a.hasLanded
          ? { crouchAmount: 0.05, armPose: 'slamDown', lean: 6 }
          : { armPose: 'raisedFists', lean: -4 };
      case 'dive':
        if (def.angle === 'down') return { armPose: 'tuckedDive', kneeForward: 22, crouchAmount: a.diving ? 0.1 : 0 };
        return a.diving ? { lean: 30, armPose: 'tackle', elbowBend: 2 } : { lean: 14, armPose: 'tackle', elbowBend: 4 };
      case 'growRoll':
        return (a.tGrowEnd !== undefined && t > a.tGrowEnd && t <= a.tRollEnd)
          ? { lean: 18, armPose: 'tuckedDive' }
          : { lean: 6, armPose: 'up' };
      case 'counterDodge':
        if (a.phase === 'counter') return { lean: 16, armPose: 'forward', elbowBend: 3 };
        if (a.phase === 'dodge') return { lean: -18, crouchAmount: 0.12, armPose: 'guard' };
        return { lean: -6, crouchAmount: 0.05, armPose: 'guard' };
      case 'projectileCharge':
        return { lean: 4, armPose: 'aim' };
      case 'soundwaveProjectile':
        return { lean: 6, armPose: a.fired ? 'shoutOut' : 'shoutIn' };
      case 'nuke':
        return a.fired ? { lean: 10, armPose: 'thrust' } : { lean: -4, armPose: 'channelUp' };
      case 'reflectStance':
        return { crouchAmount: 0.08, armPose: 'crossedGuard' };
      case 'buff':
        return { lean: -6, armPose: 'powerUp' };
      case 'poisonBurst':
        return { lean: -22, stride: 20, armPose: 'balance' };
      default:
        return {};
    }
  }

  // ---- Procedural placeholder figure (used until real sprites are uploaded) ----
  function drawPlaceholder(ctx, fighter, pose) {
    const color = fighter.displayColor;
    const accent = fighter.displayAccent;
    const H = fighter.height;
    const profile = getBodyProfile(fighter.character.id);
    const bulk = fighter.transformed ? 1.18 : 1;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 14 * profile.limbWidth * bulk;

    let stride = 9 * profile.stanceMul;   // how far apart the feet are
    let kneeForward = 10;                  // how much the knees bow forward
    let crouchAmount = profile.idleCrouch; // 0 = standing tall, ~0.25 = deep crouch
    let lean = 0;                          // upper-body lean, pivoting at the hip
    let elbowBend = 8;
    let armPose = 'swing';    // swing | forward | crossed | up | ...(see arm switch below)
    let armSwing = Math.sin(performance.now() / 400) * 3 * (profile.dancer ? 1.7 : 1); // idle sway

    switch (pose) {
      case 'walk': {
        const cyc = fighter.walkCycle;
        stride = (20 + Math.sin(cyc) * 15) * profile.stanceMul;
        kneeForward = 12 + Math.abs(Math.cos(cyc)) * 14;
        armSwing = Math.sin(cyc) * 22 * (profile.dancer ? 1.3 : 1);
        break;
      }
      case 'jump':
        stride = -8;
        kneeForward = 22;
        crouchAmount = 0.06;
        armPose = 'up';
        break;
      case 'attack':
        stride = 16 * profile.stanceMul;
        kneeForward = 16;
        lean = 9;
        elbowBend = 6;
        armPose = 'forward';
        break;
      case 'special': {
        // currentPose() collapses both 'special' and 'ultimate' fighter
        // states to this one pose name -- read fighter.state to know which
        // ability def is actually live.
        const def = fighter.state === 'ultimate' ? fighter.character.ultimate : fighter.character.special;
        const chore = choreographAbility(def, fighter);
        stride = chore.stride ?? (18 * profile.stanceMul);
        kneeForward = chore.kneeForward ?? 16;
        crouchAmount = chore.crouchAmount ?? crouchAmount;
        lean = chore.lean ?? 0;
        elbowBend = chore.elbowBend ?? elbowBend;
        armPose = chore.armPose ?? 'forward';
        break;
      }
      case 'block':
        crouchAmount = 0.24;
        kneeForward = 26;
        stride = 15 * profile.stanceMul;
        lean = 6;
        armPose = 'crossed';
        break;
      case 'knockdown':
        crouchAmount = 0.1;
        kneeForward = 28;
        stride = 24;
        armSwing = 34;
        break;
      case 'hit':
        lean = -16;
        kneeForward = 18;
        stride = 16;
        armSwing = 28;
        break;
      case 'victory':
        kneeForward = 6;
        armPose = 'up';
        break;
      default:
        break; // idle -- defaults above already give a subtle sway
    }

    // Carlos hovers -- never quite touches the ground while upright.
    const floatY = (profile.floaty && pose !== 'knockdown' && pose !== 'ko') ? -8 : 0;

    const crouchScale = 1 - crouchAmount;
    const hipY = -H * 0.38 * crouchScale + floatY;
    const shoulderY = -H * 0.72 * crouchScale + floatY;
    const headY = -H * 0.86 * crouchScale + floatY;
    const headR = H * 0.14 * profile.headScale;

    // Legs are drawn in world space -- feet planted at y=0 -- so leaning the
    // torso below doesn't lift them off the ground or distort their shape.
    drawLeg(ctx, -stride * 0.3, hipY, -stride, kneeForward);
    drawLeg(ctx, stride * 0.3, hipY, stride, kneeForward);

    ctx.save();
    // Lean the upper body (torso/arms/head) from the hip joint, not the
    // feet, so an attack's forward lean doesn't warp the legs.
    ctx.translate(0, hipY);
    ctx.rotate(lean * Math.PI / 180);
    ctx.translate(0, -hipY);

    // Torso
    ctx.beginPath();
    ctx.moveTo(0, hipY);
    ctx.lineTo(0, shoulderY);
    ctx.stroke();

    // Arms -- see choreographAbility()/the pose switch above for how each
    // character's kit maps onto these.
    const shY = shoulderY + 6;
    const reach = 46 + profile.reachBoost;
    switch (armPose) {
      case 'forward':
        drawArm(ctx, 0, shY, -18, shY + 20, -elbowBend);
        drawArm(ctx, 0, shY, reach, shY - 4, elbowBend);
        drawHand(ctx, reach, shY - 4, profile, accent);
        break;
      case 'crossed':
        drawArm(ctx, 0, shY, 22, shY + 18, -elbowBend);
        drawArm(ctx, 0, shY, -6, shY + 30, elbowBend);
        break;
      case 'crossedGuard': // Nathan's Rubber Guard -- tight symmetric brace
        drawArm(ctx, 0, shY, 16, shY + 8, -10);
        drawArm(ctx, 0, shY, -16, shY + 8, 10);
        break;
      case 'up':
        drawArm(ctx, 0, shY, -16, shoulderY - 26, -elbowBend);
        drawArm(ctx, 0, shY, 16, shoulderY - 26, elbowBend);
        break;
      case 'powerUp': { // Overgrowth / Encore cast -- triumphant raised fists
        const hy = shoulderY - 30;
        drawArm(ctx, 0, shY, -24, hy, -elbowBend);
        drawArm(ctx, 0, shY, 24, hy, elbowBend);
        drawHand(ctx, -24, hy, profile, accent);
        drawHand(ctx, 24, hy, profile, accent);
        break;
      }
      case 'guard': // Keenan's Foresight -- hands up, ready to react
        drawArm(ctx, 0, shY, -10, shY - 14, -6);
        drawArm(ctx, 0, shY, 10, shY - 14, 6);
        break;
      case 'aim': { // Owen charging a plasma bolt -- one hand out, glowing
        drawArm(ctx, 0, shY, -14, shY + 22, elbowBend);
        const hx = reach + 2, hy = shY - 6;
        drawArm(ctx, 0, shY, hx, hy, -elbowBend);
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(hx, hy, 7, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'shoutIn': // Ryan winding up Soundwave
        drawArm(ctx, 0, shY, -12, shY + 10, elbowBend);
        drawArm(ctx, 0, shY, 12, shY + 10, -elbowBend);
        break;
      case 'shoutOut': // Ryan releasing it -- both hands thrust out
        drawArm(ctx, 0, shY, reach - 6, shY - 2, elbowBend);
        drawArm(ctx, 0, shY, (reach - 6) * 0.7, shY + 10, -elbowBend);
        break;
      case 'channelUp': // Owen's Plasma Nuke, channeling
        drawArm(ctx, 0, shY, -20, shoulderY - 20, -6);
        drawArm(ctx, 0, shY, 20, shoulderY - 20, 6);
        break;
      case 'thrust': // Owen's Plasma Nuke, released
        drawArm(ctx, 0, shY, reach - 2, shY - 10, 4);
        drawArm(ctx, 0, shY, reach - 6, shY + 8, -4);
        break;
      case 'slash1': { // Carlos's Double Slash, first claw swipe
        const hx = reach - 6, hy = shY - 22;
        drawArm(ctx, 0, shY, hx, hy, elbowBend);
        drawArm(ctx, 0, shY, -16, shY + 18, -elbowBend);
        drawHand(ctx, hx, hy, profile, accent);
        break;
      }
      case 'slash2': { // second swipe, opposite diagonal
        const hx = reach - 6, hy = shY + 22;
        drawArm(ctx, 0, shY, hx, hy, -elbowBend);
        drawArm(ctx, 0, shY, -16, shY - 10, elbowBend);
        drawHand(ctx, hx, hy, profile, accent);
        break;
      }
      case 'raisedFists': { // Robert winding up Double Fist Slam
        const hy = shoulderY - 30;
        drawArm(ctx, 0, shY, -18, hy, -elbowBend);
        drawArm(ctx, 0, shY, 18, hy, elbowBend);
        drawHand(ctx, -18, hy, profile, accent);
        drawHand(ctx, 18, hy, profile, accent);
        break;
      }
      case 'slamDown': { // ...and bringing both fists down
        const hy = shY + 34;
        drawArm(ctx, 0, shY, -22, hy, -elbowBend);
        drawArm(ctx, 0, shY, 22, hy, elbowBend);
        drawHand(ctx, -22, hy, profile, accent);
        drawHand(ctx, 22, hy, profile, accent);
        break;
      }
      case 'tackle': { // Carlos's Rending Dive / Robert's Body Slam
        const h1x = reach, h1y = shY - 6, h2x = reach - 6, h2y = shY + 4;
        drawArm(ctx, 0, shY, h1x, h1y, elbowBend * 0.5);
        drawArm(ctx, 0, shY, h2x, h2y, -elbowBend * 0.5);
        drawHand(ctx, h1x, h1y, profile, accent);
        drawHand(ctx, h2x, h2y, profile, accent);
        break;
      }
      case 'tuckedDive': // Sam's dives / John's Big Silb Roll
        drawArm(ctx, 0, shY, -16, shY + 8, elbowBend);
        drawArm(ctx, 0, shY, 16, shY + 8, -elbowBend);
        break;
      case 'balance': // Artur's Poison Fart -- arms out for balance
        drawArm(ctx, 0, shY, -30, shY - 2, -6);
        drawArm(ctx, 0, shY, 30, shY - 2, 6);
        break;
      default: // 'swing' -- idle/walk/hit/knockdown
        drawArm(ctx, 0, shY, -14 + armSwing * 0.3, shY + 26, elbowBend);
        drawArm(ctx, 0, shY, 14 - armSwing * 0.3, shY + 26, -elbowBend);
        break;
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

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // A small rounded key-binding chip. `x` is the left edge normally, or the
  // right edge when `alignRight` is true (so P2's badges can mirror P1's).
  function drawKeyBadge(ctx, x, y, label, alignRight) {
    ctx.save();
    ctx.font = 'bold 11px sans-serif';
    const textW = ctx.measureText(label).width;
    const boxW = Math.max(18, textW + 10);
    const boxH = 16;
    const boxX = alignRight ? x - boxW : x;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    roundRectPath(ctx, boxX, y - boxH / 2, boxW, boxH, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, boxX + boxW / 2, y + 1);
    ctx.restore();
  }

  function drawHUD(ctx, p1, p2) {
    const barW = 380;
    const barH = 26;
    const margin = 30;
    const gaugeW = 160;

    drawHealthBar(ctx, margin, 30, barW, barH, p1.hp, p1.maxHp, false);
    drawHealthBar(ctx, CANVAS_WIDTH - margin - barW, 30, barW, barH, p2.hp, p2.maxHp, true);

    drawSpecialGauge(ctx, margin, 60, gaugeW, 8, p1.specialCooldownTimer, p1.character.special.cooldown, false);
    drawSpecialGauge(ctx, CANVAS_WIDTH - margin - gaugeW, 60, gaugeW, 8, p2.specialCooldownTimer, p2.character.special.cooldown, true);
    drawKeyBadge(ctx, margin + gaugeW + 8, 64, keyLabel(CONTROLS.p1.special), false);
    drawKeyBadge(ctx, CANVAS_WIDTH - margin - gaugeW - 8, 64, keyLabel(CONTROLS.p2.special), true);

    drawUltGauge(ctx, margin, 74, gaugeW, 10, p1.ultCharge, false);
    drawUltGauge(ctx, CANVAS_WIDTH - margin - gaugeW, 74, gaugeW, 10, p2.ultCharge, true);
    drawKeyBadge(ctx, margin + gaugeW + 8, 79, keyLabel(CONTROLS.p1.ultimate), false);
    drawKeyBadge(ctx, CANVAS_WIDTH - margin - gaugeW - 8, 79, keyLabel(CONTROLS.p2.ultimate), true);

    drawRoundPips(ctx, margin, 99, p1.roundsWon, false);
    drawRoundPips(ctx, CANVAS_WIDTH - margin, 99, p2.roundsWon, true);

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
