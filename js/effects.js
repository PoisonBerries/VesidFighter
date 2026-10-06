// Small juice layer: hit-spark particles and screen shake. Purely cosmetic,
// decoupled from game logic so it's easy to rip out or expand later.

const Effects = (() => {
  let particles = [];
  let shakeTime = 0;
  let shakeMagnitude = 0;
  let shakeScale = 1; // the victory screens shake much less (see Game.update)
  // Online host records sparks/shakes/resets so the guest can replay them.
  let recording = false;
  // Set by rollback netcode while it re-simulates frames it already showed,
  // so replays don't spawn duplicate sparks, shakes and hit sounds.
  let suppressed = false;
  let events = [];

  function spawnHitSpark(x, y, color, kind) {
    if (suppressed) return;
    if (recording) events.push(['h', Math.round(x), Math.round(y), color, kind]);
    if (typeof Sfx !== 'undefined') Sfx.impact(color, kind); // absent on the sim server
    for (let i = 0; i < 10; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 5;
      particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 18 + Math.random() * 10,
        maxLife: 28,
        color: color || '#ffe066',
        size: 2 + Math.random() * 3,
      });
    }
  }

  // A single slow, softly-rising ember -- meant to be called every frame
  // while an aura (special/ultimate glow, poison tint, etc) is active, so
  // the steady-state particle count naturally stays small.
  function spawnAuraPuff(x, y, color) {
    const angle = -Math.PI / 2 + (Math.random() * 2 - 1) * 0.9;
    const speed = 0.6 + Math.random() * 0.8;
    particles.push({
      x: x + (Math.random() * 2 - 1) * 20,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 20 + Math.random() * 10,
      maxLife: 30,
      color: color || '#ffe066',
      size: 1.5 + Math.random() * 2.5,
      noGravity: true,
    });
  }

  // Low, fast-fading puff kicked up where a fighter lands or slides. Local
  // only (each peer spawns its own from the animation), so not recorded.
  function spawnDust(x, y, count, power) {
    if (suppressed) return;
    for (let i = 0; i < count; i++) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      particles.push({
        x: x + (Math.random() * 2 - 1) * 14,
        y: y - 2,
        vx: dir * (0.5 + Math.random() * (power || 1.5)),
        vy: -(0.3 + Math.random() * 1.1),
        life: 14 + Math.random() * 10,
        maxLife: 24,
        color: '#d8cfee',
        size: 2 + Math.random() * 3,
        noGravity: true,
      });
    }
  }

  // Generic particle for ability effects: droplets, debris, embers.
  // Optional per-particle g (gravity), drag and shrink.
  function spawn(o) {
    if (suppressed) return;
    const life = o.life || 30;
    particles.push(Object.assign({ vx: 0, vy: 0, size: 3, color: '#fff', maxLife: life }, o, { life, maxLife: life }));
  }

  function shake(magnitude, frames) {
    if (suppressed) return;
    if (recording) events.push(['s', magnitude, frames]);
    shakeMagnitude = Math.max(shakeMagnitude, magnitude);
    shakeTime = Math.max(shakeTime, frames);
  }

  function update() {
    // Frames simulated again or ahead of time (rollback, the CPU's lookahead)
    // were already shown or never will be: don't age what's on screen.
    if (suppressed) return;
    particles = particles.filter(p => p.life > 0);
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      if (!p.noGravity) p.vy += (p.g === undefined ? 0.2 : p.g);
      p.vx *= (p.drag === undefined ? 0.95 : p.drag);
      p.life--;
    }
    if (shakeTime > 0) shakeTime--;
    else shakeMagnitude = 0;
  }

  function setShakeScale(v) { shakeScale = v; }

  function getShakeOffset() {
    if (shakeTime <= 0) return { x: 0, y: 0 };
    const m = shakeMagnitude * shakeScale * (shakeTime / 12);
    return {
      x: (Math.random() * 2 - 1) * m,
      y: (Math.random() * 2 - 1) * m,
    };
  }

  function draw(ctx) {
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.shrink ? Math.max(0.3, p.size * (p.life / p.maxLife)) : p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function reset() {
    if (recording) events.push(['r']);
    particles = [];
    shakeTime = 0;
    shakeMagnitude = 0;
    if (typeof AbilityFX !== 'undefined') AbilityFX.reset(); // absent on the sim server
  }

  // A character's voice line for an occasion (see Sfx.voice in audio.js). Like
  // hit sparks it's recorded for online play and skipped while the game
  // replays frames for rollback.
  function voice(charId, occasion) {
    if (suppressed) return;
    if (recording) events.push(['v', charId, occasion]);
    if (typeof Sfx !== 'undefined' && Sfx.voice) Sfx.voice(charId, occasion); // absent on the sim server
  }

  function setRecording(v) { recording = v; events = []; }
  function setSuppressed(v) { suppressed = !!v; }

  function drainEvents() {
    const out = events;
    events = [];
    return out;
  }

  function replayEvents(list) {
    for (const e of list || []) {
      if (e[0] === 'h') spawnHitSpark(e[1], e[2], e[3], e[4]);
      else if (e[0] === 's') shake(e[1], e[2]);
      else if (e[0] === 'v') voice(e[1], e[2]);
      else if (e[0] === 'r') reset();
    }
  }

  return { voice, setRecording, setSuppressed, drainEvents, replayEvents, spawnHitSpark, spawnAuraPuff, spawnDust, spawn, shake, setShakeScale, update, getShakeOffset, draw, reset };
})();
