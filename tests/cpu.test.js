// The CPU opponent (js/cpu.js), headless: full matches for every character
// against simple scripted players and against itself at each difficulty.
// These are the numbers it was tuned to; a change that makes it fall off
// the stage on its own or lose to button-mashing should fail here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT } = require('./helpers');

const FILES = ['constants.js', 'input.js', 'characters.js', 'effects.js', 'fighter.js', 'game.js', 'rollback.js', 'cpu.js'];
const ACTIONS = ['left', 'right', 'block', 'jump', 'attack', 'special', 'ultimate'];
const source = FILES.map((f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n;\n');
const PRELUDE = `
  const window = { addEventListener() {} };
  const VCONTROLS = {};
  for (const slot of ['p1', 'p2']) { VCONTROLS[slot] = {}; for (const a of ${JSON.stringify(ACTIONS)}) VCONTROLS[slot][a] = 'V_' + slot + '_' + a; }
  const Net = { controlsFor: (slot) => VCONTROLS[slot], setLocalVirtual() {} };
`;
const script = new vm.Script(PRELUDE + source + '\n({ Game, Cpu, Rollback, CHARACTER_LIST, FIXED_STEP });', { filename: 'cpu-sim.js' });
const createSim = () => script.runInContext(vm.createContext({ console, Math, JSON, performance: { now: () => 0 } }));

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Scripted opponents.
const BOTS = {
  // Random buttons, like someone who just picked up the controller.
  masher(sim, seed) {
    const r = rng(seed), B = sim.Rollback.BIT;
    let held = 0, until = 0, t = 0;
    return { think() {
      t++;
      if (t >= until) { held = 0; if (r() < 0.4) held |= B.left; else if (r() < 0.6) held |= B.right; if (r() < 0.15) held |= B.block; until = t + 5 + Math.floor(r() * 20); }
      let b = held;
      if (r() < 0.08) b |= B.attack; if (r() < 0.03) b |= B.jump; if (r() < 0.02) b |= B.special; if (r() < 0.02) b |= B.ultimate;
      return b;
    } };
  },
  // Walks straight in and swings the instant it's in range (frame-perfect).
  rusher(sim) {
    const B = sim.Rollback.BIT;
    let t = 0;
    return { think(me, o) {
      t++;
      const d = o.x - me.x, a = me.character.attack;
      let b = d < 0 ? B.left : B.right;
      if (Math.abs(d) < a.offset + a.width + 20 && t % 6 === 0) b |= B.attack;
      if (me.specialCooldownTimer <= 0 && t % 97 === 0) b |= B.special;
      if (me.ultCharge >= 100) b |= B.ultimate;
      return b;
    } };
  },
  passive() { return { think: () => 0 }; },
};

function playMatch(kinds, chars, seed) {
  const sim = createSim();
  let winner = null;
  sim.Game.startMatch(chars[0], chars[1], (w) => { winner = w; });
  const brains = kinds.map((k, i) => (k.startsWith('cpu:')
    ? sim.Cpu.createBrain(i ? 'p2' : 'p1', k.slice(4), seed + i)
    : BOTS[k](sim, seed + i)));
  const lastHit = [-999, -999], seq = [0, 0], selfKO = [0, 0];
  let prev = 'countdown';
  for (let f = 0; f < 16000 && !winner; f++) {
    const w = sim.Game.world();
    const fs = [w.p1, w.p2];
    sim.Rollback.applyInput('p1', brains[0].think(w.p1, w.p2, w.projectiles, w.matchState));
    sim.Rollback.applyInput('p2', brains[1].think(w.p2, w.p1, w.projectiles, w.matchState));
    sim.Game.update(sim.FIXED_STEP);
    fs.forEach((F, i) => { if (F.impactSeq !== seq[i]) { seq[i] = F.impactSeq; lastHit[i] = f; } });
    const st = sim.Game.getState();
    // Fell off the stage without being hit in the last two seconds.
    if (st === 'roundEnd' && prev === 'fight') fs.forEach((F, i) => { if (F.hasFallenOff() && f - lastHit[i] > 120) selfKO[i]++; });
    prev = st;
  }
  return { winner, selfKO };
}

// Every character, on both sides, against a rotating opponent character.
function series(a, b) {
  const ids = createSim().CHARACTER_LIST.map((c) => c.id);
  let wins = 0, games = 0, unfinished = 0;
  const selfKO = [0, 0];
  ids.forEach((id, i) => {
    const other = ids[(i + 1) % ids.length];
    for (const flip of [false, true]) {
      const r = flip ? playMatch([b, a], [other, id], 100 + i) : playMatch([a, b], [id, other], 100 + i);
      const [ai, bi] = flip ? [1, 0] : [0, 1];
      games++;
      if (!r.winner) unfinished++;
      if (r.winner === (ai ? 'p2' : 'p1')) wins++;
      selfKO[0] += r.selfKO[ai]; selfKO[1] += r.selfKO[bi];
    }
  });
  return { rate: wins / games, games, unfinished, selfKO };
}

test('the CPU never falls off the stage on its own (all difficulties, every character)', () => {
  for (const level of ['easy', 'normal', 'hard']) {
    const r = series('cpu:' + level, 'passive');
    assert.strictEqual(r.selfKO[0], 0, `${level} CPU fell off the stage by itself ${r.selfKO[0]} times`);
    assert.strictEqual(r.rate, 1, `${level} CPU failed to beat an opponent who does nothing`);
    assert.strictEqual(r.unfinished, 0);
  }
});

test('Normal CPU beats button-mashing, and holds its own against a frame-perfect rusher', () => {
  const mash = series('cpu:normal', 'masher');
  assert.ok(mash.rate >= 0.75, `beat the masher only ${(mash.rate * 100).toFixed(0)}% of the time`);
  const rush = series('cpu:normal', 'rusher');
  assert.ok(rush.rate >= 0.5, `beat the rusher only ${(rush.rate * 100).toFixed(0)}% of the time`);
});

test('difficulty levels are ordered: Hard beats Easy', () => {
  const r = series('cpu:hard', 'cpu:easy');
  assert.ok(r.rate >= 0.6, `Hard beat Easy only ${(r.rate * 100).toFixed(0)}% of the time`);
});
