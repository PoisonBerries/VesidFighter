// Headless simulation tests. The sim is built the same way server/server.js
// builds it (same files, same stubs), so these also guard online play.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT } = require('./helpers');

const SIM_FILES = ['constants.js', 'input.js', 'characters.js', 'effects.js', 'fighter.js', 'game.js'];
const HELD = ['left', 'right', 'block'];
const TAPS = ['jump', 'attack', 'special', 'ultimate'];
const ACTIONS = HELD.concat(TAPS);

const source = SIM_FILES.map((f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n;\n');
const PRELUDE = `
  const window = { addEventListener() {} };
  const VCONTROLS = {};
  for (const slot of ['p1', 'p2']) { VCONTROLS[slot] = {}; for (const a of ${JSON.stringify(ACTIONS)}) VCONTROLS[slot][a] = 'V_' + slot + '_' + a; }
  const Net = { controlsFor: (slot) => VCONTROLS[slot] };
`;
const EXPORTS = '\n({ Game, InputManager, Effects, Fighter, CHARACTERS, CHARACTER_LIST, VCONTROLS, GROUND_Y, STAGE_LEFT_EDGE, STAGE_RIGHT_EDGE, FIXED_STEP, ULT_METER_MAX, CROUCH_HEIGHT, HIGH_ATTACK_BOTTOM });';
const script = new vm.Script(PRELUDE + source + EXPORTS, { filename: 'sim.js' });

function createSim() {
  const context = vm.createContext({ console, Math, JSON, performance: { now: () => 0 } });
  return script.runInContext(context);
}

// Deterministic pseudo-random inputs so failures are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function driveRandom(sim, frames, seed, onFrame) {
  const rand = rng(seed);
  const held = { p1: {}, p2: {} };
  for (let i = 0; i < frames; i++) {
    for (const slot of ['p1', 'p2']) {
      for (const a of HELD) {
        if (rand() < 0.08) held[slot][a] = !held[slot][a];
        sim.InputManager.setVirtual(sim.VCONTROLS[slot][a], !!held[slot][a], false);
      }
      for (const a of TAPS) {
        const p = a === 'ultimate' ? 0.01 : 0.04;
        sim.InputManager.setVirtual(sim.VCONTROLS[slot][a], false, rand() < p);
      }
    }
    sim.Game.update(sim.FIXED_STEP);
    if (onFrame) onFrame(i);
  }
}

function assertFinite(obj, where) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${where}: ${k} is ${v}`);
  }
}

const STATES = new Set(['idle', 'walk', 'jump', 'fall', 'block', 'attack', 'special', 'ultimate', 'hitstun', 'knockdown', 'ko', 'victory']);

test('every character can fight every other character for a whole match without errors', () => {
  const sim = createSim();
  const ids = sim.CHARACTER_LIST.map((c) => c.id);
  let seed = 1;
  for (let i = 0; i < ids.length; i++) {
    const a = ids[i], b = ids[(i + 3) % ids.length];
    sim.Game.startMatch(a, b, () => {});
    driveRandom(sim, 2400, seed++, () => {
      const snap = sim.Game.getSnapshot();
      for (const f of snap.f) {
        assertFinite(f, `${a} vs ${b}`);
        assert.ok(STATES.has(f.state), `${a} vs ${b}: unknown state ${f.state}`);
        assert.ok(f.hp >= 0);
      }
    });
    const snap = sim.Game.getSnapshot();
    assert.ok(['countdown', 'fight', 'roundEnd', 'matchEnd', 'idle'].includes(snap.m));
  }
});

test('mirror matches work (same character on both sides)', () => {
  const sim = createSim();
  for (const c of sim.CHARACTER_LIST) {
    sim.Game.startMatch(c.id, c.id, () => {});
    driveRandom(sim, 900, 7);
  }
});

test('the simulation is deterministic (same inputs -> same state), which online play relies on', () => {
  const run = () => {
    const sim = createSim();
    sim.Game.startMatch('carlos', 'sam', () => {});
    driveRandom(sim, 1500, 42);
    const s = sim.Game.getSnapshot();
    delete s.fx;
    return JSON.stringify(s);
  };
  assert.strictEqual(run(), run());
});

test('a snapshot survives a JSON round trip and can be applied by another sim (the guest path)', () => {
  const host = createSim(), guest = createSim();
  host.Game.startMatch('owen', 'ryan', () => {});
  guest.Game.startMatch('owen', 'ryan', () => {});
  driveRandom(host, 600, 5);
  const wire = JSON.parse(JSON.stringify(host.Game.getSnapshot()));
  assert.doesNotThrow(() => guest.Game.applySnapshot(wire));
  const g = guest.Game.getSnapshot();
  assert.strictEqual(g.f[0].hp, wire.f[0].hp);
  assert.strictEqual(g.f[1].x, wire.f[1].x);
});

function startFighter(sim, id, x) {
  const f = new sim.Fighter('p1', sim.CHARACTERS[id], x, 1);
  const foe = new sim.Fighter('p2', sim.CHARACTERS.sam, 900, -1);
  return { f, foe };
}

test('walking off the edge and back never re-lands sideways; only a jump gets you back', () => {
  const sim = createSim();
  const { f, foe } = startFighter(sim, 'keenan', sim.STAGE_LEFT_EDGE + 30);
  const C = sim.VCONTROLS.p1;
  const hold = (keys) => { for (const a of ACTIONS) sim.InputManager.setVirtual(C[a], keys.includes(a), false); };
  hold(['left']);
  for (let i = 0; i < 9; i++) f.update(C, foe);
  assert.ok(f.y > sim.GROUND_Y, 'should have dropped below the platform top');
  hold(['right']);
  for (let i = 0; i < 40; i++) f.update(C, foe);
  assert.strictEqual(f.grounded, false, 'walking back in must not re-land');
  assert.ok(f.y > sim.GROUND_Y);

  // Fresh fall, then jump: recovery works.
  const g = startFighter(sim, 'keenan', sim.STAGE_LEFT_EDGE + 30);
  hold(['left']);
  for (let i = 0; i < 9; i++) g.f.update(C, g.foe);
  hold(['right']);
  for (let i = 0; i < 4; i++) g.f.update(C, g.foe);
  sim.InputManager.setVirtual(C.jump, false, true);
  g.f.update(C, g.foe);
  sim.InputManager.setVirtual(C.jump, false, false);
  let landed = false;
  for (let i = 0; i < 100 && !landed; i++) { g.f.update(C, g.foe); landed = g.f.grounded; }
  assert.ok(landed, 'a jump from just below the edge should land back on the stage');
  assert.strictEqual(g.f.y, sim.GROUND_Y);
});

test('every attack, special and ultimate finishes and hands control back', () => {
  const sim = createSim();
  const C = sim.VCONTROLS.p1;
  const press = (a) => { sim.InputManager.setVirtual(C[a], false, true); };
  const release = () => { for (const a of ACTIONS) sim.InputManager.setVirtual(C[a], false, false); };
  for (const c of sim.CHARACTER_LIST) {
    for (const move of ['attack', 'special', 'ultimate']) {
      const { f, foe } = startFighter(sim, c.id, 400);
      f.ultCharge = sim.ULT_METER_MAX;
      release();
      for (let i = 0; i < 5; i++) f.update(C, foe);
      press(move);
      f.update(C, foe);
      release();
      let frames = 0;
      while (frames < 400) {
        f.update(C, foe);
        frames++;
        if (['idle', 'jump', 'fall', 'walk'].includes(f.state) && frames > 3) break;
      }
      assert.ok(['idle', 'jump', 'fall', 'walk'].includes(f.state), `${c.id} ${move} never finished (stuck in ${f.state})`);
      assertFinite(f, `${c.id} ${move}`);
    }
  }
});

test('getting hit, knocked down and KO\'d all recover or settle', () => {
  const sim = createSim();
  const C = sim.VCONTROLS.p1;
  for (const c of sim.CHARACTER_LIST) {
    const { f, foe } = startFighter(sim, c.id, 500);
    f.applyHit({ damage: 5, knockback: 9, knockbackUp: 5, hitstun: 20, fromFacing: -1 });
    for (let i = 0; i < 120; i++) f.update(C, foe);
    assert.ok(['idle', 'walk'].includes(f.state), `${c.id} stuck in ${f.state} after hitstun`);
    f.applyHit({ damage: 5, knockback: 9, knockbackUp: 5, hitstun: 20, fromFacing: -1, knockdown: true, knockdownDuration: 50 });
    for (let i = 0; i < 200; i++) f.update(C, foe);
    assert.ok(['idle', 'walk'].includes(f.state), `${c.id} stuck in ${f.state} after knockdown`);
  }
});

test('Carlos hovers while jump is held (limited fuel, refills on landing); a tap or another character does not hover', () => {
  const sim = createSim();
  const C = sim.VCONTROLS.p1;
  const setJump = (down, pressed) => sim.InputManager.setVirtual(C.jump, down, pressed);
  const others = () => { for (const a of ACTIONS) if (a !== 'jump') sim.InputManager.setVirtual(C[a], false, false); };

  // Held jump.
  const { f, foe } = startFighter(sim, 'carlos', 500);
  const max = sim.CHARACTERS.carlos.hover.frames;
  others();
  setJump(true, true); f.update(C, foe);
  setJump(true, false);
  const ys = [];
  let hoverFrames = 0, everHovered = false;
  for (let i = 0; i < 200 && !(f.grounded && i > 5); i++) {
    f.update(C, foe);
    if (f.hovering) { hoverFrames++; everHovered = true; ys.push(f.y); }
  }
  assert.ok(everHovered, 'holding jump should start a hover');
  assert.ok(hoverFrames <= max, `hovered ${hoverFrames} frames, more than the ${max} of fuel`);
  assert.ok(hoverFrames >= max - 2, `should use (nearly) all its fuel while held, used ${hoverFrames}`);
  assert.ok(Math.max(...ys) - Math.min(...ys) < 3, 'position should stay put while hovering');
  assert.ok(f.hoverLeft === 0 || f.grounded, 'fuel should be spent (or already refilled by landing)');
  for (let i = 0; i < 120 && !f.grounded; i++) f.update(C, foe);
  assert.ok(f.grounded, 'should come down once the fuel runs out');
  f.update(C, foe);
  assert.strictEqual(f.hoverLeft, max, 'landing refills the fuel');

  // A quick tap never hovers (released before the apex).
  const t = startFighter(sim, 'carlos', 500);
  setJump(true, true); t.f.update(C, t.foe);
  setJump(false, false);
  for (let i = 0; i < 100 && !(t.f.grounded && i > 5); i++) { t.f.update(C, t.foe); assert.ok(!t.f.hovering, 'a tap must not hover'); }

  // Pressing jump again in the air is not a double jump.
  const d = startFighter(sim, 'carlos', 500);
  setJump(true, true); d.f.update(C, d.foe);
  setJump(false, false);
  for (let i = 0; i < 6; i++) d.f.update(C, d.foe);
  const vyBefore = d.f.vy;
  setJump(false, true); d.f.update(C, d.foe); setJump(false, false);
  assert.ok(d.f.vy > vyBefore - 0.01, 'no second jump impulse');

  // Characters without the hover data never hover, even holding jump.
  for (const c of sim.CHARACTER_LIST.filter((c) => !c.hover)) {
    const x = startFighter(sim, c.id, 500);
    setJump(true, true); x.f.update(C, x.foe); setJump(true, false);
    for (let i = 0; i < 90; i++) { x.f.update(C, x.foe); assert.ok(!x.f.hovering, `${c.id} should not hover`); }
    setJump(false, false);
  }
});

// Sets a fighter flying to the right in mid-air and returns it ready to act.
function airborneMovingRight(sim, id) {
  const C = sim.VCONTROLS.p1;
  const { f, foe } = startFighter(sim, id, 300);
  f.ultCharge = sim.ULT_METER_MAX;
  const set = (keys, pressed = []) => { for (const a of ACTIONS) sim.InputManager.setVirtual(C[a], keys.includes(a), pressed.includes(a)); };
  for (let i = 0; i < 5; i++) f.update(C, foe);
  set(['right'], ['jump']); f.update(C, foe);
  for (let i = 0; i < 6; i++) { set(['right']); f.update(C, foe); }
  assert.strictEqual(f.grounded, false, `${id} should be airborne`);
  return { f, foe, C, set };
}

test('a regular attack in the air keeps horizontal momentum; on the ground it still stops', () => {
  const sim = createSim();
  for (const c of sim.CHARACTER_LIST) {
    const { f, foe, C, set } = airborneMovingRight(sim, c.id);
    set(['right'], ['attack']); f.update(C, foe);
    set([]);
    assert.strictEqual(f.state, 'attack');
    const vx0 = f.vx;
    assert.ok(vx0 > 1, `${c.id}: expected forward speed going into the attack, got ${vx0}`);
    let frames = 0;
    while (f.state === 'attack' && !f.grounded && frames < 30) {
      f.update(C, foe); frames++;
      if (f.state === 'attack' && !f.grounded) assert.ok(Math.abs(f.vx - vx0) < 1e-9, `${c.id}: air attack changed vx ${vx0} -> ${f.vx} on frame ${frames}`);
    }
    assert.ok(frames >= 4, `${c.id}: airborne for too few attack frames to check (${frames})`);

    // Same attack from the ground: friction stops them.
    const g = startFighter(sim, c.id, 300);
    set(['right']);
    for (let i = 0; i < 12; i++) g.f.update(C, g.foe);
    set([], ['attack']); g.f.update(C, g.foe); set([]);
    for (let i = 0; i < 12; i++) g.f.update(C, g.foe);
    assert.ok(Math.abs(g.f.vx) < 0.5, `${c.id}: a grounded attack should still slow to a stop (vx ${g.f.vx})`);
  }
});

test('specials in the air keep momentum too, except moves that plant the fighter (Rubber Guard)', () => {
  const sim = createSim();
  for (const c of sim.CHARACTER_LIST) {
    const { f, foe, C, set } = airborneMovingRight(sim, c.id);
    f.specialCooldownTimer = 0;
    set(['right'], ['special']); f.update(C, foe);
    set([]);
    if (f.state !== 'special') continue; // e.g. a character whose special can't start here
    const vx0 = f.vx;
    for (let i = 0; i < 3; i++) f.update(C, foe);
    if (c.special.type === 'reflectStance') {
      assert.strictEqual(f.vx, 0, `${c.id}: Rubber Guard plants the fighter`);
    } else {
      assert.ok(f.vx > vx0 * 0.9, `${c.id}: air special ${c.special.type} lost its momentum (${vx0} -> ${f.vx})`);
    }
  }
});

test('hits, blocks and reflects are announced with a counter the visuals (and online clients) can watch', () => {
  const sim = createSim();
  const { f } = startFighter(sim, 'nathan', 500);
  const hit = { damage: 5, knockback: 10, knockbackUp: 3, hitstun: 12, fromFacing: -1 };
  assert.strictEqual(f.impactSeq, 0);
  f.applyHit(hit);
  assert.strictEqual(f.impactSeq, 1);
  assert.strictEqual(f.impactKind, 'hit');
  assert.strictEqual(f.impactDir, -1);
  assert.ok(f.impactPower >= 0.5);

  const b = startFighter(sim, 'nathan', 500).f;
  b.blocking = true; b.applyHit(hit);
  assert.strictEqual(b.impactKind, 'blocked');
  assert.ok(b.impactPower < 0.5, 'a block is a smaller shove than a hit');

  const r = startFighter(sim, 'nathan', 500).f;
  r.reflectTimer = 30; r.applyHit(hit);
  assert.strictEqual(r.impactKind, 'reflected');
  assert.strictEqual(r.impactSeq, 1);

  const d = startFighter(sim, 'nathan', 500).f;
  d.invulnerableTimer = 10; d.applyHit(hit);
  assert.strictEqual(d.impactSeq, 0, 'a dodged hit is not an impact');
});

test('Robert transforms at half HP, and the transformation resets at the start of the next round', () => {
  const sim = createSim();
  const base = sim.CHARACTERS.robert;
  const { f } = startFighter(sim, 'robert', 500);
  assert.strictEqual(f.transformed, false);
  f.applyHit({ damage: f.hp - base.maxHp * base.transform.hpThreshold + 1, knockback: 5, knockbackUp: 1, hitstun: 5, fromFacing: -1 });
  assert.strictEqual(f.transformed, true, 'should transform once HP reaches the threshold');
  assert.strictEqual(f.maxHp, base.maxHp + base.transform.bonusHp);
  assert.ok(f.width > sim.CHARACTERS.robert.sizeScale * 96, 'transformed Robert is bigger');
  f.revertTransform();
  assert.strictEqual(f.transformed, false);
  assert.strictEqual(f.maxHp, base.maxHp);

  // End to end through the round flow: transform, lose the round, start the next one.
  sim.Game.startMatch('robert', 'sam', () => {});
  driveRandom(sim, 200, 3); // through the countdown into the fight
  sim.Game.applySnapshot({ f: [{ transformed: true, maxHp: base.maxHp + base.transform.bonusHp, hp: 5 }, { hp: 0 }] });
  for (let i = 0; i < 400; i++) {
    sim.Game.update(sim.FIXED_STEP);
    if (sim.Game.getSnapshot().m === 'countdown' && i > 30) break;
  }
  const s = sim.Game.getSnapshot();
  assert.strictEqual(s.m, 'countdown', 'the next round should have started');
  assert.strictEqual(s.f[0].transformed, false, 'transformation must not carry into the next round');
  assert.strictEqual(s.f[0].maxHp, base.maxHp);
  assert.strictEqual(s.f[0].hp, base.maxHp, 'and he starts the round at full base HP');
});

test('a transformed Robert hits as hard as before the base nerf (base got slightly weaker, transformed did not)', () => {
  const sim = createSim();
  const r = sim.CHARACTERS.robert;
  const transformedBasic = r.attack.damage * r.transform.dmgMul;
  assert.ok(transformedBasic >= 16 && transformedBasic <= 17.5, `transformed basic attack ${transformedBasic}`);
  assert.ok(r.attack.damage <= 10, 'base Robert should be a touch weaker than before (was 11)');
  assert.ok(r.maxHp < 115, 'base Robert should have a little less HP than before (was 115)');
  assert.ok(r.maxHp + r.transform.bonusHp >= 170, 'transformed HP pool unchanged (~173)');
});

test('nothing lingers between rounds: buffs, poison, shields, stun and transformations are all cleared', () => {
  const sim = createSim();
  const lingering = { buffTimer: 300, buffAtkMul: 1.4, buffSpdMul: 1.45, buffSizeMul: 1.35, atkSpeedMul: 1.6, poisonTicksLeft: 4, poisonTickTimer: 7, poisonDamagePerTick: 3, invulnerableTimer: 20, _dodging: true, reflectTimer: 25, hitFlashTimer: 9, hoverLeft: 3, hovering: true, transformed: true, maxHp: 180 };

  // Unit level: the reset itself.
  const { f } = startFighter(sim, 'robert', 500);
  Object.assign(f, lingering);
  f.resetForRound();
  assert.strictEqual(f.buffTimer, 0);
  assert.strictEqual(f.buffSizeMul, 1);
  assert.strictEqual(f.buffAtkMul, 1);
  assert.strictEqual(f.buffSpdMul, 1);
  assert.strictEqual(f.atkSpeedMul, 1);
  assert.strictEqual(f.poisonTicksLeft, 0);
  assert.strictEqual(f.invulnerableTimer, 0);
  assert.strictEqual(f._dodging, false);
  assert.strictEqual(f.reflectTimer, 0);
  assert.strictEqual(f.transformed, false);
  assert.strictEqual(f.maxHp, sim.CHARACTERS.robert.maxHp);
  assert.strictEqual(f.width, 96 * sim.CHARACTERS.robert.sizeScale, 'back to normal size');

  // Through the real round flow, for every character.
  for (const c of sim.CHARACTER_LIST) {
    sim.Game.startMatch(c.id, 'sam', () => {});
    driveRandom(sim, 200, 11);
    sim.Game.applySnapshot({ f: [Object.assign({ hp: 5 }, lingering, { maxHp: c.maxHp }), { hp: 0 }] });
    for (let i = 0; i < 400; i++) {
      sim.Game.update(sim.FIXED_STEP);
      if (sim.Game.getSnapshot().m === 'countdown' && i > 30) break;
    }
    const s = sim.Game.getSnapshot();
    assert.strictEqual(s.m, 'countdown', `${c.id}: next round should have started`);
    const p = s.f[0];
    assert.strictEqual(p.buffTimer, 0, `${c.id}: buff carried over`);
    assert.strictEqual(p.buffSizeMul, 1, `${c.id}: size buff carried over`);
    assert.strictEqual(p.poisonTicksLeft, 0, `${c.id}: poison carried over`);
    assert.strictEqual(p.reflectTimer, 0, `${c.id}: reflect carried over`);
    assert.strictEqual(p.invulnerableTimer, 0, `${c.id}: invulnerability carried over`);
    assert.strictEqual(p.transformed, false, `${c.id}: transformation carried over`);
    assert.strictEqual(p.hp, c.maxHp, `${c.id}: should start at full base HP`);
  }
});


// ---- Crouching ----
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// The box a fighter's basic attack has during its active frames, and whether
// it touches `targetId` (standing or crouching) standing right in front.
function punchHits(sim, attackerId, targetId, crouching) {
  const A = new sim.Fighter('p1', sim.CHARACTERS[attackerId], 500, 1);
  const atk = sim.CHARACTERS[attackerId].attack;
  A.state = 'attack';
  A.actionTimer = atk.startup + 1;
  const box = A.getHitbox();
  assert.ok(box, `${attackerId} should have an active hitbox`);
  const T = new sim.Fighter('p2', sim.CHARACTERS[targetId], box.x + box.w / 2, -1);
  T.grounded = true;
  T.state = crouching ? 'block' : 'idle';
  return overlaps(box, T.getHurtbox());
}

test('crouching (holding block on the ground) shrinks the hurtbox in proportion to height', () => {
  const sim = createSim();
  for (const c of sim.CHARACTER_LIST) {
    const f = new sim.Fighter('p1', c, 500, 1);
    f.grounded = true;
    f.state = 'idle';
    assert.strictEqual(f.getHurtbox().h, f.height);
    f.state = 'block';
    const h = f.getHurtbox();
    assert.ok(Math.abs(h.h - f.height * sim.CROUCH_HEIGHT) < 1e-9, `${c.id}: crouched hurtbox ${h.h}`);
    assert.strictEqual(h.y + h.h, f.y, 'the crouched box still stands on the floor');
    f.grounded = false; // in the air the block key doesn't crouch you
    assert.strictEqual(f.getHurtbox().h, f.height);
  }
  const small = new sim.Fighter('p1', sim.CHARACTERS.keenan, 500, 1), big = new sim.Fighter('p1', sim.CHARACTERS.john, 500, 1);
  for (const f of [small, big]) { f.grounded = true; f.state = 'block'; }
  assert.ok(small.getHurtbox().h < big.getHurtbox().h * 0.7, 'a small fighter crouches much lower than a big one');
});

test('punches are high attacks: you duck a punch from anyone about your height or taller; nobody ducks a standing hit', () => {
  const sim = createSim();
  const ids = sim.CHARACTER_LIST.map((c) => c.id);
  let ducks = 0, hits = 0;
  for (const a of ids) {
    for (const t of ids) {
      assert.ok(punchHits(sim, a, t, false), `${a}'s punch must hit a standing ${t}`);
      const Ha = new sim.Fighter('p1', sim.CHARACTERS[a], 0, 1).height, Ht = new sim.Fighter('p2', sim.CHARACTERS[t], 0, 1).height;
      const expectDuck = a !== 'artur' && Ht * sim.CROUCH_HEIGHT <= Ha * sim.HIGH_ATTACK_BOTTOM;
      const hit = punchHits(sim, a, t, true);
      assert.strictEqual(hit, !expectDuck, `${a} punching a crouching ${t}: expected ${expectDuck ? 'a duck' : 'a hit'}`);
      if (hit) hits++; else ducks++;
    }
  }
  assert.ok(ducks > 10 && hits > 10, `both outcomes should occur across the roster (ducks ${ducks}, hits ${hits})`);
  // The headline cases.
  assert.strictEqual(punchHits(sim, 'john', 'keenan', true), false, 'small Keenan ducks big John\'s punch');
  assert.strictEqual(punchHits(sim, 'keenan', 'john', true), true, 'big John cannot duck small Keenan\'s punch');
  assert.strictEqual(punchHits(sim, 'ryan', 'sam', true), false, 'Sam ducks Ryan');
});

