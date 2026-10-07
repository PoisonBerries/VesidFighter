// A single fighter's state machine, physics, and combat logic.
// Runs on a fixed timestep (see FIXED_STEP in constants.js); all durations
// below are expressed in frames at that fixed rate (60fps) rather than
// wall-clock time, which keeps combat timing exact regardless of the
// display's refresh rate.
//
// Specials and ultimates are data-driven: character.special / .ultimate
// carry a `type` (lunge, slam, dive, multiHit, projectileCharge,
// soundwaveProjectile, nuke, counterDodge, reflectStance, buff, poisonBurst,
// growRoll, phase) and _updateAbilityState() dispatches on it. Adding a hero
// whose kit reuses an existing type is pure data in characters.js; a
// genuinely new mechanic needs a new case here.

const TONGUE_MOUTH = 0.86;
const TONGUE_REACH_FROM = 0.34; // how far in front of his centre the mouth is (fraction of his width) // how far up his body Artur's mouth is (as a fraction of his height)

class Fighter {
  constructor(slot, character, startX, facing) {
    this.slot = slot; // 'p1' | 'p2'
    this.character = character;
    this.x = startX;
    this.y = GROUND_Y;
    this.vx = 0;
    this.vy = 0;
    this.facing = facing; // 1 = facing right, -1 = facing left
    this.aim = 0; // held direction relative to facing (see _handleInput)
    this.blockFrames = 0; // how long block has been held (a fresh block catches the ball)
    this.balanceMode = false;  // balance mode (constants.js): set by Game for the match
    this.launched = false;     // flying from a hit in balance mode: keeps its momentum until it lands
    this.grounded = true;
    this.platform = null;   // id of the stage platform being stood on (stages.js), null on the floor
    this.dropThrough = 0;   // frames left falling through platforms (crouch + jump on one)
    this.jumpsUsed = 0;
    this.doubleJumpFlipTimer = 0;
    this.doubleJumpFlipDir = 1; // +1 front flip, -1 backflip

    this.hpMul = 1;         // free-for-all doubles everyone's health (game.js)
    this.maxHp = character.maxHp;
    this.hp = character.maxHp;
    this.out = false;       // out of the round (game.js): false | 'ko' | 'ringout'

    this.state = 'idle';
    this.actionTimer = 0; // frames elapsed in current action (attack/special/hitstun/etc)
    this.attackHasHit = false;
    this.specialCooldownTimer = 0; // seconds remaining
    this.ultCharge = 0;

    this.blocking = false;
    this.guarding = false; // holding guard (a full block, standing) rather than crouching
    this.facingLocked = false;
    this.paletteSwap = false; // mirror match: player 2 wears the alternate colours

    this.roundsWon = 0;

    // Purely cosmetic: bob/flash timers the renderer uses.
    this.hitFlashTimer = 0;
    this.walkCycle = 0;

    // Status effects, all decremented in _updateStatusTimers().
    this.poisonTicksLeft = 0;
    this.poisonTickTimer = 0;
    this.poisonDamagePerTick = 0;
    this.poisonTickInterval = 20;
    this.poisonLife = 0;      // frames the cloud still hangs around
    this.poisonBox = null;    // where the cloud is (it stays put)
    this.inPoison = false;    // standing in it right now
    this.invulnerableTimer = 0;
    this._dodging = false; // true only during a Keenan-style counter-dodge window
    this._dodgeSuccess = false;
    this.reflectTimer = 0;
    this.reflectMultiplier = 1;
    this.knockdownTimer = 0;
    this.hoverLeft = character.hover ? character.hover.frames : 0; // frames of hover fuel
    // Announces each hit taken/blocked/reflected (a counter the visuals watch;
    // it rides along in snapshots, so online clients see the same thing).
    this.impactSeq = 0;
    this.impactDir = 1;   // direction the hit pushes (attacker's facing / projectile heading)
    this.impactPower = 0; // 0-1.3, how hard
    this.impactKind = null;
    this.hovering = false;
    this.rolling = false; // crouch-moving as a roll (characters with crouchRoll)
    this.sliding = false; // gliding along the floor on crouch momentum (characters with crouchSwim)
    this.downAttackActive = false; // the current attack is the midair down+attack shockwave (characters with downAttack)
    this.finaleArmed = 0;  // frames left in which Ryan's next air kick is a Finale (stronger)
    this.finaleKick = false; // the current kick is the Finale
    this.airSuspend = 0;   // frames left hanging in the air after landing an air kick (Keenan)
    this.airChain = 0;     // air kicks that have kept him up this jump
    this.cloud = null;     // a lingering poison cloud this fighter has let off (Artur): { x, y, w, h, life, poison... }
    this.phaseFlurryIn = 0; // frames until the phase ultimate ends in a flurry (Keenan)
    this._flurryPending = false; // the phase just ended: start the flurry this frame
    this._foeX = 0;        // the opponent's x as of last frame (the flurry stops drifting once it is up close)
    this.finishUltimate = false; // the round is over but this ultimate is still playing out (finishOnKo)
    this.foeHitTimer = 0;  // frames left in which the opponent backing off counts as running away (voice line)
    this.juggleTimer = 0;  // frames left in which hits from juggleBy do extra while we're airborne (Sam's Splashdown)
    this.juggleBy = null;
    this.comboHits = 0;    // hits landed in a row without being hit or blocked
    this.comboTimer = 0;   // frames left to keep the string going
    this.jumpBuffer = 0;   // frames a jump press is still remembered (Owen's charged jump; see chargeJump.buffer)
    this.jumpCharge = 0;   // frames a charged jump has been held (characters with chargeJump)
    this.plasmaJumping = false; // on a fully charged jump, heading for the whirlwind
    this.upAttackActive = false; // the current attack is the two-fisted upward punch (characters with upAttack)
    this.airAttackActive = false; // the current attack is the aerial one (characters with airAttack)
    this.phaseCooldown = 0; // frames until Phase Step (Keenan) is ready again
    this.sinceHit = 999; // frames since last taking a hit (Phase Step window)
    this._comboHeld = false; // jump + crouch both down last frame (to catch the moment the pair is completed)
    this._crouchHeld = false; // crouch down last frame (pressing it on a platform drops you through)
    this.heldByStage = false; // held up by the stage's monster (stages.js)
    this.grabbedBy = null;    // slot of the fighter holding us (Robert's slam, John's carry)
    this.phaseStepFrom = 0;
    this.phaseStepTo = 0;

    // Timed buffs (Ryan/Nathan ultimates).
    this.buffTimer = 0;
    this.buffAtkMul = 1;
    this.buffSpdMul = 1;
    this.buffSizeMul = 1;
    this.buffReachMul = 1;   // Nathan's Overgrowth: how many times further his punches reach
    this.buffTallMul = 1;    // ...and how much taller his rubber body stretches
    this.atkSpeedMul = 1;
    this.fartPower = 0;       // Artur's Toxic Rush: bonus (0..max) earned from fart damage
    this.jumpStacks = 0;      // John's Bounce Back: hits taken this round
    this.poisonFrom = null;   // slot of whoever's cloud is poisoning us
    this.poisonTickDamage = 0; // damage the poison dealt this frame

    // Robert-style permanent mid-match transformation.
    this.transformed = false;
    this._justTransformed = false;

    // Scratch state for whichever special/ultimate is currently running.
    this._ability = {};
    this._controls = null;
  }

  get sizeMultiplier() {
    let m = this.character.sizeScale * this.buffSizeMul;
    if (this.transformed && this.character.transform) m *= this.character.transform.sizeMul;
    return m;
  }

  get width() { return FIGHTER_WIDTH * this.sizeMultiplier; }
  get height() { return FIGHTER_HEIGHT * this.sizeMultiplier; }

  // The attack currently in use: the ordinary one, or the aerial one if it
  // was started in the air (Sam's pike kick).
  get attackDef() {
    if (this.state === 'whirlwind') {
      const w = this.character.whirlwind;
      return this._ability && this._ability.landing ? w.landing : w;
    }
    if (this.downAttackActive) return this.character.downAttack;
    return this.upAttackActive ? this.character.upAttack : this.airAttackActive ? this.character.airAttack : this.character.attack;
  }

  // An attack as it works right now: Overgrowth stretches a forward attack's
  // far edge out reachMul times as far, at reachDamageMul of the damage.
  // (The up punch already reaches the top of any jump.)
  attackBox(a) {
    const r = this.buffReachMul;
    if (r === 1 || a === this.character.upAttack) return a;
    const dm = this.character.ultimate.reachDamageMul || 1;
    return { ...a, width: (a.offset + a.width) * r - a.offset, damage: a.damage * dm };
  }

  // Blood Donor: 0 at full health up to 1 at none -- how much of the bonus applies.
  get bloodFactor() {
    if (!this.character.bloodDonor) return 0;
    return 1 - Math.max(0, Math.min(1, this.hp / this.maxHp));
  }

  get ultFrac() { return Math.max(0, Math.min(1, this.ultCharge / ULT_METER_MAX)); }

  // Jump strength, with the passives that change it: Ryan's Crescendo (ult
  // meter) and John's Bounce Back (hits taken).
  get jumpForceEff() {
    let j = this.character.jumpForce;
    const cr = this.character.ultCrescendo;
    if (cr) j *= 1 + cr.jump * this.ultFrac;
    const hj = this.character.hitJump;
    if (hj) j *= 1 + hj.perHit * this.jumpStacks;
    return j;
  }

  // Carlos's hover fuel tank: bigger the lower his health.
  get hoverMax() {
    const h = this.character.hover;
    if (!h) return 0;
    return h.frames * (1 + (h.lowHealthBonus || 0) * (1 - Math.max(0, Math.min(1, this.hp / this.maxHp))));
  }

  get moveSpeedEff() {
    let s = this.character.moveSpeed * this.buffSpdMul;
    if (this.transformed && this.character.transform) s *= this.character.transform.spdMul;
    if (this.character.bloodDonor) s *= 1 + this.character.bloodDonor.speed * this.bloodFactor;
    return s;
  }

  get damageMultiplier() {
    let d = this.buffAtkMul;
    if (this.transformed && this.character.transform) d *= this.character.transform.dmgMul;
    if (this.character.bloodDonor) d *= 1 + this.character.bloodDonor.damage * this.bloodFactor;
    const rt = this.character.retaliate;
    if (rt && this.sinceHit < rt.frames) d *= 1 + rt.damage;
    if (this.character.fartPower) d *= 1 + this.fartPower;
    const cr = this.character.ultCrescendo;
    if (cr && !this.grounded) d *= 1 + cr.air * this.ultFrac;
    return d;
  }

