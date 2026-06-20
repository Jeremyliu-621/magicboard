# 06 — Extending (recipes)

Concrete how-tos for the common additions. Match existing conventions (`09`) and the aesthetic (`02`).

## Add a new tunable / setting
1. Add the field to `js/data.js` (`settings`, a character `stats`, or an action).
2. Add an editor control (`05` → "Adding a new editable control").
3. Read it where needed (`world.settings.x`, `this.ch.stats.x`, etc.).
4. If old saves should adopt a *layout-level* change, bump the storage key or add a migration in
   `mergeDefaults` (see below).

## Add a new attack / move
Moves are data + a tiny bit of fighter wiring.
- **Reuse an existing slot:** edit the `attack`/`special` action's pose + `hit`/`projectile` in
  `defaultActions()`. Melee uses `hit:{x,y,r,damage,kbBase,kbScale,angle}`; ranged uses
  `projectile:{speed,damage,kbBase,kbScale,angle,gravity,life,r}`. The editor already edits both.
- **A brand-new move (e.g., an up-special):**
  1. Add the action to `defaultActions()` with a pose + combat data.
  2. Add a control to start it in `Fighter.update` (a new input edge; add the binding in
     `js/input.js` and expose it on `player(i)`).
  3. `_startAction(name)` already supports any action that has a `hit` or `projectile`. For melee,
     `_updateAction` checks the hitbox; for ranged it calls `world.spawnProjectile`. Add a branch
     only if it's a new *kind* of move (e.g., a multi-hit or a grab).
  4. Make sure `_poseName()` returns the action while it's active (it returns `this.action.name`).

## Add a new character to the roster
1. In `defaults()`: `characters.Name = makeCharacter('Name', headStyle, accent)` and add `'Name'` to
   `roster`. Head styles: `spikes | beanie | tuft | none` (rendered in `js/character.js` `head()`).
2. Only `roster[0]` and `roster[1]` are wired into a match today (P1/P2). To support character
   **select**, add UI that sets which roster entries the two fighters use, then `game.rebuild()`.
   (Backlog item — see `08`.)
3. Users can also reskin any character via the Draw tab (`04`).

## Add a stage decoration type
1. Write a draw function in `js/stage.js` (e.g., `rock(ctx, x, y, sx, sy)`), using `DS.draw` helpers
   and a **position-seeded** rng (`DS.makeRng(DS.hashSeed('r'+sx+sy))`) for stable jitter.
2. Handle it in `drawStage` (it already wraps flower/grass/bush with translate + `scale(d.s)` and
   passes original coords for the seed; clouds are drawn first/behind).
3. Add instances to `defaults().stage.decor` with `{ type, x, y, s }`.

## Add a new control / key
1. Add the code to `BINDINGS` in `js/input.js` (per player) and to the `OWNED` set if it should
   `preventDefault`.
2. Expose it on `player(i)` (a `held` boolean and/or a `pressX` edge via `this.pressed(code)`).
3. Read it in `Fighter.update`. Update the help overlay in `index.html` and the controls table in
   `docs/03`.

## Migrations (when old saves must change)
`Store` uses a versioned localStorage key (`doodle-smash:data:v2`). Two tools:
- **Bump the key** (`v2`→`v3`) to force fresh defaults for everyone (wipes saved edits/drawings).
- **In-place migration** in `mergeDefaults` for non-destructive upgrades (e.g., the melee→ranged
  Special upgrade adds `projectile` to old saves while keeping drawings). Prefer this when users may
  have content worth keeping.

## A note on the CV/AR direction
When wiring computer vision, **write into `data.stage.platforms`** (rectangles) and let the existing
game render/play unchanged. Keep the detector behind the same seam the editor uses. See `08`.
