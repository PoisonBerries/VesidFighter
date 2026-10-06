// The CPU should play each character's whole kit, not just punch and one or
// two specials: across a few full matches per character (against the other
// CPU levels and a button-masher) every move below has to turn up at least
// once. Watching the fighter's own state (the CPU only ever presses buttons,
// same as a player), so a move that the CPU never thinks to try fails here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT } = require('./helpers');

const FILES = ['constants.js', 'stages.js', 'input.js', 'characters.js', 'effects.js', 'fighter.js', 'game.js', 'rollback.js', 'cpu.js'];
const ACTIONS = ['left', 'right', 'block', 'guard', 'jump', 'attack', 'special', 'ultimate'];
const source = FILES.map((f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n;\n');
const PRELUDE = `
  const window = { addEventListener() {} };
  const VCONTROLS = {};
  for (const slot of ['p1', 'p2']) { VCONTROLS[slot] = {}; for (const a of ${JSON.stringify(ACTIONS)}) VCONTROLS[slot][a] = 'V_' + slot + '_' + a; }
  const Net = { controlsFor: (slot) => VCONTROLS[slot], setLocalVirtual() {} };
`;
const script = new vm.Script(PRELUDE + source + '\n({ Game, Cpu, Rollback, CHARACTER_LIST, FIXED_STEP });', { filename: 'cpu-moves-sim.js' });
const createSim = () => script.runInContext(vm.createContext({ console, Math, JSON, performance: { now: () => 0 } }));

// What counts as "used" -- read off the fighter each frame.
const DETECT = {
  attack: (f) => f.state === 'attack' && !f.airAttackActive && !f.downAttackActive && !f.upAttackActive,
  airAttack: (f) => f.state === 'attack' && f.airAttackActive,
  downAttack: (f) => f.state === 'attack' && f.downAttackActive,
  upAttack: (f) => f.state === 'attack' && f.upAttackActive,
  special: (f) => f.state === 'special',
  ultimate: (f) => f.state === 'ultimate' || f.isPhased,
  guard: (f) => f.guarding,
  phaseStep: (f) => f.state === 'phasestep',
  hover: (f) => f.hovering,
  hoverDive: (f) => f.state === 'hoverdive',
  roll: (f) => f.rolling,
  swim: (f) => !!f.character.crouchSwim && f.state === 'block' && !f.guarding && Math.abs(f.vx) > 1,
  chainKick: (f) => f.airChain >= 2,
  finale: (f) => f.finaleKick && f.state === 'attack',
  chargedJump: (f) => f.state === 'jumpcharge' && f.jumpCharge >= 20,
  whirlwind: (f) => f.state === 'whirlwind',
  grab: (f) => f.state === 'grabslam' || f.state === 'grabbeat',
  transform: (f) => f.transformed,
};

// What each character's CPU has to show off.
const KIT = {
  keenan: ['attack', 'airAttack', 'chainKick', 'phaseStep', 'special', 'ultimate', 'guard'],
  artur: ['attack', 'roll', 'special', 'ultimate', 'guard'],
  carlos: ['attack', 'hover', 'hoverDive', 'special', 'ultimate', 'guard'],
  nathan: ['attack', 'upAttack', 'special', 'ultimate', 'guard'],
  owen: ['attack', 'chargedJump', 'whirlwind', 'special', 'ultimate', 'guard'],
  robert: ['attack', 'grab', 'special', 'ultimate', 'guard'],
  ryan: ['attack', 'airAttack', 'downAttack', 'finale', 'special', 'ultimate', 'guard'],
  sam: ['attack', 'airAttack', 'swim', 'special', 'ultimate', 'guard'],
  john: ['attack', 'downAttack', 'grab', 'special', 'ultimate', 'guard'],
};

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// One match: `id` played by the CPU at `level` against `opp` played by a CPU too. Returns the set of moves seen.
function movesUsed(id, opp, level, seed, frames) {
  const sim = createSim();
  sim.Game.startMatch(id, opp, () => {}, { ball: 'off', balance: false });
  const a = level === 'unbeatable' ? sim.Cpu.createSearchBrain('p1') : sim.Cpu.createBrain('p1', level, seed);
  const b = sim.Cpu.createBrain('p2', 'normal', seed + 7);
  const seen = new Set();
  for (let f = 0; f < frames; f++) {
    const w = sim.Game.world();
    sim.Rollback.applyInput('p1', a.think(w.p1, w.p2, w.projectiles, w.matchState, w.ball));
    sim.Rollback.applyInput('p2', b.think(w.p2, w.p1, w.projectiles, w.matchState, w.ball));
    sim.Game.update(sim.FIXED_STEP);
    const me = sim.Game.world().p1;
    for (const [name, fn] of Object.entries(DETECT)) if (!seen.has(name) && fn(me)) seen.add(name);
    if (sim.Game.getState() === 'idle') break;
  }
  return seen;
}

const OPPONENTS = (id) => ['keenan', 'john', 'ryan', 'carlos'].filter((o) => o !== id);

for (const [id, kit] of Object.entries(KIT)) {
  test(`the CPU plays ${id}'s whole kit (${kit.join(', ')})`, () => {
    const seen = new Set();
    // Hard CPUs over a few matches, then tougher ones if something is still missing.
    for (const [k, opp] of OPPONENTS(id).entries()) {
      movesUsed(id, opp, 'hard', 40 + k * 13, 9000).forEach((m) => seen.add(m));
      if (kit.every((m) => seen.has(m))) break;
    }
    const missing = kit.filter((m) => !seen.has(m));
    assert.deepStrictEqual(missing, [], `${id}'s CPU never used: ${missing.join(', ')} (it did use: ${[...seen].join(', ')})`);
  });
}

// Unbeatable picks from a list of options each time it decides. The list has to hold the moves that need
// particular buttons together, or it could never choose them.
test('Unbeatable has an option for each character\'s particular moves', () => {
  const sim = createSim();
  sim.Game.startMatch('keenan', 'john', () => {}, { ball: 'off', balance: false });
  const brain = sim.Cpu.createSearchBrain('p1');
  const names = (id, mutate) => {
    sim.Game.startMatch(id, 'john', () => {}, { ball: 'off', balance: false });
    const w = sim.Game.world();
    if (mutate) mutate(w.p1);
    return brain.plansFor(w.p1, w.p2).map((p) => p.name);
  };
  const need = (list, ...wanted) => wanted.forEach((n) => assert.ok(list.includes(n), `missing "${n}" in ${list.join(' | ')}`));
  need(names('nathan'), 'up + attack', 'guard', 'down + attack');
  need(names('artur'), 'crawl in');
  need(names('sam'), 'crawl in');
  need(names('carlos'), 'hover dive');
  need(names('keenan'), 'chain kick');
  need(names('ryan'), 'shockwave then kick');
  need(names('keenan', (f) => { f.state = 'hitstun'; f.sinceHit = 0; }), 'phase step');
  assert.ok(!names('keenan').includes('phase step'), 'no phase step when he has not just been hit');
  assert.ok(!names('ryan').includes('chain kick') && !names('ryan').includes('up + attack'));
});

// A telegraphed move (an ultimate charging up, a slow special) is sometimes met with a full guard, more often at the
// higher levels. Owen's Plasma Nuke is the clean case: nothing else makes a CPU guard against it.
test('the CPU sometimes guards against a telegraphed ultimate: about 5% on Easy, a little more on Normal and Hard', () => {
  const guardRate = (level) => {
    let blocked = 0, trials = 400;
    for (let seed = 1; seed <= trials; seed++) {
      const sim = createSim();
      sim.Game.startMatch('keenan', 'owen', () => {}, { ball: 'off', balance: false });
      for (let i = 0; i < 200; i++) sim.Game.update(sim.FIXED_STEP);
      const brain = sim.Cpu.createBrain('p1', level, seed);
      const w = sim.Game.world();
      w.p1.x = 500; w.p2.x = 640; w.p2.facing = -1;
      let any = false;
      for (let t = 0; t < 130 && !any; t++) {
        if (t < 30) { w.p2.state = 'idle'; w.p2.actionTimer = 0; } // (standing there, then the ultimate starts: the CPU notices it a moment later)
        else { w.p2.state = 'ultimate'; w.p2.actionTimer = Math.min(t - 30, 40); w.p2._ability = { fired: false }; }
        const bits = brain.think(w.p1, w.p2, [], 'fight', null);
        if (bits & sim.Rollback.BIT.guard) any = true;
      }
      if (any) blocked++;
    }
    return blocked / trials;
  };
  const easy = guardRate('easy'), normal = guardRate('normal'), hard = guardRate('hard');
  assert.ok(easy > 0.02 && easy < 0.1, `Easy guards ${(easy * 100).toFixed(1)}%`);
  assert.ok(normal > easy && hard > normal * 0.9, `Normal ${(normal * 100).toFixed(1)}%, Hard ${(hard * 100).toFixed(1)}%`);
  assert.ok(hard < 0.18, `Hard guards ${(hard * 100).toFixed(1)}%: still only occasionally`);
});
