// Shared tuning constants for the whole game. Kept in one place so the
// "feel" of the game (speed, gravity, timing) can be tuned quickly.

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;

const GROUND_Y = 560; // y coordinate of the floor (feet position when standing)
const GRAVITY = 0.75; // px / frame^2 at 60fps
const FRICTION = 0.82; // velocity multiplier applied when no input
const CROUCH_SPEED_MULTIPLIER = 0.35; // how much slower crouch-walking is vs normal movement

// The stage is a raised platform with open air on either side. Walking past
// these x values means there's no ground underfoot -> fighter falls.
const STAGE_LEFT_EDGE = 160;
const STAGE_RIGHT_EDGE = 1120;

// Falling below this y means the fighter has fallen off the stage entirely
// (ring-out) and the round ends immediately, Tough-Love-Arena style.
const RING_OUT_Y = 840;

const FIGHTER_WIDTH = 96;
const FIGHTER_HEIGHT = 160;

const ROUND_TIME = 60; // seconds per round
const ROUNDS_TO_WIN = 2; // best of 3

const FIXED_STEP = 1 / 60; // seconds, physics runs at a fixed 60hz timestep

const CONTROLS = {
  p1: {
    left: 'KeyA',
    right: 'KeyD',
    jump: 'KeyW',
    block: 'KeyS',
    attack: 'KeyF',
    special: 'KeyG',
    ultimate: 'KeyH',
  },
  p2: {
    left: 'ArrowLeft',
    right: 'ArrowRight',
    jump: 'ArrowUp',
    block: 'ArrowDown',
    attack: 'KeyL',
    special: 'Semicolon',
    ultimate: 'Quote',
  },
};

// WebSocket URL of server/server.js for online play. Leave empty to fall
// back to direct peer-to-peer connections. A ?server=wss://... query param
// overrides it (handy for testing). This file also runs on the server,
// where there's no `location`.
const GAME_SERVER_URL = (typeof location !== 'undefined' && new URLSearchParams(location.search).get('server')) || 'wss://35-223-40-228.sslip.io';

// Identity colours for the two sides: HUD chips, the tag above each fighter
// and the ring on the floor all use these, so who-is-who reads at a glance
// even in a mirror match.
const PLAYER_COLORS = { p1: '#ff4d5e', p2: '#4da3ff' };

// Alternate colour scheme for player 2 in a mirror match: same hue-rotated
// treatment fighting games use for palette swaps. Memoised -- called per frame.
const _swapMemo = {};
function swapPalette(hex) {
  if (_swapMemo[hex]) return _swapMemo[hex];
  const h6 = hex.replace('#', '');
  const r = parseInt(h6.substring(0, 2), 16) / 255, g = parseInt(h6.substring(2, 4), 16) / 255, b = parseInt(h6.substring(4, 6), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  h = (h + 0.47) % 1;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const out = '#' + [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  _swapMemo[hex] = out;
  return out;
}

const ULT_METER_MAX = 100;
const ULT_GAIN_ON_LAND_NORMAL = 7;
const ULT_GAIN_ON_LAND_SPECIAL = 12;
const ULT_GAIN_ON_TAKEN = 5;

// Turns a KeyboardEvent.code into the short label shown on-screen (HUD key
// badges, the character select panel). Shared by renderer.js and ui.js.
function keyLabel(code) {
  const named = {
    Semicolon: ';', Quote: "'", ArrowLeft: '←', ArrowRight: '→',
    ArrowUp: '↑', ArrowDown: '↓', Space: 'Space',
  };
  if (named[code]) return named[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}
