// Shared tuning constants for the whole game. Kept in one place so the
// "feel" of the game (speed, gravity, timing) can be tuned quickly.

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;

const GROUND_Y = 560; // y coordinate of the floor (feet position when standing)
const GRAVITY = 0.75; // px / frame^2 at 60fps
const FRICTION = 0.82; // velocity multiplier applied when no input

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

const POSES = ['idle', 'walk', 'jump', 'attack', 'block', 'hit', 'special', 'knockdown', 'ko', 'victory'];

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

const ULT_METER_MAX = 100;
const ULT_GAIN_ON_LAND_NORMAL = 7;
const ULT_GAIN_ON_LAND_SPECIAL = 12;
const ULT_GAIN_ON_TAKEN = 5;
