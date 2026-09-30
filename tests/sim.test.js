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
  sim.Game.startMatch('robert', 'sam', () => {}, { balance: false }); // needs health KOs
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
    sim.Game.startMatch(c.id, 'sam', () => {}, { balance: false }); // needs health KOs
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
  sim.Game.startMatch(attackerId, targetId, () => {}, { ball: 'off' }); // full damage numbers
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

// ---- The ball: bomb mode ----

// Starts a fight with the fighters placed and a ball set up as given.
function ballScene(sim, ball, fighters, mode) {
  sim.Game.startMatch('ryan', 'carlos', () => {}, { ball: mode || 'bomb' });
  for (let i = 0; i < 181; i++) sim.Game.update(sim.FIXED_STEP); // countdown over, no ball yet
  sim.Game.applySnapshot({
    f: fighters || [{ x: 500 }, { x: 900 }],
    bl: Object.assign({ phase: 'live', timer: 0, vx: 0, vy: 0, spin: 0, fuse: 540, lastHit: null, grace: { p1: 0, p2: 0 }, hitstop: 0, heat: 0, live: false, liveBounces: 0, cool: 0, heldBy: null, holdT: 0, blastX: 0, blastY: 0, blastT: 0 }, ball),
  });
}

const step = (sim, n) => { for (let i = 0; i < n; i++) sim.Game.update(sim.FIXED_STEP); };

test('bomb: a ball drops in shortly after the fight starts', () => {
  const sim = createSim();
  sim.Game.startMatch('ryan', 'carlos', () => {}, { ball: 'bomb' });
  step(sim, 181);
  assert.strictEqual(sim.Game.world().ball.phase, 'waiting');
  step(sim, 200);
  assert.notStrictEqual(sim.Game.world().ball.phase, 'waiting');
});

test('bomb: a punch from the ground bumps it up and toward the opponent', () => {
  const sim = createSim();
  // Ball hanging just in front of Ryan's fist.
  ballScene(sim, { x: 590, y: 560 - 125 });
  sim.InputManager.setVirtual(sim.VCONTROLS.p1.attack, false, true);
  step(sim, 1);
  sim.InputManager.setVirtual(sim.VCONTROLS.p1.attack, false, false);
  step(sim, 12);
  const b = sim.Game.world().ball;
  assert.strictEqual(b.lastHit, 'p1');
  assert.ok(b.vx > 0 && b.vy < 0, `expected up and right, got vx ${b.vx} vy ${b.vy}`);
});

test('bomb: touching it is harmless -- it just bounces off your body', () => {
  const sim = createSim();
  // Dropping onto p2's head: pops back up, no damage.
  ballScene(sim, { x: 900, y: 360, vy: 4 });
  const hp0 = sim.Game.world().p2.hp;
  step(sim, 25);
  let b = sim.Game.world().ball;
  assert.strictEqual(sim.Game.world().p2.hp, hp0, 'no damage from contact');
  assert.strictEqual(sim.Game.world().p2.state === 'hitstun', false, 'no hitstun either');
  assert.ok(b.vy < 0 && b.y < 560 - 160, `bounced up off the head (vy ${b.vy}, y ${b.y})`);

  // Flying sideways into p2: comes back the other way.
  ballScene(sim, { x: 800, y: 480, vx: 6, vy: -2 });
  step(sim, 15);
  b = sim.Game.world().ball;
  assert.ok(b.vx < 0, `bounced back off the body (vx ${b.vx})`);
  assert.strictEqual(sim.Game.world().p2.hp, hp0);
});

test('bomb: holding toward drives a hit flatter and farther, holding away pops it up', () => {
  const launch = (hold) => {
    const sim = createSim();
    ballScene(sim, { x: 590, y: 560 - 125 });
    if (hold) sim.InputManager.setVirtual(sim.VCONTROLS.p1[hold], true, false);
    sim.InputManager.setVirtual(sim.VCONTROLS.p1.attack, false, true);
    step(sim, 1);
    sim.InputManager.setVirtual(sim.VCONTROLS.p1.attack, false, false);
    let b;
    for (let i = 0; i < 20; i++) { step(sim, 1); b = sim.Game.world().ball; if (b.lastHit) break; }
    return { vx: b.vx, vy: b.vy };
  };
  const toward = launch('right'), neutral = launch(null), away = launch('left');
  assert.ok(toward.vx > neutral.vx && neutral.vx > away.vx && away.vx > 0, 'always toward the opponent, farther when holding toward');
  assert.ok(away.vy < neutral.vy && neutral.vy < toward.vy, 'higher when holding away');
});

