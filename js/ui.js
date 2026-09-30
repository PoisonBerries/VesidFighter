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

  function renderPreview(slot, charId) {
    const char = CHARACTERS[charId];
    const controls = CONTROLS[slot];
    const container = document.getElementById('preview-' + slot);

    container.style.setProperty('--fp-color', char.color);
    container.style.setProperty('--fp-glow', hexToRgba(char.color, 0.45));

    const speedPct = statPct(char.moveSpeed, STAT_RANGES.speed);
    const atkSpeedPct = statPct(atkSpeedScore(char), STAT_RANGES.atkSpeed);
    const powerPct = statPct(char.attack.damage, STAT_RANGES.power);
    const hpPct = statPct(char.maxHp, STAT_RANGES.hp);
    const sizePct = statPct(char.sizeScale, STAT_RANGES.size);

    container.innerHTML = `
      <div class="preview-avatar-wrap">
        <div class="avatar-fallback" style="background:${char.color}"></div>
        <img class="avatar-img" src="assets/heads/${char.id}.png" alt="" onerror="this.style.display='none'">
      </div>
      <div class="preview-name">${char.name}</div>
      <div class="preview-title">${char.title}</div>
      <div class="stat-bars">
        <div class="stat-row"><span class="stat-label">Speed</span><div class="stat-bar"><div class="stat-fill" style="width:${speedPct}%"></div></div></div>
        <div class="stat-row"><span class="stat-label">Atk Spd</span><div class="stat-bar"><div class="stat-fill" style="width:${atkSpeedPct}%"></div></div></div>
        <div class="stat-row"><span class="stat-label">Power</span><div class="stat-bar"><div class="stat-fill" style="width:${powerPct}%"></div></div></div>
        <div class="stat-row"><span class="stat-label">HP</span><div class="stat-bar"><div class="stat-fill" style="width:${hpPct}%"></div></div></div>
        <div class="stat-row"><span class="stat-label">Size</span><div class="stat-bar"><div class="stat-fill" style="width:${sizePct}%"></div></div></div>
      </div>
      <div class="ability-row">
        <span class="key-badge">${keyLabel(controls.special)}</span>
        <div>
          <div class="ability-name">Special: ${char.special.name}</div>
          <div class="ability-desc">${char.special.description}</div>
        </div>
      </div>
      <div class="ability-row">
        <span class="key-badge">${keyLabel(controls.ultimate)}</span>
        <div>
          <div class="ability-name">Ultimate: ${char.ultimate.name}</div>
          <div class="ability-desc">${char.ultimate.description}</div>
        </div>
      </div>
    `;
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
        buildCharCards(containerId, slot);
        renderPreview(slot, char.id);
      });
      container.appendChild(icon);
    }
  }

  function openSelect() {
    const online = Net.isOnline();
    const local = Net.localSlot();
    document.getElementById('p1-cards').classList.toggle('locked', online && local !== 'p1');
    document.getElementById('p2-cards').classList.toggle('locked', online && local !== 'p2');
    document.getElementById('btn-fight').disabled = online && !Net.isLeader();
    document.getElementById('select-online-note').textContent = !online ? ''
      : (Net.isLeader() ? 'Online: you are Player 1. Press Fight! when you are both ready.'
        : 'Online: you are Player 2. Waiting for the host to start...');
    buildCharCards('p1-cards', 'p1');
    buildCharCards('p2-cards', 'p2');
    renderPreview('p1', selected.p1);
    renderPreview('p2', selected.p2);
    show('select');
  }

  // ---- Match flow ----
  function startFight() {
    if (Net.isOnline()) {
      if (!Net.isLeader()) return; // P1 drives match start
      Net.sendCtrl({ t: 'start', p1: selected.p1, p2: selected.p2 });
      if (Net.isServer()) return; // wait for the server to echo 'start'
    }
    beginMatch();
  }

  function beginMatch() {
    hideAll();
    window.VF_setPaused(false);
    isPaused = false;
    Game.startMatch(selected.p1, selected.p2, onMatchEnd);
  }

  function onMatchEnd(winnerSlot) {
    if (Net.isHost()) Net.sendCtrl({ t: 'matchEnd', winner: winnerSlot });
    const online = Net.isOnline();
    document.getElementById('btn-rematch').disabled = online && !Net.isLeader();
    document.getElementById('btn-rematch').textContent = online && !Net.isLeader() ? 'P1 picks rematch' : 'Rematch';
    const winnerChar = CHARACTERS[selected[winnerSlot]];
    document.getElementById('matchend-title').textContent =
      `${winnerChar.name} (${winnerSlot.toUpperCase()}) WINS THE MATCH!`;
    show('matchend');
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
  document.getElementById('btn-start').addEventListener('click', openSelect);

  document.getElementById('btn-select-back').addEventListener('click', () => show('title'));
  document.getElementById('btn-fight').addEventListener('click', startFight);

  document.getElementById('btn-rematch').addEventListener('click', startFight);
  document.getElementById('btn-change-chars').addEventListener('click', () => {
    Net.sendCtrl({ t: 'select' });
    openSelect();
  });
  document.getElementById('btn-main-menu').addEventListener('click', () => {
    Net.disconnect();
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
        renderPreview(msg.slot, msg.id);
      }
    } else if (msg.t === 'start' && Net.isRemoteSim() && CHARACTERS[msg.p1] && CHARACTERS[msg.p2]) {
      selected.p1 = msg.p1;
      selected.p2 = msg.p2;
      beginMatch();
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
    isPaused = false;
    window.VF_setPaused(false);
    show('title');
  });

  show('title');

  return { togglePause };
})();
