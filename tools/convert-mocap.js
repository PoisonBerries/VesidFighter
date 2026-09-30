#!/usr/bin/env node
// Converts motion-capture clips (Mixamo FBX files in fbx/) into the 2D
// keyframes the animator plays (assets/anim/<clip>.json), and keeps
// assets/anim/moves.json up to date: every FBX gets an entry under "clips";
// which character uses which clip for which move is up to you, under "use".
// See assets/anim/README.md.
//
//   node tools/convert-mocap.js          convert new or changed clips
//   node tools/convert-mocap.js --all    reconvert everything
//
// Needs Chrome (like the browser tests; set CHROME_PATH if it isn't found)
// and an internet connection (the FBX loader comes from a CDN).
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { ROOT, startServer, findChrome } = require('../tests/helpers');

const FBX_DIR = path.join(ROOT, 'fbx');
const ANIM_DIR = path.join(ROOT, 'assets/anim');
const MOVES = path.join(ANIM_DIR, 'moves.json');
const FPS = 30;

const slug = (name) => name.replace(/\.fbx$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const round = (v) => Math.round(v * 1000) / 1000;

function loadMoves() {
  if (fs.existsSync(MOVES)) return JSON.parse(fs.readFileSync(MOVES, 'utf8'));
  return { clips: {}, use: { '*': {} } };
}

// 3D joint positions (Mixamo: y up, the character faces +z) -> a 2D pose
// seen from the side (optionally turned `view` degrees toward the camera for
// a three-quarter look), facing right, screen y pointing down. The pose is
// stored as *directions*, so the game can rebuild it with each fighter's own
// bone lengths:
//   root: [x, h]  hips' shift forward since the clip started, and hip height
//                 above the floor (body heights)
//   c:    crouch (0 = legs straight), l: spine lean in degrees (+ = forward)
//   hd:   head tilt relative to the spine, change from the first frame, degrees
//   sh:   [far, near] shoulder offsets from the base of the neck, in the
//         torso's own (un-leaned) frame, body heights
//   arm:  [far, near] [upper arm angle, forearm angle] (radians, screen)
//   hp:   [far, near] hip joint offsets from the hips' centre (screen frame)
//   leg:  [far, near] [thigh angle, shin angle]
//   ft:   [far, near] foot angle change from standing (0 = flat, + = toe down)
//   lo:   height of the body's lowest joint above the floor (0 = standing;
//         for a body lying down it's whichever part is on the floor)
// "far"/"near" are by depth: the near limbs are drawn in front.
// Joints that can be the one touching the floor (not the toes: the floor is
// measured from the ankles).
const LOW_JOINTS = ['lFoot', 'rFoot', 'lKnee', 'rKnee', 'hips', 'lHand', 'rHand', 'lElbow', 'rElbow', 'head', 'lShoulder', 'rShoulder'];

function toPose(raw, opts) {
  const flip = opts.flip ? -1 : 1;
  const yaw = ((opts.view || 0) * Math.PI) / 180;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  // Screen x (forward), screen y (down), and depth (toward the camera = smaller).
  const P = (p) => [(p[2] * cy + p[0] * sy) * flip, -p[1]];
  const depth = (p) => p[0] * cy - p[2] * sy;
  const f0 = raw[0];
  const ankleFloor = Math.min(...raw.map((f) => Math.min(f.lFoot[1], f.rFoot[1])));
  const height = (f0.head[1] - ankleFloor) / 0.83;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const legLen = (dist(f0.lHip, f0.lKnee) + dist(f0.lKnee, f0.lFoot) + dist(f0.rHip, f0.rKnee) + dist(f0.rKnee, f0.rFoot)) / 2;
  const avg = (fn) => raw.reduce((s, f) => s + fn(f), 0) / raw.length;
  // Far side first: the side further from the camera on average.
  const armSides = avg((f) => depth(f.lShoulder) - depth(f.rShoulder)) > 0 ? ['l', 'r'] : ['r', 'l'];
  const legSides = avg((f) => depth(f.lHip) - depth(f.rHip)) > 0 ? ['l', 'r'] : ['r', 'l'];
  const ang = (a, b) => { const A = P(a), B = P(b); return round(Math.atan2(B[1] - A[1], B[0] - A[0])); };
  const hip0 = P(f0.hips);
  // Resting angles (first frame): Mixamo's foot and head bones point off at
  // an angle even standing normally, so store changes from these.
  const footRest = legSides.map((s) => ang(f0[s + 'Foot'], f0[s + 'Toe']));
  const tiltOf = (f) => {
    const hips = P(f.hips), neck = P(f.neck), head = P(f.head);
    return Math.atan2(head[0] - neck[0], neck[1] - head[1]) - Math.atan2(neck[0] - hips[0], hips[1] - neck[1]);
  };
  const tiltRest = tiltOf(f0);

  const frames = raw.map((f) => {
    const hips = P(f.hips), neck = P(f.neck), head = P(f.head);
    const lean = Math.atan2(neck[0] - hips[0], hips[1] - neck[1]);
    const tilt = tiltOf(f) - tiltRest;
    const cos = Math.cos(lean), sin = Math.sin(lean);
    const torsoFrame = (p) => {
      const q = P(p);
      const x = (q[0] - neck[0]) / height, y = (q[1] - neck[1]) / height;
      return [round(x * cos + y * sin), round(-x * sin + y * cos)]; // undo the lean
    };
    const lowJoint = Math.min(...LOW_JOINTS.map((j) => f[j][1]));
    return {
      root: [round((hips[0] - hip0[0]) / height), round((f.hips[1] - ankleFloor) / height)],
      c: round(Math.max(0, Math.min(0.5, 1 - (f.hips[1] - ankleFloor) / legLen))),
      l: round((lean * 180) / Math.PI),
      hd: round((tilt * 180) / Math.PI),
      sh: armSides.map((s) => torsoFrame(f[s + 'Shoulder'])),
      arm: armSides.map((s) => [ang(f[s + 'Shoulder'], f[s + 'Elbow']), ang(f[s + 'Elbow'], f[s + 'Hand'])]),
      hp: legSides.map((s) => { const q = P(f[s + 'Hip']); return [round((q[0] - hips[0]) / height), round((q[1] - hips[1]) / height)]; }),
      leg: legSides.map((s) => [ang(f[s + 'Hip'], f[s + 'Knee']), ang(f[s + 'Knee'], f[s + 'Foot'])]),
      ft: legSides.map((s, i) => round(ang(f[s + 'Foot'], f[s + 'Toe']) - footRest[i])),
      lo: round((lowJoint - ankleFloor) / height),
    };
  });

  // The strike, and when it lands: every punch and kick is at its straightest
  // at contact (hand furthest from its shoulder, foot furthest from its
  // hip), which a wind-up never is. The striking limb is the one that
  // straightens the most over the clip; a clip where a foot really leaves
  // the ground is a kick; a headbutt is the head moving furthest from the
  // hips. moves.json can override any of it.
  const reach = (f, from, to) => dist(f[from], f[to]) / height;
  const cands = [];
  armSides.forEach((sd, i) => cands.push({ kind: 'hand', limb: ['arm', i], joint: sd + 'Hand', ext: (f) => reach(f, sd + 'Shoulder', sd + 'Hand') }));
  legSides.forEach((sd, i) => cands.push({ kind: 'foot', limb: ['leg', i], joint: sd + 'Foot', ext: (f) => reach(f, sd + 'Hip', sd + 'Foot') }));
  const lift = (sd) => Math.max(...raw.map((f) => (f[sd + 'Foot'][1] - ankleFloor) / height));
  const kick = Math.max(lift('l'), lift('r')) > 0.12;
  const pool = cands.filter((c) => (kick ? c.kind === 'foot' : c.kind === 'hand'));
  let chosen = pool[0], impact = 0, gain = -1;
  for (const c of pool) {
    const ex = raw.map(c.ext);
    const i = ex.indexOf(Math.max(...ex));
    const g = ex[i] - Math.min(...ex);
    if (g > gain) { gain = g; chosen = c; impact = i; }
  }
  // A headbutt: the head moves a long way while no limb straightens much.
  const headTravel = raw.map((f) => Math.hypot(f.head[0] - f.hips[0] - (f0.head[0] - f0.hips[0]), f.head[2] - f.hips[2] - (f0.head[2] - f0.hips[2])) / height);
  const headMax = Math.max(...headTravel);
  let strike = chosen.kind, strikeLimb = chosen.limb, strikeJoint = chosen.joint;
  if (!kick && headMax > gain * 1.5) { strike = 'head'; strikeLimb = null; strikeJoint = 'head'; impact = headTravel.indexOf(headMax); }
  if (typeof opts.impact === 'number') impact = Math.round(opts.impact * (frames.length - 1));
  if (opts.strike) strike = opts.strike;
  const rel = (fr, j) => [fr[j][0] - fr.hips[0], fr[j][1] - fr.hips[1], fr[j][2] - fr.hips[2]];

  // The action window: from when the striking limb starts moving to when it
  // has settled again, so the game plays the strike itself (not the standing
  // around before and after) at close to its real speed.
  const speed = raw.map((f, i) => {
    if (i === 0) return 0;
    const a = rel(f, strikeJoint), b = rel(raw[i - 1], strikeJoint);
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / height;
  });
  const peak = Math.max(...speed) || 1;
  const quiet = (i) => speed[i] < peak * 0.12;
  // The limb is momentarily still at full extension, so first find the fast
  // movement on each side of the impact, then go outward to where it's quiet.
  const argmax = (lo, hi) => { let k = lo; for (let i = lo; i <= hi; i++) if (speed[i] > speed[k]) k = i; return k; };
  const last = raw.length - 1;
  let start = argmax(0, impact), end = argmax(impact, last);
  while (start > 0 && !(quiet(start) && quiet(start - 1))) start--;
  while (end < last && !(quiet(end) && quiet(Math.min(last, end + 1)) && quiet(Math.min(last, end + 2)))) end++;
  const n = frames.length - 1;
  let window = [round(Math.max(0, start - 1) / n), round(Math.min(n, end + 1) / n)];
  // Not really a strike (a victory pose, a fall): play the whole clip.
  if ((window[1] - window[0]) * raw.length < 8) window = [0, 1];
  if (Array.isArray(opts.window)) { window[0] = opts.window[0]; window[1] = opts.window[1]; }
  // Airborne stretch (both feet clearly off the floor): a jump clip's air
  // time is matched to the game's jump.
  const up = raw.map((f) => Math.min(f.lFoot[1], f.rFoot[1]) - ankleFloor > height * 0.04);
  const a0 = up.indexOf(true), a1 = up.lastIndexOf(true);
  const air = a0 >= 0 && a1 - a0 >= 3 ? [round(a0 / n), round(a1 / n)] : null;
  // Where the motion comes to rest (a fall ending on the floor): the last
  // frame where anything is still moving noticeably.
  const motion = raw.map((f, i) => (i === 0 ? 0 : LOW_JOINTS.reduce((sum, j) => sum + dist(f[j], raw[i - 1][j]), 0) / height));
  const mPeak = Math.max(...motion) || 1;
  let settle = motion.length - 1;
  while (settle > 1 && motion[settle] < mPeak * 0.08) settle--;
  // For falls: the first moment the hips are down at their lowest.
  const hipH = raw.map((f) => f.hips[1]);
  const hipMin = Math.min(...hipH);
  const down = hipH.findIndex((h) => h <= hipMin + height * 0.03);
  return { frames, impact: round(impact / n), strike, limb: strikeLimb, window, air, settle: round(Math.min(n, settle + 1) / n), down: round(down / n) };
}

(async () => {
  const all = process.argv.includes('--all');
  fs.mkdirSync(ANIM_DIR, { recursive: true });
  const moves = loadMoves();
  moves.clips = moves.clips || {};
  moves.use = moves.use || { '*': {} };

  // Register every FBX in fbx/ as a clip.
  const files = fs.existsSync(FBX_DIR) ? fs.readdirSync(FBX_DIR).filter((f) => /\.fbx$/i.test(f)) : [];
  for (const file of files) {
    const id = slug(file);
    if (!moves.clips[id]) moves.clips[id] = { fbx: 'fbx/' + file };
  }

  const todo = Object.entries(moves.clips).filter(([id, c]) => {
    const src = path.join(ROOT, c.fbx), out = path.join(ANIM_DIR, id + '.json');
    if (!fs.existsSync(src)) { console.log(`  ${id}: ${c.fbx} is missing, skipped`); return false; }
    return all || !fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs;
  });

  if (todo.length) {
    const server = await startServer();
    const browser = await puppeteer.launch({ executablePath: findChrome(), headless: 'new', args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/tools/mocap-sampler.html`);
      await page.waitForFunction(() => window.samplerReady, { timeout: 30000 });
      for (const [id, clip] of todo) {
        const url = '/' + clip.fbx.split('/').map(encodeURIComponent).join('/');
        const raw = await page.evaluate((u, fps) => window.sampleClip(u, fps), url, FPS);
        const pose = toPose(raw.frames, clip);
        const out = { version: 2, source: clip.fbx, fps: FPS, duration: round(raw.duration), impact: pose.impact, strike: pose.strike, limb: pose.limb, window: pose.window, air: pose.air, settle: pose.settle, down: pose.down, frames: pose.frames };
        fs.writeFileSync(path.join(ANIM_DIR, id + '.json'), JSON.stringify(out));
        const secs = ((pose.window[1] - pose.window[0]) * raw.duration).toFixed(2);
        const airTxt = pose.air ? `, airborne ${Math.round(pose.air[0] * 100)}-${Math.round(pose.air[1] * 100)}%` : '';
        console.log(`  ${id}: ${pose.frames.length} frames, action ${Math.round(pose.window[0] * 100)}-${Math.round(pose.window[1] * 100)}% (${secs}s), ${pose.strike} strike at ${Math.round(pose.impact * 100)}%${airTxt}, settles ${Math.round(pose.settle * 100)}%`);
      }
    } finally {
      await browser.close();
      server.close();
    }
  } else {
    console.log('  nothing new to convert (use --all to redo everything)');
  }

  fs.writeFileSync(MOVES, JSON.stringify(moves, null, 2) + '\n');
  console.log(`moves.json: ${Object.keys(moves.clips).length} clip(s)`);
})().catch((e) => { console.error(e); process.exit(1); });