  // How fast the action clock runs: Encore's buff, and Blood Donor's bonus while attacking.
  get actionSpeed() {
    let a = this.atkSpeedMul || 1;
    const bd = this.character.bloodDonor;
    const acting = this.state === 'attack' || this.state === 'special' || this.state === 'ultimate';
    if (bd && acting) a *= 1 + bd.attackSpeed * this.bloodFactor;
    if (this.character.fartPower && acting) a *= 1 + this.fartPower;
    return a;
  }

  get displayColor() {
    const c = (this.transformed && this.character.transformColor) ? this.character.transformColor : this.character.color;
    return this.paletteSwap ? swapPalette(c) : c;
  }

  get displayAccent() {
    const c = (this.transformed && this.character.transformAccent) ? this.character.transformAccent : this.character.accent;
    return this.paletteSwap ? swapPalette(c) : c;
  }

  // Balance mode: how shaky you are, 0 (full balance) to 1 (none left).
  get shakiness() {
    return this.balanceMode ? 1 - Math.max(0, this.hp) / this.maxHp : 0;
  }

  get isPhased() {
    return this.invulnerableTimer > 0 && !this._dodging;
  }

  // Holding block on the ground is a crouch, and it really lowers the body.
  get isCrouching() {
    return this.state === 'block' && this.grounded && !this.guarding;
  }

  getHurtbox() {
    // Crouched: a fraction of full height -- and for a swimmer (Sam) lying
    // flat, so very low but long.
    const swim = this.isCrouching ? this.character.crouchSwim : null;
    // (Overgrowth's stretch makes Nathan a taller target, but only here: his
    // hitboxes still work from his normal height.)
    const h = (this.isCrouching ? this.height * (swim ? swim.height : CROUCH_HEIGHT) : this.height) * this.buffTallMul;
    const w = swim ? this.width * swim.widthMul : this.width;
    return {
      x: this.x - w / 2,
      y: this.y - h,
      w,
      h,
    };
  }

  // `bottom`: how far above the floor the box starts (0 = reaches the ground).
  _forwardBox(offset, w, h, bottom = 0) {
    const centerX = this.x + this.facing * offset;
    return {
      x: centerX - (this.facing === 1 ? 0 : w),
      y: this.y - bottom - h,
      w,
      h,
    };
  }

  _centeredBox(w, h) {
    return { x: this.x - w / 2, y: this.y - h, w, h };
  }

  // Returns the active melee hitbox rect, or null. Projectile-type abilities
  // don't return anything here -- they're spawned into Game.projectiles
  // instead and collide independently (see game.js).
  getHitbox() {
    this._pendingHitIndex = -1;

    if (this.state === 'attack' && !this.attackHasHit) {
      const a = this.attackDef;
      if (this.actionTimer > a.startup && this.actionTimer <= a.startup + a.active) {
        // Punches are high attacks (start at chest height, so a crouch can
        // duck them); a def with `high: false`, like Artur's kick, reaches
        // the floor and can't be ducked.
        const bottom = a.high === false ? 0 : this.height * HIGH_ATTACK_BOTTOM;
        const box = this.attackBox(a);
        return this._forwardBox(box.offset, box.width, box.height, bottom);
      }
      return null;
    }
    if (this.state === 'flurry') {
      const f = this.character.ultimate.flurry, a = this._ability, k = this.actionTimer - f.start;
      if (k < 0) return null;
      const i = Math.floor(k / f.every);
      if (i >= f.count || k % f.every >= f.active || a.hitFlags[i]) return null;
      this._pendingHitIndex = i;
      return this._forwardBox(f.offset, f.width, f.height, this.height * HIGH_ATTACK_BOTTOM);
    }
    if (this.state === 'special') return this._abilityHitbox(this.character.special);
    if (this.state === 'ultimate') return this._abilityHitbox(this.character.ultimate);
    if (this.state === 'whirlwind') {
      const a = this._ability, w = this.character.whirlwind;
      if (this.attackHasHit) return null;
      if (a.landing) {
        if (a.timer <= w.landing.recovery) return null;
        return { x: this.x - w.landing.width / 2, y: this.y - w.landing.height, w: w.landing.width, h: w.landing.height };
      }
      // A spinning ring of plasma around his whole body.
      return { x: this.x - w.width / 2, y: this.y - this.height * 0.5 - w.height / 2, w: w.width, h: w.height };
    }
    if (this.state === 'hoverdive') {
      const d = this.character.hoverDive;
      // Claws out all round the body while diving; once it has connected it's over.
      return this._ability.diving && !this.attackHasHit ? this._forwardBox(d.offset, d.width, d.height, 0) : null;
    }
    return null;
  }

  _abilityHitbox(def) {
    if (this.attackHasHit) return null;
    const a = this._ability;

    switch (def.type) {
      case 'lunge':
        if (this.actionTimer > def.startup && this.actionTimer <= def.startup + def.active) {
          return this._forwardBox(def.offset, def.width, def.height);
        }
        return null;

      case 'poisonBurst':
        if (this.actionTimer > def.startup && this.actionTimer <= def.startup + def.active) return this.burstBox(def);
        return null;

      case 'multiHit':
        for (let i = 0; i < def.hits.length; i++) {
          const w = def.hits[i];
          if (!a.hitFlags[i] && this.actionTimer > w.start && this.actionTimer <= w.end) {
            this._pendingHitIndex = i;
            return this._forwardBox(def.offset, def.width, def.height);
          }
        }
        return null;

      case 'slam':
        if (a.justLanded) {
          return this._centeredBox(def.radius * 2, this.height * 0.65);
        }
        return null;

      case 'dive':
        if (a.diving) {
          return def.angle === 'down'
            ? this._centeredBox(def.width, def.height)
            : this._forwardBox(def.offset || 30, def.width, def.height);
        }
        return null;

      case 'tongue': // the tongue shooting out (thin, at mouth height); it's spent once it connects
        if (this.actionTimer > def.startup && this.actionTimer <= def.startup + def.extend + def.hold + def.retract && !a.reeling && a.len > 0) { // (live for as long as the tongue is out, including as it snaps back)
          // From his mouth, but the box reaches well down the body, so it catches anyone standing or crouching (a block still stops it).
          const bottom = this.height * def.bottom;
          return this._forwardBox(this.width * TONGUE_REACH_FROM, a.len + def.height / 2, this.height * TONGUE_MOUTH + def.height / 2 - bottom, bottom); // (from the mouth to the end of the blob on its tip)
        }
        return null;

      case 'takedown': // the hip-first plunge is live: a box around and under his hips
        if (a.phase === 'plunge') return this._centeredBox(def.width, def.height);
        return null;

      case 'growRoll':
        if (this.actionTimer > a.tGrowEnd && this.actionTimer <= a.tRollEnd) {
          return this._forwardBox(def.offset || 30, def.width, def.height);
        }
        return null;

      case 'counterDodge':
        if (a.phase === 'counter') {
          return this._forwardBox(30, def.counterWidth, def.counterHeight);
        }
        return null;

      case 'nuke':
        if (a.fired && a.firedFrame === this.actionTimer) {
          return this._forwardBox(def.offset, def.radius * 2, def.radius * 1.3);
        }
        return null;

      default:
        return null; // projectileCharge, soundwaveProjectile, reflectStance, buff, phase
    }
  }

  // Called by Game once a hitbox from getHitbox() is confirmed to overlap
  // the opponent -- separate from getHitbox() so multi-hit abilities can
  // mark just the window that connected rather than the whole action.
  markHit() {
    if (this._pendingHitIndex >= 0 && this._ability.hitFlags) {
      this._ability.hitFlags[this._pendingHitIndex] = true;
    } else {
      this.attackHasHit = true;
    }
  }

  startAttack() {
    this.state = 'attack';
    this.actionTimer = 0;
    this.attackHasHit = false;
    this.facingLocked = true;
    this.upAttackActive = !!this.character.upAttack && !!this._controls && InputManager.isDown(this._controls.jump);
    this.downAttackActive = !!this.character.downAttack && !this.grounded && !!this._controls && InputManager.isDown(this._controls.block);
    this.airAttackActive = !this.upAttackActive && !this.downAttackActive && !this.grounded && !!this.character.airAttack;
    // Ryan's Finale: the next air kick after a shockwave / combo hit is the powered-up one (spent when thrown).
    this.finaleKick = this.airAttackActive && this.finaleArmed > 0 && !!this.character.finale;
    if (this.finaleKick) this.finaleArmed = 0;
    if (this.grounded) this.vx = 0; // in the air, keep the momentum
    const slam = this.downAttackActive && this.character.downAttack.slamSpeed;
    if (slam) { this.vy = Math.max(this.vy, slam); this.vx += this.facing * this.character.downAttack.slamVx; }
  }

  startSpecial() {
    const def = this.character.special;
    if (this.specialCooldownTimer > 0) return;
    if (def.airOnly && this.grounded) return; // (Sam's dives: only from the air)
    this._cooldownBefore = this.specialCooldownTimer;
    this.specialCooldownTimer = def.cooldown;
    this._beginAbility(def, false);
  }

  startUltimate() {
    const def = this.character.ultimate;
    if (this.ultCharge < ULT_METER_MAX) return;
    if (def.airOnly && this.grounded) return; // (nothing is spent)
    Effects.voice(this.character.id, 'ultimate'); // (only fires when the ultimate really goes off)

    // Phase is instant and non-committing -- it wouldn't make sense to lock
    // a dodge/escape ultimate into an uninterruptible animation.
    if (def.type === 'phase') {
      this.ultCharge = 0;
      this.invulnerableTimer = def.duration;
      this._dodging = false;
      this.phaseFlurryIn = def.flurry ? def.duration : 0; // frames until he unphases into the flurry
      return;
    }

    this.ultCharge = 0;
    this._beginAbility(def, true);
  }

