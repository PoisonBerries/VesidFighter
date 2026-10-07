# Rigs blender/jon-full-body.blend onto the giant's skeleton and animations
# (assets/models/monster.glb: a Mixamo rig in a T-pose with its clips) and
# writes the result back as assets/models/monster.glb (via a temp file; run
# tools/optimize-model.mjs on it afterwards for the game copy):
#
#   Blender -b --python tools/blender/rig_giant.py -- assets/models/monster.glb blender/jon-one.blend <out.glb>
#   (blender/jon-one.blend: Jon as one model, the better head on the full body)
#
# How: Jon stands arms-down, the rig is a T-pose. A copy of the rig is posed
# to Jon's stance and made its rest pose, Jon is weighted to it (automatic
# weights), then that copy is posed back to the T-pose -- which moves Jon
# into a T-pose too -- and he's bound to the real rig, whose clips then play
# on him unchanged.
import bpy, bmesh, mathutils, sys, math

args = sys.argv[sys.argv.index('--') + 1:]
RIG_GLB, JON_BLEND, OUT = args[0], args[1], args[2]
TARGET_FACES = int(args[3]) if len(args) > 3 else 30000

# Jon, scaled to the rig (top of the head at 1.77 m, feet on the floor), and
# where his joints are (measured from renders of him at that size).
JON_HEIGHT = 1.77
ARM = {  # side +1 = his left (+x)
    'shoulder': (0.19, 0.06, 1.43), 'elbow': (0.27, 0.03, 1.12), 'wrist': (0.28, 0.0, 0.85), 'fingertips': (0.27, 0.0, 0.72),
}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=RIG_GLB)
rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
old_meshes = [o for o in bpy.data.objects if o.type == 'MESH']
# The rig in its rest pose (the T-pose), not partway through a clip.
for a in bpy.data.actions: a.use_fake_user = True
if rig.animation_data: rig.animation_data.action = None
for pb in rig.pose.bones: pb.matrix_basis = mathutils.Matrix.Identity(4)

# ---- Jon ----
# (blender/jon-full-body.blend, or blender/jon-face.blend: the body plus the
# better head from tools/blender/jon_head_swap.py, as two meshes -- each is
# simplified on its own, the head keeping a bigger share for the face, then
# they're joined.)
HEAD_SHARE = 0.4
with bpy.data.libraries.load(JON_BLEND, link=False) as (src, dst):
    dst.objects = list(src.objects)
pieces = [o for o in dst.objects if o.type == 'MESH']
for o in pieces:
    bpy.context.scene.collection.objects.link(o)
    if o.mode != 'OBJECT':   # (saved mid-sculpt or mid-paint: back to object mode)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.mode_set(mode='OBJECT')
    o.data.transform(o.matrix_world); o.matrix_world = mathutils.Matrix.Identity(4)
    print('mesh repaired (as loaded):', o.name, o.data.validate(verbose=False))
body_piece = max(pieces, key=lambda o: max(v.co.z for v in o.data.vertices) - min(v.co.z for v in o.data.vertices))
# Scaled by his whole height (feet to the top of the head), so his joints land where measured.
zs = [v.co.z for o in pieces for v in o.data.vertices]
k = JON_HEIGHT / (max(zs) - min(zs))
for o in pieces:
    o.data.transform(mathutils.Matrix.Translation((0, 0, -min(zs) * k)) @ mathutils.Matrix.Scale(k, 4))
    # Fewer triangles first (the game needs that anyway, and weighting goes better).
    share = 1.0 if len(pieces) == 1 else (1 - HEAD_SHARE if o is body_piece else HEAD_SHARE)
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
    mod = o.modifiers.new('decimate', 'DECIMATE'); mod.ratio = min(1.0, TARGET_FACES * share / len(o.data.polygons))
    bpy.ops.object.modifier_apply(modifier=mod.name)
bpy.ops.object.select_all(action='DESELECT')
for o in pieces: o.select_set(True)
bpy.context.view_layer.objects.active = body_piece
if len(pieces) > 1: bpy.ops.object.join()
jon = body_piece; jon.name = 'jon'
print('jon faces', len(jon.data.polygons))
print('mesh repaired (after simplifying):', jon.data.validate(verbose=False))

