// Motion-capture clips for the animator. Clips are converted from FBX by
// tools/convert-mocap.js into assets/anim/<clip>.json, and
// assets/anim/moves.json says which character plays which clip for which
// move (see assets/anim/README.md). The animator asks clipFor(); a move with
// no clip keeps the built-in hand-made animation.
//
// Purely visual: clips move the drawn body, never hitboxes or timing, and
// nothing here is part of the simulation (so online play is unaffected).

const Mocap = (() => {
  let moves = null;
  const clips = {};
  const preview = {}; // state -> clip id (Body Part Studio), or null = off

  // Moves a clip can be assigned to, and how its time is driven (animator.js).
  const STATES = ['attack', 'hitstun', 'idle', 'walk', 'block', 'victory'];

  if (typeof fetch !== 'undefined') {
    fetch('assets/anim/moves.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (!m) return;
        moves = m;
        for (const id of Object.keys(m.clips || {})) {
          fetch(`assets/anim/${id}.json`)
            .then((r) => (r.ok ? r.json() : null))
            .then((c) => { if (c && c.frames && c.frames.length) clips[id] = { id, ...c }; })
            .catch(() => { /* not converted yet */ });
        }
      })
      .catch(() => { /* no clips */ });
  }

  // The clip a character plays for a move: the studio's preview choice, then
  // their own assignment, then everyone's ('*').
  function clipFor(charId, state) {
    if (state in preview) return preview[state] ? clips[preview[state]] || null : null;
    const use = (moves && moves.use) || {};
    const id = (use[charId] && use[charId][state]) || (use['*'] && use['*'][state]);
    return (id && clips[id]) || null;
  }

  // A frame at clip time u (0-1), blended between the two nearest frames.
  function sample(clip, u) {
    const fr = clip.frames;
    const x = Math.max(0, Math.min(1, u)) * (fr.length - 1);
    const i = Math.floor(x), t = x - i;
    const a = fr[i], b = fr[Math.min(fr.length - 1, i + 1)];
    if (t === 0 || a === b) return a;
    const mix = (p, q) => p + (q - p) * t;
    const pair = (P, Q) => P.map((p, k) => [mix(p[0], Q[k][0]), mix(p[1], Q[k][1])]);
    return { c: mix(a.c, b.c), l: mix(a.l, b.l), h: pair(a.h, b.h), e: pair(a.e, b.e), f: pair(a.f, b.f), k: pair(a.k, b.k) };
  }

  // Body Part Studio: try a clip for a move (null = the built-in animation,
  // undefined = back to what moves.json says).
  function setPreview(state, clipId) {
    if (clipId === undefined) delete preview[state]; else preview[state] = clipId;
  }

  function list() {
    return Object.keys(clips).sort();
  }

  function assigned(charId, state) {
    const use = (moves && moves.use) || {};
    return (use[charId] && use[charId][state]) || (use['*'] && use['*'][state]) || null;
  }

  return { STATES, clipFor, sample, setPreview, list, assigned };
})();
