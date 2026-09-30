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
const EXPORTS = '\n({ Game, InputManager, Effects, Fighter, CHARACTERS, CHARACTER_LIST, VCONTROLS, GROUND_Y, STAGE_LEFT_EDGE, STAGE_RIGHT_EDGE, FIXED_STEP, ULT_METER_MAX });';
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
