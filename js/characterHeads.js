// Optional per-character head portraits, shipped as real project assets
// (assets/heads/<characterId>.png, cut-out photos on a transparent
// background). A character with no image yet just gets a plain drawn head,
// so adding these one at a time is always safe.
//
// A character that transforms (Robert) can also have
// assets/heads/<characterId>-transformed.png, shown while transformed;
// without it the normal head is kept. variantFor() picks which one to draw.
//
// Each photo is measured once when it loads: the box around its visible
// pixels (so the chin can sit exactly on the neck however much empty space
// the file has) and a skin tone sampled from the face (so the body's arms,
// hands and neck match the photo).

const CharacterHeads = (() => {
  const images = {};
  const info = {};

  // Rough "is this pixel skin?" test (standard RGB skin heuristic).
  const isSkin = (r, g, b) => r > 95 && g > 40 && b > 20 && r > g && r > b && r - Math.min(g, b) > 15 && Math.abs(r - g) > 12;

  function analyze(id, img) {
    try {
      const w = img.naturalWidth, h = img.naturalHeight;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, w, h).data;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      let opaque = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (d[(y * w + x) * 4 + 3] > 40) {
            opaque++;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      // A photo without transparency (a square picture) is used as-is.
      if (x1 < 0 || opaque > w * h * 0.97) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; }
      const box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };

      // Skin: median of skin-coloured pixels in the cheek/jaw band.
      const samples = [];
      for (let y = Math.round(y0 + box.h * 0.45); y < y0 + box.h * 0.8; y += 2) {
        for (let x = Math.round(x0 + box.w * 0.25); x < x0 + box.w * 0.75; x += 2) {
          const i = (y * w + x) * 4;
          if (d[i + 3] > 200 && isSkin(d[i], d[i + 1], d[i + 2])) samples.push([d[i], d[i + 1], d[i + 2]]);
        }
      }
      let skin = null;
      if (samples.length > 30) {
        const med = (k) => samples.map((s) => s[k]).sort((a, b) => a - b)[samples.length >> 1];
        skin = `rgb(${med(0)},${med(1)},${med(2)})`;
      }
      info[id] = { box, skin };
    } catch (e) {
      info[id] = { box: { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight }, skin: null };
    }
  }

  function load(key) {
    const img = new Image();
    img.onload = () => analyze(key, img);
    img.src = `assets/heads/${key}.png`;
    images[key] = img;
  }
  for (const char of CHARACTER_LIST) {
    load(char.id);
    if (char.transform) load(char.id + '-transformed'); // optional: a 404 just leaves it unset
  }

  function getImage(characterId) {
    const img = images[characterId];
    if (img && img.complete && img.naturalWidth > 0) return img;
    return null;
  }

  // { box: visible-pixel rectangle, skin: css colour or null }, once loaded.
  function getInfo(characterId) {
    return getImage(characterId) ? info[characterId] || null : null;
  }

  // Which head to draw: the transformed one if this character has one loaded
  // and is currently transformed, otherwise the normal one.
  function variantFor(characterId, transformed) {
    return transformed && getImage(characterId + '-transformed') ? characterId + '-transformed' : characterId;
  }

  return { getImage, getInfo, variantFor };
})();
