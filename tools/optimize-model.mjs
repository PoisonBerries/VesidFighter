// Makes the game copy of a model: smaller textures (JPEG, colour at most
// 1024px, the rest 512px) and optionally fewer triangles. Rigged and
// animated models keep their skeleton and clips.
//
//   node tools/optimize-model.mjs in.glb out.glb [triangle ratio, e.g. 0.02] [max error, e.g. 0.004]
//
// (Used for the orchard sign, from a 48 MB generated model, and for the giant
// after tools/blender/rig_giant.py.)

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, textureCompress, prune, dedup } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const [src, out, ratio, error] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: node tools/optimize-model.mjs in.glb out.glb [triangle ratio] [max error]');
  process.exit(1);
}
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(src);
const triangles = () => doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives()).reduce((n, p) => n + (p.getIndices()?.getCount() || 0) / 3, 0);
const before = triangles();
if (ratio) {
  await MeshoptSimplifier.ready;
  await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: Number(ratio), error: Number(error || 0.0005) }));
}
await doc.transform(
  textureCompress({ encoder: sharp, targetFormat: 'jpeg', quality: 85, resize: [1024, 1024], slots: /baseColor/ }),
  textureCompress({ encoder: sharp, targetFormat: 'jpeg', quality: 80, resize: [512, 512], slots: /^(?!baseColor).*/ }),
  prune(), dedup(),
);
await io.write(out, doc);
console.log(`${out}: ${before} -> ${triangles()} triangles`);
