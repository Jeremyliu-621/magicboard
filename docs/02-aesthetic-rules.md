# 02 — Aesthetic Rules (the visual bible)

> This is the most important doc. The whole appeal is that everything looks like one person
> doodled it with a soft marker on a sheet of paper. Every new element must obey these rules or
> the world stops feeling coherent. When in doubt, match what `js/draw.js` already does.

## The look in one sentence
**Thick, slightly-wobbly rounded charcoal line-art on warm off-white paper — hand-drawn, imperfect,
monochrome, friendly.** Think doodle-in-a-notebook, not polished corporate vector art.

## 1. Palette — monochrome charcoal on paper
Defined in `js/draw.js` `COL` (and mirrored in `style.css` `:root`):

| Token | Hex | Use |
|---|---|---|
| `ink` | `#2f2a26` | **Every in-game line and fill-stroke.** Warm near-black, never pure `#000`. |
| `inkSoft` | `#6b6259` | Secondary/faint marks: guides, mannequin ghost, subtle labels. |
| `paper` | `#f6f1e7` | The canvas/background and the **fill** of solid shapes. |
| `paperShade` | `#e9e0cf` | Letterbox bars / behind the stage; slightly darker paper. |
| `accent` | `#d4663f` | **Editor UI ONLY** (selection, spawn markers, hitbox preview) + CSS chrome. |

Hard rules:
- **In-game art is strictly monochrome** — `ink` lines on `paper`. No color in the world.
- **`accent` (orange) must never appear in gameplay art.** It is reserved for editor affordances
  and HTML UI so editing feels distinct from playing.
- Never use pure black or pure white. Use the warm tokens.
- Convey depth with **line weight, layering, and faint alpha**, not with color or gray fills.

## 2. The line — rough "soft marker" strokes
All strokes go through `DS.draw` (`strokePts` and the shape helpers). Characteristics:
- **Rounded caps and joins** (`lineCap/lineJoin = 'round'`). Lines look like a brush pen.
- **Wobble (jitter):** anchor points are nudged by a small random amount (`jitter`, default ~1.6px)
  so lines aren't ruler-straight. Path is smoothed with quadratic curves through midpoints
  (`smoothPath`) so the wobble is gentle, not jagged.
- **Endpoints wobble less** (~0.35× jitter) so connected strokes still meet cleanly.
- **Double pass for weight:** a main stroke plus a lighter, thinner second pass
  (~0.55× width, ~0.5 alpha) — that's what gives the soft, slightly-doubled marker feel. (Skipped
  for thin/UI strokes via `passes: 1`.)
- **Typical line widths** (logical px, fighter ~74px tall): limbs 5.5–7, body/head outline ~5.5,
  faces & small details 3–4, platforms ~6 (with a ~4 surface wave), decorations 3.5–4.5,
  HUD strokes 3–5. Keep lines **thick and confident**, not hairline.

## 3. Stable vs "boiling" jitter — be intentional
Jitter is driven by a **seeded** RNG (`DS.makeRng`) so a shape looks the same every frame
(no distracting shimmer):
- **Static things are stable:** stage platforms/decor seed off their position; a fighter seeds off
  its player index (`pIndex*1009+7`). They wobble in shape but **hold still**.
- **Energetic things may "boil":** short-lived effects (impact stars, dust, projectile poof)
  re-seed each frame so they crackle with life. That's intentional and limited to fast FX.
- Rule of thumb: anything on screen for more than ~0.3s should have a stable seed.

## 4. Solid shapes = paper fill + ink outline
Things that should read as opaque cutouts (platforms, clouds, bush, the character body, the
projectile ball, HUD portrait frames) are **filled with `paper`** then **stroked with `ink`**.
This makes them sit "on top of" the paper and occlude what's behind. Open marks (limbs, grass,
faces, motion lines) are just strokes, no fill.

## 5. Paper backdrop
`DS.draw.paperTexture()` renders once and is blitted: a `paper` fill + very faint ink **speckles**
(alpha ~0.015–0.045) + a soft **radial vignette** (up to ~0.06 ink at the edges). Keep it subtle —
it should feel like real paper grain, never a visible texture.

## 6. Characters — friendly, chunky doodles
(Geometry in `js/character.js` `GEO`.) Proportions matter for the cute factor:
- **Big round head** (r≈19) on a small **egg body** (rx≈15, ry≈17). Stubby limbs.
- Hands are little filled **fists** (a dot); feet are small filled **shoe ellipses**.
- **Back limbs are faded** (~0.82–0.85 alpha) and drawn first; body, then head; then front limbs on
  top. This layering is the only depth cue — preserve the order.
