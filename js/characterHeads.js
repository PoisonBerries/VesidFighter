// Optional per-character head portraits, shipped as real project assets
// (assets/heads/<characterId>.png) rather than per-player localStorage
// uploads -- these are for telling characters apart by default, before
// anyone has uploaded their own cutout sprites. A character with no image
// yet just falls back to the plain colored circle the placeholder already
// draws, so adding these one at a time is always safe.

const CharacterHeads = (() => {
  const images = {};

  for (const char of CHARACTER_LIST) {
    const img = new Image();
    img.src = `assets/heads/${char.id}.png`;
    images[char.id] = img;
  }

  function getImage(characterId) {
    const img = images[characterId];
    if (img && img.complete && img.naturalWidth > 0) return img;
    return null;
  }

  return { getImage };
})();
