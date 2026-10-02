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

**After every export**, also rebuild the lighter copy that the Low and Medium
graphics settings load (fewer triangles, smaller textures, no normal maps):

    node tools/optimize-stage.mjs

It writes `assets/stages/orchard-lite.glb` (commit it with the full one). How
much each part of the scene is simplified is the `RATIOS` list at the top of
that script, by object name. Keep object names stable -- the game finds the
car, cows, roads, lawn and so on by name, and the graphics settings sort
scenery by name too (`shadowRole` in `js/renderer3d.js`: which parts cast
shadows, and which far-off trees and poles Low leaves out).

The template is generated from the game's layout, so after changing the
stage in `js/stages.js` rebuild it with:

    node tools/blender/make-template.js
