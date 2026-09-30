// All drawing: background/stage, fighters (procedural body), and in-fight HUD (health bars, timer, round pips).

const Renderer = (() => {
  // ---- Stage ----------------------------------------------------------
  // A floating sky-arena at dusk. Everything that never moves (sky, moon,
  // far ranges, ruined skyline, the rock island itself) is painted once into
  // an offscreen canvas and blitted each frame; only a handful of cheap
  // animated touches (twinkling stars, light beams, drifting embers, the
  // pulsing edge runes) are drawn live on top.
  let stageCache = null;
  let twinkleStars = [];

  function seededRandom(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function ridge(c, baseY, amp, seed, color, fadeTo) {
    const rnd = seededRandom(seed);
    const p1 = rnd() * 6, p2 = rnd() * 6, p3 = rnd() * 6;
    c.beginPath();
    c.moveTo(0, CANVAS_HEIGHT);
    for (let x = 0; x <= CANVAS_WIDTH; x += 8) {
      const y = baseY - amp * (0.55 * Math.sin(x / 190 + p1) + 0.3 * Math.sin(x / 83 + p2) + 0.15 * Math.sin(x / 37 + p3) + 0.6);
      c.lineTo(x, y);
    }
    c.lineTo(CANVAS_WIDTH, CANVAS_HEIGHT);
    c.closePath();
    const g = c.createLinearGradient(0, baseY - amp * 1.6, 0, baseY + 40);
    g.addColorStop(0, color);
    g.addColorStop(1, fadeTo);
    c.fillStyle = g;
    c.fill();
  }

  function skyline(c, baseY, seed, color, windowColor) {
    const rnd = seededRandom(seed);
    let x = -20;
    while (x < CANVAS_WIDTH + 20) {
      const w = 26 + rnd() * 46;
      const h = 40 + rnd() * 120 * (0.4 + 0.6 * Math.abs(Math.sin(x / 260)));
      c.fillStyle = color;
      c.fillRect(x, baseY - h, w, h + 160);
      // Broken ruined tops: a spire on some, a crumbled notch on others.
      if (rnd() < 0.3) {
        c.beginPath();
        c.moveTo(x + w * 0.2, baseY - h);
        c.lineTo(x + w * 0.5, baseY - h - 22 - rnd() * 26);
        c.lineTo(x + w * 0.8, baseY - h);
        c.closePath();
        c.fill();
      } else if (rnd() < 0.4) {
        // A stubby chimney/antenna block for a broken roofline.
        c.fillRect(x + w * 0.6, baseY - h - 9, w * 0.22, 9);
      }
      c.fillStyle = windowColor;
      for (let wy = baseY - h + 12; wy < baseY - 10; wy += 13) {
        for (let wx = x + 5; wx < x + w - 6; wx += 9) {
          if (rnd() < 0.16) c.fillRect(wx, wy, 3, 4);
        }
      }
      x += w + rnd() * 6;
    }
  }

  // Everything behind the island: sky, stars, moon, far ranges, ruined
  // skyline and haze. Shared with the 3D view (as its distant backdrop), which
  // passes bakeTwinkles since it has no per-frame 2D pass to twinkle them in.
  function paintBackdrop(c, rnd, bakeTwinkles) {
    // Sky: deep indigo overhead melting to a warm magenta horizon glow.
    const sky = c.createLinearGradient(0, 0, 0, CANVAS_HEIGHT);
    sky.addColorStop(0, '#0d0820');
    sky.addColorStop(0.35, '#241546');
    sky.addColorStop(0.68, '#5a2f86');
    sky.addColorStop(0.86, '#a24a9c');
    sky.addColorStop(1, '#d9788f');
    c.fillStyle = sky;
    c.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Stars (the brighter ones get re-drawn live so they twinkle).
    twinkleStars = [];
    for (let i = 0; i < 140; i++) {
      const x = rnd() * CANVAS_WIDTH, y = rnd() * 380;
      const r = 0.4 + rnd() * 1.3, a = 0.25 + rnd() * 0.6;
      if (!bakeTwinkles && r > 1.15 && twinkleStars.length < 26) {
        twinkleStars.push({ x, y, r, a, ph: rnd() * 6.28, sp: 1.2 + rnd() * 2 });
      } else {
        c.fillStyle = `rgba(255,245,255,${a})`;
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.fill();
      }
    }

    // Moon with a wide halo and soft craters.
    const mx = 1010, my = 150, mr = 62;
    const halo = c.createRadialGradient(mx, my, mr * 0.5, mx, my, mr * 4.2);
    halo.addColorStop(0, 'rgba(255,225,250,0.34)');
    halo.addColorStop(0.35, 'rgba(230,170,240,0.12)');
    halo.addColorStop(1, 'rgba(180,120,220,0)');
    c.fillStyle = halo;
    c.fillRect(mx - mr * 4.2, my - mr * 4.2, mr * 8.4, mr * 8.4);
    const disc = c.createRadialGradient(mx - 18, my - 18, 6, mx, my, mr);
    disc.addColorStop(0, '#fff7ff');
    disc.addColorStop(1, '#e6c6f2');
    c.fillStyle = disc;
    c.beginPath();
    c.arc(mx, my, mr, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = 'rgba(160,110,190,0.22)';
    for (const [dx, dy, r] of [[-20, -8, 11], [16, 18, 15], [22, -22, 7], [-8, 28, 6]]) {
      c.beginPath();
      c.arc(mx + dx, my + dy, r, 0, Math.PI * 2);
      c.fill();
    }

    // Distant range, then the ruined skyline, each hazier the further back.
    ridge(c, 470, 120, 7, '#5b3a86', '#a2508f');
    ridge(c, 520, 90, 21, '#3e2766', '#8c4590');
    skyline(c, 610, 99, '#2a1a4c', 'rgba(255,196,120,0.75)');
    // Haze pooling between the skyline and the island.
    const haze = c.createLinearGradient(0, 470, 0, CANVAS_HEIGHT);
    haze.addColorStop(0, 'rgba(217,120,150,0)');
    haze.addColorStop(0.55, 'rgba(217,120,160,0.28)');
    haze.addColorStop(1, 'rgba(240,150,170,0.5)');
    c.fillStyle = haze;
    c.fillRect(0, 470, CANVAS_WIDTH, CANVAS_HEIGHT - 470);
  }

  function buildBackdropCanvas() {
    const cv = document.createElement('canvas');
    cv.width = CANVAS_WIDTH;
    cv.height = CANVAS_HEIGHT;
    paintBackdrop(cv.getContext('2d'), seededRandom(1337), true);
    return cv;
  }

  function buildStageCache() {
    const cv = document.createElement('canvas');
    cv.width = CANVAS_WIDTH;
    cv.height = CANVAS_HEIGHT;
    const c = cv.getContext('2d');
    const rnd = seededRandom(1337);
    const L = STAGE_LEFT_EDGE, R = STAGE_RIGHT_EDGE, mid = (L + R) / 2;

    paintBackdrop(c, rnd, false);

    // ---- The floating island ----
    const slabH = 38;
    // Jagged tapering underside.
    const under = [];
    for (let x = L; x <= R; x += 30) {
      const k = Math.abs((x - mid) / ((R - L) / 2));
      const depth = 150 * (1 - Math.pow(k, 1.5)) + 18 + (rnd() - 0.5) * 26;
      under.push([x, GROUND_Y + slabH + depth]);
    }
    c.beginPath();
    c.moveTo(L, GROUND_Y + slabH - 2);
    for (const [x, y] of under) c.lineTo(x, y);
    c.lineTo(R, GROUND_Y + slabH - 2);
    c.closePath();
    const rock = c.createLinearGradient(0, GROUND_Y + slabH, 0, CANVAS_HEIGHT);
    rock.addColorStop(0, '#3a2f57');
    rock.addColorStop(1, '#171029');
    c.fillStyle = rock;
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.lineWidth = 2;
    c.stroke();
    // Cracks and lit crystals in the rock.
    c.strokeStyle = 'rgba(10,5,25,0.55)';
    c.lineWidth = 1.5;
    for (let i = 0; i < 16; i++) {
      const x = L + 40 + rnd() * (R - L - 80);
      let y = GROUND_Y + slabH + 4;
      c.beginPath();
      c.moveTo(x, y);
      for (let s = 0; s < 4; s++) {
        y += 8 + rnd() * 16;
        c.lineTo(x + (rnd() - 0.5) * 22, y);
      }
      c.stroke();
    }
    for (let i = 0; i < 9; i++) {
      const k = 0.15 + rnd() * 0.7;
      const x = L + k * (R - L);
      const kk = Math.abs((x - mid) / ((R - L) / 2));
      const y = GROUND_Y + slabH + 12 + rnd() * 90 * (1 - Math.pow(kk, 1.5));
      const gl = c.createRadialGradient(x, y, 0, x, y, 20);
      gl.addColorStop(0, 'rgba(190,150,255,0.85)');
      gl.addColorStop(1, 'rgba(190,150,255,0)');
      c.fillStyle = gl;
      c.fillRect(x - 20, y - 20, 40, 40);
      c.fillStyle = '#e6d4ff';
      c.beginPath();
      c.moveTo(x, y - 6); c.lineTo(x + 3.5, y); c.lineTo(x, y + 6); c.lineTo(x - 3.5, y);
      c.closePath();
      c.fill();
    }

    // Front stone face: staggered blocks with bevelled highlights.
    const face = c.createLinearGradient(0, GROUND_Y, 0, GROUND_Y + slabH);
    face.addColorStop(0, '#6b5f8f');
    face.addColorStop(1, '#40365f');
    c.fillStyle = face;
    c.fillRect(L, GROUND_Y, R - L, slabH);
    c.strokeStyle = 'rgba(15,8,35,0.5)';
    c.lineWidth = 1.5;
    const rows = [GROUND_Y + 6, GROUND_Y + 22];
    c.beginPath();
    c.moveTo(L, rows[1]);
    c.lineTo(R, rows[1]);
    c.stroke();
    for (let r = 0; r < 2; r++) {
      const top = r === 0 ? GROUND_Y + 6 : rows[1];
      const bot = r === 0 ? rows[1] : GROUND_Y + slabH;
      for (let x = L + (r ? 30 : 0); x < R; x += 60) {
        c.beginPath();
        c.moveTo(x, top);
        c.lineTo(x, bot);
        c.stroke();
        c.fillStyle = 'rgba(255,255,255,0.06)';
        c.fillRect(x + 2, top + 1, 56, 2);
      }
    }
    // Top surface: bright lip plus a darker walking strip below it.
    c.fillStyle = '#b3a5d9';
    c.fillRect(L, GROUND_Y, R - L, 4);
    c.fillStyle = '#8a7cae';
    c.fillRect(L, GROUND_Y + 4, R - L, 3);
    // Carved centre emblem.
    c.strokeStyle = 'rgba(190,170,255,0.32)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(mid, GROUND_Y + 10); c.lineTo(mid + 14, GROUND_Y + 22); c.lineTo(mid, GROUND_Y + 34); c.lineTo(mid - 14, GROUND_Y + 22);
    c.closePath();
    c.stroke();
    // Corner posts with the old cliff-cap look.
    c.fillStyle = '#a596cc';
    c.fillRect(L - 5, GROUND_Y, 5, slabH + 6);
    c.fillRect(R, GROUND_Y, 5, slabH + 6);

    return cv;
  }

  function drawStage(ctx) {
    if (!stageCache) stageCache = buildStageCache();
    ctx.drawImage(stageCache, 0, 0);
    const now = performance.now() / 1000;
    const L = STAGE_LEFT_EDGE, R = STAGE_RIGHT_EDGE;

    // Twinkling stars.
    for (const s of twinkleStars) {
      const a = s.a * (0.45 + 0.55 * Math.sin(now * s.sp + s.ph));
      ctx.fillStyle = `rgba(255,248,255,${Math.max(0, a)})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Two slow-sweeping searchlight beams from beyond the top corners,
    // crossing over the fighting area.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const side of [-1, 1]) {
      const ox = side < 0 ? 40 : CANVAS_WIDTH - 40;
      const tx = CANVAS_WIDTH / 2 + side * (150 + Math.sin(now * 0.45 + side) * 130);
      const spread = 70;
      const g = ctx.createLinearGradient(ox, -20, tx, GROUND_Y);
      g.addColorStop(0, 'rgba(255,220,255,0.16)');
      g.addColorStop(1, 'rgba(255,200,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(ox - 8, -20);
      ctx.lineTo(ox + 8, -20);
      ctx.lineTo(tx + spread, GROUND_Y);
      ctx.lineTo(tx - spread, GROUND_Y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Pulsing runes along the stone face.
    const pulse = 0.35 + 0.25 * Math.sin(now * 2);
    ctx.fillStyle = `rgba(150,130,255,${pulse})`;
    for (let x = L + 30; x < R; x += 60) {
      ctx.fillRect(x - 5, GROUND_Y + 12, 10, 2);
      ctx.fillRect(x - 1, GROUND_Y + 9, 2, 8);
    }
    // Glow along the lip.
    const lip = ctx.createLinearGradient(0, GROUND_Y - 14, 0, GROUND_Y);
    lip.addColorStop(0, 'rgba(200,170,255,0)');
    lip.addColorStop(1, `rgba(200,170,255,${0.16 + pulse * 0.2})`);
    ctx.fillStyle = lip;
    ctx.fillRect(L, GROUND_Y - 14, R - L, 14);

    // Embers drifting up off the island and out of the void.
    for (let i = 0; i < 28; i++) {
      const seed = i * 47.13;
      const life = ((now * (0.05 + (i % 5) * 0.012) + seed) % 1);
      const x = L - 120 + ((seed * 13.7) % (R - L + 240)) + Math.sin(now + seed) * 14;
      const y = GROUND_Y + 150 - life * 420;
      const a = Math.sin(life * Math.PI) * 0.55;
      ctx.fillStyle = `rgba(255,190,140,${a})`;
      ctx.beginPath();
      ctx.arc(x, y, 1 + (i % 3) * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
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

  // opts.card: drawing onto a 3D paper card (renderer3d.js). The card is
  // mirrored in 3D to face left, so draw facing right, and skip the
  // floor-level shadow/P1-P2 ring and the P1/P2 marker: the 3D view draws
  // those itself (a real shadow, a floor ring, and the marker on its
  // unmirrored effects layer). Returns the frame's rig so the 3D view can
  // shape its shadow and ring the same way.
  function drawFighter(ctx, fighter, opts) {
    const card = !!(opts && opts.card);
    const facing = card ? 1 : fighter.facing;
    const rig = Animator.update(fighter, getBodyProfile(fighter.character.id), opts);

    const auraColor = getAuraColor(fighter);
    if (auraColor) drawAura(ctx, fighter, auraColor);
    if (fighter.poisonTicksLeft > 0) {
      Effects.spawnAuraPuff(fighter.x + (Math.random() * 2 - 1) * fighter.width * 0.25, fighter.y - fighter.height * 0.3, '#6bbf59');
    }
    if (fighter.character.id === 'owen' && fighter._ability && fighter._ability.charging) {
      const chargeColor = fighter._ability.chargeFrames >= 10 ? '#ffe066' : '#e0aaff';
      Effects.spawnAuraPuff(fighter.x + fighter.facing * fighter.width * 0.4, fighter.y - fighter.height * 0.55, chargeColor);
    }

    // Ground contact shadow, drawn in world space (not the fighter's own
    // translated/rotated space) so it stays flat on the platform. It
    // shrinks/fades with height, and stretches out when the body lies down.
    const heightAboveGround = Math.max(0, GROUND_Y - fighter.y) + rig.lift;
    const shadowScale = Math.max(0.35, 1 - heightAboveGround / 220);
    const lying = Math.abs(Math.sin(rig.rot)) * (1 - Math.min(1, rig.ball));
    if (!card) {
      ctx.save();
      ctx.globalAlpha = 0.32 * shadowScale;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(fighter.x, GROUND_Y + 3, fighter.width * 0.34 * shadowScale * (1 + 1.1 * lying), 7 * shadowScale, 0, 0, Math.PI * 2);
      ctx.fill();
      // Side-coloured ring under the feet: identifies P1/P2 even when both
      // fighters look the same.
      ctx.globalAlpha = 0.85 * shadowScale;
      ctx.strokeStyle = PLAYER_COLORS[fighter.slot];
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(fighter.x, GROUND_Y + 3, fighter.width * 0.46 * shadowScale * (1 + 0.9 * lying), 9 * shadowScale, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(fighter.x, fighter.y);
    ctx.scale(facing, 1);

    // Whole-body transform, in facing-relative space (positive angle =
    // head toward the opponent): rotate about the body's pivot, placed at
    // the height that keeps the silhouette resting on the floor.
    ctx.translate(0, -rig.wh);
    ctx.rotate(rig.rot);
    ctx.translate(0, rig.pv);
    if (rig.stretch) {
      // Rubber stretch (Nathan): the upper body is pulled sideways with the
      // feet anchored, and widens/squashes a little to keep its volume.
      const s = rig.stretch;
      ctx.transform(1 + 0.25 * Math.abs(s), 0, -s * 0.45, 1 - 0.1 * Math.abs(s), 0, 0);
    }
    if (rig.axialSpin !== null && rig.axialSpin !== undefined) {
      ctx.scale(Math.max(0.3, Math.abs(Math.cos(rig.axialSpin))), 1); // drill-spin (see Animator)
    }
    if (rig.vstretch && Math.abs(rig.vstretch - 1) > 0.004) {
      // Squash and stretch (elastic bodies): taller and thinner rising, squat landing.
      ctx.scale(1 / Math.sqrt(rig.vstretch), rig.vstretch);
    }

    if (fighter.isPhased) ctx.globalAlpha = 0.35;

    // Status tints -- mixed directly into the fill colors drawPlaceholder
    // uses, rather than ctx.filter (a full CSS-style filter pass over the
    // rasterized scene, which got dramatically more expensive once the body
    // became many gradient-filled shapes instead of plain strokes -- this
    // was the actual cause of block, and any of these other states, tanking
    // to ~5fps) or a post-hoc 'source-atop' rectangle (which composites
    // against the *entire canvas so far*, including the background already
    // painted underneath, not just this character -- it left a visible
    // tinted box over the arena rather than just tinting the fighter).
    const flashing = fighter.hitFlashTimer > 0 && Math.floor(fighter.hitFlashTimer / 3) % 2 === 0;
    let tint = null;
    if (flashing) tint = { color: '#ffffff', alpha: 0.55 };
    else if (fighter.reflectTimer > 0) tint = { color: '#ff3c3c', alpha: 0.32 };
    else if (fighter.state === 'block') tint = { color: '#000000', alpha: 0.22 };
    else if (fighter.poisonTicksLeft > 0) tint = { color: '#78c85a', alpha: 0.3 };

    drawPlaceholder(ctx, fighter, rig, tint);

    ctx.globalAlpha = 1;
    ctx.restore();

    if (fighter.blocking) {
      drawShieldIcon(ctx, fighter.x, fighter.y - fighter.height - 18);
    }
    if (!card) drawPlayerMarker(ctx, fighter);
    return { lift: rig.lift, lying };
  }

  function drawProjectiles(ctx, projectiles) {
    for (const p of projectiles) {
      if (AbilityFX.drawProjectile(ctx, p)) continue; // kinds with their own art
      const dir = p.vx >= 0 ? 1 : -1;

      // Fake motion trail -- a few fading, shrinking copies behind the
      // direction of travel, so a fast-moving shot reads clearly even
      // against a busy background instead of looking like a static dot.
      for (let i = 3; i >= 1; i--) {
        const k = i / 3;
        ctx.save();
        ctx.translate(p.x - dir * i * p.w * 0.4, p.y);
        ctx.globalAlpha = 0.22 * (1 - k * 0.4);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(0, 0, (p.w / 2) * (1 - k * 0.35), (p.h / 2) * (1 - k * 0.35), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      ctx.translate(p.x, p.y);

      // Soft outer glow so it stands out even over similarly-colored terrain.
      const glowR = Math.max(p.w, p.h) * 0.9;
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR);
      glow.addColorStop(0, p.color);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.ellipse(0, 0, glowR, glowR * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();

      // Hot white-cored body with a bright outline for contrast at any size.
      ctx.globalAlpha = 1;
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(p.w, p.h) * 0.55);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.55, p.color);
      grad.addColorStop(1, p.color);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(0, 0, p.w / 2, p.h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.restore();
    }
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

  // ---- Filled-body drawing primitives -------------------------------
  // Replaces the old single-width stroked-line limbs with tapered, filled
  // "capsule" bones (thicker at the joint nearer the torso, narrower toward
  // the extremity, like real limbs) plus small joint discs to hide the
  // seams. This is what actually moves the placeholder from "stick figure"
  // to something with real body volume.

  // Accepts either "#rrggbb" or "rgb(r,g,b)" -- lets these color helpers
  // safely re-process a color that's already been through one of them.
  function parseColor(input) {
    if (input.startsWith('#')) {
      const h = input.replace('#', '');
      return [parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16)];
    }
    const m = input.match(/\d+/g);
    return [+m[0], +m[1], +m[2]];
  }

  function shadeColor(input, percent) {
    // percent < 0 darkens toward black, > 0 lightens toward white.
    const [r, g, b] = parseColor(input);
    const t = percent < 0 ? 0 : 255;
    const p = Math.abs(percent) / 100;
    const mix = (c) => Math.round((t - c) * p) + c;
    return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
  }

  // Alpha-blends tintInput over baseInput by tintAlpha (0-1). Used to apply
  // status tints (block darken, poison green, etc) directly into the fill
  // colors drawPlaceholder uses, so every shape just naturally draws in the
  // tinted color -- cheap, and correctly scoped to the character (unlike a
  // ctx.filter pass or a post-hoc 'source-atop' overlay rectangle).
  function mixColor(baseInput, tintInput, tintAlpha) {
    const [br, bg, bb] = parseColor(baseInput);
    const [tr, tg, tb] = parseColor(tintInput);
    const mix = (b, t) => Math.round(b * (1 - tintAlpha) + t * tintAlpha);
    return `rgb(${mix(br, tr)},${mix(bg, tg)},${mix(bb, tb)})`;
  }

  // A perpendicular light-to-dark gradient across a shape's own bounding
  // radius, so flat-filled limbs/torso read as cylindrical volume instead
  // of flat cutout shapes. `nx,ny` is the direction to lighten toward.
  function bodyGradient(ctx, cx, cy, nx, ny, radius, baseColor) {
    const grad = ctx.createLinearGradient(cx + nx * radius, cy + ny * radius, cx - nx * radius, cy - ny * radius);
    grad.addColorStop(0, shadeColor(baseColor, 30));
    grad.addColorStop(0.5, baseColor);
    grad.addColorStop(1, shadeColor(baseColor, -26));
    return grad;
  }

  // ---- Body parts ----
  // The figure is built from parts -- torso, neck, head, upper arm,
  // forearm, fist, thigh, shin, shoe -- placed on joints the rig positions.
  // Arms and legs are each drawn as ONE continuous shape from the shoulder
  // to the wrist / hip to the ankle, swelling over the muscles, so knees and
  // elbows bend instead of showing a seam. Every part can be replaced by a
  // drawing (bodyArt.js); the procedural shapes below are the defaults.
  // Lighting: one key light from the front and above (the way the fighter
  // faces), deep shadow on the far side with a little bounce light, and a
  // rim of the arena's pink-violet glow along the back edges. Outlines are
  // thin and dark -- the form comes from the light, not the line.
  const OUTLINE = 'rgba(8,5,14,0.72)';
  const KEY = { x: 0.8, y: -0.6 };
  const RIM = '#ffb0ec';
  const WRAP = '#e4dac6';
  const BOOT = '#1b161f';
  const LEATHER = '#35271f';
  const GLOVE = '#211a1f';
  const METAL = '#b3aca1';

  // Two-bone solve: bones keep their length and the middle joint (elbow or
  // knee) bends by however much the end-to-end distance requires. `pick`
  // chooses which of the two possible bends to use.
  function solveTwoBone(x1, y1, x2, y2, len1, len2, pick) {
    let dx = x2 - x1, dy = y2 - y1;
    let d = Math.hypot(dx, dy) || 0.001;
    const maxD = (len1 + len2) * 0.999;
    if (d > maxD) { dx *= maxD / d; dy *= maxD / d; x2 = x1 + dx; y2 = y1 + dy; d = maxD; }
    const minD = Math.abs(len1 - len2) + 0.5;
    if (d < minD) { dx *= minD / d; dy *= minD / d; x2 = x1 + dx; y2 = y1 + dy; d = minD; }
    const a = (len1 * len1 - len2 * len2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, len1 * len1 - a * a));
    const mx = x1 + (dx * a) / d, my = y1 + (dy * a) / d;
    const A = { x: mx + (dy / d) * h, y: my - (dx / d) * h };
    const B = { x: mx - (dy / d) * h, y: my + (dx / d) * h };
    return { mid: pick(A, B), end: { x: x2, y: y2 } };
  }

  // Simple tapered segment (neck).
  function drawSegment(ctx, x1, y1, x2, y2, r1, r2, color) {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.arc(x1, y1, r1, ang + Math.PI / 2, ang - Math.PI / 2);
    ctx.arc(x2, y2, r2, ang - Math.PI / 2, ang + Math.PI / 2);
    ctx.closePath();
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    const nx = -Math.sin(ang), ny = Math.cos(ang), R = Math.max(r1, r2);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const g = ctx.createLinearGradient(mx - nx * R, my - ny * R, mx + nx * R, my + ny * R);
    g.addColorStop(0, shadeColor(color, 12));
    g.addColorStop(1, shadeColor(color, -30));
    ctx.fillStyle = g;
    ctx.fill();
  }

  // Muscle profiles: limb radius (in body heights) along the limb, s from 0
  // (shoulder / hip) through 1 (elbow / knee) to 2 (wrist / ankle).
  const ARM_PROFILE = [[0, 0.037], [0.3, 0.039], [0.62, 0.033], [0.88, 0.026], [1, 0.025], [1.25, 0.03], [1.6, 0.024], [2, 0.019]];
  const LEG_PROFILE = [[0, 0.064], [0.3, 0.059], [0.75, 0.046], [0.95, 0.038], [1, 0.037], [1.3, 0.043], [1.6, 0.035], [1.88, 0.027], [2, 0.025]];

  function radiusAt(profile, s) {
    for (let i = 1; i < profile.length; i++) {
      if (s <= profile[i][0]) {
        const [s0, r0] = profile[i - 1], [s1, r1] = profile[i];
        let t = (s - s0) / (s1 - s0 || 1);
        t = t * t * (3 - 2 * t);
        return r0 + (r1 - r0) * t;
      }
    }
    return profile[profile.length - 1][1];
  }

  // Sample a two-bone limb A-B-C: centre points with the side normal
  // (blended across the joint so the outline bends smoothly) and radius.
  function limbSamples(A, B, C, profile, scale) {
    const N = 10;
    const d1x = B.x - A.x, d1y = B.y - A.y, l1 = Math.hypot(d1x, d1y) || 1;
    const d2x = C.x - B.x, d2y = C.y - B.y, l2 = Math.hypot(d2x, d2y) || 1;
    const n1 = { x: -d1y / l1, y: d1x / l1 }, n2 = { x: -d2y / l2, y: d2x / l2 };
    const blend = (w) => {
      const x = n1.x * (1 - w) + n2.x * w, y = n1.y * (1 - w) + n2.y * w;
      const l = Math.hypot(x, y) || 1;
      return { x: x / l, y: y / l };
    };
    const out = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const n = t > 0.7 ? blend(((t - 0.7) / 0.3) * 0.5) : n1;
      out.push({ x: A.x + d1x * t, y: A.y + d1y * t, n, r: radiusAt(profile, t) * scale, s: t });
    }
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const n = t < 0.3 ? blend(0.5 + (t / 0.3) * 0.5) : n2;
      out.push({ x: B.x + d2x * t, y: B.y + d2y * t, n, r: radiusAt(profile, 1 + t) * scale, s: 1 + t });
    }
    return out;
  }

  function smoothThrough(ctx, pts, first) {
    if (first) ctx.moveTo(pts[0].x, pts[0].y); else ctx.lineTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
    }
    const l = pts[pts.length - 1];
    ctx.lineTo(l.x, l.y);
  }

  // Outline path for the part of a limb between s0 and s1, with rounded
  // ends where asked (and straight cuts elsewhere, e.g. a trouser hem).
  function limbPath(ctx, S, s0, s1, capStart, capEnd, widen = 1) {
    const sel = S.filter((p) => p.s >= s0 - 1e-6 && p.s <= s1 + 1e-6);
    if (sel.length < 2) return false;
    const L = sel.map((p) => ({ x: p.x + p.n.x * p.r * widen, y: p.y + p.n.y * p.r * widen }));
    const R = sel.map((p) => ({ x: p.x - p.n.x * p.r * widen, y: p.y - p.n.y * p.r * widen }));
    const first = sel[0], last = sel[sel.length - 1];
    ctx.beginPath();
    smoothThrough(ctx, L, true);
    if (capEnd) {
      const th = Math.atan2(last.n.y, last.n.x);
      ctx.arc(last.x, last.y, last.r * widen, th, th - Math.PI, true);
    } else {
      ctx.lineTo(R[R.length - 1].x, R[R.length - 1].y);
    }
    smoothThrough(ctx, R.slice().reverse(), false);
    if (capStart) {
      const th = Math.atan2(first.n.y, first.n.x);
      ctx.arc(first.x, first.y, first.r * widen, th + Math.PI, th, true);
    }
    ctx.closePath();
    return true;
  }

  // Fill a limb section: dark outline first (the fill then covers its inner
  // half, including any fold where a deep bend overlaps itself), then the
  // key-lit fill, then the rim light along the shadow side.
  function paintLimb(ctx, S, s0, s1, capStart, capEnd, color, widen = 1, rim = true) {
    if (!limbPath(ctx, S, s0, s1, capStart, capEnd, widen)) return;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    const mid = S.filter((p) => p.s >= s0 && p.s <= s1);
    const m = mid[Math.floor(mid.length / 2)] || S[0];
    const lit = m.n.x * KEY.x + m.n.y * KEY.y >= 0 ? 1 : -1;
    const R = m.r * widen * 1.05;
    const g = ctx.createLinearGradient(m.x + m.n.x * R * lit, m.y + m.n.y * R * lit, m.x - m.n.x * R * lit, m.y - m.n.y * R * lit);
    g.addColorStop(0, shadeColor(color, 24));
    g.addColorStop(0.28, shadeColor(color, 6));
    g.addColorStop(0.62, shadeColor(color, -24));
    g.addColorStop(0.86, shadeColor(color, -40));
    g.addColorStop(1, shadeColor(color, -22)); // bounce light
    ctx.fillStyle = g;
    ctx.fill();
    if (rim) {
      const edge = mid.map((p) => ({ x: p.x - p.n.x * p.r * widen * 0.9 * lit, y: p.y - p.n.y * p.r * widen * 0.9 * lit }));
      if (edge.length > 1) {
        ctx.save();
        ctx.globalAlpha *= 0.26;
        ctx.strokeStyle = RIM;
        ctx.lineWidth = 1.2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        smoothThrough(ctx, edge, true);
        ctx.stroke();
        ctx.restore();
      }
    }
    return lit;
  }

  // Muscle definition on a bare arm: where the deltoid meets the arm, the
  // split between biceps and triceps, and the line down the forearm.
  function armDefinition(ctx, S, skin, lit) {
    const at = (s) => S.reduce((a, b) => (Math.abs(b.s - s) < Math.abs(a.s - s) ? b : a));
    const line = (s0, s1, off0, off1) => {
      const a = at(s0), b = at(s1);
      ctx.beginPath();
      ctx.moveTo(a.x + a.n.x * a.r * off0 * lit, a.y + a.n.y * a.r * off0 * lit);
      const m = at((s0 + s1) / 2);
      ctx.quadraticCurveTo(m.x + m.n.x * m.r * ((off0 + off1) / 2 + 0.12) * lit, m.y + m.n.y * m.r * ((off0 + off1) / 2 + 0.12) * lit,
        b.x + b.n.x * b.r * off1 * lit, b.y + b.n.y * b.r * off1 * lit);
      ctx.stroke();
    };
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = shadeColor(skin, -35);
    ctx.globalAlpha *= 0.28;
    ctx.lineWidth = 1.1;
    line(0.45, 0.88, 0.1, 0.18);    // biceps / triceps
    line(1.1, 1.45, 0.3, 0.12);     // forearm
    ctx.restore();
  }

  // Leather bracer on the forearm: trim at both ends and a couple of studs.
  function bracer(ctx, S, s0, s1, colors) {
    paintLimb(ctx, S, s0, s1, false, false, colors.leather, 1.1);
    const at = (s) => S.reduce((a, b) => (Math.abs(b.s - s) < Math.abs(a.s - s) ? b : a));
    ctx.save();
    ctx.lineCap = 'butt';
    for (const t of [s0 + 0.03, s1 - 0.03]) {
      const p = at(t);
      ctx.strokeStyle = colors.trim;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(p.x + p.n.x * p.r * 1.1, p.y + p.n.y * p.r * 1.1);
      ctx.lineTo(p.x - p.n.x * p.r * 1.1, p.y - p.n.y * p.r * 1.1);
      ctx.stroke();
    }
    ctx.fillStyle = METAL;
    for (const t of [s0 + (s1 - s0) * 0.38, s0 + (s1 - s0) * 0.68]) {
      const p = at(t);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1, p.r * 0.2), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // A boot: heel under the ankle, toe pointing along `angle`.
  function drawBoot(ctx, x, y, angle, size, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(-size * 0.5, -size * 0.85);
    ctx.lineTo(size * 0.35, -size * 0.8);
    ctx.quadraticCurveTo(size * 0.55, -size * 0.35, size * 1.15, -size * 0.22);
    ctx.quadraticCurveTo(size * 1.55, -size * 0.1, size * 1.5, size * 0.3);
    ctx.lineTo(-size * 0.62, size * 0.3);
    ctx.quadraticCurveTo(-size * 0.72, -size * 0.2, -size * 0.5, -size * 0.85);
    ctx.closePath();
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    const g = ctx.createLinearGradient(0, -size, size * 0.6, size * 0.3);
    g.addColorStop(0, shadeColor(color, 30));
    g.addColorStop(1, shadeColor(color, -30));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.fillStyle = shadeColor(color, -45); // sole
    ctx.fillRect(-size * 0.62, size * 0.14, size * 2.1, size * 0.16);
    ctx.restore();
  }

  // Motion smear: the tip's recent path (last ~110 ms) as a streak that
  // tapers and fades toward the past, drawn behind the limb while it's
  // moving fast. `trail` persists between frames (on the fighter's visual
  // state); `on` is false outside strikes, which just resets it.
  function smear(ctx, trail, tip, on, width, H) {
    if (!trail) return;
    const now = performance.now();
    if (!on) { trail.length = 0; return; }
    trail.push({ x: tip.x, y: tip.y, t: now });
    while (trail.length && now - trail[0].t > 110) trail.shift();
    if (trail.length < 3) return;
    let len = 0;
    for (let i = 1; i < trail.length; i++) len += Math.hypot(trail[i].x - trail[i - 1].x, trail[i].y - trail[i - 1].y);
    if (len < H * 0.12) return; // too slow to streak
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 1; i < trail.length; i++) {
      const k = i / (trail.length - 1);
      ctx.strokeStyle = `rgba(255,244,224,${0.5 * k})`;
      ctx.lineWidth = Math.max(1, width * k);
      ctx.beginPath();
      ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
      ctx.lineTo(trail[i].x, trail[i].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Hip -> knee -> ankle -> boot. Knees always bend forward.
  function drawLeg(ctx, hip, foot, pointAmt, dims, colors, art) {
    const { thigh, shin, foot: footSize, bulk } = dims;
    const H = dims.H;
    // Knees bend forward -- or, for a mocap clip, toward where the real knee was.
    const h = foot.hint;
    const pickKnee = h ? (A, B) => (Math.hypot(A.x - h.x, A.y - h.y) <= Math.hypot(B.x - h.x, B.y - h.y) ? A : B) : (A, B) => (A.x > B.x ? A : B);
    const sol = solveTwoBone(hip.x, hip.y, foot.x, foot.y - footSize * 0.45, thigh, shin, pickKnee);
    const knee = sol.mid, ankle = sol.end;
    const lifted = Math.min(1, Math.max(0, -foot.y / 25));
    const shinAng = Math.atan2(ankle.y - knee.y, ankle.x - knee.x) - Math.PI / 2;
    const flat = lifted * 0.5;
    // A mocap clip gives the foot's own direction; otherwise flat, tipping
    // toe-down when lifted and along the shin for a kick.
    const footAng = foot.angle !== undefined && foot.angle !== null ? foot.angle : flat + (shinAng - flat) * (pointAmt || 0);  // clip: change from flat
    const toe = { x: ankle.x + Math.cos(footAng) * footSize * 1.4, y: ankle.y + Math.sin(footAng) * footSize * 1.4 };
    smear(ctx, foot.trail, toe, foot.smear, footSize * 1.4, H);
    const S = limbSamples(hip, knee, ankle, LEG_PROFILE, H * bulk);
    if (!art.has('thigh') && !art.has('shin')) {
      legShin(ctx, S, colors);
      paintLimb(ctx, S, 0, 1.4, true, false, colors.pants, 1.04); // loose trousers, tucked into the wraps
    } else {
      art.draw('shin', knee, ankle, () => legShin(ctx, S, colors, true));
      art.draw('thigh', hip, knee, () => paintLimb(ctx, S, 0, 1, true, true, colors.pants, 1.04));
    }
    art.draw('shoe', ankle, toe, () => partShoeAt(ctx, ankle, toe, footSize, colors));
  }

  function legShin(ctx, S, colors, alone) {
    if (alone) paintLimb(ctx, S, 1, 1.4, true, false, colors.pants, 1.04);
    paintLimb(ctx, S, 1.28, 2, false, true, colors.boot, 1.06);
    paintLimb(ctx, S, 1.28, 1.36, false, false, colors.trim, 1.1, false);
  }

  function partShoeAt(ctx, A, B, size, colors) {
    const ang = Math.atan2(B.y - A.y, B.x - A.x);
    drawBoot(ctx, A.x - Math.sin(ang) * size * 0.35, A.y + Math.cos(ang) * size * 0.35, ang, size, colors.boot);
  }

  // Shoulder -> elbow -> fist. Elbows bend down and back, like a real guard.
  function drawArm(ctx, shoulder, hand, dims, colors, profile, orb, accent, art, only) {
    const stretch = hand.stretch || 1; // elastic arms: bones lengthen, the limb thins
    const upper = dims.upper * stretch, fore = dims.fore * stretch;
    const { fist, bulk } = dims;
    const H = dims.H;
    // Elbows bend down and back -- or, for a mocap clip, toward the real elbow.
    const h = hand.hint;
    const pickElbow = h ? (A, B) => (Math.hypot(A.x - h.x, A.y - h.y) <= Math.hypot(B.x - h.x, B.y - h.y) ? A : B)
      : (A, B) => ((A.y - A.x * 0.35) > (B.y - B.x * 0.35) ? A : B);
    const sol = solveTwoBone(shoulder.x, shoulder.y, hand.x, hand.y, upper, fore, pickElbow);
    const elbow = sol.mid, wrist = sol.end;
    const ang = Math.atan2(wrist.y - elbow.y, wrist.x - elbow.x);
    const knuckles = { x: wrist.x + Math.cos(ang) * fist * 1.4, y: wrist.y + Math.sin(ang) * fist * 1.4 };
    if (only !== 'upper') smear(ctx, hand.trail, knuckles, hand.smear, fist * 1.8, H);
    const S = limbSamples(shoulder, elbow, wrist, ARM_PROFILE, (H * bulk) / Math.sqrt(stretch));
    const upperArm = () => { const lit = paintLimb(ctx, S, 0, 1, true, true, colors.skin); armDefinition(ctx, S, colors.skin, lit); };
    const forearm = () => { paintLimb(ctx, S, 1, 2, true, true, colors.skin); bracer(ctx, S, 1.42, 1.95, colors); };
    if (only === 'upper') {
      art.draw('upperArm', shoulder, elbow, upperArm);
      return;
    }
    if (only === 'lower') {
      art.draw('forearm', elbow, wrist, forearm);
    } else if (!art.has('upperArm') && !art.has('forearm')) {
      const lit = paintLimb(ctx, S, 0, 2, true, true, colors.skin);
      armDefinition(ctx, S, colors.skin, lit);
      bracer(ctx, S, 1.42, 1.95, colors);
    } else {
      art.draw('upperArm', shoulder, elbow, upperArm);
      art.draw('forearm', elbow, wrist, forearm);
    }
    art.draw('fist', wrist, knuckles, () => partFistAt(ctx, wrist, knuckles, fist, colors, profile, accent));
    if (orb > 0.02) {
      ctx.save();
      ctx.globalAlpha *= Math.min(1, orb);
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(knuckles.x, knuckles.y, 7 * orb, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function partFistAt(ctx, A, B, r, colors, profile, accent) {
    const ang = Math.atan2(B.y - A.y, B.x - A.x);
    drawFist(ctx, A.x + Math.cos(ang) * r * 0.55, A.y + Math.sin(ang) * r * 0.55, ang, r, colors, profile, accent);
  }

  // A fist in a fingerless fighting glove: knuckles forward, thumb across,
  // the fingers showing. Carlos gets claws.
  function drawFist(ctx, x, y, ang, r, colors, profile, accent) {
    if (profile.clawHands) { drawHand(ctx, x, y, profile, accent); return; }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    const shape = () => {
      ctx.beginPath();
      ctx.moveTo(-r * 0.75, -r * 0.8);
      ctx.quadraticCurveTo(r * 0.85, -r * 1.1, r * 1.05, -r * 0.15);
      ctx.quadraticCurveTo(r * 1.1, r * 0.85, -r * 0.05, r * 0.95);
      ctx.quadraticCurveTo(-r * 0.95, r * 0.85, -r * 0.75, -r * 0.8);
      ctx.closePath();
    };
    shape();
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    const g = ctx.createLinearGradient(-r, -r, r, r);
    g.addColorStop(0, shadeColor(colors.glove, 35));
    g.addColorStop(1, shadeColor(colors.glove, -20));
    ctx.fillStyle = g;
    ctx.fill();
    // The fingers, curled over the front.
    ctx.save();
    shape();
    ctx.clip();
    const fg = ctx.createLinearGradient(0, -r, 0, r);
    fg.addColorStop(0, shadeColor(colors.skin, 10));
    fg.addColorStop(1, shadeColor(colors.skin, -30));
    ctx.fillStyle = fg;
    ctx.fillRect(r * 0.58, -r * 1.2, r * 0.6, r * 2.4);
    ctx.restore();
    ctx.strokeStyle = shadeColor(colors.skin, -50);
    ctx.lineWidth = 1;
    for (const t of [-0.35, 0.1, 0.52]) {
      ctx.beginPath();
      ctx.moveTo(r * 0.62, r * t);
      ctx.lineTo(r * 1.02, r * t);
      ctx.stroke();
    }
    // Knuckle pad and wrist strap.
    ctx.strokeStyle = colors.trim;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-r * 0.55, -r * 0.7);
    ctx.lineTo(-r * 0.35, r * 0.85);
    ctx.stroke();
    ctx.restore();
  }

  // ---- Per-character build: differentiates silhouette/stance beyond just
  // sizeScale, so e.g. Carlos reads as a hovering claw-fighter and Robert
  // reads as stocky at a glance.
  // Build: shoulders/waist/hips scale the torso's widths, armBulk/legBulk
  // the limbs' thickness (muscle), headScale the photo head.
  // Body shape settings (all multipliers of the default, 1 = standard):
  //   headScale, neckLength, neckWidth -- head and neck
  //   torsoLength, shoulders, waist, hips -- torso length and breadths
  //   armScale (length), armBulk (thickness), handScale
  //   legLength, legBulk (thickness), footScale, stanceMul (feet apart)
  // Plus movement flags the animator reads (idleCrouch, floaty, dancer, ...).
  // A character's saved assets/parts/<id>/body.json, and live edits in the
  // Body Part Studio, override these (see BodyArt.build).
  const DEFAULT_BODY_PROFILE = {
    headScale: 1, neckLength: 1, neckWidth: 1,
    torsoLength: 1, shoulders: 1, waist: 1, hips: 1,
    armScale: 1, armBulk: 1, handScale: 1,
    legLength: 1, legBulk: 1, footScale: 1, stanceMul: 1,
    idleCrouch: 0, floaty: false, clawHands: false, dancer: false, reachBoost: 0, staggerMul: 1,
  };
  const BODY_PROFILES = {
    keenan: { headScale: 1.05, stanceMul: 0.9, staggerMul: 1.25, shoulders: 0.92, waist: 0.9, armBulk: 0.85, legBulk: 0.88 }, // small and wiry
    artur: { stanceMul: 1.3, idleCrouch: 0.14, shoulders: 1.0, armBulk: 0.95, legBulk: 1.12 }, // squat frog stance, strong kicking legs
    carlos: { headScale: 0.95, floaty: true, clawHands: true, staggerMul: 0.85, shoulders: 1.15, armBulk: 1.12, legBulk: 1.05 },
    nathan: { headScale: 0.95, reachBoost: 26, armScale: 1.25, staggerMul: 1.2, shoulders: 0.95, waist: 0.9, armBulk: 0.82, legBulk: 0.9 }, // stretchy long arms and reach
    owen: { stanceMul: 0.95, staggerMul: 1.2, shoulders: 0.9, waist: 0.92, armBulk: 0.85, legBulk: 0.9 },
    robert: { headScale: 0.95, stanceMul: 1.2, staggerMul: 0.6, shoulders: 1.22, waist: 1.02, armBulk: 1.4, legBulk: 1.2 }, // stocky, muscular
    ryan: { dancer: true, staggerMul: 1.3, shoulders: 0.95, waist: 0.85, armBulk: 0.85, legBulk: 0.92 },
    sam: { headScale: 1.05, stanceMul: 0.85, staggerMul: 1.3, shoulders: 1.1, waist: 0.84, armBulk: 1.0, legBulk: 0.95 }, // swimmer's V-shape
    john: { headScale: 0.9, stanceMul: 1.3, staggerMul: 0.5, shoulders: 1.3, waist: 1.38, hips: 1.3, armBulk: 1.3, legBulk: 1.3 }, // broad, thicc frame
  };
  function getBodyProfile(id) {
    const custom = typeof BodyArt !== 'undefined' && BodyArt.build ? BodyArt.build(id) : null;
    return { ...DEFAULT_BODY_PROFILE, ...(BODY_PROFILES[id] || {}), ...(custom || {}) };
  }

  // Judgment call made by looking at each shipped head photo: Artur and
  // Owen are both clearly turned/gazing toward camera-left in their source
  // images; everyone else reads close enough to frontal that no correction
  // is needed. See the flip-math note where this is used, in drawPlaceholder.
  const HEAD_FLIP_FIX = new Set(['artur', 'owen']);

  // Fist for most characters; a small three-talon metal claw for Carlos
  // (his whole kit is "Iron Claw"), drawn in the accent color.
  // Carlos's hand: a dark gauntlet with three steel claw blades, their
  // edges catching his accent colour.
  function drawHand(ctx, x, y, profile, accent) {
    ctx.save();
    for (const deg of [-22, -2, 18]) {
      const a = deg * Math.PI / 180;
      const ux = Math.cos(a), uy = Math.sin(a);
      const len = 17, w = 2.2;
      const bx = x + ux * 4, by = y + uy * 4 - 1;
      ctx.beginPath();
      ctx.moveTo(bx - uy * w, by + ux * w);
      ctx.quadraticCurveTo(bx + ux * len * 0.6 - uy * w * 0.9, by + uy * len * 0.6 + ux * w * 0.9, bx + ux * len, by + uy * len - 3);
      ctx.lineTo(bx + uy * w, by - ux * w);
      ctx.closePath();
      const g = ctx.createLinearGradient(bx - uy * w, by + ux * w, bx + uy * w, by - ux * w);
      g.addColorStop(0, '#6f737c');
      g.addColorStop(0.5, '#e6e8ee');
      g.addColorStop(1, shadeColor(accent, -10));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 0.9;
      ctx.stroke();
    }
    const palm = ctx.createRadialGradient(x - 2, y - 2, 1, x, y, 7);
    palm.addColorStop(0, shadeColor(GLOVE, 40));
    palm.addColorStop(1, GLOVE);
    ctx.fillStyle = palm;
    ctx.beginPath();
    ctx.arc(x, y, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
  }

  // ---- Per-character costume accents, layered onto the base filled body so
  // the roster reads as distinct characters (not just recolored stick
  // figures).

  // Drawn first, before the legs -- for anything that sits behind/under the
  // whole figure (Carlos's hover thrusters glowing beneath his feet).
  function drawBackAccessory(ctx, id, floatY) {
    if (id === 'carlos') {
      // Glow fills the gap between his lifted feet and the actual ground
      // line (y=0), so the hover reads as thruster-supported rather than
      // an unexplained floating figure.
      const pulse = 0.75 + Math.sin(performance.now() / 90) * 0.2;
      const glowY = floatY * 0.25; // just under his feet, above the ground line
      ctx.save();
      for (const fx of [-9, 9]) {
        const g = ctx.createRadialGradient(fx, glowY, 0, fx, glowY, 16);
        g.addColorStop(0, `rgba(255,244,214,${0.95 * pulse})`);
        g.addColorStop(0.3, `rgba(255,170,60,${0.7 * pulse})`);
        g.addColorStop(1, 'rgba(255,120,30,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(fx, glowY, 16, 10, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // Drawn right after the torso fill (so it sits under the arms), before the
  // head accessory and head itself.
  function drawTorsoCostume(ctx, id, hipY, shoulderY, color, accent, transformed) {
    const midY = (hipY + shoulderY) / 2;
    switch (id) {
      case 'artur': { // sleeveless athletic vest
        ctx.fillStyle = shadeColor(color, -18);
        ctx.beginPath();
        ctx.moveTo(-11, shoulderY + 4);
        ctx.lineTo(11, shoulderY + 4);
        ctx.lineTo(9, hipY - 3);
        ctx.lineTo(-9, hipY - 3);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'carlos': { // angular chest-plate accent
        ctx.strokeStyle = accent;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-10, shoulderY + 6);
        ctx.lineTo(0, midY + 2);
        ctx.lineTo(10, shoulderY + 6);
        ctx.stroke();
        break;
      }
      case 'nathan': { // ribbed stretchy-rubber texture lines
        ctx.strokeStyle = shadeColor(color, -25);
        ctx.lineWidth = 2;
        for (let t = 0.28; t < 1; t += 0.28) {
          const y = shoulderY + (hipY - shoulderY) * t;
          ctx.beginPath();
          ctx.moveTo(-8, y);
          ctx.lineTo(8, y);
          ctx.stroke();
        }
        break;
      }
      case 'owen': { // tech collar with a glowing plasma core
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(-9, shoulderY + 5);
        ctx.lineTo(0, shoulderY + 15);
        ctx.lineTo(9, shoulderY + 5);
        ctx.stroke();
        ctx.save();
        ctx.globalAlpha = 0.7 + Math.sin(performance.now() / 100) * 0.3;
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(0, midY, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        break;
      }
      case 'robert': { // tank top; hem rips jagged once transformed
        ctx.fillStyle = shadeColor(color, transformed ? 20 : -15);
        ctx.beginPath();
        ctx.moveTo(-12, shoulderY + 3);
        ctx.lineTo(12, shoulderY + 3);
        if (transformed) {
          ctx.lineTo(9, hipY - 11);
          ctx.lineTo(5, hipY - 3);
          ctx.lineTo(1, hipY - 12);
          ctx.lineTo(-3, hipY - 3);
          ctx.lineTo(-7, hipY - 11);
          ctx.lineTo(-10, hipY - 3);
        } else {
          ctx.lineTo(10, hipY - 6);
          ctx.lineTo(-10, hipY - 6);
        }
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'ryan': { // open performer jacket collar + a little music note
        ctx.strokeStyle = shadeColor(color, -20);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-10, shoulderY + 4);
        ctx.lineTo(-2, shoulderY + 17);
        ctx.moveTo(10, shoulderY + 4);
        ctx.lineTo(2, shoulderY + 17);
        ctx.stroke();
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(2, midY + 7, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(4.3, midY - 6, 1.6, 13);
        break;
      }
      case 'sam': { // wetsuit diagonal stripe
        ctx.strokeStyle = accent;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(-9, shoulderY + 6);
        ctx.lineTo(8, hipY - 4);
        ctx.stroke();
        break;
      }
      case 'john': { // suspender straps over a broad frame
        ctx.strokeStyle = shadeColor(color, -25);
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        ctx.moveTo(-8, shoulderY + 2);
        ctx.lineTo(-6, hipY);
        ctx.moveTo(8, shoulderY + 2);
        ctx.lineTo(6, hipY);
        ctx.stroke();
        break;
      }
      default:
        break;
    }
  }

  // Drawn immediately before the head, so it naturally sits behind it.
  function drawHeadAccessory(ctx, id, headY, headR, color) {
    if (id === 'keenan') {
      ctx.fillStyle = shadeColor(color, -35);
      ctx.beginPath();
      ctx.moveTo(-headR * 1.15, headY - headR * 0.25);
      ctx.quadraticCurveTo(0, headY - headR * 2.05, headR * 1.15, headY - headR * 0.25);
      ctx.quadraticCurveTo(headR * 0.9, headY + headR * 0.65, 0, headY + headR * 0.8);
      ctx.quadraticCurveTo(-headR * 0.9, headY + headR * 0.65, -headR * 1.15, headY - headR * 0.25);
      ctx.closePath();
      ctx.fill();
    }
  }

  // ---- Procedural fighter body ----
  // All motion comes from the rig Animator.update() built for this frame;
  // this only turns those joint targets into body parts. Drawn facing right
  // (drawFighter mirrors for left): back arm and leg first, then the hips,
  // front leg, torso, head, and the front (striking) arm on top.
  //
  // Proportions are fighting-game heroic: about six heads tall, broad sloped
  // shoulders, narrow waist, long legs. Outfit: sleeveless gi top with a V
  // neck, sash, loose trousers tucked into wrapped shins, boots, taped fists.
  const DEFAULT_SKIN = '#d9a07a';
  // Default heights, in body heights from the floor: legs (hip joints at
  // LEG + ANKLE), torso on top. Leg and torso length settings scale these.
  const LEG = 0.48, ANKLE = 0.025, TORSO = 0.29;

  // Body measurements in game pixels, for a character at height H. Shared by
  // the game and by the part templates (partSpec) so they always agree.
  function bodyDims(id, H, transformed) {
    const profile = getBodyProfile(id);
    const bulk = transformed ? 1.18 : 1;
    const legBulk = profile.legBulk * bulk, armBulk = profile.armBulk * bulk;
    return {
      H, profile,
      // Torso build factors (the torso is drawn turned three-quarters toward
      // the way the fighter faces; see torsoOutline).
      fs: profile.shoulders * bulk, fw: profile.waist * bulk, fh: profile.hips * bulk,
      sw: H * 0.1 * profile.shoulders * bulk,    // chest depth, front to back (costume scaling)
      pw: H * 0.085 * profile.hips * bulk,
      leg: { H, thigh: H * LEG * 0.51 * profile.legLength, shin: H * LEG * 0.49 * profile.legLength, bulk: legBulk, foot: H * 0.052 * profile.footScale },
      arm: { H, upper: H * 0.185 * profile.armScale, fore: H * 0.165 * profile.armScale, bulk: armBulk, fist: H * 0.036 * Math.max(0.92, armBulk * 0.85) * profile.handScale },
      headH: H * 0.23 * profile.headScale,
      neckR: H * 0.026 * Math.max(1, profile.shoulders * 0.95) * bulk * profile.neckWidth,
      neckLen: H * 0.05 * profile.neckLength,
      // Hip joints and the top of the shoulders, in body heights from the floor.
      hipFrac: LEG * profile.legLength + ANKLE,
      shoulderFrac: LEG * profile.legLength + ANKLE + TORSO * profile.torsoLength,
    };
  }

  // Joint pairs for the torso, neck and head of an upright body
  // (y up is negative, feet at 0). Shared by drawPlaceholder and partSpec.
  function torsoJoints(d, shoulderY, hipY) {
    const H = d.H;
    const chinY = shoulderY - d.neckLen;
    const headX = H * 0.018;
    return {
      torso: [{ x: 0, y: shoulderY - H * 0.03 }, { x: 0, y: hipY }],
      neck: [{ x: H * 0.004, y: shoulderY + H * 0.01 }, { x: headX * 0.8, y: chinY + H * 0.014 }],
      head: [{ x: headX, y: chinY }, { x: headX, y: chinY - d.headH }],
    };
  }

  // Template geometry for each drawable part of a character, in template
  // pixels (BodyArt.ART_SCALE per game pixel at the character's normal
  // size): canvas size w x h, and the two joint points `a` and `b` the part
  // hangs between. Limbs point down (a on top), fists and shoes point right
  // (a = wrist / ankle, b = knuckles / toe tip), head and neck point up (a at
  // the bottom). `rigid` parts (torso, neck, head) keep their width
  // when their joints move closer together (a crouch squashes the torso).
  function partSpec(id) {
    const char = CHARACTERS[id];
    const H = FIGHTER_HEIGHT * char.sizeScale;
    const d = bodyDims(id, H, false);
    const k = typeof BodyArt !== 'undefined' ? BodyArt.ART_SCALE : 3;
    const J = torsoJoints(d, -H * d.shoulderFrac, -H * d.hipFrac);
    const vert = (len, halfW, padTop, padBottom, up) => {
      const w = Math.ceil(halfW * 2 * k), h = Math.ceil((len + padTop + padBottom) * k);
      const top = { x: w / 2, y: padTop * k }, bottom = { x: w / 2, y: (padTop + len) * k };
      return up ? { w, h, a: bottom, b: top } : { w, h, a: top, b: bottom };
    };
    const horiz = (len, halfH, padBack, padFront, yFrac) => {
      const w = Math.ceil((len + padBack + padFront) * k), h = Math.ceil(halfH * 2 * k);
      return { w, h, a: { x: padBack * k, y: h * yFrac }, b: { x: (padBack + len) * k, y: h * yFrac } };
    };
    const len = (p) => Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
    const L = d.leg, A = d.arm;
    const armR = (s) => radiusAt(ARM_PROFILE, s) * H * A.bulk;
    const legR = (s) => radiusAt(LEG_PROFILE, s) * H * L.bulk * 1.04;
    return {
      H, dims: d,
      head: { ...vert(d.headH, d.headH * 0.6, d.headH * 0.12, d.headH * 0.08, true), rigid: true },
      neck: { ...vert(len(J.neck), d.neckR * 2.4, d.neckR, d.neckR * 0.6, true), rigid: true },
      torso: { ...vert(len(J.torso), H * 0.125 * Math.max(d.fs, d.fw), H * 0.06, H * 0.04), rigid: true },
      upperArm: vert(A.upper, armR(0) * 1.9, armR(0) * 1.3, armR(1) * 1.3),
      forearm: vert(A.fore, armR(1.25) * 2.1, armR(1) * 1.3, armR(2) * 1.6),
      fist: horiz(A.fist * 1.4, A.fist * 1.5, A.fist * 0.7, A.fist * 0.5, 0.5),
      thigh: vert(L.thigh, legR(0) * 1.8, legR(0) * 1.2, legR(1) * 1.3),
      shin: vert(L.shin, legR(1.3) * 2, legR(1) * 1.3, legR(2) * 1.6),
      shoe: horiz(L.foot * 1.4, L.foot * 1.25, L.foot * 0.9, L.foot * 0.6, 0.62),
    };
  }

  // Draw a hand-drawn part between game-space joints A and B, with the
  // template's joint points a and b landing on them; darkened/tinted as
  // needed. Returns false if there's no drawing, so the caller draws the
  // procedural part instead.
  function drawArtPart(ctx, id, part, A, B, H, shade, tint) {
    if (typeof BodyArt === 'undefined') return false;
    const img = BodyArt.get(id, part);
    if (!img) return false;
    const spec = partSpec(id)[part];
    const src = BodyArt.shaded(id, part, img, shade, tint);
    const imgW = img.naturalWidth || img.width;
    const artAng = Math.atan2(spec.b.y - spec.a.y, spec.b.x - spec.a.x);
    const artLen = Math.hypot(spec.b.x - spec.a.x, spec.b.y - spec.a.y) || 1;
    const gameAng = Math.atan2(B.y - A.y, B.x - A.x);
    const gameLen = Math.hypot(B.x - A.x, B.y - A.y);
    // Across the part: the character's current size (buffs/transforms grow
    // it). Along it: rigid parts stretch to their joints; limbs keep their
    // proportions (their bones never change length anyway).
    const across = (H / (FIGHTER_HEIGHT * CHARACTERS[id].sizeScale)) / BodyArt.ART_SCALE;
    const along = spec.rigid ? gameLen / artLen : across;
    ctx.save();
    ctx.translate(A.x, A.y);
    ctx.rotate(gameAng);
    ctx.scale(along, across);
    ctx.rotate(-artAng);
    ctx.translate(-spec.a.x, -spec.a.y);
    // A drawing saved at a different resolution than its template still
    // lines up, as long as it keeps the template's proportions.
    const r = spec.w / imgW;
    ctx.scale(r, r);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
    return true;
  }

  function bodyColors(fighter, head, tint) {
    const skin = (head && head.skin) || DEFAULT_SKIN;
    const tinted = (c) => (tint ? mixColor(c, tint.color, tint.alpha) : c);
    const base = fighter.displayColor;
    return {
      shirt: tinted(mixColor(base, '#0c0910', 0.38)),   // tunic: deep version of their colour
      pants: tinted(mixColor(base, '#09070d', 0.8)),    // near-black trousers
      trim: tinted(shadeColor(base, 12)),               // their colour, bright, as trim
      sash: tinted(LEATHER),
      leather: tinted(LEATHER),
      glove: tinted(GLOVE),
      boot: tinted(BOOT),
      wrap: tinted(WRAP),
      skin: tinted(skin),
      accent: tinted(fighter.displayAccent),
    };
  }

  // Art-or-procedural helper for one side of the body (shade 0 = near side).
  function partPainter(ctx, id, H, shade, tint) {
    return {
      has: (part) => typeof BodyArt !== 'undefined' && !!BodyArt.get(id, part),
      draw: (part, A, B, fallback) => { if (!drawArtPart(ctx, id, part, A, B, H, shade, tint)) fallback(); },
    };
  }

  function drawPlaceholder(ctx, fighter, rig, tint) {
    const id = fighter.character.id;
    const H = fighter.height;
    const d = bodyDims(id, H, fighter.transformed);
    const profile = d.profile;
    // (getInfo may be missing if the browser still has an older cached
    // characterHeads.js; never let that stop the fighter being drawn.)
    // Transforming characters can swap to their own head (Robert).
    const headId = CharacterHeads.variantFor ? CharacterHeads.variantFor(id, fighter.transformed) : id;
    const head = CharacterHeads.getInfo ? CharacterHeads.getInfo(headId) : null;

    const colors = bodyColors(fighter, head, tint);
    const accent = colors.accent;
    // The far limbs sit in shadow, which is what sells the depth.
    const back = {
      ...colors, pants: shadeColor(colors.pants, -25), boot: shadeColor(colors.boot, -15),
      skin: shadeColor(colors.skin, -14), wrap: shadeColor(colors.wrap, -16),
    };
    const near = partPainter(ctx, id, H, 0, tint), far = partPainter(ctx, id, H, 0.24, tint);

    // Skeleton, in body heights (H) from the floor. Crouching lowers the hips
    // and the legs fold to meet the floor.
    const crouchScale = 1 - rig.crouch;
    const floatY = rig.float;
    const hipY = -H * d.hipFrac * crouchScale + floatY;
    // Mocap clips move the hips but keep the torso its full length (a body
    // lying down isn't squashed); the built-in animation shrinks both.
    const shoulderY = rig.rigidTorso ? hipY - H * (d.shoulderFrac - d.hipFrac) : -H * d.shoulderFrac * crouchScale + floatY;
    const J = torsoJoints(d, shoulderY, hipY);

    // A mocap move can shift the body forward and back (a step into a punch).
    ctx.save();
    ctx.translate(rig.rootX || 0, 0);

    drawBackAccessory(ctx, id, floatY);

    // Legs are placed before the torso lean is applied, so an attack's
    // forward lean pivots at the hip without warping them.
    // Side-on hips: the far leg starts just behind the near one.
    const hipBack = rig.hips ? { x: rig.hips[0].x, y: hipY + rig.hips[0].y } : { x: -H * 0.022 * d.fh, y: hipY };
    const hipFront = rig.hips ? { x: rig.hips[1].x, y: hipY + rig.hips[1].y } : { x: H * 0.026 * d.fh, y: hipY };
    // Smear trails live on the fighter's visual state between frames.
    const vis = fighter._visualPose || {};
    const trails = vis.trails || (vis.trails = [[], [], [], []]);
    const footOf = (f, knee, angle, i) => ({ x: f.x, y: floatY + f.y, hint: knee ? { x: knee.x, y: floatY + knee.y } : null, angle, trail: trails[2 + i], smear: rig.smear === 'leg' + i });
    const fa = rig.footAngles || [null, null];

    // Upper body, leaned from the hip.
    const lean = (fn) => {
      ctx.save();
      ctx.translate(0, hipY);
      ctx.rotate(rig.lean * Math.PI / 180);
      ctx.translate(0, -hipY);
      fn();
      ctx.restore();
    };
    const shY = shoulderY + H * 0.03;
    // Three-quarter view: the near shoulder is at the top front of the
    // chest, the far one tucked behind the upper back.
    // (A mocap clip moves them: the shoulder driving a punch forward.)
    const shoulderFront = rig.sh ? { x: rig.sh[1].x, y: shoulderY + rig.sh[1].y } : { x: H * 0.052 * d.fs, y: shY + H * 0.004 };
    const shoulderBack = rig.sh ? { x: rig.sh[0].x, y: shoulderY + rig.sh[0].y } : { x: -H * 0.042 * d.fs, y: shY - H * 0.006 };
    // The rig gives hand targets relative to a single shoulder point at x=0.
    const handOf = (a, i) => ({ x: a.x, y: shY + a.y, hint: a.ex !== undefined ? { x: a.ex, y: shY + a.ey } : null, trail: trails[i], smear: rig.smear === 'arm' + i, stretch: a.stretch });
    const [armBack, armFront] = rig.arms;

    lean(() => drawArm(ctx, shoulderBack, handOf(armBack, 0), d.arm, back, profile, armBack.orb, accent, far, 'upper'));
    drawLeg(ctx, hipBack, footOf(rig.fA, rig.knees && rig.knees[0], fa[0], 0), 0, d.leg, back, far);
    drawLeg(ctx, hipFront, footOf(rig.fB, rig.knees && rig.knees[1], fa[1], 1), rig.footPoint, d.leg, colors, near);

    lean(() => near.draw('neck', J.neck[0], J.neck[1], () => partNeck(ctx, J.neck[0], J.neck[1], d, colors)));
    lean(() => near.draw('torso', J.torso[0], J.torso[1], () => {
      partTorso(ctx, d, shoulderY, hipY, colors);
      torsoCostume(ctx, d, id, shoulderY, hipY, colors, fighter.transformed);
      // Tabard hangs straight down (undo the lean) and trails the movement.
      const sway = Math.max(-0.45, Math.min(0.45, -fighter.vx * 0.035 - rig.lean * Math.PI / 180 * 0.8));
      partSash(ctx, d, hipY, colors, sway);
    }));

    // The far arm's forearm and fist come across the front of the body.
    lean(() => drawArm(ctx, shoulderBack, handOf(armBack, 0), d.arm, back, profile, armBack.orb, accent, far, 'lower'));

    const drawHead = () => lean(() => {
      // Head tilt (mocap), pivoting at the chin.
      if (rig.headTilt) {
        ctx.translate(J.head[0].x, J.head[0].y);
        ctx.rotate((rig.headTilt * Math.PI) / 180);
        ctx.translate(-J.head[0].x, -J.head[0].y);
      }
      near.draw('head', J.head[0], J.head[1], () => partHead(ctx, headId, J.head[0], d, colors, head));
    });
    const drawFrontArm = () => lean(() => drawArm(ctx, shoulderFront, handOf(armFront, 1), d.arm, colors, profile, armFront.orb, accent, near));
    // The front arm normally crosses in front of the head (a jab at face
    // height); raised overhead, it goes behind so it doesn't cover the face.
    if (handOf(armFront, 1).y < shoulderY - H * 0.08) { drawFrontArm(); drawHead(); } else { drawHead(); drawFrontArm(); }
    ctx.restore();
  }

  // Torso, three-quarters on and facing right: a real side silhouette --
  // chest and pecs along the front, trapezius, shoulder blade, lats and the
  // curve of the lower back along the back -- rather than a flat front view,
  // so it matches the side-on legs and arms. Points in body heights.
  function torsoOutline(d, sY, hipY) {
    const { H, fs, fw, fh } = d;
    const waistY = sY + (hipY - sY) * 0.7;
    const p = (x, y) => ({ x: x * H, y });
    return {
      waistY,
      front: [
        p(0.028, sY - H * 0.03),                 // front of the neck
        p(0.07 * fs, sY - H * 0.004),            // collarbone to the front delt
        p(0.098 * fs, sY + H * 0.045),           // top of the chest
        p(0.104 * fs, sY + H * 0.08),            // pec
        p(0.088 * fs, sY + H * 0.115),           // under the pec
        p(0.078 * fw, waistY),                   // stomach
        p(0.084 * fh, hipY - H * 0.005),         // front of the hip
        p(0.08 * fh, hipY + H * 0.02),
      ],
      back: [
        p(-0.02, sY - H * 0.04),                 // back of the neck
        p(-0.07 * fs, sY - H * 0.008),           // trapezius
        p(-0.1 * fs, sY + H * 0.045),            // shoulder blade
        p(-0.094 * fs, sY + H * 0.105),          // upper back
        p(-0.068 * fw, waistY),                  // lower back curves in
        p(-0.088 * fh, hipY - H * 0.005),        // glute
        p(-0.084 * fh, hipY + H * 0.02),
      ],
    };
  }

  function torsoPath(ctx, d, shoulderY, hipY) {
    const o = torsoOutline(d, shoulderY, hipY);
    const back = o.back.slice().reverse();
    ctx.beginPath();
    smoothThrough(ctx, o.front, true);
    smoothThrough(ctx, back, false);
    ctx.closePath();
    return o;
  }

  function partTorso(ctx, d, shoulderY, hipY, colors) {
    const { H, fs } = d;
    const o = torsoPath(ctx, d, shoulderY, hipY);
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    // Lit from the front and above: the back of the body falls into shadow.
    const g = ctx.createLinearGradient(-0.1 * H * fs, shoulderY + H * 0.1, 0.1 * H * fs, shoulderY);
    g.addColorStop(0, shadeColor(colors.shirt, -45));
    g.addColorStop(0.45, shadeColor(colors.shirt, -12));
    g.addColorStop(0.8, shadeColor(colors.shirt, 12));
    g.addColorStop(1, shadeColor(colors.shirt, 28));
    ctx.fillStyle = g;
    ctx.fill();
    // Rim light down the back.
    ctx.save();
    ctx.globalAlpha *= 0.3;
    ctx.strokeStyle = RIM;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    smoothThrough(ctx, o.back.slice(1, 5).map((p) => ({ x: p.x + H * 0.004, y: p.y })), true);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    torsoPath(ctx, d, shoulderY, hipY);
    ctx.clip();
    // Crossover gi lapel: a diagonal from behind the neck down to the front
    // of the chest, with the chest showing in front of it.
    const lapTop = { x: -H * 0.012, y: shoulderY - H * 0.04 };
    const lapBottom = { x: H * 0.078 * fs, y: shoulderY + H * 0.135 };
    ctx.beginPath();
    ctx.moveTo(lapTop.x, lapTop.y);
    ctx.lineTo(H * 0.2, shoulderY - H * 0.06);
    ctx.lineTo(H * 0.2, lapBottom.y);
    ctx.lineTo(lapBottom.x, lapBottom.y);
    ctx.closePath();
    const sk = ctx.createLinearGradient(0, 0, H * 0.1 * fs, 0);
    sk.addColorStop(0, shadeColor(colors.skin, -22));
    sk.addColorStop(1, shadeColor(colors.skin, 8));
    ctx.fillStyle = sk;
    ctx.fill();
    // Pec shadow under the chest.
    ctx.strokeStyle = shadeColor(colors.skin, -40);
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(H * 0.05 * fs, shoulderY + H * 0.1);
    ctx.quadraticCurveTo(H * 0.085 * fs, shoulderY + H * 0.112, H * 0.1 * fs, shoulderY + H * 0.095);
    ctx.stroke();
    // The lapel band itself.
    ctx.lineCap = 'round';
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 5.2;
    ctx.beginPath(); ctx.moveTo(lapTop.x, lapTop.y); ctx.lineTo(lapBottom.x, lapBottom.y); ctx.stroke();
    ctx.strokeStyle = colors.trim;
    ctx.lineWidth = 3.2;
    ctx.beginPath(); ctx.moveTo(lapTop.x, lapTop.y); ctx.lineTo(lapBottom.x, lapBottom.y); ctx.stroke();
    // Cloth folds pulled toward the sash.
    ctx.strokeStyle = shadeColor(colors.shirt, -32);
    ctx.lineWidth = 1.2;
    for (const [x0, x1] of [[-0.06, -0.035], [-0.02, 0.0], [0.03, 0.045]]) {
      ctx.beginPath();
      ctx.moveTo(H * x0 * fs, shoulderY + H * 0.14);
      ctx.quadraticCurveTo(H * (x0 + 0.01) * fs, o.waistY - H * 0.04, H * x1 * fs, o.waistY - H * 0.005);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Leather belt with a metal buckle, and the ninja tabard: a cloth panel
  // hanging from the belt to the knees, trimmed in the character's colour,
  // swinging a little with movement (`sway`, radians).
  function partSash(ctx, d, hipY, colors, sway = 0) {
    const { H } = d;
    const o = torsoOutline(d, hipY - (d.shoulderFrac - d.hipFrac) * H, hipY);
    const y = o.waistY - H * 0.012, h = H * 0.034;
    const xb = o.back[4].x - H * 0.006, xf = o.front[5].x + H * 0.006;

    // Tabard, hanging from under the front of the belt.
    const tx0 = H * 0.0, tx1 = xf - H * 0.004, top = y + h * 0.6;
    const len = H * 0.26;
    ctx.save();
    ctx.translate((tx0 + tx1) / 2, top);
    ctx.rotate(sway);
    const w0 = (tx1 - tx0) / 2, w1 = w0 * 1.15;
    const panel = () => {
      ctx.beginPath();
      ctx.moveTo(-w0, 0);
      ctx.lineTo(w0, 0);
      ctx.quadraticCurveTo(w1 * 1.05, len * 0.5, w1, len);
      ctx.lineTo(-w1, len);
      ctx.quadraticCurveTo(-w1 * 1.05, len * 0.5, -w0, 0);
      ctx.closePath();
    };
    panel();
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    const tg = ctx.createLinearGradient(-w1, 0, w1, len);
    tg.addColorStop(0, shadeColor(colors.shirt, -30));
    tg.addColorStop(0.6, shadeColor(colors.shirt, 4));
    tg.addColorStop(1, shadeColor(colors.shirt, -20));
    ctx.fillStyle = tg;
    ctx.fill();
    ctx.save();
    panel();
    ctx.clip();
    ctx.strokeStyle = colors.trim;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(-w0 + 2, 0); ctx.lineTo(-w1 + 2, len - 2); ctx.lineTo(w1 - 2, len - 2); ctx.lineTo(w0 - 2, 0);
    ctx.stroke();
    // An emblem in the trim colour.
    ctx.fillStyle = colors.trim;
    ctx.globalAlpha *= 0.85;
    ctx.beginPath();
    const ey = len * 0.35, er = Math.min(w0, len * 0.12);
    ctx.moveTo(0, ey - er); ctx.lineTo(er * 0.7, ey); ctx.lineTo(0, ey + er); ctx.lineTo(-er * 0.7, ey);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.restore();

    // Belt.
    ctx.beginPath();
    ctx.moveTo(xb, y + H * 0.004);
    ctx.lineTo(xf, y - H * 0.004);
    ctx.lineTo(xf + H * 0.002, y + h - H * 0.004);
    ctx.lineTo(xb, y + h + H * 0.004);
    ctx.closePath();
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    const g = ctx.createLinearGradient(xb, 0, xf, 0);
    g.addColorStop(0, shadeColor(colors.sash, -35));
    g.addColorStop(1, shadeColor(colors.sash, 18));
    ctx.fillStyle = g;
    ctx.fill();
    // Buckle.
    const bx = xf - H * 0.028, by = y - H * 0.002, bw = H * 0.03, bh = h + H * 0.004;
    ctx.fillStyle = METAL;
    ctx.fillRect(bx - bw / 2, by, bw, bh);
    ctx.fillStyle = shadeColor(colors.sash, -20);
    ctx.fillRect(bx - bw * 0.28, by + bh * 0.28, bw * 0.56, bh * 0.44);
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx - bw / 2, by, bw, bh);
  }

  // Per-character costume details, kept inside the torso's outline. (They
  // were designed on a ~12px-wide chest, so they're stretched to fit.)
  function torsoCostume(ctx, d, id, shoulderY, hipY, colors, transformed) {
    ctx.save();
    torsoPath(ctx, d, shoulderY, hipY);
    ctx.clip();
    ctx.scale(d.sw / 12, 1);
    drawTorsoCostume(ctx, id, hipY, shoulderY, colors.shirt, colors.accent, transformed);
    ctx.restore();
  }

  function partNeck(ctx, A, B, d, colors) {
    drawSegment(ctx, A.x, A.y, B.x, B.y, d.neckR, d.neckR * 0.92, colors.skin);
    // The chin casts a shadow down the neck.
    ctx.save();
    const g = ctx.createLinearGradient(B.x, B.y, A.x, A.y);
    g.addColorStop(0, 'rgba(20,8,10,0.55)');
    g.addColorStop(0.6, 'rgba(20,8,10,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(B.x, B.y, d.neckR * 1.05, 0, Math.PI * 2);
    ctx.rect(Math.min(A.x, B.x) - d.neckR, Math.min(A.y, B.y), d.neckR * 2 + Math.abs(A.x - B.x), Math.abs(A.y - B.y));
    ctx.fill();
    ctx.restore();
  }

  // The head: the character's cut-out photo with its chin at `chin`, or a
  // plain drawn head until there is one.
  function partHead(ctx, id, chin, d, colors, info) {
    const img = CharacterHeads.getImage(id);
    const headH = d.headH;
    if (img && info) {
      const bx = info.box;
      const dw = bx.w * (headH / bx.h);
      ctx.save();
      ctx.translate(chin.x, 0);
      // Photos looking toward camera-left get one extra mirror so the gaze
      // follows the body's facing (see HEAD_FLIP_FIX).
      if (HEAD_FLIP_FIX.has(id.replace('-transformed', ''))) ctx.scale(-1, 1);
      ctx.shadowColor = 'rgba(6,3,12,0.85)';
      ctx.shadowBlur = Math.max(2, headH * 0.05);
      ctx.drawImage(img, bx.x, bx.y, bx.w, bx.h, -dw / 2, chin.y - headH, dw, headH);
      ctx.restore();
      return;
    }
    // Hair/hood shapes were made for the plain drawn head.
    drawHeadAccessory(ctx, id, chin.y - headH * 0.5, headH * 0.5, colors.shirt);
    ctx.beginPath();
    ctx.ellipse(chin.x, chin.y - headH * 0.48, headH * 0.36, headH * 0.47, 0, 0, Math.PI * 2);
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    ctx.fillStyle = colors.skin;
    ctx.fill();
  }

  // A part template's guide: the current procedural part, drawn at template
  // scale with its joints on the template's joint points, for the Body Part
  // Studio to show faintly under the artist's drawing.
  function drawPartGuide(ctx, id, part, fighterLike) {
    const spec = partSpec(id);
    const d = spec.dims;
    const s = spec[part];
    const k = BodyArt.ART_SCALE;
    const info = CharacterHeads.getInfo ? CharacterHeads.getInfo(id) : null;
    const colors = bodyColors(fighterLike, info, null);
    const shoulderY = -d.H * d.shoulderFrac, hipY = -d.H * d.hipFrac;
    const J = torsoJoints(d, shoulderY, hipY);
    // Map game-space joints (A, B) onto the template's (a, b), then draw.
    const onto = (A, B, fn) => {
      const gameAng = Math.atan2(B.y - A.y, B.x - A.x);
      const artAng = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
      ctx.save();
      ctx.translate(s.a.x, s.a.y);
      ctx.rotate(artAng - gameAng);
      ctx.scale(k, k);
      ctx.translate(-A.x, -A.y);
      fn();
      ctx.restore();
    };
    // A straight limb hanging down, to cut single bones from.
    const straight = (dims, profile, l1, l2) => {
      const A = { x: 0, y: 0 }, B = { x: 0, y: l1 }, C = { x: 0, y: l1 + l2 };
      return { A, B, C, S: limbSamples(A, B, C, profile, d.H * dims.bulk) };
    };
    const arm = straight(d.arm, ARM_PROFILE, d.arm.upper, d.arm.fore);
    const leg = straight(d.leg, LEG_PROFILE, d.leg.thigh, d.leg.shin);
    const flatSeg = (len) => [{ x: 0, y: 0 }, { x: len, y: 0 }];
    switch (part) {
      case 'torso':
        return onto(J.torso[0], J.torso[1], () => {
          partTorso(ctx, d, shoulderY, hipY, colors);
          torsoCostume(ctx, d, id, shoulderY, hipY, colors, false);
          partSash(ctx, d, hipY, colors);
        });
      case 'neck': return onto(J.neck[0], J.neck[1], () => partNeck(ctx, J.neck[0], J.neck[1], d, colors));
      case 'head': return onto(J.head[0], J.head[1], () => partHead(ctx, id, J.head[0], d, colors, info));
      case 'upperArm': return onto(arm.A, arm.B, () => { const lit = paintLimb(ctx, arm.S, 0, 1, true, true, colors.skin); armDefinition(ctx, arm.S, colors.skin, lit); });
      case 'forearm': return onto(arm.B, arm.C, () => { paintLimb(ctx, arm.S, 1, 2, true, true, colors.skin); bracer(ctx, arm.S, 1.42, 1.95, colors); });
      case 'fist': { const [A, B] = flatSeg(d.arm.fist * 1.4); return onto(A, B, () => partFistAt(ctx, A, B, d.arm.fist, colors, d.profile, colors.accent)); }
      case 'thigh': return onto(leg.A, leg.B, () => paintLimb(ctx, leg.S, 0, 1, true, true, colors.pants, 1.04));
      case 'shin': return onto(leg.B, leg.C, () => legShin(ctx, leg.S, colors, true));
      case 'shoe': { const [A, B] = flatSeg(d.leg.foot * 1.4); return onto(A, B, () => partShoeAt(ctx, A, B, d.leg.foot, colors)); }
      default: return undefined;
    }
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

  // A small coloured pill ("P1", "YOU"). `x` is the left edge, or the right
  // edge when alignRight; returns the pill's width so chips can be chained.
  function drawSlotChip(ctx, x, cy, text, color, alignRight) {
    ctx.save();
    ctx.font = 'bold 13px sans-serif';
    const w = ctx.measureText(text).width + 14, h = 19;
    const left = alignRight ? x - w : x;
    roundRectPath(ctx, left, cy - h / 2, w, h, 9);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + w / 2, cy + 1);
    ctx.restore();
    return w;
  }

  function drawHUD(ctx, p1, p2) {
    const barW = 380;
    const barH = 26;
    const margin = 30;
    const gaugeW = 160;
    const online = typeof Net !== 'undefined' && Net.isOnline();
    const local = online ? Net.localSlot() : null;
    const labels1 = Net.controlLabelsFor('p1'), labels2 = Net.controlLabelsFor('p2');

    drawHealthBar(ctx, margin, 30, barW, barH, p1.hp, p1.maxHp, false);
    drawHealthBar(ctx, CANVAS_WIDTH - margin - barW, 30, barW, barH, p2.hp, p2.maxHp, true);
    // Side colour strip along the top of each bar.
    ctx.fillStyle = PLAYER_COLORS.p1;
    ctx.fillRect(margin, 26, barW, 3);
    ctx.fillStyle = PLAYER_COLORS.p2;
    ctx.fillRect(CANVAS_WIDTH - margin - barW, 26, barW, 3);

    drawSpecialGauge(ctx, margin, 60, gaugeW, 8, p1.specialCooldownTimer, p1.character.special.cooldown, false);
    drawSpecialGauge(ctx, CANVAS_WIDTH - margin - gaugeW, 60, gaugeW, 8, p2.specialCooldownTimer, p2.character.special.cooldown, true);
    if (labels1) drawKeyBadge(ctx, margin + gaugeW + 8, 64, keyLabel(labels1.special), false);
    if (labels2) drawKeyBadge(ctx, CANVAS_WIDTH - margin - gaugeW - 8, 64, keyLabel(labels2.special), true);

    drawUltGauge(ctx, margin, 74, gaugeW, 10, p1.ultCharge, false);
    drawUltGauge(ctx, CANVAS_WIDTH - margin - gaugeW, 74, gaugeW, 10, p2.ultCharge, true);
    if (labels1) drawKeyBadge(ctx, margin + gaugeW + 8, 79, keyLabel(labels1.ultimate), false);
    if (labels2) drawKeyBadge(ctx, CANVAS_WIDTH - margin - gaugeW - 8, 79, keyLabel(labels2.ultimate), true);

    drawRoundPips(ctx, margin, 99, p1.roundsWon, false);
    drawRoundPips(ctx, CANVAS_WIDTH - margin, 99, p2.roundsWon, true);

    // Name plates: name, then a P1/P2 chip in the side colour, then "YOU"
    // on the local player's plate when playing online.
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px sans-serif';
    ctx.textBaseline = 'top';
    const name1 = p1.character.name + (p1.transformed ? ' – TRANSFORMED' : '');
    const name2 = p2.character.name + (p2.transformed ? ' – TRANSFORMED' : '');
    ctx.textAlign = 'left';
    ctx.fillText(name1, margin, 3);
    const w1 = ctx.measureText(name1).width;
    ctx.textAlign = 'right';
    ctx.fillText(name2, CANVAS_WIDTH - margin, 3);
    const w2 = ctx.measureText(name2).width;
    ctx.textAlign = 'left';
    let cx = margin + w1 + 10;
    cx += drawSlotChip(ctx, cx, 15, 'P1', PLAYER_COLORS.p1, false) + 6;
    if (local === 'p1') drawSlotChip(ctx, cx, 15, 'YOU', '#2c2c3a', false);
    cx = CANVAS_WIDTH - margin - w2 - 10;
    cx -= drawSlotChip(ctx, cx, 15, 'P2', PLAYER_COLORS.p2, true) + 6;
    if (local === 'p2') drawSlotChip(ctx, cx, 15, 'YOU', '#2c2c3a', true);
    ctx.textAlign = 'left';
  }

  // Floating tag above a fighter (Smash-style): a pill in the side colour,
  // with "YOU" over it for the local player online. Stays readable when both
  // fighters are the same character.
  function drawPlayerMarker(ctx, fighter) {
    const color = PLAYER_COLORS[fighter.slot];
    const you = typeof Net !== 'undefined' && Net.isOnline() && Net.localSlot() === fighter.slot;
    const cx = fighter.x;
    const y = Math.max(140, fighter.y - fighter.height - (fighter.blocking ? 68 : 48));
    const w = 36, h = 19;
    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.moveTo(cx - 6, y + h / 2 - 1);
    ctx.lineTo(cx + 6, y + h / 2 - 1);
    ctx.lineTo(cx, y + h / 2 + 8);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    roundRectPath(ctx, cx - w / 2, y - h / 2, w, h, 9);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(fighter.slot === 'p1' ? 'P1' : 'P2', cx, y + 1);
    if (you) {
      ctx.font = 'bold 12px sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText('YOU', cx, y - h / 2 - 8);
      ctx.fillStyle = '#fff';
      ctx.fillText('YOU', cx, y - h / 2 - 8);
    }
    ctx.restore();
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
    buildBackdropCanvas,
    drawFighter,
    partSpec,
    drawPartGuide,
    bodyProfile: getBodyProfile,
    bodyDims,
    drawPlayerMarker,
    drawProjectiles,
    drawHUD,
    drawTimer,
    drawCenteredMessage,
  };
})();
