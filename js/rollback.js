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
//
// Works for more than two players too (online free-for-all): every packet
// goes to everyone (the relay server broadcasts it) and carries its sender's
// slot; each remote player's inputs are tracked and predicted separately,
// and the game only waits on the one we've heard least from.

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
  const BIT = { left: 1, right: 2, block: 4, jumpHeld: 8, specialHeld: 16, jump: 32, attack: 64, special: 128, ultimate: 256, guard: 512 };
  const PRESS_BITS = BIT.jump | BIT.attack | BIT.special | BIT.ultimate;

  // Same virtual key names net.js hands the fighters (Net.controlsFor).
  const vkey = (slot, action) => 'V_' + slot + '_' + action;

  let active = false;
  let localSlot = 'p1';
  let remotes = ['p2'];      // everyone else's slots
  let matchId = 0;
  let send = null;

  // Per remote player (keyed by slot):
  let remoteIn = {};          // frame -> bits (confirmed)
  let usedRemote = {};        // frame -> bits the simulation actually used (maybe a guess)
  let confirmed = {};         // every input of theirs up to here is known
  let ackedBy = {};           // they have every local input up to here
  let remoteFrame = {}, remoteAdvantage = {}; // for keeping the clocks in step
  let theirHashes = {};       // frame -> their state hash

  let frame = 0;             // next frame to simulate
  let localIn = new Map();   // frame -> bits
  let states = new Map();    // frame -> state at the *start* of that frame
  let rollbackFrom = Infinity;
  let lastWaitFrame = -Infinity;
  let advDiff = 0; // smoothed (our advantage - theirs): packet jitter makes each sample noisy
  let nextSync = SYNC_EVERY;
  let myHashes = new Map();
  let early = []; // packets for a match that hasn't started here yet
  const stats = { rollbacks: 0, rolledFrames: 0, stalls: 0, waits: 0, desyncs: 0, syncChecks: 0 };

  const minOf = (obj) => Math.min(...remotes.map((r) => obj[r]));
  const remoteConfirmed = () => minOf(confirmed); // every remote input up to here is known
  const localAcked = () => minOf(ackedBy);        // every remote player has our inputs up to here

  function applyInput(slot, b) {
    const set = (a, down, pressed) => InputManager.setVirtual(vkey(slot, a), down, pressed);
    set('left', !!(b & BIT.left), false);
    set('right', !!(b & BIT.right), false);
    set('block', !!(b & BIT.block), false);
    set('guard', !!(b & BIT.guard), false);
    set('jump', !!(b & BIT.jumpHeld), !!(b & BIT.jump));
    set('attack', false, !!(b & BIT.attack));
    set('special', !!(b & BIT.specialHeld), !!(b & BIT.special));
    set('ultimate', false, !!(b & BIT.ultimate));
  }

  // The opponent's input for a frame: the real one if we have it, otherwise
  // a guess -- whatever they were holding last, with no new presses.
  function remoteFor(r, f) {
    if (remoteIn[r].has(f)) return remoteIn[r].get(f);
    const last = remoteIn[r].get(confirmed[r]);
    return last === undefined ? 0 : last & ~PRESS_BITS;
  }

  function step(f) {
    states.set(f, Game.saveState());
    applyInput(localSlot, localIn.has(f) ? localIn.get(f) : 0);
    for (const r of remotes) {
      const bits = remoteFor(r, f);
      usedRemote[r].set(f, bits);
      applyInput(r, bits);
    }
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

  // slots: everyone in the match (default the usual two).
  function begin(slot, id, sendFn, slots) {
    active = true;
    localSlot = slot;
    remotes = (slots || ['p1', 'p2']).filter((s) => s !== slot);
    matchId = id;
    send = sendFn;
    frame = 0;
    localIn = new Map(); states = new Map(); myHashes = new Map();
    remoteIn = {}; usedRemote = {}; confirmed = {}; ackedBy = {}; remoteFrame = {}; remoteAdvantage = {}; theirHashes = {};
    for (const r of remotes) {
      remoteIn[r] = new Map(); usedRemote[r] = new Map(); theirHashes[r] = new Map();
      ackedBy[r] = -1; remoteFrame[r] = 0; remoteAdvantage[r] = 0;
    }
    rollbackFrom = Infinity;
    lastWaitFrame = -Infinity; advDiff = 0;
    nextSync = SYNC_EVERY;
    // Everyone agrees the first INPUT_DELAY frames are empty.
    for (let f = 0; f < INPUT_DELAY; f++) {
      localIn.set(f, 0);
      for (const r of remotes) remoteIn[r].set(f, 0);
    }
    for (const r of remotes) confirmed[r] = INPUT_DELAY - 1;
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
    // Everything someone hasn't confirmed yet, every time: packets can be
    // dropped, and a gap would stall the game until it's filled.
    const from = Math.max(localAcked() + 1, 0);
    const i = [];
    for (let f = from; f <= last && i.length < MAX_PACKET; f++) i.push(localIn.get(f) || 0);
    // a: how far we've confirmed each player; adv: how far ahead of each we are.
    const a = {}, adv = {};
    for (const r of remotes) { a[r] = confirmed[r]; adv[r] = frame - remoteFrame[r]; }
    send({ t: 'ri', s: localSlot, m: matchId, f: from, i, a, cf: frame, adv });
  }

  // Which remote player a packet came from. (Two-player packets from older
  // clients don't say: it's the only one.)
  function senderOf(msg) {
    if (msg.s) return remotes.includes(msg.s) ? msg.s : null;
    return remotes.length === 1 ? remotes[0] : null;
  }
  // Older clients send plain numbers where newer ones send per-slot maps.
  const forMe = (v) => (v && typeof v === 'object' ? v[localSlot] : v);

  function receive(msg) {
    if (!msg || msg.m === undefined) return;
    if (!active || msg.m !== matchId) {
      if (msg.m > matchId || !active) { early.push(msg); if (early.length > 120) early.shift(); }
      return;
    }
    const r = senderOf(msg);
    if (!r) return;
    if (msg.t === 'ri') {
      const ins = remoteIn[r], used = usedRemote[r];
      for (let k = 0; k < msg.i.length; k++) {
        const f = msg.f + k;
        if (ins.has(f) || f < frame - HISTORY) continue;
        const v = msg.i[k] | 0;
        ins.set(f, v);
        if (f < frame && used.get(f) !== v) rollbackFrom = Math.min(rollbackFrom, f);
      }
      while (ins.has(confirmed[r] + 1)) confirmed[r]++;
      const ack = forMe(msg.a);
      if (typeof ack === 'number') ackedBy[r] = Math.max(ackedBy[r], ack);
      if (typeof msg.cf === 'number' && msg.cf >= remoteFrame[r]) { remoteFrame[r] = msg.cf; remoteAdvantage[r] = forMe(msg.adv) || 0; }
      // A guessed frame may now need redoing even if nothing arrived for it
      // directly: its guess was based on an older "last held" input.
      for (let f = Math.max(0, frame - MAX_AHEAD - 1); f < frame; f++) {
        if (f > confirmed[r] && used.has(f) && used.get(f) !== remoteFor(r, f)) { rollbackFrom = Math.min(rollbackFrom, f); break; }
      }
    } else if (msg.t === 'rh') {
      theirHashes[r].set(msg.f, msg.h);
      compareHash(msg.f, r);
    } else if (msg.t === 'rs' && localSlot !== 'p1' && r === 'p1' && msg.st && msg.f < frame && msg.f >= frame - HISTORY) {
      // Player 1's copy of a confirmed frame: take it and replay from there.
      states.set(msg.f, msg.st);
      myHashes.set(msg.f, theirHashes[r].get(msg.f));
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

  // Player 1 is the reference: it checks everyone's hash against its own,
  // and the others check theirs against player 1's.
  function compareHash(f, r) {
    if (localSlot !== 'p1' && r !== 'p1') return;
    if (!myHashes.has(f) || !theirHashes[r].has(f)) return;
    if (myHashes.get(f) === theirHashes[r].get(f)) { stats.syncChecks++; return; }
    stats.desyncs++;
    console.warn('[rollback] desync with', r, 'at frame', f, localSlot === 'p1' ? '-- sending our state' : '-- waiting for player 1\'s state');
    if (localSlot === 'p1' && states.has(f)) send({ t: 'rs', s: localSlot, m: matchId, f, st: states.get(f) });
  }

  // Once every input before a checkpoint is confirmed, its state is final on
  // both machines: hash it and compare.
  function checkSync() {
    while (nextSync < frame && remoteConfirmed() >= nextSync - 1 && rollbackFrom > nextSync) {
      if (states.has(nextSync)) {
        const h = hashState(states.get(nextSync));
        myHashes.set(nextSync, h);
        send({ t: 'rh', s: localSlot, m: matchId, f: nextSync, h });
        for (const r of remotes) compareHash(nextSync, r);
      }
      nextSync += SYNC_EVERY;
    }
  }

  function prune() {
    const old = frame - HISTORY;
    const maps = [localIn, states, myHashes];
    for (const r of remotes) maps.push(remoteIn[r], usedRemote[r], theirHashes[r]);
    for (const m of maps) {
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

    // Too far ahead of what we know about someone: wait for them.
    if (frame - remoteConfirmed() > MAX_AHEAD) {
      stats.stalls++;
      sendInputs();
      return false;
    }
    // Keep both clocks in step: if we're consistently ahead of the opponent
    // (they started later, or their machine runs slower), pause one frame now
    // and then so neither side has to rollback much more than the other.
    // (With several opponents, keep in step with the one furthest behind.)
    const gap = Math.max(...remotes.map((r) => frame - remoteFrame[r] - remoteAdvantage[r]));
    advDiff += (gap - advDiff) * ADV_SMOOTH;
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

  // Current keyboard state as input bits (the one-player keys, CONTROLS.solo).
  function inputBits() {
    const any = (action, fn) => InputManager[fn](CONTROLS.solo[action]) || (!!SOLO_ALT_KEYS[action] && InputManager[fn](SOLO_ALT_KEYS[action]));
    let b = 0;
    if (any('left', 'isDown')) b |= BIT.left;
    if (any('right', 'isDown')) b |= BIT.right;
    if (any('block', 'isDown')) b |= BIT.block;
    if (any('guard', 'isDown')) b |= BIT.guard;
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
    stats: () => Object.assign({ frame, remoteConfirmed: remoteConfirmed() }, stats),
    stateAt: (f) => states.get(f), // for tests and debugging
    hashState,
    BIT,
  };
})();
