// Character roster. Each entry is pure data consumed by fighter.js's
// ability-type dispatcher (see _updateAbilityState / getHitbox), so adding a
// hero generally means adding numbers here rather than new code -- unless
// their kit needs a genuinely new ability `type`.
//
// Stat tiers used across the roster (rough guide, not hard rules):
//   sizeScale:    0.85 small, 1.0 mid, 1.1-1.25 big
//   moveSpeed:    4.6 low, 5.0-5.6 medium, 6.4-6.6 high
//   attackSpeed:  total basic-attack frames (startup+active+recovery), lower
//                 is faster -- 16-19 fast, 24-27 normal, 29-32 slow, 38 slowest
//   maxHp:        135-138 low, 162-173 medium, 186-210 high
//   attack dmg:   6-7 low, 8-11 normal, 14-16 high
//   attack.high:  punches are high by default (duckable by crouching); high: false = low attack
//   blockDamageMul / blockKnockbackMul: how much of a blocked hit still gets through (default 0.15 / 0.25)
//
// Attack speed and damage are meant to trade off against each other, and
// baseline stats generally trade off against how strong a character's
// special/ultimate is -- e.g. Owen has the roster's best burst (a charged
// plasma shot and the single hardest-hitting ultimate) so he's the most
// fragile and slowest character in a straight fight; Keenan's ultimate does
// no damage at all (pure evasion) so his normal kit is fast, if weak.

