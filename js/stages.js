// Stages: where you fight. Each has its floor edges (fall past them and it's
// a ring-out), where the fighters start, one-way platforms (jump up through
// them, land on top, crouch + jump to drop back down) and hazards.
//
// Only gameplay lives here, in game pixels: the floor is at GROUND_Y and
// x = 640 is the middle of the screen. How a stage looks is up to the
// renderers (renderer3d.js). Everything that changes during a round (the
// car) is plain data, saved and restored with the rest of the match so
// online play stays in sync.

const STAGES = {
  arena: {
    name: 'Sky Arena',
    left: 160, right: 1120,
    spawns: [380, 900],
    platforms: [],
  },
  orchard: {
    name: 'Orchard',
    // 2.5x the arena's floor, with room for four.
    left: -560, right: 1840,
    spawns: [210, 1070],
    // The apple tree in the middle: a low branch each side, the two upper
    // branches (the crown) above, and a short pair at the very top. 92px
    // apart, to fit the lowest jump in the roster (John's, ~106px). Each
    // covers the level part of its branch (blender/orchard.blend).
    platforms: [
      { id: 'branchL', x1: 445, x2: 595, y: GROUND_Y - 92 },
      { id: 'branchR', x1: 695, x2: 835, y: GROUND_Y - 92 },
      { id: 'crown', x1: 490, x2: 790, y: GROUND_Y - 184 },
      { id: 'top', x1: 540, x2: 740, y: GROUND_Y - 276 },
    ],
    // Now and then a car comes down a farm road from the background (the
    // warning: you can see it coming, lights on), turns onto the fight line
    // just inside one end, drives across and turns off at the other end,
    // alternating sides. It runs over anyone in its way (unblockable); jump
    // over it, or onto the roof and ride it. Timings in frames of fighting.
    car: {
      width: 300, height: 95, speed: 16,
      turn: 150, turnSpeed: 0.35, exitSpeed: 0.45, // share of full speed coming out of / going into the corners
      firstAt: 18 * 60, every: 30 * 60, warn: 120,
      damage: 14, knockback: 16, knockbackUp: 12, knockdownDuration: 40,
    },
  },
};
const STAGE_IDS = Object.keys(STAGES);
const DEFAULT_STAGE = 'arena';

const Stage = (() => {
  let id = DEFAULT_STAGE;
  let def = STAGES[id];
  let state = fresh();

  function fresh() {
    return { t: 0, cars: 0, car: null };
  }

  // Switch stage (at the start of a match).
  function use(stageId) {
    id = STAGES[stageId] ? stageId : DEFAULT_STAGE;
    def = STAGES[id];
    STAGE_LEFT_EDGE = def.left;
    STAGE_RIGHT_EDGE = def.right;
    WORLD_LEFT = def.left - 200;
    WORLD_RIGHT = def.right + 200;
    state = fresh();
  }

  // Each round starts with the stage as new.
  function reset() {
    state = fresh();
  }

  const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // Where the car joins (and leaves) the fight line: its middle, just inside
  // the left (-1) or right (1) end of the floor.
  function carStart(side) {
    const c = def.car;
    // (the farm road is at the edge + width/2 + 20; the car comes onto the
    // line a turning circle's radius further in)
    const d = c.width / 2 + 20 + c.turn;
    return side < 0 ? STAGE_LEFT_EDGE + d : STAGE_RIGHT_EDGE - d;
  }

  // The car's body -- what runs you over. Starts a little below the roof,
  // so standing on top is safe.
  function carBody() {
    const c = def.car, car = state.car;
    return { x: car.x - c.width / 2, y: GROUND_Y - c.height + 14, w: c.width, h: c.height - 14 };
  }

  // One fight frame, before the fighters move.
  function update(fighters) {
    state.t++;
    const c = def.car;
    if (!c) return;
    let car = state.car;
    if (!car) {
      if (state.t < c.firstAt + state.cars * c.every - c.warn) return;
      const dir = state.cars % 2 === 0 ? 1 : -1;
      state.car = { phase: 'warn', timer: c.warn, dir, x: dir > 0 ? carStart(-1) : carStart(1), dx: 0, hit: {}, n: state.cars };
      state.cars++;
      return;
    }
    if (car.phase === 'warn') {
      if (--car.timer <= 0) car.phase = 'drive';
      return;
    }
    // Like a real car through the corners: it pulls onto the line slowly out
    // of its turn, gets up to speed, and brakes again before turning off.
    const from = carStart(-car.dir), to = carStart(car.dir);
    const p = Math.max(0, Math.min(1, (car.x - from) / (to - from)));
    const ease = (t) => t * t * (3 - 2 * t);
    const pace = Math.min(c.turnSpeed + (1 - c.turnSpeed) * ease(Math.min(1, p / 0.25)),
      c.exitSpeed + (1 - c.exitSpeed) * ease(Math.min(1, (1 - p) / 0.18)));
    car.dx = car.dir * c.speed * pace;
    car.x += car.dx;
    if ((car.dir > 0 && car.x > carStart(1)) || (car.dir < 0 && car.x < carStart(-1))) { // turns off the road
      state.car = null;
      return;
    }
    const body = carBody();
    for (const f of fighters) {
      if (car.hit[f.slot] || f.state === 'ko' || f.state === 'grabbed') continue;
      if (!overlap(body, f.getHurtbox())) continue;
      const result = f.applyHit({
        damage: c.damage, knockback: c.knockback, knockbackUp: c.knockbackUp, hitstun: 30,
        fromFacing: car.dir, knockdown: true, knockdownDuration: c.knockdownDuration, unblockable: true,
      });
      if (result !== 'hit') continue;
      car.hit[f.slot] = true;
      f.platform = null;
      if (typeof Effects !== 'undefined') {
        Effects.spawnHitSpark(f.x, f.y - f.height * 0.5, '#ffe066', 'boom');
        Effects.shake(12, 16);
      }
    }
  }

  // Everything you can stand on right now besides the floor: the stage's
  // platforms and the roof of a moving car. dx: how far it moved this frame
  // (a rider moves with it).
  function platforms() {
    const car = state.car;
    if (!car || car.phase !== 'drive') return def.platforms;
    const c = def.car;
    return def.platforms.concat([{ id: 'car', x1: car.x - c.width / 2 + 8, x2: car.x + c.width / 2 - 8, y: GROUND_Y - c.height, dx: car.dx }]);
  }

  function platform(pid) {
    return platforms().find((p) => p.id === pid) || null;
  }

  // For rollback / online snapshots (plain data, copied both ways).
  function save() {
    return JSON.parse(JSON.stringify(state));
  }
  function load(s) {
    state = s ? JSON.parse(JSON.stringify(s)) : fresh();
  }

  return {
    use, reset, update, platforms, platform, save, load, carStart,
    id: () => id,
    def: () => def,
    car: () => state.car,
    time: () => state.t,
  };
})();
