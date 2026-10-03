// Visual-only animation layer. Reads a fighter's sim state (state, timers,
// velocity, ability phase) and produces a smoothly-blended "rig" the
// renderer draws: torso/leg/arm targets, whole-body rotation, and where the
// body pivots. It never writes to the sim, and derives everything from state
// that is already synced online, so both peers animate identically.
//
// The pieces:
//  - targets: what pose the current state/ability *wants* this frame, built
//    from keyframed timelines (attack wind-up -> snap -> recover, dive coil ->
//    launch -> roll-out, ...) rather than one static pose per state.
//  - channels: every pose number is exponentially smoothed toward its target
//    with a frame-rate independent rate, so pose changes never snap.
//  - body rotation: a critically-damped spring (dives, get-ups), a toppling
//    pendulum (falling over), or a deterministic spin (rolls/flips), pivoting
//    about the body's centre and lifted so the silhouette rests on the floor
//    instead of sinking through it.

const Animator = (() => {
  const TAU = Math.PI * 2;
  const LYING = -1.52; // body angle (rad) when lying on its back
  const STRETCH_W = 15, STRETCH_Z = 0.3; // rubber-stretch spring: fast, underdamped (a couple of wobbles)
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => t * t * (3 - 2 * t);
  const easeInOutSine = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);
  const wrapPi = (x) => x - TAU * Math.round(x / TAU);

  const P = (x, y, bend, hand, orb) => ({ x, y, bend, hand: hand ? 1 : 0, orb: orb ? 1 : 0 });
  const F = (x, y) => ({ x, y });

  // Arm poses. Hand positions are relative to the shoulder; index 0 is the
  // back arm (drawn first), index 1 the front/striking arm. Keeping the
  // same arm in the same slot across poses is what lets blends look right.
  function armsFor(name, k) {
    const { R, E, s } = k;
    switch (name) {
      case 'forward': return [P(-18, 20, -E), P(R, -4, E, 1)];
      case 'crossed': return [P(-6, 30, E), P(22, 18, -E)];
      case 'crossedGuard': return [P(-16, 8, 10), P(16, 8, -10)];
      case 'up': return [P(-16, -32, -E), P(16, -32, E)];
      case 'powerUp': return [P(-24, -36, -E, 1), P(24, -36, E, 1)];
      case 'guard': return [P(-10, -14, -6), P(10, -14, 6)];
      case 'aim': return [P(-14, 22, E), P(R + 2, -6, -E, 0, 1)];
      case 'shoutIn': return [P(-12, 10, E), P(12, 10, -E)];
      case 'shoutOut': return [P((R - 6) * 0.7, 10, -E), P(R - 6, -2, E)];
      case 'channelUp': return [P(-20, -26, -6), P(20, -26, 6)];
      case 'thrust': return [P(R - 6, 8, -4), P(R - 2, -10, 4)];
      case 'slash1': return [P(-16, 18, -E), P(R - 6, -22, E, 1)];
      case 'slash2': return [P(-16, -10, E), P(R - 6, 22, -E, 1)];
      case 'raisedFists': return [P(-18, -36, -E, 1), P(18, -36, E, 1)];
      case 'slamDown': return [P(-22, 34, -E, 1), P(22, 34, E, 1)];
      case 'tackle': return [P(R - 6, 4, -E * 0.5, 1), P(R, -6, E * 0.5, 1)];
      case 'diveReach': return [P(6, -40, -3, 1), P(14, -44, 3, 1)];
      case 'tuckedDive': return [P(-16, 8, E), P(16, 8, -E)];
      case 'balance': return [P(-30, -2, -6), P(30, -2, 6)];
      case 'reach': return [P(-24, -10, -6), P(24, -10, 6)];
      case 'recoil': return [P(-26, -4, -6), P(-14, -16, 6)];
      case 'limp': return [P(-10, 28, 4), P(12, 30, -4)];
      case 'flail': return [P(-24, -18, -8), P(20, -30, 8)];
      default: // 'swing' -- idle/walk: a fighting guard, rear fist by the chin and
        // lead fist out front, bobbing a little with the stride/breathing.
        return [P(22 - s * 0.25, -8 + Math.abs(s) * 0.12, E), P(34 + s * 0.25, 2 - Math.abs(s) * 0.1, -E)];
    }
  }

  function lerpArms(A, B, k) {
    return A.map((a, i) => {
      const b = B[i];
      return P(lerp(a.x, b.x, k), lerp(a.y, b.y, k), lerp(a.bend, b.bend, k), lerp(a.hand, b.hand, k) > 0.5, lerp(a.orb, b.orb, k) > 0.5);
    });
  }

  // Piecewise, eased interpolation through [[time, value], ...].
  function keys(t, pts) {
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i][0]) {
        const p = (t - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0] || 1);
        return lerp(pts[i - 1][1], pts[i][1], easeInOut(p));
      }
    }
    return pts[pts.length - 1][1];
  }

  // Basic attack: 0 = rest, negative = cocked back, 1 = fully extended.
  function attackExt(t, atk) {
    const s = atk.startup, e = s + atk.active;
    if (t <= s) return -0.45 * easeOutCubic(clamp(t / s, 0, 1));
    if (t <= e) return lerp(-0.45, 1, easeOutCubic(clamp((t - s) / Math.max(1, atk.active * 0.6), 0, 1)));
    return 1 - easeInOut(clamp((t - e) / atk.recovery, 0, 1));
  }

  // ---- Target construction ---------------------------------------------

  function baseTargets(fighter, profile, now) {
    const stride = 9 * profile.stanceMul;
    const breathe = Math.sin(now / 620);
    const T = {
      crouch: profile.idleCrouch + breathe * 0.006 + (profile.dancer ? Math.sin(now / 210) * 0.012 : 0),
      lean: breathe * 0.5 + (profile.dancer ? Math.sin(now / 420) * 2 : 0),
      fA: F(-stride, 0), fB: F(stride, 0), footPoint: 0,
      armPose: 'swing', arms: null,
      E: 8, s: Math.sin(now / 400) * 3 * (profile.dancer ? 1.7 : 1),
      float: profile.floaty ? -12 : 0, lift: 0,
      ball: 0, spin: 0, rot: 0, rotW: 16, rotZ: 1,
      topple: false, tumble: 0,
      rate: 30, slideDust: false,
    };
    return T;
  }

  function walkPose(T, fighter, profile, amp, lift, rate) {
    const cyc = fighter.walkCycle;
    const sn = Math.sin(cyc), cs = Math.cos(cyc);
    T.fA = F(sn * amp, -Math.max(0, cs) * lift);
    T.fB = F(-sn * amp, -Math.max(0, -cs) * lift);
    T.crouch += 0.03 * Math.abs(sn);
    T.s = sn * 22 * (profile.dancer ? 1.3 : 1);
    T.rate = rate;
  }

  function abilityTargets(T, fighter, def, profile, R) {
    const ab = fighter._ability || {};
    const t = fighter.actionTimer;
    const g = fighter.grounded;
    switch (def.type) {
      case 'lunge': { // John's Momentum Roll: coil -> two tight spins -> unwind
        const s = def.startup, e = s + def.active;
        const w0 = s - 3, w1 = e + 8;
        const u = clamp((t - w0) / (w1 - w0), 0, 1);
        T.spin = TAU * 2 * (0.5 * u + 0.5 * easeInOutSine(u));
        const spinning = u > 0.04 && u < 0.96;
        T.ball = spinning ? 1 : 0;
        T.rate = 45;
        if (t <= w0) {
          const c = easeOutCubic(clamp(t / w0, 0, 1));
          T.crouch = 0.28 * c; T.lean = -10 * c; T.armPose = 'crossedGuard';
          T.fA = F(-16, 0); T.fB = F(12, 0);
        } else if (spinning) {
          T.crouch = 0.36; T.lean = 8; T.armPose = 'tuckedDive';
          T.fA = F(-6, -10); T.fB = F(12, -16);
        } else {
          T.crouch = 0.1 * (1 - easeInOut(clamp((t - w1) / 12, 0, 1))); T.lean = 4;
          T.fA = F(-14, 0); T.fB = F(12, 0);
        }
        break;
      }
      case 'growRoll': { // John's Big Silb Roll: power-up -> roll -> shrink
        const a = ab;
        if (a.tGrowEnd === undefined) break;
        const w0 = a.tGrowEnd - 4, w1 = a.tRollEnd + 6;
        const u = clamp((t - w0) / (w1 - w0), 0, 1);
        T.spin = TAU * 2 * (0.5 * u + 0.5 * easeInOutSine(u));
        const spinning = u > 0.04 && u < 0.96;
        T.ball = spinning ? 1 : 0;
        T.rate = 45;
        if (t <= w0) {
          const c = clamp(t / w0, 0, 1);
          T.crouch = 0.1 + 0.16 * Math.sin(c * Math.PI * 0.5); T.lean = -6; T.armPose = 'powerUp';
          T.fA = F(-18, 0); T.fB = F(16, 0);
        } else if (spinning) {
          T.crouch = 0.36; T.lean = 8; T.armPose = 'tuckedDive';
          T.fA = F(-6, -10); T.fB = F(12, -16);
        } else {
          T.crouch = 0.12 * (1 - easeInOut(clamp((t - w1) / 14, 0, 1))); T.lean = 4;
          T.fA = F(-14, 0); T.fB = F(12, 0);
        }
        break;
      }
      case 'dive': {
        const s = def.startup;
        if (def.angle === 'down') { // Sam: tuck-and-pitch -> nose-dive -> tuck-and-roll landing
          if (ab.hasHitOrLanded) {
            const p = clamp(1 - (ab.recoveryTimer || 0) / def.recovery, 0, 1);
            T.rot = 2.85 + (TAU - 2.85) * easeInOut(p);
            T.rotW = 17;
            T.ball = p < 0.85 ? 1 : 0;
            T.crouch = p < 0.85 ? 0.34 : 0.34 * (1 - (p - 0.85) / 0.15);
            T.armPose = 'tuckedDive';
            T.fA = F(-4, -14); T.fB = F(10, -20);
            T.rate = 45;
          } else if (ab.diving) {
            T.rot = 2.85; T.rotW = 30; T.ball = 0;
            T.crouch = -0.04; T.armPose = 'diveReach';
            T.fA = F(-3, 0); T.fB = F(3, -2);
            T.rate = 50;
          } else {
            T.rot = 2.5; T.rotW = 17; T.ball = 0.6;
            T.crouch = 0.26; T.armPose = 'tuckedDive';
            T.fA = F(-4, -16); T.fB = F(10, -22);
            T.rate = 40;
          }
        } else { // Carlos/Robert: coil -> flying tackle -> get up
          if (ab.hasHitOrLanded) {
            const rt = clamp((ab.recoveryTimer || 0) / def.recovery, 0, 1);
            T.rot = 0; T.rotW = 11;
            T.crouch = 0.3 * rt; T.lean = 10 * rt; T.armPose = 'swing';
            T.fA = F(-16, 0); T.fB = F(12, 0);
            T.rate = 32;
          } else if (ab.diving) {
            T.rot = 1.38; T.rotW = 20; T.rotZ = 0.85;
            T.crouch = -0.02; T.armPose = 'diveReach';
            T.fA = F(-8, 0); T.fB = F(6, -5);
            T.rate = 55; T.slideDust = g;
            if (g) T.lift = 16 * Math.sin(Math.PI * clamp((t - s) / (def.travel * 0.55), 0, 1));
          } else {
            const c = easeOutCubic(clamp(t / s, 0, 1));
            T.rot = -0.14 * c; T.rotW = 22;
            T.crouch = 0.22 * c; T.lean = -8 * c; T.armPose = 'balance';
            T.fA = F(-18, 0); T.fB = F(10, 0);
            T.rate = 50;
          }
        }
        break;
      }
      case 'slam': { // Robert
        const rise = def.riseFrames;
        T.rate = 45;
        if (ab.hasLanded) {
          const rt = clamp((ab.recoveryTimer || 0) / 14, 0, 1);
          T.crouch = 0.08 + 0.24 * Math.pow(rt, 0.7); T.lean = 8 * rt; T.armPose = 'slamDown';
          T.fA = F(-20, 0); T.fB = F(20, 0);
        } else if (t < rise) {
          T.crouch = -0.04; T.lean = -5; T.armPose = 'raisedFists';
          T.fA = F(-8, -10); T.fB = F(10, -16);
        } else {
          T.crouch = 0.02; T.lean = 12; T.armPose = 'slamDown';
          T.fA = F(-10, 0); T.fB = F(10, -6);
        }
        break;
      }
      case 'multiHit': { // Carlos: a long wind-up, then one huge overhead-to-low slash
        const h = def.hits;
        if (h.length === 1) {
          const s0 = h[0].start, e0 = h[0].end;
          const back = P(-14, 12, -8);
          let front, lean, crouch;
          if (t <= s0) {
            // The tell: the claw goes overhead over the first 60% of the
            // wind-up, then trembles there while the body coils back.
            const p = clamp(t / s0, 0, 1);
            const rise = easeOutCubic(clamp(p / 0.6, 0, 1));
            const shake = p > 0.6 ? Math.sin(t * 2.4) * 2.4 * ((p - 0.6) / 0.4) : 0;
            front = P(lerp(12, -4, rise) + shake, lerp(14, -50, rise) + shake * 0.6, lerp(8, 12, rise), 1);
            lean = -20 * rise; crouch = 0.05 + 0.16 * rise;
          } else if (t <= e0) {
            const q = easeOutCubic(clamp((t - s0) / Math.max(1, e0 - s0), 0, 1));
            front = P(lerp(-4, R + 10, q), lerp(-50, 46, q), lerp(12, 2, q), 1);
            lean = lerp(-20, 26, q); crouch = lerp(0.21, 0.06, q);
          } else {
            // Stuck low and open after the swing: the punish window.
            const c = easeInOut(clamp((t - e0) / def.recovery, 0, 1));
            front = P(lerp(R + 10, 12, c), lerp(46, 14, c), lerp(2, 8, c), c < 0.5);
            lean = lerp(26, 0, c); crouch = lerp(0.06, 0.04, c);
          }
          T.arms = [back, front];
          T.lean = lean; T.crouch = crouch;
          T.fA = F(-18, 0); T.fB = F(18, 0);
          T.rate = t <= s0 ? 30 : 60; // the wind-up eases in; the strike snaps
          break;
        }
        const sweep = (win, from, to) => {
          const q = easeOutCubic(clamp((t - win.start) / Math.max(1, win.end - win.start), 0, 1));
          return P(lerp(from.x, to.x, q), lerp(from.y, to.y, q), lerp(from.b, to.b, q), 1);
        };
        const s1a = { x: 12, y: -46, b: 10 }, s1b = { x: R - 6, y: 14, b: 4 };
        const s2a = { x: 12, y: 30, b: -10 }, s2b = { x: R - 6, y: -30, b: -4 };
        const back = P(-16, 10, -8);
        let front;
        if (t <= h[0].start) {
          const c = easeOutCubic(clamp(t / h[0].start, 0, 1));
          front = P(lerp(12, s1a.x, c), lerp(14, s1a.y, c), lerp(8, s1a.b, c), 1);
          T.lean = -6 * c;
        } else if (t <= h[0].end) {
          front = sweep(h[0], s1a, s1b); T.lean = lerp(-6, 12, easeOutCubic(clamp((t - h[0].start) / (h[0].end - h[0].start), 0, 1)));
        } else if (t <= h[1].start) {
          const c = easeInOut(clamp((t - h[0].end) / (h[1].start - h[0].end), 0, 1));
          front = P(lerp(s1b.x, s2a.x, c), lerp(s1b.y, s2a.y, c), lerp(s1b.b, s2a.b, c), 1);
          T.lean = lerp(12, 4, c);
        } else if (t <= h[1].end) {
          front = sweep(h[1], s2a, s2b); T.lean = lerp(4, 12, easeOutCubic(clamp((t - h[1].start) / (h[1].end - h[1].start), 0, 1)));
        } else {
          const c = easeInOut(clamp((t - h[1].end) / def.recovery, 0, 1));
          front = P(lerp(s2b.x, 12, c), lerp(s2b.y, 14, c), lerp(s2b.b, 8, c), c < 0.5);
          T.lean = 12 * (1 - c);
        }
        T.arms = [back, front];
        T.fA = F(-14, 0); T.fB = F(14, 0);
        T.crouch = 0.04;
        T.rate = 60;
        break;
      }
      case 'counterDodge': { // Keenan
        if (ab.phase === 'counter') {
          T.lean = 18; T.crouch = 0.1; T.armPose = 'forward'; T.E = 3;
          T.fA = F(-22, 0); T.fB = F(20, 0); T.rate = 55;
        } else if (ab.phase === 'dodge') {
          T.lean = -20; T.crouch = 0.14; T.armPose = 'guard';
          T.fA = F(-16, 0); T.fB = F(8, 0); T.rate = 50;
        } else {
          T.lean = -6; T.crouch = 0.05; T.armPose = 'guard';
          T.fA = F(-14, 0); T.fB = F(10, 0);
        }
        break;
      }
      case 'projectileCharge':
        T.lean = 4; T.armPose = 'aim';
        T.crouch = 0.04 + Math.min((ab.chargeFrames || 0) / 20, 1) * 0.06;
        T.fA = F(-14, 0); T.fB = F(14, 0);
        break;
      case 'soundwaveProjectile':
        T.lean = ab.fired ? 10 : -6; T.armPose = ab.fired ? 'shoutOut' : 'shoutIn';
        T.fA = F(-14, 0); T.fB = F(14, 0); T.rate = 45;
        break;
      case 'nuke':
        T.lean = ab.fired ? 10 : -4; T.armPose = ab.fired ? 'thrust' : 'channelUp';
        T.crouch = ab.fired ? 0.08 : 0; T.fA = F(-16, 0); T.fB = F(16, 0); T.rate = 45;
        break;
      case 'reflectStance':
        T.crouch = 0.08; T.armPose = 'crossedGuard';
        T.fA = F(-16, 0); T.fB = F(16, 0);
        break;
      case 'buff':
        T.lean = -6; T.armPose = 'powerUp';
        T.crouch = 0.05 * Math.sin(clamp(t / Math.max(1, def.castFrames || 20), 0, 1) * Math.PI);
        T.fA = F(-14, 0); T.fB = F(14, 0);
        break;
      case 'poisonBurst':
        T.lean = -22; T.armPose = 'balance';
        T.fA = F(-20, 0); T.fB = F(20, 0);
        break;
      default:
        T.armPose = 'forward'; T.fA = F(-16, 0); T.fB = F(16, 0);
    }
  }

  // Crouch-roll (Artur): a curled ball turning with the distance covered.
  // A ninja tumble: knees hauled up to the chest, arms wrapped in, chin
  // tucked (the head tilt is applied after the clip step, which resets it).
  function rollPose(T, an) {
    T.crouch = 0.5; T.lean = 16; T.armPose = 'tuckedDive';
    T.arms = [P(2, 20, -8, 0), P(14, 26, 8, 0)];
    T.ball = 1; T.spin = an.rollAngle || 0;
    T.fA = F(0, -22); T.fB = F(14, -28);
    T.rate = 50;
  }

  // Sam's crouch: flat on his belly, head forward, front-crawling along the
  // floor (arms reaching and pulling in turn, flutter kicks). The strokes
  // slow to a lazy tread when he's not going anywhere, and stop for a
  // streamlined glide while he slides on momentum.
  function swimPose(T, fighter, an) {
    const moving = Math.abs(fighter.vx) > 0.4, gliding = fighter.sliding;
    const ph = an.swimPhase || 0;
    const k = moving || gliding ? 1 : 0.35;
    const s = gliding ? 0 : Math.sin(ph) * k;
    T.rot = 1.5; T.rotW = 18; T.rotZ = 0.9; // level with the floor, head forward
    T.crouch = 0.02; T.lean = gliding ? -4 : 0;
    // The body is horizontal, so "up the body" is forward: arms reach out along it.
    T.arms = [P(-4, -50 + 16 * s, -4, 1), P(6, -50 - 16 * s, 4, 1)];
    const kick = gliding ? 0 : Math.sin(ph * 1.9) * 10 * k;
    T.fA = F(-6 + kick, 0); T.fB = F(6 - kick, 0);
    T.rate = 45;
  }

  function computeTargets(fighter, profile, an, now) {
    const T = baseTargets(fighter, profile, now);
    const id = fighter.character.id;
    const st = fighter.state;
    const t = fighter.actionTimer;
    const R = 46 + profile.reachBoost;
    const g = fighter.grounded;
    const stance = profile.stanceMul;

    switch (st) {
      case 'walk':
        walkPose(T, fighter, profile, 20 * stance, 9, 55);
        break;

      case 'jump':
      case 'fall': {
        const k = clamp((fighter.vy + 5) / 12, 0, 1); // 0 = launching, 1 = falling
        T.fA = F(lerp(-10, -6, k), lerp(-8, -2, k));
        T.fB = F(lerp(12, 8, k), lerp(-18, 0, k));
        T.crouch = lerp(-0.035, 0.0, k);
        T.lean = lerp(4, 0, k);
        T.rate = 34;
        T.arms = lerpArms(armsFor('up', { R, E: 8, s: 0 }), armsFor('reach', { R, E: 8, s: 0 }), k);
        if (fighter.hovering) { // hanging on the thrusters: legs dangle, arms out for balance
          T.crouch = 0; T.lean = 0;
          T.fA = F(-7, -5); T.fB = F(8, -3);
          T.arms = armsFor('reach', { R, E: 8, s: 0 });
          T.float = profile.floaty ? -20 : -8;
          T.rate = 30;
        }
        if (fighter.airSuspend > 0 && fighter.character.airAttack && fighter.character.airAttack.suspend) {
          // Just kicked off the target: knees snap up and arms fling out, then he coils for the next kick as he drifts back down.
          const ph = fighter.airSuspend / fighter.character.airAttack.suspend; // 1 = the kick just landed
          const snap = clamp((ph - 0.75) / 0.25, 0, 1);
          T.crouch = 0.1 + 0.1 * snap; T.lean = lerp(-2, -12, snap);
          T.fA = F(lerp(-6, -2, snap), lerp(-16, -26, snap));
          T.fB = F(lerp(16, 10, snap), lerp(-24, -30, snap));
          T.arms = lerpArms(armsFor('balance', { R, E: 8, s: 0 }), armsFor('flail', { R, E: 8, s: 0 }), snap);
          T.rate = 55;
        }
        if (fighter.doubleJumpFlipTimer > 0 && fighter.character.doubleJumpFlip) {
          const u = 1 - fighter.doubleJumpFlipTimer / 24;
          T.spin = TAU * easeInOutSine(u) * (fighter.doubleJumpFlipDir || 1);
          T.ball = u > 0.06 && u < 0.94 ? 0.85 : 0;
          T.crouch = 0.22; T.armPose = 'tuckedDive'; T.arms = null;
          T.fA = F(-2, -20); T.fB = F(12, -24); T.rate = 45;
        }
        break;
      }

      case 'block': {
        T.crouch = 0.47; T.lean = 6; T.armPose = 'crossed';
        if (fighter.guarding) { // a full guard: standing tall behind crossed forearms
          T.crouch = 0.06; T.lean = -3; T.armPose = 'crossedGuard';
          T.fA = F(-14 * stance, 0); T.fB = F(14 * stance, 0);
          T.rate = 45;
        } else if (fighter.character.crouchSwim) { // Sam: flat on the floor, swimming
          swimPose(T, fighter, an);
        } else if (fighter.rolling) { // crouch-move as a tucked ball rolling along the floor
          rollPose(T, an);
        } else if (Math.abs(fighter.vx) > 0.4) {
          walkPose(T, fighter, profile, 10 * stance, 4, 45);
          T.crouch = 0.47 + 0.03 * Math.abs(Math.sin(fighter.walkCycle));
          T.s = 0; T.armPose = 'crossed';
        } else {
          T.fA = F(-15 * stance, 0); T.fB = F(15 * stance, 0);
          T.rate = 40;
        }
        break;
      }

      case 'attack': {
        const atk = fighter.attackBox(fighter.attackDef);
        const ext = attackExt(t, atk);
        const heavy = id === 'john' || id === 'robert';
        T.rate = 60;
        if (fighter.downAttackActive && id === 'john') { // elbow first, dropping like a stone
          T.lean = 48; T.crouch = 0.14;
          T.arms = [P(-14, 20, -6, 1), P(28, 36, -16, 1)];
          T.fA = F(-8, -12); T.fB = F(12, -8);
          T.rate = 60;
        } else if (fighter.downAttackActive) { // Ryan: arms flung wide, belting out the shockwave
          const pulse = clamp((t - atk.startup) / Math.max(1, atk.active), 0, 1);
          T.arms = [P(-40 - 8 * pulse, -26 + 10 * (1 - pulse), 0, 1), P(40 + 8 * pulse, -26 + 10 * (1 - pulse), 0, 1)];
          T.crouch = 0.1 + 0.08 * (1 - pulse); T.lean = 0;
          T.fA = F(-12, -14); T.fB = F(12, -14);
          T.rate = 50;
        } else if (fighter.airAttackActive && atk.flip) { // Ryan: a backflip with the kick swinging through
          const total = atk.startup + atk.active + atk.recovery;
          const u = clamp(t / total, 0, 1);
          const kick = Math.sin(clamp((t - atk.startup) / Math.max(1, atk.active), 0, 1) * Math.PI);
          T.spin = -TAU * easeInOutSine(u);
          T.ball = u < 0.22 ? 0.75 * (1 - u / 0.22) : 0;
          T.crouch = 0.14 * (1 - kick); T.armPose = 'tuckedDive'; T.arms = null;
          T.fA = F(-6, -16); T.fB = F(lerp(8, 52, kick), lerp(-14, -26, kick));
          T.footPoint = kick;
          T.rate = 55;
        } else if (fighter.airAttackActive && id === 'sam') { // Sam's pike kick: knees up, then both legs driven straight out, folded at the hips
          const tuck = ext < 0 ? -ext / 0.45 : 0, drive = ext > 0 ? ext : 0;
          if (ext < 0) {
            T.fA = F(lerp(-6, 16, tuck), lerp(0, -34, tuck));
            T.fB = F(lerp(8, 24, tuck), lerp(0, -28, tuck));
            T.lean = 26 * tuck;
          } else {
            // (reaching a little past full leg length, so the legs lock out straight)
            T.fA = F(lerp(16, 66, drive), lerp(-34, -50, drive));
            T.fB = F(lerp(24, 72, drive), lerp(-28, -46, drive));
            T.lean = lerp(26, 72, drive);
          }
          T.crouch = 0.08;
          // (the torso is folded forward, so "toward the toes" is along the torso's own axis, past the head)
          T.arms = [P(lerp(10, 2, drive), lerp(18, -46, drive), 0, 1), P(lerp(16, 10, drive), lerp(24, -50, drive), 0, 1)];
        } else if (fighter.upAttackActive) { // Nathan: both fists shoot straight up, arms stretched way out
          const wind = ext < 0 ? -ext / 0.45 : 0, drive = ext > 0 ? ext : 0;
          const dm = typeof Renderer !== 'undefined' && Renderer.bodyDims ? Renderer.bodyDims(id, fighter.height, fighter.transformed) : null;
          const armLen = dm ? (dm.arm.upper + dm.arm.fore) * 0.97 : fighter.height * 0.4;
          const y = lerp(lerp(10, 26, wind), -(atk.height * 0.88), Math.pow(drive, 0.7));
          T.arms = [P(-10 - 6 * drive, y, -4, 1), P(10 + 6 * drive, y, 4, 1)];
          for (const a of T.arms) a.stretch = Math.max(1, Math.abs(y + 20) / armLen);
          T.crouch = 0.05 + 0.12 * wind; T.lean = -4 * drive;
          T.fA = F(-10, 0); T.fB = F(10, 0);
        } else if (fighter.buffReachMul > 1 && fighter.character.elastic) { // Nathan's Overgrowth: the arm whips up overhead and cracks down onto the target
          const H = fighter.height;
          const dm = typeof Renderer !== 'undefined' && Renderer.bodyDims ? Renderer.bodyDims(id, H, fighter.transformed) : null;
          // Phases: raise the arm overhead (first part of the startup), whip it
          // over and down onto the target (landing on the first frame the hit
          // is live), then reel it straight back in over the recovery.
          const raiseEnd = atk.startup * 0.4, strikeEnd = atk.startup + 1;
          const raise = easeOutCubic(clamp(t / raiseEnd, 0, 1));
          const s = clamp((t - raiseEnd) / (strikeEnd - raiseEnd), 0, 1);
          const recovering = t > atk.startup + atk.active;
          const reel = recovering ? ext : 1; // 1 = fully out, 0 = back at the body
          T.crouch = 0.05 + 0.06 * raise * (1 - s); T.lean = -8 * raise * (1 - s) + 6 * s * reel;
          T.fA = F(-14 * stance, 0); T.fB = F(10 * stance, 0);
          T.rate = 110; // snappier than other moves: a whip doesn't drift
          T.arms = [P(-12 - 8 * s * reel, 16 - 6 * s * reel, -8), P(12, 14, 8, 1)];
          if (dm) {
            // Worked in the body's own frame (feet at 0, y down) and then
            // carried back through what the renderer does to the pose (see
            // drawPlaceholder): the body is stretched taller (vs) and thinner
            // (1/sqrt(vs)) from the feet, the arm leans with the torso about
            // the hip, and hand targets are offsets from the shoulder line
            // scaled by armScale. The fist comes down near the far end of the
            // hitbox, inside its band of height -- the punch doesn't rise
            // with the stretch, so it can't sail over anyone.
            const vs = an.vs || 1, as = profile.armScale, c = 1 - T.crouch;
            const shoulderY = -H * dm.shoulderFrac * c, hipY = -H * dm.hipFrac * c, shLine = shoulderY + H * 0.03;
            const sx = H * 0.052 * dm.fs, sy = shoulderY + H * 0.034;
            const bottom = H * HIGH_ATTACK_BOTTOM;
            const fistUp = clamp(-shoulderY * vs, bottom + atk.height * 0.3, bottom + atk.height * 0.7);
            const tx = (atk.offset + atk.width) * 0.9 * Math.sqrt(vs), ty = -fistUp / vs;
            const armLen = dm.arm.upper + dm.arm.fore;
            const L = Math.hypot(tx - sx, ty - sy), aT = Math.atan2(ty - sy, tx - sx);
            const aUp = (-95 * Math.PI) / 180; // straight up, a touch back
            // The fist swings over and down while the arm pays out, most of
            // the length coming late, so it arcs over at about head height
            // and cracks down onto the target like a whip.
            let ang, len, bow = 0, w;
            if (recovering) { ang = aT; len = lerp(armLen * 0.7, L, reel); w = clamp(reel * 1.6, 0, 1); }
            else if (s > 0) { ang = lerp(aUp, aT, Math.pow(s, 0.8)); len = lerp(armLen * 0.95, L, Math.pow(s, 1.8)); bow = Math.sin(Math.PI * s) * 0.1; w = 1; }
            else { ang = aUp; len = armLen * 0.95; w = raise; }
            let hx = sx + Math.cos(ang) * len, hy = sy + Math.sin(ang) * len;
            // The torso's lean rotates the arm about the hip; undo it.
            const r = (-T.lean * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
            [hx, hy] = [hx * cs - (hy - hipY) * sn, hipY + hx * sn + (hy - hipY) * cs];
            const hand = T.arms[1];
            hand.x = lerp(hand.x, hx / as, w); hand.y = lerp(hand.y, (hy - shLine) / as, w);
            // Bones just short of the distance lock the arm out straight; mid
            // swing they're a bit long, so the arm bows back behind the fist
            // (the elbow hint on the trailing, upper side) like a cracking whip.
            const dist = Math.hypot(hand.x * as - sx, shLine + hand.y * as - sy);
            hand.stretch = Math.max(1, (dist * (0.96 + bow)) / armLen);
            if (bow > 0) {
              const mx = (sx + hx) / 2 + Math.sin(ang) * len * 0.3, my = (sy + hy) / 2 - Math.cos(ang) * len * 0.3;
              hand.ex = mx / as; hand.ey = (my - shLine) / as;
            }
          }
        } else if (id === 'artur' || fighter.airAttackActive) { // front kick (Artur's froggy one; Keenan's in the air): chamber the knee, then drive the foot out
          const hipY = -fighter.height * 0.38;
          const chamber = ext < 0 ? -ext / 0.45 : 0;
          const drive = ext > 0 ? ext : 0;
          T.fA = F(-6 * stance, 0);
          T.fB = F(lerp(lerp(9 * stance, 12, chamber), fighter.height * 0.42, drive), lerp(lerp(0, hipY * 0.42, chamber), hipY * 0.6, drive));
          T.footPoint = clamp(chamber * 0.7 + drive, 0, 1);
          T.lean = ext < 0 ? ext * -10 : -6 * ext;
          T.crouch = 0.05 + 0.03 * chamber;
          T.armPose = 'balance';
        } else {
          const cockAmt = ext < 0 ? -ext / 0.45 : 0;
          const rest = { x: 12, y: 14 }, cock = { x: -10, y: 6 }, out = { x: R, y: -4 };
          let hx, hy, hb;
          if (ext >= 0) { hx = lerp(rest.x, out.x, ext); hy = lerp(rest.y, out.y, ext); hb = lerp(8, 3, ext); }
          else { hx = lerp(rest.x, cock.x, cockAmt); hy = lerp(rest.y, cock.y, cockAmt); hb = lerp(8, 12, cockAmt); }
          const backPull = Math.max(0, ext);
          T.arms = [P(-12 - 8 * backPull, 16 - 6 * backPull, -8), P(hx, hy, hb, 1)];
          T.lean = ext >= 0 ? ext * (heavy ? 18 : 13) : ext * (heavy ? 18 : 12);
          const sp = (heavy ? 20 : 14) * stance;
          T.fA = F(-sp - 2 * Math.max(0, ext), 0);
          T.fB = F(sp * 0.7 + 8 * Math.max(0, ext), 0);
          T.crouch = 0.05 + 0.04 * Math.max(0, ext) + 0.04 * cockAmt;
        }
        break;
      }

      case 'special':
      case 'ultimate': {
        const def = st === 'ultimate' ? fighter.character.ultimate : fighter.character.special;
        T.rate = 40;
        T.fA = F(-18 * stance, 0); T.fB = F(18 * stance, 0);
        T.armPose = 'forward';
        abilityTargets(T, fighter, def, profile, R);
        break;
      }

      case 'hoverdive': { // Carlos: claws out, then a spinning nose-down dive
        const ab = fighter._ability || {};
        if (ab.diving) {
          T.rot = 2.1; T.rotW = 26; T.rotZ = 0.85; // head leading, down along the dive
          T.crouch = -0.02; T.armPose = 'diveReach';
          T.fA = F(-4, 0); T.fB = F(6, -4);
          T.rate = 60;
        } else if (ab.ended) {
          T.rot = 0; T.rotW = 12;
          T.crouch = 0.25; T.lean = 12; T.armPose = 'swing';
          T.fA = F(-16, 0); T.fB = F(12, 0);
          T.rate = 34;
        } else {
          T.rot = 0.3; T.rotW = 22; // coiling in the air, claws coming round
          T.crouch = 0.14; T.lean = 10; T.armPose = 'diveReach';
          T.fA = F(-6, -10); T.fB = F(10, -14);
          T.rate = 50;
        }
        break;
      }

      case 'phasestep': { // Keenan slipping through the opponent: a low, fast, leaning dash
        const ps = fighter.character.phaseStep;
        const u = clamp(t / ps.dashFrames, 0, 1);
        T.lean = lerp(30, 6, u); T.crouch = lerp(0.3, 0.12, u);
        T.armPose = 'forward'; T.E = 4;
        T.fA = F(-26, 0); T.fB = F(22, 0);
        T.rate = 70;
        break;
      }

      case 'jumpcharge': { // Owen: sinking into the crouch, fists clenched at his sides
        const cj = fighter.character.chargeJump;
        const f = clamp(fighter.jumpCharge / cj.maxFrames, 0, 1);
        T.crouch = 0.12 + 0.3 * f; T.lean = 8 * f; T.armPose = 'slamDown';
        T.fA = F(-16, 0); T.fB = F(16, 0);
        T.rate = 40;
        break;
      }

      case 'whirlwind': { // Owen: arms straight out, spinning about his own axis on the way down
        const ab = fighter._ability || {};
        if (ab.landing) {
          T.crouch = 0.3; T.lean = 10; T.armPose = 'slamDown';
          T.fA = F(-18, 0); T.fB = F(16, 0);
          T.rate = 40;
        } else {
          T.crouch = -0.02; T.lean = 0;
          T.arms = [P(-50, -14, 0, 1), P(50, -14, 0, 1)];
          T.fA = F(-8, -12); T.fB = F(10, -18);
          T.rate = 60;
        }
        break;
      }

      case 'grabslam': { // Robert: heave the opponent overhead, then drive them into the floor
        const gs = fighter.character.grabSlam;
        const lift = clamp(t / gs.lift, 0, 1);
        if (t <= gs.lift + gs.hold) {
          T.arms = [P(lerp(-18, -16, lift), lerp(10, -40, lift), -4, 1), P(lerp(18, 16, lift), lerp(10, -40, lift), 4, 1)];
          T.crouch = lerp(0.2, -0.02, lift); T.lean = lerp(14, -10, lift);
        } else {
          const r = clamp((t - gs.lift - gs.hold) / 8, 0, 1);
          T.arms = [P(lerp(-16, 10, r), lerp(-40, 34, r), 0, 1), P(lerp(16, 26, r), lerp(-40, 34, r), 0, 1)];
          T.crouch = 0.12 + 0.26 * r; T.lean = lerp(-10, 26, r);
        }
        T.fA = F(-18, 0); T.fB = F(16, 0);
        T.rate = 50;
        break;
      }

      case 'grabbeat': { // John: heave them up onto the shoulder, then hammer away
        const gb = fighter.character.grabBeat;
        if (t <= gb.lift) {
          const lift = clamp(t / gb.lift, 0, 1);
          T.arms = [P(lerp(-14, -20, lift), lerp(10, -20, lift), -4, 1), P(lerp(16, 6, lift), lerp(10, -26, lift), 4, 1)];
          T.crouch = lerp(0.22, 0.04, lift); T.lean = lerp(14, -6, lift);
        } else {
          const ph = ((t - gb.lift) % gb.every) / gb.every, e = Math.sin(ph * Math.PI);
          const right = Math.floor((t - gb.lift) / gb.every) % 2 === 0;
          const out = P(lerp(14, R, e), lerp(12, -4, e), 0, 1), back = P(-8, 14, -6, 1);
          T.arms = right ? [back, out] : [out, back];
          T.lean = 6 + 10 * e; T.crouch = 0.08;
        }
        T.fA = F(-16, 0); T.fB = F(14, 0);
        T.rate = 60;
        break;
      }

      case 'grabbed': { // the one being carried: upside down, kicking
        const wig = Math.sin(now / 55);
        if (fighter.heldByStage) {
          // In the orchard giant's fist (stages.js): upright, squeezed round
          // the middle, arms flailing above it and legs kicking below.
          T.spin = 0; T.armPose = 'flail'; T.crouch = 0.02; T.lean = 4 * wig;
          T.fA = F(-8 + 9 * wig, -6 * Math.abs(wig)); T.fB = F(8 - 9 * wig, -6 * Math.abs(Math.cos(now / 55)));
          T.rate = 50;
          break;
        }
        T.spin = Math.PI * 0.92;
        T.armPose = 'flail'; T.crouch = 0.04;
        T.fA = F(-10 + 5 * wig, -12); T.fB = F(10 - 5 * wig, -16);
        T.rate = 50;
        break;
      }

      case 'hitstun': {
        const stagger = profile.staggerMul * (fighter.transformed ? 0.6 : 1);
        const p = clamp(t / Math.max(10, fighter.stunFrames || 10), 0, 1);
        const fl = (1 - p) * (1 - p);
        T.lean = -(10 + 22 * fl) * stagger;
        T.crouch = 0.05 + 0.07 * fl;
        T.armPose = 'recoil';
        T.rate = 62;
        if (g) { T.fA = F(-22, 0); T.fB = F(10, 0); }
        else { T.fA = F(-12, -8); T.fB = F(10, -14); T.rot = -0.22 * stagger; }
        break;
      }

      case 'knockdown':
      case 'ko': {
        T.topple = true;
        T.rate = 45;
        T.float = 0;
        if (g) {
          T.rot = LYING; T.rotW = 24; T.rotZ = 0.8;
          T.armPose = 'limp'; T.crouch = 0.04;
          T.fA = F(-14, 0); T.fB = F(14, 0);
        } else {
          T.rot = -(0.9 + 0.6 * clamp(Math.abs(fighter.vx) / 12, 0, 1));
          T.rotW = 10; T.rotZ = 0.75;
          T.armPose = 'flail'; T.crouch = 0.05;
          T.fA = F(-16, -6); T.fB = F(14, -14);
          // Knocked out of the arena: keep tumbling on the way down.
          if (st === 'ko' && fighter.y > GROUND_Y + 6) T.tumble = -0.16;
        }
        break;
      }

      case 'victory': {
        const b = Math.abs(Math.sin(now / 170));
        T.lift = b * 9;
        T.crouch = 0.05 * (1 - b);
        T.fA = F(-10, -6 * b); T.fB = F(10, -6 * b);
        const ph = Math.sin(now / 170 * 2) * 8;
        T.arms = [P(-24, -36 + ph, -8, 1), P(24, -36 - ph, 8, 1)];
        T.rate = 40;
        break;
      }

      default: // idle
        T.fA = F(-9 * stance, 0); T.fB = F(9 * stance, 0);
        break;
    }

    // Rising from the floor: fold the body into a crouch while it unrolls.
    if (an.getup > 0) {
      const gu = easeInOut(an.getup);
      T.crouch += 0.3 * gu;
      T.rotW = 9; T.rotZ = 1;
      T.rate = Math.min(T.rate, 32);
    }
    // Landing squash.
    if (an.landT > 0) {
      T.crouch += (0.06 + 0.2 * an.landImpact) * an.landT * (fighter.character.elastic ? 1.6 : 1); // rubber squashes more
      T.rate = Math.max(T.rate, 46);
    }
    // Carlos only hovers while upright.
    if (T.rot !== 0 && Math.abs(T.rot) > 0.5) T.float = 0;

    // Finishing the last part of a roll after the fighter has stopped: keep
    // the curled ball pose (over any clip) until the turn completes.
    const rollFinish = !fighter.rolling && an.rollAngle !== 0 && an.rollAngle !== undefined;
    if (rollFinish) rollPose(T, an);
    if (!T.arms) T.arms = armsFor(T.armPose, { R, E: T.E, s: T.s });
    // (an air attack is hand-posed: the punch clip would fight it)
    applyClip(T, fighter, an, now, rollFinish || (fighter.state === 'attack' && (fighter.airAttackActive || fighter.upAttackActive || fighter.downAttackActive || (fighter.buffReachMul > 1 && fighter.character.elastic))));
    if (fighter.rolling || rollFinish) T.headTilt = 38; // chin tucked into the chest
    else if (fighter.state === 'block' && fighter.character.crouchSwim && !T.clip) T.headTilt = -22; // chin up, looking ahead as he swims
    // Long-armed characters (Nathan): every arm pose reaches proportionally further.
    if (profile.armScale !== 1 && !T.clip) {
      T.arms = T.arms.map((a) => ({
        ...a, x: a.x * profile.armScale, y: a.y * profile.armScale,
        ...(a.ex !== undefined ? { ex: a.ex * profile.armScale, ey: a.ey * profile.armScale } : {}),
      }));
    }
    return T;
  }

  // ---- Motion-capture clips (mocap.js) ------------------------------------
  // When moves.json gives this character a clip for the current move, the
  // clip drives the whole pose. Clips store directions (bone angles, spine
  // lean, shoulder placement), so the pose is rebuilt here with this
  // fighter's own bone lengths and then stood on the floor -- the motion is
  // the clip's, the proportions stay the character's.
  //
  // Timing: an attack's wind-up is compressed just enough that the clip's
  // impact lands in the middle of the attack's active (hitbox) frames; the
  // recovery then plays at the clip's real speed, carrying on after the
  // attack while the fighter only stands or walks. Hit reactions play at
  // real speed too. Idle, walk and victory loop; block holds its peak.

  const IMPACT_HOLD_MS = 70;   // visual freeze at full extension
  const EXAGGERATE = 1.12;     // strikes pushed this much further from the guard

  // Default shoulder placement (renderer's), relative to the top of the
  // shoulders in the torso's frame, for blending in and out of clips.
  function defaultShoulders(fighter) {
    if (typeof Renderer === 'undefined' || !Renderer.bodyDims) return null;
    const d = Renderer.bodyDims(fighter.character.id, fighter.height, fighter.transformed);
    const H = fighter.height;
    return [F(-H * 0.042 * d.fs, H * 0.024), F(H * 0.052 * d.fs, H * 0.034)];
  }

  // Which clip is playing and where in it (0-1), or null.
  function clipPlayback(fighter, an, now) {
    if (typeof Mocap === 'undefined') return null;
    const st = fighter.state;
    const t = fighter.actionTimer;
    const id = fighter.character.id;
    const settling = st === 'idle' || st === 'walk';
    if (Mocap.debug && Mocap.debug.time !== null) {
      const clip = Mocap.clipFor(id, st);
      return clip ? { clip, u: Mocap.debug.time } : null;
    }

    // Jumps: the clip's airborne stretch follows the jump (by vertical
    // speed); the landing plays out at real speed afterwards. A double jump
    // can have its own clip ('jump2', e.g. a flip).
    const airborne = st === 'jump' || st === 'fall';
    if (airborne) {
      const single = Mocap.clipFor(id, 'jump');
      let two = fighter.jumpsUsed >= 2 && Mocap.clipFor(id, 'jump2');
      // Once the flip is done, fall like any other jump.
      if (two && single && an.mocap && (an.mocap.flipped || (an.mocap.clip === two && now - an.mocap.since > 650))) two = null;
      const clip = two || single;
      if (clip) {
        let mo2 = an.mocap;
        if (!mo2 || mo2.clip !== clip) {
          const flipped = !two && fighter.jumpsUsed >= 2 && !!Mocap.clipFor(id, 'jump2');
          mo2 = an.mocap = { state: two ? 'jump2' : 'jump', clip, since: now, landedAt: null, flipped };
        }
        const [a0, a1] = clip.air || clip.window || [0, 1];
        let u;
        if (two) { // the flip in ~0.6s; played backwards it's the backflip
          const pr = Math.min(1, (now - mo2.since) / 600);
          u = a0 + (a1 - a0) * (fighter.doubleJumpFlipDir < 0 ? 1 - pr : pr);
        }
        else {
          const v0 = fighter.character.jumpForce || 15;
          u = a0 + (a1 - a0) * clamp((fighter.vy + v0) / (2 * v0), 0, 1);
        }
        return { clip, u, oneShot: true, air: true };
      }
    }
    // Landing after a jump clip.
    if (an.mocap && (an.mocap.state === 'jump' || an.mocap.state === 'jump2') && settling) {
      const mo2 = an.mocap, c = mo2.clip;
      if (mo2.landedAt === null) mo2.landedAt = now;
      // (at real speed, but never longer than ~0.3s -- landings shouldn't feel sluggish)
      const a1 = c.air ? c.air[1] : (c.window || [0, 1])[1], end = (c.window || [0, 1])[1];
      const rate = Math.max(1 / Math.max(0.1, c.duration), (end - a1) / 0.3);
      const u = a1 + ((now - mo2.landedAt) / 1000) * rate;
      if (u < end) return { clip: c, u, oneShot: true, from: c.air ? c.air[1] : null };
      an.mocap = null;
    }

    // Getting up after a knockdown: the fall played backwards, quickly.
    if (an.mocap && an.mocap.state === 'knockdown' && st !== 'knockdown' && st !== 'ko' && st !== 'hitstun') {
      const mo2 = an.mocap, c = mo2.clip;
      if (!mo2.upAt) mo2.upAt = now;
      const ws = (c.window || [0, 1])[0], down = Math.max(ws, c.down || 1);
      const k = (now - mo2.upAt) / 450;
      if (k < 1) return { clip: c, u: down - (down - ws) * easeInOut(k), oneShot: true, fall: true };
      an.mocap = null;
    }

    // Knockdowns and KOs: the fall (compressed to fit), then lie there.
    if (st === 'knockdown' || st === 'ko') {
      const clip = Mocap.clipFor(id, st);
      if (!clip) { an.mocap = null; return null; }
      let mo2 = an.mocap;
      if (!mo2 || mo2.state !== st || mo2.clip !== clip) mo2 = an.mocap = { state: st, clip, since: now };
      const ws = (clip.window || [0, 1])[0], down = Math.max(ws, clip.down || 1);
      const fallMs = Math.min(700, (down - ws) * clip.duration * 1000);
      const u = ws + (down - ws) * Math.min(1, (now - mo2.since) / Math.max(1, fallMs));
      return { clip, u, oneShot: true, fall: true };
    }

    // A one-shot (attack, hit reaction) that's still playing out.
    let mo = an.mocap;
    if (mo && (mo.state === 'knockdown' || mo.state === 'ko' || mo.state === 'jump' || mo.state === 'jump2')) an.mocap = mo = null;
    if (st === 'attack' || st === 'hitstun') {
      const clip = Mocap.clipFor(id, st);
      if (!clip) { an.mocap = null; return null; }
      if (!mo || mo.state !== st || mo.clip !== clip || t < mo.t) mo = an.mocap = { state: st, clip, since: now, hitAt: null, t };
      mo.t = t;
    } else if (!(mo && settling)) {
      an.mocap = mo = null;
    }
    if (mo) {
      const c = mo.clip, [ws, we] = c.window || [0, 1];
      const secs = (ms) => (ms / 1000) / Math.max(0.1, c.duration);
      let u;
      if (mo.state === 'attack') {
        const a = fighter.character.attack;
        const hit = a.startup + a.active * 0.5;
        // Anticipation: the wind-up starts slow and accelerates into the hit.
        if (st === 'attack' && t < hit) u = ws + (c.impact - ws) * Math.pow(t / hit, 1.6);
        else {
          // Hold the fully-extended pose for a moment (visual hitstop), then
          // recover at the clip's real speed.
          if (mo.hitAt === null) mo.hitAt = now;
          u = c.impact + secs(Math.max(0, now - mo.hitAt - IMPACT_HOLD_MS));
        }
      } else {
        u = ws + secs(now - mo.since);
      }
      if (u >= we) { an.mocap = null; if (settling) return null; u = we; }
      return { clip: c, u, oneShot: true };
    }

    // Sam's swim (his crouch): loops with the distance he covers -- backwards
    // when he backs up -- and treads slowly in place.
    const swim = st === 'block' && !fighter.guarding && fighter.character.crouchSwim && Mocap.clipFor(id, 'swim');
    if (swim) return { clip: swim, u: ((an.swimU || 0) % 1 + 1) % 1, loop: true, swim: true };

    // 'block' is also the crouch; only the held guard plays the block clip.
    const crouching = st === 'block' && !fighter.guarding;
    const clip = crouching ? null : Mocap.clipFor(id, st);
    if (!clip) {
      // No idle/walk clip: stand in the guard the attack clip starts from, so
      // idle, walk and attack share one stance and nothing shifts between them.
      const stance = (st === 'idle' || st === 'walk') && (Mocap.clipFor(id, 'stance') || Mocap.clipFor(id, 'attack'));
      if (!stance) return null;
      return { clip: stance, u: (stance.window || [0, 1])[0], stance: true, upperOnly: st === 'walk' };
    }
    switch (st) {
      case 'block': return { clip, u: clip.impact };
      case 'walk': {
        // Advance by distance walked, one clip loop per the clip's own
        // stride, so the feet don't slide; backwards plays it in reverse.
        const r0 = clip.frames[0].root[0], r1 = clip.frames[clip.frames.length - 1].root[0];
        const stride = Math.abs(r1 - r0) * fighter.height;
        let u = stride > fighter.height * 0.2 ? ((an.walkDist || 0) / stride) % 1 : ((fighter.walkCycle / TAU) % 1 + 1) % 1;
        if (fighter.vx * fighter.facing < 0) u = 1 - u;
        return { clip, u, loop: true };
      }
      case 'idle': case 'victory': return { clip, u: ((now / 1000) / Math.max(0.1, clip.duration)) % 1, loop: true };
      default: return null;
    }
  }

  // Push a strike's pose further from the guard it started in.
  function exaggerate(f, clip) {
    const g = Mocap.sample(clip, (clip.window || [0, 1])[0]);
    const k = EXAGGERATE;
    const ang = (a, b) => b + Math.atan2(Math.sin(a - b), Math.cos(a - b)) * k;
    return {
      ...f,
      l: g.l + (f.l - g.l) * k,
      root: [g.root[0] + (f.root[0] - g.root[0]) * k, f.root[1]],
      arm: f.arm.map((pair, i) => pair.map((a, j) => ang(a, g.arm[i][j]))),
      leg: f.leg.map((pair, i) => pair.map((a, j) => ang(a, g.leg[i][j]))),
    };
  }

  // How far out the strike is, 0 (guard) to 1 (fully extended): builds to the
  // clip's impact, then whips back in a fraction of the recovery.
  function strikeExtent(pb) {
    const w = pb.clip.window || [0, 1], im = pb.clip.impact;
    if (pb.u <= im) return Math.pow(clamp((pb.u - w[0]) / Math.max(0.01, im - w[0]), 0, 1), 3.4);
    return Math.pow(clamp(1 - (pb.u - im) / Math.max(0.01, (w[1] - im) * 0.4), 0, 1), 2);
  }

  // Stretches the striking arm (bones lengthen, limb thins) so the fist
  // reaches the end of the attack's hitbox at full extension.
  function elasticReach(T, fighter, sh, shY, ext, dims, idx) {
    const atk = fighter.character.attack;
    const a = T.arms[idx];
    if (!a) return;
    const S = { x: sh[idx].x, y: sh[idx].y - shY };
    let vx = a.x - S.x, vy = a.y - S.y;
    const dist = Math.hypot(vx, vy) || 1;
    const want = Math.max(dist, atk.offset + atk.width * 0.82 - S.x);
    const nd = dist + (want - dist) * ext;
    const k = nd / dist;
    // As it stretches the arm straightens out toward the target (level with
    // the shoulder) instead of following the clip's rising haymaker arc.
    const turn = -Math.atan2(vy, vx) * 0.75 * ext;
    const cs = Math.cos(turn), sn = Math.sin(turn);
    const rot = (x, y) => ({ x: x * cs - y * sn, y: x * sn + y * cs });
    const w = rot(vx * k, vy * k);
    a.x = S.x + w.x; a.y = S.y + w.y;
    if (a.ex !== undefined) {
      const e = rot((a.ex - S.x) * k, (a.ey - S.y) * k);
      a.ex = S.x + e.x; a.ey = S.y + e.y;
    }
    a.stretch = Math.max(1, nd / ((dims.arm.upper + dims.arm.fore) * 0.97));
  }

  function applyClip(T, fighter, an, now, skipClip) {
    T.sh = defaultShoulders(fighter);
    T.rootX = 0;
    T.headTilt = 0;
    const pb = skipClip ? null : clipPlayback(fighter, an, now);
    if (!pb || typeof Renderer === 'undefined' || !Renderer.bodyDims) return;
    let f = Mocap.sample(pb.clip, pb.u);
    if (pb.oneShot && pb.clip === Mocap.clipFor(fighter.character.id, 'attack')) f = exaggerate(f, pb.clip);
    const H = fighter.height;
    const d = Renderer.bodyDims(fighter.character.id, H, fighter.transformed);
    // Standing in the guard: breathe a little so it isn't a statue.
    const breathe = pb.stance ? Math.sin(now / 650) : 0;
    const L = ((f.l + breathe * 0.8) * Math.PI) / 180;
    const dir = (a, len) => F(Math.cos(a) * len, Math.sin(a) * len);

    // Arms, in the torso's own frame (the renderer leans the upper body).
    const sh = f.sh.map(([x, y]) => F(x * H, y * H));
    const shY = H * 0.03; // the rig's hand targets are relative to this point
    T.arms = [0, 1].map((i) => {
      const [a1, a2] = f.arm[i];
      const u = dir(a1 - L, d.arm.upper), w = dir(a2 - L, d.arm.fore);
      const elbow = F(sh[i].x + u.x, sh[i].y + u.y);
      const wrist = F(elbow.x + w.x, elbow.y + w.y);
      return { ...P(wrist.x, wrist.y - shY + breathe * H * 0.006, 0, 1), ex: elbow.x, ey: elbow.y - shY };
    });
    const el = fighter.character.elastic;
    if (el && el.reach && pb.oneShot && pb.clip === Mocap.clipFor(fighter.character.id, 'attack')) {
      const ext = strikeExtent(pb);
      if (ext > 0.001) {
        const limb = pb.clip.limb;
        elasticReach(T, fighter, sh, shY, ext, d, limb && limb[0] === 'arm' ? Number(limb[1]) : 1);
      }
    }
    T.sh = sh;
    T.lean = f.l + breathe * 0.8;
    T.headTilt = f.hd;
    if (pb.upperOnly) {
      // Walking: the stance's upper body over the walk cycle's legs.
      T.clip = true; // arms are already built at this fighter's arm length
      T.rate = 45;
      return;
    }

    // Legs from the hips.
    // (in the air the game's jump is the height: the clip's own rise is dropped)
    const hipY0 = -H * d.hipFrac * (1 - (pb.air ? Math.max(0, f.c) : f.c));
    // Each hip where the clip has it (in a fighting stance the far leg is
    // often the forward one).
    const hips = f.hp ? f.hp.map(([x, y]) => F(x * H, hipY0 + y * H)) : [F(-H * 0.022 * d.fh, hipY0), F(H * 0.026 * d.fh, hipY0)];
    const legs = [0, 1].map((i) => {
      const [t1, t2] = f.leg[i];
      const k = dir(t1, d.leg.thigh), s2 = dir(t2, d.leg.shin);
      const knee = F(hips[i].x + k.x, hips[i].y + k.y);
      return { knee, ankle: F(knee.x + s2.x, knee.y + s2.y) };
    });
    const ankleLift = d.leg.foot * 0.45;

    // Stand on the floor with whatever is lowest -- feet when standing, the
    // back and head when lying down -- at the height the clip has it. The
    // torso keeps its length in clips (only the hips move), so this is
    // worked out on the whole body. In the air the game's jump decides.
    let shift = 0;
    if (pb.swim) {
      // Swimming along the floor: hips held just above it (the clip bobs in water).
      shift = -H * 0.09 - hipY0;
    } else if (fighter.grounded && !pb.air) {
      const torsoLen = H * (d.shoulderFrac - d.hipFrac);
      const rot = (x, y, a) => F(x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a));
      const nb = rot(0, -torsoLen, L);
      const neckBase = F(nb.x, hipY0 + nb.y);
      const pad = H * 0.035;
      const low = [legs[0].ankle.y + ankleLift, legs[1].ankle.y + ankleLift, legs[0].knee.y + pad, legs[1].knee.y + pad, hipY0 + pad];
      for (const [x, y] of f.sh) {
        const q = rot(x * H, y * H, L);
        low.push(neckBase.y + q.y + pad);
      }
      const headTop = rot(0, -(d.neckLen + d.headH), L + (f.hd * Math.PI) / 180);
      low.push(neckBase.y + headTop.y * 0.5 + pad, neckBase.y + headTop.y + pad);
      shift = -(f.lo * H) - Math.max(...low);
    }
    const hipY = hipY0 + shift;
    T.crouch = clamp(1 - -hipY / (H * d.hipFrac), -0.3, 0.95);
    T.rigidTorso = true;
    T.fA = F(legs[0].ankle.x, legs[0].ankle.y + shift + ankleLift);
    T.fB = F(legs[1].ankle.x, legs[1].ankle.y + shift + ankleLift);
    T.knees = legs.map((l) => F(l.knee.x, l.knee.y + shift));
    T.hips = hips.map((h) => F(h.x, h.y - hipY0)); // offsets from the hip line
    T.footAngles = f.ft;
    T.footPoint = 0;

    // Breathing, and the body's own shift forward and back within the move
    // (from where the move started; loops have their overall travel removed
    // -- the game moves the fighter).
    T.crouch += breathe * 0.008;
    const fr = pb.clip.frames;
    // Jumps travel with the game too, and landings start from where it put
    // the fighter down. Falls keep only some of theirs, so getting up doesn't
    // slide the body back a long way.
    const x0 = pb.air ? f.root[0]
      : pb.loop ? fr[0].root[0] + (fr[fr.length - 1].root[0] - fr[0].root[0]) * pb.u
      : Mocap.sample(pb.clip, pb.from != null ? pb.from : (pb.clip.window || [0, 1])[0]).root[0];
    T.rootX = (f.root[0] - x0) * H;
    if (pb.fall) T.rootX = clamp(T.rootX, -H * 0.35, H * 0.35);
    T.float = 0;
    T.rot = 0;
    T.spin = 0;
    T.topple = false;
    T.tumble = 0;
    T.clip = true;
    T.rate = 55;
    // Motion smear behind the striking hand/foot, from the wind-up to the hit.
    const striking = pb.oneShot && an.mocap && an.mocap.state === 'attack' && pb.u <= pb.clip.impact + 0.02;
    T.smear = striking && pb.clip.limb ? pb.clip.limb[0] + pb.clip.limb[1] : null; // e.g. 'arm1', 'leg0'
  }

  // ---- Per-fighter state & integration ---------------------------------

  function makeState(T) {
    return {
      lastT: performance.now(),
      c: null, // smoothed channels, seeded from the first target set
      rot: 0, rotVel: 0, prevSpin: 0, toppling: false,
      hop: 0, hopV: 0,
      landT: 0, landImpact: 0, getup: 0,
      prevAirborne: false, prevVy: 0, prevState: 'idle', prevT: 0, prevJumps: 0, prevHovering: false, prevRolling: false, prevSliding: false, swimBeat: 0, prevTransformed: undefined, pan: 0, impactSeq: 0, str: 0, strV: 0,
      dustTimer: 0,
    };
  }

  function seedChannels(T) {
    return {
      crouch: T.crouch, lean: T.lean, float: T.float, lift: T.lift, ball: T.ball, footPoint: T.footPoint,
      fA: { ...T.fA }, fB: { ...T.fB },
      arms: T.arms.map((a) => ({ ...a })),
      sh: T.sh ? T.sh.map((v) => ({ ...v })) : null,
      knees: T.knees ? T.knees.map((v) => ({ ...v })) : null,
      hips: T.hips ? T.hips.map((v) => ({ ...v })) : null,
      footAngles: T.footAngles ? T.footAngles.slice() : null,
      rootX: T.rootX || 0, headTilt: T.headTilt || 0,
    };
  }

  // Ease a list of points (or angles) toward targets; appears/disappears
  // with the clip that drives it.
  function easePoints(cur, target, k) {
    if (!target) return null;
    if (!cur) return target.map((v) => ({ ...v }));
    cur.forEach((v, i) => { v.x += (target[i].x - v.x) * k; v.y += (target[i].y - v.y) * k; });
    return cur;
  }
  function easeAngles(cur, target, k) {
    if (!target) return null;
    if (!cur) return target.slice();
    return cur.map((a, i) => a + Math.atan2(Math.sin(target[i] - a), Math.cos(target[i] - a)) * k);
  }

  function smoothInto(c, T, k) {
    c.sh = easePoints(c.sh, T.sh, k);
    c.knees = easePoints(c.knees, T.knees, k);
    c.hips = easePoints(c.hips, T.hips, k);
    c.footAngles = easeAngles(c.footAngles, T.footAngles, k);
    c.rootX += ((T.rootX || 0) - c.rootX) * k;
    c.headTilt += ((T.headTilt || 0) - c.headTilt) * k;
    c.crouch += (T.crouch - c.crouch) * k;
    c.lean += (T.lean - c.lean) * k;
    c.float += (T.float - c.float) * k;
    c.lift += (T.lift - c.lift) * k;
    c.ball += (T.ball - c.ball) * Math.min(1, k * 1.4);
    c.footPoint += (T.footPoint - c.footPoint) * k;
    c.fA.x += (T.fA.x - c.fA.x) * k; c.fA.y += (T.fA.y - c.fA.y) * k;
    c.fB.x += (T.fB.x - c.fB.x) * k; c.fB.y += (T.fB.y - c.fB.y) * k;
    for (let i = 0; i < 2; i++) {
      const a = c.arms[i], b = T.arms[i];
      a.x += (b.x - a.x) * k; a.y += (b.y - a.y) * k; a.bend += (b.bend - a.bend) * k;
      a.hand += (b.hand - a.hand) * k; a.orb += (b.orb - a.orb) * k;
      a.stretch = (a.stretch || 1) + ((b.stretch || 1) - (a.stretch || 1)) * Math.min(1, k * 2.5); // stretches snap
      // Elbow hints (mocap clips): where the real elbow was, to pick the bend.
      if (b.ex !== undefined) {
        a.ex = a.ex === undefined ? b.ex : a.ex + (b.ex - a.ex) * k;
        a.ey = a.ey === undefined ? b.ey : a.ey + (b.ey - a.ey) * k;
      } else { delete a.ex; delete a.ey; }
    }
  }

  function stepRot(an, T, f, dt, fighter) {
    // Interrupting a spin (e.g. getting hit mid-roll) folds it into the
    // body angle so the spring carries on from the current orientation
    // instead of popping back to upright.
    if (T.spin === 0 && an.prevSpin !== 0) an.rot += wrapPi(an.prevSpin);
    an.prevSpin = T.spin;

    if (!T.topple) an.toppling = false;

    if (T.tumble) {
      an.rot += T.tumble * f;
      an.rotVel = 0; an.toppling = false;
      return;
    }

    // Falling over from standing: an inverted-pendulum topple -- slow
    // start, accelerating, a thud and a small rebound at the floor.
    if (T.topple && !an.toppling && fighter.grounded && Math.abs(an.rot) < 0.4) {
      an.toppling = true;
      an.rotVel = -0.012;
    }
    if (an.toppling) {
      an.rotVel += -0.03 * (Math.sin(Math.abs(an.rot)) + 0.12) * f;
      an.rot += an.rotVel * f;
      if (an.rot <= T.rot) {
        an.rot = T.rot;
        if (Math.abs(an.rotVel) > 0.05) {
          an.rotVel = -an.rotVel * 0.24; an.hopV = Math.max(an.hopV, 2.6);
          if (typeof Sfx !== 'undefined') Sfx.thud(an.pan);
        }
        else { an.rotVel = 0; an.toppling = false; }
      }
      return;
    }

    while (an.rot - T.rot > Math.PI) an.rot -= TAU;
    while (an.rot - T.rot < -Math.PI) an.rot += TAU;
    const w = T.rotW, z = T.rotZ;
    const steps = Math.max(1, Math.ceil(dt / (1 / 90)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      an.rotVel += (-w * w * (an.rot - T.rot) - 2 * z * w * an.rotVel) * h;
      an.rot += an.rotVel * h;
    }
  }

  // Knocked out of the arena and still going down.
  function T0_TUMBLE(fighter, st) { return st === 'ko' && fighter.y > GROUND_Y + 6; }

  function spawnLandingDust(fighter, count, power) {
    if (typeof Effects !== 'undefined' && Effects.spawnDust) Effects.spawnDust(fighter.x, fighter.platform ? fighter.y : GROUND_Y, count, power);
  }

  // opts.settle: a one-off still (the sprite planner's reference ghosts) --
  // jump straight to the target pose with no easing, sounds or dust.
  function update(fighter, profile, opts) {
    const settle = !!(opts && opts.settle);
    const now = performance.now();
    let an = fighter._visualPose;
    if (!an || an.c === undefined) an = fighter._visualPose = makeState();
    const dt = clamp((now - an.lastT) / 1000, 0, 1 / 20);
    an.lastT = now;
    const f = dt * 60; // elapsed time in 60fps sim frames

    const st = fighter.state;
    const down = st === 'knockdown' || st === 'ko';
    const airborne = !fighter.grounded;
    an.walkDist = (an.walkDist || 0) + Math.abs(fighter.vx) * f; // drives walk clips
    if (fighter.character.crouchSwim && st === 'block' && !fighter.guarding && typeof Mocap !== 'undefined') {
      const sc = Mocap.clipFor(fighter.character.id, 'swim');
      if (sc) { // swim clip: one loop per the clip's own travel; slow tread when still or gliding
        const fr = sc.frames, travel = Math.abs(fr[fr.length - 1].root[0] - fr[0].root[0]) * fighter.height;
        const idle = (0.35 / Math.max(0.1, sc.duration)) * (f / 60);
        const moved = fighter.sliding ? 0 : (fighter.vx * fighter.facing * f) / Math.max(fighter.height * 0.5, travel);
        an.swimU = (an.swimU || 0) + (Math.abs(moved) > idle ? moved : idle);
      }
    }
    // Spinning about its own long axis (the claw dive): seen from the side, the body's width swells and shrinks.
    an.axial = (st === 'hoverdive' && fighter._ability && fighter._ability.diving) || (st === 'whirlwind' && fighter._ability && !fighter._ability.landing) ? (an.axial || 0) + 0.75 * f : 0;
    // A crouch-roll turns in step with the distance covered (one turn per
    // ball circumference); it folds into the body angle when the roll stops.
    // Sam's swimming stroke: advances with the distance he covers (and a lazy tread when still).
    if (fighter.character.crouchSwim && st === 'block' && !fighter.guarding && !fighter.sliding) {
      an.swimPhase = (an.swimPhase || 0) + (0.14 + Math.abs(fighter.vx) * 0.085) * f;
    }
    if (fighter.rolling) {
      an.rollAngle = (an.rollAngle || 0) + (fighter.vx * fighter.facing) / (0.2 * fighter.height) * f; // a stylised, quick tumble
      an.rollDir = Math.sign(fighter.vx * fighter.facing) || an.rollDir || 1;
    } else if (an.rollAngle) {
      // The roll stopped mid-turn: finish the rotation to the next whole turn
      // (still curled up) instead of unwinding backwards through a flop. Any
      // other action cuts it short.
      const finishing = fighter.grounded && (st === 'idle' || st === 'walk' || st === 'block');
      if (!finishing) an.rollAngle = 0;
      else {
        const a0 = an.rollAngle;
        const target = (an.rollDir >= 0 ? Math.ceil(a0 / TAU - 1e-6) : Math.floor(a0 / TAU + 1e-6)) * TAU;
        an.rollAngle = a0 + (target - a0) * (1 - Math.exp(-11 * dt));
        if (Math.abs(target - an.rollAngle) < 0.05) an.rollAngle = 0;
      }
    } else an.rollAngle = 0;

    // Event detection from state transitions (render-side only).
    if (!settle && an.prevAirborne && !airborne && (fighter.y >= GROUND_Y - 1 || fighter.platform)) {
      const impact = clamp(an.prevVy / 20, 0, 1);
      if (down || Math.abs(an.rot) > 0.8) {
        an.hopV = Math.max(an.hopV, clamp(an.prevVy * 0.35, 2.5, 8));
        spawnLandingDust(fighter, 7, 2.6);
        if (typeof Sfx !== 'undefined') Sfx.thud(an.pan);
      } else if (impact > 0.15) {
        an.landT = 1; an.landImpact = impact;
        spawnLandingDust(fighter, Math.round(2 + impact * 5), 1.6 + impact * 1.4);
        if (typeof Sfx !== 'undefined') Sfx.land(impact, an.pan);
      }
    }
    an.prevAirborne = airborne;
    if (airborne) an.prevVy = fighter.vy;

    // Sound cues from state transitions (render-side, so host, guest and
    // local play all hear the same thing).
    an.pan = (fighter.x - CANVAS_WIDTH / 2) / (CANVAS_WIDTH / 2);
    if (!settle && typeof Sfx !== 'undefined') {
      const restarted = st === an.prevState && fighter.actionTimer < an.prevT - 0.5;
      if (st !== an.prevState || (restarted && (st === 'attack' || st === 'special' || st === 'ultimate'))) {
        if (st === 'attack') Sfx.swing(an.pan);
        else if (st === 'special' || st === 'ultimate') {
          const def = st === 'ultimate' ? fighter.character.ultimate : fighter.character.special;
          Sfx.ability(def.type, st === 'ultimate', an.pan, def);
        } else if (st === 'phasestep') Sfx.phasestep(an.pan);
        else if (st === 'hoverdive' || st === 'whirlwind') Sfx.drill(an.pan);
        else if (st === 'grabslam') Sfx.swing(an.pan);
        else if (st === 'ko') Sfx.ko(an.pan);
        else if (st === 'victory') Sfx.victory();
      }
      if (fighter.jumpsUsed > an.prevJumps) Sfx.jump(fighter.jumpsUsed, an.pan);
      if (fighter.hovering && !an.prevHovering) Sfx.hover(an.pan);
      if (fighter.rolling && !an.prevRolling) Sfx.roll(an.pan);
      if (fighter.sliding && !an.prevSliding) Sfx.slide(an.pan);
      if (fighter.character.crouchSwim && st === 'block' && !fighter.guarding && !fighter.sliding && Math.abs(fighter.vx) > 0.4) {
        const beat = Math.floor((an.swimPhase || 0) / Math.PI);
        if (beat !== an.swimBeat) { an.swimBeat = beat; Sfx.swim(an.pan); }
      }
      if (fighter.transformed && an.prevTransformed === false) Sfx.transform(an.pan);
      if (T0_TUMBLE(fighter, st) && !an.falling) { an.falling = true; Sfx.fall(an.pan); }
    }
    an.prevJumps = fighter.jumpsUsed;

    // Rubber stretch: every hit taken, blocked or reflected by an elastic
    // fighter kicks a spring that stretches the body along the hit, then
    // snaps it back with a wobble.
    if (fighter.character.elastic) {
      an.impactAge = (an.impactAge === undefined ? 99 : an.impactAge) + f;
      if ((fighter.impactSeq || 0) > an.impactSeq) {
        an.impactAge = 0;
        const push = (fighter.impactDir || 1) * fighter.facing; // hit direction in body space
        an.strV += push * (fighter.impactPower || 0.7) * STRETCH_W * 0.9;
        if (typeof Sfx !== 'undefined') Sfx.boing(an.pan);
      }
      an.impactSeq = fighter.impactSeq || 0;
      // Secondary motion: a rubber body lags behind its own acceleration, so
      // starting, stopping and turning make it sway and wobble back.
      if (!settle && an.impactAge > 14) {
        const dvx = (fighter.vx - (an.prevVx === undefined ? fighter.vx : an.prevVx)) * fighter.facing;
        an.strV -= dvx * 0.045 * STRETCH_W;
      }
      an.prevVx = fighter.vx;
      const steps = Math.max(1, Math.ceil(dt / (1 / 90))), h = dt / steps;
      for (let i = 0; i < steps; i++) {
        an.strV += (-STRETCH_W * STRETCH_W * an.str - 2 * STRETCH_Z * STRETCH_W * an.strV) * h;
        an.str += an.strV * h;
      }
      an.str = clamp(an.str, -1.4, 1.4);
      // Squash and stretch: a rubber body lengthens rising, squashes landing.
      // (Overgrowth stretches the whole body taller on top of that.)
      const vsTarget = (fighter.buffTallMul || 1) * (airborne
        ? 1 + 0.2 * clamp(-fighter.vy / 15, 0, 1)
        : 1 - 0.2 * an.landImpact * an.landT);
      an.vs = (an.vs || 1) + (vsTarget - (an.vs || 1)) * (1 - Math.exp(-22 * dt));
    }
    an.prevHovering = !!fighter.hovering;
    an.prevRolling = !!fighter.rolling;
    an.prevSliding = !!fighter.sliding;
    an.prevTransformed = !!fighter.transformed;
    an.prevT = fighter.actionTimer;

    if (an.prevState === 'knockdown' && !down && st !== 'hitstun' && Math.abs(an.rot) > 0.8) an.getup = 1;
    an.prevState = st;
    if (an.getup > 0) an.getup = Math.max(0, an.getup - f / 20);
    if (an.landT > 0) an.landT = Math.max(0, an.landT - f / 9);

    const T = computeTargets(fighter, profile, an, now);

    // A settled still (planner ghosts, the studio jumping to a pose) takes
    // the target pose exactly instead of easing toward it.
    if (!an.c || settle) an.c = seedChannels(T);
    const k = 1 - Math.exp(-T.rate * dt);
    smoothInto(an.c, T, k);

    if (settle) {
      an.rot = T.rot; an.rotVel = 0; an.toppling = false; an.prevSpin = T.spin;
    } else {
      stepRot(an, T, f, dt, fighter);
    }

    // Secondary bounce after heavy impacts.
    if (an.hopV || an.hop > 0) {
      an.hopV -= 0.85 * f;
      an.hop += an.hopV * f;
      if (an.hop <= 0) {
        an.hop = 0;
        an.hopV = an.hopV < -2.2 ? -an.hopV * 0.4 : 0;
      }
    }

    // Dust trailing a ground slide (flying tackle).
    if (!settle && T.slideDust && Math.abs(fighter.vx) > 6) {
      an.dustTimer += f;
      if (an.dustTimer >= 2) { an.dustTimer = 0; spawnLandingDust(fighter, 1, 1.4); }
    }

    const c = an.c;
    const H = fighter.height;
    const cs = 1 - c.crouch;
    const pv = H * 0.49 * cs;          // pivot height within the body (its centre)
    const top = H * 0.98 * cs;
    const r = H * 0.1;                 // half body thickness, for lying flat
    const rot = an.rot + T.spin;
    const cosR = Math.cos(rot), sinR = Math.abs(Math.sin(rot));
    // Height the pivot must sit at for the rotated body to rest on the
    // floor; a curled ball just rolls on its own radius instead.
    const wh = lerp(Math.max(pv * cosR, -(top - pv) * cosR) + r * sinR, pv, clamp(c.ball, 0, 1));

    return {
      crouch: c.crouch, lean: c.lean, float: c.float, footPoint: c.footPoint,
      fA: c.fA, fB: c.fB, arms: c.arms, knees: c.knees,
      sh: c.sh, hips: c.hips, footAngles: c.footAngles, rootX: c.rootX, headTilt: c.headTilt,
      smear: T.smear || null,
      rigidTorso: !!T.rigidTorso,
      rot, ball: c.ball, pv, wh: wh + an.hop + c.lift, lift: an.hop + c.lift,
      stretch: an.str,
      vstretch: an.vs || 1,
      axialSpin: an.axial ? an.axial : null,
    };
  }

  return { update };
})();
