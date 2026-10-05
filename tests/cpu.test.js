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

const FILES = ['constants.js', 'stages.js', 'input.js', 'characters.js', 'effects.js', 'fighter.js', 'game.js', 'rollback.js', 'cpu.js'];
const ACTIONS = ['left', 'right', 'block', 'guard', 'jump', 'attack', 'special', 'ultimate'];
const source = FILES.map((f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n;\n');
const PRELUDE = `
  const window = { addEventListener() {} };
  const VCONTROLS = {};
  for (const slot of ['p1', 'p2']) { VCONTROLS[slot] = {}; for (const a of ${JSON.stringify(ACTIONS)}) VCONTROLS[slot][a] = 'V_' + slot + '_' + a; }
  const Net = { controlsFor: (slot) => VCONTROLS[slot], setLocalVirtual() {} };
`;
const script = new vm.Script(PRELUDE + source + '\n({ Game, Cpu, Rollback, Stage, InputManager, Effects, CHARACTER_LIST, FIXED_STEP });', { filename: 'cpu-sim.js' });
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

// ball / balance: the match's modes (default: the game's defaults).
// kinds: a bot name, 'cpu:<level>', or 'cpu:unbeatable'.
function playMatch(kinds, chars, seed, ball, balance, stage, maxFrames = 16000) {
  const sim = createSim();
  let winner = null;
  sim.Game.startMatch(chars[0], chars[1], (w) => { winner = w; }, { ball, balance, stage });
  const brains = kinds.map((k, i) => (k === 'cpu:unbeatable' ? sim.Cpu.createSearchBrain(i ? 'p2' : 'p1')
    : k.startsWith('cpu:') ? sim.Cpu.createBrain(i ? 'p2' : 'p1', k.slice(4), seed + i)
    : BOTS[k](sim, seed + i)));
  const lastHit = [-999, -999], seq = [0, 0], selfKO = [0, 0];
  const shots = [0, 0], ballDamage = [0, 0], damage = [0, 0];
  let prev = 'countdown', prevShot = null;
  for (let f = 0; f < maxFrames && !winner; f++) {
    const w = sim.Game.world();
    const fs = [w.p1, w.p2];
    sim.Rollback.applyInput('p1', brains[0].think(w.p1, w.p2, w.projectiles, w.matchState, w.ball));
    sim.Rollback.applyInput('p2', brains[1].think(w.p2, w.p1, w.projectiles, w.matchState, w.ball));
    const hp = fs.map((F) => F.hp);
    sim.Game.update(sim.FIXED_STEP);
    fs.forEach((F, i) => { if (F.impactSeq !== seq[i]) { seq[i] = F.impactSeq; lastHit[i] = f; } });
    // Ball play: live shots taken, and damage done by the ball (the frame a
    // live ball hits, it gives the victim 20 frames of grace).
    const b = sim.Game.world().ball;
    if (b && sim.Game.getState() === 'fight') {
      const shot = b.live ? b.lastHit + b.heat : null;
      if (shot && shot !== prevShot) shots[b.lastHit === 'p1' ? 0 : 1]++;
      prevShot = shot;
      fs.forEach((F, i) => {
        const d = hp[i] - F.hp;
        if (d > 0) { damage[i] += d; if (b.grace[F.slot] === 20) ballDamage[i] += d; }
      });
    }
    const st = sim.Game.getState();
    // Fell off the stage without being hit in the last two seconds.
    if (st === 'roundEnd' && prev === 'fight') fs.forEach((F, i) => { if (F.hasFallenOff() && f - lastHit[i] > 120) selfKO[i]++; });
    prev = st;
  }
  const end = sim.Game.world();
  return { winner, selfKO, shots, ballDamage, damage, rounds: [end.p1.roundsWon, end.p2.roundsWon], hp: [end.p1.hp / end.p1.maxHp, end.p2.hp / end.p2.maxHp] };
}

// Every character, on both sides, against a rotating opponent character.
function series(a, b, ball, balance, seedBase = 100) {
  const ids = createSim().CHARACTER_LIST.map((c) => c.id);
  let wins = 0, games = 0, unfinished = 0;
  const selfKO = [0, 0];
  ids.forEach((id, i) => {
    const other = ids[(i + 1) % ids.length];
    for (const flip of [false, true]) {
      const r = flip ? playMatch([b, a], [other, id], seedBase + i, ball, balance) : playMatch([a, b], [id, other], seedBase + i, ball, balance);
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

test('Normal CPU beats random button-mashing', () => {
  const mash = series('cpu:normal', 'masher');
  assert.ok(mash.rate >= 0.75, `beat the masher only ${(mash.rate * 100).toFixed(0)}% of the time`);
});

// The rusher (walk in, punch when in range) stands in for a new player's
// fighting: Easy should be easy to beat that way, and each level should be
// harder than the last. Plain fighting (no ball, no balance mode), since the
// rusher ignores the ball and walks itself into ring-outs.
test('difficulty ramps against a simple walk-in-and-punch player (plain fighting)', () => {
  // (36 games per level -- two sets of matches with different seeds -- so one lucky or unlucky game can't swing it)
  const [easy, normal, hard] = ['easy', 'normal', 'hard'].map((l) => (series('cpu:' + l, 'rusher', 'off', false).rate + series('cpu:' + l, 'rusher', 'off', false, 200).rate) / 2);
  const pct = (r) => (r * 100).toFixed(0) + '%';
  assert.ok(easy <= 0.25, `Easy beat the rusher ${pct(easy)} of the time -- too hard`);
  // (easy/normal may still swap by a game or so)
  assert.ok(easy <= normal + 0.1 && normal < hard && easy < hard, `levels out of order: easy ${pct(easy)}, normal ${pct(normal)}, hard ${pct(hard)}`);
  assert.ok(hard >= 0.25, `Hard beat the rusher only ${pct(hard)} of the time -- too easy`);
});

test('difficulty levels are ordered: Hard beats Easy', () => {
  const r = series('cpu:hard', 'cpu:easy');
  assert.ok(r.rate >= 0.6, `Hard beat Easy only ${(r.rate * 100).toFixed(0)}% of the time`);
});

test('rally mode: CPUs really play the ball -- shots both ways, and it does real damage', () => {
  let shots = [0, 0], ballDamage = 0, damage = 0;
  for (const [i, chars] of [['ryan', 'carlos'], ['owen', 'sam'], ['nathan', 'john']].entries()) {
    const r = playMatch(['cpu:normal', 'cpu:normal'], chars, 300 + i);
    shots = shots.map((v, k) => v + r.shots[k]);
    ballDamage += r.ballDamage[0] + r.ballDamage[1];
    damage += r.damage[0] + r.damage[1];
  }
  assert.ok(shots[0] >= 6 && shots[1] >= 6, `too few live shots: ${shots}`);
  assert.ok(ballDamage / damage >= 0.1, `the ball did only ${(ballDamage / damage * 100).toFixed(0)}% of the damage`);
});


test('on the orchard (bigger floor, tree, car) the CPU still never walks itself off the edge', () => {
  const ids = createSim().CHARACTER_LIST.map((c) => c.id);
  const selfKO = [0, 0];
  ids.forEach((id, i) => {
    const r = playMatch(['cpu:normal', 'cpu:hard'], [id, ids[(i + 3) % ids.length]], 500 + i, 'off', false, 'orchard');
    selfKO[0] += r.selfKO[0]; selfKO[1] += r.selfKO[1];
  });
  assert.deepStrictEqual(selfKO, [0, 0], `self ring-outs: ${selfKO}`);
});

// ---- Unbeatable (search) ----

// Everything Effects draws right now, as a string (to see that nothing moved).
function drawn(sim) {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : (...args) => { calls.push(String(k) + args.map((a) => (typeof a === 'number' ? a.toFixed(2) : a)).join()); }),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  sim.Effects.draw(ctx);
  return calls.join(';');
}

test('Unbeatable: thinking ahead leaves the real game, the keys and the effects on screen exactly as they were', () => {
  const sim = createSim();
  sim.Game.startMatch('robert', 'owen', () => {}, { ball: 'rally', stage: 'orchard' });
  const brain = sim.Cpu.createSearchBrain('p2');
  const B = sim.Rollback.BIT;
  for (let f = 0; f < 400; f++) {
    const w = sim.Game.world();
    // The human's input for this frame goes in first (as Cpu.tick does), with a fresh press.
    sim.Rollback.applyInput('p1', B.right | (f % 20 === 0 ? B.attack : 0));
    const before = sim.Rollback.hashState(sim.Game.saveState());
    const keys = JSON.stringify(sim.InputManager.snapshot().map((set) => [...set].sort()));
    sim.Effects.spawnHitSpark(100, 100, '#fff');
    const sparks = drawn(sim);
    const bits = brain.think(w.p2, w.p1, w.projectiles, w.matchState, w.ball);
    assert.strictEqual(sim.Rollback.hashState(sim.Game.saveState()), before, `frame ${f}: the game changed while it thought`);
    assert.strictEqual(JSON.stringify(sim.InputManager.snapshot().map((set) => [...set].sort())), keys, `frame ${f}: keys changed`);
    assert.strictEqual(drawn(sim), sparks, `frame ${f}: sparks on screen aged while it thought`);
    assert.strictEqual(bits & ~Object.values(B).reduce((a, b) => a | b, 0), 0, 'only real buttons');
    sim.Rollback.applyInput('p2', bits);
    sim.Game.update(sim.FIXED_STEP);
  }
});

// A minute of fighting from the start (full matches take a while: see below).
test('Unbeatable: comes out of a minute of fighting ahead of Hard, the rusher and the masher, every time', () => {
  const pairs = [['keenan', 'robert'], ['owen', 'sam'], ['john', 'nathan'], ['artur', 'carlos'], ['ryan', 'keenan']];
  for (const opp of ['cpu:hard', 'rusher', 'masher']) {
    pairs.forEach((chars, i) => {
      const r = playMatch(['cpu:unbeatable', opp], chars, 700 + i, i % 2 ? 'rally' : 'off', i % 2 === 0, 'arena', 3600);
      const lead = r.winner === 'p1' || (!r.winner && (r.rounds[0] > r.rounds[1] || (r.rounds[0] === r.rounds[1] && r.hp[0] > r.hp[1])));
      assert.ok(lead, `${chars[0]} (Unbeatable) vs ${chars[1]} (${opp}): behind after a minute (rounds ${r.rounds}, health ${r.hp.map((h) => h.toFixed(2))})`);
    });
  }
});

// Whole matches: slow (the CPU plays thousands of frames ahead every second),
// so only on request: RUN_SLOW=1 npm test.
test('Unbeatable: wins whole matches against Hard, every character, both sides', { skip: process.env.RUN_SLOW === '1' ? false : 'slow: RUN_SLOW=1 npm test' }, () => {
  const r = series('cpu:unbeatable', 'cpu:hard', 'rally', true);
  assert.ok(r.rate >= 0.95, `won only ${(r.rate * 100).toFixed(0)}%`);
  assert.strictEqual(r.selfKO[0], 0);
});