  // Stunned before a special or ultimate actually went off: it just fails,
  // and you keep the charge (the ultimate meter stays full, the special's
  // cooldown isn't spent).
  _refundInterruptedAbility() {
    if (this.state !== 'special' && this.state !== 'ultimate') return;
    const isUlt = this.state === 'ultimate';
    const def = isUlt ? this.character.ultimate : this.character.special;
    const a = this._ability || {};
    let fired;
    if (def.type === 'projectileCharge') fired = a.charging === false;
    else {
      const at = def.startup !== undefined ? def.startup : def.channel !== undefined ? def.channel
        : def.castFrames !== undefined ? def.castFrames : def.growFrames !== undefined ? def.growFrames
        : def.riseFrames !== undefined ? def.riseFrames : def.hits && def.hits.length ? def.hits[0].start : 0;
      fired = this.actionTimer > at;
    }
    if (fired) return;
    if (isUlt) this.ultCharge = ULT_METER_MAX;
    else this.specialCooldownTimer = this._cooldownBefore || 0;
  }

  _beginAbility(def, isUlt) {
    this.state = isUlt ? 'ultimate' : 'special';
    this.actionTimer = 0;
    this.attackHasHit = false;
    this.facingLocked = true;
    if (this.grounded) this.vx = 0; // in the air, keep the momentum
    this._ability = { hitFlags: def.hits ? def.hits.map(() => false) : [] };
    if (def.type === 'poisonBurst') Effects.voice(this.character.id, 'fart'); // Artur's fart (special or ultimate)

    switch (def.type) {
      case 'projectileCharge':
        this._ability.charging = true;
        this._ability.chargeFrames = 0;
        break;
      case 'slam':
        this._ability.launched = false;
        this._ability.justLanded = false;
        this._ability.hasLanded = false;
        break;
      case 'tongue':
        this._ability.len = 0;
        break;
      case 'dive':
        this._ability.diving = false;
        this._ability.hasHitOrLanded = false;
        break;
      case 'growRoll':
        this._ability.tGrowEnd = def.growFrames;
        this._ability.tRollEnd = def.growFrames + def.active;
        this._ability.tShrinkEnd = this._ability.tRollEnd + def.shrinkFrames;
        this._ability.tTotal = this._ability.tShrinkEnd + def.recovery;
        break;
      case 'counterDodge':
        this._ability.phase = 'dodge';
        break;
      case 'soundwaveProjectile':
      case 'nuke':
        this._ability.fired = false;
        break;
      default:
        break;
    }
  }

  _endAbility() {
    this.state = this.grounded ? 'idle' : 'fall';
    this.facingLocked = false;
    this.airAttackActive = false;
    this.upAttackActive = false;
    this.downAttackActive = false;
  }

  // Artur's Toxic Rush: fart damage dealt feeds him.
  gainFartPower(damage) {
    const fp = this.character.fartPower;
    if (fp) this.fartPower = Math.min(fp.max, this.fartPower + damage * fp.perDamage);
  }

  applyPoison(def, cloud, fromSlot) {
    this.poisonFrom = fromSlot || null;
    // The poison is the cloud: it only hurts while you stand in it.
    this.poisonBox = cloud ? { x: cloud.x, y: cloud.y, w: cloud.w, h: cloud.h } : null;
    this.poisonLife = def.poisonTicks * def.poisonTickInterval;
    this.poisonTicksLeft = def.poisonTicks;
    this.poisonTickInterval = def.poisonTickInterval;
    this.poisonTickTimer = def.poisonTickInterval;
    this.poisonDamagePerTick = def.poisonDamage;
  }

  noteImpact(kind, dir, power) {
    this.impactSeq++;
    this.impactKind = kind;
    this.impactDir = dir >= 0 ? 1 : -1;
    this.impactPower = power;
  }

  // hit: { damage, knockback, knockbackUp, hitstun, fromFacing, knockdown, knockdownDuration }
  // Returns 'dodged' | 'phased' | 'reflected' | 'blocked' | 'hit'.
  applyHit(hit) {
    if (hit.projectile && this.character.projectileResist) hit = Object.assign({}, hit, { damage: hit.damage * (1 - this.character.projectileResist) });
    if (this.state === 'grabbed') return 'phased'; // in Robert's grip: nothing else can touch them
    if (this.invulnerableTimer > 0) {
      if (this._dodging) this._dodgeSuccess = true;
      return this._dodging ? 'dodged' : 'phased';
    }
    if (this.reflectTimer > 0) {
      this.noteImpact('reflected', hit.fromFacing, 0.9);
      return 'reflected';
    }
    if (this.blocking && !hit.unblockable) {
      this.noteImpact('blocked', hit.fromFacing, 0.35);
      // Most blocks absorb 85% of the damage; a move can override that
      // (Artur's kick goes low, under the guard).
      // A guard is a full block: nothing gets through, not even a low kick.
      const dmgMul = this.guarding ? 0 : hit.blockDamageMul === undefined ? 0.15 : hit.blockDamageMul;
      const kbMul = this.guarding ? 0.15 : hit.blockKnockbackMul === undefined ? 0.25 : hit.blockKnockbackMul;
      this.hp = Math.max(0, this.hp - hit.damage * dmgMul);
      this.vx = hit.fromFacing * hit.knockback * kbMul;
      this.hitFlashTimer = 6;
      this._maybeTransform();
      return 'blocked';
    }

    this._refundInterruptedAbility();
    let kb = hit.knockback * KNOCKBACK_MUL, kbUp = hit.knockbackUp * KNOCKBACK_MUL;
    this.hp = Math.max(0, this.hp - hit.damage);
    this.comboHits = 0;
    this.plasmaJumping = false;
    this.jumpCharge = 0;
    if (this.character.hitJump) this.jumpStacks = Math.min(this.character.hitJump.max, this.jumpStacks + 1);
    if (this.balanceMode) {
      // The shakier you are (after this hit), the further it sends you --
      // gently at first, steeply near the end -- and past a point you fly
      // with it rather than skidding to a stop.
      const sh = this.shakiness;
      const scale = 1 + BALANCE_KNOCKBACK_SCALE * sh * sh;
      kb *= scale;
      kbUp *= scale;
      if (sh >= BALANCE_FLY_AT) this.launched = true;
    }
    const power = Math.min(1.3, Math.max(0.5, kb / 12));

    this.sinceHit = 0;
    this.noteImpact('hit', hit.fromFacing, power);
    this.vx = hit.fromFacing * kb;
    this.vy = -kbUp;
    this.grounded = false;
    this.hitFlashTimer = 10;
    this.facingLocked = false;
    this.actionTimer = 0;

    if (hit.knockdown) {
      this.state = 'knockdown';
      this.knockdownTimer = hit.knockdownDuration || 45;
      Effects.voice(this.character.id, 'knockedDown');
    } else {
      this.state = 'hitstun';
      this.stunFrames = hit.hitstun;
    }

    this._maybeTransform();
    return 'hit';
  }

  _maybeTransform() {
    const t = this.character.transform;
    if (!t || this.transformed) return;
    if (this.hp > 0 && this.hp <= this.maxHp * t.hpThreshold) {
      // The bonus raises the ceiling, it doesn't heal: he keeps the same
      // percentage of the bigger pool (50% of 108 becomes 50% of 173).
      const fraction = this.hp / this.maxHp;
      this.transformed = true;
      this.maxHp += t.bonusHp * this.hpMul;
      this.hp = this.maxHp * fraction;
      this._justTransformed = true;
      Effects.voice(this.character.id, 'transform');
    }
  }

  // Clears everything that lasts beyond a single action, so nothing carries
  // from one round into the next: Robert's transformation, timed buffs
  // (Overgrowth, Encore), poison, shields/dodge windows, stun, hover fuel and
  // any half-finished move. Position, HP and meters are set by the caller.
  resetForRound() {
    this.platform = null;
    this.dropThrough = 0;
    this.revertTransform();
    this.buffTimer = 0;
    this.buffAtkMul = 1;
    this.buffSpdMul = 1;
    this.buffSizeMul = 1;
    this.buffReachMul = 1;
    this.buffTallMul = 1;
    this.atkSpeedMul = 1;
    this.poisonTicksLeft = 0;
    this.poisonTickTimer = 0;
    this.poisonLife = 0;
    this.poisonBox = null;
    this.inPoison = false;
    this.sinceHit = 999;
    this.invulnerableTimer = 0;
    this._dodging = false;
    this._dodgeSuccess = false;
    this.reflectTimer = 0;
    this.hitFlashTimer = 0;
    this.knockdownTimer = 0;
    this.stunFrames = 0;
    this.doubleJumpFlipTimer = 0;
    this.hoverLeft = this.character.hover ? this.character.hover.frames : 0;
    this.hovering = false;
    this.rolling = false;
    this.sliding = false;
    this.airAttackActive = false;
    this.upAttackActive = false;
    this.downAttackActive = false;
    this.phaseCooldown = 0;
    this.comboHits = 0; this.comboTimer = 0; this.jumpCharge = 0; this.plasmaJumping = false; this.foeHitTimer = 0; this.juggleTimer = 0; this.juggleBy = null; this.airSuspend = 0; this.airChain = 0; this.finaleArmed = 0; this.finaleKick = false; this.finishUltimate = false; this.jumpBuffer = 0; this.cloud = null; this.phaseFlurryIn = 0; this._flurryPending = false;
    this.fartPower = 0; this.jumpStacks = 0; this.poisonFrom = null; this.poisonTickDamage = 0;
    this._comboHeld = false;
    this._crouchHeld = false;
    this.heldByStage = false;
    this.blocking = false;
    this.guarding = false;
    this.facingLocked = false;
    this.attackHasHit = false;
    this.actionTimer = 0;
    this.jumpsUsed = 0;
    this.grounded = true;
    this._ability = {};
    this.launched = false;
  }

  // Undo a transformation (Robert's transform only lasts for the round it
  // happened in).
  revertTransform() {
    if (!this.transformed) return;
    this.transformed = false;
    this._justTransformed = false;
    this.maxHp = this.character.maxHp * this.hpMul;
  }

  consumeTransformFlag() {
    if (this._justTransformed) {
      this._justTransformed = false;
      return true;
    }
    return false;
  }

  koByRingOut() {
    this.hp = 0;
    this.state = 'ko';
    this.actionTimer = 0;
  }

  // Another fighter in the same match, by slot (null if we're not in the
  // running match, e.g. a select-screen preview).
  _matchFighter(slot) {
    if (!slot || typeof Game === 'undefined' || !Game.fighters) return null;
    const all = Game.fighters();
    return all.includes(this) ? all.find((f) => f.slot === slot) || null : null;
  }

