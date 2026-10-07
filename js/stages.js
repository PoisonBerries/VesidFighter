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
    // branches (the crown) above, a short pair at the top, and the leafy top
    // of the tree itself. 92px
    // apart, to fit the lowest jump in the roster (John's, ~106px). Each
    // covers its branch from the trunk to the tip (blender/orchard.blend).
    platforms: [
      { id: 'branchL', x1: 485, x2: 628, y: GROUND_Y - 92 },
      { id: 'branchR', x1: 652, x2: 797, y: GROUND_Y - 92 },
      { id: 'crown', x1: 482, x2: 798, y: GROUND_Y - 184 },
      { id: 'top', x1: 532, x2: 752, y: GROUND_Y - 276 },
      { id: 'canopy', x1: 555, x2: 710, y: GROUND_Y - 368 }, // standing on the leaves
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
    // Once a round, 15s in, a giant comes in from far out in the valley,
    // walks up the hill behind the orchard past the barn, wanders forward
    // swatting at bugs, sprints, leaps to just behind the fence, and looks
    // around -- and a red zone lights up on the road where its hand will come
    // down, brighter and faster the closer it gets. When it reaches down
    // (the zone "goes off"), whoever is standing in the zone is picked up and
    // thrown away (a KO). Then it runs back the way it came. It comes down a
    // gap between the tree columns (lanes, fight-line x) -- the one that puts
    // its hand nearest a fighter when it sets off (each round, the other
    // fighter). Phases in frames; the 3D view (renderer3d.js) moves and
    // animates it to match.
    monster: {
      at: 15 * 60,
      lanes: [175, 970, 1235], // (clear of the apple tree, which would hide it, and the tractor)
      hand: 145,        // its grabbing hand comes down this far to the right of its lane
      range: 170,       // the danger zone: this far either side of that spot
      top: 150,         // ...on the floor (not up a tree)
      climb: 1450, swat: 270, run: 120, jump: 50, look: 270,
      grab: 140, reach: 0.62, // grab: hands at the floor this far through
      hold: 45, throw: 146, release: 0.445, // throw: turns side-on and lets go this far through (frame 65), then follows through
      turn: 98, back: 230, descend: 500,
      held: [110, 350], // where it holds them (x from its lane, height)
      fling: [572, 424], // where its fist is as it lets go (x along the throw from where it stands, height)
      flingV: [44, 24],  // how fast they leave its hand (along the throw, up): its arm's whip, measured from the clip
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
    return { t: 0, cars: 0, car: null, monster: null, monsters: 0 };
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

  // The monster (def.monster): where it is in its run, and what it does to
  // whoever it catches.
  function monsterNext(mon, phase) { mon.phase = phase; mon.t = 0; }
  // (coasting: after the round's over it carries on through its moves -- the
  // follow-through, running off -- but catches no one.)
  function updateMonster(fighters, coasting) {
    const m = def.monster;
    if (!m || m.off) return; // (switched off for now -- see def.monster.off)
    let mon = state.monster;
    if (!mon) {
      if (state.t !== m.at) return;
      // The lane that brings its hand nearest one fighter (the other one next round).
      const who = fighters[state.monsters % fighters.length];
      const lane = m.lanes.reduce((best, x) => (Math.abs(x + m.hand - who.x) < Math.abs(best + m.hand - who.x) ? x : best), m.lanes[0]);
      state.monster = { phase: 'climb', t: 0, x: lane, held: null, dir: 0, thrown: 0 };
      state.monsters++;
      return;
    }
    mon.t++;
    if (coasting && mon.held) mon.held = null;
    const handX = mon.x + m.hand;
    const inReach = (f) => f.state !== 'ko' && f.state !== 'grabbed' && !(f.invulnerableTimer > 0)
      && Math.abs(f.x - handX) <= m.range && f.y >= GROUND_Y - m.top;
    const held = mon.held ? fighters.find((f) => f.slot === mon.held) : null;
    if (mon.phase === 'grab' && !mon.held && !coasting && mon.t === Math.round(m.reach * m.grab)) {
      // Hand at the floor: catch whoever is still under it.
      let pick = null;
      for (const f of fighters) if (inReach(f) && (!pick || Math.abs(f.x - handX) < Math.abs(pick.x - handX))) pick = f;
      if (pick) {
        mon.held = pick.slot;
        mon.gx = pick.x; mon.gy = pick.y; // lifted from where they stood
        mon.dir = mon.x < (STAGE_LEFT_EDGE + STAGE_RIGHT_EDGE) / 2 ? -1 : 1; // it throws towards the nearer end
        pick.state = 'grabbed'; pick.heldByStage = true;
        pick.vx = 0; pick.vy = 0; pick.grounded = false; pick.platform = null;
        pick.blocking = false; pick.guarding = false; pick.stunFrames = 0; pick.actionTimer = 0;
        if (typeof Effects !== 'undefined') Effects.shake(10, 14);
      }
    }
    if (held && held.state === 'grabbed') {
      // Lifted up into its hand as it straightens, held there, then thrown.
      const r0 = Math.round(m.reach * m.grab);
      const k = mon.phase === 'grab' ? Math.min(1, Math.max(0, (mon.t - r0) / (m.grab - r0))) : 1;
      const e = k * k * (3 - 2 * k);
      const gx = mon.gx === undefined ? handX : mon.gx, gy = mon.gy === undefined ? GROUND_Y : mon.gy;
      held.x = gx + (mon.x + m.held[0] - gx) * e;
      held.y = gy + (GROUND_Y - m.held[1] - gy) * e;
      held.vx = 0; held.vy = 0;
      if (mon.phase === 'throw' && mon.t === Math.round(m.throw * m.release)) {
        // Flung away towards the nearer end of the floor, from its fist: a KO
        // (and off the edge, for balance mode where an empty bar doesn't end
        // the round).
        const dir = mon.dir;
        const at = mon.gx === undefined ? mon.x : mon.gx - m.hand; // where it stands (it leaned over to grab them)
        held.x = at + dir * m.fling[0]; held.y = GROUND_Y - m.fling[1];
        mon.thrown = dir;
        held.heldByStage = false;
        held.state = 'hitstun'; held.stunFrames = 60; held.launched = true; held.flung = true;
        held.vx = dir * m.flingV[0]; held.vy = -m.flingV[1]; // (out past the edge of the world and away: see Fighter.flung)
        held.hp = 0;
        mon.held = null;
        if (typeof Effects !== 'undefined') { Effects.shake(18, 24); Effects.spawnHitSpark(held.x, held.y - 40, '#ffe066', 'boom'); }
      }
    }
    if (mon.t < m[mon.phase]) return;
    switch (mon.phase) {
      case 'climb': monsterNext(mon, 'swat'); break;
      case 'swat': monsterNext(mon, 'run'); break;
      case 'run': monsterNext(mon, 'jump'); break;
      case 'jump': monsterNext(mon, 'look'); break;
      case 'look': monsterNext(mon, 'grab'); break; // reaches down whatever: the zone goes off
      case 'grab': monsterNext(mon, mon.held ? 'hold' : 'turn'); break;
      case 'hold': monsterNext(mon, 'throw'); break;
      case 'throw': monsterNext(mon, 'back'); break; // already side-on: it wheels round as it runs
      case 'turn': monsterNext(mon, 'back'); break;
      case 'back': monsterNext(mon, 'descend'); break; // ...and off down the hill
      default: state.monster = null;
    }
  }

  // One fight frame, before the fighters move.
  function update(fighters) {
    state.t++;
    updateMonster(fighters);
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

  // The giant's danger zone right now: { x1, x2, k } (k: 0 when it appears,
  // 1 as it goes off), or null.
  function monsterZone() {
    const m = def.monster, mon = state.monster;
    if (!m || !mon) return null;
    const reachAt = Math.round(m.reach * m.grab), total = m.look + reachAt;
    const t = mon.phase === 'look' ? mon.t : mon.phase === 'grab' && mon.t <= reachAt ? m.look + mon.t : -1;
    if (t < 0) return null;
    const c = mon.x + m.hand;
    return { x1: c - m.range, x2: c + m.range, k: t / total };
  }

  return {
    use, reset, update, coast: (fighters) => updateMonster(fighters, true), platforms, platform, save, load, carStart, monsterZone,
    id: () => id,
    def: () => def,
    car: () => state.car,
    monster: () => state.monster,
    time: () => state.t,
  };
})();
