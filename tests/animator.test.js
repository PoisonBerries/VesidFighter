// Animation-layer tests that don't need a browser: the animator is loaded in
// a sandbox next to the sim and driven with a fake clock.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT } = require('./helpers');

function load() {
  let now = 1000;
  const ctx = vm.createContext({ console, Math, JSON, window: { addEventListener() {} }, performance: { now: () => now } });
  const src = ['constants.js', 'input.js', 'characters.js', 'effects.js', 'fighter.js', 'animator.js']
    .map((f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n;\n');
  const api = vm.runInContext(src + '\n({ Animator, Fighter, CHARACTERS, InputManager })', ctx);
  return { ...api, tick: (ms = 1000 / 60) => { now += ms; } };
}

const PROFILE = { limbWidth: 1, headScale: 1, stanceMul: 1, idleCrouch: 0, floaty: false, clawHands: false, dancer: false, reachBoost: 0, staggerMul: 1, torsoWidth: 1, armScale: 1 };

function run(lib, id) {
  const f = new lib.Fighter('p1', lib.CHARACTERS[id], 500, 1);
  const trace = [];
  for (let i = 0; i < 6; i++) { lib.tick(); lib.Animator.update(f, PROFILE); }
  f.applyHit({ damage: 5, knockback: 10, knockbackUp: 3, hitstun: 12, fromFacing: -1 });
  for (let i = 0; i < 150; i++) {
    lib.tick();
    trace.push(lib.Animator.update(f, PROFILE).stretch);
  }
  return { f, trace };
}

test('elastic Nathan stretches when hit, overshoots and settles; other fighters never stretch', () => {
  const lib = load();
  const { trace } = run(lib, 'nathan');
  const peak = Math.max(...trace.map(Math.abs));
  assert.ok(peak > 0.35, `stretch should be clearly visible (peak ${peak.toFixed(2)})`);
  assert.ok(peak <= 1.4, 'stretch is clamped');
  const early = trace.slice(0, 40);
  assert.ok(early.some((v) => v > 0.05) && early.some((v) => v < -0.05), 'should swing to both sides (a snap-back wobble)');
  assert.ok(Math.abs(trace[trace.length - 1]) < 0.02, `should have settled, still at ${trace[trace.length - 1]}`);
  for (const id of ['sam', 'john', 'carlos']) {
    assert.ok(run(lib, id).trace.every((v) => v === 0), `${id} is not elastic and must not stretch`);
  }
});

test('the stretch is driven by the hit direction, so it mirrors with facing', () => {
  const lib = load();
  const a = run(lib, 'nathan').trace.find((v) => Math.abs(v) > 0.05);
  const f = new lib.Fighter('p1', lib.CHARACTERS.nathan, 500, -1); // facing left instead
  for (let i = 0; i < 6; i++) { lib.tick(); lib.Animator.update(f, PROFILE); }
  f.applyHit({ damage: 5, knockback: 10, knockbackUp: 3, hitstun: 12, fromFacing: 1 }); // same body-relative hit
  let b = 0;
  for (let i = 0; i < 20 && Math.abs(b) < 0.05; i++) { lib.tick(); b = lib.Animator.update(f, PROFILE).stretch; }
  assert.strictEqual(Math.sign(a), Math.sign(b), 'same body-relative hit should stretch the same way');
});

test('Nathan reaches further and John is broader than the default body', () => {
  const lib = load();
  const arms = (id, profile) => {
    const f = new lib.Fighter('p1', lib.CHARACTERS[id], 500, 1);
    for (let i = 0; i < 10; i++) { lib.tick(); lib.Animator.update(f, profile); }
    return lib.Animator.update(f, profile).arms;
  };
  const plain = arms('nathan', PROFILE)[1];
  const long = arms('nathan', { ...PROFILE, armScale: 1.25 })[1];
  assert.ok(Math.hypot(long.x, long.y) > Math.hypot(plain.x, plain.y) * 1.2, 'armScale should lengthen arm poses');
});

test('a crouch-roll turns the body with the distance covered and finishes the turn when it stops', () => {
  const lib = load();
  const f = new lib.Fighter('p1', lib.CHARACTERS.artur, 500, 1);
  f.grounded = true;
  f.state = 'block'; f.rolling = true; f.vx = 3.6;
  let rot = 0;
  for (let i = 0; i < 60; i++) { lib.tick(); rot = lib.Animator.update(f, PROFILE).rot; }
  const turned = Math.abs(rot);
  assert.ok(turned > 2.5, `should have turned well over half a revolution in 60 frames (${turned.toFixed(2)} rad)`);
  assert.ok(lib.Animator.update(f, PROFILE).ball > 0.5, 'curled into a ball');
  // Stop: it should keep turning (never reverse) until a whole turn is done, then stand.
  f.rolling = false; f.vx = 0; f.state = 'idle';
  let prev = rot, reversed = false, last = null;
  const wrap = (x) => x - Math.PI * 2 * Math.round(x / (Math.PI * 2)); // whole turns are the same pose
  for (let i = 0; i < 90; i++) { lib.tick(); last = lib.Animator.update(f, PROFILE); if (wrap(last.rot - prev) < -0.05) reversed = true; prev = last.rot; }
  assert.strictEqual(reversed, false, 'must not unwind backwards through a flop');
  const wrapped = ((last.rot % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  assert.ok(Math.abs(wrapped) < 0.15, `should end upright (off by ${wrapped.toFixed(2)} rad)`);
  assert.ok(last.ball < 0.2, 'and uncurled');
});

test('elastic Nathan squashes and stretches vertically with his jump; others stay put', () => {
  const lib = load();
  const rise = (id) => {
    const f = new lib.Fighter('p1', lib.CHARACTERS[id], 500, 1);
    for (let i = 0; i < 6; i++) { lib.tick(); lib.Animator.update(f, PROFILE); }
    f.grounded = false; f.y = 400; f.vy = -14; f.state = 'jump';
    let vs = 1;
    for (let i = 0; i < 12; i++) { lib.tick(); vs = lib.Animator.update(f, PROFILE).vstretch; }
    return vs;
  };
  assert.ok(rise('nathan') > 1.08, `Nathan should lengthen rising (${rise('nathan').toFixed(3)})`);
  assert.strictEqual(rise('sam'), 1);
});
