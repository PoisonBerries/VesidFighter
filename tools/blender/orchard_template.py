# Builds blender/orchard_template.blend: the Orchard stage as a Blender scene
# of named grey-box placeholders to swap for real models, plus locked guides
# showing where the gameplay is (floor edges, the tree's standable tops, the
# car's size). Run through tools/blender/make-template.js, which passes the
# gameplay layout from js/stages.js:
#
#   Blender -b --factory-startup -P tools/blender/orchard_template.py -- layout.json out.blend
#
# Coordinates: 1 Blender unit = 1 metre = 100 game pixels (a fighter is about
# 1.6 m tall). Blender is Z-up; the game (three.js) is Y-up, and the glTF
# export converts between them.

import json
import math
import sys

import bmesh
import bpy

argv = sys.argv[sys.argv.index('--') + 1:]
layout = json.load(open(argv[0]))
OUT = argv[1]

S = 1 / 100
GROUND_Y = layout['groundY']
stage = layout['stage']


def to_x(gx):
    return (gx - 640) * S


def to_h(gy):
    return (GROUND_Y - gy) * S


def B(x, y, z):
    """three.js position (x, up, towards camera) -> Blender (x, away, up)."""
    return (x, -z, y)


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.name = 'Orchard'
scene.unit_settings.system = 'METRIC'
scene.render.resolution_x = 1280
scene.render.resolution_y = 720


def collection(name):
    c = bpy.data.collections.new(name)
    scene.collection.children.link(c)
    return c


GAME = collection('Gameplay - swap these')
SCENERY = collection('Scenery - yours')
GUIDES = collection('Guides - not exported')

_materials = {}


def material(hex_color, alpha=1.0):
    key = (hex_color, alpha)
    if key in _materials:
        return _materials[key]
    srgb = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    m = bpy.data.materials.new(hex_color if alpha == 1 else hex_color + '_guide')
    m.diffuse_color = (*lin, alpha)
    try:
        m.use_nodes = True
    except AttributeError:
        pass
    bsdf = m.node_tree.nodes.get('Principled BSDF') if m.node_tree else None
    if bsdf:
        bsdf.inputs['Base Color'].default_value = (*lin, 1)
        bsdf.inputs['Roughness'].default_value = 0.9
        if alpha < 1:
            bsdf.inputs['Alpha'].default_value = alpha
    if alpha < 1:
        for attr, value in (('surface_render_method', 'BLENDED'), ('blend_method', 'BLEND')):
            try:
                setattr(m, attr, value)
                break
            except (AttributeError, TypeError):
                pass
    _materials[key] = m
    return m


def new_object(name, mesh, coll, parent=None, loc=(0, 0, 0)):
    o = bpy.data.objects.new(name, mesh)
    coll.objects.link(o)
    o.location = loc
    if parent:
        o.parent = parent
    return o


def empty(name, coll, loc=(0, 0, 0), parent=None, size=0.5):
    o = new_object(name, None, coll, parent, loc)
    o.empty_display_type = 'PLAIN_AXES'
    o.empty_display_size = size
    return o


def mesh_from(name, build, color, alpha=1.0):
    bm = bmesh.new()
    build(bm)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material(color, alpha))
    return me


def cube(bm, w, h, d, offset=(0, 0, 0)):
    """A box w (x) by h (up) by d (depth), centred on offset (three.js axes)."""
    geom = bmesh.ops.create_cube(bm, size=1.0)
    verts = [v for v in geom['verts']]
    bmesh.ops.scale(bm, vec=(w, d, h), verts=verts)
    bmesh.ops.translate(bm, vec=B(*offset), verts=verts)


def box(name, w, h, d, color, pos, coll, parent=None, alpha=1.0):
    me = mesh_from(name, lambda bm: cube(bm, w, h, d), color, alpha)
    return new_object(name, me, coll, parent, B(*pos))


def cylinder(name, r1, r2, h, color, pos, coll, parent=None, segments=8):
    def build(bm):
        bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=r1, radius2=r2, depth=h)
    me = mesh_from(name, build, color)
    return new_object(name, me, coll, parent, B(*pos))


def blob(name, r, color, pos, coll, parent=None, subdivisions=1):
    def build(bm):
        bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=r)
    me = mesh_from(name, build, color)
    return new_object(name, me, coll, parent, B(*pos))


# ---- The layout (gameplay numbers from js/stages.js) ----
L, R = to_x(stage['left']), to_x(stage['right'])
W, CX = R - L, (L + R) / 2
car_def = stage['car']
CAR_W, CAR_H = car_def['width'] * S, car_def['height'] * S


def car_join(side):
    return to_x(stage['left'] + car_def['width'] / 2 + 20) if side < 0 else to_x(stage['right'] - car_def['width'] / 2 - 20)


