# 04 — Character Rig & Skins

## The shared rig
Every character is the **same skeleton**: `head`, `body`, `armFront`, `armBack`, `legFront`,
`legBack`. Arms pivot at the shoulder, legs at the hip. There is no elbow/knee bend — a limb is one
piece that rotates at its joint. (This is a deliberate simplification; see `08` if you ever add bend.)

## Poses (the editable "asset" per action)
A **pose** is a set of joint angles, in **degrees, where 0 = straight down and +angle rotates
toward the facing side**. Shape of a pose (see `js/data.js` `BASE_POSE`):
```
{ lean, headX, headY, squash,
  armFront:{sh, el}, armBack:{sh, el},      // sh = shoulder angle (el used only by stick figure)
  legFront:{hip, knee}, legBack:{hip, knee} } // hip = hip angle (knee used only by stick figure)
```
Each **action** (`idle, walk, dash, crouch, jump, fall, attack, special, shield, hurt`) stores one
pose. `attack`/`special` also carry combat data (`startup/active/recovery` + `hit` or `projectile`).
`js/data.js` `defaultActions()` is the canonical set — copy its structure when adding actions.

The fighter picks the action by state (`Fighter._poseName()`), then `getPose()` clones the action's
pose and layers **procedural motion** on top (idle breathing, walk swing, dash churn). Editors edit
the *static* pose; the procedural motion is automatic.

## Two ways a character is drawn
`DS.character.drawFighter(ctx, ch, pose, opts)` is the single entry point. It branches:
- **No skin → parametric stick figure** (`js/character.js`): round head, egg body, stubby limbs,
  fists/feet, doodle face + head decoration. Geometry in `GEO`. This is the default look.
- **Has a skin → drawn parts** (`js/skin.js` `render`): the user's strokes, rotated around the same
  joints. Same poses drive it, so it animates identically.

`opts`: `{ facing (+1/-1), expr ('attack'|'hurt'|'shield'|''), blink, seed, scale }`.
The caller translates to the fighter's world position; `drawFighter` handles scale, lean, squash,
facing (via `ctx.scale(facing,1)`), and draw order (back limbs faded → body → head → front limbs).

## Skins — draw your own fighter (`js/skin.js` + editor Draw tab)
Model on a character: `ch.skin = { enabled, parts: { head, body, armFront, armBack, legFront, legBack } }`,
where each part is `{ strokes: [ { pts:[[x,y]...], w } ] }`. **Strokes are stored relative to the
part's pivot** (`PIVOTS[name]`), in the fighter's local coordinate space.

Key pieces:
- `PIVOTS` — joint location per part (where the part attaches/rotates).
- `REST` — the angle each limb is drawn at on the mannequin (front limbs fan forward `+`, back limbs
  fan back `−`) so the four limbs occupy **distinct regions**. At render time a limb rotates by
  `-(poseAngle - REST[name])`, so a drawn limb lands where the stick-figure limb would.
- `BONES` + `assign(ptsLocal)` — auto-tag a stroke to the nearest body part by its centroid. This is
  what makes "draw over the mannequin, strokes sort themselves" reliable (the regions are known
  because *we* drew the mannequin).
- `drawMannequin(ctx, activePart)` — the faint ghost guide the user traces over.
- `hasSkin(ch)` — true only if `enabled` and at least one part has strokes (so empty skins fall back
  to the stick figure).

### Why this design (don't redo it)
We explicitly rejected "draw freely, auto-segment the whole drawing" (an unreliable CV problem). The
mannequin makes segmentation a solved lookup. We also chose **6 separate parts** (not 4 + mirror) so
characters can be asymmetric.

## How animation "just works" on a drawn character
Because the skin rigs to the same joints and the same action poses drive both renderers, the moment
someone finishes drawing, their character idles, runs, dashes, jumps, attacks, and gets launched —
no per-character animation work. This is the core magic; protect it when refactoring.
