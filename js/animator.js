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
      default: // 'swing' -- idle/walk
        return [P(-8 - s * 0.75, 26 - Math.abs(s) * 0.15, E), P(8 + s * 0.75, 26 - Math.abs(s) * 0.15, -E)];
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
      case 'multiHit': { // Carlos: cock -> diagonal claw sweep -> reverse sweep
        const h = def.hits;
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
        if (fighter.doubleJumpFlipTimer > 0 && fighter.character.doubleJumpFlip) {
          const u = 1 - fighter.doubleJumpFlipTimer / 24;
          T.spin = TAU * easeInOutSine(u);
          T.ball = u > 0.06 && u < 0.94 ? 0.85 : 0;
          T.crouch = 0.22; T.armPose = 'tuckedDive'; T.arms = null;
          T.fA = F(-2, -20); T.fB = F(12, -24); T.rate = 45;
        }
        break;
      }

      case 'block': {
        T.crouch = 0.24; T.lean = 6; T.armPose = 'crossed';
        if (Math.abs(fighter.vx) > 0.4) {
          walkPose(T, fighter, profile, 10 * stance, 4, 45);
          T.crouch = 0.24 + 0.03 * Math.abs(Math.sin(fighter.walkCycle));
          T.s = 0; T.armPose = 'crossed';
        } else {
          T.fA = F(-15 * stance, 0); T.fB = F(15 * stance, 0);
          T.rate = 40;
        }
        break;
      }

      case 'attack': {
        const atk = fighter.character.attack;
        const ext = attackExt(t, atk);
        const heavy = id === 'john' || id === 'robert';
        T.rate = 60;
        if (id === 'artur') { // froggy front kick: chamber the knee, then drive the foot out
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
      T.crouch += (0.06 + 0.2 * an.landImpact) * an.landT;
      T.rate = Math.max(T.rate, 46);
    }
    // Carlos only hovers while upright.
    if (T.rot !== 0 && Math.abs(T.rot) > 0.5) T.float = 0;

    if (!T.arms) T.arms = armsFor(T.armPose, { R, E: T.E, s: T.s });
    return T;
  }

  // ---- Per-fighter state & integration ---------------------------------

  function makeState(T) {
    return {
      lastT: performance.now(),
      c: null, // smoothed channels, seeded from the first target set
      rot: 0, rotVel: 0, prevSpin: 0, toppling: false,
      hop: 0, hopV: 0,
      landT: 0, landImpact: 0, getup: 0,
      prevAirborne: false, prevVy: 0, prevState: 'idle',
      dustTimer: 0,
    };
  }

  function seedChannels(T) {
    return {
      crouch: T.crouch, lean: T.lean, float: T.float, lift: T.lift, ball: T.ball, footPoint: T.footPoint,
      fA: { ...T.fA }, fB: { ...T.fB },
      arms: T.arms.map((a) => ({ ...a })),
    };
  }

  function smoothInto(c, T, k) {
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
        if (Math.abs(an.rotVel) > 0.05) { an.rotVel = -an.rotVel * 0.24; an.hopV = Math.max(an.hopV, 2.6); }
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

  function spawnLandingDust(fighter, count, power) {
    if (typeof Effects !== 'undefined' && Effects.spawnDust) Effects.spawnDust(fighter.x, GROUND_Y, count, power);
  }

  function update(fighter, profile) {
    const now = performance.now();
    let an = fighter._visualPose;
    if (!an || an.c === undefined) an = fighter._visualPose = makeState();
    const dt = clamp((now - an.lastT) / 1000, 0, 1 / 20);
    an.lastT = now;
    const f = dt * 60; // elapsed time in 60fps sim frames

    const st = fighter.state;
    const down = st === 'knockdown' || st === 'ko';
    const airborne = !fighter.grounded;

    // Event detection from state transitions (render-side only).
    if (an.prevAirborne && !airborne && fighter.y >= GROUND_Y - 1) {
      const impact = clamp(an.prevVy / 20, 0, 1);
      if (down || Math.abs(an.rot) > 0.8) {
        an.hopV = Math.max(an.hopV, clamp(an.prevVy * 0.35, 2.5, 8));
        spawnLandingDust(fighter, 7, 2.6);
      } else if (impact > 0.15) {
        an.landT = 1; an.landImpact = impact;
        spawnLandingDust(fighter, Math.round(2 + impact * 5), 1.6 + impact * 1.4);
      }
    }
    an.prevAirborne = airborne;
    if (airborne) an.prevVy = fighter.vy;

    if (an.prevState === 'knockdown' && !down && st !== 'hitstun' && Math.abs(an.rot) > 0.8) an.getup = 1;
    an.prevState = st;
    if (an.getup > 0) an.getup = Math.max(0, an.getup - f / 20);
    if (an.landT > 0) an.landT = Math.max(0, an.landT - f / 9);

    const T = computeTargets(fighter, profile, an, now);

    if (!an.c) an.c = seedChannels(T);
    const k = 1 - Math.exp(-T.rate * dt);
    smoothInto(an.c, T, k);

    stepRot(an, T, f, dt, fighter);

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
    if (T.slideDust && Math.abs(fighter.vx) > 6) {
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
      fA: c.fA, fB: c.fB, arms: c.arms,
      rot, ball: c.ball, pv, wh: wh + an.hop + c.lift, lift: an.hop + c.lift,
    };
  }

  return { update };
})();