# ---- Cut his arms free: where he stood with his hands against his thighs
# (and his arms against his sides) the model's surfaces are fused together,
# which would drag his trousers along with his hands. Below the shoulders his
# arms are all further out than his body (|x| > ARM_X(z)): delete the faces
# that bridge the two.
SHOULDER_MIX_Z = 1.32   # above this, arm and body join (the shoulders)
def ARM_X(z): return 0.215 if z < 1.1 else 0.20
def region(p):
    if p.z >= SHOULDER_MIX_Z or abs(p.x) <= ARM_X(p.z): return 'body'
    return 'Left' if p.x > 0 else 'Right'
bm = bmesh.new(); bm.from_mesh(jon.data)
bridge = [f for f in bm.faces if len({region(v.co) for v in f.verts}) > 1 and all(v.co.z < SHOULDER_MIX_Z for v in f.verts)]
bmesh.ops.delete(bm, geom=bridge, context='FACES')
bm.to_mesh(jon.data); bm.free()
print('faces cut to free the arms', len(bridge))
print('mesh repaired (after cutting):', jon.data.validate(verbose=False))

# Bits of his hands that were fused to his trousers stay behind on the body
# side of the cut: skin-coloured faces at his hips. (Skin is much redder than
# the khaki: red - green >= 0.08 against ~0.05.) Then any small loose scraps.
import numpy as np
def face_colours(me):
    img = next(n.image for n in me.materials[0].node_tree.nodes if n.type == 'TEX_IMAGE' and any(l.to_socket.name == 'Base Color' for l in n.outputs[0].links))
    W, H = img.size; px = np.zeros(W * H * 4, dtype=np.float32); img.pixels.foreach_get(px); px = px.reshape(H, W, 4)
    uv = np.zeros(len(me.loops) * 2, dtype=np.float32); me.uv_layers.active.data.foreach_get('uv', uv)
    lt = np.zeros(len(me.polygons), dtype=int); me.polygons.foreach_get('loop_total', lt)
    ls = np.zeros(len(me.polygons), dtype=int); me.polygons.foreach_get('loop_start', ls)
    uv = uv.reshape(-1, 2); fuv = np.array([uv[a:a + n].mean(axis=0) for a, n in zip(ls, lt)])
    return px[np.clip((fuv[:, 1] % 1) * H, 0, H - 1).astype(int), np.clip((fuv[:, 0] % 1) * W, 0, W - 1).astype(int), :3]
col = face_colours(jon.data)
bm = bmesh.new(); bm.from_mesh(jon.data); bm.faces.ensure_lookup_table()
stuck = []
for f in bm.faces:
    c = f.calc_center_median()
    if region(c) == 'body' and abs(c.x) > 0.16 and 0.6 < c.z < 1.12 and col[f.index][0] - col[f.index][1] > 0.075: stuck.append(f)
bmesh.ops.delete(bm, geom=stuck, context='FACES')
# loose scraps
seen, scraps = set(), []
for v in bm.verts:
    if v in seen: continue
    island, stack = [], [v]
    while stack:
        x = stack.pop()
        if x in seen: continue
        seen.add(x); island.append(x); stack.extend(e.other_vert(x) for e in x.link_edges)
    if len(island) < 60: scraps.extend(island)
bmesh.ops.delete(bm, geom=scraps, context='VERTS')
bm.to_mesh(jon.data); bm.free()
print('hand bits removed', len(stuck), 'faces; loose scraps removed', len(scraps), 'verts')

# ---- A copy of the rig, posed like Jon, as its rest pose ----
def world_bone(arm, name):
    pb = arm.pose.bones[name]
    return pb, arm.matrix_world @ pb.head, arm.matrix_world @ pb.tail

def aim(arm, name, target):
    """Turns a pose bone (about its head, in world space) to point at target."""
    pb, head, tail = world_bone(arm, name)
    cur = (tail - head).normalized(); want = (mathutils.Vector(target) - head).normalized()
    q = cur.rotation_difference(want)
    mw = arm.matrix_world
    m = mw @ pb.matrix                     # the bone's world matrix
    t = mathutils.Matrix.Translation(head)
    m = t @ q.to_matrix().to_4x4() @ t.inverted() @ m
    pb.matrix = mw.inverted() @ m
    bpy.context.view_layer.update()

