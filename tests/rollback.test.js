// Rollback netcode (js/rollback.js): two independent copies of the game talk
// over a simulated bad network (delay, jitter, loss, reordering), mashing
// random buttons. Both must end up in exactly the state a single local game
// reaches with the same inputs, without the desync repair ever kicking in.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT } = require('./helpers');

const FILES = ['constants.js', 'input.js', 'characters.js', 'effects.js', 'fighter.js', 'game.js', 'rollback.js'];
const ACTIONS = ['left', 'right', 'block', 'jump', 'attack', 'special', 'ultimate'];
const source = FILES.map((f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n;\n');
const PRELUDE = `
  const window = { addEventListener() {} };
  const VCONTROLS = {};
  for (const slot of ['p1', 'p2']) { VCONTROLS[slot] = {}; for (const a of ${JSON.stringify(ACTIONS)}) VCONTROLS[slot][a] = 'V_' + slot + '_' + a; }
  const Net = { controlsFor: (slot) => VCONTROLS[slot] };
`;
const script = new vm.Script(PRELUDE + source + '\n({ Game, Rollback, InputManager, FIXED_STEP });', { filename: 'rollback-sim.js' });
const createSim = () => script.runInContext(vm.createContext({ console: { warn() {}, log() {} }, Math, JSON, performance: { now: () => 0 } }));

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Button mashing that changes every few frames, like a real player.
function player(rand, BIT) {
  let held = 0, until = 0;
  return (tick) => {
    if (tick >= until) {
      held = 0;
      if (rand() < 0.35) held |= BIT.left; else if (rand() < 0.5) held |= BIT.right;
      if (rand() < 0.15) held |= BIT.block;
      if (rand() < 0.2) held |= BIT.jumpHeld;
      if (rand() < 0.1) held |= BIT.specialHeld;
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

function runMatch({ seed, chars, latency, jitter, loss, startGap, ticks, hiccups = 0, hiccupLen = 0, p2Drops = 0.02 }) {
  const rand = rng(seed);
  // TCP-style hiccups (the WebSocket relay): now and then a link holds every
  // packet for a while, then delivers them all at once, in order.
  const heldUntil = [0, 0];
  const peers = [createSim(), createSim()];
  const inbox = [[], []]; // packets in flight to peer i: { at, msg }
  let now = 0;
  const sender = (to) => (msg) => {
    if (hiccups && now >= heldUntil[to] && rand() < hiccups) heldUntil[to] = now + hiccupLen;
    if (rand() < loss) return;
    const at = Math.max(now + latency + Math.floor(rand() * (jitter + 1)), heldUntil[to] + latency);
    inbox[to].push({ at, msg: JSON.parse(JSON.stringify(msg)) });
  };
  const inputs = [new Map(), new Map()]; // frame -> bits, as each side recorded them
  const players = [player(rng(seed + 1), peers[0].Rollback.BIT), player(rng(seed + 2), peers[1].Rollback.BIT)];
  const started = [false, false];

  for (now = 0; now < ticks; now++) {
    for (let i = 0; i < 2; i++) {
      const P = peers[i];
      if (!started[i] && now >= (i === 1 ? startGap : 0)) {
        P.Game.startMatch(chars[0], chars[1], () => {});
        P.Rollback.begin(i === 0 ? 'p1' : 'p2', 1, sender(1 - i));
        started[i] = true;
      }
      // Deliver whatever has arrived (in arrival order, so reordered by jitter).
      const due = inbox[i].filter((p) => p.at <= now).sort((a, b) => a.at - b.at);
      inbox[i] = inbox[i].filter((p) => p.at > now);
      due.forEach((p) => P.Rollback.receive(p.msg));
      if (!started[i]) continue;
      if (i === 1 && rand() < p2Drops) continue; // player 2's machine drops a frame now and then
      const f = P.Rollback.frame();
      const bits = players[i](now);
      if (P.Rollback.tick(bits)) inputs[i].set(f + 2, bits);
    }
  }
  // Let the network drain so the last frames confirm (no new presses).
  for (let extra = 0; extra < 120; extra++, now++) {
    for (let i = 0; i < 2; i++) {
      const P = peers[i];
      const due = inbox[i].filter((p) => p.at <= now).sort((a, b) => a.at - b.at);
      inbox[i] = inbox[i].filter((p) => p.at > now);
      due.forEach((p) => P.Rollback.receive(p.msg));
      const f = P.Rollback.frame();
      if (P.Rollback.tick(0)) inputs[i].set(f + 2, 0);
    }
  }

  // Reference: one plain local game fed the same inputs frame by frame.
  const ref = createSim();
  const target = Math.min(peers[0].Rollback.frame(), peers[1].Rollback.frame()) - 60;
  ref.Game.startMatch(chars[0], chars[1], () => {});
  const apply = (sim, slot, b) => {
    const B = sim.Rollback.BIT, set = (a, d, p) => sim.InputManager.setVirtual('V_' + slot + '_' + a, d, p);
    set('left', !!(b & B.left), false); set('right', !!(b & B.right), false); set('block', !!(b & B.block), false);
    set('jump', !!(b & B.jumpHeld), !!(b & B.jump)); set('attack', false, !!(b & B.attack));
    set('special', !!(b & B.specialHeld), !!(b & B.special)); set('ultimate', false, !!(b & B.ultimate));
  };
  for (let f = 0; f < target; f++) {
    apply(ref, 'p1', inputs[0].get(f) || 0);
    apply(ref, 'p2', inputs[1].get(f) || 0);
    ref.Game.update(ref.FIXED_STEP);
  }
  const hash = (sim, s) => sim.Rollback.hashState(s);
  return {
    target,
    refHash: hash(ref, ref.Game.saveState()),
    peerHashes: peers.map((P) => hash(P, P.Rollback.stateAt(target))),
    stats: peers.map((P) => P.Rollback.stats()),
    state: ref.Game.getState(),
  };
}

// latency/jitter are one-way, in 60 fps frames (1 frame = 16.7 ms).
const SCENARIOS = [
  { name: 'good connection (~100 ms ping)', latency: 3, jitter: 1, loss: 0.01, startGap: 2, seed: 11, chars: ['keenan', 'artur'], minFrames: 3300 },
  { name: 'bad connection (~200 ms ping, jitter, 10% loss)', latency: 5, jitter: 3, loss: 0.1, startGap: 8, seed: 22, chars: ['owen', 'robert'], minFrames: 3000 },
  // Found a real bug: a rollback across the end of a match used to leave the game stuck on the match-over screen.
  { name: 'rollback across the end of a match (~370 ms ping, 10% loss)', latency: 10, jitter: 5, loss: 0.1, startGap: 8, seed: 22, chars: ['owen', 'robert'], minFrames: 2000 },
  { name: 'mirror match, awful connection (~370 ms ping, 20% loss)', latency: 10, jitter: 5, loss: 0.2, startGap: 12, seed: 33, chars: ['sam', 'sam'], minFrames: 2000 },
];

for (const sc of SCENARIOS) {
  test(`rollback keeps both players identical: ${sc.name}`, () => {
    const r = runMatch({ ...sc, ticks: 3600 });
    assert.ok(r.target > sc.minFrames, `too few frames confirmed (${r.target}); stalls: ${r.stats.map((s) => s.stalls)}`);
    assert.strictEqual(r.peerHashes[0], r.refHash, 'player 1 diverged from the reference game');
    assert.strictEqual(r.peerHashes[1], r.refHash, 'player 2 diverged from the reference game');
    for (const s of r.stats) {
      assert.strictEqual(s.desyncs, 0, 'desync repair was needed');
      assert.ok(s.syncChecks > 20, `too few desync checks ran (${s.syncChecks})`);
    }
    assert.ok(r.stats[0].rollbacks + r.stats[1].rollbacks > 0, 'expected some rollbacks on a lagged connection');
  });
}

// The relay is a WebSocket (TCP): packets don't drop, they arrive late in
// bursts. A burst shorter than the rollback window must not freeze the game
// (your own fighter would stutter), and the clock sync must not pause often.
test('rollback rides out TCP-style hiccups without freezing', () => {
  const r = runMatch({ latency: 4, jitter: 1, loss: 0, startGap: 2, seed: 44, chars: ['keenan', 'owen'], ticks: 3600, hiccups: 0.004, hiccupLen: 12, p2Drops: 0 });
  assert.strictEqual(r.peerHashes[0], r.refHash, 'player 1 diverged from the reference game');
  assert.strictEqual(r.peerHashes[1], r.refHash, 'player 2 diverged from the reference game');
  for (const s of r.stats) {
    assert.ok(s.stalls < 10, `froze for ${s.stalls} ticks waiting on the opponent`);
    assert.ok(s.waits < 15, `clock sync paused ${s.waits} times`);
  }
});

// Every character (all the new states: grabs, charged jumps, whirlwinds...)
// must stay deterministic through rollbacks, or one player sees the game snap.
const ALL = ['keenan', 'artur', 'carlos', 'nathan', 'owen', 'robert', 'ryan', 'sam', 'john'];
for (let i = 0; i < ALL.length; i++) {
  test(`rollback stays in sync for ${ALL[i]} vs ${ALL[(i + 4) % ALL.length]}`, () => {
    const r = runMatch({ latency: 4, jitter: 2, loss: 0.03, startGap: 3, seed: 100 + i, chars: [ALL[i], ALL[(i + 4) % ALL.length]], ticks: 3000 });
    assert.strictEqual(r.peerHashes[0], r.refHash, 'player 1 diverged from the reference game');
    assert.strictEqual(r.peerHashes[1], r.refHash, 'player 2 diverged from the reference game');
    for (const s of r.stats) assert.strictEqual(s.desyncs, 0, 'desync repair was needed');
  });
}


// One machine that can't hold 60 fps (heavy graphics, slow laptop, background
// tab) must slow the other one down to match. Otherwise the fast player runs a
// whole rollback window ahead: every packet rewinds ~20 frames, so they see the
// opponent jerk and stall while the slow player's game looks perfectly smooth.
test('a slower opponent machine does not make the faster player stall and rewind constantly', () => {
  const r = runMatch({ latency: 4, jitter: 1, loss: 0, startGap: 2, seed: 7, chars: ['keenan', 'owen'], ticks: 3600, p2Drops: 0.15 });
  assert.strictEqual(r.peerHashes[0], r.refHash);
  assert.strictEqual(r.peerHashes[1], r.refHash);
  const [fast] = r.stats;
  assert.ok(fast.stalls < 20, `the fast player froze ${fast.stalls} times waiting`);
  assert.ok(fast.rolledFrames / Math.max(1, fast.rollbacks) < 12, `rewinds ${(fast.rolledFrames / fast.rollbacks).toFixed(1)} frames per correction on average`);
});
