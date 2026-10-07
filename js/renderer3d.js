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
  // Graphics settings (graphics.js): most apply live through
  // applyGraphics() below; the stage file and antialiasing at the next load.
  let gfx = Graphics.config();
  let CARD_RES = gfx.cardRes; // texture pixels per game pixel
  const FLIP_SECONDS = 0.14;


  const overlay = document.getElementById('game-canvas');
  const canvas = document.createElement('canvas');
  canvas.id = 'game-canvas-3d';
  overlay.parentNode.insertBefore(canvas, overlay);

  // (powerPreference: on laptops with two GPUs, ask for the strong one.)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: gfx.antialias, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = gfx.shadows !== 'off';
  renderer.shadowMap.type = gfx.shadows === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 420); // (far: the orchard's giant can be ~170 m out)

  function resize() {
    const w = canvas.clientWidth || CANVAS_WIDTH;
    const h = canvas.clientHeight || CANVAS_HEIGHT;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, gfx.maxPixelRatio));
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
  sun.shadow.mapSize.set(gfx.shadows === 'high' ? 2048 : 1024, gfx.shadows === 'high' ? 2048 : 1024);
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
  // Once the Blender scene arrives, the low-poly scenery below moves in here:
  // shown only with the Cartoon graphics setting.
  const toyScenery = new THREE.Group();
  toyScenery.name = 'toy_scenery';
  orchard.add(toyScenery);

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
  // The orchard's sign: on the grass behind the fence, left of the apple tree
  // (the real model in addSign, the low-poly one with the Cartoon scenery).
  const SIGN = { x: -3.0, z: -3.1, height: 1.84, turn: 0.18 }; // 3D units; turn: radians toward the fight

  // The low-poly orchard: the same layout and colours as the Blender scene
  // (blender/orchard.blend -- positions measured from it), as simple shapes.
  // It's what the Cartoon graphics setting shows, and what's up while the
  // Blender scene loads.
  {
    const L = toX(orchardDef.left), R = toX(orchardDef.right), W = R - L, CX = (L + R) / 2;
    const HILL_DEPTH = 50, HILL_FRONT = 18, HILL_H = 16.7; // the hilltop, down to the gorge floors
    const mat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true });
    const DRY_GRASS = '#a38a5f', CLIFF = '#6e624f';
    const grassMat = mat(DRY_GRASS), cliffMat = mat(CLIFF);
    const slab = (name, x1, x2, top, z1, z2, depth, m) => {
      const s = new THREE.Mesh(new THREE.BoxGeometry(x2 - x1, depth, z2 - z1), m || [cliffMat, cliffMat, grassMat, cliffMat, cliffMat, cliffMat]);
      s.name = name;
      s.position.set((x1 + x2) / 2, top - depth / 2, (z1 + z2) / 2);
      s.receiveShadow = true;
      orchard.add(s);
      return s;
    };

    // The hilltop between the gorges (the ring-out edges), dry autumn grass;
    // the land carrying on behind it, where the barn stands; and past each
    // gorge, the far banks with their trees and telephone poles.
    slab('ground_hilltop', L, R, 0, HILL_FRONT - HILL_DEPTH, HILL_FRONT, HILL_H);
    slab('terrain_back', -45, 45, -0.3, -75, HILL_FRONT - HILL_DEPTH, 16);
    for (const side of [-1, 1]) slab('terrain_bank', side < 0 ? -45 : 17, side < 0 ? -17 : 45, -2.2, -75, 40, 15);
    // The gorge floors: dark autumn woods far below.
    const valley = new THREE.Mesh(new THREE.PlaneGeometry(400, 260), mat('#5e4128'));
    valley.name = 'backdrop_valley';
    valley.rotation.x = -Math.PI / 2;
    valley.position.set(0, -16.6, -40);
    orchard.add(valley);

    // The muddy road along the fight line, and the farm roads that join it from the back.
    const roadMat = mat('#3a2e24');
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

    // The climbable apple tree: pale bark, olive leaves, branches and crown
    // exactly where the platforms are.
    const tree = new THREE.Group();
    tree.name = 'tree_platform';
    const bark = '#cbc4b6', leaf = '#76692f';
    const crown = orchardDef.platforms.find((p) => p.id === 'crown');
    const crownY = toY(crown.y);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.32, crownY + 0.2, 8), mat(bark));
    trunk.name = 'tree_trunk';
    trunk.position.set(toX(640), (crownY + 0.2) / 2, -0.55);
    trunk.castShadow = true;
    tree.add(trunk);
    for (const p of orchardDef.platforms) {
      const x1 = toX(p.x1), x2 = toX(p.x2), y = toY(p.y);
      if (p.id === 'crown') {
        tree.add(box('tree_crown_top', x2 - x1, 0.16, 1.1, leaf, (x1 + x2) / 2, y - 0.08, -0.25));
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
    const leafMat = mat(leaf);
    for (const [x, y, z, r] of [[0, 2.55, -1.3, 1.25], [-1.0, 2.2, -1.1, 0.9], [1.0, 2.25, -1.1, 0.9], [-1.6, 1.25, -0.9, 0.55], [1.6, 1.25, -0.9, 0.55], [0.4, 3.1, -1.6, 0.8]]) {
      const s = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), leafMat);
      s.name = 'tree_leaves';
      s.position.set(toX(640) + x, y, z);
      s.castShadow = true;
      tree.add(s);
    }
    // Apples on the ground under it.
    const appleMat = mat('#a8321f');
    for (const [x, z] of [[-1.2, -1.4], [-0.6, -2.1], [0.5, -1.2], [1.3, -1.9], [0.1, -2.3]]) {
      const a = new THREE.Mesh(new THREE.IcosahedronGeometry(0.07, 0), appleMat);
      a.name = 'apple_fallen';
      a.position.set(toX(640) + x, 0.06, z);
      tree.add(a);
    }
    orchard.add(tree);

    // Autumn trees: a trunk and a round crown, one mesh each for all of them
    // (instanced), coloured per tree. [x, z, crown size, ground y]
    const ORCHARD = [];
    const COLS = [-8.65, -6.1, -3.3, -0.7, 1.95, 4.65, 7.35];
    for (const [z, from] of [[-4.6, 0], [-8.3, 2], [-11.8, 2], [-15.5, 0], [-19.0, 0], [-22.7, 0]]) {
      for (let c = from; c < COLS.length; c++) ORCHARD.push([COLS[c] + Math.sin(c * 7.1 + z) * 0.12, z + Math.cos(c * 3.3 + z) * 0.12, 0.95 + 0.12 * Math.sin(c * 5.7 + z * 1.3), 0]);
    }
    // ...and the trees on the far banks, past the gorges.
    const BANKS = [[-22.35, 6.05, 1.1, -2.2], [-24.3, -5, 1.25, -2.2], [-22.65, -13.35, 1, -2.2], [-25.85, -24.45, 1, -2.2], [21.6, 3.5, 1.15, -2.2], [22.7, -8.3, 1.25, -2.2], [26.4, -15.45, 1.2, -2.2], [23.6, -24.95, 1.05, -2.2]];
    const AUTUMN = ['#d8704a', '#c95f3e', '#e08550', '#b8553a', '#d27a45'];
    const trees = [...ORCHARD, ...BANKS];
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.15, 1, 6), mat('#7a5c3a'), trees.length);
    const tops = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), mat('#ffffff'), trees.length);
    trunks.name = 'orchard_rows_trunks';
    tops.name = 'orchard_rows_tops';
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
    trees.forEach(([x, z, r, gy], i) => {
      mtx.compose(new THREE.Vector3(x, gy + 0.5, z), q, new THREE.Vector3(1, 1, 1)); trunks.setMatrixAt(i, mtx);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), i * 1.7);
      mtx.compose(new THREE.Vector3(x, gy + 0.9 + r * 0.75, z), q, new THREE.Vector3(r, r * 0.9, r)); tops.setMatrixAt(i, mtx);
      q.identity();
      tops.setColorAt(i, col.set(AUTUMN[(i * 7 + (i >> 2)) % AUTUMN.length]));
    });
    trunks.castShadow = tops.castShadow = true;
    orchard.add(trunks, tops);

    // The white wooden fence along the back of the fight area.
    const fence = new THREE.Group();
    fence.name = 'fence';
    for (let x = -8.7; x < 9.4; x += 1.5) {
      fence.add(box('fence_post', 0.1, 0.7, 0.1, '#d9d1c4', x, 0.35, -2.3));
      if (x + 1.5 < 9.5) fence.add(box('fence_rail', 1.5, 0.07, 0.05, '#e3dccf', x + 0.75, 0.52, -2.3));
    }
    orchard.add(fence);

    // The red tractor parked among the trees, left of centre.
    const tractor = new THREE.Group();
    tractor.name = 'tractor';
    tractor.add(box('tractor_body', 1.6, 0.6, 0.9, '#a3301f', 0.15, 0.85, 0));
    tractor.add(box('tractor_hood', 0.8, 0.45, 0.7, '#a3301f', 0.95, 0.75, 0));
    tractor.add(box('tractor_cab', 0.75, 0.75, 0.85, '#2a2a2a', -0.35, 1.5, 0));
    tractor.add(box('tractor_roof', 0.95, 0.07, 1.0, '#a3301f', -0.35, 1.9, 0));
    tractor.add(box('tractor_stack', 0.08, 0.5, 0.08, '#2a2a2a', 1.0, 1.2, 0.2));
    const tyre = mat('#232120');
    for (const [x, z, r, w] of [[-0.45, 0.62, 0.62, 0.35], [-0.45, -0.62, 0.62, 0.35], [1.0, 0.5, 0.36, 0.22], [1.0, -0.5, 0.36, 0.22]]) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 12), tyre);
      t.name = 'tractor_wheel';
      t.rotation.x = Math.PI / 2;
      t.position.set(x, r, z);
      t.castShadow = true;
      tractor.add(t);
    }
    tractor.position.set(-7.45, 0, -10.15);
    tractor.rotation.y = 0.5;
    orchard.add(tractor);

    // A cow lying down among the trees.
    const lying = new THREE.Group();
    lying.name = 'cow_lying';
    lying.add(box('cow_body', 1.2, 0.45, 0.6, '#f2efe8', 0, 0.25, 0));
    lying.add(box('cow_patch', 0.45, 0.38, 0.62, '#2c2a28', 0.15, 0.3, 0));
    lying.add(box('cow_head', 0.35, 0.33, 0.32, '#f2efe8', 0.72, 0.42, 0.1));
    lying.add(box('cow_nose', 0.12, 0.16, 0.28, '#e8a8a0', 0.9, 0.36, 0.1));
    lying.position.set(0.75, 0, -6.5);
    lying.rotation.y = -0.6;
    orchard.add(lying);

    // The barn and silo, far back behind the orchard: red walls, a dark
    // gable roof (ridge running away from the camera), a lean-to on the
    // right, and a pale concrete silo with a domed cap on the left.
    const barn = new THREE.Group();
    barn.name = 'barn';
    const BARN_LEN = 16;
    barn.add(box('barn_walls', 10, 4.2, BARN_LEN, '#9b3a2c', 0, 2.1, 0));
    const roofShape = new THREE.Shape([new THREE.Vector2(-5.25, 0), new THREE.Vector2(0, 3.7), new THREE.Vector2(5.25, 0)]);
    const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(roofShape, { depth: BARN_LEN + 0.6, bevelEnabled: false }), mat('#4b4642'));
    roof.name = 'barn_roof';
    roof.position.set(0, 4.1, -(BARN_LEN + 0.6) / 2);
    roof.castShadow = true;
    barn.add(roof);
    barn.add(box('barn_door', 3.2, 3.2, 0.1, '#7d2c22', 0, 1.6, BARN_LEN / 2 + 0.04));
    barn.add(box('barn_door_trim', 3.4, 0.2, 0.12, '#e8e0d2', 0, 3.3, BARN_LEN / 2 + 0.05));
    barn.add(box('barn_loft', 1.4, 1.2, 0.1, '#e8e0d2', 0, 5.4, BARN_LEN / 2 + 0.04));
    barn.add(box('barn_leanto', 3, 2.2, BARN_LEN * 0.7, '#8f3528', 6.5, 1.1, 0));
    const lean = box('barn_leanto_roof', 3.4, 0.15, BARN_LEN * 0.72, '#4b4642', 6.5, 2.5, 0);
    lean.rotation.z = -0.3;
    barn.add(lean);
    const silo = new THREE.Group();
    silo.name = 'silo';
    const siloMat = mat('#b9b4aa');
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 7.4, 14), siloMat);
    tube.position.y = 3.7;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1.75, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat('#8d8a84'));
    dome.position.y = 7.4;
    for (const y of [1.6, 3.4, 5.2]) silo.add(box('silo_band', 3.48, 0.12, 3.48, '#9d988f', 0, y, 0));
    tube.castShadow = dome.castShadow = true;
    silo.add(tube, dome);
    silo.position.set(-7.5, 0, 3);
    barn.add(silo);
    barn.position.set(0, -0.3, -43);
    orchard.add(barn);

    // Telephone poles marching away down both far banks, with their wires.
    const POLES = 15;
    const poleSpots = [];
    for (const side of [-1, 1]) {
      for (let i = 0; i < POLES; i++) {
        const out = Math.max(0, i - 4) * 0.58, drop = Math.max(0, i - 4) * 0.68;
        poleSpots.push({ x: side * (20.05 + out), z: 6.55 - 9.5 * i, top: 7 - drop, side, i });
      }
    }
    const poleMat = mat('#6f5e52');
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.11, 0.14, 1, 6), poleMat, poleSpots.length);
    const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(2.2, 0.12, 0.12), poleMat, poleSpots.length);
    poles.name = 'telephone_poles';
    bars.name = 'telephone_pole_bars';
    const wire = [];
    poleSpots.forEach((p, i) => {
      const h = p.top + 2.2 + Math.min(p.i, 4) * 0; // from the bank (y -2.2) up
      mtx.compose(new THREE.Vector3(p.x, p.top - h / 2, p.z), q, new THREE.Vector3(1, h, 1)); poles.setMatrixAt(i, mtx);
      mtx.compose(new THREE.Vector3(p.x, p.top - 0.4, p.z), q, new THREE.Vector3(1, 1, 1)); bars.setMatrixAt(i, mtx);
      const next = poleSpots[i + 1];
      if (next && next.side === p.side) {
        for (const dx of [-0.9, 0, 0.9]) wire.push(p.x + dx, p.top - 0.35, p.z, next.x + dx, next.top - 0.35, next.z);
      }
    });
    poles.castShadow = true;
    const wires = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(wire, 3)), new THREE.LineBasicMaterial({ color: '#2b2b2b' }));
    wires.name = 'pole_wires';
    orchard.add(poles, bars, wires);

    // The far mountains, like the photo on the Blender scene's horizon:
    // ridge after ridge fading from autumn rust to hazy blue-grey, filling
    // the horizon. [x, z, width, height, colour]
    for (const [x, z, sx, sy, color] of [
      [-150, -185, 80, 62, '#b4b8c2'], [-50, -188, 90, 70, '#b9bcc4'], [55, -186, 85, 66, '#b2b6c0'], [160, -182, 80, 60, '#b9bcc4'],
      [-110, -160, 70, 52, '#a6a3a2'], [-10, -165, 75, 56, '#aaa4a0'], [95, -158, 70, 50, '#a19d9c'], [185, -150, 55, 44, '#a6a3a2'], [-190, -150, 55, 44, '#aaa4a0'],
      [-140, -130, 60, 40, '#8f7262'], [-45, -135, 65, 44, '#94735f'], [45, -128, 60, 40, '#8c6c5c'], [140, -125, 60, 38, '#94735f'],
      [-95, -105, 50, 30, '#9a6447'], [0, -110, 55, 32, '#a06a4a'], [95, -102, 50, 28, '#97603f'], [-175, -100, 45, 26, '#a06a4a'], [175, -98, 45, 26, '#9a6447'],
    ]) {
      const h = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 8), new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true, fog: false }));
      h.name = 'backdrop_hill';
      h.scale.set(sx, sy * 0.62, sx * 0.35);
      h.position.set(x, -16, z);
      orchard.add(h);
    }
  }

  // The orchard sign, low-poly: two posts and a crossbar, the arched board
  // (gold edge) on iron brackets, its face painted on -- the same layout as
  // assets/models/sign.glb. Built at SIGN.height = 1.84 (scaled to it).
  {
    const sign = new THREE.Group();
    sign.name = 'orchard_sign_toy';
    const WOOD = '#7d7466', IRON = '#3b3631', GOLD = '#c9a04a';
    for (const side of [-1, 1]) {
      sign.add(box('sign_post', 0.14, 1.62, 0.14, WOOD, side * 0.73, 0.81, 0));
      for (const y of [0.58, 1.27]) sign.add(box('sign_bracket', 0.1, 0.03, 0.03, IRON, side * 0.62, y, 0));
    }
    sign.add(box('sign_rail', 1.6, 0.1, 0.08, WOOD, 0, 0.25, 0.06));
    // The board's outline: a rectangle with an arched top, set in at the shoulders.
    const BW = 0.6, BOT = 0.42, SH = 1.42, TOP = 1.84, AW = 0.49;
    const outline = (path) => {
      path.moveTo(-BW, BOT); path.lineTo(BW, BOT); path.lineTo(BW, SH); path.lineTo(AW, SH);
      path.absellipse(0, SH, AW, TOP - SH, 0, Math.PI, false);
      path.lineTo(-BW, SH); path.closePath();
      return path;
    };
    const DEPTH = 0.05;
    const board = new THREE.Mesh(
      new THREE.ExtrudeGeometry(outline(new THREE.Shape()), { depth: DEPTH, bevelEnabled: false, curveSegments: 10 }),
      [new THREE.MeshStandardMaterial({ color: '#1d3b2e', roughness: 1, flatShading: true }), new THREE.MeshStandardMaterial({ color: GOLD, roughness: 1, flatShading: true })],
    );
    board.name = 'sign_board';
    board.position.z = -DEPTH / 2;
    board.castShadow = board.receiveShadow = true;
    sign.add(board);
    // The face, painted: gold edge, the arched picture of a tree, the lettering.
    const CW = 512, CH = Math.round(CW * (TOP - BOT) / (BW * 2));
    const px = (x) => ((x + BW) / (BW * 2)) * CW, py = (y) => ((TOP - y) / (TOP - BOT)) * CH;
    const c = document.createElement('canvas');
    c.width = CW; c.height = CH;
    const g = c.getContext('2d');
    const trace = (inset) => { // the outline, `inset` canvas pixels in
      const k = inset / CW * BW * 2;
      g.beginPath();
      g.moveTo(px(-BW + k), py(BOT + k)); g.lineTo(px(BW - k), py(BOT + k)); g.lineTo(px(BW - k), py(SH));
      g.lineTo(px(AW - k), py(SH));
      g.ellipse(px(0), py(SH), px(AW - k) - px(0), py(SH) - py(TOP - k), 0, 0, Math.PI, true);
      g.lineTo(px(-BW + k), py(SH)); g.closePath();
    };
    g.fillStyle = '#1d3b2e'; trace(0); g.fill();
    g.strokeStyle = GOLD; g.lineWidth = 12; trace(6); g.stroke();
    g.strokeStyle = '#4f8a7a'; g.lineWidth = 4; trace(26); g.stroke();
    // The picture: an arched light-blue panel, gold-framed, with a little apple tree.
    const PX = px(0), PW = px(0.26) - px(0), PB = py(1.1), PT = py(1.62), PS = PT + PW;
    g.beginPath(); g.moveTo(PX - PW, PB); g.lineTo(PX - PW, PS); g.arc(PX, PS, PW, Math.PI, 0); g.lineTo(PX + PW, PB); g.closePath();
    g.fillStyle = '#b9d3e0'; g.fill();
    g.strokeStyle = GOLD; g.lineWidth = 8; g.stroke();
    g.fillStyle = '#6b4a2e'; g.fillRect(PX - 7, PB - 46, 14, 40);
    g.fillStyle = '#3f7d5c';
    for (const [dx, dy, r] of [[0, -98, 30], [-26, -76, 24], [26, -76, 24], [-14, -118, 20], [14, -118, 20], [0, -62, 22]]) { g.beginPath(); g.arc(PX + dx, PB + dy, r, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#a8321f';
    for (const [dx, dy] of [[-18, -84], [16, -100], [4, -70], [-6, -118], [24, -72]]) { g.beginPath(); g.arc(PX + dx, PB + dy, 4, 0, Math.PI * 2); g.fill(); }
    // The lettering.
    const fit = (text, font, maxW) => { g.font = font; const w = g.measureText(text).width; return w > maxW ? maxW / w : 1; };
    const write = (text, font, color, y, maxW, skew) => {
      const k = fit(text, font, maxW);
      g.save(); g.translate(CW / 2, y); g.transform(1, 0, skew, 1, 0, 0); g.scale(k, k);
      g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 0, 0);
      g.restore();
    };
    write('Alyson\'s', 'bold italic 96px "Brush Script MT", "Snell Roundhand", "Segoe Script", cursive', '#c0262e', py(0.93), CW * 0.66, -0.15);
    write('APPLE ORCHARD INC.', 'bold 40px "Trebuchet MS", "Arial Narrow", sans-serif', '#e0b85a', py(0.68), CW * 0.74, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const faceGeo = new THREE.ShapeGeometry(outline(new THREE.Shape()), 10);
    const uv = faceGeo.attributes.uv, pos = faceGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + BW) / (BW * 2), (pos.getY(i) - BOT) / (TOP - BOT));
    const face = new THREE.Mesh(faceGeo, new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
    face.name = 'sign_face';
    face.position.z = DEPTH / 2 + 0.002;
    face.receiveShadow = true;
    sign.add(face);
    sign.scale.setScalar(SIGN.height / TOP);
    sign.position.set(SIGN.x, 0, SIGN.z);
    sign.rotation.y = SIGN.turn;
    orchard.add(sign);
  }

  // Cows grazing and wandering behind the fence (scenery only). The first
  // turns round just short of the orchard sign (SIGN, x -3), in view left of the tree.
  const cows = [];
  {
    const white = '#f2efe8', black = '#2c2a28';
    for (const [z, xa, xb, speed, phase] of [[-3.4, -9, -4.8, 0.35, 0], [-6, 2.5, 9, 0.28, 2], [-9, -4, 4, 0.22, 4.5], [-12.5, 5, 11, 0.3, 1]]) {
      const cow = new THREE.Group();
      cow.name = 'cow';
      cow.add(box('cow_body', 1.2, 0.55, 0.5, white, 0, 0.75, 0));
      cow.add(box('cow_patch', 0.45, 0.4, 0.52, black, -0.15, 0.8, 0));
      const head = box('cow_head', 0.35, 0.35, 0.34, white, 0.72, 0.95, 0);
      cow.add(head);
      cow.add(box('cow_nose', 0.12, 0.18, 0.3, '#e8a8a0', 0.9, 0.88, 0));
      const legs = [];
      for (const [lx, lz] of [[0.45, 0.17], [0.45, -0.17], [-0.45, 0.17], [-0.45, -0.17]]) {
        const leg = box('cow_leg', 0.1, 0.5, 0.1, white, lx, 0.25, lz);
        legs.push(leg);
        cow.add(leg);
      }
      cow.position.set(xa, 0, z);
      orchard.add(cow);
      cows.push({ cow, legs, head, z, xa, xb, speed, phase });
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
      const custom = c.custom && !gfx.cartoon; // (Cartoon: the low-poly cow)
      if (!custom) c.cow.rotation.y = dir > 0 ? 0 : Math.PI;
      if (custom) {
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
      c.head.position.y = walking ? 0.95 : 0.62; // head down to graze
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

  // The low-poly orchard is drawn cartoon-style: flat bands of light and
  // shade (toon shading) instead of smooth lighting. Cheap, and it's what the
  // Cartoon graphics setting shows (also what's up while the Blender scene
  // loads on the others).
  {
    const tones = new Uint8Array([90, 170, 255]);
    const gradient = new THREE.DataTexture(tones, tones.length, 1, THREE.RedFormat);
    gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
    gradient.needsUpdate = true;
    const made = new Map();
    orchard.traverse((o) => {
      if (!o.isMesh || !o.material.isMeshStandardMaterial) return;
      const m = o.material;
      if (!made.has(m)) {
        made.set(m, new THREE.MeshToonMaterial({
          name: m.name, color: m.color, map: m.map, gradientMap: gradient, fog: m.fog,
          emissive: m.emissive, emissiveIntensity: m.emissiveIntensity,
        }));
      }
      o.material = made.get(m);
    });
  }

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
  const lawnLayers = { value: 14 }, lawnFar = { value: 32 };
  const LAWN_MAX_LAYERS = 14;
  let lawn = null, lawnFlat = null;
  function addLawn(root) {
    const bed = root.getObjectByName('lawn_bed');
    const ground = root.getObjectByName('ground_hilltop');
    if (!bed || !bed.isMesh || !ground || !ground.isMesh) return;
    root.updateMatrixWorld(true);
    bed.removeFromParent(); // it's only the shape to grow on
    const HEIGHT = 0.11;
    const geo = bed.geometry;
    geo.applyMatrix4(bed.matrixWorld);
    // With the grass turned off (Low), just the bed, wearing the grass texture.
    lawnFlat = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: ground.material.map, color: ground.material.color }));
    lawnFlat.name = 'lawn_flat';
    lawnFlat.receiveShadow = true;
    root.add(lawnFlat);
    geo.setAttribute('lawnMask', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count).fill(1), 1));
    const mat = new THREE.MeshLambertMaterial({ map: ground.material.map, color: ground.material.color });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = lawnTime;
      sh.uniforms.uLayers = lawnLayers;
      sh.uniforms.uFar = lawnFar;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float lawnMask;
          uniform float uTime, uLayers;
          varying float vLayer, vMask;
          varying vec2 vSpot;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vLayer = (float(gl_InstanceID) + 1.0) / uLayers;
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
          uniform float uFar;
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
          h *= smoothstep(uFar, uFar * 0.625, distance(vSpot, cameraPosition.xz)); // far off, just the ground
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
    lawn = new THREE.InstancedMesh(geo, mat, LAWN_MAX_LAYERS);
    for (let i = 0; i < LAWN_MAX_LAYERS; i++) lawn.setMatrixAt(i, new THREE.Matrix4());
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
  // The monster (stages.js def.monster): a giant -- a rigged humanoid with
  // its clips (assets/models/monster.glb -- Jon, rigged by tools/blender/rig_giant.py: swat, run, jump, look, grab, throw,
  // turn) --
  // moved along its lane to match the game's phases. The clips' own forward
  // travel is taken out (we move it), and it blends smoothly from one clip
  // to the next. Whoever it's holding is drawn in its hand.
  const MON = orchardDef.monster;
  const MON_SCALE = 5.5;           // ~9.5 m tall
  const MON_BLEND = 0.35;          // seconds to cross-fade between clips
  const THROW_RELEASE = 0.305;     // how far through the throw clip its hand lets go (matches stages.js fling/flingV)
  const THROW_SETTLED = 0.67;      // ...and where its follow-through has settled
  const newHand = () => ({ hand: null, knuckle: null, fingers: [], thumb: [], tips: [], thumbTip: null, curlAxis: null, thumbAxis: null, curl: 0 });
  const monster = { group: new THREE.Group(), mixer: null, acts: {}, w: {}, ready: false, last: null, hands: { Left: newHand(), Right: newHand() }, mats: [], yaw: undefined, ground: [] };
  monster.group.visible = false;
  orchard.add(monster.group);
  (async () => {
    if (!MON) return;
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().loadAsync('assets/models/monster.glb');
      const body = gltf.scene;
      body.scale.multiplyScalar(MON_SCALE);
      body.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true; o.frustumCulled = false;
          o.material = o.material.clone(); monster.mats.push(o.material);
        }
        const hm = o.isBone && /(Left|Right)Hand(Index|Middle|Ring|Pinky|Thumb)?(\d)?$/.exec(o.name);
        if (hm) {
          const h = monster.hands[hm[1]], part = hm[2], n = hm[3];
          if (!part) h.hand = o;
          else if (part === 'Middle' && n === '1') h.knuckle = o;
          if (part && part !== 'Thumb' && '123'.includes(n)) h.fingers.push(o);
          if (part && part !== 'Thumb' && n === '4') h.tips.push(o);
          if (part === 'Thumb' && '123'.includes(n)) h.thumb.push(o);
          if (part === 'Thumb' && n === '4') h.thumbTip = o;
        }
      });
      monster.group.add(body);
      // Which way its fingers bend: the axis that brings the fingertips
      // closest to the palm (measured once per hand, on the model as loaded).
      const v = new THREE.Vector3(), palm = new THREE.Vector3();
      const bestAxis = (bones, measure, angle) => {
        let best = null;
        for (const axis of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis), angle);
          const saved = bones.map((b) => b.quaternion.clone());
          bones.forEach((b) => b.quaternion.multiply(q));
          body.updateMatrixWorld(true);
          const d = measure();
          bones.forEach((b, i) => b.quaternion.copy(saved[i]));
          if (!best || d < best.d) best = { d, axis: new THREE.Vector3(...axis) };
        }
        body.updateMatrixWorld(true);
        return best && best.axis;
      };
      // (In the model's rest pose -- a T-pose, palms down -- a curl brings the
      // fingertips down and in; twisting or bending back doesn't.)
      for (const h of Object.values(monster.hands)) {
        if (!h.hand || !h.knuckle || !h.tips.length) continue;
        const fingerBones = h.fingers.filter((b) => b.name.endsWith('1'));
        const curlScore = () => h.tips.reduce((a, t) => a + t.getWorldPosition(v).y, 0) + 0.5 * h.tips.reduce((a, t) => a + t.getWorldPosition(v).distanceTo(h.hand.getWorldPosition(palm)), 0);
        h.curlAxis = bestAxis(fingerBones, curlScore, 0.6);
        if (h.thumbTip) h.thumbAxis = bestAxis(h.thumb.filter((b) => b.name.endsWith('1')), () => h.thumbTip.getWorldPosition(v).distanceTo(h.knuckle.getWorldPosition(palm)), 0.5);
      }
      monster.mixer = new THREE.AnimationMixer(body);
      for (const clip of gltf.animations) {
        for (const tr of clip.tracks) {
          if (!/Hips\.position$/.test(tr.name)) continue;
          // Take out the clip's travel (start-to-end drift); keep its bob and sway.
          const v = tr.values, n = v.length / 3, T = tr.times;
          for (let k = 0; k < 3; k++) {
            const d = v[(n - 1) * 3 + k] - v[k];
            for (let i = 0; i < n; i++) v[i * 3 + k] -= d * ((T[i] - T[0]) / (T[n - 1] - T[0] || 1));
          }
        }
        const act = monster.mixer.clipAction(clip);
        act.play(); act.paused = true; act.setEffectiveWeight(0);
        monster.acts[clip.name] = act; monster.w[clip.name] = 0;
      }
      monster.ready = true;
    } catch (e) {
      console.warn('[stage] could not load assets/models/monster.glb', e);
    }
  })();
  // Its route, in metres (x across, z towards the camera; 0 is the fight
  // line, the fence is at -2.3): in from far out in the valley to the right
  // (out past the end of the poles, where the barn doesn't hide it), up the
  // hill behind the orchard beside the barn, across in front of the barn
  // into its lane, and down the lane to just behind the fence. Back out the
  // same way. Its feet follow the ground (the scene's terrain, sampled).
  const MON_SIDE = 10.2, MON_Z = { barn: -33, lane: -26, runEnd: -11, front: -3.6 };
  const MON_FAR = [[38, -150], [18, -132], [MON_SIDE, -58], [MON_SIDE, -50]];
  const ease = (x) => x * x * (3 - 2 * x);
  const FIST = { 1: 1.3, 2: 1.5, 3: 1.0 }, THUMB = { 1: 0.35, 2: 0.55, 3: 0.45 };
  const MON_WALK = 3.07 * MON_SCALE, MON_STRIDE = 2.37 * MON_SCALE; // metres per loop of the walk / run clips
  // Along a route of [x, z] points, d metres in: where, and which way it's heading.
  function along(pts, d) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, z0] = pts[i], [x1, z1] = pts[i + 1], len = Math.hypot(x1 - x0, z1 - z0);
      if (d <= len || i === pts.length - 2) {
        const k = Math.min(1, d / (len || 1));
        return { x: x0 + (x1 - x0) * k, z: z0 + (z1 - z0) * k, yaw: Math.atan2(x1 - x0, z1 - z0) };
      }
      d -= len;
    }
  }
  const routeLen = (pts) => pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
  // Ground height: a ray down onto the scene's terrain, smoothed over a few
  // metres (a giant's stride doesn't feel every bump), cached on a 1 m grid.
  const groundCache = new Map(), groundRay = new THREE.Raycaster(), RAY_DOWN = new THREE.Vector3(0, -1, 0);
  function groundAt(x, z) {
    if (z > -24 || !monster.ground.length) return 0; // the orchard floor
    // Blended between the four nearest grid samples, so it glides rather than steps.
    const x0 = Math.floor(x), z0 = Math.floor(z), fx = x - x0, fz = z - z0;
    const g = (gx, gz) => groundSample(gx, gz);
    return (g(x0, z0) * (1 - fx) + g(x0 + 1, z0) * fx) * (1 - fz) + (g(x0, z0 + 1) * (1 - fx) + g(x0 + 1, z0 + 1) * fx) * fz;
  }
  function groundSample(x, z) {
    const key = Math.round(x) + ',' + Math.round(z);
    let h = groundCache.get(key);
    if (h === undefined) {
      let sum = 0, n = 0;
      for (const [dx, dz] of [[0, 0], [2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5]]) {
        groundRay.set(new THREE.Vector3(Math.round(x) + dx, 80, Math.round(z) + dz), RAY_DOWN);
        const hit = groundRay.intersectObjects(monster.ground, false)[0];
        if (hit) { sum += hit.point.y; n++; }
      }
      h = n ? sum / n : 0;
      groundCache.set(key, h);
    }
    return h;
  }
  // Pose: one clip at a point in it (0..1); others fade out, keeping their pose.
  function poseMonster(name, t01, dt) {
    for (const [k, a] of Object.entries(monster.acts)) {
      const target = k === name ? 1 : 0;
      const w = monster.w[k] + Math.sign(target - monster.w[k]) * Math.min(Math.abs(target - monster.w[k]), dt / MON_BLEND);
      monster.w[k] = w;
      a.setEffectiveWeight(w);
      if (k === name) {
        const loops = k === 'run' || k === 'swat';
        a.time = (loops ? ((t01 % 1) + 1) % 1 : Math.max(0, Math.min(0.999, t01))) * a.getClip().duration;
      }
    }
    monster.mixer.update(0);
    // A fist round whoever it's holding.
    const q = new THREE.Quaternion();
    for (const h of Object.values(monster.hands)) {
      if (h.curl < 0.001 || !h.curlAxis) continue;
      // a fist: knuckles ~75 degrees, middle joints ~85, tips ~55; the thumb across
      for (const b of h.fingers) b.quaternion.multiply(q.setFromAxisAngle(h.curlAxis, FIST[b.name.slice(-1)] * h.curl));
      if (h.thumbAxis) for (const b of h.thumb) b.quaternion.multiply(q.setFromAxisAngle(h.thumbAxis, THUMB[b.name.slice(-1)] * h.curl));
    }
  }
  // Fading in at the bottom of the hill and out as it goes back down it.
  function fadeMonster(a) {
    for (const mat of monster.mats) {
      mat.opacity = a;
      const t = a < 0.999;
      if (mat.transparent !== t) { mat.transparent = t; mat.needsUpdate = true; }
      mat.depthWrite = !t;
    }
  }
  function updateMonster(m, dt) {
    const g = monster.group;
    if (!m || !monster.ready) { g.visible = false; monster.last = null; return; }
    const fresh = !g.visible;
    if (fresh) for (const k in monster.w) monster.w[k] = 0; // a new appearance: no blend from last time
    g.visible = true;
    const u = Math.min(1, m.t / MON[m.phase]);
    const LX = toX(m.x);
    const up = MON_FAR;
    const flat = [[MON_SIDE, -50], [MON_SIDE, MON_Z.barn]];
    const run = [[MON_SIDE, MON_Z.barn], [LX, MON_Z.lane], [LX, MON_Z.runEnd]];
    const back = [[LX, MON_Z.front], [LX, MON_Z.runEnd], [LX, MON_Z.lane], [MON_SIDE, MON_Z.barn], [MON_SIDE, -50]];
    const away = MON_FAR.slice().reverse();
    let x = LX, z = MON_Z.front, heading = 0, clip = 'look', at = 0, alpha = 1, turnInClip = false;
    const go = (pts, uu, perLoop) => { const L = routeLen(pts), p = along(pts, L * uu); x = p.x; z = p.z; heading = p.yaw; at = (L * uu) / perLoop; };
    switch (m.phase) {
      case 'climb': // in from far out in the valley and up the hill
        go(up, u, MON_WALK); clip = 'swat'; alpha = Math.min(1, u / 0.04); break;
      case 'swat': // wanders across the top swatting at bugs (the walk carries on from the climb)
        go(flat, u, MON_WALK); clip = 'swat'; at += routeLen(up) / MON_WALK; break;
      case 'run': // flat out
        go(run, u, MON_STRIDE); clip = 'run'; break;
      case 'jump':
        z = MON_Z.runEnd + (MON_Z.front - MON_Z.runEnd) * u; clip = 'jump'; at = Math.min(0.99, u); break;
      case 'look':
        clip = 'look'; at = u; break;
      case 'grab': { // down over the fence to the floor, then up with whoever it caught
        const r = MON.reach;
        clip = 'grab'; at = u < r ? 0.4 * (u / r) : 0.4 + 0.22 * ((u - r) / (1 - r)); break;
      }
      case 'hold':
        clip = 'grab'; at = 0.62 + 0.01 * Math.sin(u * Math.PI * 2); break;
      case 'throw': { // turns side-on towards the nearer end of the floor, steps in and hurls them along it
        const r = MON.release;
        heading = (m.dir || 1) * (Math.PI / 2);
        // (THROW_RELEASE: the point in the clip where its arm whips forward, when the game lets go)
        clip = 'throw'; at = u < r ? THROW_RELEASE * (u / r) : THROW_RELEASE + (THROW_SETTLED - THROW_RELEASE) * ((u - r) / (1 - r)); break;
      }
      case 'turn': // turns round (the clip itself turns it; it's facing away by the end)
        clip = 'turn'; at = u; turnInClip = true; break;
      case 'back': // runs back the way it came...
        go(back, u, MON_STRIDE); clip = 'run'; break;
      case 'descend': // ...down the hill and away into the valley
        go(away, u, MON_STRIDE); clip = 'run'; at += routeLen(back) / MON_STRIDE; alpha = Math.min(1, (1 - u) / 0.12); break;
    }
    // Heading: eases round towards where it's going (the turn clip does its own turning).
    if (turnInClip) heading = 0;
    // (out of the turn clip it's already facing away: no second turn)
    if (fresh || monster.yaw === undefined || (m.phase === 'back' && monster.last === 'turn')) monster.yaw = heading;
    else monster.yaw += Math.atan2(Math.sin(heading - monster.yaw), Math.cos(heading - monster.yaw)) * Math.min(1, dt * 5);
    // They're in its left fist, the one it grabs with, all the way through:
    // the throw clip is mirrored to throw with that hand (tools/blender/rig_giant.py).
    const holding = !!m.held && (m.phase === 'grab' || m.phase === 'hold' || m.phase === 'throw');
    const k8 = Math.min(1, (monster.last ? dt : 1) * 8);
    monster.hands.Left.curl += ((holding ? 1 : 0) - monster.hands.Left.curl) * k8;
    poseMonster(clip, at, monster.last ? dt : 1);
    fadeMonster(alpha);
    monster.last = m.phase;
    // Reaching for someone: it leans over so its hand comes down on them,
    // and keeps them in that hand as it straightens.
    let reach = 0;
    if ((m.held || m.phase === 'throw') && m.gx !== undefined) reach = (m.gx - (m.x + MON.hand)) * S; // (stays put through the throw)
    else if (m.phase === 'look' || m.phase === 'grab') {
      const zn = Stage.monsterZone(), st = monster.fighters;
      if (zn && st) {
        const c = (zn.x1 + zn.x2) / 2;
        const inZone = st.filter((f) => f.x >= zn.x1 && f.x <= zn.x2 && f.state !== 'ko').sort((a, b) => Math.abs(a.x - c) - Math.abs(b.x - c))[0];
        if (inZone) reach = (inZone.x - c) * S;
      }
    }
    if (!(m.held || m.phase === 'look' || m.phase === 'grab' || m.phase === 'hold' || m.phase === 'throw')) reach = 0;
    monster.reach = (monster.reach || 0) + (reach - (monster.reach || 0)) * Math.min(1, (monster.last ? dt : 1) * 4);
    g.position.set(x + monster.reach, groundAt(x, z), z);
    g.rotation.y = monster.yaw;
  }
  // The danger zone (Stage.monsterZone): a red patch on the road where its
  // hand will come down, getting brighter and pulsing faster, with a
  // bright edge; it flashes as it goes off.
  const zoneMat = new THREE.MeshBasicMaterial({ color: '#ff2a1a', transparent: true, depthWrite: false, opacity: 0 });
  const zone = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), zoneMat);
  zone.rotation.x = -Math.PI / 2; zone.renderOrder = 1; zone.visible = false;
  const zoneEdgeMat = new THREE.MeshBasicMaterial({ color: '#ff5a3a', transparent: true, depthWrite: false, opacity: 0 });
  const zoneEdges = [-1, 1].map((side) => {
    const e = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), zoneEdgeMat);
    e.rotation.x = -Math.PI / 2; e.renderOrder = 1; e.userData.side = side; scene.add(e); return e;
  });
  scene.add(zone); // (not in the orchard group: the Blender scene's arrival clears that out)
  let zoneFlash = 0;
  function updateZone(z, now, dt) {
    if (z) {
      const w = (z.x2 - z.x1) * S, cx = toX((z.x1 + z.x2) / 2), k = z.k;
      const pulse = 0.5 + 0.5 * Math.sin(now / 1000 * (4 + 18 * k * k) * Math.PI);
      zone.visible = true;
      zone.position.set(cx, 0.015, 0); zone.scale.set(w, 1.7, 1);
      zoneMat.color.set('#ff2a1a');
      zoneMat.opacity = 0.12 + 0.45 * k + 0.2 * k * pulse;
      zoneEdgeMat.opacity = 0.4 + 0.6 * pulse;
      for (const e of zoneEdges) { e.visible = true; e.position.set(cx + e.userData.side * w / 2, 0.017, 0); e.scale.set(0.08, 1.7, 1); }
      zoneFlash = k > 0.995 ? 1 : zoneFlash;
      zone.userData.last = { cx, w };
    } else if (zoneFlash > 0 && zone.userData.last) {
      // Gone off: a white flash that fades.
      zoneFlash = Math.max(0, zoneFlash - dt * 3);
      zoneMat.color.set('#fff2e0'); zoneMat.opacity = 0.8 * zoneFlash;
      zone.visible = zoneFlash > 0;
      for (const e of zoneEdges) e.visible = false;
    } else {
      zone.visible = false; for (const e of zoneEdges) e.visible = false;
    }
  }
  // Whoever it's holding: drawn in its fist -- their middle at the palm, the
  // curled fingers in front of them, head and arms above, legs below. As it
  // lets go they leave the fist smoothly rather than jumping.
  const handPos = new THREE.Vector3(), knucklePos = new THREE.Vector3();
  const fistPos = (h, out) => {
    h.hand.getWorldPosition(out);
    if (h.knuckle) out.lerp(h.knuckle.getWorldPosition(knucklePos), 0.6);
    return out;
  };
  const FLING_BLEND = 450; // ms for someone the giant throws to go from its fist onto their path
  function holdInHand(card, f, now) {
    const L = monster.hands.Left;
    const held = L.hand && monster.group.visible && f.state === 'grabbed' && f.heldByStage;
    if (held) {
      fistPos(L, handPos);
      const sheet = card.sheet;
      card.mesh.position.set(handPos.x, handPos.y + (sheet.feetY - sheet.h / 2 - 0.5 * f.height) * S, handPos.z);
      card.blob.visible = card.ring.visible = false;
      card.fistAt = card.mesh.position.clone(); card.fistTill = now + FLING_BLEND; card.fistOff = null;
    } else if (card.fistTill > now) {
      // Just thrown: they leave from its fist and fly on at full speed, the
      // gap between its fist and their path (it stands well behind the fight
      // line) closing as they go -- rather than hanging at the fist first.
      if (!card.fistOff) card.fistOff = card.fistAt.clone().sub(card.mesh.position);
      const k = (card.fistTill - now) / FLING_BLEND;
      card.mesh.position.addScaledVector(card.fistOff, k * k);
    } else {
      card.fistOff = null;
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
      o.userData.env = env; // (switched off with the graphics' reflections)
    });
  }

  // ---- Graphics settings on the Blender scene ----
  // How much each part of the scene matters for shadows: 'key' parts cast
  // them from Medium up (the props you fight around), 'detail' parts only on
  // High (rows of trees, poles, fence), and the ground itself never does --
  // it only receives them. Sorted by the part's top-level name.
  function shadowRole(name) {
    if (/^(terrain|ground|gorge|backdrop|lawn|road|pole_wires|GUIDE_)/.test(name)) return 'none';
    if (/^(tree_|bank_tree|telephone_pole|fence|simple wooden fence|cow_lying|apple_fallen)/i.test(name)) return 'detail';
    return 'key';
  }
  // Scenery that Low leaves out: the trees and poles well back from the
  // fight, which the fog mostly hides anyway.
  const FAR_BACK = 28; // metres behind the fight line
  function tagScene(root) {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const top of root.children) {
      const role = shadowRole(top.name);
      // (by the nearest edge of what's drawn: a pole's wires hang from it)
      const far = /^(tree_|bank_tree|telephone_pole|pole_wires)/.test(top.name) && box.setFromObject(top).max.z < -FAR_BACK;
      top.userData.far = far;
      top.traverse((o) => {
        if (!o.isMesh) return;
        o.userData.shadowRole = role;
        o.receiveShadow = !/^backdrop_sky/.test(o.name);
        if (o !== lawn && o !== lawnFlat) o.userData.fullMat = o.material;
      });
    }
  }
  // Cheaper stand-ins for a material: 'standard' drops the normal map (and
  // the clearcoat), 'simple' is plain diffuse lighting (no specular, normal
  // or roughness maps at all). Made once per material and shared.
  const cheaper = { standard: new Map(), simple: new Map() };
  function materialFor(m, level) {
    if (level === 'full' || !m.isMeshStandardMaterial) return m;
    const cache = cheaper[level];
    if (cache.has(m)) return cache.get(m);
    let c;
    if (level === 'standard') {
      c = m.clone();
      c.normalMap = null;
      if (c.isMeshPhysicalMaterial) { c.clearcoat = 0; c.sheen = 0; c.iridescence = 0; }
    } else {
      c = new THREE.MeshLambertMaterial({
        name: m.name, color: m.color, map: m.map, emissive: m.emissive, emissiveMap: m.emissiveMap,
        emissiveIntensity: m.emissiveIntensity, aoMap: m.aoMap, alphaMap: m.alphaMap, alphaTest: m.alphaTest,
        transparent: m.transparent, opacity: m.opacity, side: m.side, vertexColors: m.vertexColors,
        fog: m.fog, depthWrite: m.depthWrite,
      });
      // Shiny metal reads too bright without its reflections.
      if (m.metalness > 0.5) c.color = m.color.clone().multiplyScalar(0.55);
    }
    cache.set(m, c);
    return c;
  }
  let stageRoot = null;
  function applyGraphics() {
    const shadowsOn = gfx.shadows !== 'off';
    const type = gfx.shadows === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    const size = gfx.shadows === 'high' ? 2048 : 1024;
    const recompile = renderer.shadowMap.enabled !== shadowsOn || renderer.shadowMap.type !== type;
    renderer.shadowMap.enabled = shadowsOn;
    renderer.shadowMap.type = type;
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    orchard.traverse((o) => {
      if (!o.isMesh) return;
      const role = o.userData.shadowRole;
      if (role) o.castShadow = role === 'key' || (role === 'detail' && gfx.shadows === 'high');
      if (o.userData.fullMat) {
        const m = materialFor(o.userData.fullMat, gfx.materials);
        if (o.material !== m) o.material = m;
        if (o.userData.env && m.isMeshStandardMaterial && m.envMap !== (gfx.reflections ? o.userData.env : null)) {
          m.envMap = gfx.reflections ? o.userData.env : null;
          m.needsUpdate = true;
        }
      }
    });
    if (stageRoot) for (const top of stageRoot.children) if (top.userData.far) top.visible = gfx.farTrees;
    // Cartoon: the low-poly orchard instead of the Blender one.
    const toy = !!gfx.cartoon || !stageRoot;
    toyScenery.visible = toy;
    if (stageRoot) stageRoot.visible = !toy;
    for (const slot of [car, ...cows.map((c) => c.cow)]) {
      if (!slot.userData.model) continue;
      slot.userData.toy.visible = toy;
      slot.userData.model.visible = !toy;
    }
    // The grass: how many layers, and how far out it grows.
    lawnLayers.value = Math.max(1, gfx.grassLayers);
    lawnFar.value = gfx.grassFar;
    if (lawn) { lawn.count = gfx.grassLayers; lawn.visible = gfx.grassLayers > 0; }
    if (lawnFlat) lawnFlat.visible = !lawn || gfx.grassLayers === 0;
    if (recompile) scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; });
    resize();
  }
  Graphics.onChange((c) => {
    if (c.fxRes !== gfx.fxRes) setFxRes(c.fxRes);
    gfx = c; CARD_RES = c.cardRes;
    applyGraphics();
  });
  // The Blender model moves into the slot; the low-poly one it replaces is
  // kept (as slot.userData.toy) for the Cartoon setting.
  function takeOver(slot, node) {
    node.removeFromParent();
    node.position.set(0, 0, 0);
    node.rotation.set(0, 0, 0);
    const toy = new THREE.Group();
    toy.name = slot.name + '_toy';
    for (const c of [...slot.children]) toy.add(c);
    slot.add(toy, node);
    slot.userData.toy = toy;
    slot.userData.model = node;
  }
  let stageReady = false;
  // The orchard's sign (its own model, assets/models/sign.glb), on the
  // grass behind the fence, left of the apple tree. Scenery only: nothing
  // stands on it. Part of the real scene, so Cartoon doesn't show it.
  async function addSign(root, loader) {
    try {
      const sign = (await loader.loadAsync('assets/models/sign.glb')).scene;
      sign.name = 'orchard_sign';
      const box = new THREE.Box3().setFromObject(sign);
      const k = SIGN.height / (box.max.y - box.min.y);
      sign.scale.setScalar(k);
      sign.position.set(SIGN.x, -box.min.y * k, SIGN.z);
      sign.rotation.y = SIGN.turn;
      root.add(sign);
    } catch (e) {
      console.warn('[stage] could not load the orchard sign', e);
    }
  }

  async function loadStageScenes() {
    let list = [];
    try {
      const r = await fetch('assets/stages/manifest.json');
      if (r.ok) list = (await r.json()).scenes || [];
    } catch (e) { stageReady = true; return; }
    if (!list.includes('orchard')) { stageReady = true; return; }
    // Cartoon keeps the low-poly orchard, so the Blender scene isn't even
    // downloaded (picking a higher setting later asks for a reload).
    if (gfx.stageFile === 'none') { stageReady = true; return; }
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      // Low and Medium load the lighter copy made by tools/optimize-stage.js
      // (simpler meshes, smaller textures), if it's there.
      const loader = new GLTFLoader();
      let gltf = null;
      // (?stagefile=full|lite picks one regardless, for comparing them.)
      const pick = new URLSearchParams(location.search).get('stagefile') || gfx.stageFile;
      if (pick === 'lite') {
        try { gltf = await loader.loadAsync('assets/stages/orchard-lite.glb'); } catch (e) { console.info('[stage] no orchard-lite.glb -- loading the full scene'); }
      }
      if (!gltf) gltf = await loader.loadAsync('assets/stages/orchard.glb');
      const root = gltf.scene;
      const guides = [];
      root.traverse((o) => {
        if (o.name.startsWith('GUIDE_')) guides.push(o);
        // Glass that refracts (KHR_materials_transmission) makes three.js
        // draw the whole scene an extra time each frame; plain see-through
        // glass looks the same from fighting distance.
        if (o.isMesh && o.material.transmission > 0) {
          o.material.transmission = 0;
          o.material.transparent = true;
          o.material.opacity = Math.min(o.material.opacity, 0.4);
          o.material.depthWrite = false;
        }
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
      await addSign(root, loader);
      addLawn(root);
      fadeFarPoles(root);
      root.updateMatrixWorld(true);
      monster.ground = ['terrain_near', 'backdrop_valley'].map((n) => root.getObjectByName(n)).filter((o) => o && o.isMesh);
      groundCache.clear();
      wetRoads(root);
      tagScene(root);
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
        c.custom = true;
      });
      // The low-poly scenery steps aside (kept for the Cartoon setting); the
      // moving parts stay, now wearing the new models.
      const keep = new Set([car, monster.group, toyScenery, ...cows.map((c) => c.cow)]);
      for (const child of [...orchard.children]) if (!keep.has(child)) toyScenery.add(child);
      orchard.add(root);
      stageRoot = root;
      applyGraphics();
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
      stageReady = true;
    } catch (e) {
      stageReady = true;
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
    return { w, h, feetY, res: CARD_RES, canvas: c, ctx: c.getContext('2d'), tex, mesh };
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

  // One card per side; p3/p4 (free-for-all) made the first time they play.
  const CARD_Z = { p1: 0.03, p2: -0.03, p3: 0.06, p4: -0.06 };
  const cards = { p1: makeCard(CARD_Z.p1, 'p1'), p2: makeCard(CARD_Z.p2, 'p2') };
  const cardFor = (slot) => cards[slot] || (cards[slot] = makeCard(CARD_Z[slot] || 0, slot));
  const hideCard = (c) => { c.mesh.visible = false; c.blob.visible = false; c.ring.visible = false; };
  // Everyone being drawn (game.js passes the list; older callers just p1/p2).
  const fightersOf = (state) => state.fighters || [state.p1, state.p2];

  function updateCard(card, f, dt) {
    // Nathan's Overgrowth punches reach far past the normal card, so while
    // it's on he's drawn on a wide one.
    const wantWide = f.buffReachMul > 1;
    if (wantWide && !card.wide) card.wide = makeSheet(CARD_W_WIDE, CARD_H_TALL, FEET_Y_TALL);
    const sheet = wantWide ? card.wide : card.normal;
    if (sheet !== card.sheet) { card.sheet.mesh.visible = false; card.sheet = sheet; card.mesh = sheet.mesh; }
    const { ctx, canvas: c } = sheet;
    if (sheet.res !== CARD_RES) { // the graphics setting changed: redraw at the new resolution
      sheet.res = CARD_RES;
      c.width = Math.round(sheet.w * CARD_RES);
      c.height = Math.round(sheet.h * CARD_RES);
      sheet.tex.dispose();
    }
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
  // (Sized by the graphics' fxRes: Low and Medium draw effects at a lower
  // resolution -- this sheet is redrawn and sent to the GPU every frame.)
  fxCanvas.width = Math.round(CANVAS_WIDTH * gfx.fxRes);
  fxCanvas.height = Math.round((CANVAS_HEIGHT + FX_PAD) * gfx.fxRes);
  const fxCtx = fxCanvas.getContext('2d');
  const fxTex = new THREE.CanvasTexture(fxCanvas);
  fxTex.colorSpace = THREE.SRGBColorSpace;
  const fxSheet = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1), // (scaled to the area it covers in updateFx)
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
  // Most frames nothing is drawn behind the fighters: notice that, so the
  // back sheet isn't cleared and re-sent to the GPU for nothing.
  let backDrawn = false, backWasDrawn = true;
  for (const fn of ['fill', 'stroke', 'fillRect', 'strokeRect', 'drawImage', 'fillText', 'strokeText', 'putImageData']) {
    const orig = backFxCtx[fn].bind(backFxCtx);
    backFxCtx[fn] = (...a) => { backDrawn = true; return orig(...a); };
  }
  function setFxRes(r) {
    for (const [c, tex] of [[fxCanvas, fxTex], [backFxCanvas, backFxTex]]) {
      c.width = Math.round(CANVAS_WIDTH * r);
      c.height = Math.round((CANVAS_HEIGHT + FX_PAD) * r);
      tex.dispose();
    }
    backWasDrawn = true;
  }

  // Which part of the game world the sheets cover. The arena fits the
  // screen; on bigger stages they follow the camera, covering what it sees
  // at a resolution that drops as it zooms out (nothing is lost on screen).
  function fxView() {
    if (currentLook === 'arena') return { x0: 0, y0: 0, k: fxCanvas.width / CANVAS_WIDTH };
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const seen = (2 * camPos.z * tanV * camera.aspect) / S;
    const vw = THREE.MathUtils.clamp(seen * 1.25, CANVAS_WIDTH, 3400);
    const k = fxCanvas.width / vw, vh = fxCanvas.height / k;
    return { x0: camTarget.x / S + CANVAS_WIDTH / 2 - vw / 2, y0: CANVAS_HEIGHT + FX_PAD - vh, k }; // (bottom edge where the arena's is)
  }

  function updateFx(state) {
    const v = fxView();
    for (const [sheet, c] of [[fxSheet, fxCanvas], [backFxSheet, backFxCanvas]]) {
      if (c !== backFxCanvas || backWasDrawn) {
        c.getContext('2d').setTransform(1, 0, 0, 1, 0, 0);
        c.getContext('2d').clearRect(0, 0, c.width, c.height);
      }
      c.getContext('2d').setTransform(v.k, 0, 0, v.k, -v.x0 * v.k, -v.y0 * v.k);
      sheet.scale.set((c.width / v.k) * S, (c.height / v.k) * S, 1);
      sheet.position.x = toX(v.x0 + c.width / v.k / 2);
      sheet.position.y = toY(v.y0 + c.height / v.k / 2);
    }
    backDrawn = false;
    for (const f of fightersOf(state)) AbilityFX.drawBack(backFxCtx, f);
    if (backDrawn || backWasDrawn) backFxTex.needsUpdate = true; // (once more after the last drawing, to clear it)
    backFxSheet.userData.empty = !backDrawn && !backWasDrawn;
    backWasDrawn = backDrawn;

    for (const f of fightersOf(state)) AbilityFX.drawFront(fxCtx, f);
    AbilityFX.drawTimed(fxCtx);
    Renderer.drawProjectiles(fxCtx, state.projectiles);
    Effects.draw(fxCtx);
    // P1/P2 markers live on this flat sheet rather than on the fighter cards,
    // which mirror when a fighter turns and would print the label backwards.
    for (const f of fightersOf(state)) if (!f.out) Renderer.drawPlayerMarker(fxCtx, f);
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

  const flungFrom = new Map(); // slot -> where the giant threw them from (see frameCamera)
  function frameCamera(state, dt, t) {
    let tx, ty, dist;
    if (state) {
      // Frame everyone still in (a free-for-all can have four). Someone the
      // giant threw is framed where they were thrown from, so the camera holds
      // still and lets them fly out of shot.
      const all = fightersOf(state);
      for (const f of all) if (!f.flung) flungFrom.delete(f.slot); else if (!flungFrom.has(f.slot)) flungFrom.set(f.slot, { x: f.x, y: f.y, height: f.height });
      let framed = all.filter((f) => !f.out || flungFrom.has(f.slot)).map((f) => flungFrom.get(f.slot) || f);
      if (!framed.length) framed = all;
      const xs = framed.map((f) => toX(f.x));
      // Don't chase a fighter all the way down a ring-out.
      const ys = framed.map((f) => Math.max(toY(f.y), -1.2));
      const ax = Math.min(...xs), bx = Math.max(...xs), ay = Math.min(...ys), by = Math.max(...ys);
      const tallest = Math.max(...framed.map((f) => f.height)) * S;
      const spanX = Math.abs(ax - bx) + 2.8;
      const spanY = Math.abs(ay - by) + tallest + 1.6;
      const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      dist = Math.max(spanY / 2 / tanV, spanX / 2 / (tanV * camera.aspect));
      // (Pull back further when there are more than two to keep in shot.)
      dist = THREE.MathUtils.clamp(dist, 7, LOOKS[currentLook].maxDist * (framed.length > 2 ? 1.3 : 1));
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
      // The orchard giant holding someone: pull back to show all of it.
      const mon = currentLook === 'orchard' && Stage.monster();
      if (mon && monster.group.visible && (mon.held || mon.phase === 'throw' || (mon.phase === 'grab' && mon.t > MON.grab * MON.reach))) {
        const gx = monster.group.position.x;
        tx = THREE.MathUtils.clamp((tx + gx) / 2, toX(STAGE_LEFT_EDGE) + 1.6, toX(STAGE_RIGHT_EDGE) - 1.6);
        ty = Math.max(ty, 5.2);
        dist = Math.max(dist, 24);
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
      const shown = fightersOf(state);
      for (const [slot, c] of Object.entries(cards)) if (!shown.some((f) => f.slot === slot)) hideCard(c);
      for (const f of shown) updateCard(cardFor(f.slot), f, dt);
      updateFx(state);
      updateBall(state.ball, state.ballMode, now);
    } else {
      updateBall(null, null, now);
      for (const c of Object.values(cards)) hideCard(c);
      fxCtx.setTransform(1, 0, 0, 1, 0, 0);
      fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
      fxTex.needsUpdate = true;
    }
    fxSheet.visible = !!state;
    backFxSheet.visible = !!state && !backFxSheet.userData.empty;

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
      if (!gfx.cartoon) for (const m of mixers) m.update(dt);
      lawnTime.value = now / 1000;
      updateCows(now);
      updateCar(state ? Stage.car() : null, now);
      monster.fighters = state ? fightersOf(state) : null;
      updateMonster(state ? Stage.monster() : null, dt);
      updateZone(state ? Stage.monsterZone() : null, now, dt);
      if (state) for (const f of fightersOf(state)) holdInHand(cardFor(f.slot), f, now);
    }

    renderer.render(scene, camera);
  }

  applyGraphics();

  window.Renderer3D = {
    isActive: () => true,
    render,
    // For the FPS counter and benchmarks.
    stageReady: () => stageReady,
    scene: () => scene, // (for profiling from the console)
    info: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, textures: renderer.info.memory.textures, pixelRatio: renderer.getPixelRatio() }),
  };
  window.dispatchEvent(new Event('renderer3d-ready'));
}
