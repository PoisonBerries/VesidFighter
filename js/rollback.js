// Rollback netcode for direct (peer-to-peer) matches, the way fighting games
// do it (GGPO-style). Both players run the full simulation. Your own inputs
// apply right away (after a tiny fixed delay), so your fighter responds
// like couch play. The opponent's input for frames you haven't heard about
// yet is *predicted* (same buttons held as last time, no new presses); when
// the real input arrives and the guess was wrong, the game rewinds to that
// frame and re-simulates up to now with the right input.
//
// This relies on the simulation being deterministic: same state + same
// inputs = same result on both machines (tests/sim.test.js checks that).
// As a safety net the players compare a hash of the confirmed state once a
// second, and player 1 sends its state to repair any mismatch.
//
// Transport-agnostic: net.js hands packets in via receive() and sends what
// this module gives its send callback (plain JSON objects).

const Rollback = (() => {
  const INPUT_DELAY = 2;   // frames between pressing a button and it applying (hides most rollbacks)
  const MAX_AHEAD = 20;    // frames we may simulate past the opponent's last known input (the
                           // relay is TCP: inputs arrive late in bursts; freezing until they
                           // land stutters your own fighter, a longer rollback doesn't)
  const HISTORY = 180;     // frames of saved states/inputs kept (for rollbacks and desync repair)
  const ADV_SMOOTH = 0.03; // how fast the clock-gap estimate follows new samples
  const ADV_WAIT = 2;      // pause a frame once we're this far ahead (smoothed)
  const MAX_PACKET = 120;  // max frames of our input per packet
  const SYNC_EVERY = 60;   // frames between desync checks

  // Input bits. Jump and special are also *held* (hover, charged shot).
  const BIT = { left: 1, right: 2, block: 4, jumpHeld: 8, specialHeld: 16, jump: 32, attack: 64, special: 128, ultimate: 256 };
  const PRESS_BITS = BIT.jump | BIT.attack | BIT.special | BIT.ultimate;

  // Same virtual key names net.js hands the fighters (Net.controlsFor).
  const vkey = (slot, action) => 'V_' + slot + '_' + action;

  let active = false;
  let localSlot = 'p1', remoteSlot = 'p2';
  let matchId = 0;
  let send = null;

  let frame = 0;             // next frame to simulate
  let localIn = new Map();   // frame -> bits
  let remoteIn = new Map();  // frame -> bits (confirmed)
  let usedRemote = new Map(); // frame -> bits the simulation actually used (maybe a guess)
  let states = new Map();    // frame -> state at the *start* of that frame
  let remoteConfirmed = -1;  // every remote input up to here is known
  let localAcked = -1;       // the opponent has every local input up to here
  let rollbackFrom = Infinity;
  let remoteFrame = 0, remoteAdvantage = 0; // for keeping both clocks in step
  let lastWaitFrame = -Infinity;
  let advDiff = 0; // smoothed (our advantage - theirs): packet jitter makes each sample noisy
  let nextSync = SYNC_EVERY;
  let myHashes = new Map(), theirHashes = new Map();
  let early = []; // packets for a match that hasn't started here yet
  const stats = { rollbacks: 0, rolledFrames: 0, stalls: 0, waits: 0, desyncs: 0, syncChecks: 0 };

  function applyInput(slot, b) {
    const set = (a, down, pressed) => InputManager.setVirtual(vkey(slot, a), down, pressed);
    set('left', !!(b & BIT.left), false);
    set('right', !!(b & BIT.right), false);
    set('block', !!(b & BIT.block), false);
    set('jump', !!(b & BIT.jumpHeld), !!(b & BIT.jump));
    set('attack', false, !!(b & BIT.attack));
    set('special', !!(b & BIT.specialHeld), !!(b & BIT.special));
    set('ultimate', false, !!(b & BIT.ultimate));
  }

  // The opponent's input for a frame: the real one if we have it, otherwise
  // a guess -- whatever they were holding last, with no new presses.
  function remoteFor(f) {
    if (remoteIn.has(f)) return remoteIn.get(f);
    const last = remoteIn.get(remoteConfirmed);
    return last === undefined ? 0 : last & ~PRESS_BITS;
  }

  function step(f) {
    states.set(f, Game.saveState());
    const r = remoteFor(f);
    usedRemote.set(f, r);
    applyInput(localSlot, localIn.has(f) ? localIn.get(f) : 0);
    applyInput(remoteSlot, r);
    Game.update(FIXED_STEP);
  }

  function resimulate(from) {
    if (!states.has(from)) return; // too old to repair (shouldn't happen within MAX_AHEAD)
    stats.rollbacks++;
    stats.rolledFrames += frame - from;
    Game.loadState(states.get(from));
    Effects.setSuppressed(true);
    try {
      for (let f = from; f < frame; f++) step(f);
    } finally {
      Effects.setSuppressed(false);
    }
  }

  function begin(slot, id, sendFn) {
    active = true;
    localSlot = slot;
    remoteSlot = slot === 'p1' ? 'p2' : 'p1';
    matchId = id;
    send = sendFn;
    frame = 0;
    localIn = new Map(); remoteIn = new Map(); usedRemote = new Map(); states = new Map();
    myHashes = new Map(); theirHashes = new Map();
    remoteConfirmed = -1; localAcked = -1; rollbackFrom = Infinity;
    remoteFrame = 0; remoteAdvantage = 0; lastWaitFrame = -Infinity; advDiff = 0;
    nextSync = SYNC_EVERY;
    // Both sides agree the first INPUT_DELAY frames are empty.
    for (let f = 0; f < INPUT_DELAY; f++) { localIn.set(f, 0); remoteIn.set(f, 0); }
    remoteConfirmed = INPUT_DELAY - 1;
    const pending = early.filter((p) => p.m === id);
    early = [];
    pending.forEach(receive);
  }

  function end() {
    active = false;
    early = [];
  }

  function sendInputs() {
    const last = frame + INPUT_DELAY - 1; // newest local input we have
    // Everything the opponent hasn't confirmed yet, every time: packets can be
    // dropped, and a gap would stall the game until it's filled.
    const from = Math.max(localAcked + 1, 0);
    const i = [];
    for (let f = from; f <= last && i.length < MAX_PACKET; f++) i.push(localIn.get(f) || 0);
    send({ t: 'ri', m: matchId, f: from, i, a: remoteConfirmed, cf: frame, adv: frame - remoteFrame });
  }

  function receive(msg) {
    if (!msg || msg.m === undefined) return;
    if (!active || msg.m !== matchId) {
      if (msg.m > matchId || !active) { early.push(msg); if (early.length > 120) early.shift(); }
      return;
    }
    if (msg.t === 'ri') {
      for (let k = 0; k < msg.i.length; k++) {
        const f = msg.f + k;
        if (remoteIn.has(f) || f < frame - HISTORY) continue;
        const v = msg.i[k] | 0;
        remoteIn.set(f, v);
        if (f < frame && usedRemote.get(f) !== v) rollbackFrom = Math.min(rollbackFrom, f);
      }
      while (remoteIn.has(remoteConfirmed + 1)) remoteConfirmed++;
      if (typeof msg.a === 'number') localAcked = Math.max(localAcked, msg.a);
      if (typeof msg.cf === 'number' && msg.cf >= remoteFrame) { remoteFrame = msg.cf; remoteAdvantage = msg.adv || 0; }
      // A guessed frame may now need redoing even if nothing arrived for it
      // directly: its guess was based on an older "last held" input.
      for (let f = Math.max(0, frame - MAX_AHEAD - 1); f < frame; f++) {
        if (f > remoteConfirmed && usedRemote.has(f) && usedRemote.get(f) !== remoteFor(f)) { rollbackFrom = Math.min(rollbackFrom, f); break; }
      }
    } else if (msg.t === 'rh') {
      theirHashes.set(msg.f, msg.h);
      compareHash(msg.f);
    } else if (msg.t === 'rs' && localSlot === 'p2' && msg.s && msg.f < frame && msg.f >= frame - HISTORY) {
      // Player 1's copy of a confirmed frame: take it and replay from there.
      states.set(msg.f, msg.s);
      myHashes.set(msg.f, theirHashes.get(msg.f));
      rollbackFrom = Math.min(rollbackFrom, msg.f);
    }
  }

  // Key order can differ between the two machines (a rollback restores a
  // fighter's fields in a different order), so sort keys before hashing.
  function canonical(v) {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = canonical(v[k]);
      return o;
    }
    return v;
  }

  function hashState(s) {
    const str = JSON.stringify(canonical(s));
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function compareHash(f) {
    if (!myHashes.has(f) || !theirHashes.has(f)) return;
    if (myHashes.get(f) === theirHashes.get(f)) { stats.syncChecks++; return; }
    stats.desyncs++;
    console.warn('[rollback] desync at frame', f, localSlot === 'p1' ? '-- sending our state' : '-- waiting for player 1\'s state');
    if (localSlot === 'p1' && states.has(f)) send({ t: 'rs', m: matchId, f, s: states.get(f) });
  }

  // Once every input before a checkpoint is confirmed, its state is final on
  // both machines: hash it and compare.
  function checkSync() {
    while (nextSync < frame && remoteConfirmed >= nextSync - 1 && rollbackFrom > nextSync) {
      if (states.has(nextSync)) {
        const h = hashState(states.get(nextSync));
        myHashes.set(nextSync, h);
        send({ t: 'rh', m: matchId, f: nextSync, h });
        compareHash(nextSync);
      }
      nextSync += SYNC_EVERY;
    }
  }

  function prune() {
    const old = frame - HISTORY;
    for (const m of [localIn, remoteIn, usedRemote, states, myHashes, theirHashes]) {
      for (const k of m.keys()) { if (k < old) m.delete(k); else break; }
    }
  }

  // One fixed tick. `localBits` is this tick's local input (see inputBits).
  // Returns whether the game advanced a frame.
  function tick(localBits) {
    if (!active) return false;

    if (rollbackFrom < frame) {
      const from = rollbackFrom;
      rollbackFrom = Infinity;
      resimulate(from);
    }
    rollbackFrom = Infinity;

    // Too far ahead of what we know about the opponent: wait for them.
    if (frame - remoteConfirmed > MAX_AHEAD) {
      stats.stalls++;
      sendInputs();
      return false;
    }
    // Keep both clocks in step: if we're consistently ahead of the opponent
    // (they started later, or their machine runs slower), pause one frame now
    // and then so neither side has to rollback much more than the other.
    advDiff += (frame - remoteFrame - remoteAdvantage - advDiff) * ADV_SMOOTH;
    // The further ahead, the more often: a machine that can't hold 60 fps
    // would otherwise let the faster one run a full rollback window ahead, and
    // then every packet it gets rewinds that whole window (it sees the
    // opponent jerk about and stall while the slow side looks fine).
    const waitEvery = Math.max(2, Math.min(30, Math.round(24 / Math.max(1, advDiff))));
    if (advDiff > ADV_WAIT && frame - lastWaitFrame > waitEvery) {
      lastWaitFrame = frame;
      advDiff -= 2; // waiting a frame closes the gap by ~2 (we fall 1 behind, they gain 1)
      stats.waits++;
      sendInputs();
      return false;
    }

    localIn.set(frame + INPUT_DELAY, localBits | 0);
    sendInputs();
    step(frame);
    frame++;
    checkSync();
    prune();
    return true;
  }

  // Current keyboard state as input bits. Either key set drives your fighter.
  function inputBits() {
    const any = (action, fn) => InputManager[fn](CONTROLS.p1[action]) || InputManager[fn](CONTROLS.p2[action]);
    let b = 0;
    if (any('left', 'isDown')) b |= BIT.left;
    if (any('right', 'isDown')) b |= BIT.right;
    if (any('block', 'isDown')) b |= BIT.block;
    if (any('jump', 'isDown')) b |= BIT.jumpHeld;
    if (any('special', 'isDown')) b |= BIT.specialHeld;
    if (any('jump', 'isPressed')) b |= BIT.jump;
    if (any('attack', 'isPressed')) b |= BIT.attack;
    if (any('special', 'isPressed')) b |= BIT.special;
    if (any('ultimate', 'isPressed')) b |= BIT.ultimate;
    return b;
  }

  return {
    begin, end, tick, receive, inputBits, applyInput,
    isActive: () => active,
    frame: () => frame,
    stats: () => Object.assign({ frame, remoteConfirmed }, stats),
    stateAt: (f) => states.get(f), // for tests and debugging
    hashState,
    BIT,
  };
})();
