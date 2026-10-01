# Stage scenes (Blender)

`orchard_template.blend` is the Orchard stage as grey boxes, ready for real
models. Open it in Blender; the **README** in its Text Editor explains
everything. In short:

- **Gameplay - swap these**: ground, roads, the apple tree, the car, the cows.
  Replace each grey box with your model, keeping the names (`car`, `cow_1`...).
- **Scenery - yours**: orchard rows, fence, barn, hills. Anything goes.
- **Guides** (red/gold/blue, locked, never exported): where fighters stand,
  where the floor ends (ring-out), the car's size, the fighters' start spots.
  The game's collision comes from `js/stages.js`, not from this file.

Save your version in this folder (e.g. `orchard.blend`), then run the
`export_to_game.py` script inside it (Text Editor > Run Script). It writes
`assets/stages/orchard.glb` and lists it in `assets/stages/manifest.json`, and
the game shows your scene instead of the grey-box.

The template is generated from the game's layout, so after changing the
stage in `js/stages.js` rebuild it with:

    node tools/blender/make-template.js
