// Dedicated game server. Runs the exact same simulation files the browser
// uses (js/*.js) headlessly -- one isolated copy per room -- so neither
// player is the "host": both stream inputs here and both render the
// snapshots that come back.
//
// Snapshots are deltas (only fields that changed since the last send) and
// the socket uses permessage-deflate, which keeps bandwidth low enough for
// small free-tier data caps.
//
// Usage: PORT=8080 node server/server.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const FIXED_STEP_MS = 1000 / 60;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RELAYED = new Set(['ri', 'rh', 'rs', 'start', 'pick', 'select']);
const SIM_FILES = ['constants.js', 'input.js', 'characters.js', 'effects.js', 'fighter.js', 'game.js'];
const HELD = ['left', 'right', 'block'];
const TAPS = ['jump', 'attack', 'special', 'ultimate'];

const simSource = SIM_FILES
  .map(f => fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'))
  .join('\n;\n');

// Browser bits the sim files touch at load time, stubbed out. Net here just
// points the fighters at virtual keys we drive from socket input.
const SIM_PRELUDE = `
  const window = { addEventListener() {} };
  const VCONTROLS = {};
  for (const slot of ['p1', 'p2']) {
    VCONTROLS[slot] = {};
    for (const a of ${JSON.stringify(HELD.concat(TAPS))}) VCONTROLS[slot][a] = 'V_' + slot + '_' + a;
  }
  const Net = { controlsFor: (slot) => VCONTROLS[slot] };
`;
const SIM_EXPORTS = `
  ({ Game, InputManager, Effects, CHARACTERS, VCONTROLS });
`;
const simScript = new vm.Script(SIM_PRELUDE + simSource + SIM_EXPORTS, { filename: 'sim.js' });

function createSim() {
  const context = vm.createContext({ console, Math, JSON, performance: { now: () => performance.now() } });
  const sim = simScript.runInContext(context);
  sim.Effects.setRecording(true);
  return sim;
}

// ---- Rooms ----
const rooms = new Map(); // code -> room

function randomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  } while (rooms.has(code));
  return code;
}

function newInputState() {
  return { held: [false, false, false], specialHeld: false, jumpHeld: false, counts: [0, 0, 0, 0], consumed: [0, 0, 0, 0] };
}

// Relay rooms (current clients): both players run the game themselves with
// rollback netcode (js/rollback.js) and the server only passes messages
// between them. Sim rooms (older clients): the server runs the game.
function createRoom(relay) {
  const code = randomCode();
  const room = {
    code,
    relay,
    players: { p1: null, p2: null },
    inputs: { p1: newInputState(), p2: newInputState() },
    sim: relay ? null : createSim(),
    lastSent: null,
    running: false,
  };
  rooms.set(code, room);
  return room;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const ws of Object.values(room.players)) {
    if (ws && ws.readyState === ws.OPEN) ws.send(data);
  }
}

function other(slot) { return slot === 'p1' ? 'p2' : 'p1'; }

function closeRoom(room) {
  room.running = false;
  rooms.delete(room.code);
}

// ---- Delta snapshots ----
// Round floats in the *sent copy* only (never the live sim) to shrink JSON.
function roundVal(v) {
  if (typeof v === 'number' && !Number.isInteger(v)) return Math.round(v * 100) / 100;
  return v;
}

function roundDeep(v) {
  if (Array.isArray(v)) return v.map(roundDeep);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = roundDeep(v[k]);
    return o;
  }
  return roundVal(v);
}