test('bomb: it explodes on the floor, hurting whoever is close, then another comes', () => {
  const sim = createSim();
  ballScene(sim, { x: 620, y: 520, vy: 6 });
  const w0 = sim.Game.world();
  const hp1 = w0.p1.hp, hp2 = w0.p2.hp;
  step(sim, 10);
  const w = sim.Game.world();
  assert.strictEqual(w.ball.phase, 'waiting');
  assert.ok(w.ball.blastT > 0, 'blast flash');
  assert.ok(hp1 - w.p1.hp > 10, 'p1 was next to it');
  assert.strictEqual(hp2, w.p2.hp, 'p2 was far away');
  step(sim, 300 + 60);
  assert.notStrictEqual(sim.Game.world().ball.phase, 'waiting', 'a new ball arrives');
});

test('bomb: the fuse runs out mid-air and it explodes anyway', () => {
  const sim = createSim();
  ballScene(sim, { x: 700, y: 200, vy: -1, fuse: 5 });
  step(sim, 6);
  assert.strictEqual(sim.Game.world().ball.phase, 'waiting');
});

test('ball: can be turned off per match', () => {
  const sim = createSim();
  sim.Game.startMatch('ryan', 'carlos', () => {}, { ball: false });
  step(sim, 800);
  assert.strictEqual(sim.Game.world().ball, null);
});

// ---- The ball: rally mode (the default) ----

const punch = (sim, slot, hold) => {
  if (hold) sim.InputManager.setVirtual(sim.VCONTROLS[slot][hold], true, false);
  sim.InputManager.setVirtual(sim.VCONTROLS[slot].attack, false, true);
  step(sim, 1);
  sim.InputManager.setVirtual(sim.VCONTROLS[slot].attack, false, false);
};

test('rally: the ball is there from the start, and a loose ball keeps bouncing forever', () => {
  const sim = createSim();
  sim.Game.startMatch('ryan', 'carlos', () => {});
  assert.strictEqual(sim.Game.world().ballMode, 'rally');
  step(sim, 181 + 60);
  assert.strictEqual(sim.Game.world().ball.phase, 'live');
  let top = Infinity;
  for (let i = 0; i < 900; i++) { step(sim, 1); if (i > 600) top = Math.min(top, sim.Game.world().ball.y); }
  assert.ok(top < 560 - 100, `still bouncing to punching height after 15s (top ${top})`);
});

test('rally: every hit heats the ball up and makes it faster', () => {
  const sim = createSim();
  const speedAt = (heat) => {
    ballScene(sim, { x: 590, y: 560 - 125, heat }, null, 'rally');
    punch(sim, 'p1');
    for (let i = 0; i < 20; i++) { step(sim, 1); if (sim.Game.world().ball.live) break; }
    const b = sim.Game.world().ball;
    return { heat: b.heat, speed: Math.hypot(b.vx, b.vy), live: b.live, owner: b.lastHit };
  };
  const cold = speedAt(0), hot = speedAt(6);
  assert.strictEqual(cold.heat, 1);
  assert.strictEqual(hot.heat, 7);
  assert.ok(cold.live && cold.owner === 'p1');
  assert.ok(hot.speed > cold.speed * 1.4, `hotter is faster (${cold.speed} -> ${hot.speed})`);
});

test('rally: a live ball hurts the other fighter, more when hotter; a loose one does not', () => {
  const sim = createSim();
  const lossFrom = (ball) => {
    ballScene(sim, Object.assign({ x: 800, y: 470, vx: 12, vy: 0 }, ball), null, 'rally');
    const hp = sim.Game.world().p2.hp;
    step(sim, 20);
    return hp - sim.Game.world().p2.hp;
  };
  const loose = lossFrom({ live: false });
  const warm = lossFrom({ live: true, liveBounces: 2, lastHit: 'p1', heat: 2 });
  const hot = lossFrom({ live: true, liveBounces: 2, lastHit: 'p1', heat: 9 });
  const own = lossFrom({ live: true, liveBounces: 2, lastHit: 'p2', heat: 9 });
  assert.strictEqual(loose, 0, 'loose ball is harmless');
  assert.strictEqual(own, 0, 'your own shot passes through you');
  assert.ok(warm > 5 && hot > warm * 2, `hot hits harder (warm ${warm}, hot ${hot})`);
  assert.strictEqual(sim.Game.world().ball.heat, 9, 'own shot keeps its heat');
});

