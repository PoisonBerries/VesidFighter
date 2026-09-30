// Entry point: sets up the canvas and drives the fixed-timestep game loop.

(function () {
  const canvas = document.getElementById('game-canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d');

  let lastTime = performance.now();
  let accumulator = 0;
  let paused = false;

  window.VF_setPaused = (v) => { paused = v; };
  window.VF_isPaused = () => paused;

  function loop(now) {
    requestAnimationFrame(loop);

    let delta = (now - lastTime) / 1000;
    lastTime = now;
    delta = Math.min(delta, 0.25); // avoid spiral of death after tab-away

    if (!paused) {
      accumulator += delta;
      while (accumulator >= FIXED_STEP) {
        if (Net.isRemoteSim()) {
          Net.guestTick();
        } else if (Net.isRollback()) {
          Net.rollbackTick();
        } else if (Cpu.isActive()) {
          Cpu.tick();
        } else {
          Game.update(FIXED_STEP);
        }
        accumulator -= FIXED_STEP;
      }
    }

    Game.render(ctx);
  }

  requestAnimationFrame(loop);

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && Game.getState() === 'fight' && !Net.isOnline()) {
      UI.togglePause();
    }
  });
})();
