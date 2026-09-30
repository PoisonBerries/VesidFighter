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

  function fillCapsule(ctx, x1, y1, x2, y2, r1, r2, fillStyle) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const perp = angle + Math.PI / 2;
    const cos = Math.cos(perp), sin = Math.sin(perp);
    ctx.beginPath();
    ctx.moveTo(x1 + cos * r1, y1 + sin * r1);
    ctx.lineTo(x2 + cos * r2, y2 + sin * r2);
    ctx.arc(x2, y2, r2, perp, perp + Math.PI, false);
    ctx.lineTo(x1 - cos * r1, y1 - sin * r1);
    ctx.arc(x1, y1, r1, perp + Math.PI, perp + Math.PI * 2, false);
    ctx.closePath();
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    ctx.fillStyle = bodyGradient(ctx, mx, my, cos, sin, Math.max(r1, r2), fillStyle);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }

  function fillJoint(ctx, x, y, r, fillStyle) {
    const grad = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    grad.addColorStop(0, shadeColor(fillStyle, 24));
    grad.addColorStop(1, shadeColor(fillStyle, -16));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  // Hip -> knee -> foot with a two-bone solve: both bones keep the same
  // fixed length, and the knee bends forward (or up, for a kick) by however
  // much the hip-to-foot distance requires. That's what keeps legs from
  // stretching and squashing as feet lift, plant and kick.
  // pointAmt (0-1) aims the foot along the shin (a kick) instead of flat
  // on the ground; a lifted foot also tips toe-down.
  function drawLeg(ctx, hipX, hipY, footX, footY, legLen, thickness, color, footColor, pointAmt) {
    let dx = footX - hipX, dy = footY - hipY;
    let d = Math.hypot(dx, dy) || 0.001;
    const maxD = legLen * 2 * 0.999;
    if (d > maxD) {
      dx *= maxD / d; dy *= maxD / d;
      footX = hipX + dx; footY = hipY + dy;
      d = maxD;
    }
    const bend = Math.sqrt(Math.max(0, legLen * legLen - (d / 2) * (d / 2)));
    const kneeX = hipX + dx / 2 + (dy / d) * bend;
    const kneeY = hipY + dy / 2 - (dx / d) * bend;
    const rHip = thickness * 0.66, rKnee = thickness * 0.48, rFoot = thickness * 0.4;
    fillCapsule(ctx, hipX, hipY, kneeX, kneeY, rHip, rKnee, color);
    fillCapsule(ctx, kneeX, kneeY, footX, footY, rKnee, rFoot, footColor);
    fillJoint(ctx, kneeX, kneeY, rKnee * 0.92, color);
    const lifted = Math.min(1, Math.max(0, -footY / 25));
    const shinAngle = Math.atan2(footY - kneeY, footX - kneeX);
    const flat = 0.15 + lifted * 0.55;
    const angle = flat + (shinAngle - flat) * (pointAmt || 0);
    ctx.save();
    ctx.translate(footX + rFoot * 0.5, footY + 1);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.ellipse(0, 0, rFoot * 1.5, rFoot * 0.72, 0, 0, Math.PI * 2);
    ctx.fillStyle = footColor;
    ctx.fill();
    ctx.restore();
  }

  // Shoulder -> elbow -> hand, elbow offset perpendicular to the
  // shoulder-hand line by `bend` (sign controls which way it bends).
  function drawArm(ctx, shX, shY, handX, handY, bend, thickness, color, sleeveColor) {
    const mx = (shX + handX) / 2, my = (shY + handY) / 2;
    const dx = handX - shX, dy = handY - shY;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len, py = dx / len;
    const elbowX = mx + px * bend, elbowY = my + py * bend;
    const rSh = thickness * 0.5, rEl = thickness * 0.37, rHand = thickness * 0.32;
    fillCapsule(ctx, shX, shY, elbowX, elbowY, rSh, rEl, color);
    fillCapsule(ctx, elbowX, elbowY, handX, handY, rEl, rHand, sleeveColor);
    fillJoint(ctx, elbowX, elbowY, rEl * 0.9, color);
  }

  // ---- Per-character build: differentiates silhouette/stance beyond just
  // sizeScale, so e.g. Carlos reads as a hovering claw-fighter and Robert
  // reads as stocky at a glance.
  const DEFAULT_BODY_PROFILE = { limbWidth: 1, headScale: 1, stanceMul: 1, idleCrouch: 0, floaty: false, clawHands: false, dancer: false, reachBoost: 0, staggerMul: 1 };
  const BODY_PROFILES = {
    keenan: { limbWidth: 0.82, headScale: 1.05, stanceMul: 0.9, staggerMul: 1.25 },
    artur: { limbWidth: 1.0, stanceMul: 1.3, idleCrouch: 0.14 }, // squat frog stance
    carlos: { limbWidth: 1.05, headScale: 0.95, floaty: true, clawHands: true, staggerMul: 0.85 },
    nathan: { limbWidth: 0.78, headScale: 0.95, reachBoost: 26, staggerMul: 1.2 }, // stretchy long reach
    owen: { limbWidth: 0.85, stanceMul: 0.95, staggerMul: 1.2 },
    robert: { limbWidth: 1.3, headScale: 0.95, stanceMul: 1.2, staggerMul: 0.6 },
    ryan: { limbWidth: 0.78, dancer: true, staggerMul: 1.3 },
    sam: { limbWidth: 0.85, headScale: 1.05, stanceMul: 0.85, staggerMul: 1.3 },
    john: { limbWidth: 1.4, headScale: 0.9, stanceMul: 1.3, staggerMul: 0.5 },
  };
  function getBodyProfile(id) {
    return { ...DEFAULT_BODY_PROFILE, ...(BODY_PROFILES[id] || {}) };
  }

  // Judgment call made by looking at each shipped head photo: Artur and
  // Owen are both clearly turned/gazing toward camera-left in their source
  // images; everyone else reads close enough to frontal that no correction
  // is needed. See the flip-math note where this is used, in drawPlaceholder.
  const HEAD_FLIP_FIX = new Set(['artur', 'owen']);

  // Fist for most characters; a small three-talon metal claw for Carlos
  // (his whole kit is "Iron Claw"), drawn in the accent color.
  function drawHand(ctx, x, y, profile, accent) {
    if (profile.clawHands) {
      ctx.save();
      const palmGrad = ctx.createRadialGradient(x - 2, y - 2, 1, x, y, 7);
      palmGrad.addColorStop(0, shadeColor(accent, 8));
      palmGrad.addColorStop(1, shadeColor(accent, -18));
      ctx.fillStyle = palmGrad;
      ctx.beginPath();
      ctx.arc(x, y, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 4.5;
      ctx.lineCap = 'round';
      for (const deg of [-20, 0, 20]) {
        const rad = deg * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(rad) * 17, y + Math.sin(rad) * 17 - 5);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 0.8;
      for (const deg of [-20, 0, 20]) {
        const rad = deg * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(rad) * 17, y + Math.sin(rad) * 17 - 5);
        ctx.stroke();
      }
      ctx.restore();
    } else {
      const grad = ctx.createRadialGradient(x - 3, y - 3, 1, x, y, 10.5);
      grad.addColorStop(0, shadeColor(accent, 24));
      grad.addColorStop(1, shadeColor(accent, -14));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, 10.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
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
      const pulse = 0.7 + Math.sin(performance.now() / 90) * 0.25;
      const glowY = floatY * 0.25; // just under his feet, above the ground line
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.fillStyle = '#ffb238';
      for (const fx of [-9, 9]) {
        ctx.beginPath();
        ctx.ellipse(fx, glowY, 11, 7, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = Math.min(1, pulse * 0.8);
      ctx.fillStyle = '#fff3d6';
      for (const fx of [-9, 9]) {
        ctx.beginPath();
        ctx.ellipse(fx, glowY, 5, 3.2, 0, 0, Math.PI * 2);
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
  // this only turns those numbers into shapes.
  function drawPlaceholder(ctx, fighter, rig, tint) {
    let color = fighter.displayColor;
    let accent = fighter.displayAccent;
    if (tint) {
      color = mixColor(color, tint.color, tint.alpha);
      accent = mixColor(accent, tint.color, tint.alpha);
    }
    const H = fighter.height;
    const profile = getBodyProfile(fighter.character.id);
    const id = fighter.character.id;
    const bulk = fighter.transformed ? 1.18 : 1;

    const crouchScale = 1 - rig.crouch;
    const floatY = rig.float;
    const hipY = -H * 0.38 * crouchScale + floatY;
    const shoulderY = -H * 0.72 * crouchScale + floatY;
    const headY = -H * 0.86 * crouchScale + floatY;
    const headR = H * 0.14 * profile.headScale;

    const limbThickness = 15 * profile.limbWidth * bulk;
    const sleeveColor = shadeColor(color, -22);
    const bootColor = shadeColor(color, -30);
    const legLen = H * 0.2; // fixed bone length: legs bend instead of stretching
    const leg = (foot, point) => {
      const hipX = Math.max(-7, Math.min(7, foot.x * 0.3));
      drawLeg(ctx, hipX, hipY, foot.x, floatY + foot.y, legLen, limbThickness, color, bootColor, point);
    };

    drawBackAccessory(ctx, id, floatY);

    // Legs are drawn before the torso lean is applied, so an attack's
    // forward lean pivots from the hip without warping them.
    leg(rig.fA, 0);
    leg(rig.fB, rig.footPoint);

    ctx.save();
    ctx.translate(0, hipY);
    ctx.rotate(rig.lean * Math.PI / 180);
    ctx.translate(0, -hipY);

    // Torso -- a filled body with a natural waist taper instead of a rigid
    // straight-sided trapezoid, shaded like the limbs for consistent volume.
    // Shoulders are kept at least as wide as the head so it reads as "head
    // sits on shoulders" rather than a big head balanced on a narrow body.
    const shoulderW = Math.max(limbThickness * 0.62, headR * 0.95), hipW = limbThickness * 0.5;
    const waistY = shoulderY + (hipY - shoulderY) * 0.58;
    const waistW = Math.min(shoulderW, hipW) * 0.82;
    ctx.beginPath();
    ctx.moveTo(-shoulderW, shoulderY);
    ctx.lineTo(shoulderW, shoulderY);
    ctx.quadraticCurveTo(shoulderW * 0.92, waistY, waistW, waistY);
    ctx.quadraticCurveTo(hipW * 1.06, waistY, hipW, hipY);
    ctx.lineTo(-hipW, hipY);
    ctx.quadraticCurveTo(-hipW * 1.06, waistY, -waistW, waistY);
    ctx.quadraticCurveTo(-shoulderW * 0.92, waistY, -shoulderW, shoulderY);
    ctx.closePath();
    ctx.fillStyle = bodyGradient(ctx, 0, (shoulderY + hipY) / 2, 1, 0, shoulderW, color);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Neck -- bridges up into the underside of the head (drawn later, on
    // top, so it naturally tucks under the chin) instead of leaving the
    // head looking like it's floating just above the shoulders.
    const neckW = headR * 0.4;
    ctx.beginPath();
    ctx.moveTo(-neckW, headY + headR * 0.5);
    ctx.lineTo(neckW, headY + headR * 0.5);
    ctx.lineTo(neckW * 1.35, shoulderY + 3);
    ctx.lineTo(-neckW * 1.35, shoulderY + 3);
    ctx.closePath();
    ctx.fillStyle = shadeColor(color, -12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    drawTorsoCostume(ctx, id, hipY, shoulderY, color, accent, fighter.transformed);

    // Arms: back arm first, then the front/striking arm. Hands and the
    // charge orb fade with their blend weights so they never pop in.
    const shY = shoulderY + 6;
    for (const a of rig.arms) {
      const hx = a.x, hy = shY + a.y;
      drawArm(ctx, 0, shY, hx, hy, a.bend, limbThickness, color, sleeveColor);
      if (a.hand > 0.02) {
        ctx.save();
        ctx.globalAlpha *= Math.min(1, a.hand);
        drawHand(ctx, hx, hy, profile, accent);
        ctx.restore();
      }
      if (a.orb > 0.02) {
        ctx.save();
        ctx.globalAlpha *= Math.min(1, a.orb);
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(hx, hy, 7 * a.orb, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    drawHeadAccessory(ctx, id, headY, headR, color);

    // Head -- a real portrait if one's been shipped for this character,
    // otherwise the plain colored circle. The body's own facing flip
    // (applied once, up in drawFighter) makes a head that's naturally
    // gazing/turned toward camera-left in its source photo appear to look
    // backward exactly half the time; HEAD_FLIP_FIX corrects those specific
    // photos with one constant extra mirror so the gaze always tracks the
    // body's facing direction instead.
    const headImg = CharacterHeads.getImage(fighter.character.id);
    if (headImg) {
      if (HEAD_FLIP_FIX.has(fighter.character.id)) {
        ctx.save();
        ctx.scale(-1, 1);
        drawHeadImage(ctx, headImg, 0, headY, headR);
        ctx.restore();
      } else {
        drawHeadImage(ctx, headImg, 0, headY, headR);
      }
    } else {
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(0, headY, headR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
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
    drawPlayerMarker,
    drawProjectiles,
    drawHUD,
    drawTimer,
    drawCenteredMessage,
  };
})();