  update(controls, opponent) {
    this._controls = controls;
    this._updateStatusTimers();
    if (opponent) this._foeX = opponent.x;
    // Owen: remember a jump press for a few frames, so one made while he's still landing or recovering from a move still counts.
    const cjb = this.character.chargeJump;
    if (cjb && cjb.buffer) {
      if (InputManager.isPressed(controls.jump)) this.jumpBuffer = cjb.buffer;
      else if (this.jumpBuffer > 0) this.jumpBuffer--;
    }

    // Picked up by Robert (or the orchard's monster, stages.js): carried
    // around by them (they position us), no input, no physics.
    if (this.state === 'grabbed') {
      this.vx = 0; this.vy = 0;
      // With more than two fighters, whoever grabbed us may not be the nearest one.
      const holder = this._matchFighter(this.grabbedBy) || opponent;
      if (!this.heldByStage && holder.state !== 'grabslam' && holder.state !== 'grabbeat' && holder.state !== 'takedown' && !(holder.state === 'ultimate' && holder._ability && holder._ability.reeling)) this.state = 'fall';
      return;
    }

    if (this._flurryPending) { // the phase ended: unphase into the flurry
      this._flurryPending = false;
      if (this.state !== 'ko' && this.state !== 'victory' && this.state !== 'hitstun' && this.state !== 'knockdown' && this.state !== 'grabbed') this._startFlurry(opponent);
    }
    if (this.juggleTimer > 0 && (this.grounded || this.state === 'ko')) this.juggleTimer = 0; // (it only counts while they're still in the air)
    else if (this.juggleTimer > 0) {
      this.juggleTimer--;
      // Bounced up by Splashdown they hang there a while: gravity is eased so the stunned fall is slower and longer.
      const jg = (this._matchFighter(this.juggleBy) || {}).character;
      if (jg && jg.ultimate.juggle && !this.grounded) this.vy -= GRAVITY * (this.character.gravityMul || 1) * (1 - jg.ultimate.juggle.gravity);
    }
    this.rolling = false; // set again below while a crouch-roll is in progress
    if (this.state !== 'block') this.sliding = false; // a slide only lasts while crouched
    const held = (this._ability && this._matchFighter(this._ability.target)) || opponent;
    if (this.state === 'grabslam') this._updateGrabSlam(held);
    if (this.state === 'grabbeat') this._updateGrabBeat(held);
    if (this.state === 'takedown') this._updateTakedown(held);
    if (this.state !== 'ko' && this.state !== 'victory') {
      this._handleInput(controls, opponent);
    }
    this._updateActionState();
    this._updatePlasmaJump();
    this._updateHover();
    this._updateSuspend();
    this._applyPhysics();
    this._resolveFacing(opponent);
  }

  _updateStatusTimers() {
    if (this.specialCooldownTimer > 0) {
      this.specialCooldownTimer = Math.max(0, this.specialCooldownTimer - FIXED_STEP);
    }
    if (this.hitFlashTimer > 0) this.hitFlashTimer--;
    if (this.phaseCooldown > 0) this.phaseCooldown--;
    if (this.sinceHit < 999) this.sinceHit++;
    if (this.phaseFlurryIn > 0 && --this.phaseFlurryIn === 0) this._flurryPending = true;
    if (this.comboTimer > 0 && --this.comboTimer === 0) this.comboHits = 0;
    if (this.finaleArmed > 0) this.finaleArmed--;
    if (this.invulnerableTimer > 0) this.invulnerableTimer--;
    if (this.reflectTimer > 0) this.reflectTimer--;
    if (this.doubleJumpFlipTimer > 0) this.doubleJumpFlipTimer--;

    if (this.buffTimer > 0) {
      this.buffTimer--;
      if (this.buffTimer <= 0) {
        this.buffAtkMul = 1;
        this.buffSpdMul = 1;
        this.buffSizeMul = 1;
        this.buffReachMul = 1;
        this.buffTallMul = 1;
        this.atkSpeedMul = 1;
      }
    }

    this.inPoison = false;
    this.poisonTickDamage = 0;
    if (this.poisonTicksLeft > 0) {
      const b = this.poisonBox, h = this.getHurtbox();
      this.inPoison = !b || (h.x < b.x + b.w && h.x + h.w > b.x && h.y < b.y + b.h && h.y + h.h > b.y);
      if (--this.poisonLife <= 0) {
        this.poisonTicksLeft = 0;
        this.inPoison = false;
      } else if (this.inPoison) {
        this.poisonTickTimer--;
        if (this.poisonTickTimer <= 0) {
          this.hp = Math.max(0, this.hp - this.poisonDamagePerTick);
          this.poisonTickDamage = this.poisonDamagePerTick;
          this.poisonTickTimer = this.poisonTickInterval;
          this.hitFlashTimer = Math.max(this.hitFlashTimer, 4);
          this._maybeTransform();
        }
      }
    }
  }

  _startHoverDive() {
    this.state = 'hoverdive';
    this.actionTimer = 0;
    this.attackHasHit = false;
    this.facingLocked = true;
    this.hovering = false;
    this.hoverLeft = 0; // no re-hovering until he lands
    this.vx = 0;
    this.vy = 0;
    this._ability = { hitFlags: [], diving: false, ended: false };
  }

  _updateHoverDive() {
    const d = this.character.hoverDive;
    const a = this._ability;
    if (!a.diving && !a.ended) {
      this.vx = 0;
      this.vy = -GRAVITY * (this.character.gravityMul || 1); // hang in place through the wind-up
      if (this.actionTimer > d.startup) { a.diving = true; a.diveStart = this.actionTimer; }
      return;
    }
    if (a.diving) {
      this.vx = this.facing * d.vx;
      this.vy = d.vy;
      const landed = this.grounded && this.actionTimer > a.diveStart + 1;
      if (landed || this.attackHasHit || this.actionTimer - a.diveStart >= d.maxFrames) {
        a.diving = false;
        a.ended = true;
        a.recoveryTimer = d.recovery;
        if (this.attackHasHit && !this.grounded) { this.vx = -this.facing * 3; this.vy = -5; } // bounces off the hit
      }
      return;
    }
    // Recovery: slide out or drop, open to a counter-attack.
    this._decelerate();
    if (--a.recoveryTimer <= 0) {
      this.state = this.grounded ? 'idle' : 'fall';
      this.facingLocked = false;
    }
  }

  // Keenan's escape: from hitstun/knockdown, dash through the opponent and
  // end up behind them, untouchable for the dash. Returns whether it fired.
  _tryPhaseStep(opp) {
    const ps = this.character.phaseStep;
    if (!ps || !opp || this.phaseCooldown > 0 || this.y > GROUND_Y + 1) return false;
    const dir = opp.x >= this.x ? 1 : -1; // through them, out the far side
    this.state = 'phasestep';
    this.actionTimer = 0;
    this.phaseStepFrom = this.x;
    this.phaseStepTo = Math.max(STAGE_LEFT_EDGE + 40, Math.min(STAGE_RIGHT_EDGE - 40, opp.x + dir * ps.behind));
    this.facing = dir;
    this.facingLocked = true;
    this.invulnerableTimer = ps.dashFrames + ps.invulnTail;
    this._dodging = false; // "phased" (see-through), not a dodge window
    this.reflectTimer = 0;
    this.blocking = false;
    this.guarding = false;
    this.launched = false;
    this.stunFrames = 0;
    this.hitFlashTimer = 0;
    this.vx = 0;
    this.vy = 0;
    this.phaseCooldown = ps.cooldown;
    Effects.voice(this.character.id, 'phaseStep');
    return true;
  }

  _updatePhaseStep() {
    const ps = this.character.phaseStep;
    const u = Math.min(1, this.actionTimer / ps.dashFrames);
    this.x = this.phaseStepFrom + (this.phaseStepTo - this.phaseStepFrom) * (1 - Math.pow(1 - u, 3));
    this.vx = 0;
    if (u < 1) this.vy = -GRAVITY * (this.character.gravityMul || 1); // hold height through the dash
    if (this.actionTimer >= ps.dashFrames + ps.recovery) {
      this.state = this.grounded ? 'idle' : 'fall';
      this.facingLocked = false;
    }
  }