tmp = rig.copy(); tmp.data = rig.data.copy(); tmp.name = 'rig_jon_pose'
tmp.animation_data_clear()
bpy.context.scene.collection.objects.link(tmp)
bpy.context.view_layer.update()
for side, s in (('Left', 1), ('Right', -1)):
    mir = lambda p: (p[0] * s, p[1], p[2])
    aim(tmp, f'mixamorig:{side}Arm', mir(ARM['elbow']))
    aim(tmp, f'mixamorig:{side}ForeArm', mir(ARM['wrist']))
    aim(tmp, f'mixamorig:{side}Hand', mir(ARM['fingertips']))
bpy.ops.object.select_all(action='DESELECT')
tmp.select_set(True); bpy.context.view_layer.objects.active = tmp
bpy.ops.object.mode_set(mode='POSE'); bpy.ops.pose.select_all(action='SELECT')
bpy.ops.pose.armature_apply(selected=False)
bpy.ops.object.mode_set(mode='OBJECT')

# ---- Weight Jon to it ----
# Each vertex follows the bones nearest to it, blended smoothly between the
# closest few -- only bones of its own part (an arm, or the body and legs),
# mixing round the shoulders. (Blender's automatic weights went wrong on this
# generated mesh: a warped head, shoes and trousers flying off.)
bpy.ops.object.select_all(action='DESELECT')
jon.select_set(True); tmp.select_set(True); bpy.context.view_layer.objects.active = tmp
bpy.ops.object.parent_set(type='ARMATURE_NAME')   # (empty groups, one per bone)

def seg_dist(p, a, b):
    ab = b - a; L2 = ab.length_squared
    t = 0.0 if L2 < 1e-12 else max(0.0, min(1.0, (p - a).dot(ab) / L2))
    return (a + ab * t - p).length

mw = tmp.matrix_world
head_of = {b.name: mw @ b.head_local for b in tmp.data.bones}
def segment(b):
    # from this joint to the next one along (its child's; the middle finger for a hand)
    kids = [c for c in b.children]
    if b.name.endswith('Hand'):
        tip = [c for c in b.children_recursive if c.name.endswith('HandMiddle4')]
        return head_of[b.name], head_of[tip[0].name] if tip else head_of[b.name]
    if not kids: return head_of[b.name], head_of[b.name]
    main = max(kids, key=lambda c: (head_of[c.name] - head_of[b.name]).length if 'Spine' in c.name or 'Neck' in c.name or 'Head' in c.name or 'Leg' in c.name or 'Foot' in c.name or 'Toe' in c.name or 'Arm' in c.name else -1)
    return head_of[b.name], head_of[main.name]
SKIP = ('_End', 'Index', 'Middle', 'Ring', 'Pinky', 'Thumb')   # end markers, fingers (the hand moves as one)
bones = {b.name: segment(b) for b in tmp.data.bones if not any(k in b.name for k in SKIP)}
def side_of(n):
    n = n.replace('mixamorig:', '')
    for side in ('Left', 'Right'):
        if n.startswith(side) and any(n[len(side):].startswith(k) for k in ('Arm', 'ForeArm', 'Hand')): return side
    return 'body'
SHOULDER_BONES = ('Shoulder', 'Spine2', 'Neck')
region_of = [region(v.co) for v in jon.data.vertices]
POWER, KEEP = 6, 3
for v in jon.data.vertices:
    p = v.co; r = region_of[v.index]
    cands = []
    for n, (a, b) in bones.items():
        sd = side_of(n)
        ok = sd == r or (p.z > SHOULDER_MIX_Z and (any(k in n for k in SHOULDER_BONES) or (sd != 'body' and r == 'body' and ((sd == 'Left') == (p.x > 0)) and n.endswith('Arm'))))
        if r != 'body' and sd == 'body' and not (p.z > SHOULDER_MIX_Z and any(k in n for k in SHOULDER_BONES)): ok = False
        if ok: cands.append((seg_dist(p, a, b), n))
    cands.sort()
    cands = cands[:KEEP]
    ws = [(1.0 / max(d, 0.004) ** POWER, n) for d, n in cands]
    tot = sum(w for w, _ in ws)
    for w, n in ws:
        if w / tot > 0.02: jon.vertex_groups[n].add([v.index], w / tot, 'REPLACE')
