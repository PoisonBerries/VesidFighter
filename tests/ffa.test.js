// Free-for-all (online, experimental): up to four fighters, double health,
// last one standing wins the round. The rules in the sim, and rollback
// keeping four players' copies of the game identical over a bad network.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT } = require('./helpers');

const FILES = ['constants.js', 'stages.js', 'input.js', 'characters.js', 'effects.js', 'fighter.js', 'game.js', 'rollback.js'];
const ACTIONS = ['left', 'right', 'block', 'guard', 'jump', 'attack', 'special', 'ultimate'];
const SLOTS = ['p1', 'p2', 'p3', 'p4'];
const source = FILES.map((f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n;\n');
const PRELUDE = `
  const window = { addEventListener() {} };
  const VCONTROLS = {};
  for (const slot of ${JSON.stringify(SLOTS)}) { VCONTROLS[slot] = {}; for (const a of ${JSON.stringify(ACTIONS)}) VCONTROLS[slot][a] = 'V_' + slot + '_' + a; }
  const Net = { controlsFor: (slot) => VCONTROLS[slot] };
`;
const script = new vm.Script(PRELUDE + source + '\n({ Game, Rollback, InputManager, Stage, CHARACTERS, CHARACTER_LIST, FIXED_STEP, FFA_HP_MUL, FFA_ROUND_TIME, ROUND_TIME, GROUND_Y });', { filename: 'ffa-sim.js' });
const createSim = () => script.runInContext(vm.createContext({ console: { warn() {}, log() {} }, Math, JSON, performance: { now: () => 0 } }));
const plain = (v) => JSON.parse(JSON.stringify(v));

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const FOUR = ['keenan', 'robert', 'owen', 'john'];
const fightNow = (sim) => { while (sim.Game.getState() !== 'fight') sim.Game.update(sim.FIXED_STEP); };

// ---- Rules ----

test('free-for-all: four fighters, double health, a longer round, spread across the floor', () => {
  const sim = createSim();
  sim.Game.startMatch(FOUR, () => {}, { ffa: true, ball: 'off', balance: false });
  const fs4 = sim.Game.fighters();
  assert.deepStrictEqual(plain(fs4.map((f) => f.slot)), SLOTS);
  for (const f of fs4) {
    assert.strictEqual(f.maxHp, f.character.maxHp * sim.FFA_HP_MUL);
    assert.strictEqual(f.hp, f.maxHp);
  }
  const xs = fs4.map((f) => f.x);
  assert.deepStrictEqual(xs, xs.slice().sort((a, b) => a - b), 'spawned left to right');
  assert.ok(new Set(xs).size === 4);
  assert.strictEqual(fs4[0].facing, 1);
  assert.strictEqual(fs4[3].facing, -1);
  assert.strictEqual(sim.Game.getSnapshot().rt, sim.FFA_ROUND_TIME);
  // Two-player matches are unchanged.
  sim.Game.startMatch('keenan', 'owen', () => {}, { ball: 'off' });
  assert.strictEqual(sim.Game.fighters().length, 2);
  assert.strictEqual(sim.Game.p1 === undefined, true);
  assert.strictEqual(sim.Game.world().p1.maxHp, sim.CHARACTERS.keenan.maxHp);
  assert.strictEqual(sim.Game.getSnapshot().rt, sim.ROUND_TIME);
});

test('free-for-all: a KO puts a fighter out, and the round goes on until one is left', () => {
  const sim = createSim();
  let winner = null;
  sim.Game.startMatch(FOUR, (w) => { winner = w; }, { ffa: true, ball: 'off', balance: false });
  const [a, b, c, d] = sim.Game.fighters();
  fightNow(sim);
  b.hp = 0;
  sim.Game.update(sim.FIXED_STEP);
  assert.strictEqual(b.out, 'ko');
  assert.strictEqual(sim.Game.getState(), 'fight', 'three left: the round goes on');
  // An out fighter can't be hit (or hit anyone).
  const hp = b.hp;
  c.y = 99999; // c falls off
  sim.Game.update(sim.FIXED_STEP);
  assert.strictEqual(c.out, 'ringout');
  assert.strictEqual(b.hp, hp);
  assert.strictEqual(sim.Game.getState(), 'fight');
  d.hp = 0;
  sim.Game.update(sim.FIXED_STEP);
  assert.strictEqual(sim.Game.getState(), 'roundEnd', 'one left: round over');
  assert.strictEqual(a.roundsWon, 1);
  assert.deepStrictEqual(plain(sim.Game.matchSummary().rounds.map((r) => [r.w, r.how])), [['p1', 'ko']]);
  // One round: that's the match.
  for (let i = 0; i < 60 * 10 && !winner; i++) sim.Game.update(sim.FIXED_STEP);
  assert.strictEqual(winner, 'p1');
  assert.strictEqual(sim.Game.matchSummary().rounds.length, 1);
});

test('free-for-all: a drawn round is played again, everyone back in at full (double) health', () => {
  const sim = createSim();
  let winner = null;
  sim.Game.startMatch(['keenan', 'artur', 'carlos'], (w) => { winner = w; }, { ffa: true, ball: 'off', balance: false });
  const [a, b, c] = sim.Game.fighters();
  fightNow(sim);
  a.hp = 0;
  sim.Game.update(sim.FIXED_STEP);
  // The last two go out on the same frame: nobody wins it.
  b.hp = 0; c.hp = 0;
  sim.Game.update(sim.FIXED_STEP);
  assert.strictEqual(sim.Game.getState(), 'roundEnd');
  assert.strictEqual(sim.Game.matchSummary().rounds[0].w, null);
  while (sim.Game.getState() !== 'countdown') sim.Game.update(sim.FIXED_STEP);
  assert.strictEqual(winner, null);
  for (const f of sim.Game.fighters()) { assert.strictEqual(f.out, false); assert.strictEqual(f.hp, f.maxHp); }
});

test('free-for-all: time up goes to whoever still in has the most health left', () => {
  const sim = createSim();
  sim.Game.startMatch(FOUR, () => {}, { ffa: true, ball: 'off', balance: false });
  const [a, b, c, d] = sim.Game.fighters();
  fightNow(sim);
  a.hp = 0; // out
  sim.Game.update(sim.FIXED_STEP);
  for (let i = 0; i < 60 * (sim.FFA_ROUND_TIME + 1) && sim.Game.getState() === 'fight'; i++) {
    b.hp = b.maxHp * 0.3; c.hp = c.maxHp * 0.6; d.hp = d.maxHp * 0.5;
    sim.Game.update(sim.FIXED_STEP);
  }
  assert.strictEqual(c.roundsWon, 1);
  assert.strictEqual(sim.Game.matchSummary().rounds[0].how, 'time');
});

test('free-for-all: three players works too, and slot names can have gaps (a player left the lobby)', () => {
  const sim = createSim();
  sim.Game.startMatch(['sam', 'sam', 'artur'], () => {}, { ffa: true, ball: 'rally', slots: ['p1', 'p3', 'p4'] });
  const fs3 = sim.Game.fighters();
  assert.deepStrictEqual(plain(fs3.map((f) => f.slot)), ['p1', 'p3', 'p4']);
  assert.strictEqual(fs3[1].paletteSwap, true, 'second Sam gets the alternate colours');
  assert.strictEqual(fs3[0].paletteSwap, false);
  assert.strictEqual(sim.Game.fighter('p3'), fs3[1]);
  assert.strictEqual(sim.Game.fighter('p2'), null);
});

test('free-for-all: every character survives a whole four-way match of button mashing, every ball mode', () => {
  const ids = createSim().CHARACTER_LIST.map((c) => c.id);
  let seed = 3;
  for (const ball of ['rally', 'bomb', 'off']) {
    for (let k = 0; k < ids.length; k += 4) {
      const sim = createSim();
      const chars = [0, 1, 2, 3].map((i) => ids[(k + i) % ids.length]);
      sim.Game.startMatch(chars, () => {}, { ffa: true, ball, stage: k % 8 ? 'orchard' : 'arena' });
      const rand = rng(seed++);
      for (let t = 0; t < 60 * 60; t++) {
        for (const s of SLOTS) for (const a of ACTIONS) sim.InputManager.setVirtual('V_' + s + '_' + a, rand() < 0.3, rand() < 0.04);
        sim.Game.update(sim.FIXED_STEP);
        for (const f of sim.Game.fighters()) {
          assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y) && Number.isFinite(f.hp), `${chars} (${ball}): ${f.slot} broke`);
        }
      }
    }
  }
});

