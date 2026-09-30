// Keyboard input manager. Tracks held keys plus per-frame "just pressed"
// edges so attack/jump/special don't repeat-fire while a key is held down.

const InputManager = (() => {
  const down = new Set();
  const pressedThisFrame = new Set();
  // Virtual keys driven by net.js in online mode (not real keyboard codes).
  const virtualDown = new Set();
  const virtualPressed = new Set();

  const PREVENT_DEFAULT_CODES = new Set([
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space',
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyL', 'Semicolon', 'Quote',
  ]);

  window.addEventListener('keydown', (e) => {
    if (!down.has(e.code)) pressedThisFrame.add(e.code);
    down.add(e.code);
    if (PREVENT_DEFAULT_CODES.has(e.code)) e.preventDefault();
  });

  window.addEventListener('keyup', (e) => {
    down.delete(e.code);
  });

  // Lose focus (alt-tab, etc) shouldn't leave keys stuck "down".
  window.addEventListener('blur', () => {
    down.clear();
  });

  function isDown(code) {
    return down.has(code) || virtualDown.has(code);
  }

  function isPressed(code) {
    return pressedThisFrame.has(code) || virtualPressed.has(code);
  }

  function setVirtual(code, isDownNow, pressedNow) {
    if (isDownNow) virtualDown.add(code); else virtualDown.delete(code);
    if (pressedNow) virtualPressed.add(code); else virtualPressed.delete(code);
  }

  // Call once per physics tick, after all fighters have read input.
  function endFrame() {
    pressedThisFrame.clear();
    virtualPressed.clear();
  }

  return { isDown, isPressed, endFrame, setVirtual };
})();
