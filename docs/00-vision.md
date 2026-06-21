# 00 — Vision

## What it is
**Doodle Smash** is a hand-drawn 2D platform fighter in the spirit of Super Smash Bros:
two fighters knock each other off a stage of floating platforms. The entire look is a
charcoal "soft marker" doodle on warm paper — drawn procedurally in code, no image assets.

It runs as a plain web page (HTML5 Canvas 2D + vanilla JS). No build step, no dependencies.

## The endgame (why decisions are the way they are)
The goal is a **live creation game**: players draw their own characters, weapons, and hazards on an
iPad and an AI pipeline injects them — **refined and functional** — into the projected match in real
time. The showpiece is **real-time asset enhancement** (a rough sketch becomes a polished doodle in
<100ms felt latency) and **real-time mechanic injection** (a drawn gun becomes a working weapon
seconds later). The current fighter is the playable core this pipeline creates *into*. See `08` for
the direction and `13` for the runtime design.

Consequences that shaped the project:
- **Web, not a native engine.** iPad drawing, a projector display, phone controllers, and easy
  WebSocket fan-out between the game and the AI microservices — zero install, runs anywhere.
- **Performance is the north star.** The projector runs a live 60fps match while AI assets stream in;
  the render must stay cheap so the budget is protected for the AI pipeline (enhancement + mechanics).
- **Stage/skin/mechanic data is plain and serializable.** AI-generated content (vector strokes, stage
  rectangles, mechanic specs) flows through the *exact same seams* the editor uses — so a drawing
  pipeline, agents, and the editor all produce the same data the game reads.

> Earlier this doc framed a **computer-vision AR layer** (detecting real-world surfaces and compositing
> the game on top) as the endgame. That's now an **optional, far-future idea**, not the goal — a CV
> module could produce `data.stage.platforms` through the same seam, but we're building the creation
> pipeline. See `08`.

## Who plays
Local **2 players on one keyboard** (P1 vs P2), matching the classic couch-fighter feel.
(See `03` for controls.) Single-player vs an AI exists only as an attract-mode demo today.

## Current state (keep this updated)
Working and verified:
- Movement: run, double jump, fast-fall, drop-through soft platforms, shield.
- **Dash:** double-tap left/right; a dash refreshes on every jump (jump→dash→jump→dash); smoke trail.
- **Dynamic camera:** Smash-style — frames both fighters, zooms out and drifts toward a launched
  one. Large KO bounds so fighters fly far before dying.
- Combat: melee **Attack** + ranged **Special** (thrown projectile); frame data; percent-scaled
  knockback by weight; hitstun; stocks; blast-zone KOs; respawn; match timer.
- Juice: hitstop, screen shake, impact starbursts, dust, KO bursts, projectile fade-out poof.
- **Draw-your-own-character:** draw 6 parts over a mannequin; auto-tag by region; rigs to the
  skeleton so it animates through every move.
- Editor: characters (pose/stats/hitbox/projectile), draw tool, stage layout, settings; save/export/import.

Known limitations: limbs are single pieces (no elbow/knee bend); only 2 roster slots wired into a
match; AI is a simple attract-mode bot. See `08` for the backlog.

## Repo
- Personal remote: `git@github.com-personal:Jeremyliu-621/doodle-smash.git`
  (committed/pushed under the personal identity Jeremyliu-621 / jeremyliu621@gmail.com).
