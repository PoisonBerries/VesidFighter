// DOM screen management: title, character select, sprite customization,
// pause menu, and match-end. The canvas only ever draws the arena/HUD; every
// menu is a plain HTML overlay toggled via a `hidden` class.

const UI = (() => {
  const screens = {
    title: document.getElementById('screen-title'),
    select: document.getElementById('screen-select'),
    customize: document.getElementById('screen-customize'),
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
  function buildCharCards(containerId, slot) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    for (const char of CHARACTER_LIST) {
      const card = document.createElement('div');
      card.className = 'char-card' + (selected[slot] === char.id ? ' selected' : '');
      card.innerHTML = `
        <div class="swatch" style="background:${char.color}"></div>
        <div class="char-name">${char.name}</div>
        <div class="char-title">${char.title}</div>
        <div class="char-special">Special: ${char.special.name}</div>
        <div class="char-ultimate">Ultimate: ${char.ultimate.name}</div>
      `;
      card.addEventListener('click', () => {
        selected[slot] = char.id;
        buildCharCards(containerId, slot);
      });
      container.appendChild(card);
    }
  }

  function openSelect() {
    buildCharCards('p1-cards', 'p1');
    buildCharCards('p2-cards', 'p2');
    show('select');
  }

  // ---- Sprite customization ----
  function buildPoseGrid(slot) {
    const grid = document.getElementById('pose-grid-' + slot);
    grid.innerHTML = '';
    for (const pose of POSES) {
      const wrap = document.createElement('div');
      wrap.className = 'pose-slot';

      const label = document.createElement('div');
      label.className = 'pose-label';
      label.textContent = pose;

      const thumb = document.createElement('div');
      thumb.className = 'pose-thumb';
      renderThumb(thumb, slot, pose);

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        SpriteManager.setSpriteFromFile(slot, pose, file, () => {
          renderThumb(thumb, slot, pose);
        });
      });

      const clearBtn = document.createElement('button');
      clearBtn.className = 'clear-btn';
      clearBtn.textContent = 'Clear';
      clearBtn.addEventListener('click', () => {
        SpriteManager.clearSprite(slot, pose);
        fileInput.value = '';
        renderThumb(thumb, slot, pose);
      });

      wrap.appendChild(label);
      wrap.appendChild(thumb);
      wrap.appendChild(fileInput);
      wrap.appendChild(clearBtn);
      grid.appendChild(wrap);
    }
  }

  function renderThumb(thumb, slot, pose) {
    const dataUrl = SpriteManager.getThumbnail(slot, pose);
    if (dataUrl) {
      thumb.innerHTML = `<img src="${dataUrl}" alt="${pose}">`;
    } else {
      thumb.innerHTML = `<span class="placeholder-dot">no image</span>`;
    }
  }

  function openCustomize() {
    buildPoseGrid('p1');
    buildPoseGrid('p2');
    show('customize');
  }

  // ---- Match flow ----
  function startFight() {
    hideAll();
    window.VF_setPaused(false);
    isPaused = false;
    Game.startMatch(selected.p1, selected.p2, onMatchEnd);
  }

  function onMatchEnd(winnerSlot) {
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
  document.getElementById('btn-customize').addEventListener('click', openCustomize);
  document.getElementById('btn-customize-back').addEventListener('click', () => show('title'));

  document.getElementById('btn-select-back').addEventListener('click', () => show('title'));
  document.getElementById('btn-select-customize').addEventListener('click', openCustomize);
  document.getElementById('btn-fight').addEventListener('click', startFight);

  document.getElementById('btn-rematch').addEventListener('click', startFight);
  document.getElementById('btn-change-chars').addEventListener('click', openSelect);
  document.getElementById('btn-main-menu').addEventListener('click', () => show('title'));

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

  document.querySelectorAll('.reset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const slot = btn.getAttribute('data-slot');
      SpriteManager.clearSlot(slot);
      buildPoseGrid(slot);
    });
  });

  show('title');

  return { togglePause };
})();
