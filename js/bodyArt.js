// Hand-drawn body parts. Each character's figure is built from parts (see
// PARTS); any part with a drawing in assets/parts/<characterId>/<part>.png
// is drawn from that image, and every other part falls back to the
// procedural shape in renderer.js -- so art can be added one limb at a time.
//
// Which drawings exist is listed in assets/parts/manifest.json (regenerate it
// with `python3 tools/update-parts.py` after adding files), so the game never
// requests files that aren't there.
//
// Each character's body *shape* (head size, limb lengths and thickness...,
// see DEFAULT_BODY_PROFILE in renderer.js) can be saved the same way as
// assets/parts/<characterId>/body.json; the studio edits it live.
//
// Where each part attaches (its two joint points, and the template size) is
// defined by Renderer.partSpec(); the Body Part Studio (studio.html) turns
// that into templates to draw on.

const BodyArt = (() => {
  const PARTS = ['head', 'neck', 'torso', 'upperArm', 'forearm', 'fist', 'thigh', 'shin', 'shoe'];
  const ART_SCALE = 3; // template pixels per game pixel (at the character's normal size)

  const images = {};    // id -> part -> Image, from the manifest
  const overrides = {}; // id -> part -> image/canvas (studio previews, not saved)
  const builds = {};    // id -> saved body shape (body.json)
  const buildEdits = {}; // id -> shape being edited in the studio (not saved)
  const cache = new Map();

  function ready(img) {
    return img && (img instanceof HTMLCanvasElement || (img.complete && img.naturalWidth > 0));
  }

  function load(manifest) {
    for (const id of Object.keys(manifest || {})) {
      images[id] = images[id] || {};
      for (const part of manifest[id]) {
        if (part === 'body') {
          fetch(`assets/parts/${id}/body.json`)
            .then((r) => (r.ok ? r.json() : null))
            .then((b) => { if (b && typeof b === 'object') builds[id] = b; })
            .catch(() => { /* keep the built-in shape */ });
          continue;
        }
        if (!PARTS.includes(part)) continue;
        const img = new Image();
        img.src = `assets/parts/${id}/${part}.png`;
        images[id][part] = img;
      }
    }
  }

  if (typeof fetch !== 'undefined' && typeof Image !== 'undefined') {
    fetch('assets/parts/manifest.json')
      .then((r) => (r.ok ? r.json() : {}))
      .then(load)
      .catch(() => { /* no drawings yet */ });
  }

  // The drawing for a part, or null to use the procedural shape.
  function get(id, part) {
    const o = overrides[id] && overrides[id][part];
    if (o) return ready(o) ? o : null;
    const img = images[id] && images[id][part];
    return ready(img) ? img : null;
  }

  // A copy darkened for the far side of the body and/or tinted for a status
  // (hit flash, block, poison...), made once and reused.
  function shaded(id, part, img, shade, tint) {
    if (!shade && !tint) return img;
    const key = `${id}|${part}|${shade}|${tint ? tint.color + tint.alpha : ''}`;
    const hit = cache.get(key);
    if (hit && hit.src === img) return hit.canvas;
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = 'source-atop';
    if (shade) { g.fillStyle = `rgba(0,0,0,${shade})`; g.fillRect(0, 0, w, h); }
    if (tint) { g.globalAlpha = tint.alpha; g.fillStyle = tint.color; g.fillRect(0, 0, w, h); }
    cache.set(key, { src: img, canvas: c });
    return c;
  }

  // Studio previews: try a drawing on the live figure without saving it.
  function setOverride(id, part, img) {
    overrides[id] = overrides[id] || {};
    if (img) overrides[id][part] = img; else delete overrides[id][part];
    for (const k of [...cache.keys()]) if (k.startsWith(id + '|' + part + '|')) cache.delete(k);
  }

  function hasSaved(id, part) {
    return !!(images[id] && images[id][part]);
  }

  // Body shape overrides: studio edits win over the saved body.json.
  function build(id) {
    if (buildEdits[id]) return buildEdits[id];
    return builds[id] || null;
  }
  function setBuild(id, values) {
    if (values) buildEdits[id] = values; else delete buildEdits[id];
  }
  function savedBuild(id) {
    return builds[id] || null;
  }

  return { PARTS, ART_SCALE, get, shaded, setOverride, hasSaved, build, setBuild, savedBuild };
})();