  _handleInput(controls, opponent) {
    const held = {
      left: InputManager.isDown(controls.left),
      right: InputManager.isDown(controls.right),
      block: InputManager.isDown(controls.block),
      guard: InputManager.isDown(controls.guard),
    };
    // Held direction relative to facing, read even mid-attack: it aims the
    // hot potato (game.js) -- toward for a long hit, away for a short lob.
    this.aim = held.left === held.right ? 0 : (held.right ? 1 : -1) * this.facing;
    // Jump + crouch pressed together (either order, as long as both are down
    // and the pair was only just completed) -- Keenan's Phase Step escape.
    const comboDown = InputManager.isDown(controls.jump) && held.block;
    const comboEdge = comboDown && !this._comboHeld;
    this._comboHeld = comboDown;
    const crouchEdge = held.block && !this._crouchHeld;
    this._crouchHeld = !!held.block;
    const pressed = {
      jump: InputManager.isPressed(controls.jump),
      attack: InputManager.isPressed(controls.attack),
      special: InputManager.isPressed(controls.special),
      ultimate: InputManager.isPressed(controls.ultimate),
    };

    if (this.state === 'jumpcharge') { this._updateJumpCharge(); return; }
    if (this.state === 'hitstun' || this.state === 'knockdown') {
      if (comboEdge) this._tryPhaseStep(opponent);
      return; // no other input while stunned or downed
    }
    // Shortly after a hit you can still slip away, even once you're back on your feet.
    const ps = this.character.phaseStep;
    if (ps && comboEdge && this.sinceHit <= ps.window && this.state !== 'phasestep' && this._tryPhaseStep(opponent)) return;
    if (this.state === 'attack' || this.state === 'special' || this.state === 'ultimate' || this.state === 'phasestep' || this.state === 'hoverdive' || this.state === 'whirlwind' || this.state === 'grabslam' || this.state === 'grabbeat' || this.state === 'flurry' || this.state === 'takedown') {
      return; // committed to the action until it finishes
    }

    const phased = this.isPhased; // ultimate phase-out: can move, can't act

    if (!phased) {
      // Blocking: only while grounded. Re-checked every frame (unlike
      // attack/special above) so releasing the key immediately frees the
      // player up to move/attack again. Still allows a slow crouch-walk
      // rather than fully rooting the player in place.
      // Guard: a full, standing block. Holding it slowly bleeds the ultimate meter.
      if (held.guard && this.grounded) {
        this.blockFrames = this.blocking && this.guarding ? this.blockFrames + 1 : 1;
        this.blocking = true;
        this.guarding = true;
        this.sliding = false;
        this.state = 'block';
        this.ultCharge = Math.max(0, this.ultCharge - GUARD_ULT_DRAIN);
        this.vx *= FRICTION;
        return;
      }
      this.guarding = false;
      // Crouching on a platform (or crouch + jump): drop down through it.
      if (held.block && (crouchEdge || pressed.jump) && this.grounded && this.platform) {
        this.platform = null;
        this.dropThrough = 10;
        this.grounded = false;
        this.blocking = false;
        this.state = 'fall';
        return;
      }
      if (held.block && this.grounded) {
        const swim = this.character.crouchSwim;
        // Crouching while already moving (Sam): slide on with that momentum.
        if (swim && !this.blocking && Math.abs(this.vx) >= swim.slide.minSpeed) {
          this.sliding = true;
          this.vx *= swim.slide.boost;
        }
        this.blockFrames = this.blocking ? this.blockFrames + 1 : 1;
        this.blocking = true;
        this.state = 'block';
        let crouchDir = 0;
        if (held.left && !held.right) crouchDir = -1;
        else if (held.right && !held.left) crouchDir = 1;
        if (this.sliding) {
          // Committed to the glide (no steering); it ends when it runs out of speed.
          if (Math.abs(this.vx) < swim.slide.endSpeed) this.sliding = false;
        } else if (crouchDir !== 0) {
          if (swim && !this.facingLocked) this.facing = crouchDir; // Sam turns to swim the other way
          const roll = this.character.crouchRoll;
          this.vx = crouchDir * this.moveSpeedEff * (roll ? roll.speedMul : swim ? swim.speedMul : CROUCH_SPEED_MULTIPLIER);
          this.rolling = !!roll;
        } else {
          this.vx *= FRICTION;
        }
        return;
      }
    }
    this.blocking = false;
    this.guarding = false;
    this.blockFrames = 0;
    this.sliding = false; // letting go of crouch ends any slide at once

    if (!phased) {
      if (pressed.ultimate && this.ultCharge >= ULT_METER_MAX) {
        this.startUltimate();
        if (this.state === 'ultimate') return;
        // Non-committing ultimates (phase) fall through so movement below
        // still applies on the same frame -- but re-check phased status
        // below so this same frame's attack/special input can't sneak in.
      }
    }

    if (!this.isPhased) {
      if (pressed.attack) {
        // Attacking while hovering (Carlos) is a spinning claw dive instead.
        if (this.hovering && this.character.hoverDive && !this.grounded) {
          this._startHoverDive();
          return;
        }
        this.startAttack();
        return;
      }
      if (pressed.special) {
        this.startSpecial();
        if (this.state === 'special') return;
      }
    }

    let moveDir = 0;
    if (held.left && !held.right) moveDir = -1;
    else if (held.right && !held.left) moveDir = 1;

    const facingBefore = this.facing;
    if (moveDir !== 0) {
      // Turn when you switch direction -- in the air too (Carlos hovering), except
      // mid-flip, which keeps the direction it started in.
      if (!this.facingLocked && this.doubleJumpFlipTimer <= 0) this.facing = moveDir;
      this.vx = moveDir * this.moveSpeedEff;
      if (this.grounded) this.state = 'walk';
    } else if (this.grounded) {
      this.state = 'idle';
    }

    if ((pressed.jump || this.jumpBuffer > 0) && this.character.chargeJump && this.grounded && this.jumpsUsed < this.character.maxJumps) {
      this.jumpBuffer = 0;
      // Owen: jump is charged -- the longer it's held the higher he goes.
      this.state = 'jumpcharge';
      this.actionTimer = 0;
      this.jumpCharge = 0;
      this.vx = 0;
      return;
    }
    if (pressed.jump && this.jumpsUsed < this.character.maxJumps) {
      this.vy = -this.jumpForceEff;
      this.jumpsUsed++;
      this.grounded = false;
      this.state = 'jump';
      if (this.jumpsUsed === 2 && this.character.doubleJumpFlip) {
        this.doubleJumpFlipTimer = 24;
        // Front flip when travelling the way he's facing, backflip when going backwards.
        this.doubleJumpFlipDir = moveDir !== 0 && moveDir !== facingBefore ? -1 : 1;
        if (this.doubleJumpFlipDir < 0) this.facing = facingBefore; // a backflip keeps facing the same way
      }
    }
  }

  // Charged jump (Owen): hold jump to crouch and build power, release to go.
  // A full charge is a plasma jump that ends in a spinning whirlwind dive.
  _updateJumpCharge() {
    const cj = this.character.chargeJump;
    this._decelerate();
    this.blocking = false;
    const held = this._controls && InputManager.isDown(this._controls.jump);
    this.jumpCharge++;
    if (held && this.jumpCharge < cj.maxFrames + cj.holdFrames) return;
    const full = this.jumpCharge >= cj.maxFrames;
    // A quick tap is the ordinary jump; charging only counts past tapFrames.
    const frac = Math.max(0, Math.min(1, (this.jumpCharge - cj.tapFrames) / (cj.maxFrames - cj.tapFrames)));
    const force = full ? cj.plasmaForce : this.jumpForceEff + (cj.maxForce - this.jumpForceEff) * frac;
    this.vy = -force;
    this.grounded = false;
    this.jumpsUsed++;
    this.state = 'jump';
    this.plasmaJumping = full;
  }

  // At the top of a plasma jump: arms out, spin down in a whirlwind.
  _updatePlasmaJump() {
    if (!this.plasmaJumping) return;
    if (this.grounded) { this.plasmaJumping = false; return; }
    if ((this.state !== 'jump' && this.state !== 'fall') || this.vy < this.character.whirlwind.startAt) return;
    this.plasmaJumping = false;
    this.state = 'whirlwind';
    this.actionTimer = 0;
    this.attackHasHit = false;
    this.facingLocked = true;
    this.hovering = false;
    this.vx = 0;
    this._ability = { landing: false, timer: 0 };
  }

  _updateWhirlwind() {
    const w = this.character.whirlwind, a = this._ability;
    if (!a.landing) {
      const steer = (this._controls && InputManager.isDown(this._controls.right) ? 1 : 0) - (this._controls && InputManager.isDown(this._controls.left) ? 1 : 0);
      this.vx = steer * w.steer;
      this.vy = w.fallSpeed;
      if (this.actionTimer % w.hitEvery === 0) this.attackHasHit = false; // the whirl keeps hitting
      if (this.grounded) {
        a.landing = true;
        a.timer = w.landing.active + w.landing.recovery;
        this.attackHasHit = false;
        this.vx = 0;
        if (typeof Effects !== 'undefined') Effects.shake(10, 14);
      }
      return;
    }
    this._decelerate();
    if (--a.timer <= 0) { this.state = 'idle'; this.facingLocked = false; }
  }

  // Robert's third unanswered hit: pick the opponent up and slam them down.
  startGrabSlam(opp) {
    const gs = this.character.grabSlam || this.character.grabBeat;
    this.state = this.character.grabBeat ? 'grabbeat' : 'grabslam';
    this.actionTimer = 0;
    this.attackHasHit = true;
    this.facingLocked = true;
    this.comboHits = 0;
    this.vx = 0;
    this.blocking = false;
    this._ability = { slammed: false, released: false, target: opp.slot };
    opp._refundInterruptedAbility();
    opp.state = 'grabbed';
    opp.grabbedBy = this.slot;
    opp.vx = 0; opp.vy = 0;
    opp.blocking = false; opp.stunFrames = 0; opp.launched = false; opp.facingLocked = false;
    opp.actionTimer = 0;
  }

  // John's Takedown, part 1: he springs up aimed at where they are, then at the top drops hip-first onto them
  // (steering a little as he falls). It has to connect with someone standing; Game.tryHit then calls
  // startTakedown. Landing on nothing is just a heavy landing and a long recovery.
  _updateTakedownDash(def) {
    const a = this._ability, g = GRAVITY * (this.character.gravityMul || 1);
    if (this.actionTimer <= def.startup) {
      this._decelerate();
      if (!this.grounded) this.vy = -GRAVITY * (this.character.gravityMul || 1); // cast in the air: he hangs there while he coils
      return;
    }
    if (!a.phase) { // the leap: far enough to be over them at the top
      const gap = Math.max(0, (this._foeX - this.x) * this.facing), apex = def.jump / g;
      this.vx = this.facing * Math.max(2, Math.min(def.maxSpeed, gap / apex));
      this.vy = -def.jump;
      this.grounded = false;
      a.phase = 'leap';
      return;
    }
    if (a.phase === 'leap') {
      if (this.vy >= 0) { a.phase = 'plunge'; a.dropFrom = Math.max(0, GROUND_Y - this.y); this.vx = 0; this.vy = def.plunge; } // over them: drop
      return;
    }
    if (a.phase === 'plunge') {
      this.dropThrough = 3; // straight down through any branches or platforms, all the way to them
      this.vy = def.plunge;
      this.vx = Math.max(-6, Math.min(6, (this._foeX - this.x) * 0.3)); // a little steering on the way down
      if (this.grounded) {
        a.phase = 'landed';
        a.recoveryTimer = def.recovery;
        this.vx = 0;
        Effects.shake(10, 12);
        Effects.spawnDust(this.x, GROUND_Y, 8, 3);
      }
      return;
    }
    this._decelerate();
    if (--a.recoveryTimer <= 0) this._endAbility();
  }

  // How much extra the takedown hits for, by how high he is as he comes down on them.
  takedownMul() {
    const d = this.character.ultimate;
    const a = this._ability, h = a && a.dropFrom !== undefined ? a.dropFrom : Math.max(0, GROUND_Y - this.y); // (the height he dropped from)
    return Math.min(d.maxMul, 1 + d.heightBonus * Math.max(0, h - d.refHeight) / d.refHeight);
  }

