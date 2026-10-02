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
  // Room for Nathan's Overgrowth whip: ~900px out, arcing ~500px overhead.
  const CARD_W_WIDE = 2000, CARD_H_TALL = 1000, FEET_Y_TALL = 900;
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

  const hemi = new THREE.HemisphereLight('#c9b6ff', '#5a2f5a', 1.1);
  scene.add(hemi);

  // Moonlight from the moon's side of the sky (upper right).
  const sun = new THREE.DirectionalLight('#ffe9f6', 2.3);
  sun.position.set(3, 9, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 7, bottom: -5, near: 1, far: 30 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target); // (moved along with the camera, so shadows cover big stages)

  // Warm horizon glow as a rim from behind.
  const rim = new THREE.DirectionalLight('#e08aa8', 1.2);
  rim.position.set(-5, 3, -8);
  scene.add(rim);

  // Everything below belongs to the Sky Arena; other stages have their own
  // group (see "Stages" further down) and only one is shown at a time.
  const arena = new THREE.Group();
  scene.add(arena);

  // Platform: same footprint as the 2D stage (edges are where you fall off).
  const PLAT_W = (STAGES.arena.right - STAGES.arena.left) * S;
  const PLAT_X = toX((STAGES.arena.left + STAGES.arena.right) / 2);
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
  arena.add(platform);

  // Glowing trim along the front and side edges.
  const trimMat = new THREE.MeshStandardMaterial({ color: '#b3a5d9', emissive: '#6a4fb0', emissiveIntensity: 0.9, roughness: 0.4 });
  const frontTrim = new THREE.Mesh(new THREE.BoxGeometry(PLAT_W + 0.08, 0.07, 0.07), trimMat);
  frontTrim.position.set(PLAT_X, -0.02, PLAT_Z + PLAT_DEPTH / 2);
  arena.add(frontTrim);
  for (const side of [-1, 1]) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, PLAT_DEPTH), trimMat);
    t.position.set(PLAT_X + side * (PLAT_W / 2 + 0.02), -0.02, PLAT_Z);
    arena.add(t);
    // Corner posts, like the 2D stage's cliff caps.
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, PLAT_THICK + 0.1, 0.1), new THREE.MeshStandardMaterial({ color: '#a596cc', roughness: 0.6 }));
    post.position.set(PLAT_X + side * (PLAT_W / 2 + 0.04), -PLAT_THICK / 2 - 0.03, PLAT_Z + PLAT_DEPTH / 2);
    arena.add(post);
  }

  // Rocky underside so it reads as a floating island.
  const rockMat = new THREE.MeshStandardMaterial({ color: '#2a2140', roughness: 1, flatShading: true });
  const UNDER_H = 2.6;
  const underside = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.12, 1, 7, 3), rockMat);
  underside.scale.set(PLAT_W * 0.5, UNDER_H, PLAT_DEPTH * 0.5);
  underside.position.set(PLAT_X, -PLAT_THICK - UNDER_H / 2, PLAT_Z);
  arena.add(underside);

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
      arena.add(m);
      const glow = new THREE.Sprite(glowMat);
      glow.position.set(x, y, z + 0.05);
      glow.scale.setScalar(0.5);
      arena.add(glow);
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
    arena.add(g);
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
      arena.add(m);
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
      arena.add(sp);
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

  // ---- Stages ----
  // Each stage is a group of scenery plus its sky, fog and light; only the
  // current one is shown. Gameplay positions (floor edges, branches, the
  // car) come from stages.js, so the scenery always lines up with the game.
  //
  // The Orchard is a grey-box: simple placeholder shapes, each named for
  // what it stands in for, to be swapped for real models (the Blender
  // template is built from this same layout).

  const orchard = new THREE.Group();
  orchard.visible = false;
  scene.add(orchard);

  const LOOKS = {
    arena: {
      group: arena, background: scene.background, fog: scene.fog,
      hemi: ['#c9b6ff', '#5a2f5a', 1.1], sun: ['#ffe9f6', 2.3], rim: ['#e08aa8', 1.2],
      maxDist: 16,
    },
    orchard: {
      group: orchard,
      // Sky and haze in the colours of the mountain photo on the horizon (blender/orchard.blend).
      background: canvasTexture(gradientCanvas([[0, '#7fa9c4'], [0.5, '#b4c6c4'], [0.8, '#d6c8a8'], [1, '#c9ae8a']])),
      fog: new THREE.Fog('#c4b293', 60, 300),
      hemi: ['#eaf5ff', '#6f8f4a', 1.3], sun: ['#fff3da', 2.7], rim: ['#ffe6b8', 0.5],
      maxDist: 24,
    },
  };
  let currentLook = 'arena';
  function useStageLook(id) {
    if (!LOOKS[id] || id === currentLook) return;
    currentLook = id;
    const look = LOOKS[id];
    for (const l of Object.values(LOOKS)) l.group.visible = l === look;
    scene.background = look.background;
    scene.fog = look.fog;
    hemi.color.set(look.hemi[0]); hemi.groundColor.set(look.hemi[1]); hemi.intensity = look.hemi[2];
    sun.color.set(look.sun[0]); sun.intensity = look.sun[1];
    rim.color.set(look.rim[0]); rim.intensity = look.rim[1];
  }

  // Grey-box parts. Each is named after what it stands in for.
  const box = (name, w, h, d, color, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.9, flatShading: true }));
    m.name = name;
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    return m;
  };

  // Where the car joins the fight line at each end (3D x).
  const orchardDef = STAGES.orchard;
  const CAR = orchardDef.car;
  const carJoin = (side) => toX(side < 0 ? orchardDef.left + CAR.width / 2 + 20 : orchardDef.right - CAR.width / 2 - 20);
  const ROAD_BACK = -26; // how far back the farm roads come from

  {
    const L = toX(orchardDef.left), R = toX(orchardDef.right), W = R - L, CX = (L + R) / 2;
    const HILL_DEPTH = 50, HILL_FRONT = 18, HILL_H = 5; // (runs well forward, so the view is grass, not a wall of dirt)

    // The hilltop: flat grass on top, steep dirt drops at the ends (the ring-out edges).
    const dirt = new THREE.MeshStandardMaterial({ color: '#9a7652', roughness: 1, flatShading: true });
    const grass = new THREE.MeshStandardMaterial({ color: '#86b35a', roughness: 1 });
    const hill = new THREE.Mesh(new THREE.BoxGeometry(W, HILL_H, HILL_DEPTH), [dirt, dirt, grass, dirt, dirt, dirt]);
    hill.name = 'ground_hilltop';
    hill.position.set(CX, -HILL_H / 2, HILL_FRONT - HILL_DEPTH / 2);
    hill.receiveShadow = true;
    orchard.add(hill);

    // The valley far below, beyond the edges.
    const valley = new THREE.Mesh(new THREE.PlaneGeometry(260, 200), new THREE.MeshStandardMaterial({ color: '#6f9a4a', roughness: 1 }));
    valley.name = 'backdrop_valley';
    valley.rotation.x = -Math.PI / 2;
    valley.position.set(0, -9, -40);
    orchard.add(valley);

    // Dirt road along the fight line, and the farm roads that join it from the back.
    const roadMat = new THREE.MeshStandardMaterial({ color: '#c2a57a', roughness: 1 });
    const road = new THREE.Mesh(new THREE.PlaneGeometry(W, 1.6), roadMat);
    road.name = 'road_main';
    road.rotation.x = -Math.PI / 2;
    road.position.set(CX, 0.004, 0);
    road.receiveShadow = true;
    orchard.add(road);
    for (const side of [-1, 1]) {
      const back = new THREE.Mesh(new THREE.PlaneGeometry(1.6, -ROAD_BACK + 1), roadMat);
      back.name = side < 0 ? 'road_back_left' : 'road_back_right';
      back.rotation.x = -Math.PI / 2;
      back.position.set(carJoin(side), 0.003, ROAD_BACK / 2);
      back.receiveShadow = true;
      orchard.add(back);
    }

    // The apple tree: branches and crown exactly where the platforms are.
    const tree = new THREE.Group();
    tree.name = 'tree_platform';
    const bark = '#7a5634', leaf = '#4f8f3a';
    const crown = orchardDef.platforms.find((p) => p.id === 'crown');
    const crownY = toY(crown.y);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.32, crownY + 0.2, 8), new THREE.MeshStandardMaterial({ color: bark, roughness: 1, flatShading: true }));
    trunk.name = 'tree_trunk';
    trunk.position.set(toX(640), (crownY + 0.2) / 2, -0.55);
    trunk.castShadow = true;
    tree.add(trunk);
    for (const p of orchardDef.platforms) {
      const x1 = toX(p.x1), x2 = toX(p.x2), y = toY(p.y);
      if (p.id === 'crown') {
        tree.add(box('tree_crown_top', x2 - x1, 0.16, 1.1, '#5d9c44', (x1 + x2) / 2, y - 0.08, -0.25));
      } else {
        tree.add(box('tree_' + p.id, x2 - x1, 0.12, 0.6, bark, (x1 + x2) / 2, y - 0.06, -0.15));
        // The limb from the trunk out to the branch.
        const near = Math.abs(x1 - toX(640)) < Math.abs(x2 - toX(640)) ? x1 : x2;
        const limb = box('tree_limb', Math.abs(near - toX(640)) + 0.2, 0.14, 0.18, bark, (near + toX(640)) / 2, y - 0.2, -0.5);
        limb.rotation.z = 0.25 * Math.sign(near - toX(640));
        tree.add(limb);
      }
    }
    // Leaves, all behind the fight line so they never hide a fighter.
    const leafMat = new THREE.MeshStandardMaterial({ color: leaf, roughness: 1, flatShading: true });
    for (const [x, y, z, r] of [[0, 2.55, -1.3, 1.25], [-1.0, 2.2, -1.1, 0.9], [1.0, 2.25, -1.1, 0.9], [-1.6, 1.25, -0.9, 0.55], [1.6, 1.25, -0.9, 0.55], [0.4, 3.1, -1.6, 0.8]]) {
      const s = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), leafMat);
      s.name = 'tree_leaves';
      s.position.set(toX(640) + x, y, z);
      s.castShadow = true;
      tree.add(s);
    }
    orchard.add(tree);

    // Rows of fruit trees behind (one mesh each for trunks and tops).
    const spots = [];
    for (const z of [-4.5, -7.5, -10.5, -14, -18, -22.5]) {
      for (let x = L + 1.2; x < R - 1; x += 2.6) {
        if (Math.abs(x - carJoin(-1)) < 1.4 || Math.abs(x - carJoin(1)) < 1.4) continue; // keep the roads clear
        if (z > -14 && z < -7 && Math.abs(x - (-8)) < 2.8) continue; // the barn
        spots.push([x + Math.sin(x * 12.9 + z) * 0.35, z]);
      }
    }
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.14, 1, 6), new THREE.MeshStandardMaterial({ color: bark, roughness: 1 }), spots.length);
    const tops = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.75, 0), new THREE.MeshStandardMaterial({ color: '#5c9a40', roughness: 1, flatShading: true }), spots.length);
    trunks.name = 'orchard_rows_trunks';
    tops.name = 'orchard_rows_tops';
    const mtx = new THREE.Matrix4();
    spots.forEach(([x, z], i) => {
      mtx.makeTranslation(x, 0.5, z); trunks.setMatrixAt(i, mtx);
      mtx.makeTranslation(x, 1.35, z); tops.setMatrixAt(i, mtx);
    });
    trunks.castShadow = tops.castShadow = true;
    orchard.add(trunks, tops);

    // Fence along the back of the fight area.
    const fence = new THREE.Group();
    fence.name = 'fence';
    for (let x = L + 0.3; x < R; x += 1.5) {
      if (Math.abs(x - carJoin(-1)) < 1.1 || Math.abs(x - carJoin(1)) < 1.1) continue;
      fence.add(box('fence_post', 0.1, 0.7, 0.1, '#a88a62', x, 0.35, -2.3));
      fence.add(box('fence_rail', 1.5, 0.07, 0.05, '#b89a70', x + 0.75, 0.52, -2.3));
    }
    orchard.add(fence);

    // A barn, far hills, and the sun's warmth.
    const barn = new THREE.Group();
    barn.name = 'barn';
    barn.add(box('barn_walls', 3.4, 2.2, 2.6, '#b5473a', 0, 1.1, 0));
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(1.95, 1.95, 3.6, 3, 1), new THREE.MeshStandardMaterial({ color: '#6b5a52', roughness: 1, flatShading: true }));
    roof.name = 'barn_roof';
    roof.rotation.set(-Math.PI / 2, 0, Math.PI / 2); // a triangular prism lying along x, ridge up
    roof.scale.set(1, 1, 0.55);
    roof.position.set(0, 2.74, 0);
    roof.castShadow = true;
    barn.add(roof);
    barn.position.set(-8, 0, -10.5);
    orchard.add(barn);

    const hillMat = new THREE.MeshStandardMaterial({ color: '#7fa65a', roughness: 1, flatShading: true });
    for (const [x, z, sx, sy] of [[-40, -70, 26, 9], [-8, -80, 30, 12], [26, -72, 24, 8], [55, -65, 22, 10], [-65, -60, 20, 7]]) {
      const h = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), hillMat);
      h.name = 'backdrop_hill';
      h.scale.set(sx, sy, sx * 0.6);
      h.position.set(x, -9, z);
      orchard.add(h);
    }
  }

  // Cows grazing and wandering behind the fence (scenery only).
  const cows = [];
  {
    const white = '#f2efe8', black = '#2c2a28';
    for (const [z, xa, xb, speed, phase] of [[-3.4, -9, -3, 0.35, 0], [-6, 2.5, 9, 0.28, 2], [-9, -4, 4, 0.22, 4.5], [-12.5, 5, 11, 0.3, 1]]) {
      const cow = new THREE.Group();
      cow.name = 'cow';
      cow.add(box('cow_body', 1.2, 0.55, 0.5, white, 0, 0.75, 0));
      cow.add(box('cow_patch', 0.45, 0.4, 0.52, black, -0.15, 0.8, 0));
      cow.add(box('cow_head', 0.35, 0.35, 0.34, white, 0.72, 0.95, 0));
      cow.add(box('cow_nose', 0.12, 0.18, 0.3, '#e8a8a0', 0.9, 0.88, 0));
      const legs = [];
      for (const [lx, lz] of [[0.45, 0.17], [0.45, -0.17], [-0.45, 0.17], [-0.45, -0.17]]) {
        const leg = box('cow_leg', 0.1, 0.5, 0.1, white, lx, 0.25, lz);
        legs.push(leg);
        cow.add(leg);
      }
      cow.position.set(xa, 0, z);
      orchard.add(cow);
      cows.push({ cow, legs, z, xa, xb, speed, phase });
    }
  }
  let cowsLast = null;
  function updateCows(now) {
    const t = now / 1000;
    const dt = cowsLast === null ? 0 : Math.min(0.1, (now - cowsLast) / 1000);
    cowsLast = now;
    for (const c of cows) {
      // Wander back and forth, stopping to graze at each end.
      const span = c.xb - c.xa, period = (span / c.speed) * 2 + 8;
      const u = ((t + c.phase * 3) % period) / period;
      const walkOut = (span / c.speed) / period;
      let x, dir, walking, left = 0; // left: seconds of grazing left at this end
      if (u < walkOut) { x = c.xa + span * (u / walkOut); dir = 1; walking = true; }
      else if (u < 0.5) { x = c.xb; dir = 1; walking = false; left = (0.5 - u) * period; }
      else if (u < 0.5 + walkOut) { x = c.xb - span * ((u - 0.5) / walkOut); dir = -1; walking = true; }
      else { x = c.xa; dir = -1; walking = false; left = (1 - u) * period; }
      c.cow.position.x = x;
      if (!c.custom) c.cow.rotation.y = dir > 0 ? 0 : Math.PI;
      if (c.custom) {
        // A real cow turns round at the end of its graze rather than flipping.
        const face = (dir > 0 ? 0 : Math.PI) + (!walking && left < 1.6 ? Math.PI : 0);
        c.yaw = c.yaw === undefined ? face : c.yaw + Math.atan2(Math.sin(face - c.yaw), Math.cos(face - c.yaw)) * Math.min(1, dt * 2.5);
        c.cow.rotation.y = c.yaw;
        if (c.walk && c.graze) {
          // Walk while moving, at the pace it covers ground (the clip's stride);
          // graze, head down, while stopped.
          c.w = (c.w || 0) + ((walking ? 1 : 0) - (c.w || 0)) * Math.min(1, dt * 3);
          c.walk.setEffectiveWeight(c.w);
          c.graze.setEffectiveWeight(1 - c.w);
          if (c.stride) c.walk.timeScale = (c.speed / c.stride) * c.walk.getClip().duration;
        }
        continue;
      }
      c.legs.forEach((leg, i) => { leg.rotation.z = walking ? Math.sin(t * 6 + (i % 2) * Math.PI) * 0.35 : 0; });
      c.cow.children[2].position.y = walking ? 0.95 : 0.62; // head down to graze
    }
  }

  // The car (a van -- its roof is the platform you can ride).
  const car = new THREE.Group();
  car.name = 'car';
  {
    const w = CAR.width * S, h = CAR.height * S;
    car.add(box('car_body', w, h - 0.15, 1.3, '#8aa1b8', 0, 0.15 + (h - 0.15) / 2, 0));
    car.add(box('car_windshield', 0.08, 0.3, 1.1, '#2b3440', w / 2 - 0.02, h - 0.25, 0));
    for (const side of [-1, 1]) car.add(box('car_window', 1.4, 0.26, 0.04, '#2b3440', 0.3, h - 0.25, side * 0.66));
    for (const [x, z] of [[w / 2 - 0.55, 0.6], [w / 2 - 0.55, -0.6], [-w / 2 + 0.55, 0.6], [-w / 2 + 0.55, -0.6]]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.18, 12), new THREE.MeshStandardMaterial({ color: '#222', roughness: 0.8 }));
      wheel.name = 'car_wheel';
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(x, 0.2, z);
      car.add(wheel);
    }
    const lightMat = new THREE.MeshStandardMaterial({ color: '#fff6c8', emissive: '#fff2a0', emissiveIntensity: 2 });
    for (const z of [0.45, -0.45]) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.22), lightMat);
      l.name = 'car_headlight';
      l.position.set(w / 2 + 0.01, 0.4, z);
      car.add(l);
    }
    const glowMat = new THREE.SpriteMaterial({ map: glowTexture('rgba(255,245,190,1)', 'rgba(255,245,190,0)'), blending: THREE.AdditiveBlending, depthWrite: false });
    for (const z of [0.45, -0.45]) {
      const g = new THREE.Sprite(glowMat);
      g.name = 'car_glow';
      g.position.set(w / 2 + 0.2, 0.4, z);
      g.scale.setScalar(0.9);
      car.add(g);
    }
    car.traverse((m) => { if (m.isMesh) m.castShadow = true; });
  }
  car.visible = false;
  orchard.add(car);

  // Where the car is on screen: down a farm road during the warning, round a
  // proper turning arc onto the fight line, along it (where the game has it)
  // while it drives, then round the far corner and away up the other farm
  // road (scenery only, once the game is done with it). Speeds join up:
  // it pulls away from the back, brakes into the corner and comes out at the
  // speed the game starts it at; at the far end it leaves at the speed the
  // game slowed it to and accelerates away.
  const TURN_R = CAR.turn * S;
  const CAR_MPS = (f) => CAR.speed * f * 60 * S; // game speed share -> metres per second
  // The path from the back of a farm road (side -1/1) to the fight line: s metres along it.
  function roadPath(side, s) {
    const cj = carJoin(side), inward = -side;
    const straight = -TURN_R - ROAD_BACK;
    if (s <= straight) return { x: cj, z: ROAD_BACK + Math.max(0, s), tx: 0, tz: 1 };
    const phi = Math.min(Math.PI / 2, (s - straight) / TURN_R);
    return {
      x: cj + inward * TURN_R - inward * TURN_R * Math.cos(phi),
      z: -TURN_R + TURN_R * Math.sin(phi),
      tx: inward * Math.sin(phi), tz: Math.cos(phi),
    };
  }
  const ROAD_LEN = -TURN_R - ROAD_BACK + (Math.PI / 2) * TURN_R;
  let carShown = null; // { side, t0 } while it drives away after the game drops it
  let carModels = [];   // from the Blender scene: [{ model, wheels: [{ o, r }] }], one per pass
  const carLast = new THREE.Vector3();
  let carLastOn = false;
  // Which car this pass is, and its wheels turning by the distance it moved.
  function dressCar(n) {
    if (!carModels.length) return;
    const pick = carModels[((n || 0) % carModels.length + carModels.length) % carModels.length];
    for (const m of carModels) m.model.visible = m === pick;
    const d = carLastOn ? car.position.distanceTo(carLast) : 0;
    carLast.copy(car.position); carLastOn = true;
    for (const w of pick.wheels) w.o.rotation.z -= d / w.r;
  }
  function updateCar(c, now) {
    updateCarPath(c, now);
    if (!car.visible) { carLastOn = false; return; }
    dressCar(c ? c.n : carShown && carShown.n);
  }
  function updateCarPath(c, now) {
    const faceTo = (dx, dz) => Math.atan2(-dz, dx); // rotation.y that points +x along (dx, dz)
    if (c && c.phase === 'warn') {
      // From a standstill at the back: speed up, then brake into the corner.
      const side = c.dir > 0 ? -1 : 1;
      const T = CAR.warn / 60, u = 1 - c.timer / CAR.warn, v = CAR_MPS(CAR.turnSpeed) * T;
      const s = (3 * ROAD_LEN - v) * u * u + (v - 2 * ROAD_LEN) * u * u * u;
      const p = roadPath(side, s);
      car.position.set(p.x, 0, p.z);
      car.rotation.y = faceTo(p.tx, p.tz);
      car.visible = true;
      carShown = { side: -side, dir: c.dir, t0: null, n: c.n };
      return;
    }
    if (c && c.phase === 'drive') {
      car.position.set(toX(c.x), 0, 0);
      car.rotation.y = faceTo(c.dir, 0);
      car.visible = true;
      carShown = { side: c.dir, dir: c.dir, t0: null, n: c.n };
      return;
    }
    // Gone from the game: round the corner and up the farm road, speeding up.
    if (carShown) {
      if (carShown.t0 === null) carShown.t0 = now;
      const T = 1.8, u = (now - carShown.t0) / 1000 / T;
      if (u >= 1) { carShown = null; car.visible = false; return; }
      const v = CAR_MPS(CAR.exitSpeed) * T;
      const s = v * u + (ROAD_LEN - v) * u * u;
      const p = roadPath(carShown.side, ROAD_LEN - s);
      car.position.set(p.x, 0, p.z);
      car.rotation.y = faceTo(-p.tx, -p.tz);
      return;
    }
    car.visible = false;
  }

  // Real scenery from Blender: a stage listed in assets/stages/manifest.json
  // has assets/stages/<id>.glb (exported from the template in blender/),
  // which replaces its grey-box. Its 'car' and 'cow_1'... 'cow_4' objects take
  // over from the placeholders and move the same way (a cow's own animation
  // plays if it has one). Anything named GUIDE_... is a layout aid, never shown.
  const mixers = [];
  // A lawn: glTF can't carry the Blender file's hair grass, so it's drawn
  // here as shell grass -- thin stacked copies of the scene's 'lawn_bed' mesh
  // (the orchard's ground minus the roads, and the gentle hillsides around
  // it), each lifted a little further along the surface and keeping only the
  // parts of a scattered pattern of strands that reach that high. Coloured
  // from the ground's own grass texture; the tips sway in a gusting breeze.
  const lawnTime = { value: 0 };
  function addLawn(root) {
    const bed = root.getObjectByName('lawn_bed');
    const ground = root.getObjectByName('ground_hilltop');
    if (!bed || !bed.isMesh || !ground || !ground.isMesh) return;
    root.updateMatrixWorld(true);
    bed.removeFromParent(); // it's only the shape to grow on
    const LAYERS = 14, HEIGHT = 0.11;
    const geo = bed.geometry;
    geo.applyMatrix4(bed.matrixWorld);
    geo.setAttribute('lawnMask', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count).fill(1), 1));
    const mat = new THREE.MeshLambertMaterial({ map: ground.material.map, color: ground.material.color });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = lawnTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float lawnMask;
          uniform float uTime;
          varying float vLayer, vMask;
          varying vec2 vSpot;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vLayer = (float(gl_InstanceID) + 1.0) / ${LAYERS}.0;
          vMask = lawnMask;
          vSpot = transformed.xz;
          transformed += normal * (vLayer * ${HEIGHT});
          // Wind: a slow swell with faster gusts running across the field.
          float gust = sin(uTime * 1.3 + transformed.x * 0.35 + transformed.z * 0.2)
                     + 0.5 * sin(uTime * 2.7 + transformed.x * 0.9 - transformed.z * 0.6);
          float bend = vLayer * vLayer;
          transformed.x += (0.035 + 0.025 * gust) * bend;
          transformed.z += 0.015 * gust * bend;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying float vLayer, vMask;
          varying vec2 vSpot;
          float lawnHash(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
          float lawnNoise(vec2 q) {
            vec2 i = floor(q), f = fract(q); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(lawnHash(i), lawnHash(i + vec2(1, 0)), f.x), mix(lawnHash(i + vec2(0, 1)), lawnHash(i + vec2(1, 1)), f.x), f.y);
          }`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          // One strand per small cell, each its own height, thinning to a tip.
          vec2 c = vSpot * 32.0, id = floor(c);
          float h = mix(0.35, 1.0, lawnHash(id)) * vMask;
          h *= smoothstep(32.0, 20.0, distance(vSpot, cameraPosition.xz)); // far off, just the ground
          vec2 off = vec2(lawnHash(id + 17.0), lawnHash(id + 31.0)) - 0.5;
          float r = length(fract(c) - 0.5 - off * 0.5);
          if (vLayer > h || r > 0.48 * (1.0 - vLayer / max(h, 1e-3))) discard;`)
        .replace('#include <map_fragment>', `
          // The texture again at another scale and angle, blended by slow noise,
          // so its tiling doesn't show as a checkerboard.
          vec2 uv2 = mat2(0.8, -0.6, 0.6, 0.8) * vMapUv * 0.43 + 0.17;
          vec3 grassCol = mix(texture2D(map, vMapUv).rgb, texture2D(map, uv2).rgb, smoothstep(0.3, 0.7, lawnNoise(vSpot * 0.12)));
          grassCol = mix(grassCol, vec3(dot(grassCol, vec3(0.3, 0.55, 0.15))) * vec3(1.0, 0.96, 0.82), 0.2);
          diffuseColor.rgb *= grassCol * mix(0.5, 1.12, vLayer) * (0.88 + 0.24 * lawnHash(id + 5.0)); // darker at the roots`);
    };
    const lawn = new THREE.InstancedMesh(geo, mat, LAYERS);
    for (let i = 0; i < LAYERS; i++) lawn.setMatrixAt(i, new THREE.Matrix4());
    lawn.name = 'lawn';
    lawn.receiveShadow = true;
    lawn.castShadow = false;
    lawn.frustumCulled = false; // the layers rise above the plane's own bounds
    root.add(lawn);
  }
  // The telephone poles (and each span of wire) run off down the hill and
  // fade out as they go: each gets its own see-through copy of its material,
  // fading by how far back it stands.
  function fadeFarPoles(root) {
    const FADE_FROM = 55, FADE_TO = 115; // metres behind the fight line
    const box = new THREE.Box3(), mid = new THREE.Vector3();
    root.updateMatrixWorld(true);
    const items = [];
    root.traverse((o) => { if (/^(telephone_pole_\d+|pole_wires_[LR]_\d+)$/.test(o.name)) items.push(o); });
    for (const item of items) {
      box.setFromObject(item).getCenter(mid);
      const back = -mid.z;
      if (back <= FADE_FROM) continue;
      const k = Math.min(1, (back - FADE_FROM) / (FADE_TO - FADE_FROM));
      const op = 1 - k * k * (3 - 2 * k);
      if (op <= 0.01) { item.visible = false; continue; }
      item.traverse((m) => {
        if (!m.isMesh) return;
        m.material = m.material.clone();
        m.material.transparent = true;
        m.material.opacity = op;
        m.material.depthWrite = op > 0.5;
        m.castShadow = false;
      });
    }
  }
  // The mud road's wet patches catch the sky all along it, not only where
  // the sun happens to glint: the road reflects a soft sky (the same colours
  // as the backdrop), and its baked roughness keeps the dry bits matte.
  function wetRoads(root) {
    const sky = canvasTexture(gradientCanvas([[0, '#9ebdd2'], [0.45, '#c9d4d0'], [0.5, '#d9c9a6'], [0.56, '#6f6150'], [1, '#3a3229']]));
    sky.mapping = THREE.EquirectangularReflectionMapping;
    const env = new THREE.PMREMGenerator(renderer).fromEquirectangular(sky).texture;
    root.traverse((o) => {
      if (!o.isMesh || !/^road_/.test(o.name)) return;
      o.material = o.material.clone();
      o.material.envMap = env;
      o.material.envMapIntensity = 1.1;
    });
  }
  function takeOver(slot, node) {
    node.removeFromParent();
    node.position.set(0, 0, 0);
    node.rotation.set(0, 0, 0);
    for (const c of [...slot.children]) slot.remove(c);
    slot.add(node);
  }
  async function loadStageScenes() {
    let list = [];
    try {
      const r = await fetch('assets/stages/manifest.json');
      if (r.ok) list = (await r.json()).scenes || [];
    } catch (e) { return; }
    if (!list.includes('orchard')) return;
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().loadAsync('assets/stages/orchard.glb');
      const root = gltf.scene;
      const guides = [];
      root.traverse((o) => {
        if (o.name.startsWith('GUIDE_')) guides.push(o);
        if (o.isMesh) o.castShadow = o.receiveShadow = true;
        // The painted horizon (the mountain photo): far beyond the fog, and no shadows.
        if (o.isMesh && o.name.startsWith('backdrop_sky')) {
          o.material.fog = false;
          o.castShadow = o.receiveShadow = false;
        }
      });
      guides.forEach((o) => o.removeFromParent());
      // The apple tree's leaves come forward round the branches, but never
      // hide a fighter: drawn after the rest of the scene without writing
      // depth, so the fighters (drawn after them) always show in front.
      const treeLeaves = root.getObjectByName('apple_tree_leaves');
      if (treeLeaves) {
        treeLeaves.traverse((m) => {
          if (!m.isMesh) return;
          m.material = m.material.clone();
          m.material.depthWrite = false;
          m.renderOrder = 1;
        });
      }
      addLawn(root);
      fadeFarPoles(root);
      wetRoads(root);
      const carNode = root.getObjectByName('car');
      if (carNode) {
        takeOver(car, carNode);
        // The cars inside it ('car_avalon', 'car_x6', ...) take turns, and
        // their '..._wheel_..' parts roll.
        carModels = carNode.children.filter((o) => /^car_/.test(o.name)).map((model) => {
          const wheels = [];
          model.traverse((o) => {
            if (!/_wheel_/.test(o.name)) return;
            const size = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
            wheels.push({ o, r: Math.max(0.05, size.y / 2) });
          });
          return { model, wheels };
        });
      }
      cows.forEach((c, i) => {
        const node = root.getObjectByName('cow_' + (i + 1));
        if (!node) return;
        takeOver(c.cow, node);
        c.legs = []; c.custom = true;
      });
      // Out with the grey-box scenery; the moving parts stay (now wearing the new models).
      const keep = new Set([car, ...cows.map((c) => c.cow)]);
      for (const child of [...orchard.children]) if (!keep.has(child)) orchard.remove(child);
      orchard.add(root);
      // Each animation plays on whichever object holds what it moves (the
      // scenery, the car, or a cow as it wanders).
      const owners = [root, car, ...cows.map((c) => c.cow)];
      const byOwner = new Map();
      for (const clip of gltf.animations) {
        const target = clip.tracks.length ? clip.tracks[0].name.split('.')[0] : null;
        const owner = owners.find((o) => target && o.getObjectByName(target));
        if (!owner) continue;
        if (!byOwner.has(owner)) byOwner.set(owner, new THREE.AnimationMixer(owner));
        const action = byOwner.get(owner).clipAction(clip);
        // A cow's '..._walk' and '..._graze' clips both run; updateCows blends
        // between them as it walks and stops.
        const cow = cows.find((c) => c.cow === owner);
        const gait = cow && /(walk|graze)$/.exec(clip.name);
        if (gait) {
          cow[gait[1]] = action;
          action.setEffectiveWeight(0);
          owner.traverse((o) => { if (o.userData.stride) cow.stride = o.userData.stride; });
        }
        action.play();
      }
      mixers.push(...byOwner.values());
    } catch (e) {
      console.warn('[stage] could not load assets/stages/orchard.glb -- showing the grey-box', e);
    }
  }
  loadStageScenes();

  // ---- Fighter cards ----

  // The picture a card is drawn on: a canvas texture on a plane `w` x `h`
  // game pixels, with the fighter's feet `feetY` down from the top.
  function makeSheet(w, h, feetY) {
    const c = document.createElement('canvas');
    c.width = Math.round(w * CARD_RES);
    c.height = Math.round(h * CARD_RES);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w * S, h * S),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.01, side: THREE.DoubleSide, depthWrite: false }),
    );
    mesh.castShadow = true;
    // Cast the silhouette, not the whole rectangle.
    mesh.customDepthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.5, side: THREE.DoubleSide,
    });
    mesh.renderOrder = 2;
    mesh.visible = false;
    scene.add(mesh);
    return { w, h, feetY, canvas: c, ctx: c.getContext('2d'), tex, mesh };
  }

  function makeCard(z, slot) {
    const sheet = makeSheet(CARD_W, CARD_H, FEET_Y);

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

    // `wide`: made the first time it's needed (see updateCard).
    return { sheet, normal: sheet, wide: null, mesh: sheet.mesh, blob, ring, z, rotY: 0 };
  }

  const cards = { p1: makeCard(0.03, 'p1'), p2: makeCard(-0.03, 'p2') };

  function updateCard(card, f, dt) {
    // Nathan's Overgrowth punches reach far past the normal card, so while
    // it's on he's drawn on a wide one.
    const wantWide = f.buffReachMul > 1;
    if (wantWide && !card.wide) card.wide = makeSheet(CARD_W_WIDE, CARD_H_TALL, FEET_Y_TALL);
    const sheet = wantWide ? card.wide : card.normal;
    if (sheet !== card.sheet) { card.sheet.mesh.visible = false; card.sheet = sheet; card.mesh = sheet.mesh; }
    const { ctx, canvas: c } = sheet;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(CARD_RES, 0, 0, CARD_RES, (sheet.w / 2 - f.x) * CARD_RES, (sheet.feetY - f.y) * CARD_RES);
    const rig = Renderer.drawFighter(ctx, f, { card: true });
    sheet.tex.needsUpdate = true;

    // Paper flip: rotate toward the facing side instead of snapping.
    const target = f.facing > 0 ? 0 : Math.PI;
    const step = (Math.PI / FLIP_SECONDS) * dt;
    const diff = target - card.rotY;
    card.rotY = Math.abs(diff) <= step ? target : card.rotY + Math.sign(diff) * step;

    const m = card.mesh;
    m.visible = true;
    m.position.set(toX(f.x), toY(f.y - sheet.feetY + sheet.h / 2), card.z);
    m.rotation.y = card.rotY;
    // Balance mode: the shakier they are, the more the card wobbles, like
    // they're about to tip over.
    const shaky = f.shakiness > 0.4 ? (f.shakiness - 0.4) / 0.6 : 0;
    m.rotation.z = shaky && f.state !== 'ko' ? Math.sin(performance.now() / (110 - 50 * shaky)) * 0.09 * shaky : 0;

    const overStage = f.x > STAGE_LEFT_EDGE && f.x < STAGE_RIGHT_EDGE;
    // Standing on a branch or the car: the shadow and ring go on that, not the floor.
    const floorY = f.platform && f.grounded ? f.y : GROUND_Y;
    const floor3 = toY(floorY);
    const height = (Math.max(0, floorY - f.y) + rig.lift) * S;
    const k = Math.max(0.25, 1 - height / 2.4);
    const stretch = 1 + 1.1 * rig.lying;
    card.blob.visible = (overStage || !!f.platform) && f.y <= floorY + 1;
    card.blob.position.set(toX(f.x), floor3 + 0.004, card.z);
    card.blob.scale.set(f.width * S * 0.42 * k * stretch, f.width * S * 0.16 * k, 1);
    card.blob.material.opacity = 0.38 * k;

    card.ring.visible = card.blob.visible;
    card.ring.position.set(toX(f.x), floor3 + 0.006, card.z);
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

  // Which part of the game world the sheets cover. The arena fits the
  // screen; on bigger stages they follow the camera, covering what it sees
  // at a resolution that drops as it zooms out (nothing is lost on screen).
  function fxView() {
    if (currentLook === 'arena') return { x0: 0, y0: 0, k: 1 };
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const seen = (2 * camPos.z * tanV * camera.aspect) / S;
    const vw = THREE.MathUtils.clamp(seen * 1.25, CANVAS_WIDTH, 3400);
    const k = fxCanvas.width / vw, vh = fxCanvas.height / k;
    return { x0: camTarget.x / S + CANVAS_WIDTH / 2 - vw / 2, y0: CANVAS_HEIGHT + FX_PAD - vh, k }; // (bottom edge where the arena's is)
  }

  function updateFx(state) {
    const v = fxView();
    for (const [sheet, c] of [[fxSheet, fxCanvas], [backFxSheet, backFxCanvas]]) {
      c.getContext('2d').setTransform(1, 0, 0, 1, 0, 0);
      c.getContext('2d').clearRect(0, 0, c.width, c.height);
      c.getContext('2d').setTransform(v.k, 0, 0, v.k, -v.x0 * v.k, -v.y0 * v.k);
      sheet.scale.setScalar(1 / v.k);
      sheet.position.x = toX(v.x0 + c.width / v.k / 2);
      sheet.position.y = toY(v.y0 + c.height / v.k / 2);
    }
    AbilityFX.drawBack(backFxCtx, state.p1);
    AbilityFX.drawBack(backFxCtx, state.p2);
    backFxTex.needsUpdate = true;

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

  // Bomb mode wears an apple (assets/models/apple.glb, made from the scan in
  // blender/): it ripens from its own colour to glowing red as the fuse burns,
  // blinking faster, with the fuse spark at the stem.
  let apple = null;
  const appleMats = [];
  const appleGlow = new THREE.Color('#ff2a10');
  (async () => {
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().loadAsync('assets/models/apple.glb');
      apple = gltf.scene;
      apple.scale.setScalar(BALL_RADIUS * S * 1.1); // the model's body has radius 1
      apple.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.material = o.material.clone();
        o.material.emissive = appleGlow.clone();
        o.material.emissiveIntensity = 0;
        appleMats.push({ mat: o.material, base: o.material.color.clone() });
      });
      apple.visible = false;
      ballGroup.add(apple);
    } catch (e) {
      console.warn('[ball] could not load the apple -- bombs stay round', e);
    }
  })();

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
    const asApple = !!apple && mode !== 'rally';
    ballMesh.visible = !asApple;
    if (apple) apple.visible = asApple;
    let d = { heat: 0 };
    if (asApple) {
      d = Game.ballDanger(b);
      apple.rotation.z = -b.spin;
      // Ripens towards hot red as the fuse burns; the glow blinks with the warning light.
      for (const { mat, base } of appleMats) {
        mat.color.copy(base).lerp(appleGlow, d.heat * 0.6);
        mat.emissiveIntensity = d.lit ? 0.15 + d.heat * 1.3 : d.heat * 0.2;
      }
      haloMat.color.set('#ff4632');
      halo.scale.setScalar(BALL_RADIUS * S * (3 + 2 * d.heat));
      haloMat.opacity = d.lit ? 0.3 + 0.6 * d.heat : 0.05;
      spark.visible = true;
      // The fuse burns at the stem, which turns with the spin.
      const r = BALL_RADIUS * S * 1.25;
      spark.position.set(Math.sin(b.spin) * r, Math.cos(b.spin) * r, 0);
      spark.scale.setScalar(BALL_RADIUS * S * (1.1 + 0.4 * Math.sin(now / 40)));
    } else if (mode === 'rally') {
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
      dist = THREE.MathUtils.clamp(dist, 7, LOOKS[currentLook].maxDist);
      // Keep the view over the stage (the arena's: +-3.2).
      tx = THREE.MathUtils.clamp((ax + bx) / 2, toX(STAGE_LEFT_EDGE) + 1.6, toX(STAGE_RIGHT_EDGE) - 1.6);
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

    // The stage being played (or last played, behind the menus).
    useStageLook(Stage.id());
    frameCamera(state, dt, now);
    // The sun follows the view, so its shadows cover wherever the fight is.
    sun.position.set(camTarget.x + 3, 9, 7);
    sun.target.position.set(camTarget.x, 0, 0);

    if (state) {
      updateCard(cards.p1, state.p1, dt);
      updateCard(cards.p2, state.p2, dt);
      updateFx(state);
      updateBall(state.ball, state.ballMode, now);
    } else {
      updateBall(null, null, now);
      for (const c of Object.values(cards)) { c.mesh.visible = false; c.blob.visible = false; c.ring.visible = false; }
      fxCtx.setTransform(1, 0, 0, 1, 0, 0);
      fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
      fxTex.needsUpdate = true;
    }
    fxSheet.visible = backFxSheet.visible = !!state;

    if (currentLook === 'arena') {
      for (const isl of islands) {
        isl.position.y = isl.userData.baseY + Math.sin(now * 0.0005 + isl.userData.bob) * 0.25;
      }
      updateBeams(now);
      updateEmbers(now);
      // Pulsing runes and lip glow, in step with the 2D stage.
      const pulse = 0.35 + 0.25 * Math.sin(now / 1000 * 2);
      faceMat.emissiveIntensity = 0.3 + pulse * 1.1;
      trimMat.emissiveIntensity = 0.6 + pulse * 0.8;
    } else if (currentLook === 'orchard') {
      for (const m of mixers) m.update(dt);
      lawnTime.value = now / 1000;
      updateCows(now);
      updateCar(state ? Stage.car() : null, now);
    }

    renderer.render(scene, camera);
  }

  window.Renderer3D = {
    isActive: () => true,
    render,
  };
  window.dispatchEvent(new Event('renderer3d-ready'));
}