test('rally: a fresh block catches a live ball and the next attack throws it back hotter', () => {
  const sim = createSim();
  ballScene(sim, { x: 760, y: 470, vx: 12, vy: 0, live: true, liveBounces: 2, lastHit: 'p1', heat: 4 }, null, 'rally');
  const hp = sim.Game.world().p2.hp;
  sim.InputManager.setVirtual(sim.VCONTROLS.p2.block, true, false);
  step(sim, 14);
  let b = sim.Game.world().ball;
  assert.strictEqual(b.heldBy, 'p2', 'caught');
  assert.strictEqual(sim.Game.world().p2.hp, hp, 'no damage when caught');
  sim.InputManager.setVirtual(sim.VCONTROLS.p2.block, false, false);
  step(sim, 2);
  punch(sim, 'p2');
  step(sim, 2);
  b = sim.Game.world().ball;
  assert.strictEqual(b.heldBy, null);
  assert.ok(b.live && b.lastHit === 'p2' && b.heat === 5 && b.vx < 0, 'thrown back at p1, one hotter');
});

test('rally: blocking too early only deflects a live ball (with chip damage)', () => {
  const sim = createSim();
  ballScene(sim, { x: 600, y: 490, vx: 8, vy: -2, live: true, liveBounces: 2, lastHit: 'p1', heat: 6 }, null, 'rally');
  const hp = sim.Game.world().p2.hp;
  sim.InputManager.setVirtual(sim.VCONTROLS.p2.block, true, false);
  step(sim, 45); // blocking the whole way: far longer than the catch window
  sim.InputManager.setVirtual(sim.VCONTROLS.p2.block, false, false);
  const b = sim.Game.world().ball;
  const lost = hp - sim.Game.world().p2.hp;
  assert.strictEqual(b.heldBy, null, 'not caught');
  assert.strictEqual(b.live, false, 'deflected: no longer a live shot');
  assert.ok(lost > 0 && lost < 4, `only chip damage (${lost})`);
});

test('rally: punches on each other do half damage', () => {
  const sim = createSim();
  const hit = (mode) => {
    sim.Game.startMatch('ryan', 'carlos', () => {}, { ball: mode });
    step(sim, 181);
    sim.Game.applySnapshot({ f: [{ x: 500 }, { x: 560 }] });
    const hp = sim.Game.world().p2.hp;
    punch(sim, 'p1');
    step(sim, 20);
    return hp - sim.Game.world().p2.hp;
  };
  const full = hit('off'), rally = hit('rally');
  assert.ok(full > 0 && Math.abs(rally - full * 0.5) < 0.01, `rally ${rally} vs ${full}`);
});

test('rally: the ball never leaves the stage, and bouncing on the floor cools it', () => {
  const sim = createSim();
  // Smashed hard toward the edge: it bounces off the edge instead of falling off.
  ballScene(sim, { x: 1000, y: 300, vx: 12, vy: 2, live: true, liveBounces: 2, lastHit: 'p1', heat: 8 }, [{ x: 400 }, { x: 600 }], 'rally');
  let minHeat = 8;
  for (let i = 0; i < 300; i++) {
    step(sim, 1);
    const b = sim.Game.world().ball;
    assert.ok(b.x >= 160 && b.x <= 1120, `left the stage at x ${b.x}`);
    minHeat = Math.min(minHeat, b.heat);
  }
  assert.strictEqual(sim.Game.world().ball.phase, 'live', 'still in play');
  assert.strictEqual(minHeat, 0, 'floor bounces and time cooled it all the way down');
});


// ---- Balance mode ----

// One point-blank punch from Ryan to Carlos at mid-stage, with Carlos at the
// given fraction of his balance. Returns how far it pushed him and whether
// he went off the stage.
function pushAt(sim, frac, opts) {
  sim.Game.startMatch('ryan', 'carlos', () => {}, Object.assign({ ball: 'off' }, opts));
  step(sim, 181);
  const c = sim.Game.world().p2;
  sim.Game.applySnapshot({ f: [{ x: 580 }, { x: 640, hp: c.maxHp * frac }] });
  punch(sim, 'p1');
  let furthest = 0;
  for (let i = 0; i < 150 && sim.Game.getState() === 'fight'; i++) {
    step(sim, 1);
    furthest = Math.max(furthest, sim.Game.world().p2.x - 640);
  }
  return { pushed: furthest, out: sim.Game.getState() !== 'fight' };
}