  // Part 2: he lands hip-first on them -- they're flattened onto the mat beside his hip -- and then, both on the
  // ground, he punches them a few times.
  startTakedown(opp) {
    const d = this.character.ultimate;
    const mul = this.takedownMul(); // (from the height he dropped from: read before the ability is replaced)
    this.state = 'takedown';
    this.actionTimer = 0;
    this.attackHasHit = true;
    this.facingLocked = true;
    this.vx = 0;
    this.blocking = false;
    this._ability = { slammed: false, landed: false, punched: 0, target: opp.slot, mul }; // (he is still coming down onto them)
    opp._refundInterruptedAbility();
    opp.x = Math.max(STAGE_LEFT_EDGE + 20, Math.min(STAGE_RIGHT_EDGE - 20, this.x + this.facing * 20));
    opp.y = GROUND_Y; opp.vx = 0; opp.vy = 0;
    opp.grounded = true;
    opp.blocking = false; opp.stunFrames = 0; opp.launched = false; opp.facingLocked = false;
    opp.state = 'knockdown';
    opp.knockdownTimer = d.pause + d.punches * d.every + d.end + 24; // down until he's done with them (and his drop to the mat is over)
    opp.actionTimer = 0;
    opp.hp = Math.max(0, opp.hp - d.slamDamage * this._ability.mul * this.damageMultiplier * Game.fightDamageMul());
    opp.hitFlashTimer = 14;
    opp.noteImpact('hit', this.facing, Math.min(1.8, 1.2 + 0.3 * this._ability.mul));
    opp._maybeTransform();
    Effects.voice(opp.character.id, 'knockedDown');
    Effects.shake(8, 10);
    Effects.spawnHitSpark(opp.x, opp.y - 30, '#ffe066');
  }

  _updateTakedown(opp) {
    const d = this.character.ultimate, a = this._ability;
    this.vx = 0;
    if (!a.landed) { // still dropping onto them; the pin starts when his hip hits the mat
      if (!this.grounded) { this.vy = d.plunge; this.dropThrough = 3; return; }
      a.landed = true; a.slammed = true;
      this.actionTimer = 0;
      Effects.shake(14, 18);
      Effects.spawnDust(this.x, GROUND_Y, 12, 4);
      return;
    }
    const t = this.actionTimer;
    // A punch every `every` frames, after a short pause on the mat.
    const k = t - d.pause;
    if (k >= 0 && a.punched < d.punches && k >= a.punched * d.every && opp.state === 'knockdown') {
      a.punched++;
      opp.hp = Math.max(0, opp.hp - d.punchDamage * a.mul * this.damageMultiplier * Game.fightDamageMul());
      opp.hitFlashTimer = 8;
      opp.noteImpact('hit', this.facing, 0.8);
      opp._maybeTransform();
      Effects.shake(6, 8);
      Effects.spawnHitSpark(opp.x, opp.y - 14, '#ffe066');
    }
    if (t > d.pause + d.punches * d.every + d.end) { this.state = 'idle'; this.facingLocked = false; }
  }

  // John: carried over the shoulder and pummelled, then they wriggle free.
  _updateGrabBeat(opp) {
    const gb = this.character.grabBeat, a = this._ability, t = this.actionTimer;
    this.vx = 0;
    if (!a.released) {
      if (opp.state !== 'grabbed') { a.released = true; }
      else {
        const u = Math.min(1, t / gb.lift), e = u * u * (3 - 2 * u);
        opp.x = this.x + this.facing * (30 - 46 * e);
        opp.y = this.y - this.height * 0.5 * e;
        const k = t - gb.lift;
        if (k > 0 && k % gb.every === 0 && k / gb.every <= gb.punches) {
          opp.hp = Math.max(0, opp.hp - gb.damage * this.damageMultiplier * Game.fightDamageMul());
          opp.hitFlashTimer = 6;
          opp.noteImpact('hit', this.facing, 0.7);
          opp._maybeTransform();
          if (typeof Effects !== 'undefined') {
            Effects.shake(5, 6);
            Effects.spawnHitSpark(opp.x, opp.y - this.height * 0.4, '#ffe066');
          }
        }
        if (k >= gb.punches * gb.every) {
          a.released = true;
          a.releasedAt = t;
          opp.state = 'hitstun';
          opp.stunFrames = 16;
          opp.actionTimer = 0;
          opp.vx = this.facing * 9;
          opp.vy = -5;
          opp.grounded = false;
        }
      }
      return;
    }
    if (t > (a.releasedAt || t) + gb.recovery) { this.state = 'idle'; this.facingLocked = false; }
  }

  _updateGrabSlam(opp) {
    const gs = this.character.grabSlam, a = this._ability, t = this.actionTimer;
    this.vx = 0;
    if (!a.slammed) {
      if (t <= gs.lift + gs.hold && opp.state === 'grabbed') {
        const u = Math.min(1, t / gs.lift), e = u * u * (3 - 2 * u);
        opp.x = this.x + this.facing * (30 - 18 * e);
        opp.y = this.y - this.height * 1.3 * e;
      } else {
        a.slammed = true;
        if (opp.state === 'grabbed') {
          opp.x = Math.max(STAGE_LEFT_EDGE + 20, Math.min(STAGE_RIGHT_EDGE - 20, this.x + this.facing * 62));
          opp.y = GROUND_Y;
          opp.grounded = true;
          opp.state = 'knockdown';
          opp.knockdownTimer = gs.stun;
          Effects.voice(opp.character.id, 'knockedDown');
          opp.actionTimer = 0;
          opp.hp = Math.max(0, opp.hp - gs.damage * this.damageMultiplier * Game.fightDamageMul());
          opp.hitFlashTimer = 14;
          opp.noteImpact('hit', this.facing, 1.4);
          opp._maybeTransform();
          if (typeof Effects !== 'undefined') {
            Effects.shake(16, 20);
            Effects.spawnHitSpark(opp.x, opp.y - 18, '#ffe066');
          }
        }
      }
      return;
    }
    if (t > gs.lift + gs.hold + gs.recovery) { this.state = 'idle'; this.facingLocked = false; }
  }

  // Keenan: a kick that lands keeps him hanging in the air so he can follow it up.
  hangAfterKick() {
    const a = this.character.airAttack;
    if (!a || !a.suspend || this.grounded || this.airChain >= a.maxChain) return;
    this.airChain++;
    this.airSuspend = a.suspend;
    this.vy = -a.pop;                  // pushes off the target: up...
    this.vx = -this.facing * a.recoil; // ...and a little back
  }

  _updateSuspend() {
    if (this.grounded || this.state === 'hitstun' || this.state === 'knockdown' || this.state === 'ko' || this.state === 'grabbed') {
      this.airSuspend = 0;
      if (this.grounded) this.airChain = 0;
      return;
    }
    if (this.airSuspend > 0) {
      this.airSuspend--;
      // Mostly (not fully) cancels this frame's gravity: he arcs up off the kick and drifts down, rather than hanging.
      this.vy -= GRAVITY * (this.character.gravityMul || 1) * (1 - this.character.airAttack.gravity);
    }
  }

  // Keenan's flurry (the end of his phase ultimate): 9 quick punches while he drifts at them.
  _startFlurry(opp) {
    const f = this.character.ultimate.flurry;
    this.state = 'flurry';
    this.actionTimer = 0;
    this.attackHasHit = false;
    this.facing = opp && opp.x < this.x ? -1 : 1;
    this.facingLocked = true;
    this.blocking = false;
    this.guarding = false;
    this._ability = { hitFlags: Array.from({ length: f.count }, () => false) };
    Effects.voice(this.character.id, 'flurry');
  }

  // The numbers for the flurry punch that just connected (the last one hits hardest).
  flurryStats() {
    const f = this.character.ultimate.flurry;
    return this._pendingHitIndex === f.count - 1 ? f.last : f.hit;
  }

  _updateFlurry() {
    const f = this.character.ultimate.flurry;
    const end = f.start + f.count * f.every + f.recovery;
    // Drifts in at them, but stops once he's right up against them (rather than walking through).
    const gap = (this._foeX - this.x) * this.facing;
    this.vx = this.facing * (this.actionTimer < f.start + f.count * f.every && gap > 50 ? f.drift : 0);
    if (this.actionTimer > end) this._endAbility();
  }

  // Hold-jump hover (characters with a `hover` block, e.g. Carlos). While
  // held in normal air movement, gravity is cancelled and fuel drains; it
  // refills on landing. Getting hit or starting an attack ends it.
  _updateHover() {
    const h = this.character.hover;
    if (!h) return;
    if (this.grounded) {
      this.hoverLeft = this.hoverMax;
      this.hovering = false;
      return;
    }
    const inAir = this.state === 'jump' || this.state === 'fall';
    const held = this._controls && InputManager.isDown(this._controls.jump);
    if (inAir && held && this.hoverLeft > 0 && this.vy > -h.maxRiseSpeed) {
      this.hovering = true;
      this.hoverLeft--;
      this.vy = -GRAVITY * (this.character.gravityMul || 1); // cancels this frame's gravity
    } else {
      this.hovering = false;
    }
  }

  // True while a committed attack/ability should carry its horizontal
  // momentum through the air instead of braking. Regular attacks always do;
  // specials/ultimates do unless the def opts out with `airMomentum: false`
  // (moves that explicitly plant or redirect the fighter zero vx themselves,
  // e.g. Rubber Guard and the straight-down dives).
  _keepsAirMomentum() {
    if (this.grounded) return false;
    if (this.launched) return true;
    if (this.state === 'attack') return true;
    const def = this.state === 'special' ? this.character.special
      : this.state === 'ultimate' ? this.character.ultimate : null;
    return !!def && def.airMomentum !== false;
  }

  // Ground friction for committed actions; a no-op while momentum is kept.
  _decelerate() {
    if (!this._keepsAirMomentum()) this.vx *= FRICTION;
  }

  _updateActionState() {
    // Ryan's Encore ultimate speeds up whatever animation is currently
    // playing (his own) by advancing the action clock faster than realtime.
    this.actionTimer += this.actionSpeed;

    if (this.state === 'attack') {
      const a = this.attackDef;
      const total = a.startup + a.active + a.recovery;
      if (this.downAttackActive && a.slamSpeed && !this.grounded && !this.attackHasHit) this.vy = Math.max(this.vy, a.slamSpeed); // stays on the way down
      this._decelerate();
      if (this.actionTimer > total) this._endAbility();
    }

    if (this.state === 'phasestep') this._updatePhaseStep();
    if (this.state === 'hoverdive') this._updateHoverDive();
    if (this.state === 'whirlwind') this._updateWhirlwind();
    if (this.state === 'flurry') this._updateFlurry();
    if (this.state === 'special') this._updateAbilityState(this.character.special);
    if (this.state === 'ultimate') this._updateAbilityState(this.character.ultimate);

    if (this.state === 'hitstun') {
      if (this.actionTimer > (this.stunFrames || 0) && this.grounded) {
        this.state = 'idle';
      } else if (this.actionTimer > (this.stunFrames || 0) && this.launched) {
        // Hitstun wears off mid-flight: you get control back to try to recover.
        this.state = 'fall';
      }
    }

    if (this.state === 'knockdown') {
      if (this.actionTimer > this.knockdownTimer && this.grounded) {
        this.state = 'idle';
        Effects.voice(this.character.id, 'recovery'); // back on his feet
      }
    }

    if (!this.grounded && (this.state === 'idle' || this.state === 'walk')) {
      this.state = this.vy < 0 ? 'jump' : 'fall';
    }
  }