test('free-for-all: Robert\'s grab holds the fighter he grabbed, even when someone else is nearer', () => {
  const sim = createSim();
  sim.Game.startMatch(['robert', 'sam', 'owen'], () => {}, { ffa: true, ball: 'off', balance: false });
  const [r, s, o] = sim.Game.fighters();
  fightNow(sim);
  r.x = 600; s.x = 680; o.x = 560; // Owen is as close on the other side
  r.startGrabSlam(s);
  assert.strictEqual(s.grabbedBy, 'p1');
  for (let i = 0; i < 10; i++) sim.Game.update(sim.FIXED_STEP);
  assert.strictEqual(s.state, 'grabbed', 'still held');
  assert.notStrictEqual(o.state, 'grabbed');
});

// ---- Rollback with four players ----

function player(rand, BIT) {
  let held = 0, until = 0;
  return (tick) => {
    if (tick >= until) {
      held = 0;
      if (rand() < 0.35) held |= BIT.left; else if (rand() < 0.5) held |= BIT.right;
      if (rand() < 0.15) held |= BIT.block;
      if (rand() < 0.2) held |= BIT.jumpHeld;
      until = tick + 3 + Math.floor(rand() * 20);
    }
    let b = held;
    if (rand() < 0.06) b |= BIT.attack;
    if (rand() < 0.03) b |= BIT.jump;
    if (rand() < 0.015) b |= BIT.special;
    if (rand() < 0.01) b |= BIT.ultimate;
    return b;
  };
}

