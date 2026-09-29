// Handles custom player sprites: uploading, resizing, persisting to
// localStorage as data URLs, and handing back loaded Image objects for the
// renderer. Sprites are stored per "slot" (p1 / p2) and pose, independent of
// which character (stat set) that slot is playing as -- the idea is each
// person uploads their own cutout photos once and reuses them regardless of
// which character they pick.

const SpriteManager = (() => {
  const STORAGE_PREFIX = 'vf_sprites_';
  const MAX_DIMENSION = 480; // downscale uploads so localStorage doesn't fill up

  // slot -> { pose: dataURL }
  const store = { p1: {}, p2: {} };
  // slot -> { pose: HTMLImageElement }
  const imageCache = { p1: {}, p2: {} };

  function storageKey(slot) {
    return STORAGE_PREFIX + slot;
  }

  function load() {
    for (const slot of ['p1', 'p2']) {
      try {
        const raw = localStorage.getItem(storageKey(slot));
        store[slot] = raw ? JSON.parse(raw) : {};
      } catch (e) {
        console.warn('Failed to load sprites for', slot, e);
        store[slot] = {};
      }
      imageCache[slot] = {};
      for (const pose of Object.keys(store[slot])) {
        preloadImage(slot, pose);
      }
    }
  }

  function persist(slot) {
    try {
      localStorage.setItem(storageKey(slot), JSON.stringify(store[slot]));
    } catch (e) {
      console.warn('Could not save sprite (storage full?)', e);
    }
  }

  function preloadImage(slot, pose) {
    const dataUrl = store[slot][pose];
    if (!dataUrl) return;
    const img = new Image();
    img.src = dataUrl;
    imageCache[slot][pose] = img;
  }

  // Downscale + re-encode a File to a data URL, then store it.
  function setSpriteFromFile(slot, pose, file, onDone) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/png');
        store[slot][pose] = dataUrl;
        persist(slot);
        preloadImage(slot, pose);
        if (onDone) onDone(dataUrl);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function clearSprite(slot, pose) {
    delete store[slot][pose];
    delete imageCache[slot][pose];
    persist(slot);
  }

  function clearSlot(slot) {
    store[slot] = {};
    imageCache[slot] = {};
    persist(slot);
  }

  function getImage(slot, pose) {
    const img = imageCache[slot] && imageCache[slot][pose];
    if (img && img.complete && img.naturalWidth > 0) return img;
    return null;
  }

  function hasCustomSprite(slot, pose) {
    return !!(store[slot] && store[slot][pose]);
  }

  function getThumbnail(slot, pose) {
    return store[slot] && store[slot][pose];
  }

  load();

  return {
    setSpriteFromFile,
    clearSprite,
    clearSlot,
    getImage,
    hasCustomSprite,
    getThumbnail,
  };
})();
