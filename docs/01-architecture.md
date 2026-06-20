# 01 — Architecture

## The one principle to remember
**The rig is constant; the art is swappable.** Every character — built-in stick figure or a
user's drawing — is animated by the *same* skeleton of joints (head, body, 2 arms, 2 legs) and the
*same* set of action poses (joint angles per action). So any new move animates every character for
free, and a freshly-drawn character is instantly fully playable. Don't fork this.

## No build, classic scripts
There is no bundler. `index.html` loads each `js/*.js` with a plain `<script>` tag **in order**.
Everything attaches to a single global namespace `window.DS`. This is deliberate so the game runs
from `file://` by double-clicking `index.html` (ES modules would hit CORS on `file://`).

Load order (from `index.html`) — earlier files must not depend on later ones at load time:
```
rng → draw → data → character → skin → effects → input → physics → fighter → stage → modes → game → editor → main
```

## Code map
| File | Responsibility |
|---|---|
| `js/rng.js` | `DS.makeRng(seed)` (deterministic PRNG) + `DS.hashSeed(str)`. For stable hand-drawn jitter. |
| `js/draw.js` | `DS.draw`: the rough "marker" renderer (`line/curve/ellipse/circle/roundedRect/wavy/strokePts`), color palette `COL`, the offscreen pose cache `getCached`, and `paperTexture`. **All drawing goes through here.** |
| `js/data.js` | `DS.Store` (the single source of truth, localStorage) + `defaults()` (characters, stage, settings) + the pose model + save/load/migration. |
| `js/character.js` | `DS.character.drawFighter()` — the parametric stick figure (skeleton geometry, limbs, head, face). Branches to `DS.skin.render` if the character has a drawn skin. |
| `js/skin.js` | `DS.skin` — user-drawn 6-part skins: render, stroke→part auto-assignment, the mannequin guide. |
| `js/effects.js` | `DS.Effects` — particles (stars/sparks/dust/smears), screen shake (trauma), hitstop, KO bursts, floating text. |
| `js/input.js` | `DS.Input` — keyboard state with per-frame pressed/held edges, mapped to two players. |
| `js/physics.js` | `DS.physics.step()` — AABB platformer collision (solid + pass-through, drop-through). |
| `js/fighter.js` | `DS.Fighter` — movement, jumps, dash, shield, attacks, projectiles, knockback, KO, pose selection, render. |
| `js/stage.js` | `DS.stage.drawStage()` — platforms + doodle decorations (clouds, grass, flower, bush). |
| `js/modes.js` | `DS.Modes` + `DS.Maps` — game-mode hooks (Smash/KotH/Gems/K.O. Rush) and map presets. See `10`. |
| `js/game.js` | `DS.Game` — match flow, camera/letterbox, projectiles, HUD, overlays, attract AI; drives the active mode + map. |
| `js/net.js` | `DS.Net` — host-side phone-controller networking; exposes a phone slot as `player(slot)` like `DS.Input`. See `11`. |
| `js/editor.js` | `DS.Editor` — the editor tab UI + canvas interactions. |
| `js/main.js` | Bootstrap: canvas/DPR sizing, tab switching, help overlay, lobby UI + input routing, the rAF loop, dev URL hooks. |

The game above is **client-only and still runs from `file://`**. The *optional* phone-controller
feature adds a server (`server.js`, with `controller.html`) — the one networked exception; see `11`.

## Data flow
```
                 ┌─────────────┐
   Editor  ───►  │  DS.Store   │  ◄─── localStorage (key 'doodle-smash:data:v2')
 (mutates)       │  .data      │
                 └─────┬───────┘
                       │ read every frame
                 ┌─────▼───────┐
   Input ──► DS.Game.update ──► DS.Fighter.update ──► physics/combat
                       │
                 DS.Game.render ──► stage → fighters(+skins) → projectiles → effects → HUD
```
- The **Editor mutates `Store.data` in place** and debounce-saves. The **Game reads `Store.data`**
  (via `game.data`) when it `rebuild()`s a match. So "Play test" = rebuild + read latest data.
- Characters reference their data object by identity, so editor changes show live in the preview.

## The frame loop (`main.js`)
Each rAF tick: keep the canvas backing store sized to its CSS box (`syncSize`), set the DPR
transform, then either `game.update(dt); game.render(...)` (Play) or `editor.render(...)` (Editor),
then `DS.Input.update()` to roll the pressed/held edges. `dt` is clamped to 50ms.

## Where state lives
- **Authoring/persistent state:** `DS.Store.data` (characters, stage, settings). Serializable JSON.
- **Runtime/match state:** on `DS.Game` (fighters, projectiles, timer, effects) — rebuilt per match,
  never persisted.

See `07` for coordinate spaces and rendering details; `02` for how anything is allowed to look.