test('balance mode: the less balance you have, the further hits send you', () => {
  const sim = createSim();
  const [full, three, half, quarter] = [1, 0.75, 0.5, 0.25].map((f) => pushAt(sim, f));
  assert.ok(full.pushed < 80 && !full.out, `a fresh fighter barely moves (${full.pushed})`);
  assert.ok(three.pushed > full.pushed * 2 && half.pushed > three.pushed, 'grows as balance drops');
  assert.ok(!half.out, 'half balance: not yet knocked off from mid-stage');
  assert.ok(quarter.out, 'a quarter left: a punch from mid-stage knocks you off');
});

test('balance mode: no KOs -- an empty bar keeps fighting, only falling off loses', () => {
  const sim = createSim();
  sim.Game.startMatch('ryan', 'carlos', () => {}, { ball: 'off' });
  step(sim, 181);
  sim.Game.applySnapshot({ f: [{ x: 400 }, { x: 800, hp: 0 }] });
  step(sim, 30);
  assert.strictEqual(sim.Game.getState(), 'fight', 'still fighting at zero balance');
  assert.notStrictEqual(sim.Game.world().p2.state, 'ko');
});

test('balance mode: a fighter sent flying gets control back mid-air and can recover', () => {
  const sim = createSim();
  sim.Game.startMatch('ryan', 'carlos', () => {}, { ball: 'off' });
  step(sim, 181);
  sim.Game.applySnapshot({ f: [{ x: 580 }, { x: 640, hp: 20 }] });
  punch(sim, 'p1');
  // Carlos steers back toward the middle and double-jumps as he falls.
  for (let i = 0; i < 200 && sim.Game.getState() === 'fight'; i++) {
    const p = sim.Game.world().p2;
    sim.InputManager.setVirtual(sim.VCONTROLS.p2.left, p.x > 640, false);
    sim.InputManager.setVirtual(sim.VCONTROLS.p2.jump, p.vy > 0, p.vy > 0 && p.state === 'fall');
    step(sim, 1);
  }
  sim.InputManager.setVirtual(sim.VCONTROLS.p2.left, false, false);
  sim.InputManager.setVirtual(sim.VCONTROLS.p2.jump, false, false);
  assert.strictEqual(sim.Game.getState(), 'fight', 'recovered back onto the stage');
});

test('balance mode off: health KOs as usual, and knockback does not grow', () => {
  const sim = createSim();
  const full = pushAt(sim, 1, { balance: false }), low = pushAt(sim, 0.1, { balance: false });
  assert.ok(Math.abs(full.pushed - low.pushed) < 1, `same knockback (${full.pushed} vs ${low.pushed})`);
  sim.Game.startMatch('ryan', 'carlos', () => {}, { ball: 'off', balance: false });
  step(sim, 181);
  sim.Game.applySnapshot({ f: [{}, { hp: 0 }] });
  step(sim, 2);
  assert.strictEqual(sim.Game.getState(), 'roundEnd', 'zero health is a KO');
});

// ---- Artur's crouch-roll, Carlos's Guillotine Slash, Nathan's reach ----

test('Artur rolls when he moves while crouched: faster than anyone\'s crouch-walk, still a crouch; nobody else rolls', () => {
  const sim = createSim();
  const C = sim.VCONTROLS.p1;
  const holdBlockMove = (id, frames) => {
    const { f, foe } = startFighter(sim, id, 400);
    for (const a of ACTIONS) sim.InputManager.setVirtual(C[a], a === 'block' || a === 'right', false);
    const x0 = f.x;
    for (let i = 0; i < frames; i++) f.update(C, foe);
    const r = { f, dist: f.x - x0 };
    for (const a of ACTIONS) sim.InputManager.setVirtual(C[a], false, false);
    return r;
  };
  const artur = holdBlockMove('artur', 30);
  assert.strictEqual(artur.f.rolling, true);
  assert.strictEqual(artur.f.isCrouching, true, 'a roll is still the crouch (same hurtbox and guard)');
  const crouchWalkSpeed = sim.CHARACTERS.artur.moveSpeed * 0.35;
  const rollSpeed = artur.dist / 30;
  assert.ok(rollSpeed > crouchWalkSpeed * 1.4 && rollSpeed < crouchWalkSpeed * 2.2, `roll speed ${rollSpeed.toFixed(2)} vs crouch-walk ${crouchWalkSpeed.toFixed(2)}: should be "a bit faster"`);
  for (const c of sim.CHARACTER_LIST.filter((c) => c.id !== 'artur')) {
    const r = holdBlockMove(c.id, 20);
    assert.strictEqual(r.f.rolling, false, `${c.id} should not roll`);
    assert.ok(Math.abs(r.dist / 20 - c.moveSpeed * 0.35) < 0.05, `${c.id}: crouch-walk speed should be unchanged`);
  }
  // Standing still while crouched, or letting go, is not rolling.
  const { f, foe } = startFighter(sim, 'artur', 400);
  for (const a of ACTIONS) sim.InputManager.setVirtual(C[a], a === 'block', false);
  for (let i = 0; i < 10; i++) f.update(C, foe);
  assert.strictEqual(f.rolling, false);
});

