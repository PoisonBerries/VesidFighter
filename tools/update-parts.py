#!/usr/bin/env python3
"""Regenerates assets/parts/manifest.json from the body-part drawings in
assets/parts/<characterId>/<part>.png (and body-shape files, body.json), so the game knows which drawings
exist (and never requests ones that don't). Run after adding or removing
drawings: python3 tools/update-parts.py"""
import json, os

PARTS = ['head', 'neck', 'torso', 'upperArm', 'forearm', 'fist', 'thigh', 'shin', 'shoe']
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'parts')
manifest = {}
for cid in sorted(os.listdir(root)):
    folder = os.path.join(root, cid)
    if not os.path.isdir(folder):
        continue
    found = [p for p in PARTS if os.path.isfile(os.path.join(folder, p + '.png'))]
    if os.path.isfile(os.path.join(folder, 'body.json')):
        found.append('body')  # body shape settings (see js/bodyArt.js)
    unknown = [f for f in os.listdir(folder) if f.endswith('.png') and f[:-4] not in PARTS]
    for f in unknown:
        print(f'  ignoring {cid}/{f} (part names: {", ".join(PARTS)})')
    if found:
        manifest[cid] = found
with open(os.path.join(root, 'manifest.json'), 'w') as fh:
    json.dump(manifest, fh, indent=2)
    fh.write('\n')
total = sum(len(v) for v in manifest.values())
print(f'manifest.json: {total} drawing(s) across {len(manifest)} character(s)')
for cid, parts in manifest.items():
    print(f'  {cid}: {", ".join(parts)}')
