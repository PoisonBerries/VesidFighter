# Animations (motion capture)

Fighters can play motion-capture clips instead of their built-in, hand-made
animation, move by move. Clips are stored as the *directions* of every bone
(upper arms, forearms, thighs, shins, feet), the spine's lean, the head's
tilt, where each shoulder and hip sits and how the body shifts -- and the game
rebuilds that pose with each character's own bone lengths, then stands the
planted foot on the floor. So the motion is the clip's and the proportions
stay the character's (including drawn parts and body.json shapes). It's
purely visual: hitboxes, timing and online play are unchanged.

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
| `attack` | Only the clip's **action window** plays (the converter trims the standing around before and after). The wind-up is compressed so the clip's **impact** lands mid-way through the attack's active (hitbox) frames; the recovery then plays at real speed, carrying on after the attack while the fighter just stands or walks. |
| `hitstun` | The action window, once, at real speed. |
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
| `window` | `[start, end]`, 0-1: the part of the clip to play (detected from when the striking limb starts and stops moving). |
| `view` | Degrees to turn the clip toward the camera before flattening (default 0 = pure side view). Try 15-25 for moves with a lot of rotation, like hooks. |
| `flip` | `true` if the character in the clip faces the other way (the converter assumes Mixamo's +z). |

## Limits

- The clip is seen from the side, so motion toward or away from the camera is
  flattened: a hook reads as a shorter swing, a spinning kick loses its spin.
  Strikes thrown sideways (most fighting-game moves) come through fully.
- One clip looks the same on everyone who uses it; give characters different
  clips to tell them apart.
- Mixing mocap and built-in moves shows a small shift in stance when one hands
  over to the other. Clips from the same family (e.g. Mixamo's boxing idle,
  walk, jab, cross, hook, block, hit, knockdown, get up) avoid it.

## Checking a clip

The studio's Animations dropdowns show a clip on any character. To compare a
clip against its source frame by frame, the page exposes `Mocap.debug.time`
(set 0-1 to hold every clip at that point; `null` to go back to normal).

## Licensing

Mixamo animations can be used in a game, but (as we understand Adobe's terms)
the raw files shouldn't be redistributed on their own -- so `fbx/` is in
`.gitignore` and only the converted keyframes are committed. Check the current
Mixamo terms if that matters for how the game is shared.
