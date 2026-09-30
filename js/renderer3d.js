// 3D "paper puppet" view. The fighters are still drawn by the 2D renderer,
// each onto its own transparent card, and the cards stand in a Three.js
// scene: a floating platform, lighting and real cast shadows, and a camera
// that frames both fighters like Smash. Turning around flips the card like
// a sheet of paper. Gameplay is untouched -- the sim is still 2D (x/y) and
// this only changes how a frame is presented.
//
// Loaded as an ES module (Three.js ships as modules), so it arrives after
// the classic scripts; Game.render falls back to the 2D renderer until
// window.Renderer3D exists.

import * as THREE from 'three';

// The game is 3D. The 2D renderer is only a fallback for machines without
// WebGL (old GPUs, blocklisted drivers, some headless browsers): there the
// 3D view never registers and Game.render keeps drawing in 2D. Checked up
// front because Three.js logs console errors and throws without a context.
// ?renderer=2d forces that fallback (the browser tests' pixel checks read
// the 2D canvas).
function webglAvailable() {
  if (new URLSearchParams(location.search).get('renderer') === '2d') return false;
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch (e) {
    return false;
  }
}

if (webglAvailable()) {
  const S = 1 / 100; // game pixels -> 3D units
  const toX = (gx) => (gx - CANVAS_WIDTH / 2) * S;
  const toY = (gy) => (GROUND_Y - gy) * S;

  // Each card covers this much game space around its fighter, with the
  // fighter's feet at (CARD_W / 2, FEET_Y). Sized for the biggest case
  // (Robert transformed, ~300px tall) plus auras and the block shield.
  const CARD_W = 800;
  const CARD_H = 680;
  const FEET_Y = 580;
  const CARD_RES = 1.25; // texture pixels per game pixel
  const FLIP_SECONDS = 0.14;


  const overlay = document.getElementById('game-canvas');
  const canvas = document.createElement('canvas');
  canvas.id = 'game-canvas-3d';
  overlay.parentNode.insertBefore(canvas, overlay);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 200);

  function resize() {
    const w = canvas.clientWidth || CANVAS_WIDTH;
    const h = canvas.clientHeight || CANVAS_HEIGHT;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
  }
  new ResizeObserver(resize).observe(canvas);

  // ---- Environment ----
  // Matches the 2D stage (renderer.js): a floating sky-arena at dusk. The 2D
  // backdrop (sky, moon, far ranges, ruined skyline, haze) is reused as the
  // sky itself; the island, its runes and crystals, the searchlights and the
  // embers are real 3D so they parallax and catch the light.

  function canvasTexture(c) {
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function gradientCanvas(stops, w = 4, h = 256) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, h);
    for (const [t, col] of stops) grad.addColorStop(t, col);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    return c;
  }

  function glowTexture(inner, outer) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, inner);
    grad.addColorStop(1, outer);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return canvasTexture(c);
  }

  scene.background = canvasTexture(Renderer.buildBackdropCanvas());
  scene.fog = new THREE.Fog('#7a3f86', 18, 62);

  scene.add(new THREE.HemisphereLight('#c9b6ff', '#5a2f5a', 1.1));

  // Moonlight from the moon's side of the sky (upper right).
  const sun = new THREE.DirectionalLight('#ffe9f6', 2.3);
  sun.position.set(3, 9, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 7, bottom: -5, near: 1, far: 30 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);

  // Warm horizon glow as a rim from behind.
  const rim = new THREE.DirectionalLight('#e08aa8', 1.2);
  rim.position.set(-5, 3, -8);
  scene.add(rim);

  // Platform: same footprint as the 2D stage (edges are where you fall off).
  const PLAT_W = (STAGE_RIGHT_EDGE - STAGE_LEFT_EDGE) * S;
  const PLAT_X = toX((STAGE_LEFT_EDGE + STAGE_RIGHT_EDGE) / 2);
  const PLAT_DEPTH = 3.4;
  const PLAT_Z = -0.5;
  const PLAT_THICK = 0.55;

  function tileTexture() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#6b5f8f';
    g.fillRect(0, 0, 512, 128);
    g.strokeStyle = 'rgba(20,10,40,0.35)';
    g.lineWidth = 2;
    for (let x = 0; x <= 512; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke(); }
    for (let y = 0; y <= 128; y += 64) { g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke(); }
    // Carved centre emblem, as on the 2D stone face.
    g.strokeStyle = 'rgba(190,170,255,0.35)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(256, 40); g.lineTo(276, 64); g.lineTo(256, 88); g.lineTo(236, 64);
    g.closePath();
    g.stroke();
    const tex = canvasTexture(c);
    tex.anisotropy = 8;
    return tex;
  }

  // Front stone face: staggered blocks (colour) plus the rune glyphs (an
  // emissive map, pulsed each frame like the 2D runes).
  const FACE_TEX_W = 1024, FACE_TEX_H = 64;
  function faceTextures() {
    const blocks = FACE_TEX_W / 16; // one 60px 2D block ≈ 1/16 of the face
    const c = document.createElement('canvas');
    c.width = FACE_TEX_W; c.height = FACE_TEX_H;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, FACE_TEX_H);
    grad.addColorStop(0, '#6b5f8f');
    grad.addColorStop(1, '#40365f');
    g.fillStyle = grad;
    g.fillRect(0, 0, FACE_TEX_W, FACE_TEX_H);
    g.fillStyle = '#b3a5d9'; // bright lip
    g.fillRect(0, 0, FACE_TEX_W, 5);
    g.strokeStyle = 'rgba(15,8,35,0.5)';
    g.lineWidth = 2;
    const mid = FACE_TEX_H * 0.55;
    g.beginPath(); g.moveTo(0, mid); g.lineTo(FACE_TEX_W, mid); g.stroke();
    for (let r = 0; r < 2; r++) {
      const top = r === 0 ? 8 : mid, bot = r === 0 ? mid : FACE_TEX_H;
      for (let x = r ? blocks / 2 : 0; x < FACE_TEX_W; x += blocks) {
        g.beginPath(); g.moveTo(x, top); g.lineTo(x, bot); g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.06)';
        g.fillRect(x + 2, top + 1, blocks - 4, 2);
      }
    }

    const e = document.createElement('canvas');
    e.width = FACE_TEX_W; e.height = FACE_TEX_H;
    const eg = e.getContext('2d');
    eg.fillStyle = '#000';
    eg.fillRect(0, 0, FACE_TEX_W, FACE_TEX_H);
    eg.fillStyle = '#9682ff';
    for (let x = blocks / 2; x < FACE_TEX_W; x += blocks) {
      eg.fillRect(x - 6, 20, 12, 3);
      eg.fillRect(x - 1.5, 15, 3, 13);
    }
    eg.fillStyle = 'rgba(200,170,255,0.8)'; // glow along the lip
    eg.fillRect(0, 0, FACE_TEX_W, 3);
    return { map: canvasTexture(c), emissiveMap: canvasTexture(e) };
  }

  const sideMat = new THREE.MeshStandardMaterial({ color: '#40365f', roughness: 0.9 });
  const topMat = new THREE.MeshStandardMaterial({ map: tileTexture(), roughness: 0.8 });
  const faceMat = new THREE.MeshStandardMaterial({ ...faceTextures(), emissive: '#ffffff', emissiveIntensity: 0.6, roughness: 0.85 });
  const platform = new THREE.Mesh(
    new THREE.BoxGeometry(PLAT_W, PLAT_THICK, PLAT_DEPTH),
    [sideMat, sideMat, topMat, sideMat, faceMat, sideMat],
  );
  platform.position.set(PLAT_X, -PLAT_THICK / 2, PLAT_Z);
  platform.receiveShadow = true;
  scene.add(platform);

  // Glowing trim along the front and side edges.
  const trimMat = new THREE.MeshStandardMaterial({ color: '#b3a5d9', emissive: '#6a4fb0', emissiveIntensity: 0.9, roughness: 0.4 });
  const frontTrim = new THREE.Mesh(new THREE.BoxGeometry(PLAT_W + 0.08, 0.07, 0.07), trimMat);
  frontTrim.position.set(PLAT_X, -0.02, PLAT_Z + PLAT_DEPTH / 2);
  scene.add(frontTrim);
  for (const side of [-1, 1]) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, PLAT_DEPTH), trimMat);
    t.position.set(PLAT_X + side * (PLAT_W / 2 + 0.02), -0.02, PLAT_Z);
    scene.add(t);
    // Corner posts, like the 2D stage's cliff caps.
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, PLAT_THICK + 0.1, 0.1), new THREE.MeshStandardMaterial({ color: '#a596cc', roughness: 0.6 }));
    post.position.set(PLAT_X + side * (PLAT_W / 2 + 0.04), -PLAT_THICK / 2 - 0.03, PLAT_Z + PLAT_DEPTH / 2);
    scene.add(post);
  }

  // Rocky underside so it reads as a floating island.
  const rockMat = new THREE.MeshStandardMaterial({ color: '#2a2140', roughness: 1, flatShading: true });
  const UNDER_H = 2.6;
  const underside = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.12, 1, 7, 3), rockMat);
  underside.scale.set(PLAT_W * 0.5, UNDER_H, PLAT_DEPTH * 0.5);
  underside.position.set(PLAT_X, -PLAT_THICK - UNDER_H / 2, PLAT_Z);
  scene.add(underside);

  // Lit crystals studding the rock's front, each with a soft glow.
  {
    const crystalMat = new THREE.MeshStandardMaterial({ color: '#e6d4ff', emissive: '#be96ff', emissiveIntensity: 1.4, roughness: 0.3, flatShading: true });
    const glowMat = new THREE.SpriteMaterial({ map: glowTexture('rgba(190,150,255,0.9)', 'rgba(190,150,255,0)'), blending: THREE.AdditiveBlending, depthWrite: false });
    const geo = new THREE.OctahedronGeometry(0.09, 0);
    const rnd = (() => { let s = 1337; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
    for (let i = 0; i < 9; i++) {
      const h = 0.08 + rnd() * 0.5;             // 0 = top of the rock, 1 = its tip
      const radius = 1 + (0.12 - 1) * h;        // cylinder taper at that height
      const ang = (rnd() - 0.5) * 1.6;          // spread around the front
      const x = PLAT_X + Math.sin(ang) * radius * PLAT_W * 0.5 * 0.92;
      const z = PLAT_Z + Math.cos(ang) * radius * PLAT_DEPTH * 0.5 * 0.95;
      const y = -PLAT_THICK - h * UNDER_H;
      const m = new THREE.Mesh(geo, crystalMat);
      m.position.set(x, y, z);
      m.scale.set(1, 1.7, 1);
      m.rotation.set(rnd(), rnd() * 3, rnd());
      scene.add(m);
      const glow = new THREE.Sprite(glowMat);
      glow.position.set(x, y, z + 0.05);
      glow.scale.setScalar(0.5);
      scene.add(glow);
    }
  }

  // Distant floating islands for parallax.
  function addIsland(x, y, z, s) {
    const g = new THREE.Group();
    const top = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.25, 7), new THREE.MeshStandardMaterial({ color: '#4b3f6b', roughness: 0.9, flatShading: true }));
    const bottom = new THREE.Mesh(new THREE.ConeGeometry(1, 1.8, 7), rockMat);
    bottom.rotation.x = Math.PI;
    bottom.position.y = -1.02;
    g.add(top, bottom);
    g.position.set(x, y, z);
    g.scale.setScalar(s);
    g.userData.bob = Math.random() * Math.PI * 2;
    g.userData.baseY = y;
    scene.add(g);
    return g;
  }
  // Kept low and far so they sit around the horizon, clear of the HUD.
  const islands = [
    addIsland(-13, 0.2, -24, 1.5),
    addIsland(14, 1.2, -30, 1.9),
    addIsland(-3, 2.2, -42, 1.6),
    addIsland(8, -2.2, -18, 0.9),
    addIsland(-20, -1.8, -34, 1.7),
  ];

  // Two slow-sweeping searchlight beams from beyond the top corners, crossing
  // over the fighting area (the 2D stage's light beams).
  const beams = [];
  {
    const BEAM_LEN = 16;
    const geo = new THREE.CylinderGeometry(0.08, 1.6, BEAM_LEN, 24, 1, true);
    geo.translate(0, -BEAM_LEN / 2, 0); // apex at the origin, opening downward
    const alphaMap = canvasTexture(gradientCanvas([[0, '#ffffff'], [1, '#000000']]));
    for (const side of [-1, 1]) {
      const mat = new THREE.MeshBasicMaterial({
        color: '#ffdcff', alphaMap, transparent: true, opacity: 0.16,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(side * 9, 9.5, -7);
      m.userData.side = side;
      scene.add(m);
      beams.push(m);
    }
  }
  const DOWN = new THREE.Vector3(0, -1, 0);
  const beamDir = new THREE.Vector3();
  function updateBeams(now) {
    const t = now / 1000;
    for (const m of beams) {
      const side = m.userData.side;
      const tx = side * (1.5 + Math.sin(t * 0.45 + side) * 1.3);
      beamDir.set(tx - m.position.x, 0 - m.position.y, PLAT_Z - m.position.z).normalize();
      m.quaternion.setFromUnitVectors(DOWN, beamDir);
    }
  }

  // Embers drifting up off the island and out of the void.
  const embers = [];
  {
    const map = glowTexture('rgba(255,210,170,1)', 'rgba(255,190,140,0)');
    for (let i = 0; i < 28; i++) {
      const mat = new THREE.SpriteMaterial({ map, color: '#ffbe8c', blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
      const sp = new THREE.Sprite(mat);
      const seed = i * 47.13;
      sp.userData = {
        seed,
        speed: 0.05 + (i % 5) * 0.012,
        x: PLAT_X - PLAT_W / 2 - 1.2 + ((seed * 13.7) % (PLAT_W + 2.4)),
        z: -1 - ((seed * 7.3) % 9),
      };
      sp.scale.setScalar(0.09 + (i % 3) * 0.04);
      scene.add(sp);
      embers.push(sp);
    }
  }
  function updateEmbers(now) {
    const t = now / 1000;
    for (const sp of embers) {
      const u = sp.userData;
      const life = (t * u.speed + u.seed) % 1;
      sp.position.set(u.x + Math.sin(t + u.seed) * 0.14, -1.5 + life * 4.2 * 1.6, u.z);
      sp.material.opacity = Math.sin(life * Math.PI) * 0.7;
    }
  }

  // ---- Fighter cards ----

  function makeCard(z, slot) {
    const c = document.createElement('canvas');
    c.width = Math.round(CARD_W * CARD_RES);
    c.height = Math.round(CARD_H * CARD_RES);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD_W * S, CARD_H * S),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.01, side: THREE.DoubleSide, depthWrite: false }),
    );
    mesh.castShadow = true;
    // Cast the silhouette, not the whole rectangle.
    mesh.customDepthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.5, side: THREE.DoubleSide,
    });
    mesh.renderOrder = 2;
    scene.add(mesh);

    // Soft contact shadow under the feet.
    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(1, 24),
      new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.35, depthWrite: false }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.renderOrder = 1;
    scene.add(blob);

    // P1/P2-coloured ring on the floor around the feet (the 2D view's ring).
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1, 40),
      new THREE.MeshBasicMaterial({ color: PLAYER_COLORS[slot], transparent: true, opacity: 0.85, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 1;
    scene.add(ring);

    return { canvas: c, ctx: c.getContext('2d'), tex, mesh, blob, ring, z, rotY: 0 };
  }

  const cards = { p1: makeCard(0.03, 'p1'), p2: makeCard(-0.03, 'p2') };

  function updateCard(card, f, dt) {
    const { ctx, canvas: c } = card;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(CARD_RES, 0, 0, CARD_RES, (CARD_W / 2 - f.x) * CARD_RES, (FEET_Y - f.y) * CARD_RES);
    const rig = Renderer.drawFighter(ctx, f, { card: true });
    card.tex.needsUpdate = true;

    // Paper flip: rotate toward the facing side instead of snapping.
    const target = f.facing > 0 ? 0 : Math.PI;
    const step = (Math.PI / FLIP_SECONDS) * dt;
    const diff = target - card.rotY;
    card.rotY = Math.abs(diff) <= step ? target : card.rotY + Math.sign(diff) * step;

    const m = card.mesh;
    m.visible = true;
    m.position.set(toX(f.x), toY(f.y - FEET_Y + CARD_H / 2), card.z);
    m.rotation.y = card.rotY;

    const overStage = f.x > STAGE_LEFT_EDGE && f.x < STAGE_RIGHT_EDGE;
    const height = (Math.max(0, GROUND_Y - f.y) + rig.lift) * S;
    const k = Math.max(0.25, 1 - height / 2.4);
    const stretch = 1 + 1.1 * rig.lying;
    card.blob.visible = overStage && f.y <= GROUND_Y + 1;
    card.blob.position.set(toX(f.x), 0.004, card.z);
    card.blob.scale.set(f.width * S * 0.42 * k * stretch, f.width * S * 0.16 * k, 1);
    card.blob.material.opacity = 0.38 * k;

    card.ring.visible = card.blob.visible;
    card.ring.position.set(toX(f.x), 0.006, card.z);
    card.ring.scale.set(f.width * S * 0.52 * k * (1 + 0.9 * rig.lying), f.width * S * 0.2 * k, 1);
    card.ring.material.opacity = 0.85 * k;
  }

  // ---- Projectiles + particles sheet ----
  // One transparent sheet spanning the arena, just in front of the cards.
  // Drawn by the existing 2D effect code in plain game coordinates.
  const FX_PAD = 200; // extra room below the canvas for ring-out sparks
  const fxCanvas = document.createElement('canvas');
  fxCanvas.width = CANVAS_WIDTH;
  fxCanvas.height = CANVAS_HEIGHT + FX_PAD;
  const fxCtx = fxCanvas.getContext('2d');
  const fxTex = new THREE.CanvasTexture(fxCanvas);
  fxTex.colorSpace = THREE.SRGBColorSpace;
  const fxSheet = new THREE.Mesh(
    new THREE.PlaneGeometry(fxCanvas.width * S, fxCanvas.height * S),
    new THREE.MeshBasicMaterial({ map: fxTex, transparent: true, depthWrite: false, depthTest: false }),
  );
  fxSheet.position.set(toX(CANVAS_WIDTH / 2), toY(fxCanvas.height / 2), 0.08);
  fxSheet.renderOrder = 3;
  scene.add(fxSheet);

  // A matching sheet just behind the cards for ability effects that sit
  // behind the fighters (AbilityFX.drawBack).
  const backFxCanvas = document.createElement('canvas');
  backFxCanvas.width = fxCanvas.width;
  backFxCanvas.height = fxCanvas.height;
  const backFxCtx = backFxCanvas.getContext('2d');
  const backFxTex = new THREE.CanvasTexture(backFxCanvas);
  backFxTex.colorSpace = THREE.SRGBColorSpace;
  const backFxSheet = new THREE.Mesh(
    fxSheet.geometry,
    new THREE.MeshBasicMaterial({ map: backFxTex, transparent: true, depthWrite: false }),
  );
  backFxSheet.position.set(fxSheet.position.x, fxSheet.position.y, -0.08);
  backFxSheet.renderOrder = 1;
  scene.add(backFxSheet);

  function updateFx(state) {
    backFxCtx.clearRect(0, 0, backFxCanvas.width, backFxCanvas.height);
    AbilityFX.drawBack(backFxCtx, state.p1);
    AbilityFX.drawBack(backFxCtx, state.p2);
    backFxTex.needsUpdate = true;

    fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
    AbilityFX.drawFront(fxCtx, state.p1);
    AbilityFX.drawFront(fxCtx, state.p2);
    AbilityFX.drawTimed(fxCtx);
    Renderer.drawProjectiles(fxCtx, state.projectiles);
    Effects.draw(fxCtx);
    // P1/P2 markers live on this flat sheet rather than on the fighter cards,
    // which mirror when a fighter turns and would print the label backwards.
    Renderer.drawPlayerMarker(fxCtx, state.p1);
    Renderer.drawPlayerMarker(fxCtx, state.p2);
    fxTex.needsUpdate = true;
  }

  // ---- The ball (game.js) ----
  // A real sphere, so it spins and catches the light. Its shadow on the
  // platform marks where it's coming down. Rally: coloured by heat, its band
  // shows whose shot it is, and a live ball leaves a trail. Bomb: a dark
  // bomb whose light blinks faster as the fuse burns, and a red ring shows
  // the blast radius once the fuse is nearly gone.
  const ballGroup = new THREE.Group();
  scene.add(ballGroup);
  const ballMat = new THREE.MeshStandardMaterial({ color: '#2b2440', roughness: 0.35, metalness: 0.3, emissive: '#ff2a2a', emissiveIntensity: 0 });
  const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS * S, 28, 20), ballMat);
  ballMesh.castShadow = true;
  // A pale band around it so the spin reads.
  const bandMat = new THREE.MeshStandardMaterial({ color: '#fff3b0', emissive: '#ffb347', emissiveIntensity: 0.4, roughness: 0.5 });
  const band = new THREE.Mesh(new THREE.TorusGeometry(BALL_RADIUS * S * 1.001, BALL_RADIUS * S * 0.12, 8, 32), bandMat);
  band.rotation.y = Math.PI / 2;
  ballMesh.add(band);
  ballGroup.add(ballMesh);
  // Fuse spark on top, and a halo that glows with the warning light.
  const sparkMat = new THREE.SpriteMaterial({ map: glowTexture('rgba(255,230,150,1)', 'rgba(255,140,60,0)'), blending: THREE.AdditiveBlending, depthWrite: false });
  const spark = new THREE.Sprite(sparkMat);
  ballGroup.add(spark);
  const whiteGlow = glowTexture('rgba(255,255,255,0.9)', 'rgba(255,255,255,0)');
  const haloMat = new THREE.SpriteMaterial({ map: whiteGlow, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const halo = new THREE.Sprite(haloMat);
  ballGroup.add(halo);

  // Rally trail: glowing puffs at the ball's recent positions while it's live.
  const TRAIL = 10;
  const trail = [];
  const trailPos = [];
  for (let i = 0; i < TRAIL; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: whiteGlow, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    sp.visible = false;
    scene.add(sp);
    trail.push(sp);
  }

  const ballShadow = new THREE.Mesh(
    new THREE.CircleGeometry(1, 24),
    new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.4, depthWrite: false }),
  );
  ballShadow.rotation.x = -Math.PI / 2;
  ballShadow.renderOrder = 1;
  scene.add(ballShadow);
  const dangerRing = new THREE.Mesh(
    new THREE.RingGeometry(0.93, 1, 48),
    new THREE.MeshBasicMaterial({ color: '#ff3b3b', transparent: true, depthWrite: false }),
  );
  dangerRing.rotation.x = -Math.PI / 2;
  dangerRing.renderOrder = 1;
  scene.add(dangerRing);

  // Explosion: a hot flash that swells and fades, plus a burst of light.
  const blastMat = new THREE.SpriteMaterial({ map: glowTexture('rgba(255,240,200,1)', 'rgba(255,110,40,0)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const blast = new THREE.Sprite(blastMat);
  scene.add(blast);
  const blastLight = new THREE.PointLight('#ff9a4a', 0, 9, 1.5);
  scene.add(blastLight);

  const heatColor = new THREE.Color();

  function updateBall(b, mode, now) {
    const live = !!b && b.phase !== 'waiting';
    ballGroup.visible = live;
    ballShadow.visible = false;
    dangerRing.visible = false;
    const trailOn = live && mode === 'rally' && b.live && b.hitstop === 0;
    if (!trailOn) trailPos.length = 0;
    else {
      trailPos.unshift([toX(b.x), toY(b.y)]);
      if (trailPos.length > TRAIL) trailPos.pop();
    }
    trail.forEach((sp, i) => {
      sp.visible = trailOn && i > 0 && i < trailPos.length;
      if (!sp.visible) return;
      const k = 1 - i / TRAIL;
      sp.position.set(trailPos[i][0], trailPos[i][1], -0.02);
      sp.scale.setScalar(BALL_RADIUS * S * 2.2 * (0.4 + 0.6 * k) * (1 + b.heat * 0.08));
      sp.material.color.set(Game.ballColor(b));
      sp.material.opacity = 0.55 * k;
    });

    const blastK = b && b.blastT > 0 ? 1 - b.blastT / 30 : 1;
    blast.visible = blastK < 1;
    blastLight.intensity = blastK < 1 ? 60 * (1 - blastK) : 0;
    if (blast.visible) {
      blast.position.set(toX(b.blastX), toY(b.blastY), 0.2);
      blast.scale.setScalar(BALL_BLAST_RADIUS * S * 2 * (0.5 + 0.9 * blastK));
      blastMat.opacity = 1 - blastK * blastK;
      blastLight.position.set(toX(b.blastX), toY(b.blastY) + 0.5, 1);
    }
    if (!live) return;

    const appear = b.phase === 'appearing' ? 1 - b.timer / BALL_APPEAR : 1;
    ballGroup.position.set(toX(b.x), toY(b.y), 0);
    ballGroup.scale.setScalar(Math.max(0.01, appear) * (b.hitstop > 0 ? 1.25 : 1)); // swells on impact
    ballMesh.rotation.z = -b.spin;
    let d = { heat: 0 };
    if (mode === 'rally') {
      const h = b.heat / RALLY_MAX_HEAT;
      heatColor.set(Game.ballColor(b));
      ballMat.color.copy(heatColor);
      ballMat.emissive.copy(heatColor);
      ballMat.emissiveIntensity = 0.05 + h * 1.4;
      ballMat.metalness = 0.1;
      const owned = b.live || b.heldBy;
      bandMat.color.set(owned ? PLAYER_COLORS[b.lastHit] : '#6b5f8f');
      bandMat.emissive.set(owned ? PLAYER_COLORS[b.lastHit] : '#000000');
      bandMat.emissiveIntensity = owned ? 0.8 : 0;
      haloMat.color.copy(heatColor);
      halo.scale.setScalar(BALL_RADIUS * S * (2.2 + 3 * h));
      haloMat.opacity = h > 0 ? 0.2 + 0.6 * h : 0;
      spark.visible = false;
    } else {
      d = Game.ballDanger(b);
      ballMat.color.set('#2b2440');
      ballMat.emissive.set('#ff2a2a');
      ballMat.metalness = 0.3;
      ballMat.emissiveIntensity = d.lit ? 0.2 + d.heat * 1.6 : 0.03 + d.heat * 0.25;
      bandMat.color.set('#fff3b0');
      bandMat.emissive.set('#ffb347');
      bandMat.emissiveIntensity = 0.4;
      haloMat.color.set('#ff4632');
      halo.scale.setScalar(BALL_RADIUS * S * (3 + 2 * d.heat));
      haloMat.opacity = d.lit ? 0.35 + 0.6 * d.heat : 0.08;
      spark.visible = true;
      spark.position.set(0, BALL_RADIUS * S * 1.15, 0);
      spark.scale.setScalar(BALL_RADIUS * S * (1.1 + 0.4 * Math.sin(now / 40)));
    }

    // Shadow straight below while it's over the platform: that's where it lands.
    const overStage = b.x > STAGE_LEFT_EDGE && b.x < STAGE_RIGHT_EDGE;
    if (overStage && b.phase === 'live') {
      const h = Math.max(0, GROUND_Y - b.y) * S;
      const k = Math.max(0.35, 1 - h / 6);
      ballShadow.visible = true;
      ballShadow.position.set(toX(b.x), 0.005, 0);
      ballShadow.scale.set(BALL_RADIUS * S * 1.3 * k, BALL_RADIUS * S * 0.6 * k, 1);
      ballShadow.material.opacity = 0.5 * k;
      if (d.heat > 0.6) {
        dangerRing.visible = true;
        dangerRing.position.set(toX(b.x), 0.007, 0);
        dangerRing.scale.set(BALL_BLAST_RADIUS * S, BALL_BLAST_RADIUS * S * 0.45, 1);
        dangerRing.material.opacity = (d.lit ? 0.9 : 0.35) * Math.min(1, (d.heat - 0.6) * 4);
      }
    }
  }

  // ---- Camera ----
  const camTarget = new THREE.Vector3(0, 1.4, 0);
  const camPos = new THREE.Vector3(0, 3, 13);
  let lastRender = performance.now();

  function frameCamera(state, dt, t) {
    let tx, ty, dist;
    if (state) {
      const a = state.p1, b = state.p2;
      const ax = toX(a.x), bx = toX(b.x);
      // Don't chase a fighter all the way down a ring-out.
      const ay = Math.max(toY(a.y), -1.2), by = Math.max(toY(b.y), -1.2);
      const tallest = Math.max(a.height, b.height) * S;
      const spanX = Math.abs(ax - bx) + 2.8;
      const spanY = Math.abs(ay - by) + tallest + 1.6;
      const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      dist = Math.max(spanY / 2 / tanV, spanX / 2 / (tanV * camera.aspect));
      dist = THREE.MathUtils.clamp(dist, 7, 16);
      tx = THREE.MathUtils.clamp((ax + bx) / 2, -3.2, 3.2);
      ty = Math.max((ay + by) / 2 + tallest * 0.55, 0.9);
      // Pull back to keep a high ball in shot (below the HUD, which covers
      // the top of the screen), holding the floor in place.
      const ball = state.ball;
      if (ball && ball.phase !== 'waiting') {
        const halfH = dist * tanV;
        const need = toY(ball.y) + BALL_RADIUS * S * 2;
        if (need > ty + halfH * 0.7) {
          const bottom = ty - halfH;
          const h = Math.min((need - bottom) / 1.7, 16 * tanV);
          ty = bottom + h;
          dist = h / tanV;
        }
      }
    } else {
      // Menus: slow drift over the empty stage.
      tx = Math.sin(t * 0.00012) * 1.5;
      ty = 1.2;
      dist = 13;
    }
    const k = 1 - Math.exp(-dt * 5);
    camTarget.lerp(new THREE.Vector3(tx, ty, 0), k);
    camPos.lerp(new THREE.Vector3(tx * 0.9, ty + dist * 0.17, dist), k);

    const shake = Effects.getShakeOffset();
    camera.position.set(camPos.x + shake.x * S, camPos.y - shake.y * S, camPos.z);
    camera.lookAt(camTarget.x + shake.x * S, camTarget.y - shake.y * S, camTarget.z);
  }

  // ---- Public API ----

  overlay.classList.add('overlay-3d');

  function render(state) {
    const now = performance.now();
    const dt = Math.min((now - lastRender) / 1000, 0.1);
    lastRender = now;

    if (state) {
      updateCard(cards.p1, state.p1, dt);
      updateCard(cards.p2, state.p2, dt);
      updateFx(state);
      updateBall(state.ball, state.ballMode, now);
    } else {
      updateBall(null, null, now);
      for (const c of Object.values(cards)) { c.mesh.visible = false; c.blob.visible = false; c.ring.visible = false; }
      fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
      fxTex.needsUpdate = true;
    }
    fxSheet.visible = backFxSheet.visible = !!state;

    for (const isl of islands) {
      isl.position.y = isl.userData.baseY + Math.sin(now * 0.0005 + isl.userData.bob) * 0.25;
    }
    updateBeams(now);
    updateEmbers(now);
    // Pulsing runes and lip glow, in step with the 2D stage.
    const pulse = 0.35 + 0.25 * Math.sin(now / 1000 * 2);
    faceMat.emissiveIntensity = 0.3 + pulse * 1.1;
    trimMat.emissiveIntensity = 0.6 + pulse * 0.8;

    frameCamera(state, dt, now);
    renderer.render(scene, camera);
  }

  window.Renderer3D = {
    isActive: () => true,
    render,
  };
  window.dispatchEvent(new Event('renderer3d-ready'));
}
