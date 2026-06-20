# 08 — Roadmap & the CV/AR Pivot

## The big pivot: computer-vision platforms → AR overlay
The endgame is: a **camera feed** is analyzed to detect real-world flat surfaces, and the game
composites fighters + combat **on top of those surfaces** in real time.

The architecture is already prepared for this:
- **Stage geometry is plain data** — `data.stage.platforms` is a list of `{x,y,w,h,pass}` rectangles
  in view space. A CV module just needs to **produce that array** from detected surfaces and the
  existing game renders/plays unchanged.
- **Rendering is isolated** behind `js/draw.js` (Canvas2D today; a WebGL/AR compositor can slot in).
- **Performance headroom** is the whole reason we went web + cheap procedural art.

### A sane build order for the CV work
1. **Camera + detection prototype** (separate module): webcam via `getUserMedia`; detect planes/rects
   with MediaPipe / TensorFlow.js / OpenCV.js. Output a list of rectangles in screen space.
2. **Map detected rects → `data.stage.platforms`** (scale/translate into view space; decide which are
   solid ground vs pass-through). Feed them through the same `Store`/stage path.
3. **Composite** the game canvas over the video (transparent background; draw fighters/FX only).
4. **Stabilize** (smoothing, hysteresis) so platforms don't jitter frame to frame.
Keep the detector behind the same seam the editor writes to — author mode and CV mode produce the
same `stage` data.

## Gameplay/content backlog
- **Character select** so both players choose from the full roster (only `roster[0/1]` are wired now).
- **"＋ new character"** button so users add roster slots instead of reskinning Sprout/Acorn.
- More moves: directional/aerial attacks, a grab/throw, chargeable special.
- Smarter/optional CPU opponent (current AI is attract-mode only, in `Game._ai`).
- Per-character distinct projectiles / stats presets.
- Sound (there is none yet).

## Known limitations (and the why)
- **Limbs are single pieces** (no elbow/knee bend) — simpler rig, reads fine for doodles. Adding 2-
  segment drawn limbs would mean splitting each arm/leg part and a second joint angle.
- **2 fighters only** in a match (engine spawns `roster[0]`/`[1]`). Multi-fighter needs HUD + spawn
  changes.
- **No pose-caching in play** yet (direct render); fine for 2 fighters, revisit for many overlays.
- **Storage migration is coarse** (key bump wipes saves; in-place migrations are ad hoc in
  `mergeDefaults`). Fine for an early project; formalize if it grows.

## Guardrails when extending
- Don't break the **aesthetic** (`02`) or the **rig-is-constant** principle (`01`/`04`).
- Keep new tunables **in `data.js` and editable** (`05`).
- Verify visually with the **dev URL hooks + on-page banner** (`09`) — there's no console in normal runs.
