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

// 3D joint positions (Mixamo: y up, the character faces +z) -> side view,
// facing right, in body heights. Everything the rig needs per frame:
//   c: crouch (0 = legs straight), l: torso lean in degrees (+ = forward)
//   h / e: back and front hand / elbow, relative to the shoulders, in the
//          torso's own (un-leaned) frame
//   f / k: back and front foot / knee, x from the hips, y from the floor
//          (negative = up)
function toRig(raw, opts) {
  const flip = opts.flip ? -1 : 1;
  const X = (p) => p[2] * flip, Y = (p) => p[1];
  const f0 = raw[0];
  const ankleFloor = Math.min(...raw.map((f) => Math.min(Y(f.lFoot), Y(f.rFoot))));
  const height = (Y(f0.head) - ankleFloor) / 0.83;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const legLen = (dist(f0.lHip, f0.lKnee) + dist(f0.lKnee, f0.lFoot) + dist(f0.rHip, f0.rKnee) + dist(f0.rKnee, f0.rFoot)) / 2;
  // The lead side is whichever is further forward (arms: on average).
  const avg = (fn) => raw.reduce((s, f) => s + fn(f), 0) / raw.length;
  const leftArmFront = avg((f) => X(f.lShoulder) - X(f.rShoulder)) > 0;
  const leftLegFront = X(f0.lFoot) > X(f0.rFoot);
  const armSide = leftArmFront ? ['r', 'l'] : ['l', 'r']; // [back, front]
  const legSide = leftLegFront ? ['r', 'l'] : ['l', 'r'];

  const frames = raw.map((f) => {
    const hips = f.hips;
    const lean = Math.atan2(X(f.neck) - X(hips), Y(f.neck) - Y(hips));
    const cos = Math.cos(lean), sin = Math.sin(lean);
    const sc = [(f.lShoulder[0] + f.rShoulder[0]) / 2, (f.lShoulder[1] + f.rShoulder[1]) / 2, (f.lShoulder[2] + f.rShoulder[2]) / 2];
    // Relative to the shoulders, y down, then undo the lean.
    const armPt = (p) => {
      const x = (X(p) - X(sc)) / height, y = -(Y(p) - Y(sc)) / height;
      // Inverse of the renderer's lean rotation (canvas rotate by +lean).
      return [round(x * cos + y * sin), round(-x * sin + y * cos)];
    };
    const legPt = (p) => [round((X(p) - X(hips)) / height), round(-(Y(p) - ankleFloor) / height)];
    return {
      c: round(Math.max(0, Math.min(0.45, 1 - (Y(hips) - ankleFloor) / legLen))),
      l: round((lean * 180) / Math.PI),
      h: armSide.map((s) => armPt(f[s + 'Hand'])),
      e: armSide.map((s) => armPt(f[s + 'Elbow'])),
      f: legSide.map((s) => legPt(f[s + 'Foot'])),
      k: legSide.map((s) => legPt(f[s + 'Knee'])),
    };
  });

  // The strike: whichever limb travels furthest from where it started (in
  // 3D -- a hook swings across the body, which the side view can't see),
  // at the moment it's furthest out. moves.json can override either.
  // A clip where the front foot really leaves the ground is a kick (the arms
  // swing a long way for balance, so they'd otherwise win).
  // Either foot: plenty of kicks come off the back leg.
  const lift = (k) => Math.max(...frames.map((fr) => -fr.f[k][1]));
  const kickLeg = lift(1) >= lift(0) ? 1 : 0;
  const limbs = lift(kickLeg) > 0.12
    ? { foot: [legSide[kickLeg] + 'Foot'] }
    : { hand: [armSide[1] + 'Hand', armSide[0] + 'Hand'], head: ['head'] };
  let impact = 0, best = -1, strike = 'hand';
  for (const [kind, joints] of Object.entries(limbs)) {
    for (const j of joints) {
      raw.forEach((f, i) => {
        // Measured against the hips, so walking forward doesn't count.
        const rel = (fr) => [fr[j][0] - fr.hips[0], fr[j][1] - fr.hips[1], fr[j][2] - fr.hips[2]];
        const a = rel(f), b = rel(f0);
        const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / height;
        if (d > best) { best = d; impact = i; strike = kind; }
      });
    }
  }
  if (typeof opts.impact === 'number') impact = Math.round(opts.impact * (frames.length - 1));
  if (opts.strike) strike = opts.strike;
  return { frames, impact: round(impact / (frames.length - 1)), strike };
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
        const rig = toRig(raw.frames, clip);
        const out = { source: clip.fbx, fps: FPS, duration: round(raw.duration), impact: rig.impact, strike: rig.strike, frames: rig.frames };
        fs.writeFileSync(path.join(ANIM_DIR, id + '.json'), JSON.stringify(out));
        console.log(`  ${id}: ${rig.frames.length} frames, ${out.duration}s, ${rig.strike} strike at ${Math.round(rig.impact * 100)}%`);
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
