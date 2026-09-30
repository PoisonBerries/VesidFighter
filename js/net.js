// Online play over WebRTC (PeerJS). No game server: the free PeerJS cloud
// broker is only used to introduce the two browsers, then traffic goes
// peer-to-peer.
//
// Ways to connect:
//  - "relay" mode (default when GAME_SERVER_URL is set): both players
//    connect by WebSocket to server/server.js, which just passes messages
//    between them; both run the game with rollback, exactly like direct P2P.
//  - "server" mode: the same connection, but the server runs the simulation
//    and both browsers stream inputs and render its (delta) snapshots. Only
//    used when the server predates relay rooms.
//  - direct peer-to-peer (the "Direct connection" option), described below.
//
// P2P model: rollback netcode (js/rollback.js). Both players run the
// simulation and exchange only their inputs, so your own fighter responds
// instantly; a late opponent input is predicted and corrected by rewinding.
// The host (P1) still leads the menus (Fight!, Rematch).
//
// Two data channels: "ctrl" (reliable -- menu/match events) and "fast"
// (unreliable -- rollback inputs, where a late packet is worse than a
// dropped one; rollback resends anything unconfirmed).

const Net = (() => {
  const ID_PREFIX = 'vesidfighter-';
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const HELD = ['left', 'right', 'block'];
  const TAPS = ['jump', 'attack', 'special', 'ultimate'];
  const ACTIONS = HELD.concat(TAPS);

  // Virtual key codes the fighters read in online mode (see InputManager).
  const VCONTROLS = {};
  for (const slot of ['p1', 'p2']) {
    VCONTROLS[slot] = {};
    for (const a of ACTIONS) VCONTROLS[slot][a] = 'V_' + slot + '_' + a;
  }

  let mode = 'offline'; // offline | host | guest | relay | server
  let slot = 'p1'; // our fighter in server mode
  let ws = null;
  let peer = null;
  let ctrl = null;
  let fast = null;
  let handlers = {};

  // Local input sampling
  const localTapCounts = [0, 0, 0, 0];
  let sendSeq = 0;

  // Rollback (direct P2P): match ids so both sides agree which match an
  // input belongs to, and a keepalive while no match is running.
  let matchSeq = 0;
  let lastHeartbeat = 0;

  // WebRTC often doesn't report a closed tab, so time out on silence too.
  const TIMEOUT_MS = 5000;
  let lastRecvAt = 0;

  function isOnline() { return mode !== 'offline'; }
  function isHost() { return mode === 'host'; }
  function isGuest() { return mode === 'guest'; }
  function isServer() { return mode === 'server'; }
  function isRelay() { return mode === 'relay'; }
  // True when the server runs the simulation and we just render it.
  function isRemoteSim() { return mode === 'server'; }
  // Direct P2P: both players simulate, with rollback.
  function isRollback() { return mode === 'host' || mode === 'guest' || mode === 'relay'; }
  function localSlot() {
    if (mode === 'server' || mode === 'relay') return slot;
    return mode === 'guest' ? 'p2' : 'p1';
  }
  // P1 drives menu flow (Fight!, Rematch) in every online mode.
  function isLeader() { return isOnline() && localSlot() === 'p1'; }

  // Key labels to show on the HUD / select panel that belongs to `forSlot`.
  // Offline each side shows its own keys. Online either key set drives your
  // fighter, so we advertise the WASD set on *your* panel, whichever side
  // you're on, and show nothing on the opponent's (those aren't your keys).
  function controlLabelsFor(forSlot) {
    if (!isOnline()) return CONTROLS[forSlot];
    return forSlot === localSlot() ? CONTROLS.p1 : null;
  }

  function controlsFor(slot) {
    return isOnline() ? VCONTROLS[slot] : CONTROLS[slot];
  }

  function randomCode() {
    let s = '';
    for (let i = 0; i < 5; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    return s;
  }

  function emit(name, arg) {
    if (handlers[name]) handlers[name](arg);
  }

  function on(name, fn) { handlers[name] = fn; }

  function resetState() {
    localTapCounts.fill(0);
    sendSeq = 0;
    Rollback.end();
  }

  function makePeer(id) {
    return new Peer(id, { debug: 1 });
  }

  function wireConnection(conn) {
    if (conn.label === 'ctrl') {
      ctrl = conn;
      conn.on('data', (msg) => emit('ctrl', msg));
    } else {
      fast = conn;
      conn.on('data', onFast);
    }
    conn.on('close', () => disconnect('Opponent disconnected.'));
    conn.on('error', (e) => console.warn('conn error', e));
    conn.on('open', maybeReady);
  }

  function maybeReady() {
    if (ctrl && fast && ctrl.open && fast.open) {
      resetState();
      lastRecvAt = performance.now();
      Effects.setRecording(false); // both sides simulate, so no effect events to forward
      emit('connected');
    }
  }

  function host() {
    disconnect();
    mode = 'host';
    const code = randomCode();
    peer = makePeer(ID_PREFIX + code);
    peer.on('open', () => emit('status', { code, text: 'Room code: ' + code + ' -- waiting for opponent...' }));
    peer.on('connection', (conn) => {
      // Only one opponent per room.
      if ((conn.label === 'ctrl' && ctrl) || (conn.label === 'fast' && fast)) {
        conn.close();
        return;
      }
      wireConnection(conn);
    });
    peer.on('error', onPeerError);
  }

  function join(code) {
    disconnect();
    mode = 'guest';
    code = code.trim().toUpperCase();
    peer = makePeer();
    emit('status', { text: 'Connecting to ' + code + '...' });
    peer.on('open', () => {
      const target = ID_PREFIX + code;
      wireConnection(peer.connect(target, { label: 'ctrl', reliable: true, serialization: 'json' }));
      wireConnection(peer.connect(target, { label: 'fast', reliable: false, serialization: 'json' }));
    });
    peer.on('error', onPeerError);
  }

  // ---- Server mode ----
  function serverConnect(firstMsg) {
    disconnect();
    mode = 'server';
    emit('status', { text: 'Connecting to server...' });
    let sock;
    try {
      sock = new WebSocket(GAME_SERVER_URL);
    } catch (e) {
      disconnect('Could not reach the game server.');
      return;
    }
    ws = sock;
    sock.onopen = () => sock.send(JSON.stringify(firstMsg));
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      onServerMessage(msg);
    };
    sock.onclose = () => {
      if (ws === sock) disconnect('Lost connection to the game server.');
    };
  }

  function onServerMessage(msg) {
    if (msg.t === 's') {
      Game.applySnapshot(msg);
    } else if (msg.t === 'room') {
      slot = msg.slot;
      // An older server ignores the relay request and runs the game itself.
      mode = msg.relay ? 'relay' : 'server';
      if (slot === 'p1') {
        emit('status', { code: msg.code, text: 'Room code: ' + msg.code + ' -- waiting for opponent...' });
      }
    } else if (msg.t === 'connected') {
      resetState();
      emit('connected');
    } else if (msg.t === 'error') {
      disconnect(msg.text);
    } else if (msg.t === 'left') {
      disconnect('Opponent disconnected.');
    } else if (msg.t === 'ri' || msg.t === 'rh' || msg.t === 'rs') {
      Rollback.receive(msg);
    } else {
      emit('ctrl', msg);
    }
  }

  function hostServer() { serverConnect({ t: 'create', relay: true }); }
  function joinServer(code) { serverConnect({ t: 'join', code: code.trim().toUpperCase(), relay: true }); }

  function onPeerError(err) {
    console.warn('peer error', err);
    let text = 'Connection error: ' + (err.type || err.message || err);
    if (err.type === 'peer-unavailable') text = 'No room with that code.';
    disconnect(text);
  }

  function disconnect(reason) {
    const wasOnline = isOnline();
    const p = peer;
    const sock = ws;
    peer = null; ctrl = null; fast = null; ws = null;
    if (sock) { try { sock.close(); } catch (e) { /* ignore */ } }
    mode = 'offline';
    Rollback.end();
    Effects.setRecording(false);
    if (p) { try { p.destroy(); } catch (e) { /* ignore */ } }
    if (wasOnline && reason) emit('disconnected', reason);
  }

  function sendWs(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function sendCtrl(msg) {
    if (ws) return sendWs(msg);
    if (ctrl && ctrl.open) ctrl.send(msg);
  }

  function sendFast(msg) {
    if (ws) return sendWs(msg);
    if (fast && fast.open) fast.send(msg);
  }

  // Either key set works for the local player online.
  function sampleLocal() {
    const held = HELD.map(a => InputManager.isDown(CONTROLS.p1[a]) || InputManager.isDown(CONTROLS.p2[a]));
    const taps = TAPS.map(a => InputManager.isPressed(CONTROLS.p1[a]) || InputManager.isPressed(CONTROLS.p2[a]));
    taps.forEach((t, i) => { if (t) localTapCounts[i]++; });
    // Jump is a tap for jumping but also a hold (hover), so send both.
    const jumpHeld = InputManager.isDown(CONTROLS.p1.jump) || InputManager.isDown(CONTROLS.p2.jump);
    return { held, taps, jumpHeld };
  }

  function setVirtual(slot, held, taps) {
    HELD.forEach((a, i) => InputManager.setVirtual(VCONTROLS[slot][a], held[i], false));
    TAPS.forEach((a, i) => InputManager.setVirtual(VCONTROLS[slot][a], false, taps[i]));
  }

  // ---- Rollback (direct P2P) ----
  // Player 1 numbers each match; player 2 uses the number from 'start'.
  function newMatchId() { return ++matchSeq; }

  function startRollback(id) {
    matchSeq = Math.max(matchSeq, id);
    Rollback.begin(localSlot(), id, sendFast);
  }

  // Called once per fixed tick in direct matches, instead of Game.update.
  function rollbackTick() {
    checkTimeout();
    if (Rollback.isActive()) {
      Rollback.tick(Rollback.inputBits());
    } else {
      InputManager.endFrame();
      const now = performance.now();
      if (!ws && now - lastHeartbeat > 250) { lastHeartbeat = now; sendFast({ t: 'hb' }); }
    }
  }

  // Called once per fixed tick on the guest instead of Game.update.
  function guestTick() {
    checkTimeout();
    const local = sampleLocal();
    const specialHeld = InputManager.isDown(CONTROLS.p1.special) || InputManager.isDown(CONTROLS.p2.special);
    InputManager.endFrame();
    sendFast({ t: 'i', h: local.held, s: specialHeld, j: local.jumpHeld, c: localTapCounts.slice() });
    Effects.update();
  }

  function checkTimeout() {
    if (!ws && fast && fast.open && performance.now() - lastRecvAt > TIMEOUT_MS) {
      disconnect('Lost connection to opponent.');
    }
  }

  function onFast(msg) {
    if (!msg) return;
    lastRecvAt = performance.now();
    if (msg.t === 'ri' || msg.t === 'rh' || msg.t === 'rs') Rollback.receive(msg);
  }

  window.addEventListener('beforeunload', () => disconnect());

  return {
    isOnline, isHost, isGuest, isServer, isRelay, isRemoteSim, isLeader, localSlot, controlsFor, controlLabelsFor,
    host, join, hostServer, joinServer, disconnect, on, sendCtrl,
    isRollback, newMatchId, startRollback, rollbackTick, guestTick,
  };
})();