// n players through a relay: every packet goes to everyone else, each link
// with its own delay, jitter and loss.
function runFfa({ seed, chars, latency, jitter, loss, ticks, ball, stage }) {
  const n = chars.length, slots = SLOTS.slice(0, n);
  const rand = rng(seed);
  const peers = chars.map(() => createSim());
  const inbox = peers.map(() => []);
  let now = 0;
  const broadcast = (from) => (msg) => {
    for (let to = 0; to < n; to++) {
      if (to === from || rand() < loss) continue;
      inbox[to].push({ at: now + latency + Math.floor(rand() * (jitter + 1)), msg: JSON.parse(JSON.stringify(msg)) });
    }
  };
  const inputs = peers.map(() => new Map());
  const players = peers.map((P, i) => player(rng(seed + 1 + i), P.Rollback.BIT));
  const opts = { ffa: true, slots, ball, stage, balance: false };
  peers.forEach((P, i) => {
    P.Game.startMatch(chars, () => {}, opts);
    P.Rollback.begin(slots[i], 1, broadcast(i), slots);
  });
  const deliver = (i) => {
    const due = inbox[i].filter((p) => p.at <= now).sort((a, b) => a.at - b.at);
    inbox[i] = inbox[i].filter((p) => p.at > now);
    due.forEach((p) => peers[i].Rollback.receive(p.msg));
  };
  for (now = 0; now < ticks; now++) {
    for (let i = 0; i < n; i++) {
      deliver(i);
      const f = peers[i].Rollback.frame();
      const bits = players[i](now);
      if (peers[i].Rollback.tick(bits)) inputs[i].set(f + 2, bits);
    }
  }
  for (let extra = 0; extra < 150; extra++, now++) {
    for (let i = 0; i < n; i++) {
      deliver(i);
      const f = peers[i].Rollback.frame();
      if (peers[i].Rollback.tick(0)) inputs[i].set(f + 2, 0);
    }
  }
  const ref = createSim();
  const target = Math.min(...peers.map((P) => P.Rollback.frame())) - 60;
  ref.Game.startMatch(chars, () => {}, opts);
  for (let f = 0; f < target; f++) {
    slots.forEach((s, i) => ref.Rollback.applyInput(s, inputs[i].get(f) || 0));
    ref.Game.update(ref.FIXED_STEP);
  }
  return {
    target,
    refHash: ref.Rollback.hashState(ref.Game.saveState()),
    peerHashes: peers.map((P) => P.Rollback.hashState(P.Rollback.stateAt(target))),
    stats: peers.map((P) => P.Rollback.stats()),
    outs: ref.Game.fighters().filter((f) => f.out).length,
    rounds: ref.Game.matchSummary().rounds.length,
  };
}

const FFA_SCENARIOS = [
  { name: 'four players, ~100 ms ping', seed: 5, chars: FOUR, latency: 3, jitter: 1, loss: 0.01, ball: 'off', stage: 'arena', minFrames: 3200 },
  { name: 'four players, orchard, rally ball, ~200 ms ping, 10% loss', seed: 6, chars: ['sam', 'nathan', 'carlos', 'artur'], latency: 5, jitter: 3, loss: 0.1, ball: 'rally', stage: 'orchard', minFrames: 2800 },
  { name: 'three players, bomb ball, mirror pair, ~370 ms ping, 10% loss', seed: 7, chars: ['ryan', 'ryan', 'keenan'], latency: 10, jitter: 5, loss: 0.1, ball: 'bomb', stage: 'orchard', minFrames: 2000 },
];

for (const sc of FFA_SCENARIOS) {
  test(`rollback keeps every player identical: ${sc.name}`, () => {
    const r = runFfa({ ...sc, ticks: 3600 });
    assert.ok(r.target > sc.minFrames, `too few frames confirmed (${r.target}); stalls: ${r.stats.map((s) => s.stalls)}`);
    r.peerHashes.forEach((h, i) => assert.strictEqual(h, r.refHash, `player ${i + 1} diverged from the reference game`));
    for (const s of r.stats) assert.strictEqual(s.desyncs, 0, 'desync repair kicked in');
  });
}