  _updateAbilityState(def) {
    switch (def.type) {
      case 'lunge': return this._updateLunge(def);
      case 'multiHit': return this._updateMultiHit(def);
      case 'slam': return this._updateSlam(def);
      case 'poisonBurst': return this._updatePoisonBurstAction(def);
      case 'dive': return this._updateDive(def);
      case 'growRoll': return this._updateGrowRoll(def);
      case 'takedown': return this._updateTakedownDash(def);
      case 'tongue': return this._updateTongue(def);
      case 'counterDodge': return this._updateCounterDodge(def);
      case 'projectileCharge': return this._updateProjectileCharge(def);
      case 'soundwaveProjectile': return this._updateInstantProjectile(def);
      case 'nuke': return this._updateNuke(def);
      case 'reflectStance': return this._updateReflectStance(def);
      case 'buff': return this._updateBuffCast(def);
      default: this._endAbility();
    }
  }

  _updateLunge(def) {
    const total = def.startup + def.active + def.recovery;
    if (this.actionTimer <= def.startup) {
      this._decelerate();
    } else if (this.actionTimer <= def.startup + def.active) {
      this.vx = this.facing * def.dashSpeed;
    } else {
      this._decelerate();
    }
    if (this.actionTimer > total) this._endAbility();
  }

  _updateMultiHit(def) {
    this._decelerate();
    const lastWindow = def.hits[def.hits.length - 1];
    if (this.actionTimer > lastWindow.end + def.recovery) this._endAbility();
  }

  // Where a poison burst's cloud is: ahead of him, or -- for Artur's ultimate let off in the air -- a column
  // from his body down to the floor beneath him.
  burstBox(def) {
    if (def.darts && this._ability && this._ability.air) {
      const top = this.y - this.height * 0.3, bottom = GROUND_Y + 30;
      return { x: this.x - def.width / 2, y: top, w: def.width, h: Math.max(120, bottom - top) };
    }
    return this._forwardBox(def.offset, def.width, def.height);
  }

  _updatePoisonBurstAction(def) {
    this._decelerate();
    const a = this._ability;
    if (a.air === undefined) a.air = !!def.darts && !this.grounded;
    // In the air he hangs there while the burst goes off, then drops.
    if (a.air && this.actionTimer <= def.startup + def.active) this.vy = -GRAVITY * (this.character.gravityMul || 1);
    // The fart darts: a few, one every `every` frames from just after the burst goes off.
    if (def.darts) {
      const d = def.darts, n = a.air ? d.airCount : d.count;
      a.darts = a.darts || 0;
      while (a.darts < n && this.actionTimer >= def.startup + 2 + a.darts * d.every) {
        const i = a.darts++, mid = (n - 1) / 2, off = i - mid;
        if (a.air) {
          // Raining down from under him, fanned out a little, each one slightly outward.
          Game.spawnProjectile(this, d, { kind: 'fartDart', color: '#9be04a', x: this.x + off * 58, y: this.y - this.height * 0.1, vx: off * 1.2, vy: d.fall, poison: d, life: 120 });
        } else {
          const ang = d.spread[i % d.spread.length];
          Game.spawnProjectile(this, d, { kind: 'fartDart', color: '#9be04a', y: this.y - this.height * (0.5 - 0.06 * (i % 3)), vx: this.facing * d.speed * Math.cos(ang), vy: d.speed * Math.sin(ang), poison: d });
        }
      }
    }
    // The cloud is left hanging where it was let off (Game.updateClouds poisons whoever is in it).
    if (def.lingerFrames && this.actionTimer > def.startup && !this._ability.cloudMade) {
      this._ability.cloudMade = true;
      const b = this.burstBox(def);
      this.cloud = { x: b.x, y: b.y, w: b.w, h: b.h, life: def.lingerFrames, poisonDamage: def.poisonDamage, poisonTicks: def.poisonTicks, poisonTickInterval: def.poisonTickInterval };
    }
    const total = def.startup + def.active + def.recovery;
    if (this.actionTimer > total) this._endAbility();
  }

  // Artur's ultimate: the tongue shoots out (the hitbox is the length it has reached), holds a beat and snaps back.
  // If it connects, Game.tryHit calls startTongueReel: they're hauled in to him, and he lets one go in their face.
  tongueMouth() { return { x: this.x + this.facing * this.width * TONGUE_REACH_FROM, y: this.y - this.height * TONGUE_MOUTH }; }

  _updateTongue(def) {
    const a = this._ability, t = this.actionTimer;
    this._decelerate();
    if (a.air === undefined) a.air = !this.grounded;
    if (a.air) this.vy = -GRAVITY * (this.character.gravityMul || 1); // cast in the air: he hangs there for the whole thing
    const m = this.tongueMouth();
    if (a.reeling) {
      const opp = this._matchFighter(a.target);
      if (!opp || opp.state !== 'grabbed') { a.reeling = false; a.endAt = t + def.retract + def.recovery; a.len = 0; return; } // (they got free)
      const u = Math.min(1, ++a.reelT / def.reel), e = u * u;
      const destX = Math.max(STAGE_LEFT_EDGE + 20, Math.min(STAGE_RIGHT_EDGE - 20, this.x + this.facing * def.arrive));
      opp.x = a.fromX + (destX - a.fromX) * e;
      opp.y = a.fromY + (this.y - a.fromY) * e;
      a.len = Math.abs(opp.x - m.x);
      a.tipY = opp.y - opp.height * 0.6;
      if (u >= 1) this._tongueFart(opp, def);
      return;
    }
    if (a.farted) { a.len = 0; if (t >= a.endAt) this._endAbility(); return; }
    if (a.endAt !== undefined) { // snapping back (it missed, was blocked, or they broke free)
      a.len *= 0.7;
      if (t >= a.endAt) this._endAbility();
      return;
    }
    if (t <= def.startup) return;
    if (this.attackHasHit) { a.endAt = t + def.retract + def.recovery; return; } // blocked: it's spent
    const k = t - def.startup;
    if (k <= def.extend) a.len = def.reach * k / def.extend;
    else if (k <= def.extend + def.hold) a.len = def.reach;
    else if (k <= def.extend + def.hold + def.retract) a.len = def.reach * (1 - (k - def.extend - def.hold) / def.retract);
    else { a.len = 0; a.endAt = t + def.recovery; }
    a.tipY = m.y;
  }

  startTongueReel(opp) {
    const a = this._ability;
    a.reeling = true; a.reelT = 0; a.target = opp.slot;
    a.fromX = opp.x; a.fromY = opp.y;
    opp._refundInterruptedAbility();
    opp.state = 'grabbed';
    opp.grabbedBy = this.slot;
    opp.vx = 0; opp.vy = 0;
    opp.blocking = false; opp.stunFrames = 0; opp.launched = false; opp.facingLocked = false;
    opp.actionTimer = 0;
  }

  // They've arrived: a huge fart right in their face.
  _tongueFart(opp, def) {
    const a = this._ability, f = def.fart;
    a.reeling = false; a.farted = true; a.len = 0;
    a.endAt = this.actionTimer + def.recovery;
    const dmg = f.damage * this.damageMultiplier * Game.fightDamageMul();
    opp.hp = Math.max(0, opp.hp - dmg);
    opp.state = 'hitstun'; opp.stunFrames = f.hitstun; opp.actionTimer = 0;
    opp.grabbedBy = null;
    opp.vx = this.facing * f.knockback * KNOCKBACK_MUL; opp.vy = -f.knockbackUp * KNOCKBACK_MUL;
    opp.grounded = false;
    opp.sinceHit = 0;
    opp.hitFlashTimer = 14;
    opp.noteImpact('hit', this.facing, 1.3);
    opp._maybeTransform();
    // The cloud hangs around them: whoever stays in it is poisoned.
    const cx = (this.x + opp.x) / 2;
    const box = { x: cx - f.width / 2, y: Math.min(this.y, opp.y) - f.height, w: f.width, h: f.height };
    opp.applyPoison(f, box, this.slot);
    this.cloud = { x: box.x, y: box.y, w: box.w, h: box.h, life: f.lingerFrames, poisonDamage: f.poisonDamage, poisonTicks: f.poisonTicks, poisonTickInterval: f.poisonTickInterval };
    this.gainFartPower(dmg);
    Effects.voice(this.character.id, 'fart');
    Effects.voice(opp.character.id, 'hitByUltimate:' + this.character.id + '|hitByUltimate');
    Effects.shake(14, 18);
    Effects.spawnHitSpark(opp.x, opp.y - opp.height * 0.5, '#9be04a');
  }

  _updateSlam(def) {
    const a = this._ability;
    a.justLanded = false;
    if (!a.launched) {
      this.vy = -def.riseSpeed;
      this.grounded = false;
      a.launched = true;
    } else if (this.actionTimer === def.riseFrames) {
      this.vy = def.fallSpeed;
    } else if (!a.hasLanded && this.actionTimer > def.riseFrames && this.grounded) {
      // Landing frame: stay in 'special'/'ultimate' for a short recovery
      // window so getHitbox() (checked right after this update by the game
      // loop) still sees the right state for the AOE to register.
      a.justLanded = true;
      a.hasLanded = true;
      a.recoveryTimer = 14;
    } else if (a.hasLanded) {
      a.recoveryTimer--;
      if (a.recoveryTimer <= 0) this._endAbility();
    }
    if (this.actionTimer > def.riseFrames + 180) this._endAbility();
  }