ROAD_BACK = -26
TREE_X = to_x(640)

# ---- Gameplay: swap these ----
# The hilltop you fight on. Its top must stay flat at height 0 between the
# red edge guides; past them is a ring-out, so it should look like a drop.
HILL_DEPTH, HILL_FRONT, HILL_H = 50, 18, 5
ground = box('ground_hilltop', W, HILL_H, HILL_DEPTH, '#86b35a', (CX, -HILL_H / 2, HILL_FRONT - HILL_DEPTH / 2), GAME)

roads = empty('roads', GAME)
box('road_main', W, 0.01, 1.6, '#c2a57a', (CX, 0.005, 0), GAME, roads)
for side, name in ((-1, 'road_back_left'), (1, 'road_back_right')):
    box(name, 1.6, 0.01, -ROAD_BACK + 1, '#c2a57a', (car_join(side), 0.004, ROAD_BACK / 2), GAME, roads)

# The apple tree: its branches and crown are where the red platform guides are.
tree = empty('tree_platform', GAME, size=1.0)
crown = next(p for p in stage['platforms'] if p['id'] == 'crown')
crown_h = to_h(crown['y'])
cylinder('tree_trunk', 0.32, 0.2, crown_h + 0.2, '#7a5634', (TREE_X, (crown_h + 0.2) / 2, -0.55), GAME, tree)
for p in stage['platforms']:
    x1, x2, h = to_x(p['x1']), to_x(p['x2']), to_h(p['y'])
    if p['id'] == 'crown':
        box('tree_crown_top', x2 - x1, 0.16, 1.1, '#5d9c44', ((x1 + x2) / 2, h - 0.08, -0.25), GAME, tree)
    else:
        box('tree_' + p['id'], x2 - x1, 0.12, 0.6, '#7a5634', ((x1 + x2) / 2, h - 0.06, -0.15), GAME, tree)
for i, (x, y, z, r) in enumerate([(0, 2.55, -1.3, 1.25), (-1.0, 2.2, -1.1, 0.9), (1.0, 2.25, -1.1, 0.9), (-1.6, 1.25, -0.9, 0.55), (1.6, 1.25, -0.9, 0.55), (0.4, 3.1, -1.6, 0.8)]):
    blob('tree_leaves_%d' % (i + 1), r, '#4f8f3a', (TREE_X + x, y, z), GAME, tree)

# The car: a van whose roof is a platform. Keep the replacement facing +X
# (its front), wheels on the ground, roof at the red guide's height.
car = empty('car', GAME, B(car_join(-1), 0, 3.0), size=1.0)
box('car_body', CAR_W, CAR_H - 0.15, 1.3, '#8aa1b8', (0, 0.15 + (CAR_H - 0.15) / 2, 0), GAME, car)
box('car_windshield', 0.08, 0.3, 1.1, '#2b3440', (CAR_W / 2 - 0.02, CAR_H - 0.25, 0), GAME, car)
for x, z in ((CAR_W / 2 - 0.55, 0.6), (CAR_W / 2 - 0.55, -0.6), (-CAR_W / 2 + 0.55, 0.6), (-CAR_W / 2 + 0.55, -0.6)):
    w = cylinder('car_wheel', 0.2, 0.2, 0.18, '#222222', (x, 0.2, z), GAME, car, segments=12)
    w.rotation_euler = (math.pi / 2, 0, 0)
box('car_headlight_L', 0.05, 0.12, 0.22, '#fff2a0', (CAR_W / 2 + 0.01, 0.4, 0.45), GAME, car)
box('car_headlight_R', 0.05, 0.12, 0.22, '#fff2a0', (CAR_W / 2 + 0.01, 0.4, -0.45), GAME, car)

# Cows: the game walks them back and forth behind the fence; where they
# stand here doesn't matter. Face +X. An animation on a cow plays as it walks.
for i, (x, z) in enumerate([(-6, -3.4), (5, -6), (0, -9), (8, -12.5)]):
    cow = empty('cow_%d' % (i + 1), GAME, B(x, 0, z))
    box('cow_body', 1.2, 0.55, 0.5, '#f2efe8', (0, 0.75, 0), GAME, cow)
    box('cow_patch', 0.45, 0.4, 0.52, '#2c2a28', (-0.15, 0.8, 0), GAME, cow)
    box('cow_head', 0.35, 0.35, 0.34, '#f2efe8', (0.72, 0.95, 0), GAME, cow)
    box('cow_nose', 0.12, 0.18, 0.3, '#e8a8a0', (0.9, 0.88, 0), GAME, cow)
    for lx, lz in ((0.45, 0.17), (0.45, -0.17), (-0.45, 0.17), (-0.45, -0.17)):
        box('cow_leg', 0.1, 0.5, 0.1, '#f2efe8', (lx, 0.25, lz), GAME, cow)