const CHARACTERS = {
  keenan: {
    id: 'keenan',
    name: 'Keenan',
    title: 'Insight',
    color: '#f4c95d',
    accent: '#2e2a4a',
    sizeScale: 0.85,
    moveSpeed: 5.6,
    jumpForce: 15,
    maxJumps: 1,
    // Phase Step: while being hit (hitstun, or knocked down), press jump and
    // crouch TOGETHER to slip through the opponent and come out behind them.
    // Untouchable for the dash and a moment after; then a short cooldown.
    phaseStep: { window: 75, cooldown: 480, dashFrames: 9, invulnTail: 6, recovery: 6, behind: 85 },
    faceAfterAbility: true, // turns back to face the opponent after a phase step / counter
    ultChargeMul: 1.6, // his ultimate meter fills faster (Game.grantUltCharge)
    // Passive: for a while after taking a hit, he hits harder.
    retaliate: { damage: 0.15, frames: 300 },
    passive: { name: 'Adrenaline', description: 'For 5 seconds after taking a hit he deals 15% more damage.' },
    maxHp: 135,
    attack: {
      damage: 6, offset: 24, width: 60, height: 82,
      startup: 5, active: 3, recovery: 8,
      knockback: 6, knockbackUp: 3, hitstun: 11,
    },
    // Airborne attack: a standard front kick, a little lower and longer than his punch.
    airAttack: {
      damage: 7, offset: 22, width: 66, height: 48, high: false,
      startup: 5, active: 5, recovery: 10,
      // A kick that connects keeps him up (renewed by each kick that lands, at most maxChain times
      // per jump) and only nudges the target, so the kicks can be chained until the opponent gets away.
      knockback: 3.5, knockbackUp: 1.5, hitstun: 16,
      // He kicks off the target: each kick that lands pops him upward (pop) and back a little (recoil), and
      // for `suspend` frames gravity is only `gravity` of normal, so he arcs between kicks instead of hovering.
      suspend: 50, maxChain: 6, pop: 5, recoil: 1.2, gravity: 0.45,
    },
    special: {
      type: 'counterDodge',
      name: 'Foresight',
      description: 'Dodge briefly; a timed dodge auto-counters with a heavy strike.',
      cooldown: 4.5,
      dodgeWindow: 16,
      whiffRecovery: 12,
      counterActive: 10,
      counterRecovery: 16,
      counterDashSpeed: 16,
      counterDamage: 26,
      counterWidth: 90, counterHeight: 100,
      counterKnockback: 16, counterKnockbackUp: 5, counterHitstun: 24,
    },
    ultimate: {
      type: 'phase',
      name: 'Foreseen Escape',
      description: 'Phase out of reality briefly -- untouchable, but can only move. When he unphases he lets fly a 9-punch flurry.',
      duration: 100,
      // The flurry when the phase ends: `count` fast punches, one every `every` frames (each live for `active`),
      // while he drifts forward; the last one hits harder and knocks them back.
      flurry: {
        count: 9, start: 3, every: 4, active: 2, recovery: 14, drift: 3.2,
        offset: 24, width: 64, height: 82,
        hit: { damage: 3.2, knockback: 1.2, knockbackUp: 0.4, hitstun: 12 },
        last: { damage: 6, knockback: 9, knockbackUp: 4, hitstun: 20 },
      },
    },
  },

  artur: {
    id: 'artur',
    name: 'Artur',
    title: 'Poison Fart Frog',
    color: '#6bbf59',
    accent: '#c9f26c',
    sizeScale: 1.0,
    moveSpeed: 6.6,
    jumpForce: 15,
    maxJumps: 2,
    doubleJumpFlip: true,
    // Moving while crouched is a tuck-and-roll instead of a shuffle: still
    // the crouch/guard (same hurtbox and block), but a fair bit quicker than
    // everyone's crouch-walk (which is CROUCH_SPEED_MULTIPLIER of run speed).
    crouchRoll: { speedMul: 0.9 },
    // Passive: damage his fart clouds do builds power and attack speed.
    fartPower: { perDamage: 0.012, max: 0.4 },
    passive: { name: 'Toxic Rush', description: 'Every point of damage his farts deal feeds him: up to +40% damage and attack speed for the rest of the round.' },
    maxHp: 173,
    attack: {
      damage: 9, offset: 26, width: 70, height: 90,
      startup: 6, active: 4, recovery: 11, // (was 7 / 4 / 13: a touch quicker)
      knockback: 8, knockbackUp: 3, hitstun: 15,
      // Froggy front kick: a LOW attack. It reaches the floor so crouching
      // doesn't duck it, and it mostly goes under a crouched guard (a block
      // absorbs 45% of it instead of the usual 85%).
      high: false, blockDamageMul: 0.55, blockKnockbackMul: 0.6,
    },
    special: {
      type: 'poisonBurst',
      name: 'Poison Fart',
      description: 'A short-range toxic cloud that poisons anyone caught in it.',
      cooldown: 4.0,
      startup: 10, active: 10, recovery: 16,
      offset: 30, width: 110, height: 90,
      damage: 5, knockback: 4, knockbackUp: 2, hitstun: 10,
      poisonDamage: 3, poisonTicks: 5, poisonTickInterval: 20,
      // The cloud hangs where it was let off for this long: anyone who walks into it is poisoned while they're in it.
      lingerFrames: 84,
    },
    ultimate: {
      type: 'poisonBurst',
      name: 'Massive Fart',
      description: 'An enormous toxic blast that poisons and shoves back everything nearby.',
      startup: 16, active: 14, recovery: 22,
      offset: 10, width: 220, height: 130,
      damage: 12, knockback: 15, knockbackUp: 6, hitstun: 20,
      poisonDamage: 5, poisonTicks: 6, poisonTickInterval: 18,
      lingerFrames: 114,
    },
  },

  carlos: {
    id: 'carlos',
    name: 'Carlos',
    title: 'Iron Claw',
    color: '#7d7d8c',
    accent: '#ffb703',
    sizeScale: 1.05,
    moveSpeed: 5.2,
    jumpForce: 14,
    maxJumps: 1,
    gravityMul: 0.82, // hovers -- floatier than everyone else
    // Instead of a double jump: hold jump in the air (once the rise has
    // mostly finished) to hang in place on the thrusters for a short time.
    // Refills on landing.
    hover: { frames: 68, maxRiseSpeed: 3, lowHealthBonus: 1.0 },
    passive: { name: 'Desperate Fuel', description: 'The lower his health, the more hover fuel he has: up to double at no health.' },
    // Attack while hovering: a brief wind-up, then a spinning claw dive
    // forward and down (a drill of claws, in the spirit of Meta Knight's
    // Drill Rush). Ends on a hit or when he touches down; he can't hover
    // again until he lands.
    hoverDive: {
      startup: 5, vx: 13, vy: 8, maxFrames: 34, recovery: 14,
      offset: 8, width: 110, height: 110,
      damage: 15, knockback: 10, knockbackUp: 4, hitstun: 18,
    },
    maxHp: 173,
    attack: {
      damage: 16, offset: 28, width: 78, height: 100,
      startup: 12, active: 5, recovery: 21,
      knockback: 13, knockbackUp: 4, hitstun: 21,
    },
    special: {
      type: 'multiHit',
      name: 'Guillotine Slash',
      description: 'Rears back with a slow, obvious wind-up, then brings down one huge claw slash for massive damage.',
      cooldown: 5.5,
      // One enormous swing. The wind-up (the first ~0.45s) is the tell: the
      // claw goes overhead and the strike zone lights up on the floor, so an
      // attentive opponent can block, duck out of range or punish the recovery.
      offset: 20, width: 150, height: 130,
      hits: [
        { start: 28, end: 34 },
      ],
      recovery: 26,
      damage: 32, knockback: 13, knockbackUp: 6, hitstun: 30,
    },
    ultimate: {
      type: 'dive',
      name: 'Rending Dive',
      description: 'Launches forward with both claws for massive damage.',
      angle: 'forward',
      // A clear tell: he coils with glowing claws and the path of the dive lights up before he goes.
      startup: 26,
      tell: true,
      // If the dive lands the knockout, the whole dive still plays out (see Game.endRound) before the victory pose.
      finishOnKo: true,
      // Slower than it was (speed 19 over 26 frames): the same distance covered over a longer time, so it can be reacted to.
      travel: 31,
      recovery: 14,
      speed: 16,
      width: 100, height: 110,
      damage: 34, knockback: 20, knockbackUp: 8, hitstun: 30,
    },
  },

  nathan: {
    id: 'nathan',
    name: 'Nathan',
    title: 'Mr. Elastic',
    color: '#4c6ef5',
    accent: '#c3d4ff',
    sizeScale: 1.1,
    moveSpeed: 5.4,
    jumpForce: 15,
    maxJumps: 1,
    // Mr. Fantastic / Elastigirl rubber body: the punch stretches the arm out
    // to its (very long) reach and snaps it back; the body wobbles as it
    // moves, stretches when it jumps, and stretches and rebounds when hit,
    // blocked or reflecting. reach = how far the arm is drawn out.
    elastic: { reach: true },
    // Passive: rubber shrugs off shots (and the ball).
    projectileResist: 0.35,
    passive: { name: 'Rubber Skin', description: 'Takes 35% less damage from projectiles, including the ball.' },
    maxHp: 210,
    attack: {
      // Long-range punch: nearly twice a normal reach (the arm stretches out
      // to it), at a slightly lower damage and a touch slower to land than
      // the average jab.
      damage: 9, offset: 40, width: 135, height: 96,
      startup: 9, active: 4, recovery: 16,
      knockback: 8, knockbackUp: 3, hitstun: 16,
    },
    // W + F: both fists stretch straight up, tall enough to tag someone at the
    // top of even the highest double jump.
    upAttack: {
      damage: 9, offset: -40, width: 80, height: 520, high: false,
      startup: 9, active: 6, recovery: 20,
      knockback: 4, knockbackUp: 11, hitstun: 20,
    },
    special: {
      type: 'reflectStance',
      name: 'Rubber Guard',
      description: 'Glows red and bounces back any hit (melee or ranged) it absorbs.',
      cooldown: 5.0,
      startup: 4,
      duration: 50,
      recoveryAfter: 10,
      reflectMultiplier: 1.0,
    },
    ultimate: {
      type: 'buff',
      name: 'Overgrowth',
      description: 'Stretches taller and his punch becomes a whip that cracks down 3.5 times as far away, at a third of the damage, for a while.',
      castFrames: 20,
      duration: 300,
      reachMul: 3.5,
      reachDamageMul: 0.47, // a third of what it used to do (9 x 1.4 = 12.6 -> ~4.2)
      // Stretches up this much taller (drawn thinner to match; his hurtbox
      // grows with it, but his punches stay at his normal height).
      tallMul: 1.18,
    },
  },

  owen: {
    id: 'owen',
    name: 'Owen',
    title: 'Plasma',
    color: '#9d4edd',
    accent: '#e0aaff',
    sizeScale: 1.0,
    moveSpeed: 4.6,
    jumpForce: 14,
    maxJumps: 1,
    // Blood Donor (passive): the more health Owen has lost, the more of these
    // bonuses he gets, scaling linearly up to the full amount at zero health.
    // damage / speed multiply his damage and movement; attackSpeed makes his
    // attacks, specials and ultimate play out faster (like Encore, but only
    // while he's acting).
    bloodDonor: { damage: 0.5, attackSpeed: 0.35, speed: 0.25 },
    // Charged jump: hold jump to crouch and build power (release to go, higher
    // the longer it was held). Held to the max it's a plasma jump: he rockets
    // up, then throws his arms out and spins straight down in a whirlwind.
    chargeJump: { tapFrames: 9, maxFrames: 24, holdFrames: 50, maxForce: 21, plasmaForce: 27 },
    whirlwind: {
      startAt: -1, fallSpeed: 17, steer: 7, hitEvery: 7,
      width: 150, height: 120,
      damage: 5, knockback: 4, knockbackUp: 0, hitstun: 12,
      // the crash at the bottom
      landing: { damage: 16, width: 230, height: 110, active: 4, recovery: 16, knockback: 15, knockbackUp: 8, hitstun: 26 },
    },
    maxHp: 135,
    attack: {
      damage: 8, offset: 26, width: 66, height: 88,
      startup: 8, active: 4, recovery: 17,
      knockback: 7, knockbackUp: 3, hitstun: 14,
    },
    special: {
      type: 'projectileCharge',
      name: 'Plasma Bolt',
      description: 'Tap for a quick plasma shot, or hold to charge a devastating blast.',
      cooldown: 2.8,
      startup: 4,
      // Hold to charge: a tap of under chargeThreshold frames is the quick
      // shot; holding fills the charge (and fires the big blast) by
      // maxChargeFrames.
      maxChargeFrames: 5,
      chargeThreshold: 3,
      recovery: 14,
      quick: { speed: 22, width: 40, height: 22, damage: 9, knockback: 6, knockbackUp: 2, hitstun: 10 },
      charged: { speed: 14, width: 74, height: 52, damage: 26, knockback: 16, knockbackUp: 6, hitstun: 22 },
    },
    ultimate: {
      type: 'nuke',
      name: 'Plasma Nuke',
      description: 'Channels and unleashes a devastating plasma explosion.',
      channel: 44, // (was 26: a longer charge-up so the other player has time to react)
      radius: 240,
      offset: 20,
      recovery: 18,
      damage: 38, knockback: 22, knockbackUp: 10, hitstun: 34,
    },
  },

  robert: {
    id: 'robert',
    name: 'Robert',
    title: 'Crunch',
    color: '#5b8c5a',
    accent: '#dff2d8',
    transformColor: '#c62828',
    transformAccent: '#ffd6d6',
    sizeScale: 1.0,
    moveSpeed: 5.6,
    jumpForce: 15,
    maxJumps: 1,
    maxHp: 162,
    transform: {
      hpThreshold: 0.5,
      bonusHp: 98, // raises max HP; current health keeps the same percentage (no heal)
      sizeMul: 1.3,
      spdMul: 0.75,
      dmgMul: 1.65,
    },
    // Three hits in a row that aren't blocked or answered: he picks the
    // opponent up and slams them down, leaving them stunned on the floor.
    grabSlam: { hits: 3, window: 100, lift: 16, hold: 6, recovery: 22, damage: 16, stun: 62 },
    attack: {
      damage: 10, offset: 26, width: 74, height: 94,
      startup: 7, active: 4, recovery: 14,
      knockback: 9, knockbackUp: 3, hitstun: 16,
    },
    special: {
      type: 'slam',
      name: 'Double Fist Slam',
      description: 'Leaps and pounds the ground with both fists.',
      cooldown: 4.0,
      riseFrames: 14, riseSpeed: 14, fallSpeed: 22,
      radius: 130,
      damage: 15, knockback: 12, knockbackUp: 6, hitstun: 22,
    },
    ultimate: {
      type: 'dive',
      name: 'Body Slam',
      description: 'Charges forward and tackles the opponent with full body weight.',
      angle: 'forward',
      startup: 6,
      // Slower than it was (speed 18 over 24 frames): the same distance, over a longer time.
      travel: 29,
      recovery: 14,
      speed: 15,
      width: 110, height: 120,
      damage: 28, knockback: 20, knockbackUp: 8, hitstun: 26,
    },
  },

  ryan: {
    id: 'ryan',
    name: 'Ryan',
    title: 'Trance',
    color: '#e05ec7',
    accent: '#ffe0f5',
    sizeScale: 1.0,
    moveSpeed: 6.6,
    jumpForce: 18,
    maxJumps: 1,
    // Passive: the fuller his ultimate meter, the higher he jumps and the harder his airborne attacks hit.
    ultCrescendo: { jump: 0.25, air: 0.4 },
    passive: { name: 'Crescendo', description: 'As his ultimate meter fills he jumps up to 25% higher and hits up to 40% harder with airborne attacks.' },
    maxHp: 138,
    attack: {
      damage: 7, offset: 24, width: 64, height: 84,
      startup: 6, active: 3, recovery: 10,
      knockback: 7, knockbackUp: 3, hitstun: 12,
    },
    // Hits play notes; a string of them is a tune (see game.js / audio.js).
    comboSong: true,
    // Airborne attack: a backflip kick, the foot coming round as he rotates.
    airAttack: {
      damage: 8, offset: 12, width: 78, height: 76, high: false, flip: true,
      startup: 7, active: 8, recovery: 10,
      knockback: 7, knockbackUp: 5, hitstun: 14,
    },
    // Finale: landing the shockwave, or a combo of `combo` hits (the tune is under way), arms his
    // next air kick for `frames`: it deals more damage and knockback, then the charge is spent.
    finale: { damage: 1.5, knockback: 1.7, combo: 3, frames: 240 },
    // Midair down + F: a musical shockwave that rings out all round him and
    // stuns (little damage, no real knockback, a long daze).
    downAttack: {
      damage: 4, offset: -105, width: 210, height: 150, high: false,
      startup: 6, active: 6, recovery: 16,
      knockback: 1, knockbackUp: 0, hitstun: 50,
    },
    special: {
      type: 'soundwaveProjectile',
      name: 'Soundwave',
      description: 'Fires a wave that knocks the opponent back -- or down, if it catches them mid-swing.',
      cooldown: 3.5,
      startup: 8,
      recovery: 14,
      speed: 16, width: 100, height: 74,
      damage: 8, knockback: 14, knockbackUp: 5, hitstun: 16,
      parryKnockdown: true, knockdownDuration: 50,
    },
    ultimate: {
      type: 'buff',
      name: 'Encore',
      description: 'Kicks the tempo into overdrive -- faster attacks, faster feet.',
      castFrames: 16,
      duration: 480,
      spdMul: 1.45,
      atkSpeedMul: 1.6,
    },
  },

  sam: {
    id: 'sam',
    name: 'Sam',
    title: 'Diver',
    color: '#2ec4b6',
    accent: '#eafffb',
    sizeScale: 0.85,
    moveSpeed: 6.4,
    jumpForce: 19,
    maxJumps: 2,
    doubleJumpFlip: true,
    // Crouching lays Sam flat on the floor, belly-down, and moving is a front-
    // crawl swim (quicker than a normal crouch-walk). height/widthMul: the
    // flat hurtbox (very low, and long). If he crouches while already moving
    // (>= minSpeed) he slides on with that momentum instead -- boosted a
    // touch, and barely slowed (friction is per frame) -- until it fades
    // (endSpeed) or he lets go of crouch.
    crouchSwim: {
      speedMul: 0.5, height: 0.28, widthMul: 1.5,
      slide: { minSpeed: 3.2, boost: 1.12, friction: 0.965, endSpeed: 1.6 },
    },
    // Passive: hits landed from the air heal him a little.
    airLeech: 3,
    passive: { name: 'Second Wind', description: 'Landing a hit while airborne restores a little health.' },
    maxHp: 135,
    attack: {
      damage: 7, offset: 22, width: 60, height: 80,
      startup: 6, active: 3, recovery: 9,
      knockback: 7, knockbackUp: 3, hitstun: 12,
    },
    // Attack while airborne: a pike kick. He folds at the hips and drives both
    // straight legs out in front -- a low, long attack that reaches at foot
    // level (so a crouch doesn't duck it), with a long active window.
    airAttack: {
      damage: 9, offset: 14, width: 74, height: 62, high: false,
      startup: 5, active: 6, recovery: 10,
      knockback: 8, knockbackUp: 3, hitstun: 14,
    },
    special: {
      type: 'dive',
      name: 'Cannonball Dive',
      description: 'Dives down onto the opponent from above.',
      angle: 'down',
      cooldown: 3.2,
      startup: 6,
      travel: 30,
      recovery: 14,
      speed: 26,
      width: 80, height: 100,
      damage: 14, knockback: 10, knockbackUp: 4, hitstun: 18,
    },
    ultimate: {
      type: 'dive',
      name: 'Splashdown',
      description: 'A crushing dive that knocks the opponent down on landing.',
      angle: 'down',
      startup: 6,
      travel: 34,
      recovery: 16,
      speed: 30,
      width: 90, height: 110,
      damage: 24, knockback: 14, knockbackUp: 6, hitstun: 22,
      knockdownOnHit: true, knockdownDuration: 55,
    },
  },

  john: {
    id: 'john',
    name: 'John',
    title: 'Thicc Silb',
    color: '#a0522d',
    accent: '#ffd8a8',
    sizeScale: 1.1,
    moveSpeed: 5.0,
    jumpForce: 13,
    maxJumps: 1,
    // Passive: every hit he takes makes him jump a little higher.
    hitJump: { perHit: 0.04, max: 10 },
    passive: { name: 'Bounce Back', description: 'Each hit he takes makes his jump about 4% higher (up to 10 hits, for the rest of the round).' },
    maxHp: 186,
    attack: {
      damage: 14, offset: 32, width: 84, height: 106,
      startup: 9, active: 5, recovery: 18,
      knockback: 11, knockbackUp: 4, hitstun: 19,
    },
    // Midair down + F: drops like a stone elbow-first. Whoever it catches is
    // knocked down, leaving time for a free hit.
    downAttack: {
      damage: 12, offset: 4, width: 76, height: 84, high: false,
      startup: 4, active: 14, recovery: 14,
      slamSpeed: 15, slamVx: 2,
      knockback: 3, knockbackUp: 0, hitstun: 20,
      knockdownOnHit: true, knockdownDuration: 62,
    },
    // Three unanswered hits: he hoists the opponent over his shoulder and
    // hammers them until they wriggle free.
    grabBeat: { hits: 3, window: 100, lift: 14, punches: 6, every: 10, damage: 4, recovery: 12 },
    special: {
      type: 'lunge',
      name: 'Momentum Roll',
      description: 'Spins forward with his full weight, stunning on impact.',
      cooldown: 4.0,
      startup: 9, active: 10, recovery: 18,
      dashSpeed: 15,
      offset: 30, width: 90, height: 110,
      damage: 16, knockback: 10, knockbackUp: 3, hitstun: 40,
    },
    ultimate: {
      type: 'growRoll',
      name: 'Big Silb Roll',
      description: 'Grows huge, then rolls straight over the opponent.',
      growFrames: 14,
      sizeMul: 1.5,
      // Slower than it was (dash 20 over 22 frames): the same distance, over a longer time.
      dashSpeed: 17,
      active: 26,
      recovery: 18,
      shrinkFrames: 14,
      offset: 30, width: 120, height: 140,
      damage: 34, knockback: 22, knockbackUp: 8, hitstun: 26,
    },
  },
};

const CHARACTER_LIST = Object.values(CHARACTERS);