  _updateDive(def) {
    const a = this._ability;
    if (this.actionTimer <= def.startup) {
      if (def.angle === 'down' && this.actionTimer === 1 && this.grounded) {
        this.vy = -8;
        this.grounded = false;
      }
      this._decelerate();
      return;
    }
    if (!a.diving && !a.hasHitOrLanded) {
      a.diving = true;
      a.diveEndTimer = this.actionTimer + def.travel;
      if (def.angle === 'down') {
        this.vx = 0;
        this.vy = def.speed;
      } else {
        this.vx = this.facing * def.speed;
        this.vy = def.speed * 0.35;
      }
      return; // don't evaluate end-conditions the same frame the dive begins --
      // `grounded` still reflects last frame and would end a forward dive
      // (which is allowed to slide along the ground) before it ever swings.
    }
    if (a.diving) {
      if (def.angle === 'forward') this.vx = this.facing * def.speed;
      // Only a downward dive ends on landing; a forward dive is allowed to
      // slide along the ground and only ends by travel timeout or a hit.
      const groundEnds = def.angle === 'down' && this.grounded;
      // (an ultimate that has already ended the round plays out to the end of its travel: see Game.endRound)
      if (groundEnds || this.actionTimer >= a.diveEndTimer || (this.attackHasHit && !this.finishUltimate)) {
        a.diving = false;
        a.hasHitOrLanded = true;
        a.recoveryTimer = def.recovery;
        this._decelerate();
      }
    } else if (a.hasHitOrLanded) {
      a.recoveryTimer--;
      this._decelerate();
      if (a.recoveryTimer <= 0) this._endAbility();
    }
  }

  _updateGrowRoll(def) {
    const a = this._ability;
    if (this.actionTimer <= a.tGrowEnd) {
      const t = this.actionTimer / a.tGrowEnd;
      this.buffSizeMul = 1 + (def.sizeMul - 1) * t;
      this._decelerate();
    } else if (this.actionTimer <= a.tRollEnd && !this.attackHasHit) {
      this.buffSizeMul = def.sizeMul;
      this.vx = this.facing * def.dashSpeed;
    } else if (this.actionTimer <= a.tShrinkEnd) {
      const t = Math.max(0, Math.min(1, (this.actionTimer - a.tRollEnd) / (a.tShrinkEnd - a.tRollEnd)));
      this.buffSizeMul = def.sizeMul + (1 - def.sizeMul) * t;
      this._decelerate();
    } else {
      this.buffSizeMul = 1;
      this._decelerate();
      if (this.actionTimer > a.tTotal) this._endAbility();
    }
  }

  _updateCounterDodge(def) {
    const a = this._ability;
    if (a.phase === 'dodge') {
      this.invulnerableTimer = Math.max(this.invulnerableTimer, 2);
      this._dodging = true;
      this._decelerate();
      if (this._dodgeSuccess) {
        a.phase = 'counter';
        this._dodgeSuccess = false;
        this._dodging = false;
        this.invulnerableTimer = 0;
        this.attackHasHit = false;
        a.counterStart = this.actionTimer;
        this.vx = this.facing * def.counterDashSpeed;
      } else if (this.actionTimer > def.dodgeWindow) {
        a.phase = 'recovery';
        a.recoveryStart = this.actionTimer;
        a.recoveryLen = def.whiffRecovery;
        this._dodging = false;
        this.invulnerableTimer = 0;
      }
    } else if (a.phase === 'counter') {
      this.vx = this.facing * def.counterDashSpeed;
      if (this.actionTimer - a.counterStart > def.counterActive || this.attackHasHit) {
        a.phase = 'recovery';
        a.recoveryStart = this.actionTimer;
        a.recoveryLen = def.counterRecovery;
        this._decelerate();
      }
    } else if (a.phase === 'recovery') {
      this._decelerate();
      if (this.actionTimer - a.recoveryStart > a.recoveryLen) this._endAbility();
    }
  }

  _updateProjectileCharge(def) {
    const a = this._ability;
    const CHARGE_THRESHOLD = def.chargeThreshold || 10; // frames of hold before it counts as a charged shot

    if (this.actionTimer <= def.startup) {
      this._decelerate();
      return;
    }

    if (a.charging) {
      this._decelerate();
      const held = InputManager.isDown(this._controls.special);
      if (held && a.chargeFrames < def.maxChargeFrames) {
        a.chargeFrames++;
        return;
      }
      a.charging = false;
      const usedCharged = a.chargeFrames >= CHARGE_THRESHOLD;
      const shot = usedCharged ? def.charged : def.quick;
      Game.spawnProjectile(this, shot, { color: usedCharged ? '#ffe066' : this.displayAccent, kind: usedCharged ? 'plasmaCharged' : 'plasmaQuick' });
      a.recoveryTimer = def.recovery;
      return;
    }

    this._decelerate();
    a.recoveryTimer--;
    if (a.recoveryTimer <= 0) this._endAbility();
  }

  _updateInstantProjectile(def) {
    const a = this._ability;
    this._decelerate();
    if (!a.fired && this.actionTimer > def.startup) {
      Game.spawnProjectile(this, def, {
        parryKnockdown: def.parryKnockdown,
        knockdownDuration: def.knockdownDuration,
        color: this.displayAccent,
        kind: 'soundwave',
      });
      a.fired = true;
      a.recoveryTimer = def.recovery;
      return;
    }
    if (a.fired) {
      a.recoveryTimer--;
      if (a.recoveryTimer <= 0) this._endAbility();
    }
  }

  _updateNuke(def) {
    const a = this._ability;
    this._decelerate();
    if (!a.fired && this.actionTimer > def.channel) {
      a.fired = true;
      a.firedFrame = this.actionTimer;
      a.recoveryTimer = def.recovery;
    } else if (a.fired) {
      a.recoveryTimer--;
      if (a.recoveryTimer <= 0) this._endAbility();
    }
  }

  _updateReflectStance(def) {
    this.vx = 0;
    if (this.actionTimer === def.startup) {
      this.reflectTimer = def.duration;
      this.reflectMultiplier = def.reflectMultiplier || 1;
    }
    if (this.actionTimer > def.startup + def.duration + def.recoveryAfter) {
      this._endAbility();
    }
  }

  _updateBuffCast(def) {
    if (this.actionTimer > def.castFrames) {
      this.buffTimer = def.duration;
      if (def.sizeMul) this.buffSizeMul = def.sizeMul;
      if (def.reachMul) this.buffReachMul = def.reachMul;
      if (def.tallMul) this.buffTallMul = def.tallMul;
      if (def.atkMul) this.buffAtkMul = def.atkMul;
      if (def.spdMul) this.buffSpdMul = def.spdMul;
      if (def.atkSpeedMul) this.atkSpeedMul = def.atkSpeedMul;
      this._endAbility();
    } else {
      this._decelerate();
    }
  }

  _applyPhysics() {
    // Riding something that moves (the car's roof): go along with it.
    const riding = this.platform ? Stage.platform(this.platform) : null;
    if (riding && riding.dx) this.x += riding.dx;
    this.vy += GRAVITY * (this.character.gravityMul || 1);
    const prevY = this.y;
    this.x += this.vx;
    this.y += this.vy;
    if (this.dropThrough > 0) this.dropThrough--;

    if (this.state !== 'walk' && !this._keepsAirMomentum()) {
      // Balance mode: the shakier you are, the more you slide. (A crouch-slide
      // has its own, much lower friction.)
      this.vx *= this.sliding && this.state === 'block' ? this.character.crouchSwim.slide.friction : FRICTION + BALANCE_SLIP * this.shakiness;
    }

    const onStage = this.x > STAGE_LEFT_EDGE && this.x < STAGE_RIGHT_EDGE;

    // One-way platforms (stages.js): land on top when coming down onto one;
    // from below, or dropping through, you pass straight through.
    let plat = null;
    if (this.vy >= 0 && !(this.dropThrough > 0)) {
      for (const p of Stage.platforms()) {
        const top = prevY <= p.y + (p.id === this.platform ? 2 : 0);
        if (top && this.y >= p.y && this.x >= p.x1 && this.x <= p.x2) { plat = p; break; }
      }
    }
    if (plat) {
      this.y = plat.y;
      this.vy = 0;
      this.platform = plat.id;
      if (!this.grounded) {
        this.grounded = true;
        this.jumpsUsed = 0;
        this.launched = false;
        if (this.state === 'jump' || this.state === 'fall') this.state = 'idle';
      }
    } else if (onStage && this.y > GROUND_Y && prevY > GROUND_Y) {
      // Already below the platform's top surface (walked or was knocked off
      // the edge): the platform is a solid wall from here, not a floor.
      // Recovering means jumping up and landing on top, never sliding back
      // in sideways.
      const leftSide = this.x < (STAGE_LEFT_EDGE + STAGE_RIGHT_EDGE) / 2;
      this.x = leftSide ? STAGE_LEFT_EDGE : STAGE_RIGHT_EDGE;
      if (leftSide ? this.vx > 0 : this.vx < 0) this.vx = 0;
      this.grounded = false;
    } else if (onStage && this.y >= GROUND_Y) {
      this.y = GROUND_Y;
      this.vy = 0;
      this.platform = null;
      if (!this.grounded) {
        this.grounded = true;
        this.jumpsUsed = 0;
        this.launched = false;
        if (this.state === 'jump' || this.state === 'fall') this.state = 'idle';
      }
    } else {
      this.grounded = false;
    }
    if (!plat && this.y < GROUND_Y) this.platform = null; // walked, jumped or was knocked off it

    // Keep fighters from flying fully out of the world while airborne.
    this.x = Math.max(WORLD_LEFT, Math.min(WORLD_RIGHT, this.x));

    this.walkCycle += Math.abs(this.vx) * 0.05;
  }

  // Fighters don't turn to face the opponent by themselves: they turn when
  // they move the other way (_handleInput). Some come out of an ability
  // facing the opponent again (Keenan, after dashing through them).
  _resolveFacing(opponent) {
    const inAbility = this.state === 'phasestep' || this.state === 'special';
    const wasInAbility = this.abilityFacing;
    this.abilityFacing = inAbility;
    if (this.facingLocked || inAbility) return;
    if (wasInAbility && this.character.faceAfterAbility) this.facing = opponent.x >= this.x ? 1 : -1;
  }

  hasFallenOff() {
    return this.y > RING_OUT_Y;
  }

  currentPose() {
    switch (this.state) {
      case 'walk': return 'walk';
      case 'jump': return 'jump';
      case 'fall': return 'jump';
      case 'block': return 'block';
      case 'attack': return 'attack';
      case 'special': return 'special';
      case 'ultimate': return 'special';
      case 'phasestep': return 'special';
      case 'hoverdive': case 'whirlwind': case 'grabslam': case 'grabbeat': return 'special';
      case 'flurry': return 'attack';
      case 'takedown': return 'special';
      case 'jumpcharge': return 'block';
      case 'grabbed': return 'hit';
      case 'hitstun': return 'hit';
      case 'knockdown': return 'knockdown';
      case 'ko': return 'ko';
      case 'victory': return 'victory';
      default: return 'idle';
    }
  }
}
