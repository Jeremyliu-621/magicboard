# 00 — Vision

## What it is
**Doodle Smash** is a hand-drawn 2D platform fighter in the spirit of Super Smash Bros:
two fighters knock each other off a stage of floating platforms. The entire look is a
charcoal "soft marker" doodle on warm paper — drawn procedurally in code, no image assets.

It runs as a plain web page (HTML5 Canvas 2D + vanilla JS). No build step, no dependencies.

## The endgame (why decisions are the way they are)
The long-term goal is an **AR layer**: a camera feed is analyzed by computer vision to detect
real-world flat surfaces (a desk, shelves, books), and the game composites fighters and combat
**on top of those real platforms** in real time. The current game is the playable core that the
CV pipeline will eventually drive.

Consequences that shaped the project:
- **Web, not a native engine.** Browsers have first-class real-time CV (MediaPipe / TensorFlow.js
  / WebGL) and camera access, run everywhere, and need no install.
- **Performance is the north star.** The CV pipeline will be the expensive part later, so the game
  itself must stay cheap (target a solid 60fps with headroom).
- **Stage geometry is plain data.** `data.stage.platforms` is just a list of rectangles. A CV
  module can *generate* that list from detected surfaces and feed the exact same game. That seam
  is deliberate — keep it clean.

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
