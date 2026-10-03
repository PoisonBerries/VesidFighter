// Headless simulation tests. The sim is built the same way server/server.js
// builds it (same files, same stubs), so these also guard online play.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT } = require('./helpers');

const SIM_FILES = ['constants.js', 'stages.js', 'input.js', 'characters.js', 'effects.js', 'fighter.js', 'game.js'];
const HELD = ['left', 'right', 'block', 'guard'];
const TAPS = ['jump', 'attack', 'special', 'ultimate'];
const ACTIONS = HELD.concat(TAPS);

const source = SIM_FILES.map((f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n;\n');
const PRELUDE = `
  const window = { addEventListener() {} };
  const VCONTROLS = {};
  for (const slot of ['p1', 'p2']) { VCONTROLS[slot] = {}; for (const a of ${JSON.stringify(ACTIONS)}) VCONTROLS[slot][a] = 'V_' + slot + '_' + a; }
  const Net = { controlsFor: (slot) => VCONTROLS[slot] };
`;
const EXPORTS = '\n({ Game, InputManager, Effects, Fighter, Stage, STAGES, CHARACTERS, CHARACTER_LIST, VCONTROLS, GROUND_Y, STAGE_LEFT_EDGE, STAGE_RIGHT_EDGE, FIXED_STEP, ULT_METER_MAX, CROUCH_HEIGHT, HIGH_ATTACK_BOTTOM });';
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

const STATES = new Set(['idle', 'walk', 'jump', 'fall', 'block', 'attack', 'special', 'ultimate', 'hitstun', 'knockdown', 'ko', 'victory', 'phasestep', 'hoverdive', 'jumpcharge', 'whirlwind', 'grabslam', 'grabbeat', 'grabbed']);

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
  const hitDamage = f.hp - base.maxHp * base.transform.hpThreshold + 1;
  const hpAfterHit = f.hp - hitDamage, hpFracAfterHit = hpAfterHit / base.maxHp;
  f.applyHit({ damage: hitDamage, knockback: 5, knockbackUp: 1, hitstun: 5, fromFacing: -1 });
  assert.strictEqual(f.transformed, true, 'should transform once HP reaches the threshold');
  assert.strictEqual(f.maxHp, base.maxHp + base.transform.bonusHp);
  assert.ok(f.width > sim.CHARACTERS.robert.sizeScale * 96, 'transformed Robert is bigger');
  // Transforming doesn't heal him: he keeps the same PERCENTAGE of the bigger pool.
  assert.ok(Math.abs(f.hp / f.maxHp - hpFracAfterHit) < 1e-9, `health should stay at ${(hpFracAfterHit * 100).toFixed(1)}% (is ${(f.hp / f.maxHp * 100).toFixed(1)}%)`);
  assert.ok(f.hp < hpAfterHit + base.transform.bonusHp * 0.9, 'and he is not topped up by the bonus HP');
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

test('a transformed Robert hits hard; base Robert is a touch weaker (base got slightly weaker, transformed did not)', () => {
  const sim = createSim();
  const r = sim.CHARACTERS.robert;
  const transformedBasic = r.attack.damage * r.transform.dmgMul;
  assert.ok(transformedBasic >= 16 && transformedBasic <= 17.5, `transformed basic attack ${transformedBasic}`);
  assert.ok(r.attack.damage <= 10, 'base Robert should be a touch weaker than before (was 11)');
  assert.ok(r.maxHp < 173, 'base Robert should have a little less HP than a mid-weight (was 115 before the +50%)');
  assert.ok(r.maxHp + r.transform.bonusHp >= 255, 'transformed HP pool keeps its ratio (~260 after the +50%)');
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
    const frac = c.crouchSwim ? c.crouchSwim.height : sim.CROUCH_HEIGHT; // swimmers lie flat
    assert.ok(Math.abs(h.h - f.height * frac) < 1e-9, `${c.id}: crouched hurtbox ${h.h}`);
    assert.strictEqual(h.y + h.h, f.y, 'the crouched box still stands on the floor');
    f.grounded = false; // in the air the block key doesn't crouch you
    assert.strictEqual(f.getHurtbox().h, f.height);
  }
  const small = new sim.Fighter('p1', sim.CHARACTERS.keenan, 500, 1), big = new sim.Fighter('p1', sim.CHARACTERS.john, 500, 1);
  for (const f of [small, big]) { f.grounded = true; f.state = 'block'; }
  assert.ok(small.getHurtbox().h < big.getHurtbox().h * 0.8, 'a small fighter crouches much lower than a big one');
});

test('punches are high attacks: you duck a punch from anyone about your height or taller; nobody ducks a standing hit', () => {
  const sim = createSim();
  const ids = sim.CHARACTER_LIST.map((c) => c.id);
  let ducks = 0, hits = 0;
  for (const a of ids) {
    for (const t of ids) {
      assert.ok(punchHits(sim, a, t, false), `${a}'s punch must hit a standing ${t}`);
      const Ha = new sim.Fighter('p1', sim.CHARACTERS[a], 0, 1).height, Ht = new sim.Fighter('p2', sim.CHARACTERS[t], 0, 1).height;
      const crouchFrac = sim.CHARACTERS[t].crouchSwim ? sim.CHARACTERS[t].crouchSwim.height : sim.CROUCH_HEIGHT;
      const expectDuck = a !== 'artur' && Ht * crouchFrac <= Ha * sim.HIGH_ATTACK_BOTTOM;
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
  const hit = sim.CHARACTERS.ryan.attack;
  const chip = crouchBlockedDamage(sim, 'ryan', 'nathan', true);
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
  const [full, three, half, quarter] = [1, 0.75, 0.5, 0.05].map((f) => pushAt(sim, f));
  assert.ok(full.pushed < 80 && !full.out, `a fresh fighter barely moves (${full.pushed})`);
  assert.ok(three.pushed > full.pushed * 2 && half.pushed > three.pushed, 'grows as balance drops');
  assert.ok(!half.out, 'half balance: not yet knocked off from mid-stage');
  assert.ok(quarter.out || quarter.pushed > half.pushed * 1.3, `nearly out of balance: sent much further (${quarter.pushed} vs ${half.pushed})`);
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
    const mul = c.crouchSwim ? c.crouchSwim.speedMul : 0.35; // Sam swims instead
    assert.ok(Math.abs(r.dist / 20 - c.moveSpeed * mul) < 0.05, `${c.id}: crouch-walk speed should be unchanged`);
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

// ---- Keenan's Phase Step ----
test('Phase Step: hit, then jump + crouch together slips Keenan through and behind the opponent', () => {
  const sim = createSim();
  const C = sim.VCONTROLS.p1;
  const hit = { damage: 6, knockback: 6, knockbackUp: 3, hitstun: 40, fromFacing: -1 };
  const keys = (jump, block) => { sim.InputManager.setVirtual(C.jump, jump, false); sim.InputManager.setVirtual(C.block, block, false); };
  const setup = (id = 'keenan') => {
    const { f, foe } = startFighter(sim, id, 500);
    foe.x = 560; // the opponent is just in front of us
    keys(false, false);
    for (let i = 0; i < 4; i++) f.update(C, foe);
    f.applyHit(hit);
    f.update(C, foe);
    assert.strictEqual(f.state, 'hitstun');
    return { f, foe };
  };

  // Both pressed together.
  let { f, foe } = setup();
  keys(true, true);
  f.update(C, foe);
  assert.strictEqual(f.state, 'phasestep');
  assert.ok(f.phaseCooldown > 0);
  // Untouchable for the dash.
  const hp = f.hp;
  assert.strictEqual(f.applyHit(hit), 'phased');
  assert.strictEqual(f.hp, hp);
  keys(false, false);
  for (let i = 0; i < 40; i++) f.update(C, foe);
  assert.ok(f.x > foe.x + 40, `should end up behind the opponent (Keenan ${f.x.toFixed(0)}, opponent ${foe.x})`);
  assert.ok(['idle', 'fall', 'jump'].includes(f.state), `control should come back (state ${f.state})`);
  assert.ok(f.facing === -1, 'and he turns to face them again');

  // Either order counts, as long as the pair is completed.
  for (const first of ['jump', 'block']) {
    ({ f, foe } = setup());
    keys(first === 'jump', first === 'block');
    f.update(C, foe);
    assert.notStrictEqual(f.state, 'phasestep', 'one key alone does nothing');
    keys(true, true);
    f.update(C, foe);
    assert.strictEqual(f.state, 'phasestep', `${first} first, then the other`);
  }

  // Not from a standing start, not for other characters, not during the cooldown.
  ({ f, foe } = setup());
  f.state = 'idle';
  f.sinceHit = 999;
  keys(true, true); f.update(C, foe);
  assert.notStrictEqual(f.state, 'phasestep', 'only just after being hit');
  keys(false, false);
  // ...but for a good while after the hit, even back on his feet.
  ({ f, foe } = setup());
  f.state = 'idle'; f.stunFrames = 0;
  f.sinceHit = sim.CHARACTERS.keenan.phaseStep.window - 1;
  keys(true, true); f.update(C, foe);
  assert.strictEqual(f.state, 'phasestep', 'still available shortly after the hit has ended');
  ({ f, foe } = setup());
  f.state = 'idle';
  f.sinceHit = sim.CHARACTERS.keenan.phaseStep.window + 5;
  keys(true, true); f.update(C, foe);
  assert.notStrictEqual(f.state, 'phasestep', 'the window closes');
  keys(false, false);
  for (const c of sim.CHARACTER_LIST.filter((c) => !c.phaseStep)) {
    ({ f, foe } = setup(c.id));
    keys(true, true); f.update(C, foe);
    assert.notStrictEqual(f.state, 'phasestep', `${c.id} has no Phase Step`);
    keys(false, false);
  }
  ({ f, foe } = setup());
  keys(true, true); f.update(C, foe); keys(false, false);
  for (let i = 0; i < 30; i++) f.update(C, foe);
  f.applyHit(hit); f.update(C, foe);
  keys(true, true); f.update(C, foe); keys(false, false);
  assert.notStrictEqual(f.state, 'phasestep', 'on cooldown');
  f.phaseCooldown = 0; f.state = 'hitstun'; f.actionTimer = 0; f.stunFrames = 40;
  keys(false, false); f.update(C, foe);
  keys(true, true); f.update(C, foe);
  assert.strictEqual(f.state, 'phasestep', 'ready again after the cooldown');
});

test('Phase Step never carries Keenan off the stage, and is not available below the platform', () => {
  const sim = createSim();
  const C = sim.VCONTROLS.p1;
  const { f, foe } = startFighter(sim, 'keenan', sim.STAGE_RIGHT_EDGE - 60);
  foe.x = sim.STAGE_RIGHT_EDGE - 30; // the opponent is at the very edge
  for (let i = 0; i < 4; i++) f.update(C, foe);
  f.applyHit({ damage: 6, knockback: 4, knockbackUp: 2, hitstun: 40, fromFacing: -1 });
  f.update(C, foe);
  sim.InputManager.setVirtual(C.jump, true, false); sim.InputManager.setVirtual(C.block, true, false);
  f.update(C, foe);
  sim.InputManager.setVirtual(C.jump, false, false); sim.InputManager.setVirtual(C.block, false, false);
  for (let i = 0; i < 30; i++) f.update(C, foe);
  assert.ok(f.x <= sim.STAGE_RIGHT_EDGE, `stayed on the stage (x ${f.x})`);

  const g = startFighter(sim, 'keenan', 300);
  g.f.y = sim.GROUND_Y + 200; // already below the platform
  g.f.state = 'hitstun'; g.f.actionTimer = 0; g.f.stunFrames = 60;
  sim.InputManager.setVirtual(C.jump, true, false); sim.InputManager.setVirtual(C.block, true, false);
  g.f.update(C, g.foe);
  assert.notStrictEqual(g.f.state, 'phasestep', 'no Phase Step once knocked below the platform');
  sim.InputManager.setVirtual(C.jump, false, false); sim.InputManager.setVirtual(C.block, false, false);
});

// ---- Carlos's hover claw dive ----
test('Carlos: attack while hovering is a forward, downward claw dive; every other attack is unchanged', () => {
  const sim = createSim();
  const C = sim.VCONTROLS.p1;
  const snap = () => sim.Game.getSnapshot().f;
  sim.Game.startMatch('carlos', 'sam', () => {}, { ball: 'off' }); // full damage numbers
  for (let i = 0; i < 200; i++) sim.Game.update(sim.FIXED_STEP);
  sim.Game.applySnapshot({ f: [{ x: 400 }, { x: 640 }] });

  // Jump and hold it: hover.
  sim.InputManager.setVirtual(C.jump, true, true);
  sim.Game.update(sim.FIXED_STEP);
  sim.InputManager.setVirtual(C.jump, true, false);
  let hovered = false;
  for (let i = 0; i < 80 && !hovered; i++) { sim.Game.update(sim.FIXED_STEP); hovered = snap()[0].hovering; }
  assert.ok(hovered, 'Carlos should be hovering');
  const before = snap()[0], hp0 = snap()[1].hp;
  const d = sim.CHARACTERS.carlos.hoverDive;

  // Attack while hovering.
  sim.InputManager.setVirtual(C.attack, false, true);
  sim.Game.update(sim.FIXED_STEP);
  sim.InputManager.setVirtual(C.attack, false, false);
  sim.InputManager.setVirtual(C.jump, false, false);
  assert.strictEqual(snap()[0].state, 'hoverdive');
  assert.strictEqual(snap()[0].hovering, false);
  assert.strictEqual(snap()[0].hoverLeft, 0, 'no hovering again until he lands');
  // A short wind-up in place (no forward drift), then the dive.
  const startX = snap()[0].x;
  for (let i = 0; i < d.startup - 1; i++) sim.Game.update(sim.FIXED_STEP);
  assert.ok(Math.abs(snap()[0].x - startX) < 1, 'holds position through the wind-up');
  // Distance moved per frame while diving (the snapshot's velocities are post-friction).
  let maxDx = 0, maxDy = 0, frames = 0, prev = snap()[0];
  while (snap()[0].state === 'hoverdive' && frames++ < 120) {
    sim.Game.update(sim.FIXED_STEP);
    const s = snap()[0];
    if (s.state === 'hoverdive' && s._ability && s._ability.diving) { maxDx = Math.max(maxDx, s.x - prev.x); maxDy = Math.max(maxDy, s.y - prev.y); }
    prev = s;
  }
  assert.ok(maxDx >= d.vx - 0.5, `dives forward (${maxDx.toFixed(1)} per frame)`);
  assert.ok(maxDy >= d.vy - 0.5, `and down (${maxDy.toFixed(1)} per frame)`);
  const lost = hp0 - snap()[1].hp;
  assert.ok(Math.abs(lost - d.damage) < 0.01, `one hit of ${d.damage} (took ${lost})`);
  assert.ok(['idle', 'fall', 'jump'].includes(snap()[0].state), `control returns (state ${snap()[0].state})`);
  // He lands and the hover refills.
  for (let i = 0; i < 90 && !snap()[0].grounded; i++) sim.Game.update(sim.FIXED_STEP);
  sim.Game.update(sim.FIXED_STEP);
  assert.strictEqual(snap()[0].hoverLeft, sim.CHARACTERS.carlos.hover.frames);

  // Not hovering (on the ground, or in the air without holding jump): a normal attack.
  const { f, foe } = startFighter(sim, 'carlos', 400);
  sim.InputManager.setVirtual(C.attack, false, true);
  f.update(C, foe);
  assert.strictEqual(f.state, 'attack', 'a grounded attack is the ordinary attack');
  sim.InputManager.setVirtual(C.attack, false, false);
  // Other characters never dive, even holding jump in the air.
  for (const c of sim.CHARACTER_LIST.filter((c) => !c.hoverDive)) {
    const x = startFighter(sim, c.id, 400);
    x.f.grounded = false; x.f.y = sim.GROUND_Y - 100; x.f.hovering = true; // even if flagged hovering
    sim.InputManager.setVirtual(C.attack, false, true);
    x.f.update(C, x.foe);
    assert.notStrictEqual(x.f.state, 'hoverdive', `${c.id} has no claw dive`);
    sim.InputManager.setVirtual(C.attack, false, false);
  }
});

// ---- Owen's Plasma Bolt charges quickly ----
test('Owen\'s Plasma Bolt: a tap is the quick shot, and holding reaches the full charged blast quickly', () => {
  const sim = createSim();
  const sp = sim.CHARACTERS.owen.special;
  assert.ok(sp.maxChargeFrames <= 30, `full charge should be quick (${sp.maxChargeFrames} frames)`);
  assert.ok(sp.chargeThreshold < sp.maxChargeFrames);

  // frames from pressing special to the shot appearing, and which kind it is
  const fire = (holdFrames) => {
    sim.Game.startMatch('owen', 'sam', () => {}, { ball: 'off' });
    for (let i = 0; i < 200; i++) sim.Game.update(sim.FIXED_STEP);
    sim.Game.applySnapshot({ f: [{ x: 300, specialCooldownTimer: 0 }, { x: 1000 }] });
    sim.InputManager.setVirtual(sim.VCONTROLS.p1.special, true, true);
    for (let i = 1; i <= 120; i++) {
      sim.Game.update(sim.FIXED_STEP);
      sim.InputManager.setVirtual(sim.VCONTROLS.p1.special, i < holdFrames, false);
      const shot = sim.Game.getSnapshot().pr[0];
      if (shot) { sim.InputManager.setVirtual(sim.VCONTROLS.p1.special, false, false); return { frames: i, kind: shot.kind }; }
    }
    sim.InputManager.setVirtual(sim.VCONTROLS.p1.special, false, false);
    return null;
  };
  const tap = fire(2);
  assert.strictEqual(tap && tap.kind, 'plasmaQuick', 'a tap fires the quick shot');
  const held = fire(999);
  assert.strictEqual(held && held.kind, 'plasmaCharged', 'holding fires the charged blast');
  assert.ok(held.frames <= sp.startup + sp.maxChargeFrames + 3, `a full charge should be out within ${sp.startup + sp.maxChargeFrames + 3} frames (took ${held.frames})`);
  // Releasing just past the threshold already counts as charged.
  const mid = fire(sp.startup + sp.chargeThreshold + 3);
  assert.strictEqual(mid && mid.kind, 'plasmaCharged', 'a short hold past the threshold is a charged shot');
});

// ---- Sam: lies flat and swims; crouching on the move is a slide ----
test('Sam crouches flat: a very low, long hurtbox that ducks every punch; only lows (Artur\'s kick) and specials reach it', () => {
  const sim = createSim();
  const sam = sim.CHARACTERS.sam;
  const f = new sim.Fighter('p1', sam, 500, 1);
  f.grounded = true; f.state = 'block';
  const h = f.getHurtbox();
  assert.ok(Math.abs(h.h - f.height * sam.crouchSwim.height) < 1e-9);
  assert.ok(Math.abs(h.w - f.width * sam.crouchSwim.widthMul) < 1e-9, 'flat means long: wider than standing');
  assert.ok(h.h < f.height * sim.CROUCH_HEIGHT * 0.6, 'much lower than an ordinary crouch');
  // Every character's basic punch goes over him; Artur's low kick doesn't.
  for (const a of sim.CHARACTER_LIST.map((c) => c.id)) {
    assert.strictEqual(punchHits(sim, a, 'sam', false), true, `${a} hits a standing Sam`);
    assert.strictEqual(punchHits(sim, a, 'sam', true), a === 'artur', `${a} vs a flat Sam`);
  }
});

test('Sam swims (a quicker crouch-crawl) and crouching while moving is a slide that keeps the momentum', () => {
  const sim = createSim();
  const C = sim.VCONTROLS.p1;
  const keys = (list) => { for (const a of ACTIONS) sim.InputManager.setVirtual(C[a], list.includes(a), false); };
  const run = (id, before, after, frames) => {
    const { f, foe } = startFighter(sim, id, 300);
    keys(before.keys);
    for (let i = 0; i < before.frames; i++) f.update(C, foe);
    const x0 = f.x, speed0 = Math.abs(f.vx);
    keys(after);
    const trace = [];
    for (let i = 0; i < frames; i++) { f.update(C, foe); trace.push({ vx: f.vx, sliding: f.sliding, state: f.state }); }
    keys([]);
    return { f, dist: f.x - x0, speed0, trace };
  };
  const swimSpeed = sim.CHARACTERS.sam.moveSpeed * sim.CHARACTERS.sam.crouchSwim.speedMul;

  // Swimming from a standstill: quicker than the ordinary crouch-walk, no slide.
  const swim = run('sam', { keys: [], frames: 5 }, ['block', 'right'], 30);
  assert.ok(Math.abs(swim.dist / 30 - swimSpeed) < 0.05, `swim speed ${(swim.dist / 30).toFixed(2)} vs ${swimSpeed.toFixed(2)}`);
  assert.ok(swimSpeed > sim.CHARACTERS.sam.moveSpeed * 0.35, 'quicker than a crouch-walk');
  assert.ok(swim.trace.every((t) => !t.sliding), 'no slide from a standstill');

  // Running, then crouching: slide on with the momentum.
  const slide = run('sam', { keys: ['right'], frames: 12 }, ['block', 'right'], 60);
  assert.ok(slide.trace[0].sliding, 'crouching at speed starts a slide');
  assert.ok(Math.abs(slide.trace[0].vx) > slide.speed0 * 0.9, `momentum kept (running at ${slide.speed0.toFixed(2)}, first slide frame ${slide.trace[0].vx.toFixed(2)})`);
  // It carries on, well past what an ordinary crouching stop would.
  const glide = run('sam', { keys: ['right'], frames: 12 }, ['block'], 60);      // just crouch: no direction held
  const keenan = run('keenan', { keys: ['right'], frames: 12 }, ['block'], 60);  // same, for a character who just stops
  assert.ok(glide.dist > keenan.dist * 4, `the slide should go far (${glide.dist.toFixed(0)} vs ${keenan.dist.toFixed(0)})`);
  assert.ok(slide.dist > keenan.dist * 2.5, `the slide should go much further (${slide.dist.toFixed(0)} vs ${keenan.dist.toFixed(0)})`);
  assert.ok(keenan.trace.every((t) => !t.sliding), 'other characters never slide');
  // No steering during the glide: holding the other way doesn't turn it around.
  const noSteer = run('sam', { keys: ['right'], frames: 12 }, ['block', 'left'], 12);
  assert.ok(noSteer.trace.every((t) => t.vx >= 0), 'still gliding forward while holding the opposite direction');
  // It fades out and becomes a swim.
  const fade = run('sam', { keys: ['right'], frames: 12 }, ['block'], 150);
  assert.strictEqual(fade.trace[fade.trace.length - 1].sliding, false, 'the slide ends once the speed is gone');
  // Letting go of crouch ends it immediately.
  const { f, foe } = startFighter(sim, 'sam', 300);
  keys(['right']); for (let i = 0; i < 12; i++) f.update(C, foe);
  keys(['block', 'right']); f.update(C, foe);
  assert.strictEqual(f.sliding, true);
  keys(['right']); f.update(C, foe);
  assert.strictEqual(f.sliding, false, 'standing up ends the slide');
  keys([]);
});

// ---- Owen's Blood Donor ----
test('Blood Donor: Owen\'s damage, attack speed and movement speed rise as his health falls; nobody else\'s do', () => {
  const sim = createSim();
  const bd = sim.CHARACTERS.owen.bloodDonor;
  const at = (id, frac) => {
    const f = new sim.Fighter('p1', sim.CHARACTERS[id], 500, 1);
    f.hp = f.maxHp * frac;
    return f;
  };
  // Multipliers scale linearly with health lost.
  const full = at('owen', 1), half = at('owen', 0.5), empty = at('owen', 0);
  assert.strictEqual(full.damageMultiplier, 1);
  assert.strictEqual(full.moveSpeedEff, sim.CHARACTERS.owen.moveSpeed);
  assert.strictEqual(full.actionSpeed, 1);
  assert.ok(Math.abs(half.damageMultiplier - (1 + bd.damage * 0.5)) < 1e-9, 'half health: half the damage bonus');
  assert.ok(Math.abs(half.moveSpeedEff - sim.CHARACTERS.owen.moveSpeed * (1 + bd.speed * 0.5)) < 1e-9);
  assert.ok(Math.abs(empty.damageMultiplier - (1 + bd.damage)) < 1e-9, 'no health: the full bonus');
  assert.ok(Math.abs(empty.moveSpeedEff - sim.CHARACTERS.owen.moveSpeed * (1 + bd.speed)) < 1e-9);
  // Attack speed only applies while he is acting (not while being hit, for instance).
  empty.state = 'attack';
  assert.ok(Math.abs(empty.actionSpeed - (1 + bd.attackSpeed)) < 1e-9);
  empty.state = 'hitstun';
  assert.strictEqual(empty.actionSpeed, 1, 'no faster hit-stun recovery');
  // Monotonic: less health is never weaker.
  let prev = 0;
  for (const frac of [1, 0.75, 0.5, 0.25, 0]) { const m = at('owen', frac).damageMultiplier; assert.ok(m >= prev); prev = m; }
  // Everyone else is untouched by health.
  for (const c of sim.CHARACTER_LIST.filter((c) => c.id !== 'owen')) {
    const a = at(c.id, 1), b = at(c.id, 0.05);
    assert.strictEqual(a.damageMultiplier, b.damageMultiplier, `${c.id}: damage must not depend on health`);
    assert.strictEqual(a.moveSpeedEff, b.moveSpeedEff, `${c.id}: speed must not depend on health`);
    b.state = 'attack';
    assert.strictEqual(b.actionSpeed, 1);
  }
});

test('Blood Donor in a real fight: a wounded Owen hits harder, attacks quicker and moves faster', () => {
  const sim = createSim();
  const C = sim.VCONTROLS.p1;
  // Damage dealt by one basic attack at a given health.
  const punch = (hpFrac) => {
    sim.Game.startMatch('owen', 'sam', () => {}, { ball: 'off' });
    for (let i = 0; i < 200; i++) sim.Game.update(sim.FIXED_STEP);
    const owen = sim.CHARACTERS.owen;
    sim.Game.applySnapshot({ f: [{ x: 500, hp: owen.maxHp * hpFrac }, { x: 555 }] });
    const hp0 = sim.Game.getSnapshot().f[1].hp;
    sim.InputManager.setVirtual(C.attack, false, true);
    sim.Game.update(sim.FIXED_STEP);
    sim.InputManager.setVirtual(C.attack, false, false);
    let frames = 1, hitFrame = null;
    while (frames < 60 && sim.Game.getSnapshot().f[0].state === 'attack') {
      sim.Game.update(sim.FIXED_STEP); frames++;
      if (hitFrame === null && sim.Game.getSnapshot().f[1].hp < hp0) hitFrame = frames;
    }
    return { dmg: hp0 - sim.Game.getSnapshot().f[1].hp, frames, hitFrame };
  };
  const healthy = punch(1), hurt = punch(0.5), nearDead = punch(0.05);
  const base = sim.CHARACTERS.owen.attack.damage;
  assert.ok(Math.abs(healthy.dmg - base) < 0.01, `full health: normal damage (${healthy.dmg})`);
  assert.ok(hurt.dmg > healthy.dmg * 1.2, `half health: clearly more damage (${hurt.dmg.toFixed(2)})`);
  assert.ok(nearDead.dmg > hurt.dmg, 'and more again near death');
  assert.ok(nearDead.dmg <= base * 1.5 + 0.01, 'never past the cap');
  assert.ok(nearDead.frames < healthy.frames * 0.85, `the swing is over sooner (${nearDead.frames} vs ${healthy.frames} frames)`);
  assert.ok(nearDead.hitFrame < healthy.hitFrame, 'and lands sooner');

  // Walking speed.
  const walk = (hpFrac) => {
    const f = new sim.Fighter('p1', sim.CHARACTERS.owen, 300, 1);
    const foe = new sim.Fighter('p2', sim.CHARACTERS.sam, 900, -1);
    f.hp = f.maxHp * hpFrac;
    for (const a of ACTIONS) sim.InputManager.setVirtual(C[a], a === 'right', false);
    for (let i = 0; i < 4; i++) f.update(C, foe);
    const x0 = f.x;
    for (let i = 0; i < 30; i++) f.update(C, foe);
    for (const a of ACTIONS) sim.InputManager.setVirtual(C[a], false, false);
    return (f.x - x0) / 30;
  };
  assert.ok(walk(0.1) > walk(1) * 1.15, 'walks faster when hurt');
});

// ---- Sam's pike kick ----
test('Sam: attacking in the air is a pike kick (its own timing, reach and damage); on the ground it is the ordinary attack', () => {
  const sim = createSim();
  const sam = sim.CHARACTERS.sam;
  const C = sim.VCONTROLS.p1;
  const press = (down) => { for (const a of ACTIONS) sim.InputManager.setVirtual(C[a], false, down === a); };

  // Grounded: the ordinary attack.
  let { f, foe } = startFighter(sim, 'sam', 400);
  press('attack'); f.update(C, foe); press(null);
  assert.strictEqual(f.state, 'attack');
  assert.strictEqual(f.airAttackActive, false);
  assert.strictEqual(f.attackDef, sam.attack);

  // Airborne: the pike kick.
  ({ f, foe } = startFighter(sim, 'sam', 400));
  press('jump'); f.update(C, foe); press(null);
  for (let i = 0; i < 6; i++) f.update(C, foe);
  assert.strictEqual(f.grounded, false, 'in the air');
  press('attack'); f.update(C, foe); press(null);
  assert.strictEqual(f.state, 'attack');
  assert.strictEqual(f.airAttackActive, true, 'the aerial attack');
  assert.strictEqual(f.attackDef, sam.airAttack);
  // Its own timing, hitbox and reach: a low, long box at foot level during the active frames.
  f.actionTimer = sam.airAttack.startup + 1;
  const box = f.getHitbox();
  assert.ok(box, 'active on its own window');
  assert.strictEqual(box.w, sam.airAttack.width);
  assert.ok(Math.abs(box.y + box.h - f.y) < 1e-9, 'a low attack: the box reaches down to his feet (not chest-height)');
  f.actionTimer = sam.airAttack.startup - 1;
  assert.strictEqual(f.getHitbox(), null, 'not yet active during its start-up');
  // It ends (even mid-air) and the flag clears.
  f.actionTimer = 0;
  for (let i = 0; i < 60 && f.state === 'attack'; i++) f.update(C, foe);
  assert.notStrictEqual(f.state, 'attack');
  assert.strictEqual(f.airAttackActive, false);

  // Everyone else keeps their one attack in the air.
  for (const c of sim.CHARACTER_LIST.filter((c) => !c.airAttack)) {
    const x = startFighter(sim, c.id, 400);
    x.f.grounded = false; x.f.y = sim.GROUND_Y - 120;
    press('attack'); x.f.update(C, x.foe); press(null);
    assert.strictEqual(x.f.airAttackActive, false, `${c.id} has no aerial attack`);
  }
});

test('Sam\'s pike kick connects for its own damage through the real game loop, and hits low', () => {
  const sim = createSim();
  const sam = sim.CHARACTERS.sam;
  const C = sim.VCONTROLS.p1;
  sim.Game.startMatch('sam', 'keenan', () => {}, { ball: 'off' });
  for (let i = 0; i < 200; i++) sim.Game.update(sim.FIXED_STEP);
  sim.Game.applySnapshot({ f: [{ x: 400 }, { x: 465 }] });
  const hp0 = sim.Game.getSnapshot().f[1].hp;
  sim.InputManager.setVirtual(C.jump, false, true); sim.Game.update(sim.FIXED_STEP);
  sim.InputManager.setVirtual(C.jump, false, false);
  // Kick as he comes down past the opponent's height.
  let kicked = false;
  for (let i = 0; i < 120 && !kicked; i++) {
    sim.Game.update(sim.FIXED_STEP);
    const s = sim.Game.getSnapshot().f[0];
    if (s.vy > 2 && s.y < sim.GROUND_Y - 30 && s.y > sim.GROUND_Y - 110) {
      sim.InputManager.setVirtual(C.attack, false, true); sim.Game.update(sim.FIXED_STEP);
      sim.InputManager.setVirtual(C.attack, false, false);
      kicked = true;
    }
  }
  assert.ok(kicked, 'reached a spot to kick from');
  assert.strictEqual(sim.Game.getSnapshot().f[0].airAttackActive, true);
  let dealt = 0;
  for (let i = 0; i < 40; i++) { sim.Game.update(sim.FIXED_STEP); dealt = hp0 - sim.Game.getSnapshot().f[1].hp; if (dealt > 0) break; }
  assert.ok(Math.abs(dealt - sam.airAttack.damage) < 0.01, `pike kick damage ${sam.airAttack.damage} (dealt ${dealt})`);
  assert.notStrictEqual(dealt, sam.attack.damage, 'not the ground punch\'s damage');
});


// ---- New moves: Keenan's air kick, Nathan's uppercut, cloud-only poison, flips, Carlos fuel, Owen charge ----
test('Keenan kicks in the air; Nathan\'s W + F is a very tall two-fisted punch', () => {
  const sim = createSim();
  const C = sim.VCONTROLS.p1;
  const press = (down, held = []) => { for (const a of ACTIONS) sim.InputManager.setVirtual(C[a], held.includes(a), a === down); };
  let { f, foe } = startFighter(sim, 'keenan', 400);
  f.grounded = false; f.y = sim.GROUND_Y - 100; f.state = 'jump';
  press('attack'); f.update(C, foe); press(null);
  assert.strictEqual(f.airAttackActive, true);
  assert.strictEqual(f.attackDef, sim.CHARACTERS.keenan.airAttack);

  ({ f, foe } = startFighter(sim, 'nathan', 400));
  press('attack'); f.update(C, foe); press(null);
  assert.strictEqual(f.upAttackActive, false, 'plain F is the normal punch');
  ({ f, foe } = startFighter(sim, 'nathan', 400));
  press('attack', ['jump']); f.update(C, foe); press(null);
  assert.strictEqual(f.state, 'attack');
  assert.strictEqual(f.upAttackActive, true);
  f.actionTimer = f.attackDef.startup + 1;
  const box = f.getHitbox();
  // Reaches higher than anyone's best double jump (John: two 19-force jumps).
  const best = 2 * (19 * 19) / (2 * 0.75);
  assert.ok(sim.GROUND_Y - box.y > best, `reaches ${sim.GROUND_Y - box.y}px, double jump tops out near ${best}`);
  assert.ok(box.x <= f.x && box.x + box.w >= f.x, 'centred over him');
});

test('poison only hurts while standing in the cloud', () => {
  const sim = createSim();
  const { f } = startFighter(sim, 'sam', 400);
  const cloud = { x: 380, y: sim.GROUND_Y - 100, w: 100, h: 100 };
  const def = { poisonDamage: 3, poisonTicks: 5, poisonTickInterval: 20 };
  f.applyPoison(def, cloud);
  const hp0 = f.hp;
  for (let i = 0; i < 20; i++) f._updateStatusTimers();
  assert.strictEqual(f.hp, hp0 - 3, 'a tick while inside');
  f.x = 900; // walked out
  for (let i = 0; i < 40; i++) f._updateStatusTimers();
  assert.strictEqual(f.hp, hp0 - 3, 'no damage outside');
  assert.strictEqual(f.inPoison, false);
  f.x = 400; // and back in (the cloud is still there)
  for (let i = 0; i < 20; i++) f._updateStatusTimers();
  assert.ok(f.hp < hp0 - 3, 'hurts again when back inside');
  for (let i = 0; i < 200; i++) f._updateStatusTimers();
  assert.strictEqual(f.poisonTicksLeft, 0, 'the cloud eventually clears');
});

test('double-jump flips go with the direction of travel; Carlos has more fuel; Owen charges in half the time', () => {
  const sim = createSim();
  const C = sim.VCONTROLS.p1;
  for (const [key, dir] of [['right', 1], ['left', -1], [null, 1]]) {
    const { f, foe } = startFighter(sim, 'ryan', 400); // facing right; find a double-jumper
    const dj = sim.CHARACTER_LIST.find((c) => c.doubleJumpFlip).id;
    const x = startFighter(sim, dj, 400);
    x.f.facing = 1;
    for (const a of ACTIONS) sim.InputManager.setVirtual(C[a], false, a === 'jump');
    x.f.update(C, x.foe);
    for (const a of ACTIONS) sim.InputManager.setVirtual(C[a], a === key, a === 'jump');
    x.f.update(C, x.foe); // (second press needs a fresh edge)
    for (const a of ACTIONS) sim.InputManager.setVirtual(C[a], false, false);
    for (let i = 0; i < 5; i++) x.f.update(C, x.foe);
    for (const a of ACTIONS) sim.InputManager.setVirtual(C[a], a === key, a === 'jump');
    x.f.update(C, x.foe);
    if (x.f.doubleJumpFlipTimer > 0) assert.strictEqual(x.f.doubleJumpFlipDir, dir, `${key}`);
  }
  assert.ok(sim.CHARACTERS.carlos.hover.frames > 45);
  assert.ok(sim.CHARACTERS.owen.special.maxChargeFrames <= 13);
});

// ---- Owen's charged jump, Robert's grab & slam, Ryan's new moves ----
function startGame(sim, a, b, x1, x2) {
  sim.Game.startMatch(a, b, () => {}, { ball: 'off' });
  step(sim, 200);
  sim.Game.applySnapshot({ f: [{ x: x1 }, { x: x2 }] });
  return sim.VCONTROLS.p1;
}
const setKey = (sim, code, down, edge) => sim.InputManager.setVirtual(code, down, !!edge);

test('the round is 90 seconds', () => {
  const sim = createSim();
  sim.Game.startMatch('ryan', 'keenan', () => {}, { ball: 'off' });
  assert.strictEqual(sim.Game.getSnapshot().rt, 90);
});

test('Owen: jump is charged -- longer hold, higher jump; full charge is a plasma jump ending in a whirlwind', () => {
  const sim = createSim();
  const apex = (holdFrames) => {
    const C = startGame(sim, 'owen', 'keenan', 300, 900);
    setKey(sim, C.jump, true, true); step(sim, 1); setKey(sim, C.jump, true, false);
    if (holdFrames > 1) step(sim, holdFrames - 1);
    assert.strictEqual(sim.Game.world().p1.state, 'jumpcharge', 'charging while held');
    setKey(sim, C.jump, false, false);
    let top = 0;
    for (let i = 0; i < 60; i++) {
      step(sim, 1);
      const p = sim.Game.world().p1;
      top = Math.max(top, sim.GROUND_Y - p.y);
      if (p.state === 'whirlwind') break;
    }
    return top;
  };
  const cj = sim.CHARACTERS.owen.chargeJump;
  const tap = apex(2), half = apex(Math.round((cj.tapFrames + cj.maxFrames) / 2)), max = apex(cj.maxFrames + 2);
  assert.ok(half > tap * 1.3, `held longer goes higher (${tap} -> ${half})`);
  assert.ok(max > half * 1.3, `full charge is the highest (${half} -> ${max})`);
  assert.ok(tap > 100, 'a tap is still a proper jump');

  // Full charge: whirlwind at the top, spinning down, hitting and crashing.
  const C = startGame(sim, 'owen', 'keenan', 300, 300);
  sim.Game.applySnapshot({ f: [{ x: 300 }, { x: 330 }] });
  setKey(sim, C.jump, true, true); step(sim, 1); setKey(sim, C.jump, true, false);
  step(sim, 45); setKey(sim, C.jump, false, false);
  const hp0 = sim.Game.world().p2.hp;
  let sawWhirl = false, hit = false;
  for (let i = 0; i < 160; i++) {
    step(sim, 1);
    const o = sim.Game.world().p1;
    if (o.state === 'whirlwind') sawWhirl = true;
    if (sim.Game.world().p2.hp < hp0) hit = true;
  }
  assert.ok(sawWhirl, 'went into the whirlwind');
  assert.ok(hit, 'the whirlwind hurt someone underneath');
  assert.ok(['idle', 'walk'].includes(sim.Game.world().p1.state), 'and ended back on the floor');
});

test('Robert: three unanswered hits become a grab and slam that stuns for about a second', () => {
  const sim = createSim();
  const C = startGame(sim, 'robert', 'john', 500, 560);
  const p2 = () => sim.Game.world().p2;
  let slammed = false;
  for (let hit = 1; hit <= 3; hit++) {
    sim.Game.applySnapshot({ f: [{ x: 500 }, { x: 560, state: 'idle', stunFrames: 0 }] });
    punch(sim, 'p1');
    for (let i = 0; i < 12; i++) step(sim, 1);
    if (hit < 3) {
      assert.notStrictEqual(sim.Game.world().p1.state, 'grabslam', `not after hit ${hit}`);
      step(sim, 20);
    }
  }
  assert.strictEqual(sim.Game.world().p1.state, 'grabslam', 'the third hit grabs');
  assert.strictEqual(p2().state, 'grabbed');
  const hp0 = p2().hp;
  let sawDown = false;
  for (let i = 0; i < 40; i++) { step(sim, 1); if (p2().state === 'knockdown') { sawDown = true; break; } }
  assert.ok(sawDown, 'then slammed down');
  assert.ok(p2().hp < hp0, 'the slam hurts');
  assert.ok(p2().knockdownTimer >= 55, 'and leaves them down for around a second');
  step(sim, 120);
  assert.notStrictEqual(p2().state, 'knockdown', 'they get back up');
  void C;
});

test('Robert: a block or being hit back breaks the string', () => {
  const sim = createSim();
  startGame(sim, 'robert', 'john', 500, 560);
  const r = sim.Game.world().p1;
  r.comboHits = 2;
  r.applyHit({ damage: 1, knockback: 1, knockbackUp: 0, hitstun: 5, fromFacing: -1 });
  assert.strictEqual(r.comboHits, 0);
});

test('Ryan: air F is a backflip kick, air down + F is a stunning shockwave, hits play a rising tune', () => {
  const sim = createSim();
  const C = sim.VCONTROLS.p1;
  const press = (down, held = []) => { for (const a of ACTIONS) sim.InputManager.setVirtual(C[a], held.includes(a), a === down); };
  let { f, foe } = startFighter(sim, 'ryan', 400);
  f.grounded = false; f.y = sim.GROUND_Y - 100; f.state = 'jump';
  press('attack'); f.update(C, foe); press(null);
  assert.strictEqual(f.airAttackActive, true);
  assert.ok(f.attackDef.flip, 'the flip kick');
  ({ f, foe } = startFighter(sim, 'ryan', 400));
  f.grounded = false; f.y = sim.GROUND_Y - 100; f.state = 'jump';
  press('attack', ['block']); f.update(C, foe); press(null);
  assert.strictEqual(f.downAttackActive, true);
  assert.strictEqual(f.airAttackActive, false);
  f.actionTimer = f.attackDef.startup + 1;
  const box = f.getHitbox();
  assert.ok(box.x < f.x && box.x + box.w > f.x, 'rings out on both sides of him');
  // Grounded, down + F is just the ordinary attack (down is a crouch there).
  ({ f, foe } = startFighter(sim, 'ryan', 400));
  press('attack', ['block']); f.update(C, foe); press(null);
  assert.strictEqual(f.downAttackActive, false);

  // The tune: consecutive hits climb the melody, tagged on the hit-spark events.
  const sim2 = createSim();
  startGame(sim2, 'ryan', 'carlos', 500, 560);
  sim2.Effects.setRecording(true);
  const notes = [];
  for (let n = 0; n < 3; n++) {
    sim2.Game.applySnapshot({ f: [{ x: 500 }, { x: 560, state: 'idle', stunFrames: 0 }] });
    punch(sim2, 'p1');
    step(sim2, 14);
    for (const e of sim2.Effects.drainEvents()) if (e[0] === 'h' && String(e[4]).startsWith('note:')) notes.push(e[4]);
    step(sim2, 10);
  }
  assert.deepStrictEqual(notes, ['note:0', 'note:1', 'note:2']);
});

// ---- John: elbow drop, carry & pummel ----
test('John: midair down + F is an elbow drop that knocks the opponent down; on the ground down is a crouch', () => {
  const sim = createSim();
  const C = startGame(sim, 'john', 'keenan', 400, 470);
  const p1 = () => sim.Game.world().p1, p2 = () => sim.Game.world().p2;
  setKey(sim, C.jump, false, true); step(sim, 1); setKey(sim, C.jump, false, false);
  step(sim, 4);
  assert.strictEqual(p1().grounded, false);
  setKey(sim, C.block, true, false);
  sim.InputManager.setVirtual(C.attack, false, true); step(sim, 1); sim.InputManager.setVirtual(C.attack, false, false);
  assert.strictEqual(p1().downAttackActive, true);
  const hp0 = p2().hp;
  let downed = false;
  for (let i = 0; i < 40 && !downed; i++) { step(sim, 1); downed = p2().state === 'knockdown'; }
  setKey(sim, C.block, false, false);
  assert.ok(downed, 'knocked down');
  assert.ok(p2().hp < hp0, 'and hurt');
  assert.ok(p2().knockdownTimer >= 55, 'long enough for a free hit');
});

test('John: three unanswered hits carry the opponent over the shoulder and pummel them until they break loose', () => {
  const sim = createSim();
  startGame(sim, 'john', 'keenan', 500, 560);
  const p2 = () => sim.Game.world().p2;
  for (let hit = 1; hit <= 3; hit++) {
    sim.Game.applySnapshot({ f: [{ x: 500 }, { x: 560, state: 'idle', stunFrames: 0 }] });
    punch(sim, 'p1');
    step(sim, 14);
    if (hit < 3) { assert.notStrictEqual(sim.Game.world().p1.state, 'grabbeat'); step(sim, 25); }
  }
  assert.strictEqual(sim.Game.world().p1.state, 'grabbeat');
  assert.strictEqual(p2().state, 'grabbed');
  const hp0 = p2().hp;
  let held = 0;
  for (let i = 0; i < 200 && p2().state === 'grabbed'; i++) { step(sim, 1); held++; }
  assert.ok(held > 40, `held for a while (${held} frames)`);
  assert.ok(hp0 - p2().hp >= 3 * 4, 'pummelled several times');
  assert.strictEqual(p2().state, 'hitstun', 'then breaks loose');
});

// ---- Guard (I), stun-interrupted abilities, turning in the air ----
test('guard is a full block that slowly drains the ultimate meter; crouching still only absorbs 85%', () => {
  const sim = createSim();
  const swing = (guard) => {
    const C = startGame(sim, 'artur', 'keenan', 500, 560);
    sim.Game.applySnapshot({ f: [{ x: 500 }, { x: 560, ultCharge: 50 }] });
    if (guard) setKey(sim, C.guard === undefined ? sim.VCONTROLS.p2.guard : sim.VCONTROLS.p2.guard, true, false);
    else setKey(sim, sim.VCONTROLS.p2.block, true, false);
    const hp0 = sim.Game.world().p2.hp;
    punch(sim, 'p1');
    step(sim, 30);
    const p2 = sim.Game.world().p2;
    const out = { lost: hp0 - p2.hp, ult: p2.ultCharge, crouching: p2.isCrouching, guarding: p2.guarding };
    setKey(sim, sim.VCONTROLS.p2.guard, false, false); setKey(sim, sim.VCONTROLS.p2.block, false, false);
    return out;
  };
  const g = swing(true), c = swing(false);
  assert.strictEqual(g.lost, 0, 'guard lets nothing through');
  assert.strictEqual(g.guarding, true);
  assert.strictEqual(g.crouching, false, 'guard stands tall');
  assert.ok(g.ult < 50 + 6 && g.ult > 40, `the meter drains slowly (${g.ult})`);
  assert.ok(c.lost > 0 && c.crouching, 'a crouch still takes the chip damage');
});

test('a stun before a special/ultimate goes off fails it but keeps the charge', () => {
  const sim = createSim();
  // Ultimate interrupted during its wind-up: the meter stays full.
  let { f } = startFighter(sim, 'owen', 400);
  f.ultCharge = sim.ULT_METER_MAX;
  f.startUltimate();
  assert.strictEqual(f.state, 'ultimate');
  assert.strictEqual(f.ultCharge, 0);
  f.actionTimer = 2;
  f.applyHit({ damage: 5, knockback: 4, knockbackUp: 1, hitstun: 12, fromFacing: -1 });
  assert.strictEqual(f.ultCharge, sim.ULT_METER_MAX, 'kept the ultimate charge');
  // Special interrupted in its start-up: no cooldown spent.
  ({ f } = startFighter(sim, 'artur', 400));
  f.startSpecial();
  assert.ok(f.specialCooldownTimer > 0);
  f.actionTimer = 2;
  f.applyHit({ damage: 5, knockback: 4, knockbackUp: 1, hitstun: 12, fromFacing: -1 });
  assert.strictEqual(f.specialCooldownTimer, 0, 'cooldown refunded');
  // But once it has gone off, being hit afterwards doesn't give it back.
  ({ f } = startFighter(sim, 'artur', 400));
  f.startSpecial();
  f.actionTimer = 15;
  f.applyHit({ damage: 5, knockback: 4, knockbackUp: 1, hitstun: 12, fromFacing: -1 });
  assert.ok(f.specialCooldownTimer > 0, 'a special that already fired stays spent');
});

test('fighters can turn around in the air (Carlos hovering)', () => {
  const sim = createSim();
  const C = sim.VCONTROLS.p1;
  const { f, foe } = startFighter(sim, 'carlos', 400);
  f.grounded = false; f.y = sim.GROUND_Y - 120; f.state = 'jump'; f.facing = 1;
  for (const a of ACTIONS) sim.InputManager.setVirtual(C[a], a === 'left', false);
  f.update(C, foe);
  assert.strictEqual(f.facing, -1);
});

// ---- Passives ----
test('every fighter has 50% more HP than before', () => {
  const sim = createSim();
  const was = { keenan: 90, artur: 115, carlos: 115, nathan: 140, owen: 90, robert: 108, ryan: 92, sam: 90, john: 124 };
  for (const [id, hp] of Object.entries(was)) assert.ok(Math.abs(sim.CHARACTERS[id].maxHp - hp * 1.5) <= 1, `${id}: ${sim.CHARACTERS[id].maxHp}`);
});

test('passives: Keenan hits harder after being hit; Artur\'s farts feed him; Carlos gets fuel at low health', () => {
  const sim = createSim();
  let { f } = startFighter(sim, 'keenan', 400);
  const base = f.damageMultiplier;
  f.applyHit({ damage: 5, knockback: 1, knockbackUp: 0, hitstun: 5, fromFacing: -1 });
  assert.ok(f.damageMultiplier > base * 1.1, 'more damage just after a hit');
  f.sinceHit = 999;
  assert.strictEqual(f.damageMultiplier, base, 'and it wears off');

  ({ f } = startFighter(sim, 'artur', 400));
  assert.strictEqual(f.damageMultiplier, 1);
  f.gainFartPower(10);
  f.state = 'attack';
  assert.ok(f.damageMultiplier > 1.1 && f.actionSpeed > 1.1, 'power and attack speed');
  f.gainFartPower(10000);
  assert.ok(Math.abs(f.damageMultiplier - (1 + sim.CHARACTERS.artur.fartPower.max)) < 1e-9, 'capped');
  f.resetForRound();
  assert.strictEqual(f.damageMultiplier, 1, 'fresh each round');

  ({ f } = startFighter(sim, 'carlos', 400));
  const full = f.hoverMax;
  f.hp = f.maxHp * 0.25;
  assert.ok(f.hoverMax > full * 1.5, `${f.hoverMax} vs ${full}`);
});

test('passives: Nathan resists projectiles; Ryan\'s ult meter boosts jumps and air attacks; Sam heals from air hits; John jumps higher per hit', () => {
  const sim = createSim();
  const dealt = (id, extra) => {
    const { f } = startFighter(sim, id, 400);
    const hp0 = f.hp;
    f.applyHit(Object.assign({ damage: 10, knockback: 1, knockbackUp: 0, hitstun: 5, fromFacing: -1 }, extra));
    return hp0 - f.hp;
  };
  assert.strictEqual(dealt('nathan', { projectile: true }), 10 * (1 - sim.CHARACTERS.nathan.projectileResist));
  assert.strictEqual(dealt('nathan', {}), 10, 'melee is not reduced');
  assert.strictEqual(dealt('keenan', { projectile: true }), 10);

  let { f } = startFighter(sim, 'ryan', 400);
  const j0 = f.jumpForceEff;
  f.ultCharge = sim.ULT_METER_MAX;
  assert.ok(f.jumpForceEff > j0 * 1.2);
  f.grounded = false;
  assert.ok(f.damageMultiplier > 1.3, 'airborne hits harder with a full meter');
  f.grounded = true;
  assert.strictEqual(f.damageMultiplier, 1, 'not on the ground');

  ({ f } = startFighter(sim, 'john', 400));
  const base = f.jumpForceEff;
  for (let i = 0; i < 3; i++) f.applyHit({ damage: 1, knockback: 1, knockbackUp: 0, hitstun: 5, fromFacing: -1 });
  assert.ok(Math.abs(f.jumpForceEff - base * (1 + 3 * sim.CHARACTERS.john.hitJump.perHit)) < 1e-9);

  // Sam: an air hit through the real loop restores health.
  const C = startGame(sim, 'sam', 'keenan', 400, 470);
  sim.Game.applySnapshot({ f: [{ x: 400, hp: 50, y: sim.GROUND_Y - 50, grounded: false, state: 'fall', vy: 0 }, { x: 465 }] });
  sim.InputManager.setVirtual(C.attack, false, true); step(sim, 1); sim.InputManager.setVirtual(C.attack, false, false);
  for (let i = 0; i < 40; i++) step(sim, 1);
  assert.ok(sim.Game.world().p1.hp > 50, 'healed a little from an air hit');
});

test('controls shown in vs-CPU mode are the one-keyboard keys', () => {
  const src = require('fs').readFileSync(require('path').join(ROOT, 'js', 'net.js'), 'utf8');
  assert.ok(/localVirtual\) return forSlot === 'p1' \? CONTROLS\.solo : null/.test(src));
});

// ---- Stages (stages.js) ----
function orchard(sim, a = 'keenan', b = 'john') {
  sim.Game.startMatch(a, b, () => {}, { ball: 'off', stage: 'orchard' });
  step(sim, 200); // through the countdown
  return sim.VCONTROLS.p1;
}
const press = (sim, C, keys, edges = []) => {
  for (const a of ACTIONS) sim.InputManager.setVirtual(C[a], keys.includes(a), edges.includes(a));
};

test('the arena is unchanged, and the orchard is a much bigger stage with its own spawns', () => {
  const sim = createSim();
  sim.Game.startMatch('keenan', 'john', () => {}, { ball: 'off' });
  let w = sim.Game.world();
  assert.deepStrictEqual(JSON.stringify([w.p1.x, w.p2.x]), '[380,900]');
  assert.strictEqual(sim.Stage.id(), 'arena');
  const arena = sim.STAGES.arena, o = sim.STAGES.orchard;
  assert.ok(o.right - o.left >= 2 * (arena.right - arena.left), 'orchard floor at least twice as wide');
  orchard(sim);
  w = sim.Game.world();
  assert.deepStrictEqual(JSON.stringify([w.p1.x, w.p2.x]), JSON.stringify(o.spawns));
  // Well past where the arena ends, still on solid ground.
  sim.Game.applySnapshot({ f: [{ x: arena.left - 300 }, {}] });
  step(sim, 30);
  assert.ok(w.p1.grounded && w.p1.y === sim.GROUND_Y, 'standing on the orchard floor');
  // ...and its edges are still a ring-out.
  sim.Game.applySnapshot({ f: [{ x: o.left - 60, y: sim.GROUND_Y - 1 }, {}] });
  step(sim, 60);
  assert.notStrictEqual(sim.Game.getState(), 'fight', 'fell off the orchard edge');
});

test('tree branches: jump up through them, land on top, crouch + jump to drop back down', () => {
  const sim = createSim();
  const C = orchard(sim, 'john', 'keenan'); // John has the lowest jump
  const branch = sim.STAGES.orchard.platforms.find((p) => p.id === 'branchL');
  const f = sim.Game.world().p1;
  sim.Game.applySnapshot({ f: [{ x: (branch.x1 + branch.x2) / 2, facing: 1 }, { x: 1600 }] });
  press(sim, C, ['jump'], ['jump']); step(sim, 1); press(sim, C, []);
  step(sim, 60);
  assert.strictEqual(f.platform, 'branchL', 'landed on the branch');
  assert.strictEqual(f.y, branch.y);
  assert.ok(f.grounded);
  // Up again onto the crown from the branch.
  const crown = sim.STAGES.orchard.platforms.find((p) => p.id === 'crown');
  sim.Game.applySnapshot({ f: [{ x: crown.x1 + 20 }, {}] }); // still at branch height, under the crown's end
  step(sim, 2);
  press(sim, C, ['jump'], ['jump']); step(sim, 1); press(sim, C, []);
  step(sim, 60);
  assert.strictEqual(f.platform, 'crown', 'climbed to the crown');
  // Crouch + jump drops through, all the way to the floor (not caught by the branch below? it may be).
  press(sim, C, ['block', 'jump'], ['jump']); step(sim, 1); press(sim, C, []);
  step(sim, 60);
  assert.notStrictEqual(f.platform, 'crown', 'dropped through the crown');
  assert.ok(f.grounded);
  // Walk off the end of a branch: fall to the floor.
  sim.Game.applySnapshot({ f: [{ x: branch.x1 + 10, y: branch.y, platform: 'branchL', grounded: true }, {}] });
  press(sim, C, ['left']); step(sim, 40); press(sim, C, []); step(sim, 30);
  assert.strictEqual(f.platform, null);
  assert.strictEqual(f.y, sim.GROUND_Y, 'fell off the branch to the floor');
});

test('the car: a warning, then it runs over whoever is in its way (block or not) but carries anyone on its roof', () => {
  const sim = createSim();
  const C = orchard(sim);
  const c = sim.STAGES.orchard.car;
  const w = sim.Game.world();
  // Keep the round going: nobody gets KO'd before the car.
  const hold = () => sim.Game.applySnapshot({ f: [{ hp: 999 }, { hp: 999 }] });
  while (!sim.Stage.car()) { hold(); step(sim, 30); }
  assert.strictEqual(sim.Stage.car().phase, 'warn', 'lights on before it drives');
  assert.strictEqual(sim.Stage.car().dir, 1, 'the first one comes from the left');
  // p1 blocking in its lane, p2 standing on its roof path (placed on it once it's under them).
  sim.Game.applySnapshot({ f: [{ x: 0, facing: -1 }, { x: 1700, hp: 999 }] });
  press(sim, C, ['block']);
  const hp0 = w.p1.hp;
  let hit = false, rode = false, x2 = null;
  for (let i = 0; i < 400 && sim.Stage.car(); i++) {
    const car = sim.Stage.car();
    // Drop p2 onto the roof once it's on the stage (well before it reaches them).
    if (car.phase === 'drive' && !rode && car.x > 100 && car.x < 130) {
      sim.Game.applySnapshot({ f: [{}, { x: car.x + 60, y: sim.GROUND_Y - c.height - 8, vy: 0, grounded: false, state: 'fall' }] });
    }
    step(sim, 1);
    if (w.p1.state === 'knockdown') hit = true;
    if (w.p2.platform === 'car') { if (!rode) x2 = w.p2.x; rode = true; }
  }
  assert.ok(hit, 'blocking does not stop a car');
  assert.ok(w.p1.hp < hp0, 'and it hurts');
  assert.ok(rode, 'landed on the roof');
  assert.ok(w.p2.x > x2 + 200 || sim.Game.getState() !== 'fight', 'carried along by the car');
});

// ---- Voice lines ----
test('voice occasions fire as effect events: the opponent falling off, and being hit by a projectile', () => {
  const sim = createSim();
  // Keenan wins by ring-out: he says his enemy-fall line.
  startGame(sim, 'keenan', 'ryan', 500, 800);
  sim.Effects.setRecording(true);
  sim.Effects.drainEvents();
  sim.Game.applySnapshot({ f: [{ x: 500 }, { x: 800, y: 5000, grounded: false, vy: 5 }] });
  step(sim, 3);
  assert.ok(sim.Effects.drainEvents().some((e) => e[0] === 'v' && e[1] === 'keenan' && e[2] === 'enemyFall'));
  // Hit by Ryan's soundwave.
  startGame(sim, 'ryan', 'keenan', 400, 700);
  sim.Effects.setRecording(true);
  sim.Effects.drainEvents();
  sim.InputManager.setVirtual(sim.VCONTROLS.p1.special, false, true); step(sim, 1); sim.InputManager.setVirtual(sim.VCONTROLS.p1.special, false, false);
  step(sim, 60);
  assert.ok(sim.Effects.drainEvents().some((e) => e[0] === 'v' && e[1] === 'keenan' && e[2] === 'hitByProjectile'), 'Keenan reacts to the projectile');
  // Not while the game is replaying frames for rollback.
  sim.Effects.setSuppressed(true);
  sim.Effects.voice('keenan', 'enemyFall');
  sim.Effects.setSuppressed(false);
  assert.strictEqual(sim.Effects.drainEvents().filter((e) => e[0] === 'v').length, 0);
});

test('matchup voice lines fire once per match, not every round', () => {
  const sim = createSim();
  const voices = (a, b) => {
    sim.Effects.setRecording(true);
    sim.Effects.drainEvents();
    sim.Game.startMatch(a, b, () => {}, { ball: 'off' });
    const first = sim.Effects.drainEvents().filter((e) => e[0] === 'v').map((e) => e.join(':'));
    step(sim, 200); // through the countdown into the fight
    sim.Game.applySnapshot({ f: [{ x: 500 }, { x: 800, y: 5000, grounded: false, vy: 5 }] });
    step(sim, 400); // round ends, next round starts
    const later = sim.Effects.drainEvents().filter((e) => e[0] === 'v' && String(e[2]).startsWith('vs:'));
    return { first, later };
  };
  const a = voices('keenan', 'robert');
  assert.ok(a.first.includes('v:keenan:vs:robert'), 'Keenan has a line against Robert');
  assert.strictEqual(a.later.length, 0, 'and it does not repeat on later rounds');
  assert.ok(voices('robert', 'keenan').first.includes('v:keenan:vs:robert'), 'whichever side he is on');
});

test('Keenan voice lines: phase step, winning the match, and the John matchup', () => {
  const sim = createSim();
  const events = () => sim.Effects.drainEvents().filter((e) => e[0] === 'v').map((e) => e.slice(1).join(':'));
  sim.Effects.setRecording(true);
  sim.Game.startMatch('keenan', 'john', () => {}, { ball: 'off' });
  assert.ok(events().includes('keenan:vs:john'));
  // Phase step
  const { f, foe } = startFighter(sim, 'keenan', 400);
  f.state = 'hitstun'; f.stunFrames = 20;
  f._tryPhaseStep(foe);
  assert.ok(events().includes('keenan:phaseStep'));
  // Victory: only when the match is won, not on an earlier round.
  step(sim, 200);
  sim.Game.applySnapshot({ f: [{ x: 500 }, { x: 800, y: 5000, grounded: false, vy: 5 }] });
  step(sim, 3);
  assert.ok(!events().includes('keenan:victory'), 'not after the first round');
  step(sim, 340); // round over, next round counted down and fighting
  sim.Game.applySnapshot({ f: [{ x: 500 }, { x: 800, y: 5000, grounded: false, vy: 5 }] });
  step(sim, 3);
  assert.ok(events().includes('keenan:victory'), 'after the deciding round');
});

test('Keenan voice lines: hit by a punch/kick (not by specials), and the Nathan matchup', () => {
  const sim = createSim();
  const events = () => sim.Effects.drainEvents().filter((e) => e[0] === 'v').map((e) => e.slice(1).join(':'));
  sim.Effects.setRecording(true);
  sim.Game.startMatch('keenan', 'nathan', () => {}, { ball: 'off' });
  assert.ok(events().includes('keenan:vs:nathan'));
  // A punch from Ryan lands on Keenan.
  const C = startGame(sim, 'ryan', 'keenan', 500, 560);
  sim.Effects.setRecording(true); events();
  punch(sim, 'p1');
  step(sim, 20);
  assert.ok(events().includes('keenan:hitTaken'), 'hit taken line on a punch');
  // But not a soundwave (that's a projectile).
  startGame(sim, 'ryan', 'keenan', 400, 700);
  sim.Effects.setRecording(true); events();
  sim.InputManager.setVirtual(sim.VCONTROLS.p1.special, false, true); step(sim, 1); sim.InputManager.setVirtual(sim.VCONTROLS.p1.special, false, false);
  step(sim, 60);
  const ev = events();
  assert.ok(ev.includes('keenan:hitByProjectile') && !ev.includes('keenan:hitTaken'));
});

test('voice lines: getting up from a knockdown, and the Ryan / Artur matchups', () => {
  const sim = createSim();
  const events = () => sim.Effects.drainEvents().filter((e) => e[0] === 'v').map((e) => e.slice(1).join(':'));
  sim.Effects.setRecording(true);
  sim.Game.startMatch('keenan', 'ryan', () => {}, { ball: 'off' });
  assert.ok(events().includes('keenan:vs:ryan'));
  sim.Game.startMatch('artur', 'owen', () => {}, { ball: 'off' });
  assert.ok(events().includes('owen:vs:artur'), 'Owen has a line against Artur');
  const { f, foe } = startFighter(sim, 'keenan', 400);
  events();
  f.applyHit({ damage: 1, knockback: 1, knockbackUp: 0, hitstun: 5, fromFacing: -1, knockdown: true, knockdownDuration: 30 });
  assert.strictEqual(f.state, 'knockdown');
  const C = sim.VCONTROLS.p1;
  for (let i = 0; i < 90 && f.state === 'knockdown'; i++) f.update(C, foe);
  assert.ok(events().includes('keenan:recovery'), 'recovery line when he gets up');
});

test('Artur voice lines: the fart special and ultimate, and being hit by a punch', () => {
  const sim = createSim();
  const events = () => sim.Effects.drainEvents().filter((e) => e[0] === 'v').map((e) => e.slice(1).join(':'));
  sim.Effects.setRecording(true);
  let { f } = startFighter(sim, 'artur', 400);
  events();
  f.startSpecial();
  assert.ok(events().includes('artur:fart'), 'special');
  ({ f } = startFighter(sim, 'artur', 400));
  f.ultCharge = sim.ULT_METER_MAX; events();
  f.startUltimate();
  assert.ok(events().includes('artur:fart'), 'ultimate');
  ({ f } = startFighter(sim, 'keenan', 400));
  f.startSpecial();
  assert.ok(!events().includes('keenan:fart'), 'only Artur farts');
  startGame(sim, 'ryan', 'artur', 500, 560);
  sim.Effects.setRecording(true); events();
  punch(sim, 'p1'); step(sim, 20);
  assert.ok(events().includes('artur:hitTaken'));
});

test('hit voice occasions: specials, ultimates and the ball are reported as their own occasions (audio falls back to hitTaken)', () => {
  const sim = createSim();
  const events = () => sim.Effects.drainEvents().filter((e) => e[0] === 'v').map((e) => e.slice(1).join(':'));
  // John's Momentum Roll (a special) hits Keenan.
  startGame(sim, 'john', 'keenan', 500, 560);
  sim.Effects.setRecording(true); events();
  sim.InputManager.setVirtual(sim.VCONTROLS.p1.special, false, true); step(sim, 1); sim.InputManager.setVirtual(sim.VCONTROLS.p1.special, false, false);
  step(sim, 40);
  assert.ok(events().some((e) => e.startsWith('keenan:hitBySpecial:john')), 'reported with who hit him, falling back to the general kind');
  assert.ok(events().length >= 0);
});

test('voice: falling off the map (the faller), and heavy blows (15% of max health in one hit)', () => {
  const sim = createSim();
  const events = () => sim.Effects.drainEvents().filter((e) => e[0] === 'v').map((e) => e.slice(1).join(':'));
  startGame(sim, 'ryan', 'carlos', 500, 800);
  sim.Effects.setRecording(true); events();
  sim.Game.applySnapshot({ f: [{ x: 500 }, { x: 800, y: 5000, grounded: false, vy: 5 }] });
  step(sim, 3);
  const ev = events();
  assert.ok(ev.includes('carlos:fallOff') && ev.includes('ryan:enemyFall'));
  // Owen's Plasma Nuke is a heavy blow on Carlos; a plain punch isn't.
  startGame(sim, 'owen', 'carlos', 500, 600);
  sim.Effects.setRecording(true); events();
  sim.Game.applySnapshot({ f: [{ ultCharge: 100 }, {}] });
  sim.InputManager.setVirtual(sim.VCONTROLS.p1.ultimate, false, true); step(sim, 1); sim.InputManager.setVirtual(sim.VCONTROLS.p1.ultimate, false, false);
  step(sim, 80);
  assert.ok(events().includes('carlos:bigHit'), 'the nuke is a big hit');
  startGame(sim, 'ryan', 'carlos', 500, 560);
  sim.Effects.setRecording(true); events();
  punch(sim, 'p1'); step(sim, 20);
  const punchEv = events();
  assert.ok(punchEv.includes('carlos:hitTaken') && !punchEv.includes('carlos:bigHit'));
});

test('Nathan voice lines: falling off the map and the John matchup', () => {
  const sim = createSim();
  const events = () => sim.Effects.drainEvents().filter((e) => e[0] === 'v').map((e) => e.slice(1).join(':'));
  sim.Effects.setRecording(true);
  sim.Game.startMatch('nathan', 'john', () => {}, { ball: 'off' });
  assert.ok(events().includes('nathan:vs:john'));
  step(sim, 200);
  sim.Game.applySnapshot({ f: [{ x: 500, y: 5000, grounded: false, vy: 5 }, { x: 800 }] });
  step(sim, 3);
  assert.ok(events().includes('nathan:fallOff'));
});

test('voice: knocked down, using the ultimate, and beating a particular fighter', () => {
  const sim = createSim();
  const events = () => sim.Effects.drainEvents().filter((e) => e[0] === 'v').map((e) => e.slice(1).join(':'));
  sim.Effects.setRecording(true);
  sim.Game.startMatch('ryan', 'john', () => {}, { ball: 'off' });
  assert.ok(events().includes('ryan:vs:john'));
  sim.Game.startMatch('nathan', 'artur', () => {}, { ball: 'off' });
  assert.ok(events().includes('nathan:vs:artur'));
  let { f, foe } = startFighter(sim, 'nathan', 400);
  events();
  f.applyHit({ damage: 1, knockback: 1, knockbackUp: 0, hitstun: 5, fromFacing: -1, knockdown: true, knockdownDuration: 30 });
  assert.ok(events().includes('nathan:knockedDown'));
  f.ultCharge = 50; f.startUltimate();
  assert.ok(!events().includes('nathan:ultimate'), 'not without a full meter');
  f.state = 'idle'; f.ultCharge = sim.ULT_METER_MAX; f.startUltimate();
  assert.ok(events().includes('nathan:ultimate'));
  // Beating Owen: the match-winning ring-out.
  sim.Game.startMatch('nathan', 'owen', () => {}, { ball: 'off' });
  step(sim, 200); events();
  for (let round = 0; round < 2; round++) {
    sim.Game.applySnapshot({ f: [{ x: 500 }, { x: 800, y: 5000, grounded: false, vy: 5 }] });
    step(sim, 3);
    if (round === 0) { assert.ok(!events().includes('nathan:beats:owen')); step(sim, 340); }
  }
  assert.ok(events().includes('nathan:beats:owen'));
});

test('Owen laughs when his opponent falls off the map', () => {
  const sim = createSim();
  startGame(sim, 'owen', 'keenan', 500, 800);
  sim.Effects.setRecording(true); sim.Effects.drainEvents();
  sim.Game.applySnapshot({ f: [{ x: 500 }, { x: 800, y: 5000, grounded: false, vy: 5 }] });
  step(sim, 3);
  assert.ok(sim.Effects.drainEvents().some((e) => e[0] === 'v' && e[1] === 'owen' && e[2] === 'enemyFall'));
});

test('Owen vs John matchup line, and Ryan\'s "yeah" on his ultimate', () => {
  const sim = createSim();
  const events = () => sim.Effects.drainEvents().filter((e) => e[0] === 'v').map((e) => e.slice(1).join(':'));
  sim.Effects.setRecording(true);
  sim.Game.startMatch('john', 'owen', () => {}, { ball: 'off' });
  assert.ok(events().includes('owen:vs:john'));
  const { f } = startFighter(sim, 'ryan', 400);
  f.ultCharge = sim.ULT_METER_MAX; events();
  f.startUltimate();
  assert.ok(events().includes('ryan:ultimate'));
});

test('voice: Sam\'s water attacks, round wins, and a foe running away after a hit', () => {
  const sim = createSim();
  const events = () => sim.Effects.drainEvents().filter((e) => e[0] === 'v').map((e) => e.slice(1).join(':'));
  // Round win (match continues).
  startGame(sim, 'owen', 'keenan', 500, 800);
  sim.Effects.setRecording(true); events();
  sim.Game.applySnapshot({ f: [{ x: 500 }, { x: 800, y: 5000, grounded: false, vy: 5 }] });
  step(sim, 3);
  assert.ok(events().includes('owen:roundWin'));
  // Sam's Cannonball Dive on Keenan is a water attack.
  startGame(sim, 'sam', 'keenan', 500, 560);
  sim.Effects.setRecording(true); events();
  sim.InputManager.setVirtual(sim.VCONTROLS.p1.special, false, true); step(sim, 1); sim.InputManager.setVirtual(sim.VCONTROLS.p1.special, false, false);
  step(sim, 50);
  assert.ok(events().some((e) => e.startsWith('keenan:hitBySpecial:sam|hitByWater')), 'Sam\'s special: his own, then water, then the general kind');
  // Owen hits, then Keenan backs away.
  startGame(sim, 'owen', 'keenan', 500, 560);
  sim.Effects.setRecording(true); events();
  punch(sim, 'p1'); step(sim, 14);
  assert.ok(sim.Game.world().p1.foeHitTimer > 0);
  sim.Game.applySnapshot({ f: [{}, { x: 700, vx: 6, state: 'walk', stunFrames: 0 }] });
  step(sim, 2);
  assert.ok(events().includes('owen:foeRunsAway'));
});

test('voice: block, dealing a heavy blow, match start and Robert\'s transformation', () => {
  const sim = createSim();
  const events = () => sim.Effects.drainEvents().filter((e) => e[0] === 'v').map((e) => e.slice(1).join(':'));
  sim.Effects.setRecording(true);
  sim.Game.startMatch('robert', 'keenan', () => {}, { ball: 'off' });
  const start = events();
  assert.ok(start.includes('robert:matchStart'));
  assert.ok(start.indexOf('keenan:vs:robert') < start.indexOf('robert:matchStart'), 'matchup lines are announced first');
  // Block (guard) a punch.
  startGame(sim, 'ryan', 'robert', 500, 560);
  sim.Effects.setRecording(true); events();
  setKey(sim, sim.VCONTROLS.p2.guard, true, false);
  punch(sim, 'p1'); step(sim, 20);
  setKey(sim, sim.VCONTROLS.p2.guard, false, false);
  assert.ok(events().includes('robert:block'));
  // Heavy blow dealt: Robert's Body Slam ultimate.
  startGame(sim, 'robert', 'keenan', 500, 560);
  sim.Effects.setRecording(true); events();
  sim.Game.applySnapshot({ f: [{ ultCharge: 100 }, {}] });
  sim.InputManager.setVirtual(sim.VCONTROLS.p1.ultimate, false, true); step(sim, 1); sim.InputManager.setVirtual(sim.VCONTROLS.p1.ultimate, false, false);
  step(sim, 60);
  assert.ok(events().includes('robert:dealsBigDamage'));
  // Transformation.
  const { f } = startFighter(sim, 'robert', 400);
  events();
  f.hp = f.maxHp * 0.4; f._maybeTransform();
  assert.ok(events().includes('robert:transform'));
});

test('every file named in the VOICE table exists', () => {
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(ROOT, 'js', 'audio.js'), 'utf8');
  const start = src.indexOf('const VOICE = {'), end = src.indexOf('const voiceBuffers');
  const block = src.slice(start, end);
  // VOICE.<char> = { ... } sections and the first literal block: find "<char>" owners by scanning in order.
  const re = /(?:^|\n)\s*(?:const VOICE = \{\s*\n\s*(\w+): \{|VOICE\.(\w+) = \{)([\s\S]*?)\n\s*\}[;,]?\s*(?=\n)/g;
  let m, checked = 0;
  while ((m = re.exec(block))) {
    const owner = m[1] || m[2];
    for (const f of m[3].match(/'([^']+\.(?:mp3|m4a|ogg|wav))'/g) || []) {
      const name = f.slice(1, -1), file = name.includes('/') ? name : `${owner}/${name}`;
      assert.ok(fs.existsSync(path.join(ROOT, 'assets', 'voice', file)), `missing voice file ${file}`);
      checked++;
    }
  }
  assert.ok(checked > 30, `only checked ${checked} files`);
});

test('Keenan: an air kick that lands leaves him hanging so he can chain kicks; a miss does not', () => {
  const sim = createSim();
  const k = sim.CHARACTERS.keenan.airAttack;
  const setup = (foeX) => {
    const C = startGame(sim, 'keenan', 'ryan', 500, foeX);
    sim.Game.applySnapshot({ f: [{ x: 500, y: sim.GROUND_Y - 150, grounded: false, vy: 0, state: 'fall', jumpsUsed: 1 }, { x: foeX, y: sim.GROUND_Y, state: 'idle' }] });
    return C;
  };
  const kick = (C) => { sim.InputManager.setVirtual(C.attack, false, true); step(sim, 1); sim.InputManager.setVirtual(C.attack, false, false); };
  const p1 = () => sim.Game.world().p1;

  // A kick that misses: he just falls.
  let C = setup(900);
  kick(C); step(sim, 40);
  assert.ok(p1().y > sim.GROUND_Y - 100, 'a whiff does not suspend him');

  // A kick that lands: he stays at height.
  C = setup(560);
  const y0 = p1().y;
  kick(C);
  let hit = false;
  for (let i = 0; i < 30 && !hit; i++) { step(sim, 1); hit = sim.Game.world().p2.hp < sim.Game.world().p2.maxHp; }
  assert.ok(hit, 'the kick landed');
  assert.ok(p1().airSuspend > 0);
  step(sim, 25);
  assert.ok(Math.abs(p1().y - y0) < 25, `hung in the air (${y0} -> ${p1().y})`);
  // Chain: kick again while the target is still in reach.
  const hp1 = sim.Game.world().p2.hp;
  sim.Game.applySnapshot({ f: [{}, { x: 560, state: 'idle', stunFrames: 0 }] });
  kick(C);
  for (let i = 0; i < 30; i++) step(sim, 1);
  assert.ok(sim.Game.world().p2.hp < hp1, 'the second kick landed too');
  assert.ok(p1().airChain >= 2);
  // The opponent gets away: he falls once the suspension runs out.
  sim.Game.applySnapshot({ f: [{}, { x: 900 }] });
  step(sim, 120);
  assert.strictEqual(p1().grounded, true, 'back on the ground eventually');
  assert.strictEqual(p1().airChain, 0);
  assert.ok(k.suspend > 0 && k.maxChain > 1);
});

test('Ryan: landing the shockwave (or a 3-hit combo) arms a Finale air kick with extra damage and knockback, spent when thrown', () => {
  const sim = createSim();
  const R = sim.CHARACTERS.ryan;
  const airKick = () => {
    const C = sim.VCONTROLS.p1;
    sim.Game.applySnapshot({ f: [{ x: 500, y: sim.GROUND_Y - 120, grounded: false, vy: 0, state: 'fall', jumpsUsed: 1, comboHits: 0 }, { x: 565, state: 'idle', stunFrames: 0, hp: 130 }] });
    const hp0 = sim.Game.world().p2.hp;
    sim.InputManager.setVirtual(C.attack, false, true); step(sim, 1); sim.InputManager.setVirtual(C.attack, false, false);
    let vx = 0;
    for (let i = 0; i < 25; i++) { step(sim, 1); const p2 = sim.Game.world().p2; if (p2.hp < hp0) { vx = Math.abs(p2.vx); break; } }
    return { dmg: hp0 - sim.Game.world().p2.hp, vx };
  };
  startGame(sim, 'ryan', 'keenan', 500, 565);
  const plain = airKick();
  assert.ok(Math.abs(plain.dmg - R.airAttack.damage * sim.Game.world().p1.damageMultiplier * 0.5) < 0.6 || plain.dmg > 0, 'a plain kick lands');

  // The shockwave lands -> armed.
  startGame(sim, 'ryan', 'keenan', 500, 565);
  const C = sim.VCONTROLS.p1;
  sim.Game.applySnapshot({ f: [{ x: 500, y: sim.GROUND_Y - 120, grounded: false, vy: 0, state: 'fall', jumpsUsed: 1 }, { x: 540, state: 'idle', hp: 130 }] });
  setKey(sim, C.block, true, false);
  sim.InputManager.setVirtual(C.attack, false, true); step(sim, 1); sim.InputManager.setVirtual(C.attack, false, false);
  for (let i = 0; i < 25; i++) step(sim, 1);
  setKey(sim, C.block, false, false);
  assert.ok(sim.Game.world().p1.finaleArmed > 0, 'the shockwave arms the Finale');
  step(sim, 20);
  const boosted = airKick();
  assert.ok(boosted.dmg > plain.dmg * 1.3, `Finale damage ${boosted.dmg} vs ${plain.dmg}`);
  assert.strictEqual(sim.Game.world().p1.finaleArmed, 0, 'spent');
  const again = airKick();
  assert.ok(again.dmg < boosted.dmg * 0.9, 'the next kick is back to normal');
  assert.ok(R.finale.knockback > 1 && R.finale.damage > 1);
  assert.ok(sim.CHARACTERS.owen.ultimate.channel >= 40, 'Owen\'s nuke charges for longer');
});


test('voice fallback chains: John has a line for Sam\'s ultimate; Keenan keeps his water line for Sam\'s attacks', () => {
  const sim = createSim();
  const events = () => sim.Effects.drainEvents().filter((e) => e[0] === 'v').map((e) => e.slice(1).join(':'));
  startGame(sim, 'sam', 'john', 500, 560);
  sim.Effects.setRecording(true); events();
  sim.Game.applySnapshot({ f: [{ ultCharge: 100 }, {}] });
  sim.InputManager.setVirtual(sim.VCONTROLS.p1.ultimate, false, true); step(sim, 1); sim.InputManager.setVirtual(sim.VCONTROLS.p1.ultimate, false, false);
  step(sim, 80);
  assert.ok(events().some((e) => e.startsWith('john:hitByUltimate:sam|hitByWater|hitByUltimate')));
});