test('Artur\'s kick is a low attack: nobody ducks it', () => {
  const sim = createSim();
  for (const t of sim.CHARACTER_LIST.map((c) => c.id)) {
    assert.ok(punchHits(sim, 'artur', t, true), `Artur's kick should hit a crouching ${t}`);
  }
});

// Runs a real fight frame by frame: the target holds block (crouched), the
// attacker throws one basic attack. Returns the HP the target lost.
function crouchBlockedDamage(sim, attackerId, targetId, targetBlocks) {
  sim.Game.startMatch(attackerId, targetId, () => {});
  for (let i = 0; i < 200; i++) sim.Game.update(sim.FIXED_STEP);
  sim.Game.applySnapshot({ f: [{ x: 500 }, { x: 560 }] });
  const before = sim.Game.getSnapshot().f[1].hp;
  sim.InputManager.setVirtual(sim.VCONTROLS.p2.block, !!targetBlocks, false);
  sim.InputManager.setVirtual(sim.VCONTROLS.p1.attack, false, true);
  sim.Game.update(sim.FIXED_STEP);
  sim.InputManager.setVirtual(sim.VCONTROLS.p1.attack, false, false);
  for (let i = 0; i < 40; i++) sim.Game.update(sim.FIXED_STEP);
  sim.InputManager.setVirtual(sim.VCONTROLS.p2.block, false, false);
  return before - sim.Game.getSnapshot().f[1].hp;
}

