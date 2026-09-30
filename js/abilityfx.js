// Visual effects for every special/ultimate: distinct projectiles, gas
// clouds, water splashes, claw slashes, shockwaves, shields, buff auras...
//
// Purely cosmetic and render-side. It reads the same synced fighter state the
// animator does (state, actionTimer, _ability, reflectTimer, ...) and never
// writes to the sim, so host, guest and local play all see identical effects.
//
//  - update(f):     called once per fighter per render; detects moments
//                   (windows opening, landings, shots fired) and queues timed
//                   effects / spawns particles.
//  - drawBack/Front: state-driven effects that follow a fighter while an
//                   ability runs (charging orbs, dive trails, shields...).
//  - drawTimed:     effects that outlive the ability that made them (gas
//                   clouds, splashes, explosions, slashes).
//  - drawProjectile: per-kind projectile art (plasma, soundwave).

const AbilityFX = (() => {
  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (t) => 1 - (1 - t) * (1 - t);
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeIn = (t) => t * t;
  const rnd = (a, b) => a + Math.random() * (b - a);

  const mems = new WeakMap(); // per-fighter transition memory (kept out of the synced fighter object)
  let timed = [];

  function reset() { timed = []; }

  function rgba(color, a) {
    let r, g, b;
    if (color[0] === '#') {
      const h = color.slice(1);
      r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    } else {
      [r, g, b] = color.match(/\d+/g).map(Number);
    }
    return `rgba(${r},${g},${b},${a})`;
  }

  // Soft radial glow with a white-hot centre.
  function glow(ctx, x, y, r, color, a) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba('#ffffff', a));
    g.addColorStop(0.3, rgba(color, a * 0.9));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }

  // Jagged lightning between two points: wide coloured pass + thin white core.
  function bolt(ctx, x1, y1, x2, y2, segs, jit, color, w) {
    const pts = [[x1, y1]];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    for (let i = 1; i < segs; i++) {
      const t = i / segs, o = (Math.random() * 2 - 1) * jit;
      pts.push([x1 + dx * t + nx * o, y1 + dy * t + ny * o]);
    }
    pts.push([x2, y2]);
    for (const [style, lw] of [[rgba(color, 0.55), w * 2.2], ['rgba(255,255,255,0.95)', w]]) {
      ctx.strokeStyle = style;
      ctx.lineWidth = lw;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    }
  }

  function defOf(f) {
    return f.state === 'special' ? f.character.special : f.state === 'ultimate' ? f.character.ultimate : null;
  }

  function add(e) {
    e.born = performance.now();
    timed.push(e);
  }

  // ---- Projectiles ----------------------------------------------------

  function drawProjectile(ctx, p) {
    const now = performance.now();
    const dir = p.vx >= 0 ? 1 : -1;
    if (p.kind === 'plasmaQuick') {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 1; i <= 7; i++) {
        const k = i / 7;
        glow(ctx, p.x - dir * i * 9, p.y + Math.sin(now / 45 + i) * 2.2, p.h * 0.6 * (1 - k * 0.7), p.color, 0.5 * (1 - k));
      }
      glow(ctx, p.x, p.y, p.h * 1.15, p.color, 0.95);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.w * 0.26, p.h * 0.26, 0, 0, TAU);
      ctx.fill();
      for (let k = 0; k < 3; k++) {
        const a = Math.random() * TAU, l = p.h * rnd(0.7, 1.3);
        bolt(ctx, p.x, p.y, p.x + Math.cos(a) * l, p.y + Math.sin(a) * l, 4, 4, p.color, 1.4);
      }
      ctx.restore();
      return true;
    }
    if (p.kind === 'plasmaCharged') {
      const R = p.h * 0.55;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 1; i <= 10; i++) {
        const k = i / 10;
        glow(ctx, p.x - dir * i * 13, p.y + Math.sin(now / 60 + i * 1.3) * 5, R * (1 - k * 0.65), '#b56bff', 0.55 * (1 - k));
      }
      glow(ctx, p.x, p.y, R * 2.6, '#b56bff', 0.55);
      glow(ctx, p.x, p.y, R * 1.5, p.color, 0.9);
      ctx.restore();
      ctx.save();
      ctx.translate(p.x, p.y);
      for (let k = 0; k < 3; k++) {
        ctx.save();
        ctx.rotate(now / 150 * (k % 2 ? 1 : -1) + k * 1.05);
        ctx.strokeStyle = k === 1 ? 'rgba(255,255,255,0.85)' : 'rgba(255,224,102,0.8)';
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.ellipse(0, 0, R * (1.05 + 0.12 * k), R * (0.42 + 0.1 * k), 0, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.85);
      core.addColorStop(0, '#ffffff');
      core.addColorStop(0.6, p.color);
      core.addColorStop(1, '#c9821a');
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.85, 0, TAU);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let k = 0; k < 5; k++) {
        const a = Math.random() * TAU, l = R * rnd(1.4, 2.3);
        bolt(ctx, p.x, p.y, p.x + Math.cos(a) * l, p.y + Math.sin(a) * l, 5, 6, '#b56bff', 1.8);
      }
      ctx.restore();
      return true;
    }
    if (p.kind === 'soundwave') {
      const pulse = 1 + Math.sin(now / 70) * 0.08;
      ctx.save();
      ctx.lineCap = 'round';
      for (let i = 0; i < 4; i++) {
        const x = p.x + dir * (i - 1.5) * p.w * 0.27;
        const r = p.h * (0.32 + i * 0.2) * pulse;
        const a = 0.35 + i * 0.22;
        ctx.lineWidth = 7 - i * 1.1;
        ctx.strokeStyle = i % 2 ? `rgba(255,255,255,${a})` : rgba(p.color, a);
        ctx.beginPath();
        const c = dir > 0 ? 0 : Math.PI;
        ctx.arc(x - dir * r * 0.55, p.y, r, c - 0.8, c + 0.8);
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.strokeStyle = `rgba(224,94,199,${a * 0.9})`;
        ctx.beginPath();
        ctx.arc(x - dir * r * 0.55, p.y, r + 6, c - 0.8, c + 0.8);
        ctx.stroke();
      }
      ctx.font = 'bold 22px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const notes = ['\u266A', '\u266B', '\u266C'];
      for (let k = 0; k < 3; k++) {
        const nx = p.x - dir * (p.w * 0.45 + k * 26);
        const ny = p.y + Math.sin(now / 130 + k * 2) * 16 - k * 3;
        ctx.fillStyle = `rgba(255,224,245,${0.9 - k * 0.25})`;
        ctx.fillText(notes[k], nx, ny);
      }
      ctx.restore();
      return true;
    }
    return false;
  }

  // ---- Timed effects ----------------------------------------------------

  function drawGas(ctx, e, t) {
    const fade = 1 - clamp((t - 0.55) / 0.45, 0, 1);
    for (const pf of e.puffs) {
      const lt = clamp((t - pf.delay) / 0.4, 0, 1);
      if (lt <= 0) continue;
      const k = easeOut(lt);
      const x = lerp(e.rx, e.cx + pf.ox, k) + Math.sin(t * 6 + pf.ph) * 4;
      const y = lerp(e.ry, e.cy + pf.oy, k) - t * 34 - pf.rise * t;
      const r = pf.r * (0.35 + 0.65 * k) * (1 + Math.sin(t * 9 + pf.ph) * 0.05);
      const a = Math.min(1, lt * 1.6) * fade * 0.66;
      const g = ctx.createRadialGradient(x - r * 0.25, y - r * 0.25, r * 0.1, x, y, r);
      g.addColorStop(0, `rgba(213,246,120,${a})`);
      g.addColorStop(0.55, `rgba(107,191,89,${a})`);
      g.addColorStop(1, `rgba(38,96,44,${a * 0.55})`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = `rgba(20,70,30,${a * 0.5})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    // Bubbles and stink lines rising out of the cloud.
    ctx.save();
    ctx.lineCap = 'round';
    for (const b of e.bubbles) {
      const bt = clamp((t - b.delay) / 0.5, 0, 1);
      if (bt <= 0 || bt >= 1) continue;
      ctx.fillStyle = `rgba(226,255,170,${(1 - bt) * 0.7 * fade})`;
      ctx.beginPath();
      ctx.arc(e.cx + b.ox + Math.sin(bt * 8 + b.ph) * 5, e.cy + b.oy - bt * 70, b.r * (1 - bt * 0.3), 0, TAU);
      ctx.fill();
    }
    ctx.strokeStyle = `rgba(150,215,90,${0.65 * fade})`;
    ctx.lineWidth = 3;
    for (let k = 0; k < 3; k++) {
      const x0 = e.cx + (k - 1) * e.w * 0.28;
      const y0 = e.cy - e.h * 0.55 - t * 20;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      for (let s = 1; s <= 6; s++) ctx.lineTo(x0 + Math.sin(t * 10 + k + s * 1.2) * 7, y0 - s * 8);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawSplash(ctx, e, t) {
    const R = e.big ? 210 : 135;
    ctx.save();
    if (e.ground) {
      for (let i = 0; i < 3; i++) {
        const tt = clamp((t - i * 0.1) / 0.75, 0, 1);
        if (tt <= 0 || tt >= 1) continue;
        const rx = R * easeOutCubic(tt);
        ctx.strokeStyle = `rgba(190,240,255,${(1 - tt) * 0.9})`;
        ctx.lineWidth = 5 * (1 - tt) + 1;
        ctx.beginPath();
        ctx.ellipse(e.x, e.y + 2, rx, rx * 0.16, 0, 0, TAU);
        ctx.stroke();
        ctx.fillStyle = `rgba(90,200,255,${(1 - tt) * 0.16})`;
        ctx.fill();
      }
    }
    // Water column.
    const colT = clamp(t / 0.55, 0, 1);
    if (colT < 1) {
      const h = (e.big ? 210 : 120) * Math.sin(colT * Math.PI) * (e.ground ? 1 : 0.5);
      const w = (e.big ? 46 : 30) * (0.5 + 0.5 * Math.sin(colT * Math.PI));
      if (h > 2) {
        const g = ctx.createLinearGradient(0, e.y - h, 0, e.y);
        g.addColorStop(0, 'rgba(255,255,255,0.85)');
        g.addColorStop(0.5, 'rgba(140,225,255,0.75)');
        g.addColorStop(1, 'rgba(60,170,240,0.55)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(e.x - w, e.y);
        ctx.quadraticCurveTo(e.x - w * 0.6, e.y - h * 0.6, e.x - w * 0.2, e.y - h);
        ctx.lineTo(e.x + w * 0.2, e.y - h);
        ctx.quadraticCurveTo(e.x + w * 0.6, e.y - h * 0.6, e.x + w, e.y);
        ctx.closePath();
        ctx.fill();
      }
    }
    // Crown of water arcing out and falling back.
    for (const c of e.crown) {
      const s = t * c.dur;
      const px = e.x + c.vx * s, py = e.y - c.vy * s + 0.5 * c.g * s * s;
      if (py > e.y + 4 && t > 0.1) continue;
      const tx = e.x + c.vx * Math.max(0, s - 2.4), ty = e.y - c.vy * Math.max(0, s - 2.4) + 0.5 * c.g * Math.max(0, s - 2.4) ** 2;
      const a = 1 - clamp((t - 0.6) / 0.4, 0, 1);
      ctx.lineCap = 'round';
      ctx.strokeStyle = `rgba(150,230,255,${a * 0.9})`;
      ctx.lineWidth = c.w;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(px, py);
      ctx.stroke();
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.beginPath();
      ctx.arc(px, py, c.w * 0.7, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawQuake(ctx, e, t) {
    ctx.save();
    if (t < 0.12) {
      glow(ctx, e.x, e.y - 8, e.r * 0.6, '#ffe6a8', (1 - t / 0.12) * 0.9);
    }
    for (let i = 0; i < 2; i++) {
      const tt = clamp((t - i * 0.08) / 0.7, 0, 1);
      if (tt <= 0 || tt >= 1) continue;
      const rx = e.r * 1.15 * easeOutCubic(tt);
      ctx.strokeStyle = `rgba(230,220,255,${(1 - tt) * 0.9})`;
      ctx.lineWidth = 7 * (1 - tt) + 1;
      ctx.beginPath();
      ctx.ellipse(e.x, e.y + 1, rx, rx * 0.14, 0, 0, TAU);
      ctx.stroke();
    }
    // Fissures across the stone face: dark cracks with a hot glow that cools.
    const grow = easeOutCubic(clamp(t / 0.25, 0, 1));
    const fade = 1 - clamp((t - 0.5) / 0.5, 0, 1);
    ctx.lineJoin = 'round';
    for (const c of e.cracks) {
      const len = c.len * grow;
      const pts = [[e.x, e.y + 3]];
      for (let s = 1; s <= c.seg; s++) {
        const u = s / c.seg;
        pts.push([e.x + c.dir * len * u, e.y + 3 + c.drop * u + c.off[s - 1] * u]);
      }
      for (const [col, lw] of [[`rgba(255,160,60,${fade * 0.6})`, 5], [`rgba(20,8,35,${fade})`, 2.4]]) {
        ctx.strokeStyle = col;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let s = 1; s < pts.length; s++) ctx.lineTo(pts[s][0], pts[s][1]);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawClaw(ctx, e, t) {
    const dir = e.dir;
    const x0 = e.cx - dir * e.w * 0.42, x1 = e.cx + dir * e.w * 0.48;
    const y0 = e.i === 0 ? e.cy - e.h * 0.46 : e.cy + e.h * 0.42;
    const y1 = e.i === 0 ? e.cy + e.h * 0.42 : e.cy - e.h * 0.46;
    const head = easeOut(clamp(t / 0.35, 0, 1));
    const tail = clamp((t - 0.22) / 0.78, 0, 1);
    const fade = 1 - tail;
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
    const nx = -dy / len, ny = dx / len;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.globalCompositeOperation = 'lighter';
    const th = e.big ? 1.9 : 1;          // the guillotine slash is a much bigger swing
    const spread = e.big ? 2 : 1;
    for (let k = -spread; k <= spread; k++) {
      const off = k * 15 * th, bulge = (20 - Math.abs(k) * 6 / th) * th;
      const N = 18;
      let prev = null;
      for (let s = 0; s <= N; s++) {
        const u = lerp(tail, head, s / N);
        const bx = x0 + dx * u + nx * (off + Math.sin(u * Math.PI) * bulge * dir * (e.i ? -1 : 1));
        const by = y0 + dy * u + ny * (off + Math.sin(u * Math.PI) * bulge * dir * (e.i ? -1 : 1));
        if (prev) {
          const taper = Math.sin((s / N) * Math.PI * 0.5 + 0.1);
          ctx.strokeStyle = rgba(e.color, fade * 0.85);
          ctx.lineWidth = 9 * taper * th;
          ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(bx, by); ctx.stroke();
          ctx.strokeStyle = `rgba(255,255,255,${fade})`;
          ctx.lineWidth = 3 * taper * th;
          ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(bx, by); ctx.stroke();
        }
        prev = [bx, by];
      }
    }
    if (e.big && t < 0.5) {
      // The strike lands: a flash where the claws end up, and a shock line along the floor.
      const a = 1 - t / 0.5;
      glow(ctx, x1, y1, e.w * 0.32, e.color, 0.9 * a);
      ctx.strokeStyle = `rgba(255,220,160,${a * 0.8})`;
      ctx.lineWidth = 5 * a + 1;
      ctx.beginPath();
      ctx.moveTo(x1 - dir * e.w * 0.6 * (1 - a), GROUND_Y + 3);
      ctx.lineTo(x1 + dir * e.w * 0.3, GROUND_Y + 3);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawSwoosh(ctx, e, t) {
    const head = easeOut(clamp(t / 0.5, 0, 1));
    const tail = clamp((t - 0.25) / 0.75, 0, 1);
    const dir = e.dir;
    const a0 = -1.05, a1 = 0.55;
    ctx.save();
    ctx.lineCap = 'round';
    const N = 10;
    for (let s = 0; s < N; s++) {
      const u0 = lerp(tail, head, s / N), u1 = lerp(tail, head, (s + 1) / N);
      const ang0 = lerp(a0, a1, u0), ang1 = lerp(a0, a1, u1);
      const px = (a) => e.x + dir * Math.cos(a) * e.r, py = (a) => e.y + Math.sin(a) * e.r;
      ctx.strokeStyle = `rgba(255,255,255,${(1 - tail) * 0.75 * (s / N)})`;
      ctx.lineWidth = 2 + 5 * (s / N);
      ctx.beginPath();
      ctx.moveTo(px(ang0), py(ang0));
      ctx.lineTo(px(ang1), py(ang1));
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawNuke(ctx, e, t) {
    const { x, y, rx, ry } = e;
    ctx.save();
    // Ground scorch.
    ctx.fillStyle = `rgba(25,8,45,${0.55 * (1 - t)})`;
    ctx.beginPath();
    ctx.ellipse(x, GROUND_Y + 2, rx * 0.95, 16, 0, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    // Plasma dome.
    const dk = easeOutCubic(clamp(t / 0.5, 0, 1));
    const da = Math.pow(1 - t, 1.4);
    if (da > 0.01) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, rx * dk);
      g.addColorStop(0, `rgba(255,255,255,${da})`);
      g.addColorStop(0.3, `rgba(224,170,255,${da * 0.9})`);
      g.addColorStop(0.7, `rgba(157,78,221,${da * 0.5})`);
      g.addColorStop(1, 'rgba(157,78,221,0)');
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, ry / rx);
      ctx.translate(-x, -y);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, rx * dk, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    // Billowing plasma lobes inside the dome, then a few ragged flares.
    for (const b of e.blobs) {
      const bt = clamp((t - b.delay) / 0.55, 0, 1);
      if (bt <= 0 || bt >= 1) continue;
      const k = easeOutCubic(bt), ba = Math.sin(bt * Math.PI) * 0.75;
      glow(ctx, x + b.ox * rx * k, y + b.oy * ry * k - t * 20, rx * b.r * (0.4 + 0.6 * k), b.hot ? '#ffffff' : '#c07bff', ba);
    }
    if (t < 0.5) {
      ctx.strokeStyle = `rgba(240,210,255,${(1 - t / 0.5) * 0.7})`;
      ctx.lineCap = 'round';
      for (const r of e.rays) {
        const l = rx * r.len * easeOutCubic(clamp(t / 0.28, 0, 1));
        ctx.lineWidth = 2 + 3 * r.len;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(r.a) * rx * 0.3, y + Math.sin(r.a) * ry * 0.3);
        ctx.lineTo(x + Math.cos(r.a) * l, y + Math.sin(r.a) * l * (ry / rx));
        ctx.stroke();
      }
    }
    // Shock ring.
    const sk = easeOutCubic(clamp(t / 0.4, 0, 1));
    if (t < 0.85) {
      ctx.strokeStyle = `rgba(255,255,255,${1 - t / 0.85})`;
      ctx.lineWidth = 14 * (1 - t) + 2;
      ctx.beginPath();
      ctx.ellipse(x, y, rx * sk, ry * sk, 0, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = `rgba(190,120,255,${(1 - t / 0.85) * 0.8})`;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.ellipse(x, y, rx * sk * 0.86, ry * sk * 0.86, 0, 0, TAU);
      ctx.stroke();
    }
    // Initial flash.
    if (t < 0.09) {
      const a = 1 - t / 0.09;
      glow(ctx, x, y, rx * 1.15, '#f3d9ff', a);
    }
    ctx.restore();
  }

  function drawSoundRing(ctx, e, t) {
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const tt = clamp((t - i * 0.14) / 0.7, 0, 1);
      if (tt <= 0 || tt >= 1) continue;
      const r = 14 + 62 * easeOutCubic(tt);
      const c = e.dir > 0 ? 0 : Math.PI;
      ctx.strokeStyle = i === 1 ? `rgba(255,255,255,${1 - tt})` : `rgba(255,150,225,${1 - tt})`;
      ctx.lineWidth = 5 * (1 - tt) + 1;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, c - 0.95, c + 0.95);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawFlash(ctx, e, t) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glow(ctx, e.x, e.y, e.r * (1 - t * 0.4), e.color, 1 - t);
    ctx.strokeStyle = `rgba(255,255,255,${1 - t})`;
    ctx.lineWidth = 3;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU + e.a;
      ctx.beginPath();
      ctx.moveTo(e.x + Math.cos(a) * e.r * 0.3, e.y + Math.sin(a) * e.r * 0.3);
      ctx.lineTo(e.x + Math.cos(a) * e.r * (0.6 + t), e.y + Math.sin(a) * e.r * (0.6 + t));
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawCounter(ctx, e, t) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const l = e.len * easeOutCubic(clamp(t / 0.3, 0, 1));
    ctx.strokeStyle = `rgba(200,235,255,${1 - t})`;
    ctx.lineWidth = 12 * (1 - t) + 1;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(e.x, e.y + 24);
    ctx.lineTo(e.x + e.dir * l, e.y - 24);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${1 - t})`;
    ctx.lineWidth = 4 * (1 - t) + 1;
    ctx.stroke();
    ctx.strokeStyle = `rgba(150,210,255,${1 - t})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(e.x + e.dir * 20, e.y, 20 + 70 * t, 40 + 30 * t, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // Afterimages and rings for Keenan's Phase Step.
  function drawGhost(ctx, e, t) {
    drawSilhouette(ctx, e.x, e.y, e.H, e.dir, '#bfe6ff', 0.42 * (1 - t));
  }

  function drawPhaseRing(ctx, e, t) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(190,235,255,${(1 - t) * 0.9})`;
    ctx.lineWidth = 4 * (1 - t) + 1;
    ctx.beginPath();
    ctx.ellipse(e.x, e.y - e.H * 0.5, 16 + 46 * easeOutCubic(t), e.H * 0.62, 0, 0, TAU);
    ctx.stroke();
    for (let k = -2; k <= 2; k++) {
      ctx.strokeStyle = `rgba(255,255,255,${(1 - t) * 0.7})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(e.x + k * 9, e.y);
      ctx.lineTo(e.x + k * 9, e.y - e.H * (0.4 + 0.5 * (1 - Math.abs(k) / 3)) * easeOutCubic(Math.min(1, t * 2.5)));
      ctx.stroke();
    }
    glow(ctx, e.x, e.y - e.H * 0.5, e.H * 0.6, '#9fd8ff', 0.35 * (1 - t));
    ctx.restore();
  }

  // A small pill above a fighter who can Phase Step right now (in hitstun
  // and ready), so the escape is discoverable in the moment it matters.
  function drawPhaseHint(ctx, f) {
    const now = performance.now();
    const cx = f.x, y = Math.max(150, f.y - f.height - 96);
    const pulse = 0.5 + 0.5 * Math.sin(now / 110);
    ctx.save();
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = '\u2191 + \u2193', w = 62, h = 24;
    ctx.globalCompositeOperation = 'lighter';
    glow(ctx, cx, y, 46, '#9fd8ff', 0.25 + 0.3 * pulse);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(20,30,60,0.85)';
    ctx.strokeStyle = `rgba(190,235,255,${0.6 + 0.4 * pulse})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - w / 2 + 12, y - h / 2);
    ctx.arcTo(cx + w / 2, y - h / 2, cx + w / 2, y + h / 2, 12);
    ctx.arcTo(cx + w / 2, y + h / 2, cx - w / 2, y + h / 2, 12);
    ctx.arcTo(cx - w / 2, y + h / 2, cx - w / 2, y - h / 2, 12);
    ctx.arcTo(cx - w / 2, y - h / 2, cx + w / 2, y - h / 2, 12);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText(label, cx, y + 1);
    ctx.restore();
  }

  function drawTimed(ctx) {
    if (!timed.length) return;
    const now = performance.now();
    timed = timed.filter((e) => now - e.born < e.dur);
    for (const e of timed) {
      const t = (now - e.born) / e.dur;
      switch (e.kind) {
        case 'gas': drawGas(ctx, e, t); break;
        case 'splash': drawSplash(ctx, e, t); break;
        case 'quake': drawQuake(ctx, e, t); break;
        case 'claw': drawClaw(ctx, e, t); break;
        case 'swoosh': drawSwoosh(ctx, e, t); break;
        case 'nuke': drawNuke(ctx, e, t); break;
        case 'soundRing': drawSoundRing(ctx, e, t); break;
        case 'flash': drawFlash(ctx, e, t); break;
        case 'counter': drawCounter(ctx, e, t); break;
        case 'ghost': drawGhost(ctx, e, t); break;
        case 'phasering': drawPhaseRing(ctx, e, t); break;
        default: break;
      }
    }
  }

  // ---- State-following effects ------------------------------------------

  function drawSilhouette(ctx, x, y, H, facing, color, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(x, y - H * 0.86, H * 0.14, 0, TAU);
    ctx.fill();
    ctx.lineWidth = H * 0.2;
    ctx.beginPath();
    ctx.moveTo(x - facing * 3, y - H * 0.66);
    ctx.lineTo(x, y - H * 0.44);
    ctx.stroke();
    ctx.lineWidth = H * 0.09;
    ctx.beginPath();
    ctx.moveTo(x - 4, y - H * 0.4); ctx.lineTo(x - 12 * facing, y);
    ctx.moveTo(x + 4, y - H * 0.4); ctx.lineTo(x + 12 * facing, y);
    ctx.stroke();
    ctx.restore();
  }

  function drawReflectDome(ctx, f) {
    const H = f.height, now = performance.now();
    const cx = f.x, cy = f.y - H * 0.52, rx = f.width * 0.95, ry = H * 0.62;
    const life = clamp(f.reflectTimer / 14, 0, 1);
    const flicker = f.reflectTimer < 14 ? (Math.floor(now / 50) % 2 ? 1 : 0.45) : 1;
    const A = life * flicker;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
    const g = ctx.createRadialGradient(cx, cy, ry * 0.3, cx, cy, ry);
    g.addColorStop(0, `rgba(255,70,70,${0.02 * A})`);
    g.addColorStop(0.75, `rgba(255,70,70,${0.16 * A})`);
    g.addColorStop(1, `rgba(255,120,120,${0.4 * A})`);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = `rgba(255,140,140,${0.9 * A})`;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.clip();
    // Hex lattice.
    const s = 17, hh = s * Math.sqrt(3);
    ctx.strokeStyle = `rgba(255,190,190,${0.28 * A})`;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let row = -6; row <= 6; row++) {
      for (let col = -6; col <= 6; col++) {
        const hx = cx + col * s * 1.5, hy = cy + row * hh + (col & 1 ? hh / 2 : 0);
        for (let k = 0; k < 6; k++) {
          const a = k * TAU / 6, b = (k + 1) * TAU / 6;
          ctx.moveTo(hx + Math.cos(a) * s * 0.96, hy + Math.sin(a) * s * 0.96);
          ctx.lineTo(hx + Math.cos(b) * s * 0.96, hy + Math.sin(b) * s * 0.96);
        }
      }
    }
    ctx.stroke();
    // Shimmer band sweeping across.
    const sweep = ((now / 900) % 1) * (rx * 3) - rx * 1.5;
    const band = ctx.createLinearGradient(cx + sweep - 30, cy - ry, cx + sweep + 30, cy + ry);
    band.addColorStop(0, 'rgba(255,255,255,0)');
    band.addColorStop(0.5, `rgba(255,255,255,${0.28 * A})`);
    band.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = band;
    ctx.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);
    ctx.restore();
    // Specular highlight.
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${0.55 * A})`;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 0.86, ry * 0.86, 0, Math.PI * 1.15, Math.PI * 1.45);
    ctx.stroke();
    ctx.restore();
  }

  function drawPhaseGlitch(ctx, f) {
    const H = f.height, now = performance.now();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 4; k++) {
      const u = (now / 700 + k / 4) % 1;
      const y = f.y - H * (1 - u);
      ctx.strokeStyle = `rgba(200,235,255,${Math.sin(u * Math.PI) * 0.7})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(f.x - f.width * 0.5, y);
      ctx.lineTo(f.x + f.width * 0.5, y);
      ctx.stroke();
    }
    const pulse = (now / 500) % 1;
    ctx.strokeStyle = `rgba(190,230,255,${(1 - pulse) * 0.7})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(f.x, GROUND_Y + 3, f.width * (0.3 + pulse * 0.6), 9 + pulse * 8, 0, 0, TAU);
    ctx.stroke();
    // Glitch slices: a few offset rectangles of light across the body.
    for (let k = 0; k < 3; k++) {
      const y = f.y - H * rnd(0.1, 0.95);
      ctx.fillStyle = 'rgba(190,235,255,0.22)';
      ctx.fillRect(f.x - f.width * 0.5 + rnd(-8, 8), y, f.width * rnd(0.4, 0.9), rnd(2, 6));
    }
    ctx.restore();
  }

  function drawBuffAura(ctx, f) {
    const H = f.height, now = performance.now(), id = f.character.id;
    if (id === 'ryan') {
      const acc = '#ff8fe0';
      const notes = ['\u266A', '\u266B', '\u266C'];
      ctx.save();
      const beat = (now / 330) % 1;
      ctx.strokeStyle = `rgba(255,143,224,${(1 - beat) * 0.6})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(f.x, GROUND_Y + 3, f.width * (0.35 + beat * 0.7), 9 + beat * 9, 0, 0, TAU);
      ctx.stroke();
      ctx.font = 'bold 22px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let k = 0; k < 3; k++) {
        const a = now / 480 + k * TAU / 3;
        const nx = f.x + Math.cos(a) * f.width * 0.85, ny = f.y - H * 0.55 + Math.sin(a) * H * 0.42;
        ctx.fillStyle = `rgba(255,224,245,${0.8 + 0.2 * Math.sin(now / 90 + k)})`;
        ctx.shadowColor = acc;
        ctx.shadowBlur = 10;
        ctx.fillText(notes[k], nx, ny);
      }
      ctx.restore();
    } else {
      const pulse = 0.5 + 0.5 * Math.sin(now / 240);
      ctx.save();
      ctx.strokeStyle = `rgba(140,255,160,${0.22 + pulse * 0.18})`;
      ctx.lineWidth = 3 + pulse * 2;
      ctx.beginPath();
      ctx.ellipse(f.x, f.y - H * 0.5, f.width * 0.72, H * 0.62, 0, 0, TAU);
      ctx.stroke();
      glow(ctx, f.x, f.y - H * 0.5, H * 0.75, '#5cff86', 0.1 + pulse * 0.06);
      ctx.restore();
    }
  }

  function drawCastRings(ctx, f, def) {
    const t = f.actionTimer, H = f.height;
    const p = clamp(t / (def.castFrames || 20), 0, 1);
    const color = f.character.id === 'ryan' ? '#ff8fe0' : '#7dffa0';
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const q = (p * 1.3 - i * 0.22);
      if (q <= 0 || q >= 1) continue;
      ctx.strokeStyle = rgba(color, (1 - q) * 0.9);
      ctx.lineWidth = 4 * (1 - q) + 1;
      ctx.beginPath();
      ctx.ellipse(f.x, f.y - H * q, f.width * (0.4 + 0.35 * q), 10 + 6 * q, 0, 0, TAU);
      ctx.stroke();
    }
    glow(ctx, f.x, f.y - H * 0.5, H * 0.8 * (0.4 + p), color, 0.28);
    ctx.restore();
  }

  function drawChargeOrb(ctx, f, def) {
    const a = f._ability || {};
    const H = f.height, now = performance.now();
    const hx = f.x + f.facing * H * 0.31, hy = f.y - H * 0.63;
    if (f.actionTimer <= def.startup) return;
    if (a.charging) {
      const cf = a.chargeFrames || 0;
      const ready = cf >= (def.chargeThreshold || 10);
      const color = ready ? '#ffe066' : '#c58bff';
      const r = 5 + (cf / def.maxChargeFrames) * 20 + Math.sin(now / 50) * 1.2;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      // Motes being drawn inward.
      for (let k = 0; k < 8; k++) {
        const u = ((now / 420) + k / 8) % 1;
        const ang = k * TAU / 8 + now / 260;
        const d = lerp(r * 3.4, r * 0.6, u);
        ctx.fillStyle = rgba(color, u * 0.9);
        ctx.beginPath();
        ctx.arc(hx + Math.cos(ang) * d, hy + Math.sin(ang) * d, 2.2, 0, TAU);
        ctx.fill();
      }
      glow(ctx, hx, hy, r * 2.4, color, 0.6);
      glow(ctx, hx, hy, r * 1.2, '#ffffff', 0.9);
      if (cf > 4) {
        for (let k = 0; k < 2; k++) {
          const ang = Math.random() * TAU;
          bolt(ctx, hx, hy, hx + Math.cos(ang) * r * 2, hy + Math.sin(ang) * r * 2, 4, 3, color, 1.2);
        }
      }
      ctx.restore();
    }
  }

  function drawNukeChannel(ctx, f, def) {
    const a = f._ability || {};
    if (a.fired) return;
    const H = f.height, now = performance.now();
    const p = clamp(f.actionTimer / def.channel, 0, 1);
    const cx = f.x + f.facing * 26, cy = f.y - H * 1.42 - p * 12;
    const r = 8 + 62 * easeIn(p);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 16; k++) {
      const u = ((now / 520) + k * 0.137) % 1;
      const ang = k * TAU / 16 + now / 500;
      const d0 = lerp(r * 4.2, r * 1.1, u);
      const d1 = d0 + r * 0.6 * (1 - u);
      ctx.strokeStyle = `rgba(224,170,255,${u * 0.85})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * d0, cy + Math.sin(ang) * d0);
      ctx.lineTo(cx + Math.cos(ang) * d1, cy + Math.sin(ang) * d1);
      ctx.stroke();
    }
    glow(ctx, cx, cy, r * 2.5, '#9d4edd', 0.5);
    glow(ctx, cx, cy, r * 1.35, '#e0aaff', 0.9);
    ctx.restore();
    ctx.save();
    ctx.translate(cx, cy);
    for (let k = 0; k < 3; k++) {
      ctx.save();
      ctx.rotate(now / 170 * (k % 2 ? 1 : -1) + k);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 1.15, r * 0.45, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 3; k++) {
      bolt(ctx, cx, cy, f.x + rnd(-8, 8), f.y - H * 0.7, 6, 14, '#b56bff', 1.6);
    }
    ctx.restore();
  }

  function drawNukeSigil(ctx, f, def) {
    const a = f._ability || {};
    if (a.fired) return;
    const p = clamp(f.actionTimer / def.channel, 0, 1);
    const now = performance.now();
    const R = 50 + 90 * p;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(200,140,255,${0.25 + 0.6 * p})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(f.x, GROUND_Y + 3, R, R * 0.17, 0, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(f.x, GROUND_Y + 3, R * 0.62, R * 0.11, 0, 0, TAU);
    ctx.stroke();
    for (let k = 0; k < 10; k++) {
      const ang = k * TAU / 10 + now / 700;
      const x = f.x + Math.cos(ang) * R, y = GROUND_Y + 3 + Math.sin(ang) * R * 0.17;
      ctx.fillStyle = `rgba(224,180,255,${0.4 + 0.5 * p})`;
      ctx.fillRect(x - 2, y - 5, 4, 10);
    }
    ctx.restore();
  }

  function rollFX(ctx, f, big) {
    const H = f.height, now = performance.now();
    const cx = f.x, cy = f.y - H * 0.32, R = H * (big ? 0.52 : 0.44), dir = f.facing;
    const ang = dir * now / 55;
    const accent = f.displayAccent;
    ctx.save();
    ctx.lineCap = 'round';
    for (let k = 0; k < 3; k++) {
      const a0 = ang + k * TAU / 3;
      ctx.strokeStyle = rgba(accent, 0.5);
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(cx, cy, R * (1 + 0.07 * k), a0, a0 + 1.15);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, R * (1 + 0.07 * k), a0 + 0.2, a0 + 1.15);
      ctx.stroke();
    }
    // Speed streaks trailing behind.
    for (let k = 0; k < 6; k++) {
      const y = cy + (k - 2.5) * H * 0.11;
      const len = 40 + ((k * 29) % 50) + (big ? 40 : 0);
      const x0 = cx - dir * R * 0.95;
      const g = ctx.createLinearGradient(x0, 0, x0 - dir * len, 0);
      g.addColorStop(0, 'rgba(255,255,255,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 - dir * len, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function growRings(ctx, f, a) {
    const p = clamp(f.actionTimer / a.tGrowEnd, 0, 1);
    const H = f.height;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const q = clamp(p * 1.4 - i * 0.2, 0, 1);
      if (q <= 0 || q >= 1) continue;
      const r = lerp(H * 1.3, H * 0.3, q);
      ctx.strokeStyle = rgba(f.displayAccent, q * 0.9);
      ctx.lineWidth = 4 * q + 1;
      ctx.beginPath();
      ctx.ellipse(f.x, f.y - H * 0.4, r * 0.7, r * 0.55, 0, 0, TAU);
      ctx.stroke();
    }
    glow(ctx, f.x, f.y - H * 0.45, H * (0.5 + 0.4 * p), f.displayAccent, 0.35 * p);
    ctx.restore();
  }

  function diveStreaks(ctx, f) {
    const H = f.height, dir = f.facing, cy = f.y - H * 0.3;
    const accent = f.displayAccent;
    ctx.save();
    ctx.lineCap = 'round';
    for (let k = 0; k < 9; k++) {
      const y = cy + (k - 4) * H * 0.075 + Math.sin(performance.now() / 40 + k) * 2;
      const len = 90 + ((k * 47) % 110);
      const x0 = f.x - dir * H * 0.32;
      const g = ctx.createLinearGradient(x0, 0, x0 - dir * len, 0);
      g.addColorStop(0, k % 3 === 0 ? rgba(accent, 0.8) : 'rgba(255,255,255,0.6)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 - dir * len, y);
      ctx.stroke();
    }
    // Bow-shock arcs ahead of the fighter.
    for (let k = 0; k < 3; k++) {
      const r = H * (0.45 + k * 0.17);
      const c = dir > 0 ? 0 : Math.PI;
      ctx.strokeStyle = `rgba(255,255,255,${0.6 - k * 0.17})`;
      ctx.lineWidth = 3 - k * 0.6;
      ctx.beginPath();
      ctx.arc(f.x + dir * (H * 0.62 + k * 12) - dir * r * 0.5, cy, r, c - 0.7, c + 0.7);
      ctx.stroke();
    }
    ctx.restore();
  }

  function waterJacket(ctx, f, def) {
    const H = f.height, now = performance.now();
    const a = f._ability || {};
    const cx = f.x, cy = f.y - H * 0.5;
    ctx.save();
    if (a.diving) {
      const L = clamp(60 + Math.abs(f.vy) * 9, 60, 300);
      // Tapered ribbons of water streaming up behind the fall.
      for (let r = -1; r <= 1; r++) {
        const x0 = cx + r * H * 0.1;
        const g = ctx.createLinearGradient(0, cy, 0, cy - L);
        g.addColorStop(0, 'rgba(120,225,255,0.75)');
        g.addColorStop(1, 'rgba(120,225,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(x0 - 9, cy);
        for (let s = 1; s <= 8; s++) ctx.lineTo(x0 - 9 * (1 - s / 8) + Math.sin(now / 60 + s + r) * 6, cy - L * s / 8);
        for (let s = 8; s >= 1; s--) ctx.lineTo(x0 + 9 * (1 - s / 8) + Math.sin(now / 60 + s + r) * 6, cy - L * s / 8);
        ctx.lineTo(x0 + 9, cy);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.65)';
      ctx.lineWidth = 2;
      for (let k = 0; k < 5; k++) {
        const x = cx + (k - 2) * 9, u = (k * 0.31 + now / 250) % 1;
        ctx.beginPath();
        ctx.moveTo(x, cy - u * L * 0.6);
        ctx.lineTo(x, cy - u * L * 0.6 - 26);
        ctx.stroke();
      }
      glow(ctx, cx, cy, H * 0.75, '#4fd0ff', 0.4);
    } else if (!a.hasHitOrLanded) {
      // Rising tuck: water swirling around the body.
      for (let k = 0; k < 9; k++) {
        const ang = now / 70 + k * TAU / 9;
        const x = cx + Math.cos(ang) * H * 0.5, y = cy + Math.sin(ang) * H * 0.4;
        ctx.fillStyle = k % 2 ? 'rgba(255,255,255,0.85)' : 'rgba(110,220,255,0.9)';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, TAU);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(140,230,255,0.55)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(cx, cy, H * 0.5, now / 90, now / 90 + 2.4);
      ctx.stroke();
      glow(ctx, cx, cy, H * 0.65, '#4fd0ff', 0.25);
    }
    ctx.restore();
  }

  function drawFall(ctx, f) {
    const H = f.height;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (let k = 0; k < 7; k++) {
      const x = f.x + (k - 3) * H * 0.12;
      const len = 50 + ((k * 37) % 60);
      ctx.beginPath();
      ctx.moveTo(x, f.y - H * 1.05);
      ctx.lineTo(x, f.y - H * 1.05 - len);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Carlos hovering: twin thruster jets from the feet, a heat glow on the
  // floor when close to it, and a fuel bar above the head while it's in use.
  function drawHoverJets(ctx, f) {
    const now = performance.now();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const dx of [-9, 9]) {
      const x = f.x + dx, y = f.y - 2;
      const L = 38 + Math.sin(now / 35 + dx) * 8 + Math.random() * 5;
      const g = ctx.createLinearGradient(0, y, 0, y + L);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.25, 'rgba(255,196,80,0.85)');
      g.addColorStop(1, 'rgba(255,110,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x - 7, y);
      ctx.quadraticCurveTo(x - 5, y + L * 0.6, x, y + L);
      ctx.quadraticCurveTo(x + 5, y + L * 0.6, x + 7, y);
      ctx.closePath();
      ctx.fill();
      glow(ctx, x, y + 4, 16, '#ffb238', 0.6);
    }
    const h = GROUND_Y - f.y;
    if (h < 170) {
      const k = 1 - h / 170;
      const g = ctx.createRadialGradient(f.x, GROUND_Y, 0, f.x, GROUND_Y, 70);
      g.addColorStop(0, `rgba(255,190,90,${0.5 * k})`);
      g.addColorStop(1, 'rgba(255,190,90,0)');
      ctx.save();
      ctx.translate(f.x, GROUND_Y);
      ctx.scale(1, 0.2);
      ctx.translate(-f.x, -GROUND_Y);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(f.x, GROUND_Y, 70, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  function drawHoverMeter(ctx, f) {
    const hv = f.character.hover;
    if (!hv || f.grounded) return;
    const frac = clamp(f.hoverLeft / hv.frames, 0, 1);
    if (frac >= 1) return;
    const cx = f.x, y = Math.max(140, f.y - f.height - 48) + 26, w = 46, h = 6;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(cx - w / 2 - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = frac > 0.3 ? '#ffb238' : '#ff5a3c';
    ctx.fillRect(cx - w / 2, y, w * frac, h);
    ctx.restore();
  }

  // Carlos's Guillotine Slash: the wind-up must be readable. A glowing claw
  // charges overhead, and from about halfway in the exact area the slash will
  // hit lights up on the floor, pulsing faster as it gets closer.
  function drawClawTelegraph(ctx, f, def) {
    const s0 = def.hits[0].start, t = f.actionTimer;
    if (t > s0) return;
    const p = clamp(t / s0, 0, 1), now = performance.now(), H = f.height, dir = f.facing;
    const accent = f.displayAccent;
    const hx = f.x + dir * H * 0.06, hy = f.y - H * 1.05;
    const r = 12 + 34 * easeIn(p) + Math.sin(now / 40) * 2 * p;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glow(ctx, hx, hy, r * 1.8, accent, 0.18 + 0.4 * p);
    glow(ctx, hx, hy, r * 0.8, '#ffffff', 0.4 + 0.4 * p);
    for (let k = 0; k < 10; k++) {
      const u = (now / 380 + k / 10) % 1, ang = k * TAU / 10 + now / 300, d = lerp(r * 3.2, r * 0.5, u);
      ctx.fillStyle = rgba(accent, u * p);
      ctx.beginPath();
      ctx.arc(hx + Math.cos(ang) * d, hy + Math.sin(ang) * d, 2.2, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    if (p > 0.4) {
      const box = f._forwardBox(def.offset, def.width, def.height);
      const q = (p - 0.4) / 0.6;
      const pulse = 0.5 + 0.5 * Math.sin(now / (90 - 60 * q));
      ctx.save();
      const g = ctx.createLinearGradient(0, GROUND_Y - 70, 0, GROUND_Y + 4);
      g.addColorStop(0, 'rgba(255,90,30,0)');
      g.addColorStop(1, `rgba(255,120,40,${0.16 + 0.34 * q * (0.5 + 0.5 * pulse)})`);
      ctx.fillStyle = g;
      ctx.fillRect(box.x, GROUND_Y - 70, box.w, 74);
      ctx.strokeStyle = `rgba(255,200,120,${0.4 + 0.5 * pulse * q})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(box.x, GROUND_Y + 3);
      ctx.lineTo(box.x + box.w, GROUND_Y + 3);
      ctx.stroke();
      ctx.lineWidth = 3;
      for (let i = 0; i < 4; i++) {
        const cx = f.x + dir * (def.offset + 24 + i * (def.width - 48) / 3), y = GROUND_Y - 16;
        ctx.beginPath();
        ctx.moveTo(cx - dir * 9, y - 11);
        ctx.lineTo(cx + dir * 4, y);
        ctx.lineTo(cx - dir * 9, y + 11);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // Artur's crouch-roll: thin arcs spinning around the tight ball and streaks
  // trailing along the floor, like a ninja's rolling dash.
  function drawNinjaRoll(ctx, f) {
    const H = f.height, now = performance.now(), dir = f.facing;
    const cx = f.x, cy = f.y - H * 0.26, R = H * 0.3;
    const accent = f.displayAccent;
    ctx.save();
    ctx.lineCap = 'round';
    const ang = dir * now / 48;
    for (let k = 0; k < 2; k++) {
      const a0 = ang + k * Math.PI;
      ctx.strokeStyle = rgba(accent, 0.55);
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.15, a0, a0 + 1.05);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.15, a0 + 0.25, a0 + 1.05);
      ctx.stroke();
    }
    for (let k = 0; k < 3; k++) {
      const y = f.y - 10 - k * 15, x0 = cx - dir * R * 1.1, len = 46 + k * 24;
      const g = ctx.createLinearGradient(x0, 0, x0 - dir * len, 0);
      g.addColorStop(0, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 - dir * len, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Carlos's claw dive: stacked whirling rings and streaks trailing behind
  // the direction of travel, so the body reads as a drill of claws.
  function drawClawDrill(ctx, f) {
    const now = performance.now(), H = f.height, dir = f.facing;
    const d = f.character.hoverDive;
    const ang = Math.atan2(d.vy, dir * d.vx);           // the direction of travel
    const bx = f.x, by = f.y - H * 0.5;
    const ux = Math.cos(ang), uy = Math.sin(ang);        // forward
    const accent = f.displayAccent;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 5; i++) {
      const back = 26 + i * 24, cx = bx - ux * back, cy = by - uy * back;
      const wob = Math.sin(now / 40 + i * 1.7) * 6;
      ctx.strokeStyle = i % 2 ? `rgba(255,255,255,${0.55 - i * 0.08})` : rgba(accent, 0.7 - i * 0.1);
      ctx.lineWidth = 4 - i * 0.5;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 10 + i * 4 + wob * 0.3, 30 + i * 5, ang, 0, TAU);
      ctx.stroke();
    }
    for (let k = -1; k <= 1; k++) {
      const off = k * 15;
      const sx = bx - uy * off * -1, sy = by + ux * off * -1;
      const g = ctx.createLinearGradient(sx, sy, sx - ux * 150, sy - uy * 150);
      g.addColorStop(0, rgba(accent, 0.6));
      g.addColorStop(1, rgba(accent, 0));
      ctx.strokeStyle = g;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx - ux * 150, sy - uy * 150);
      ctx.stroke();
    }
    glow(ctx, bx + ux * 26, by + uy * 26, H * 0.36, accent, 0.4);
    ctx.restore();
  }

  function drawFront(ctx, f) {
    if (f.state === 'hoverdive' && f._ability && f._ability.diving && f.character.hoverDive) drawClawDrill(ctx, f);
    if (f.rolling && f.grounded) drawNinjaRoll(ctx, f);
    if (f.character.phaseStep && (f.state === 'hitstun' || f.state === 'knockdown') && f.phaseCooldown <= 0 && f.y <= GROUND_Y + 1 && f.hp > 0) drawPhaseHint(ctx, f);
    if (f.hovering) drawHoverJets(ctx, f);
    if (f.character.hover) drawHoverMeter(ctx, f);
    if (f.reflectTimer > 0) drawReflectDome(ctx, f);
    if (f.isPhased) drawPhaseGlitch(ctx, f);
    if (f.buffTimer > 0) drawBuffAura(ctx, f);

    const def = defOf(f);
    if (!def) return;
    const a = f._ability || {};
    const t = f.actionTimer;
    switch (def.type) {
      case 'projectileCharge': drawChargeOrb(ctx, f, def); break;
      case 'multiHit': if (def.hits.length === 1) drawClawTelegraph(ctx, f, def); break;
      case 'nuke': drawNukeChannel(ctx, f, def); break;
      case 'buff': if (t <= def.castFrames) drawCastRings(ctx, f, def); break;
      case 'lunge':
        if (t > def.startup - 3 && t <= def.startup + def.active + 8) rollFX(ctx, f, false);
        break;
      case 'growRoll':
        if (a.tGrowEnd === undefined) break;
        if (t <= a.tGrowEnd) growRings(ctx, f, a);
        else if (t > a.tGrowEnd - 4 && t <= a.tRollEnd + 6) rollFX(ctx, f, true);
        break;
      case 'dive':
        if (def.angle === 'down') waterJacket(ctx, f, def);
        else if (a.diving) diveStreaks(ctx, f);
        break;
      case 'slam':
        if (!a.hasLanded && t > def.riseFrames && f.vy > 8) drawFall(ctx, f);
        break;
      case 'counterDodge':
        if (a.phase === 'dodge') {
          const now = performance.now();
          for (let i = 3; i >= 1; i--) {
            drawSilhouette(ctx, f.x - f.facing * (i * 16 + Math.sin(now / 50 + i) * 3), f.y, f.height, f.facing, '#bfe6ff', 0.32 / i);
          }
          ctx.save();
          const beat = (now / 300) % 1;
          ctx.strokeStyle = `rgba(190,230,255,${(1 - beat) * 0.8})`;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.ellipse(f.x, f.y - f.height * 0.55, f.width * (0.4 + beat * 0.7), f.height * (0.35 + beat * 0.4), 0, 0, TAU);
          ctx.stroke();
          ctx.restore();
        } else if (a.phase === 'counter') {
          const now = performance.now();
          ctx.save();
          ctx.lineCap = 'round';
          for (let k = 0; k < 6; k++) {
            const y = f.y - f.height * 0.5 + (k - 2.5) * 12;
            ctx.strokeStyle = `rgba(200,235,255,${0.6 - k * 0.04})`;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(f.x - f.facing * 20, y);
            ctx.lineTo(f.x - f.facing * (70 + ((k * 31) % 50)), y);
            ctx.stroke();
          }
          ctx.restore();
        }
        break;
      default: break;
    }
  }

  function drawBack(ctx, f) {
    const def = defOf(f);
    if (def && def.type === 'nuke') drawNukeSigil(ctx, f, def);
  }

  // ---- Triggers ---------------------------------------------------------

  function crossed(prev, cur, at) { return prev <= at && cur > at; }

  function update(f) {
    let m = mems.get(f);
    if (!m) { m = { st: null, t: 0, hasLanded: false, hasHit: false, fired: false, charging: false, phase: null, reflect: 0, diving: false, frame: -1 }; mems.set(f, m); }
    const st = f.state, t = f.actionTimer;
    const def = defOf(f);
    const a = f._ability || {};
    const H = f.height;
    const sameAction = st === m.st && t >= m.t;
    const prevT = sameAction ? m.t : -1; // -1: a fresh action, so every threshold counts as newly crossed
    const newFrame = t !== m.frame || st !== m.st;
    if (!sameAction) { // a new action: forget the previous one's phase flags
      m.hasLanded = m.hasHit = m.fired = m.charging = m.diving = false;
      m.phase = null;
    }

    // Basic-attack swoosh when the active frames begin (not with a mocap
    // attack: that draws a smear that follows the actual fist instead).
    const mocapAttack = typeof Mocap !== 'undefined' && Mocap.clipFor(f.character.id, 'attack');
    if (st === 'attack' && !mocapAttack) {
      const atk = f.character.attack;
      if (crossed(prevT, t, atk.startup)) {
        add({ kind: 'swoosh', dur: 200, x: f.x, y: f.y - H * 0.6, dir: f.facing, r: atk.offset + atk.width * 0.8 });
      }
    }

    if (def) {
      const isUlt = st === 'ultimate';
      switch (def.type) {
        case 'poisonBurst': {
          if (crossed(prevT, t, def.startup)) {
            const box = f._forwardBox(def.offset, def.width, def.height);
            const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
            const n = isUlt ? 30 : 17, pr = isUlt ? 1.7 : 1;
            const puffs = [], bubbles = [];
            for (let i = 0; i < n; i++) {
              puffs.push({ ox: rnd(-0.5, 0.5) * box.w, oy: rnd(-0.4, 0.4) * box.h, r: rnd(24, 44) * pr, delay: rnd(0, 0.28), ph: rnd(0, 6), rise: rnd(0, 30) });
            }
            for (let i = 0; i < 12; i++) bubbles.push({ ox: rnd(-0.45, 0.45) * box.w, oy: rnd(-0.2, 0.4) * box.h, r: rnd(2.5, 6), delay: rnd(0, 0.5), ph: rnd(0, 6) });
            add({ kind: 'gas', dur: isUlt ? 1900 : 1400, cx, cy, w: box.w, h: box.h, rx: f.x - f.facing * f.width * 0.42, ry: f.y - H * 0.32, puffs, bubbles });
            for (let i = 0; i < 14; i++) {
              Effects.spawn({ x: f.x - f.facing * f.width * 0.4, y: f.y - H * 0.32, vx: -f.facing * rnd(0.5, 3) + rnd(-1, 1), vy: rnd(-2, 0.5), size: rnd(3, 6), color: '#b6e86a', life: rnd(20, 34), noGravity: true, shrink: true });
            }
          }
          break;
        }
        case 'multiHit':
          def.hits.forEach((w, i) => {
            if (crossed(prevT, t, w.start)) {
              const box = f._forwardBox(def.offset, def.width, def.height);
              add({ kind: 'claw', dur: def.hits.length === 1 ? 560 : 300, big: def.hits.length === 1, i, cx: box.x + box.w / 2, cy: box.y + box.h / 2, w: box.w, h: box.h, dir: f.facing, color: f.displayAccent });
            }
          });
          break;
        case 'slam':
          if (a.hasLanded && !m.hasLanded) {
            add({ kind: 'quake', dur: 950, x: f.x, y: GROUND_Y, r: def.radius, cracks: makeCracks(def.radius) });
            for (let i = 0; i < 16; i++) {
              const dir = i % 2 ? 1 : -1;
              Effects.spawn({ x: f.x + dir * rnd(10, def.radius * 0.7), y: GROUND_Y - 2, vx: dir * rnd(1, 5), vy: rnd(-9, -3), size: rnd(2.5, 5.5), color: i % 3 ? '#9a8fb8' : '#d8cfee', life: rnd(28, 46), g: 0.45, drag: 0.98 });
            }
            Effects.spawnDust(f.x, GROUND_Y, 10, 4);
          }
          break;
        case 'dive':
          if (def.angle === 'down') {
            if (crossed(prevT, t, 0) && st !== m.st) {
              waterDroplets(f.x, f.y - H * 0.2, 10, 3.5, 5);
            }
            if (a.hasHitOrLanded && !m.hasHit) {
              const ground = f.y >= GROUND_Y - 4;
              const big = isUlt;
              add({ kind: 'splash', dur: big ? 1300 : 950, x: f.x, y: ground ? GROUND_Y : f.y, big, ground, crown: makeCrown(big) });
              waterDroplets(f.x, ground ? GROUND_Y - 4 : f.y, big ? 46 : 28, big ? 9 : 6.5, big ? 16 : 11);
            }
            if (a.diving && newFrame) waterDroplets(f.x, f.y - H * 0.5, 2, 1.5, 2);
          } else if (a.diving && !m.diving) {
            add({ kind: 'flash', dur: 240, x: f.x + f.facing * H * 0.4, y: f.y - H * 0.35, r: H * 0.75, color: f.displayAccent, a: 0 });
          }
          break;
        case 'lunge': {
          const spin = t > def.startup - 3 && t <= def.startup + def.active + 8;
          if (spin && f.grounded && newFrame && t % 2 === 0) Effects.spawnDust(f.x - f.facing * 20, GROUND_Y, 2, 2.4);
          break;
        }
        case 'growRoll': {
          if (a.tGrowEnd === undefined) break;
          if (t <= a.tGrowEnd && newFrame && t % 2 === 0) {
            Effects.spawn({ x: f.x + rnd(-1, 1) * f.width * 0.5, y: f.y - rnd(0, H * 0.4), vx: 0, vy: rnd(-3, -1), size: rnd(2, 4), color: rnd(0, 1) > 0.5 ? '#fff2d0' : '#ffb26b', life: 28, noGravity: true, shrink: true });
          }
          if (t > a.tGrowEnd - 4 && t <= a.tRollEnd + 6 && f.grounded && newFrame) Effects.spawnDust(f.x - f.facing * 30, GROUND_Y, 3, 3.2);
          break;
        }
        case 'projectileCharge':
          if (m.charging && !a.charging && st === m.st) {
            add({ kind: 'flash', dur: 200, x: f.x + f.facing * H * 0.36, y: f.y - H * 0.63, r: 46, color: (a.chargeFrames || 0) >= (def.chargeThreshold || 10) ? '#ffe066' : '#c58bff', a: Math.random() * TAU });
          }
          break;
        case 'soundwaveProjectile':
          if (a.fired && !m.fired) {
            add({ kind: 'soundRing', dur: 420, x: f.x + f.facing * f.width * 0.3, y: f.y - H * 0.8, dir: f.facing });
          }
          break;
        case 'nuke':
          if (a.fired && !m.fired) {
            const box = f._forwardBox(def.offset, def.radius * 2, def.radius * 1.3);
            const rays = [];
            for (let i = 0; i < 11; i++) rays.push({ a: rnd(0, TAU), len: rnd(0.3, 0.85) });
            const blobs = [];
            for (let i = 0; i < 9; i++) blobs.push({ ox: rnd(-0.6, 0.6), oy: rnd(-0.6, 0.5), r: rnd(0.3, 0.5), delay: rnd(0, 0.3), hot: i % 3 === 0 });
            add({ kind: 'nuke', dur: 1500, x: box.x + box.w / 2, y: box.y + box.h / 2, rx: def.radius, ry: def.radius * 0.65, rays, blobs });
            for (let i = 0; i < 44; i++) {
              const ang = rnd(0, TAU), sp = rnd(2, 11);
              Effects.spawn({ x: box.x + box.w / 2, y: box.y + box.h / 2, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp * 0.7 - 2, size: rnd(2, 5), color: i % 3 ? '#e0aaff' : '#ffffff', life: rnd(30, 60), g: 0.12, drag: 0.97, shrink: true });
            }
          }
          break;
        case 'counterDodge':
          if (a.phase === 'counter' && m.phase === 'dodge') {
            add({ kind: 'counter', dur: 340, x: f.x + f.facing * 20, y: f.y - H * 0.55, dir: f.facing, len: def.counterWidth });
          }
          break;
        default: break;
      }
    }

    // Keenan's Phase Step: rings where he goes in and comes out, and an
    // afterimage every frame of the dash.
    if (st === 'phasestep') {
      if (m.st !== 'phasestep') add({ kind: 'phasering', dur: 380, x: f.x, y: f.y, H });
      add({ kind: 'ghost', dur: 300, x: f.x, y: f.y, H, dir: f.facing });
    } else if (m.st === 'phasestep') {
      add({ kind: 'phasering', dur: 380, x: f.x, y: f.y, H });
      for (let i = 0; i < 10; i++) {
        Effects.spawn({ x: f.x + rnd(-1, 1) * f.width * 0.5, y: f.y - rnd(0, H), vx: rnd(-1, 1), vy: rnd(-2, -0.5), size: rnd(1.5, 3), color: '#cfeaff', life: 26, noGravity: true, shrink: true });
      }
    }

    // Smoke poof as the roll starts, then dust kicked up along the floor.
    if (f.rolling && !m.rolling) Effects.spawnDust(f.x, GROUND_Y, 9, 3.4);
    if (f.rolling && f.grounded) {
      const nowMs = performance.now();
      if (nowMs - (m.lastRollDust || 0) > 42) {
        m.lastRollDust = nowMs;
        Effects.spawnDust(f.x - f.facing * 18, GROUND_Y, 2, 2.2);
      }
    }
    m.rolling = !!f.rolling;

    // Scorched dust kicked up by hover thrusters near the floor.
    if (f.hovering && GROUND_Y - f.y < 150) {
      const nowMs = performance.now();
      if (nowMs - (m.lastHoverDust || 0) > 55) {
        m.lastHoverDust = nowMs;
        Effects.spawnDust(f.x, GROUND_Y, 1, 2.6);
      }
    }

    // Sparkle rising off Nathan's / Ryan's buff.
    if (f.buffTimer > 0 && newFrame && t % 3 === 0) {
      const ryan = f.character.id === 'ryan';
      Effects.spawn({ x: f.x + rnd(-1, 1) * f.width * 0.5, y: f.y - rnd(0, H * 0.8), vx: 0, vy: rnd(-1.6, -0.6), size: rnd(1.5, 3), color: ryan ? '#ff8fe0' : '#7dffa0', life: 28, noGravity: true, shrink: true });
    }
    // Bits of static off a phased fighter.
    if (f.isPhased && newFrame) {
      Effects.spawn({ x: f.x + rnd(-1, 1) * f.width * 0.5, y: f.y - rnd(0, H), vx: rnd(-0.4, 0.4), vy: rnd(-2, -0.5), size: rnd(1.5, 3), color: '#cfeaff', life: 24, noGravity: true, shrink: true });
    }

    m.st = st; m.t = t; m.frame = t;
    m.hasLanded = !!a.hasLanded && st !== 'idle';
    m.hasHit = !!a.hasHitOrLanded && st !== 'idle';
    m.fired = !!a.fired && st !== 'idle';
    m.charging = !!a.charging;
    m.phase = a.phase || null;
    m.diving = !!a.diving;
  }

  function makeCracks(r) {
    const cracks = [];
    for (let i = 0; i < 6; i++) {
      const seg = 6;
      const off = [];
      for (let s = 0; s < seg; s++) off.push(rnd(-3, 3));
      cracks.push({ dir: i % 2 ? 1 : -1, len: r * rnd(0.6, 1.15), seg, off, drop: rnd(4, 30) });
    }
    return cracks;
  }

  function makeCrown(big) {
    const crown = [];
    const n = big ? 22 : 15;
    for (let i = 0; i < n; i++) {
      const u = (i / (n - 1)) * 2 - 1; // -1 .. 1 across the crown
      const sp = (big ? 5.2 : 3.8) * u + rnd(-0.4, 0.4);
      crown.push({ vx: sp, vy: (big ? 11 : 8) * (1 - Math.abs(u) * 0.55) + rnd(-1, 1.5), g: 0.55, w: rnd(2.5, 5) * (big ? 1.3 : 1), dur: 34 });
    }
    return crown;
  }

  function waterDroplets(x, y, n, spread, up) {
    for (let i = 0; i < n; i++) {
      Effects.spawn({
        x: x + rnd(-10, 10), y,
        vx: rnd(-spread, spread), vy: -rnd(up * 0.3, up),
        size: rnd(2, 4.5), color: i % 3 ? '#8fe3ff' : '#ffffff',
        life: rnd(28, 50), g: 0.4, drag: 0.98,
      });
    }
  }

  return { update, drawBack, drawFront, drawTimed, drawProjectile, reset };
})();
