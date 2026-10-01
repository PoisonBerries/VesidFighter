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

// Crouching (holding block on the ground) shrinks the hurtbox to this
// fraction of the fighter's height, so smaller fighters crouch lower in
// absolute terms. A "high" attack (see characters.js) has its hitbox start
// this fraction of the ATTACKER's height above the floor; it misses any
// crouching fighter whose crouched top is below that line. With the numbers
// below, you can duck a punch from anyone about your own height or taller.
const CROUCH_HEIGHT = 0.56;
const HIGH_ATTACK_BOTTOM = 0.6;

const FIGHTER_WIDTH = 96;
const FIGHTER_HEIGHT = 160;

const ROUND_TIME = 90; // seconds per round
const ROUNDS_TO_WIN = 2; // best of 3

const FIXED_STEP = 1 / 60; // seconds, physics runs at a fixed 60hz timestep

const CONTROLS = {
  p1: {
    left: 'KeyA',
    right: 'KeyD',
    jump: 'KeyW',
    block: 'KeyS',
    guard: 'KeyT',
    attack: 'KeyF',
    special: 'KeyG',
    ultimate: 'KeyH',
  },
  p2: {
    left: 'ArrowLeft',
    right: 'ArrowRight',
    jump: 'ArrowUp',
    block: 'ArrowDown',
    guard: 'KeyP',
    attack: 'KeyL',
    special: 'Semicolon',
    ultimate: 'Quote',
  },
  // One player on the keyboard (vs CPU, online): WASD or the arrows to
  // move, J hit, K special, L ultimate. (Local 2-player uses p1/p2 above.)
  solo: {
    left: 'KeyA',
    right: 'KeyD',
    jump: 'KeyW',
    block: 'KeyS',
    guard: 'KeyI',
    attack: 'KeyJ',
    special: 'KeyK',
    ultimate: 'KeyL',
  },
};
const SOLO_ALT_KEYS = { left: 'ArrowLeft', right: 'ArrowRight', jump: 'ArrowUp', block: 'ArrowDown' };

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
const ULT_GAIN_ON_LAND_NORMAL = 9;
const ULT_GAIN_ON_LAND_SPECIAL = 15;
const ULT_GAIN_ON_TAKEN = 6;
const GUARD_ULT_DRAIN = 0.035;     // ult meter lost per frame while holding guard (about 47s from full)

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

// ---- The ball (see game.js) ----
// Two modes:
//  'rally' -- one ball in play all round, and it's your main weapon. Every
//     hit makes it hotter and faster; a ball your opponent hit ("live") hurts
//     you, more the hotter it is. Punches on each other do less damage: they
//     are for winning control of the ball. Block just as it arrives to catch it.
//  'bomb' -- the hot potato: a bomb-ball you volley at each other until its
//     fuse runs out or it touches the floor, and it explodes.
// 'off' plays without a ball.
const BALL_MODES = ['rally', 'bomb', 'off'];
const BALL_MODE = 'rally';
const BALL_RADIUS = 24;          // visual/body-contact radius
const BALL_HIT_RADIUS = 40;      // generous radius for attacks connecting with it
const BALL_GRAVITY = 0.2;        // floaty, like a beach ball
const BALL_MAX_FALL = 8;         // terminal fall speed from gravity alone
const BALL_FUSE = 540;           // frames from drop to detonation (9s)
const BALL_FIRST_SPAWN = 120;    // frames into a round before the first ball
const BALL_RESPAWN = 300;        // frames between an explosion and the next ball
const BALL_APPEAR = 50;          // frames it hovers, materialising, before it drops
const BALL_SPAWN_Y = 140;
const BALL_BODY_BOUNCE = 0.6;    // speed kept bouncing off a fighter's body (harmless)
// Launch velocity [vx away from the hitter, vy] when an attack connects,
// by where the hitter is and which way they hold: toward the opponent
// drives it flatter and farther, away pops it up short.
const BALL_HITS = {
  ground: { neutral: [8, -7], toward: [10, -4.5], away: [4.5, -11] },
  air: { neutral: [9, 4], toward: [11, 2], away: [6, -4] },
};
const BALL_STRONG_HIT = 1.2;     // specials and ultimates hit it harder
const BALL_DRAG = 0.99;          // horizontal speed kept per frame
const BALL_HITSTOP = 5;          // frames it freezes on a hit, for impact
const BALL_BLAST_RADIUS = 170;
const BALL_BLAST_DAMAGE = 20;

// Rally mode.
const RALLY_FIGHT_DAMAGE = 0.5;  // fighter-on-fighter damage multiplier (knockback is unchanged)
const RALLY_MAX_HEAT = 10;
const RALLY_SPEED = 6, RALLY_SPEED_PER_HEAT = 0.6; // launch speed at heat h: 6 + 0.6h (12 at max)
const RALLY_LIVE_GRAVITY = 0.12; // a struck ball flies flatter
const RALLY_LIVE_BOUNCES = 2;    // floor bounces before a live ball goes dead
const RALLY_MIN_BOUNCE = 7;      // a loose ball keeps bouncing (always hittable)
const RALLY_HEAT_DECAY = 22;     // frames per heat lost while the ball is loose
const RALLY_FLOOR_HEAT = 2;      // heat lost every time it bounces on the floor: keep it up to keep it hot
const RALLY_DAMAGE = 6, RALLY_DAMAGE_PER_HEAT = 2.5;
const RALLY_CATCH_WINDOW = 12;   // block within this many frames of impact to catch
const RALLY_HOLD = 45;           // frames you can hold a caught ball before it auto-throws
const RALLY_RESPAWN = 90;        // after the ball falls off the stage (it shouldn't: walls keep it on)


// ---- Balance mode (see Fighter.applyHit) ----
// No KOs: the health bar is your balance, and the only way to lose a round
// is falling off the stage. Every hit wears your balance down, and the lower
// it is, the bigger a mess you are -- hits knock you further, and you slide
// instead of stopping. Time up: whoever has more balance left.
const BALANCE_ENABLED = true;
const KNOCKBACK_MUL = 0.85;          // every hit's base knockback, toned down across the board
const BALANCE_KNOCKBACK_SCALE = 1.2; // knockback x(1 + 1.2 * shaky^2): x2.2 with no balance left
const BALANCE_FLY_AT = 0.25;         // from 25% balance lost, hits send you flying (no skid)
const BALANCE_SLIP = 0.12;           // ground friction eases from FRICTION toward FRICTION + this