bpy.ops.object.select_all(action='DESELECT')
jon.select_set(True); bpy.context.view_layer.objects.active = jon
bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
bpy.ops.object.vertex_group_normalize_all(lock_active=False)
bpy.ops.object.mode_set(mode='OBJECT')
unweighted = sum(1 for v in jon.data.vertices if not any(g.weight > 0.001 for g in v.groups))
print('unweighted verts', unweighted, 'of', len(jon.data.vertices))

# ---- Pose the copy back into the T-pose: Jon follows; keep that shape ----
for pb in tmp.pose.bones:
    c = pb.constraints.new('COPY_TRANSFORMS'); c.target = rig; c.subtarget = pb.name
bpy.context.view_layer.update()
bpy.ops.object.select_all(action='DESELECT')
jon.select_set(True); bpy.context.view_layer.objects.active = jon
arm_mod = next(m for m in jon.modifiers if m.type == 'ARMATURE')
bpy.ops.object.modifier_apply(modifier=arm_mod.name)
jon.parent = None
jon.matrix_world = mathutils.Matrix.Identity(4)

# ---- Onto the real rig ----
bpy.data.objects.remove(tmp)
for o in old_meshes:
    if o.type == 'MESH': bpy.data.objects.remove(o)
jon.parent = rig
jon.matrix_parent_inverse = rig.matrix_world.inverted()
m = jon.modifiers.new('rig', 'ARMATURE'); m.object = rig

print('mesh repaired (before export):', jon.data.validate(verbose=False))
# ---- The throw, mirrored: the grab picks up with his left hand, but the
# throw clip throws with his right. Flipped left-to-right it throws with the
# hand that's holding them. Each bone gets its opposite partner's movement,
# mirrored across the body (relative to each bone's own rest pose, so it
# doesn't matter how the left and right bones are set up).
def mirror_action(name):
    src = bpy.data.actions[name]
    dst = bpy.data.actions.new(name + '_mirrored')
    S = mathutils.Matrix.Scale(-1, 4, (1, 0, 0))
    bones = rig.data.bones
    opp = lambda n: n.replace('Left', '#').replace('Right', 'Left').replace('#', 'Right')
    rest = {b.name: b.matrix_local.copy() for b in bones}
    order = [b.name for b in bones if b.parent is None]
    i = 0
    while i < len(order):
        order += [c.name for c in bones[order[i]].children]; i += 1
    s, e = (int(round(v)) for v in src.frame_range)
    for pb in rig.pose.bones: pb.rotation_mode = 'QUATERNION'
    for f in range(s, e + 1):
        rig.animation_data.action = src
        if src.slots: rig.animation_data.action_slot = src.slots[0]
        bpy.context.scene.frame_set(f)
        P = {pb.name: pb.matrix.copy() for pb in rig.pose.bones}
        target = {}
        for n in order:
            o = opp(n) if opp(n) in P else n
            delta = P[o] @ rest[o].inverted()                 # its partner's movement (armature space)
            target[n] = S @ delta @ S @ rest[n]               # mirrored, onto this bone
        rig.animation_data.action = dst
        if dst.slots: rig.animation_data.action_slot = dst.slots[0]
        for n in order:
            b = bones[n]; pb = rig.pose.bones[n]
            if b.parent:
                pr = rest[b.parent.name]
                basis = (pr.inverted() @ rest[n]).inverted() @ target[b.parent.name].inverted() @ target[n]
            else:
                basis = rest[n].inverted() @ target[n]
            pb.matrix_basis = basis
            pb.keyframe_insert('location', frame=f); pb.keyframe_insert('rotation_quaternion', frame=f)
    rig.animation_data.action = None
    bpy.data.actions.remove(src)
    dst.name = name; dst.use_fake_user = True
    print('mirrored', name, 'frames', s, e)
if not rig.animation_data: rig.animation_data_create()
mirror_action('throw')

# ---- Export, with the rig's clips ----
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True); jon.select_set(True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_animations=True,
                          export_animation_mode='ACTIONS', export_skins=True, export_apply=False)
print('exported', OUT)
