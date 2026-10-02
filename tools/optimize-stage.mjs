// Makes the lighter copy of a stage scene that the Low and Medium graphics
// settings load: assets/stages/<id>.glb -> assets/stages/<id>-lite.glb.
//
//   node tools/optimize-stage.mjs            (the orchard)
//   node tools/optimize-stage.mjs orchard
//
// Run it again after every export from Blender. The full scene is left as
// it is (High still loads that). What the lite copy changes:
//  - fewer triangles: each part of the scene is simplified by how much
//    detail it shows from fighting distance (RATIOS below);
//  - smaller textures: colour at most 1024px, the rest 512px, and no
//    normal maps (Medium and Low don't use them);
//  - glass without refraction (that costs a whole extra render each frame).
// Object names are kept, so the game finds the car, cows, roads etc. as usual.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplifyPrimitive, textureCompress, prune, dedup } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2] || 'orchard';
const src = path.join(root, 'assets/stages', `${id}.glb`);
const out = path.join(root, 'assets/stages', `${id}-lite.glb`);

// How much of each part's triangles to keep, by its top-level object name
// (first match wins). Parts not listed are left alone: the ground the grass
// grows on, and the cows (they're rigged).
const RATIOS = [
  [/^(tree_|bank_tree)/, { leaves: 0.4, other: 0.2 }], // the orchard rows and the trees along the gorge
  [/^tree_platform/, { leaves: 0.5, other: 0.4 }], // the big tree out front
  [/^telephone_pole/, 0.15],
  [/^barn/, 0.35],
  [/^tractor/, 0.2],
  [/^car/, 0.3],
  [/^apple_tree/, 0.5], // the climbable tree: close to the camera
  [/^(gorge_wall|backdrop_valley)/, 0.3],
  [/^terrain_near/, 0.5],
];
const ratioFor = (name) => (RATIOS.find(([re]) => re.test(name)) || [])[1];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': null });
const doc = await io.read(src);
const before = triangles(doc);

// ---- Triangles ----
await MeshoptSimplifier.ready;
await doc.transform(weld());
const done = new Set();
for (const top of doc.getRoot().getDefaultScene().listChildren()) {
  const ratio = ratioFor(top.getName());
  if (!ratio) continue;
  top.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh || done.has(mesh) || node.getSkin()) return;
    done.add(mesh);
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      const leaves = mat && mat.getAlphaMode() === 'MASK';
      const r = typeof ratio === 'number' ? ratio : leaves ? ratio.leaves : ratio.other;
      // Leaf cards are separate little quads: let whole cards go rather than
      // squashing them (lockBorder off), with a looser error allowance.
      simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: r, error: leaves ? 0.08 : 0.02, lockBorder: false });
    }
  });
}

// ---- Materials and textures ----
for (const mat of doc.getRoot().listMaterials()) {
  mat.setNormalTexture(null);
  const tr = mat.getExtension('KHR_materials_transmission');
  if (tr) {
    mat.setExtension('KHR_materials_transmission', null);
    mat.setAlphaMode('BLEND');
    const c = mat.getBaseColorFactor();
    mat.setBaseColorFactor([c[0], c[1], c[2], Math.min(c[3], 0.4)]);
  }
  mat.setExtension('KHR_materials_clearcoat', null);
}
await doc.transform(
  dedup(),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], slots: /^(baseColorTexture|emissiveTexture)$/ }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512], slots: /^(?!baseColorTexture$|emissiveTexture$).*/ }),
);

await io.write(out, doc);
const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(1) + ' MB';
console.log(`${path.relative(root, out)}: ${Math.round(before / 1000)}k -> ${Math.round(triangles(doc) / 1000)}k triangles (as drawn), ${mb(src)} -> ${mb(out)}`);

// Triangles as drawn: each mesh counted once per object that uses it.
function triangles(d) {
  let n = 0;
  for (const node of d.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const p of mesh.listPrimitives()) {
      const idx = p.getIndices();
      n += (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3;
    }
  }
  return n;
}