# ---- Scenery: anything goes (behind the fight line, it never blocks a fighter) ----
# Orchard rows: every tree shares one mesh -- edit one (Tab) and they all change,
# or select them all, then your tree last, and Ctrl+L > Link Object Data.
def orchard_tree(bm):
    bmesh.ops.create_cone(bm, cap_ends=True, segments=6, radius1=0.14, radius2=0.1, depth=1.0)
    for v in bm.verts:
        v.co.z += 0.5
    top = bmesh.ops.create_icosphere(bm, subdivisions=0, radius=0.75)
    bmesh.ops.translate(bm, vec=(0, 0, 1.35), verts=top['verts'])
    for f in bm.faces:  # trunk: bark (slot 0), top: leaves (slot 1)
        f.material_index = 1 if f.calc_center_median().z > 1.0 else 0


row_mesh = mesh_from('orchard_tree', orchard_tree, '#7a5634')
row_mesh.materials.append(material('#5c9a40'))
rows = empty('orchard_rows', SCENERY)
n = 0
for z in (-4.5, -7.5, -10.5, -14, -18, -22.5):
    x = L + 1.2
    while x < R - 1:
        skip = abs(x - car_join(-1)) < 1.4 or abs(x - car_join(1)) < 1.4 or (-14 < z < -7 and abs(x + 8) < 2.8)
        if not skip:
            n += 1
            new_object('orchard_tree_%02d' % n, row_mesh, SCENERY, rows, B(x + math.sin(x * 12.9 + z) * 0.35, 0, z))
        x += 2.6

fence = empty('fence', SCENERY)
x = L + 0.3
while x < R:
    if abs(x - car_join(-1)) >= 1.1 and abs(x - car_join(1)) >= 1.1:
        box('fence_post', 0.1, 0.7, 0.1, '#a88a62', (x, 0.35, -2.3), SCENERY, fence)
        box('fence_rail', 1.5, 0.07, 0.05, '#b89a70', (x + 0.75, 0.52, -2.3), SCENERY, fence)
    x += 1.5

barn = empty('barn', SCENERY, B(-8, 0, -10.5))
box('barn_walls', 3.4, 2.2, 2.6, '#b5473a', (0, 1.1, 0), SCENERY, barn)


def barn_roof(bm):
    bmesh.ops.create_cone(bm, cap_ends=True, segments=3, radius1=1.95, radius2=1.95, depth=3.6)


roof = new_object('barn_roof', mesh_from('barn_roof', barn_roof, '#6b5a52'), SCENERY, barn, (0, 0, 2.74))
# A triangular prism lying along x, ridge up (the cone's first corner is on +y).
roof.rotation_euler = (math.pi / 2, 0, math.pi / 2)
roof.scale = (1, 0.55, 1)

valley = box('backdrop_valley', 260, 0.1, 200, '#6f9a4a', (0, -9, -40), SCENERY)
for i, (x, z, sx, sy) in enumerate([(-40, -70, 26, 9), (-8, -80, 30, 12), (26, -72, 24, 8), (55, -65, 22, 10), (-65, -60, 20, 7)]):
    h = blob('backdrop_hill_%d' % (i + 1), 1.0, '#7fa65a', (x, -9, z), SCENERY, subdivisions=2)
    h.scale = (sx, sx * 0.6, sy)

# ---- Guides (named GUIDE_..., locked, never exported) ----
RED, GOLD, BLUE = '#ff3040', '#ffc830', '#4da3ff'
guides = []
guides.append(box('GUIDE_floor', W, 0.02, 0.35, RED, (CX, 0.01, 0), GUIDES, alpha=0.35))
for side, gx in ((-1, stage['left']), (1, stage['right'])):
    guides.append(box('GUIDE_edge_%s_ring_out_past_here' % ('left' if side < 0 else 'right'), 0.04, 4, 3, RED, (to_x(gx), -1, 0), GUIDES, alpha=0.35))
for p in stage['platforms']:
    x1, x2, h = to_x(p['x1']), to_x(p['x2']), to_h(p['y'])
    guides.append(box('GUIDE_platform_%s' % p['id'], x2 - x1, 0.04, 0.6, RED, ((x1 + x2) / 2, h + 0.02, 0), GUIDES, alpha=0.5))
guides.append(box('GUIDE_car_size', CAR_W, CAR_H, 1.3, GOLD, (car_join(-1), CAR_H / 2, 0), GUIDES, alpha=0.25))
guides.append(box('GUIDE_car_path', car_join(1) - car_join(-1), 0.02, 1.3, GOLD, ((car_join(-1) + car_join(1)) / 2, 0.02, 0), GUIDES, alpha=0.2))
for i, sx in enumerate(stage['spawns']):
    guides.append(box('GUIDE_fighter_%d_spawn' % (i + 1), 0.5, 1.6, 0.3, BLUE, (to_x(sx), 0.8, 0), GUIDES, alpha=0.35))