function sameVal(a, b) {
  if (a === b) return true;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function diffObj(prev, next) {
  const d = {};
  let any = false;
  for (const k of Object.keys(next)) {
    if (!prev || !sameVal(prev[k], next[k])) { d[k] = next[k]; any = true; }
  }
  return any ? d : null;
}

function buildDelta(room) {
  const full = roundDeep(room.sim.Game.getSnapshot());
  const prev = room.lastSent;
  room.lastSent = full;
  if (!full.f) return null;

  const out = { t: 's' };
  let any = false;
  for (const k of ['m', 'st', 'rt', 'rm']) {
    if (!prev || !sameVal(prev[k], full[k])) { out[k] = full[k]; any = true; }
  }
  const f0 = diffObj(prev && prev.f && prev.f[0], full.f[0]);
  const f1 = diffObj(prev && prev.f && prev.f[1], full.f[1]);
  if (f0 || f1) { out.f = [f0 || {}, f1 || {}]; any = true; }
  if (!prev || !sameVal(prev.pr, full.pr)) { out.pr = full.pr; any = true; }
  if (!prev || !sameVal(prev.bl, full.bl)) { out.bl = full.bl; any = true; }
  if (full.fx.length) { out.fx = full.fx; any = true; }
  return any ? out : null;
}

// ---- Simulation tick ----
function applyInputs(room) {
  const { InputManager, VCONTROLS } = room.sim;
  for (const slot of ['p1', 'p2']) {
    const inp = room.inputs[slot];
    HELD.forEach((a, i) => InputManager.setVirtual(VCONTROLS[slot][a], inp.held[i], false));
    TAPS.forEach((a, i) => {
      // One press per tick per button; extra presses queue for the next tick.
      let pressed = false;
      if (inp.counts[i] > inp.consumed[i]) { inp.consumed[i]++; pressed = true; }
      const isHeld = a === 'special' ? inp.specialHeld : a === 'jump' ? inp.jumpHeld : false;
      InputManager.setVirtual(VCONTROLS[slot][a], isHeld, pressed);
    });
  }
}

function tickRoom(room) {
  applyInputs(room);
  room.sim.Game.update(FIXED_STEP_MS / 1000);
  const delta = buildDelta(room);
  if (delta) broadcast(room, delta);
}

let lastTime = performance.now();
let accumulator = 0;
setInterval(() => {
  const now = performance.now();
  accumulator += Math.min(now - lastTime, 250);
  lastTime = now;
  while (accumulator >= FIXED_STEP_MS) {
    for (const room of rooms.values()) {
      if (room.running) tickRoom(room);
    }
    accumulator -= FIXED_STEP_MS;
  }
}, 2);

// ---- Sockets ----
const wss = new WebSocketServer({
  port: PORT,
  perMessageDeflate: { threshold: 64 },
});

function onMessage(ws, msg) {
  if (!msg || typeof msg !== 'object') return;
  const room = ws.room;

  if (msg.t === 'create' && !room) {
    const r = createRoom(!!msg.relay);
    r.players.p1 = ws;
    ws.room = r; ws.slot = 'p1';
    send(ws, { t: 'room', code: r.code, slot: 'p1', relay: r.relay });
    return;
  }

  if (msg.t === 'join' && !room) {
    const r = rooms.get(String(msg.code || '').trim().toUpperCase());
    if (!r) return send(ws, { t: 'error', text: 'No room with that code.' });
    if (r.players.p2) return send(ws, { t: 'error', text: 'That room is full.' });
    if (r.relay !== !!msg.relay) return send(ws, { t: 'error', text: 'That room was made with a different version of the game. Both players: refresh the page.' });
    r.players.p2 = ws;
    ws.room = r; ws.slot = 'p2';
    send(ws, { t: 'room', code: r.code, slot: 'p2', relay: r.relay });
    broadcast(r, { t: 'connected' });
    return;
  }

  if (!room) return;
  const slot = ws.slot;

  if (room.relay) {
    // Rollback inputs/hashes/repairs and menu messages go straight to the
    // other player. Match start comes from player 1 only.
    if (RELAYED.has(msg.t) && (msg.t !== 'start' || slot === 'p1')) {
      const to = room.players[other(slot)];
      if (to && to.readyState === to.OPEN) to.send(JSON.stringify(msg));
    }
    return;
  }

  if (msg.t === 'i' && Array.isArray(msg.h) && Array.isArray(msg.c)) {
    const inp = room.inputs[slot];
    inp.held = HELD.map((_, i) => !!msg.h[i]);
    inp.specialHeld = !!msg.s;
    inp.jumpHeld = !!msg.j; // older clients don't send it: no hover, everything else unchanged
    // Counters only ever go up.
    for (let i = 0; i < 4; i++) inp.counts[i] = Math.max(inp.counts[i], Number(msg.c[i]) || 0);
    return;
  }

  if (msg.t === 'pick' || msg.t === 'select') {
    send(room.players[other(slot)], msg);
    return;
  }

  if (msg.t === 'start' && slot === 'p1' && room.players.p2) {
    const { CHARACTERS, Game } = room.sim;
    if (!CHARACTERS[msg.p1] || !CHARACTERS[msg.p2]) return;
    room.inputs.p1.consumed = room.inputs.p1.counts.slice();
    room.inputs.p2.consumed = room.inputs.p2.counts.slice();
    room.lastSent = null; // next snapshot is a full one
    Game.startMatch(msg.p1, msg.p2, (winner) => {
      broadcast(room, { t: 'matchEnd', winner });
    }, { ball: msg.ball });
    room.running = true;
    broadcast(room, { t: 'start', p1: msg.p1, p2: msg.p2 });
  }
}

function onClose(ws) {
  const room = ws.room;
  if (!room) return;
  room.players[ws.slot] = null;
  send(room.players[other(ws.slot)], { t: 'left' });
  const leftover = room.players[other(ws.slot)];
  if (leftover) { leftover.room = null; leftover.slot = null; }
  closeRoom(room);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    onMessage(ws, msg);
  });
  ws.on('close', () => onClose(ws));
  ws.on('error', () => {});
});

// Drop sockets that stop answering pings (closed laptop, dead wifi).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 5000);

console.log('Vesid Fighter server listening on :' + PORT);