- **Face:** eyes are two short vertical ticks; blinking = two horizontal ticks; hurt = little X eyes;
  attacking = a small open mouth. Eyes bias toward the facing direction. Keep faces minimal.
- **Head decoration** distinguishes characters (`spikes`, `beanie`, `tuft`, `none`) — small, drawn
  in the same ink line. That's the main visual identity; don't add color.

## 7. Motion & life (animation feel)
- **Squash & stretch:** poses carry a `squash` (vertical scale). Use it for jumps/landings/idle.
- **Idle breathing** (slow head bob + tiny squash), occasional **blink**, **walk** leg/arm swing,
  **dash** churn — all procedural, layered on the static action pose (see `04`).
- **Dash effect = a simple smoke/dust puff trail** behind the fighter (reuse `effects.dust`,
  emitted every ~0.04s at the feet, drifting opposite the dash) + a kick-off puff. (History: we
  tried straight speed-lines and then after-image ghosts; plain dust reads cleanest — keep it simple.)

## 8. Juice (all in `ink`, all hand-drawn)
- **Impact:** a rough multi-point **starburst** + a few radiating spark lines, scaled by power.
- **Dust:** small wobbly circles that puff and fade (jumps, landings, dash kick-off).
- **Screen shake** (trauma-based, decays) and **hitstop** (brief freeze) sell big hits.
- **Projectiles** disappear with a **shrink-and-puff**: the ball shrinks + fades while small dashes
  radiate out — never a hard cut. (On a direct hit, the impact starburst covers the disappearance.)
- **KO:** a big star burst + strong shake.
- Keep FX short and punchy; they read as quick pen-scribbles, not particles.

## 9. HUD & UI typography
- **Fonts:** `Patrick Hand` for general UI/labels; `Gloria Hallelujah` for titles, the timer, and
  big numbers (the wobbly, kid-handwriting font). Both via Google Fonts; fall back to cursive.
- HUD is hand-drawn to match: the **timer** has little tick "speed marks" beside it; **hearts**
  (stocks) are drawn with a rough bezier and filled `ink` when full, outlined when spent; the
  **percentage** sits over a hand-drawn **underline** and its font **grows with damage**; the
  **P1/P2 markers** are labels with a gently **bobbing hand-drawn arrow**; portraits are a
  rounded-square frame (paper fill) with a mini doodle face.
- HTML controls (`style.css`) echo the style: hand-font, thick ink borders with slightly irregular
  `border-radius`, paper backgrounds, tiny rotate-on-hover wiggle. Keep it playful.

## 10. Scale & camera
- **Dynamic Smash-style camera:** it frames both fighters, zooms out (and drifts toward) a
  launched fighter, and eases smoothly (`Game._updateCamera`). The HUD stays anchored to the view
  box, unaffected by the camera.
- **The whole arena is ONE continuous sheet of paper** — no visible page/mat boundary, and **no
  letterbox/clip** (the world fills the whole canvas; the field is never cut off by a vertical edge).
  The background is a single screen-space paper fill (`paperTexture(cssW, cssH)`) with a soft edge
  vignette; the stage and fighters sit on it. (We tried a "page floating on a darker mat" look and a
  16:9 clip — both produced confusing fake boundaries. Don't reintroduce them.)
- **The KO boundary IS drawn** — a faint hand-drawn **dashed charcoal border** at the blast bounds
  (`Game._renderBlastBorder`), in world space. It's off-screen during normal close play and slides
  into view as the camera zooms out toward a launched fighter, so you can see where "death" is.
- The view is **1920×1080 logical px** (a zoom-out: fighters are a fixed pixel size, so they read
  smaller with more room to move). HUD sizes scale by `U = view.h/720` to stay constant on screen.
- World/decor scale together (decorations carry an `s` factor); fighters are intentionally smaller
  relative to the world.

## Do / Don't
**Do**
- Route every mark through `DS.draw`; reuse `line/curve/circle/ellipse/roundedRect/wavy/strokePts`.
- Keep it monochrome ink-on-paper; use line weight + layering + faint alpha for hierarchy.
- Give static elements a stable seed; let only quick FX boil.
- Fill solids with `paper`; keep lines thick and round.

**Don't**
- ❌ Add color to gameplay art (orange `accent` is editor-only).
- ❌ Use pure black/white, thin hairlines, or hard geometric/vector-perfect edges.
- ❌ Draw with raw `ctx` strokes that bypass the rough renderer (they'll look too clean and clash).
- ❌ Let big/static shapes re-jitter every frame (shimmer/"boiling" looks buggy).
- ❌ Introduce raster image assets — everything is procedural strokes (user drawings are stored as
  vector strokes too).