test('through the real game loop: a crouch ducks a high punch, but Artur\'s kick cuts through a crouch-block', () => {
  const sim = createSim();
  // Ryan (160 tall) punching a crouched Keenan (136): ducked, no damage at all.
  assert.strictEqual(crouchBlockedDamage(sim, 'ryan', 'keenan', true), 0);
  // The same punch on a standing Keenan lands.
  assert.ok(crouchBlockedDamage(sim, 'ryan', 'keenan', false) > 5);
  // Artur's kick vs a crouch-blocking Keenan: 45% absorbed, not 85%.
  const kick = sim.CHARACTERS.artur.attack;
  const lost = crouchBlockedDamage(sim, 'artur', 'keenan', true);
  assert.ok(Math.abs(lost - kick.damage * kick.blockDamageMul) < 0.01, `expected ~${kick.damage * kick.blockDamageMul} damage through the guard, got ${lost}`);
  assert.ok(lost > kick.damage * 0.15 * 2.5, 'much more than a normal block lets through');
  // A blocked high punch that does connect (same-height target, crouch too high to duck) still only chips 15%.
  const hit = sim.CHARACTERS.carlos.attack;
  const chip = crouchBlockedDamage(sim, 'carlos', 'john', true);
  assert.ok(Math.abs(chip - hit.damage * 0.15) < 0.01, `a normal block should let 15% through, got ${chip} of ${hit.damage}`);
});
