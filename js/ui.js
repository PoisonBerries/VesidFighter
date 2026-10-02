// DOM screen management: title, character select,
// pause menu, and match-end. The canvas only ever draws the arena/HUD; every
// menu is a plain HTML overlay toggled via a `hidden` class.

const UI = (() => {
  const screens = {
    title: document.getElementById('screen-title'),
    select: document.getElementById('screen-select'),
    online: document.getElementById('screen-online'),
    matchend: document.getElementById('screen-matchend'),
    pause: document.getElementById('pause-menu'),
  };

  let selected = { p1: 'keenan', p2: 'artur' };
  // Vs CPU: player 1 is you, player 2 is the computer.
  let cpuMode = false;
  let cpuLevel = 'normal';
  try { cpuLevel = localStorage.getItem('vf_cpu_level') || 'normal'; } catch (e) { /* storage blocked */ }
  // Ball mode for the match (constants.js BALL_MODES). Online, player 1's choice is used.
  let ballMode = BALL_MODE;
  try { const m = localStorage.getItem('vf_ball_mode'); if (BALL_MODES.includes(m)) ballMode = m; } catch (e) { /* storage blocked */ }
  // Balance meter on/off. Online, player 1's choice is used.
  let stageId = DEFAULT_STAGE;
  try { const v = localStorage.getItem('vf_stage'); if (STAGE_IDS.includes(v)) stageId = v; } catch (e) { /* storage blocked */ }
  let balanceOn = BALANCE_ENABLED;
  try { const v = localStorage.getItem('vf_balance'); if (v === 'on' || v === 'off') balanceOn = v === 'on'; } catch (e) { /* storage blocked */ }
  if (!Cpu.LEVELS[cpuLevel]) cpuLevel = 'normal';
  const LEVEL_NAMES = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
  let isPaused = false;

  function show(name) {
    for (const key of Object.keys(screens)) {
      screens[key].classList.toggle('hidden', key !== name);
    }
  }

  function hideAll() {
    for (const key of Object.keys(screens)) {
      screens[key].classList.add('hidden');
    }
  }

  // ---- Character select ----

  // Stat bars read a 30-100% scale (not 0-100%) so even the roster's lowest
  // value still reads as a visible bar rather than a near-invisible sliver.
  function statRange(accessor) {
    const vals = CHARACTER_LIST.map(accessor);
    return { min: Math.min(...vals), max: Math.max(...vals) };
  }
  // Attack speed has no single stored field -- it's the basic attack's total
  // frame count (startup+active+recovery). Lower frames = faster, so we
  // invert it here into a "higher is faster" score that fits the same
  // higher-is-fuller stat-bar convention as everything else.
  function atkSpeedScore(c) {
    return 1000 / (c.attack.startup + c.attack.active + c.attack.recovery);
  }
  const STAT_RANGES = {
    speed: statRange((c) => c.moveSpeed),
    atkSpeed: statRange(atkSpeedScore),
    power: statRange((c) => c.attack.damage),
    hp: statRange((c) => c.maxHp),
    size: statRange((c) => c.sizeScale),
  };
  function statPct(value, range) {
    if (range.max === range.min) return 100;
    return Math.round(((value - range.min) / (range.max - range.min)) * 70 + 30);
  }

  function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // Big full-body fighters behind the select screen, like a fighting game's
  // versus screen. Each is the real fighter, drawn by the game's own renderer
  // in its ready stance (so it breathes and moves), on a canvas at the edge of
  // the screen: P1 on the left facing right, P2 on the right facing left. It
  // follows whatever the preview shows -- hovering, picking, the Random
  // shuffle -- and slides in from the edge when it changes.
  const SelectArt = (() => {
    const slots = {
      p1: { canvas: document.getElementById('select-art-p1'), id: null, swap: false, fighter: null, since: 0 },
      p2: { canvas: document.getElementById('select-art-p2'), id: null, swap: false, fighter: null, since: 0 },
    };
    const FIGHTER_MAX_H = 210; // game units: the tallest fighter (John) fills ~72% of the height
    let running = false, last = 0;

    function set(slot, charId, transformed) {
      const s = slots[slot];
      if (!s.canvas) return;
      transformed = !!transformed && !!CHARACTERS[charId].transform;
      const swap = slot === 'p2' && charId === selected.p1; // mirror match: the alternate colours
      if (s.id === charId && s.swap === swap && s.transformed === transformed) return;
      s.id = charId;
      s.swap = swap;
      s.transformed = transformed;
      s.fighter = new Fighter(slot, CHARACTERS[charId], 0, 1);
      s.fighter.transformed = transformed;
      s.fighter.paletteSwap = swap;
      s.since = performance.now();
    }

    function draw(slot, now) {
      const s = slots[slot];
      if (!s.fighter || !s.canvas) return;
      const cv = s.canvas, dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = cv.clientWidth, ch = cv.clientHeight;
      if (!cw || !ch) return;
      if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
        cv.width = Math.round(cw * dpr);
        cv.height = Math.round(ch * dpr);
      }
      const g = cv.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, cv.width, cv.height);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const f = s.fighter;
      const enter = Math.min(1, (now - s.since) / 280);
      const ease = 1 - Math.pow(1 - enter, 3);
      const dir = slot === 'p1' ? 1 : -1;
      const k = (0.72 * ch) / FIGHTER_MAX_H;
      const floorY = ch * 0.94;
      const cx = cw * (slot === 'p1' ? 0.4 : 0.6); // toward the outer edge, clear of the roster
      // A glow in the fighter's colour, and a soft shadow on the floor.
      const glow = g.createRadialGradient(cx, ch * 0.55, 0, cx, ch * 0.55, ch * 0.6);
      glow.addColorStop(0, hexToRgba(f.displayColor, 0.34 * ease));
      glow.addColorStop(1, hexToRgba(f.displayColor, 0));
      g.fillStyle = glow;
      g.fillRect(0, 0, cw, ch);
      g.fillStyle = `rgba(0,0,0,${0.35 * ease})`;
      g.beginPath();
      g.ellipse(cx, floorY + 4, f.width * k * 0.5, 9, 0, 0, Math.PI * 2);
      g.fill();
      g.translate(cx - dir * (1 - ease) * 70, floorY); // slides in from the outer edge
      g.scale(dir * k, k);
      g.translate(-f.x, -f.y);
      g.globalAlpha = 0.85 * ease;
      Renderer.drawFighter(g, f, { card: true });
    }

    function loop(now) {
      if (screens.select.classList.contains('hidden')) { running = false; return; }
      requestAnimationFrame(loop);
      if (now - last < 22) return; // ~45fps is plenty for a backdrop
      last = now;
      const t = performance.now();
      draw('p1', t);
      draw('p2', t);
    }

    function start() {
      if (running) return;
      running = true;
      requestAnimationFrame(loop);
    }

    return { set, start };
  })();

  // Characters that transform (Robert) can show either form in the overview.
  const showForm = { p1: false, p2: false };

  function renderPreview(slot, charId) {
    const char = CHARACTERS[charId];
    const tf = char.transform || null;
    const transformed = !!tf && showForm[slot];
    SelectArt.set(slot, charId, transformed);
    // null on the opponent's panel (online, or the CPU's side)
    const controls = cpuMode ? (slot === 'p1' ? CONTROLS.solo : null) : Net.controlLabelsFor(slot);
    const container = document.getElementById('preview-' + slot);
    // Mirror match: player 2 gets the alternate colours, as in the fight.
    const baseColor = transformed && char.transformColor ? char.transformColor : char.color;
    const color = (slot === 'p2' && charId === selected.p1) ? swapPalette(baseColor) : baseColor;

    container.style.setProperty('--fp-color', color);
    container.style.setProperty('--fp-glow', hexToRgba(color, 0.45));

    const pct = (v, range) => Math.max(8, Math.min(100, statPct(v, range)));
    const speedPct = pct(char.moveSpeed * (transformed ? tf.spdMul : 1), STAT_RANGES.speed);
    const atkSpeedPct = pct(atkSpeedScore(char), STAT_RANGES.atkSpeed);
    const powerPct = pct(char.attack.damage * (transformed ? tf.dmgMul : 1), STAT_RANGES.power);
    const hpPct = pct(char.maxHp + (transformed ? tf.bonusHp : 0), STAT_RANGES.hp);
    const sizePct = pct(char.sizeScale * (transformed ? tf.sizeMul : 1), STAT_RANGES.size);

    container.innerHTML = `
      <div class="preview-head">
      <div class="preview-id">
      <div class="preview-avatar-wrap">
        <div class="avatar-fallback" style="background:${color}"></div>
        <img class="avatar-img" src="assets/heads/${char.id}${transformed ? '-transformed' : ''}.png" alt="" onerror="this.onerror=null;this.src='assets/heads/${char.id}.png'">
      </div>
      <div class="preview-name">${char.name}</div>
      <div class="preview-title">${char.title}</div>
      ${tf ? `<div class="form-toggle" role="group" aria-label="Form"><button type="button" data-form="base" class="${transformed ? '' : 'on'}">Base</button><button type="button" data-form="transformed" class="${transformed ? 'on' : ''}">Transformed</button></div>` : ''}
      </div>
      <div class="stat-bars">
        <div class="stat-row"><span class="stat-label">Speed</span><div class="stat-bar"><div class="stat-fill" style="width:${speedPct}%"></div></div></div>
        <div class="stat-row"><span class="stat-label">Atk Spd</span><div class="stat-bar"><div class="stat-fill" style="width:${atkSpeedPct}%"></div></div></div>
        <div class="stat-row"><span class="stat-label">Power</span><div class="stat-bar"><div class="stat-fill" style="width:${powerPct}%"></div></div></div>
        <div class="stat-row"><span class="stat-label">HP</span><div class="stat-bar"><div class="stat-fill" style="width:${hpPct}%"></div></div></div>
        <div class="stat-row"><span class="stat-label">Size</span><div class="stat-bar"><div class="stat-fill" style="width:${sizePct}%"></div></div></div>
      </div>
      </div>
      <div class="preview-abilities">
      <div class="ability-row">
        ${controls ? `<span class="key-badge">${keyLabel(controls.special)}</span>` : ''}
        <div>
          <div class="ability-name">Special: ${char.special.name}</div>
          <div class="ability-desc">${char.special.description}</div>
        </div>
      </div>
      <div class="ability-row">
        ${controls ? `<span class="key-badge">${keyLabel(controls.ultimate)}</span>` : ''}
        <div>
          <div class="ability-name">Ultimate: ${char.ultimate.name}</div>
          <div class="ability-desc">${char.ultimate.description}</div>
        </div>
      </div>
      ${char.hover ? `<div class="ability-row">
        ${controls ? `<span class="key-badge">${keyLabel(controls.jump)}</span>` : ''}
        <div>
          <div class="ability-name">Hover</div>
          <div class="ability-desc">Hold jump in the air to hang in place on the thrusters for a moment. Refills on landing.</div>
        </div>
      </div>` : ''}
      ${char.hoverDive ? `<div class="ability-row">
        ${controls ? `<span class="key-badge">${keyLabel(controls.attack)}</span>` : ''}
        <div>
          <div class="ability-name">Claw Dive</div>
          <div class="ability-desc">Attack while hovering: spin into a forward claw dive (hold jump in the air to hover first).</div>
        </div>
      </div>` : ''}
      ${char.phaseStep ? `<div class="ability-row">
        ${controls ? `<span class="key-badge">${keyLabel(controls.jump)}+${keyLabel(controls.block)}</span>` : ''}
        <div>
          <div class="ability-name">Phase Step</div>
          <div class="ability-desc">While being hit, press jump and crouch together to slip through your opponent and come out behind them. ${Math.round(char.phaseStep.cooldown / 60)}s cooldown.</div>
        </div>
      </div>` : ''}
      ${char.passive ? `<div class="ability-row">
        <div>
          <div class="ability-name">Passive: ${char.passive.name}</div>
          <div class="ability-desc">${char.passive.description}</div>
        </div>
      </div>` : ''}
      ${tf ? `<div class="ability-row">
        <div>
          <div class="ability-name">Passive: Transformation</div>
          <div class="ability-desc">At half health he transforms: +${tf.bonusHp} max health (his health keeps the same percentage), ${Math.round((tf.dmgMul - 1) * 100)}% more damage and ${Math.round((tf.sizeMul - 1) * 100)}% bigger, but ${Math.round((1 - tf.spdMul) * 100)}% slower.</div>
        </div>
      </div>` : ''}
      ${char.chargeJump ? `<div class="ability-row">
        ${controls ? `<span class="key-badge">${keyLabel(controls.jump)}</span>` : ''}
        <div>
          <div class="ability-name">Charged Jump</div>
          <div class="ability-desc">Hold jump to charge &mdash; the longer, the higher. Fully charged, he rockets up, throws his arms out and spins down in a plasma whirlwind.</div>
        </div>
      </div>` : ''}
      ${char.grabSlam ? `<div class="ability-row">
        <div>
          <div class="ability-name">Grab &amp; Slam</div>
          <div class="ability-desc">Land ${char.grabSlam.hits} hits in a row without being blocked or hit back and he lifts the opponent and slams them down, stunning them for a second.</div>
        </div>
      </div>` : ''}
      ${char.grabBeat ? `<div class="ability-row">
        <div>
          <div class="ability-name">Carry &amp; Pummel</div>
          <div class="ability-desc">Land ${char.grabBeat.hits} hits in a row without being blocked or hit back and he throws the opponent over his shoulder and pounds them until they wriggle loose.</div>
        </div>
      </div>` : ''}
      ${char.downAttack && char.downAttack.knockdownOnHit ? `<div class="ability-row">
        ${controls ? `<span class="key-badge">${keyLabel(controls.block)}+${keyLabel(controls.attack)}</span>` : ''}
        <div>
          <div class="ability-name">Elbow Drop</div>
          <div class="ability-desc">In the air, down + attack: drop elbow-first onto your opponent, knocking them down for a free hit.</div>
        </div>
      </div>` : ''}
      ${char.comboSong ? `<div class="ability-row">
        ${controls ? `<span class="key-badge">${keyLabel(controls.block)}+${keyLabel(controls.attack)}</span>` : ''}
        <div>
          <div class="ability-name">Combo Tune &amp; Shockwave</div>
          <div class="ability-desc">Every hit plays a note &mdash; string hits together and it becomes a song. In the air: attack is a backflip kick; down + attack sends out a musical shockwave that stuns.</div>
        </div>
      </div>` : ''}
      ${char.bloodDonor ? `<div class="ability-row">
        <div>
          <div class="ability-name">Passive: Blood Donor</div>
          <div class="ability-desc">The lower his health, the harder he hits and the faster he attacks and moves &mdash; up to +${Math.round(char.bloodDonor.damage * 100)}% damage, +${Math.round(char.bloodDonor.attackSpeed * 100)}% attack speed and +${Math.round(char.bloodDonor.speed * 100)}% movement speed at no health.</div>
        </div>
      </div>` : ''}
      ${char.crouchSwim ? `<div class="ability-row">
        ${controls ? `<span class="key-badge">${keyLabel(controls.block)}</span>` : ''}
        <div>
          <div class="ability-name">Swim & slide</div>
          <div class="ability-desc">Crouching lays him flat on the floor: very low, so punches go over him, and he swims along quickly. Crouch while running to slide on with your momentum.</div>
        </div>
      </div>` : ''}
      ${char.crouchRoll ? `<div class="ability-row">
        ${controls ? `<span class="key-badge">${keyLabel(controls.block)}+${keyLabel(controls.left)}/${keyLabel(controls.right)}</span>` : ''}
        <div>
          <div class="ability-name">Crouch-roll</div>
          <div class="ability-desc">Moving while crouched is a tuck-and-roll, a bit quicker than a crouch-walk.</div>
        </div>
      </div>` : ''}
      ${char.elastic ? `<div class="ability-row">
        <div>
          <div class="ability-name">Rubber body</div>
          <div class="ability-desc">Stretching punches with a very long reach; the body wobbles, squashes and rebounds when hit.</div>
        </div>
      </div>` : ''}
      </div>
    `;
    container.querySelectorAll('.form-toggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        showForm[slot] = btn.dataset.form === 'transformed';
        renderPreview(slot, charId);
      });
    });
  }

  // The Random tile: shuffles the preview through the roster for a moment,
  // then lands on a fighter (never the one already selected). Online, only
  // the final choice is sent, so the opponent just sees the pick change once.
  const spinning = { p1: false, p2: false };
  function pickRandom(slot, containerId) {
    if (Net.isOnline() && slot !== Net.localSlot()) return;
    if (spinning[slot]) return;
    spinning[slot] = true;
    const others = CHARACTER_LIST.filter((c) => c.id !== selected[slot]);
    const final = others[Math.floor(Math.random() * others.length)].id;
    const order = CHARACTER_LIST.map((c) => c.id);
    let at = Math.floor(Math.random() * order.length), ticks = 0;
    const total = 12 + Math.floor(Math.random() * 4);
    const tile = document.querySelector('#' + containerId + ' .random');
    if (tile) tile.classList.add('spinning');
    const timer = setInterval(() => {
      ticks++;
      if (ticks < total) { renderPreview(slot, order[at++ % order.length]); return; }
      clearInterval(timer);
      spinning[slot] = false;
      if (Net.isOnline()) Net.sendCtrl({ t: 'pick', slot, id: final });
      selected[slot] = final;
      buildCharCards(containerId, slot);
      refreshSelect();
    }, 70);
  }

  function buildCharCards(containerId, slot) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    for (const char of CHARACTER_LIST) {
      const icon = document.createElement('div');
      icon.className = 'roster-icon' + (selected[slot] === char.id ? ' selected' : '');
      icon.innerHTML = `
        <div class="roster-avatar">
          <div class="icon-fallback" style="background:${char.color}"></div>
          <img class="icon-img" src="assets/heads/${char.id}.png" alt="" onerror="this.style.display='none'">
        </div>
        <div class="roster-name">${char.name}</div>
      `;
      icon.addEventListener('mouseenter', () => renderPreview(slot, char.id));
      icon.addEventListener('mouseleave', () => renderPreview(slot, selected[slot]));
      icon.addEventListener('click', () => {
        if (Net.isOnline()) {
          if (slot !== Net.localSlot()) return;
          Net.sendCtrl({ t: 'pick', slot, id: char.id });
        }
        selected[slot] = char.id;
        Sfx.voice(char.id, 'selected'); // the fighter's "picked me" line
        buildCharCards(containerId, slot);
        refreshSelect();
      });
      container.appendChild(icon);
    }
    const random = document.createElement('div');
    random.className = 'roster-icon random' + (spinning[slot] ? ' selected spinning' : '');
    random.title = 'Pick a random fighter';
    random.innerHTML = `
      <div class="roster-avatar"><span class="random-mark">?</span></div>
      <div class="roster-name">Random</div>
    `;
    random.addEventListener('click', () => pickRandom(slot, containerId));
    container.appendChild(random);
  }

  function openSelect() {
    const online = Net.isOnline();
    const local = Net.localSlot();
    document.getElementById('p1-cards').classList.toggle('locked', online && local !== 'p1');
    document.getElementById('p2-cards').classList.toggle('locked', online && local !== 'p2');
    document.getElementById('btn-fight').disabled = online && !Net.isLeader();
    document.getElementById('cpu-difficulty').classList.toggle('hidden', !cpuMode);
    syncDifficulty();
    syncStage();
    syncBallMode();
    for (const b of document.querySelectorAll('#ball-mode button, #balance-mode button, #stage-mode button')) b.disabled = online && !Net.isLeader();
    syncBalance();
    buildCharCards('p1-cards', 'p1');
    buildCharCards('p2-cards', 'p2');
    refreshSelect();
    show('select');
    SelectArt.start();
  }

  // Re-render both previews plus the side labels and the note under them
  // (a pick on either side can change the other's preview -- mirror match).
  function refreshSelect() {
    const online = Net.isOnline();
    const local = Net.localSlot();
    for (const slot of ['p1', 'p2']) {
      const el = document.querySelector('.' + slot + '-label');
      el.textContent = cpuMode
        ? (slot === 'p1' ? 'Player 1 — You' : 'CPU — ' + LEVEL_NAMES[cpuLevel])
        : 'Player ' + slot.slice(1) + (online ? (slot === local ? ' — You' : ' — Opponent') : '');
      el.style.color = PLAYER_COLORS[slot];
      renderPreview(slot, selected[slot]);
    }
    const parts = [];
    if (online) {
      const k = CONTROLS.solo;
      parts.push(Net.isLeader() ? 'You are Player 1. Press Fight! when you are both ready.'
        : 'You are Player 2. Waiting for the host to start...');
      parts.push(`Your controls: ${keyLabel(k.left)}/${keyLabel(k.right)} move · ${keyLabel(k.jump)} jump · ${keyLabel(k.block)} crouch · ${keyLabel(k.guard)} guard · ${keyLabel(k.attack)} attack · ${keyLabel(k.special)} special · ${keyLabel(k.ultimate)} ultimate (arrow keys move too)`);
    }
    if (cpuMode) {
      const k = CONTROLS.solo;
      parts.push(`Your controls: ${keyLabel(k.left)}/${keyLabel(k.right)} move · ${keyLabel(k.jump)} jump · ${keyLabel(k.block)} crouch · ${keyLabel(k.guard)} guard · ${keyLabel(k.attack)} attack · ${keyLabel(k.special)} special · ${keyLabel(k.ultimate)} ultimate (arrow keys move too)`);
    }
    if (selected.p1 === selected.p2) parts.push('Mirror match: Player 2 gets an alternate colour scheme.');
    document.getElementById('select-online-note').innerHTML = parts.join('<br>');
  }

  // ---- Match flow ----
  function startFight() {
    if (Net.isOnline()) {
      if (!Net.isLeader()) return; // P1 drives match start
      const mid = Net.isRollback() ? Net.newMatchId() : undefined;
      Net.sendCtrl({ t: 'start', p1: selected.p1, p2: selected.p2, mid, ball: ballMode, balance: balanceOn, stage: stageId });
      if (Net.isServer()) return; // wait for the server to echo 'start'
      beginMatch(mid);
      return;
    }
    beginMatch();
  }

  function beginMatch(matchId) {
    hideAll();
    window.VF_setPaused(false);
    isPaused = false;
    Game.startMatch(selected.p1, selected.p2, onMatchEnd, { ball: ballMode, balance: balanceOn, stage: stageId });
    if (cpuMode) Cpu.start('p2', cpuLevel, Date.now() >>> 0); else Cpu.stop();
    // Direct matches: both sides simulate from this exact starting state.
    if (Net.isRollback()) Net.startRollback(matchId);
  }

  function onMatchEnd(winnerSlot) {
    // With rollback both players see the match end themselves.
    const online = Net.isOnline();
    document.getElementById('btn-rematch').disabled = online && !Net.isLeader();
    document.getElementById('btn-rematch').textContent = online && !Net.isLeader() ? 'P1 picks rematch' : 'Rematch';
    if (!cpuMode) Stats.reportMatch(online ? 'online' : 'local', selected.p1, selected.p2, winnerSlot, { stage: stageId, ball: ballMode, balance: balanceOn });
    const winnerChar = CHARACTERS[selected[winnerSlot]];
    const you = cpuMode ? 'p1' : online ? Net.localSlot() : null;
    const outcome = !you ? '' : (winnerSlot === you ? ' — YOU WIN!' : ' — YOU LOSE');
    document.getElementById('matchend-title').textContent =
      `${winnerChar.name} (${winnerSlot.toUpperCase()}) WINS THE MATCH!${outcome}`;
    show('matchend');
  }

  // Leaving a match for the main menu ends it. Nothing may keep simulating
  // behind the title screen: the CPU carrying on fighting, sounds firing, or a
  // round/match end popping its screen up over the menu.
  function leaveMatch() {
    Cpu.stop();
    Game.stop();
    isPaused = false;
    window.VF_setPaused(false);
  }

  function togglePause() {
    isPaused = !isPaused;
    window.VF_setPaused(isPaused);
    if (isPaused) {
      show('pause');
    } else {
      hideAll();
    }
  }

  // ---- Wire up buttons ----
  document.getElementById('btn-start').addEventListener('click', () => { cpuMode = false; Cpu.stop(); openSelect(); });
  document.getElementById('btn-cpu').addEventListener('click', () => {
    cpuMode = true;
    if (selected.p2 === selected.p1) {
      const others = CHARACTER_LIST.filter((c) => c.id !== selected.p1);
      selected.p2 = others[Math.floor(Math.random() * others.length)].id;
    }
    openSelect();
  });
  function syncDifficulty() {
    for (const b of document.querySelectorAll('#cpu-difficulty button')) b.classList.toggle('active', b.dataset.level === cpuLevel);
  }
  function syncBalance() {
    for (const b of document.querySelectorAll('#balance-mode button')) b.classList.toggle('active', (b.dataset.balance === 'on') === balanceOn);
  }
  for (const b of document.querySelectorAll('#balance-mode button')) {
    b.addEventListener('click', () => {
      balanceOn = b.dataset.balance === 'on';
      try { localStorage.setItem('vf_balance', balanceOn ? 'on' : 'off'); } catch (e) { /* storage blocked */ }
      syncBalance();
    });
  }
  function syncStage() {
    for (const b of document.querySelectorAll('#stage-mode button')) b.classList.toggle('active', b.dataset.stage === stageId);
  }
  for (const b of document.querySelectorAll('#stage-mode button')) {
    b.addEventListener('click', () => {
      stageId = b.dataset.stage;
      try { localStorage.setItem('vf_stage', stageId); } catch (e) { /* storage blocked */ }
      syncStage();
    });
  }
  function syncBallMode() {
    for (const b of document.querySelectorAll('#ball-mode button')) b.classList.toggle('active', b.dataset.ball === ballMode);
  }
  for (const b of document.querySelectorAll('#ball-mode button')) {
    b.addEventListener('click', () => {
      ballMode = b.dataset.ball;
      try { localStorage.setItem('vf_ball_mode', ballMode); } catch (e) { /* storage blocked */ }
      syncBallMode();
    });
  }
  for (const b of document.querySelectorAll('#cpu-difficulty button')) {
    b.addEventListener('click', () => {
      cpuLevel = b.dataset.level;
      try { localStorage.setItem('vf_cpu_level', cpuLevel); } catch (e) { /* storage blocked */ }
      syncDifficulty();
      refreshSelect();
    });
  }

  document.getElementById('btn-select-back').addEventListener('click', () => show('title'));
  document.getElementById('btn-fight').addEventListener('click', startFight);

  document.getElementById('btn-rematch').addEventListener('click', startFight);
  document.getElementById('btn-change-chars').addEventListener('click', () => {
    Net.sendCtrl({ t: 'select' });
    openSelect();
  });
  document.getElementById('btn-main-menu').addEventListener('click', () => {
    Net.disconnect();
    leaveMatch();
    show('title');
  });

  // ---- Online lobby ----
  const onlineStatus = document.getElementById('online-status');
  const joinInput = document.getElementById('join-code');

  function setOnlineStatus(text, code) {
    onlineStatus.innerHTML = '';
    if (code) {
      const codeEl = document.createElement('div');
      codeEl.className = 'room-code';
      codeEl.textContent = code;
      onlineStatus.appendChild(codeEl);
    }
    onlineStatus.appendChild(document.createTextNode(text));
  }

  document.getElementById('btn-online').addEventListener('click', () => {
    cpuMode = false;
    Cpu.stop();
    setOnlineStatus('');
    show('online');
  });
  document.getElementById('btn-online-back').addEventListener('click', () => {
    Net.disconnect();
    show('title');
  });
  document.getElementById('btn-host').addEventListener('click', () => {
    setOnlineStatus('Creating room...');
    if (useServer()) Net.hostServer(); else Net.host();
  });
  const directToggle = document.getElementById('direct-toggle');
  directToggle.parentElement.style.display = GAME_SERVER_URL ? '' : 'none';
  function useServer() {
    return !!GAME_SERVER_URL && !directToggle.checked;
  }

  function doJoin() {
    const code = joinInput.value.trim();
    if (!code) { setOnlineStatus('Enter the room code from the host.'); return; }
    if (useServer()) Net.joinServer(code); else Net.join(code);
  }
  document.getElementById('btn-join').addEventListener('click', doJoin);
  joinInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') doJoin();
  });

  Net.on('status', (s) => {
    if (s.code) setOnlineStatus('Send this code to your opponent. Waiting for them to join...', s.code);
    else setOnlineStatus(s.text);
  });
  Net.on('connected', () => {
    Net.sendCtrl({ t: 'pick', slot: Net.localSlot(), id: selected[Net.localSlot()] });
    openSelect();
  });
  Net.on('disconnected', (reason) => {
    Game.stop();
    isPaused = false;
    window.VF_setPaused(false);
    setOnlineStatus(reason);
    show('online');
  });
  Net.on('ctrl', (msg) => {
    if (!msg) return;
    if (msg.t === 'pick' && (msg.slot === 'p1' || msg.slot === 'p2') && CHARACTERS[msg.id]) {
      selected[msg.slot] = msg.id;
      if (!screens.select.classList.contains('hidden')) {
        buildCharCards(msg.slot + '-cards', msg.slot);
        refreshSelect();
      }
    } else if (msg.t === 'start' && (Net.isRemoteSim() || (Net.isRollback() && !Net.isLeader())) && CHARACTERS[msg.p1] && CHARACTERS[msg.p2]) {
      selected.p1 = msg.p1;
      selected.p2 = msg.p2;
      if (BALL_MODES.includes(msg.ball)) ballMode = msg.ball;
      if (typeof msg.balance === 'boolean') balanceOn = msg.balance;
      stageId = STAGE_IDS.includes(msg.stage) ? msg.stage : DEFAULT_STAGE;
      beginMatch(msg.mid);
    } else if (msg.t === 'select') {
      openSelect();
    } else if (msg.t === 'matchEnd' && Net.isRemoteSim()) {
      onMatchEnd(msg.winner);
    }
  });

  document.getElementById('btn-resume').addEventListener('click', togglePause);
  document.getElementById('btn-restart-match').addEventListener('click', () => {
    isPaused = false;
    window.VF_setPaused(false);
    startFight();
  });
  document.getElementById('btn-quit-to-menu').addEventListener('click', () => {
    leaveMatch();
    show('title');
  });

  show('title');

  return { togglePause };
})();