// One basic special thrown at a target standing (or crouch-blocking) right in front.
function specialDamage(sim, attackerId, targetId, block, frames) {
  sim.Game.startMatch(attackerId, targetId, () => {}, { ball: 'off' }); // full damage numbers
  for (let i = 0; i < 200; i++) sim.Game.update(sim.FIXED_STEP);
  sim.Game.applySnapshot({ f: [{ x: 500 }, { x: 570 }] });
  const hp0 = sim.Game.getSnapshot().f[1].hp;
  sim.InputManager.setVirtual(sim.VCONTROLS.p2.block, !!block, false);
  sim.InputManager.setVirtual(sim.VCONTROLS.p1.special, false, true);
  const lost = [];
  for (let i = 0; i < frames; i++) {
    sim.Game.update(sim.FIXED_STEP);
    sim.InputManager.setVirtual(sim.VCONTROLS.p1.special, false, false);
    lost.push(hp0 - sim.Game.getSnapshot().f[1].hp);
  }
  sim.InputManager.setVirtual(sim.VCONTROLS.p2.block, false, false);
  return lost;
}

test('Carlos\'s Guillotine Slash: a long telegraph, then ONE big hit', () => {
  const sim = createSim();
  const sp = sim.CHARACTERS.carlos.special;
  assert.strictEqual(sp.hits.length, 1, 'a single slash');
  assert.ok(sp.hits[0].start >= 22, `wind-up should be long enough to read (${sp.hits[0].start} frames)`);
  assert.ok(sp.damage >= 30, `it should hurt (${sp.damage})`);
  assert.ok(sp.damage > 14 * 2, 'and hit harder than the old two-slash total');

  const lost = specialDamage(sim, 'carlos', 'keenan', false, 60);
  const first = lost.findIndex((v) => v > 0);
  assert.ok(first >= sp.hits[0].start - 3, `no damage during the wind-up (first damage on frame ${first + 1}, wind-up ${sp.hits[0].start})`);
  const total = lost[lost.length - 1];
  assert.ok(Math.abs(total - sp.damage) < 0.01, `exactly one hit of ${sp.damage} (took ${total})`);

  // Blocking still works, and it can't be ducked (a special reaches the floor).
  const blocked = specialDamage(sim, 'carlos', 'john', true, 60);
  assert.ok(Math.abs(blocked[blocked.length - 1] - sp.damage * 0.15) < 0.01, `a block should absorb 85% (took ${blocked[blocked.length - 1]})`);
  const crouchedSmall = specialDamage(sim, 'carlos', 'keenan', true, 60);
  assert.ok(crouchedSmall[crouchedSmall.length - 1] > 0, 'crouching does not duck a special');
});

test('Nathan\'s punch reaches nearly twice as far as a normal jab', () => {
  const sim = createSim();
  const reach = (id) => { const a = sim.CHARACTERS[id].attack; return a.offset + a.width; };
  const others = sim.CHARACTER_LIST.filter((c) => c.id !== 'nathan').map((c) => reach(c.id)).sort((a, b) => a - b);
  const median = others[Math.floor(others.length / 2)];
  assert.ok(reach('nathan') >= median * 1.7, `Nathan reach ${reach('nathan')} vs median ${median}`);
  assert.ok(reach('nathan') > Math.max(...others), 'the longest reach in the roster');
  // It really connects at long range.
  const A = new sim.Fighter('p1', sim.CHARACTERS.nathan, 500, 1);
  A.state = 'attack';
  A.actionTimer = sim.CHARACTERS.nathan.attack.startup + 1;
  const box = A.getHitbox();
  const T = new sim.Fighter('p2', sim.CHARACTERS.keenan, 500 + 190, -1);
  T.grounded = true;
  assert.ok(overlaps(box, T.getHurtbox()), 'a target 190 units away should be in range');
});
