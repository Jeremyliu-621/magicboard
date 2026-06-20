# GOAL — Doodle Smash

## The one-liner
A fast, great-looking, hand-drawn 2D platform fighter on the web where **players draw their own
characters, weapons, and hazards on an iPad and an AI pipeline injects them — refined and functional —
into a live, projected match in real time.** The philosophy is **create, don't consume**: anyone
(kids included) can draw whatever they want and instantly play with it.

## Why this shape
- **Performance is the north star.** The projector runs a live 60fps match while AI-generated assets
  stream in. Rendering the game itself must stay cheap so the budget is protected for the AI pipeline
  (real-time enhancement + mechanic generation). Target a rock-solid 60fps with headroom.
- **Web is the right substrate.** iPad drawing, a projector display, phone controllers, and easy
  WebSocket fan-out between the game and the AI microservices — all with zero install, anywhere.
- **Everything is data + vector strokes.** Skins, stage geometry, and mechanics are plain,
  serializable data, so AI-generated content flows through the *exact same seams* the editor uses.

## Pillars (in priority order)
1. **Quick.** 60fps with margin. Doodle strokes are rendered once into offscreen pose-caches and
   blitted; per-frame work is near-zero. Rendering sits behind an interface so a WebGL-compositing
   backend can replace Canvas2D without touching game logic.
2. **Looks genuinely good — not "too simple."** Charcoal marker line-art on warm paper. Expressive
   characters with squash & stretch, secondary motion, idle breathing, blinks. Juice: hitstop, screen
   shake, impact starbursts, dust puffs, motion smears, KO blast-off. Handwritten HUD typography. It
   should read as a charming, polished hand-drawn fighter.
3. **Decent fighting-game mechanics.** Smash-style: run/dash, short/full hop, double jump, fast-fall,
   drop-through platforms, shielding, grabs; attacks with startup/active/recovery frames, hitboxes,
   damage %, percent-scaled knockback by weight, hitstun, stocks, blast-zone KOs, respawn. Feels
   responsive and fair.
4. **Everything editable — and it's the foundation the AI writes into.** An in-app Editor: reshape
   poses, tune stats/hitboxes, drag/resize/add platforms, set spawns, tweak settings. Data is plain
   JSON in `Store` (localStorage, export/import). The drawing pipeline and authoring agents produce
   the *same* data the editor mutates and the game reads live.
5. **Built for live AI creation (the showpiece).** The headline is **real-time asset enhancement** (a
   rough sketch becomes a polished doodle in <100ms felt latency) and **real-time mechanic injection**
   (a drawn gun becomes a working weapon seconds later). Full runtime design in
   `docs/13-ai-pipeline.md`. Because stage/skin/mechanic data is plain, AI agents and a beefed-up,
   agentic level editor all produce the same data the game already consumes.

## Default setup
- 2 human players on one keyboard (P1 vs P2) for the core fighter; phones/iPads join for drawing +
  control (see `docs/11`).

## Definition of done
- **v1 (done):** opens by double-clicking `index.html`; two doodle fighters battle on a doodle stage
  at 60fps with the mechanics above; juice and art look polished; the Editor can fully reshape
  characters/stage/settings and persist them.
- **The headline direction:** the live AI creation pipeline (`docs/13`) — **draw → playable in
  <100ms → functional in ~1–2s** — projected on a wall, with the network bridge wiring iPad, the two
  AI engines, and the display.

> Note: an earlier framing made a *computer-vision AR layer* (detecting real-world shelves/surfaces and
> compositing the game on top) the endgame. That's been **demoted to an optional, far-future idea** — a
> CV module could feed `data.stage.platforms` through the same seam the editor/AI use, but it is **not**
> what we're building toward now. The creation pipeline is the goal. See `docs/08`.
