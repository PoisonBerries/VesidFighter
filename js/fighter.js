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
    this.jumpsUsed = 0;
    this.doubleJumpFlipTimer = 0;

    this.maxHp = character.maxHp;
    this.hp = character.maxHp;

    this.state = 'idle';
    this.actionTimer = 0; // frames elapsed in current action (attack/special/hitstun/etc)
    this.attackHasHit = false;
    this.specialCooldownTimer = 0; // seconds remaining
    this.ultCharge = 0;

    this.blocking = false;
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
    this.phaseCooldown = 0; // frames until Phase Step (Keenan) is ready again
    this._comboHeld = false; // jump + crouch both down last frame (to catch the moment the pair is completed)
    this.phaseStepFrom = 0;
    this.phaseStepTo = 0;

    // Timed buffs (Ryan/Nathan ultimates).
    this.buffTimer = 0;
    this.buffAtkMul = 1;
    this.buffSpdMul = 1;
    this.buffSizeMul = 1;
    this.atkSpeedMul = 1;

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

  get moveSpeedEff() {
    let s = this.character.moveSpeed * this.buffSpdMul;
    if (this.transformed && this.character.transform) s *= this.character.transform.spdMul;
    return s;
  }

  get damageMultiplier() {
    let d = this.buffAtkMul;
    if (this.transformed && this.character.transform) d *= this.character.transform.dmgMul;
    return d;
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
    return this.state === 'block' && this.grounded;
  }

  getHurtbox() {
    const h = this.isCrouching ? this.height * CROUCH_HEIGHT : this.height;
    return {
      x: this.x - this.width / 2,
      y: this.y - h,
      w: this.width,
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
      const a = this.character.attack;
      if (this.actionTimer > a.startup && this.actionTimer <= a.startup + a.active) {
        // Punches are high attacks (start at chest height, so a crouch can
        // duck them); a def with `high: false`, like Artur's kick, reaches
        // the floor and can't be ducked.
        const bottom = a.high === false ? 0 : this.height * HIGH_ATTACK_BOTTOM;
        return this._forwardBox(a.offset, a.width, a.height, bottom);
      }
      return null;
    }
    if (this.state === 'special') return this._abilityHitbox(this.character.special);
    if (this.state === 'ultimate') return this._abilityHitbox(this.character.ultimate);
    return null;
  }

  _abilityHitbox(def) {
    if (this.attackHasHit) return null;
    const a = this._ability;

    switch (def.type) {
      case 'lunge':
      case 'poisonBurst':
        if (this.actionTimer > def.startup && this.actionTimer <= def.startup + def.active) {
          return this._forwardBox(def.offset, def.width, def.height);
        }
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
    if (this.grounded) this.vx = 0; // in the air, keep the momentum
  }

  startSpecial() {
    const def = this.character.special;
    if (this.specialCooldownTimer > 0) return;
    this.specialCooldownTimer = def.cooldown;
    this._beginAbility(def, false);
  }

  startUltimate() {
    const def = this.character.ultimate;
    if (this.ultCharge < ULT_METER_MAX) return;

    // Phase is instant and non-committing -- it wouldn't make sense to lock
    // a dodge/escape ultimate into an uninterruptible animation.
    if (def.type === 'phase') {
      this.ultCharge = 0;
      this.invulnerableTimer = def.duration;
      this._dodging = false;
      return;
    }

    this.ultCharge = 0;
    this._beginAbility(def, true);
  }

  _beginAbility(def, isUlt) {
    this.state = isUlt ? 'ultimate' : 'special';
    this.actionTimer = 0;
    this.attackHasHit = false;
    this.facingLocked = true;
    if (this.grounded) this.vx = 0; // in the air, keep the momentum
    this._ability = { hitFlags: def.hits ? def.hits.map(() => false) : [] };

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
  }

  applyPoison(def) {
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
    if (this.invulnerableTimer > 0) {
      if (this._dodging) this._dodgeSuccess = true;
      return this._dodging ? 'dodged' : 'phased';
    }
    if (this.reflectTimer > 0) {
      this.noteImpact('reflected', hit.fromFacing, 0.9);
      return 'reflected';
    }
    if (this.blocking) {
      this.noteImpact('blocked', hit.fromFacing, 0.35);
      // Most blocks absorb 85% of the damage; a move can override that
      // (Artur's kick goes low, under the guard).
      this.hp = Math.max(0, this.hp - hit.damage * (hit.blockDamageMul === undefined ? 0.15 : hit.blockDamageMul));
      this.vx = hit.fromFacing * hit.knockback * (hit.blockKnockbackMul === undefined ? 0.25 : hit.blockKnockbackMul);
      this.hitFlashTimer = 6;
      this._maybeTransform();
      return 'blocked';
    }

    let kb = hit.knockback, kbUp = hit.knockbackUp;
    this.hp = Math.max(0, this.hp - hit.damage);
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
      this.transformed = true;
      this.maxHp += t.bonusHp;
      this.hp = Math.min(this.maxHp, this.hp + t.bonusHp);
      this._justTransformed = true;
    }
  }

  // Clears everything that lasts beyond a single action, so nothing carries
  // from one round into the next: Robert's transformation, timed buffs
  // (Overgrowth, Encore), poison, shields/dodge windows, stun, hover fuel and
  // any half-finished move. Position, HP and meters are set by the caller.
  resetForRound() {
    this.revertTransform();
    this.buffTimer = 0;
    this.buffAtkMul = 1;
    this.buffSpdMul = 1;
    this.buffSizeMul = 1;
    this.atkSpeedMul = 1;
    this.poisonTicksLeft = 0;
    this.poisonTickTimer = 0;
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
    this.phaseCooldown = 0;
    this._comboHeld = false;
    this.blocking = false;
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
    this.maxHp = this.character.maxHp;
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

  update(controls, opponent) {
    this._controls = controls;
    this._updateStatusTimers();

    this.rolling = false; // set again below while a crouch-roll is in progress
    if (this.state !== 'ko' && this.state !== 'victory') {
      this._handleInput(controls, opponent);
    }
    this._updateActionState();
    this._updateHover();
    this._applyPhysics();
    this._resolveFacing(opponent);
  }

  _updateStatusTimers() {
    if (this.specialCooldownTimer > 0) {
      this.specialCooldownTimer = Math.max(0, this.specialCooldownTimer - FIXED_STEP);
    }
    if (this.hitFlashTimer > 0) this.hitFlashTimer--;
    if (this.phaseCooldown > 0) this.phaseCooldown--;
    if (this.invulnerableTimer > 0) this.invulnerableTimer--;
    if (this.reflectTimer > 0) this.reflectTimer--;
    if (this.doubleJumpFlipTimer > 0) this.doubleJumpFlipTimer--;

    if (this.buffTimer > 0) {
      this.buffTimer--;
      if (this.buffTimer <= 0) {
        this.buffAtkMul = 1;
        this.buffSpdMul = 1;
        this.buffSizeMul = 1;
        this.atkSpeedMul = 1;
      }
    }

    if (this.poisonTicksLeft > 0) {
      this.poisonTickTimer--;
      if (this.poisonTickTimer <= 0) {
        this.hp = Math.max(0, this.hp - this.poisonDamagePerTick);
        this.poisonTicksLeft--;
        this.poisonTickTimer = this.poisonTickInterval;
        this.hitFlashTimer = Math.max(this.hitFlashTimer, 4);
        this._maybeTransform();
      }
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
    this.launched = false;
    this.stunFrames = 0;
    this.hitFlashTimer = 0;
    this.vx = 0;
    this.vy = 0;
    this.phaseCooldown = ps.cooldown;
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
    };
    // Held direction relative to facing, read even mid-attack: it aims the
    // hot potato (game.js) -- toward for a long hit, away for a short lob.
    this.aim = held.left === held.right ? 0 : (held.right ? 1 : -1) * this.facing;
    // Jump + crouch pressed together (either order, as long as both are down
    // and the pair was only just completed) -- Keenan's Phase Step escape.
    const comboDown = InputManager.isDown(controls.jump) && held.block;
    const comboEdge = comboDown && !this._comboHeld;
    this._comboHeld = comboDown;
    const pressed = {
      jump: InputManager.isPressed(controls.jump),
      attack: InputManager.isPressed(controls.attack),
      special: InputManager.isPressed(controls.special),
      ultimate: InputManager.isPressed(controls.ultimate),
    };

    if (this.state === 'hitstun' || this.state === 'knockdown') {
      if (comboEdge) this._tryPhaseStep(opponent);
      return; // no other input while stunned or downed
    }
    if (this.state === 'attack' || this.state === 'special' || this.state === 'ultimate' || this.state === 'phasestep') {
      return; // committed to the action until it finishes
    }

    const phased = this.isPhased; // ultimate phase-out: can move, can't act

    if (!phased) {
      // Blocking: only while grounded. Re-checked every frame (unlike
      // attack/special above) so releasing the key immediately frees the
      // player up to move/attack again. Still allows a slow crouch-walk
      // rather than fully rooting the player in place.
      if (held.block && this.grounded) {
        this.blockFrames = this.blocking ? this.blockFrames + 1 : 1;
        this.blocking = true;
        this.state = 'block';
        let crouchDir = 0;
        if (held.left && !held.right) crouchDir = -1;
        else if (held.right && !held.left) crouchDir = 1;
        if (crouchDir !== 0) {
          const roll = this.character.crouchRoll;
          this.vx = crouchDir * this.moveSpeedEff * (roll ? roll.speedMul : CROUCH_SPEED_MULTIPLIER);
          this.rolling = !!roll;
        } else {
          this.vx *= FRICTION;
        }
        return;
      }
    }
    this.blocking = false;
    this.blockFrames = 0;

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

    if (moveDir !== 0) {
      this.vx = moveDir * this.moveSpeedEff;
      if (this.grounded) this.state = 'walk';
    } else if (this.grounded) {
      this.state = 'idle';
    }

    if (pressed.jump && this.jumpsUsed < this.character.maxJumps) {
      this.vy = -this.character.jumpForce;
      this.jumpsUsed++;
      this.grounded = false;
      this.state = 'jump';
      if (this.jumpsUsed === 2 && this.character.doubleJumpFlip) {
        this.doubleJumpFlipTimer = 24;
      }
    }
  }

  // Hold-jump hover (characters with a `hover` block, e.g. Carlos). While
  // held in normal air movement, gravity is cancelled and fuel drains; it
  // refills on landing. Getting hit or starting an attack ends it.
  _updateHover() {
    const h = this.character.hover;
    if (!h) return;
    if (this.grounded) {
      this.hoverLeft = h.frames;
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
    this.actionTimer += (this.atkSpeedMul || 1);

    if (this.state === 'attack') {
      const a = this.character.attack;
      const total = a.startup + a.active + a.recovery;
      this._decelerate();
      if (this.actionTimer > total) this._endAbility();
    }

    if (this.state === 'phasestep') this._updatePhaseStep();
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

  _updatePoisonBurstAction(def) {
    this._decelerate();
    const total = def.startup + def.active + def.recovery;
    if (this.actionTimer > total) this._endAbility();
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
      if (groundEnds || this.actionTimer >= a.diveEndTimer || this.attackHasHit) {
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
    const CHARGE_THRESHOLD = 10;

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
      if (def.atkMul) this.buffAtkMul = def.atkMul;
      if (def.spdMul) this.buffSpdMul = def.spdMul;
      if (def.atkSpeedMul) this.atkSpeedMul = def.atkSpeedMul;
      this._endAbility();
    } else {
      this._decelerate();
    }
  }

  _applyPhysics() {
    this.vy += GRAVITY * (this.character.gravityMul || 1);
    const prevY = this.y;
    this.x += this.vx;
    this.y += this.vy;

    if (this.state !== 'walk' && !this._keepsAirMomentum()) {
      // Balance mode: the shakier you are, the more you slide.
      this.vx *= FRICTION + BALANCE_SLIP * this.shakiness;
    }

    const onStage = this.x > STAGE_LEFT_EDGE && this.x < STAGE_RIGHT_EDGE;

    if (onStage && this.y > GROUND_Y && prevY > GROUND_Y) {
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
      if (!this.grounded) {
        this.grounded = true;
        this.jumpsUsed = 0;
        this.launched = false;
        if (this.state === 'jump' || this.state === 'fall') this.state = 'idle';
      }
    } else if (!onStage && this.y >= GROUND_Y) {
      this.grounded = false;
    } else {
      this.grounded = false;
    }

    // Keep fighters from flying fully off the visible canvas while airborne.
    this.x = Math.max(-40, Math.min(CANVAS_WIDTH + 40, this.x));

    this.walkCycle += Math.abs(this.vx) * 0.05;
  }

  _resolveFacing(opponent) {
    if (this.facingLocked) return;
    if (this.state === 'block') return;
    this.facing = opponent.x >= this.x ? 1 : -1;
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
      case 'hitstun': return 'hit';
      case 'knockdown': return 'knockdown';
      case 'ko': return 'ko';
      case 'victory': return 'victory';
      default: return 'idle';
    }
  }
}
