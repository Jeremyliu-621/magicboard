# 07 — Rendering & Coordinates

## Coordinate spaces (know which you're in)
1. **Device pixels** — the canvas backing store (`canvas.width/height`). `main.js` keeps this equal
   to `clientWidth/Height * DPR` every frame (`syncSize`) and sets `ctx.setTransform(DPR,0,0,DPR,0,0)`.
2. **CSS pixels** — what `game.render(cssW, cssH)` works in after the DPR transform.
3. **View space** — the fixed logical stage, **1920×1080** (`DS.VIEW`). `game._applyView` computes
   `scale`/`ox`/`oy` to fit the view into the canvas and **letterbox** it (bars in `paperShade`).
   Stage platforms, spawns, decor, and fighter positions all live in view space.
4. **Fighter-local space** — origin at the fighter's center; `drawFighter` works here (skeleton GEO,
   skin pivots, the mannequin). Caller does `ctx.translate(fighter.x, fighter.y)` first.
5. **Mannequin space** — same units as fighter-local; the Draw tab maps it to view via a center +
   zoom `Z` (`_toMan`).

Converting a pointer to view: `(clientX - rectLeft - game.ox) / game.scale` (see `Editor._toView`).

## Render order (per frame, in `Game.render`)
Two layers, both using the view-fit (`_applyView` → `scale`/`ox`/`oy`, letterbox):
```
clear → blit paperTexture(cssW,cssH) (ONE continuous paper sheet across the whole canvas)
WORLD layer (NO clip — fills the whole canvas; view-fit × CAMERA: zoom+pan around view centre × shake):
  → blast border (dashed KO boundary; off-screen until the camera zooms out toward it)
  → stage (clouds → platforms → ground decor)
  → fighters (shadow → drawFighter → attack swoosh/shield)
  → projectiles → effects (particles) → P1/P2 markers
HUD layer (view-fit only, NO camera, NO shake):
  → HUD (timer, portraits/%/hearts; sub-elements scaled by U = view.h/720)
  → overlay (ready / paused / over)
```
The **camera** (`Game.cam = {cx, cy, zoom}`, updated by `_updateCamera`) and **screen shake** apply
only to the world layer, so the HUD stays put. The camera frames both alive fighters, clamps zoom
to ~[0.5, 1.15], zooms out fast / eases in slowly, and drifts toward a launched fighter. The
background is **one uniform paper sheet** (screen-space) and the world layer is **not clipped**, so
there's no page boundary or letterbox cut when zoomed out / on wide screens. The large KO bounds are
drawn as a faint dashed border (`_renderBlastBorder`) that slides into frame as the camera zooms out
toward a launched fighter.

## The DPR / canvas-size gotcha (important)
When the editor panel opens/closes, the canvas's **CSS width changes** but its **backing store does
not** unless resized. If they desync you get a squished, double-rendered canvas **and** broken
pointer hit-testing (clicks map to the wrong world spot). Fix already in place: `main.js` calls
`syncSize()` every frame to keep `canvas.width/height == clientSize * DPR`. Don't remove it.

## Performance & the pose cache
- Target 60fps with headroom (the live AI pipeline + many drawn entities need the budget). Two fighters of rough strokes are
  cheap; the game currently **direct-renders** each frame.
- `DS.draw.getCached(key, w, h, renderFn)` renders a drawing into an **offscreen canvas once** and
  blits it thereafter (LRU-capped). It exists for when many fighters/overlays are on screen (the AR
  case). If you add lots of repeated drawn elements, render them once into a cache and blit.
- Rendering is isolated behind `js/draw.js` so a WebGL/AR-compositing backend could replace the
  Canvas2D calls without touching game logic. Keep that boundary clean.

## Why the view is 1920×1080
It's a zoom-out: fighters are a fixed pixel size, so a bigger view makes them read smaller with more
room to move. HUD/markers scale by `U = view.h/720` to keep constant on-screen size. The default
stage + decorations are authored to fill this view (decor carries an `s` scale).