cam_data = bpy.data.cameras.new('GUIDE_game_camera')
cam_data.sensor_fit = 'VERTICAL'
cam_data.angle_y = math.radians(30)
cam = new_object('GUIDE_game_camera', cam_data, GUIDES, None, B(0, 1.4 + 13 * 0.17, 13))
cam.rotation_euler = (math.pi / 2 - math.atan2(13 * 0.17, 13), 0, 0)
scene.camera = cam
guides.append(cam)

sun_data = bpy.data.lights.new('GUIDE_sun', 'SUN')
sun_data.energy = 3
sun = new_object('GUIDE_sun', sun_data, GUIDES, None, B(3, 9, 7))
sun.rotation_euler = (math.radians(40), 0, math.radians(20))

for g in guides:
    g.hide_select = True

# ---- README and the export script (Text Editor) ----
README = """ORCHARD STAGE TEMPLATE  (Vesid Fighter)

1 Blender unit = 1 metre. A fighter is about 1.6 m tall (the blue boxes).
Look through the game's camera: View > Cameras > Active Camera (Numpad 0).

COLLECTIONS (top right, the Outliner)
  Gameplay - swap these   ground, roads, the apple tree, the car, the cows.
  Scenery - yours         orchard rows, fence, barn, hills. Change anything.
  Guides - not exported   red / gold / blue see-through boxes. Locked; they
                          show where the gameplay is. Don't move them.

THE RULES (the game's collision comes from its code, not from this file)
  * Ground: keep its top flat at height 0 between the two red edge walls.
    Past them is a ring-out, so make it look like a drop.
  * Tree: the red boxes on it are where fighters can stand. Put branches
    (and the flat top of the crown) right under them.
  * Car: build it at the gold box's size, front facing +X, wheels on the
    ground. Keep the object named 'car' (put your model inside it).
  * Cows: keep the objects named cow_1 ... cow_4. Face +X. If a cow has a
    walk animation, it plays. Where they stand here doesn't matter.
  * Keep things behind the fight line (the red floor strip) or low in
    front of it, so nothing hides the fighters.

SWAPPING A PLACEHOLDER
  1. File > Import (glTF / FBX / OBJ) your model.
  2. Move it where the grey box is (select the box, N panel shows its
     location; type the same numbers on your model).
  3. Either name it the same as the box, or drag it onto the box's parent
     (e.g. onto 'car') in the Outliner. Then delete or hide the grey box.
  Orchard rows share one mesh: select all rows, then your tree last,
  Ctrl+L > Link Object Data, and they all become your tree.

INTO THE GAME
  Keep this file in the game's 'blender' folder, save it, then open the
  'export_to_game.py' text (Text Editor, top of this panel) and press
  Run Script. It writes assets/stages/orchard.glb and switches the game from
  the grey-box to your scene. Keep it light: low-poly, under ~20 MB.

Free assets: quaternius.com (animated cow!), kenney.nl, poly.pizza,
polyhaven.com (textures). Keep to one style.
"""
EXPORT = r'''# Export this scene to the game: assets/stages/orchard.glb, and list it in
# assets/stages/manifest.json so the game loads it instead of the grey-box.
# This .blend must be saved in the game's 'blender' folder.
import bpy, os, json

if not bpy.data.filepath:
    raise SystemExit('Save this file into the game folder\'s "blender" folder first.')
stages = os.path.join(os.path.dirname(bpy.data.filepath), '..', 'assets', 'stages')
if not os.path.isdir(stages):
    raise SystemExit('Could not find ' + os.path.abspath(stages) + ' -- is this file in the game\'s "blender" folder?')

if bpy.context.object and bpy.context.object.mode != 'OBJECT':
    bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.select_all(action='DESELECT')
for o in bpy.context.view_layer.objects:
    if not o.name.startswith('GUIDE_') and o.visible_get():
        o.select_set(True)
out = os.path.abspath(os.path.join(stages, 'orchard.glb'))
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_yup=True, export_apply=True, export_animations=True)

manifest_path = os.path.join(stages, 'manifest.json')
try:
    manifest = json.load(open(manifest_path))
except Exception:
    manifest = {'scenes': []}
if 'orchard' not in manifest.setdefault('scenes', []):
    manifest['scenes'].append('orchard')
json.dump(manifest, open(manifest_path, 'w'), indent=2)
size = os.path.getsize(out) / 1e6
print('Exported %s (%.1f MB). Refresh the game.' % (out, size))
'''
bpy.data.texts.new('README').write(README)
bpy.data.texts.new('export_to_game.py').write(EXPORT)

bpy.ops.wm.save_as_mainfile(filepath=OUT)
print('saved', OUT)
