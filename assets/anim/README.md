# Animations (motion capture)

Fighters can play motion-capture clips instead of their built-in, hand-made
animation, move by move. A clip drives where the hands and feet go, which way
the elbows and knees bend, the body's lean and how low it crouches; each
character's own body shape and drawn parts follow it. It's purely visual:
hitboxes, timing and online play are unchanged.

## Files

| Where | What |
|-------|------|
| `fbx/` | Source clips (Mixamo FBX). **Not committed** -- see Licensing. |
| `assets/anim/<clip>.json` | Converted keyframes the game plays. Generated, committed. |
| `assets/anim/moves.json` | The list of clips, and who uses which clip for which move. |
| `tools/convert-mocap.js` | FBX -> keyframes converter. |
| `js/mocap.js` | Loads the clips in the game. |
| `studio.html` | Preview any clip on any character (Animations, under the preview). |

## Adding clips

1. Download from Mixamo as **FBX**, **Without Skin**, 30 fps. Tick
   **In Place** if it's offered (movement across the stage comes from the game).
2. Put the `.fbx` in `fbx/`.
3. Run `node tools/convert-mocap.js` (needs Chrome and an internet connection).
   New files are registered in `moves.json` under `clips`, named after the
   file (`Hook Punch.fbx` -> `hook-punch`), and converted.
   `--all` reconverts everything.
4. Try it in the studio (Animations dropdowns), then assign it (below).

## Assigning clips: `moves.json`

```json
{
  "clips": {
    "jab": { "fbx": "fbx/jab.fbx" },
    "pontera-kick": { "fbx": "fbx/Pontera Kick.fbx" }
  },
  "use": {
    "*":      { "attack": "jab", "hitstun": "receive-uppercut-to-the-face" },
    "artur":  { "attack": "pontera-kick" }
  }
}
```

- `use["*"]` is everyone's default; a character's own entry overrides it per move.
- Moves that can take a clip, and how the clip's time is driven:

| Move | Clip time |
|------|-----------|
| `attack` | Stretched to the basic attack's frames: the clip's **impact** lands in the middle of the attack's active (hitbox) frames. |
| `hitstun` | Plays once over the hit's stun time. |
| `block` | Holds the clip's impact pose (its fullest guard). |
| `walk` | Follows the walk cycle (one clip = one stride). |
| `idle`, `victory` | Loop in real time. |

Anything not listed (specials, ultimates, jumps, knockdowns) keeps the built-in
animation for now.

## Per-clip options (in `clips`)

The converter works these out; set them by hand if it gets one wrong, then run
the converter again.

| Option | Meaning |
|--------|---------|
| `impact` | 0-1: when in the clip the strike is fully out (e.g. `0.45`). Detected as the moment the striking limb is furthest from where it started. |
| `strike` | `"hand"`, `"foot"` or `"head"` (informational). A clip where either foot leaves the ground by more than ~12% of body height counts as a kick. |
| `flip` | `true` if the character in the clip faces the other way (the converter assumes Mixamo's +z). |

## Limits

- The clip is seen from the side, so motion toward or away from the camera is
  flattened: a hook reads as a shorter swing, a spinning kick loses its spin.
  Strikes thrown sideways (most fighting-game moves) come through fully.
- One clip looks the same on everyone who uses it; give characters different
  clips to tell them apart.

## Licensing

Mixamo animations can be used in a game, but (as we understand Adobe's terms)
the raw files shouldn't be redistributed on their own -- so `fbx/` is in
`.gitignore` and only the converted keyframes are committed. Check the current
Mixamo terms if that matters for how the game is shared.
