# 03 — Gameplay & Mechanics

Smash-style platform fighter: there is no health bar — hits raise a **damage %**, and higher %
means you fly farther, until you're knocked past a **blast zone** and lose a stock.

## Controls (2 players, one keyboard)
Defined in `js/input.js` `BINDINGS`.

| | Player 1 | Player 2 |
|---|---|---|
| Move | `A` / `D` | `←` / `→` |
| Jump (×3) | `W` | `↑` |
| Crouch / drop-through | `S` | `↓` |
| Attack (melee) | `F` | `.` |
| Special (ranged) | `G` | `/` |
| Shield | `Left Shift` | `Right Shift` |
| **Dash** | double-tap `A`/`D` | double-tap `←`/`→` |

Global: `Enter` start/rematch, `P` pause, `?` help overlay, `Esc` close help.

## Movement (in `js/fighter.js`, tuned by character `stats`)
- **Run/air:** accelerate toward `runSpeed` (ground) / `airSpeed` (air); ground friction when idle.
- **Jump:** `jumpVel` off the ground, then `doubleJumpVel` for each air jump while `jumps` remain
  (`maxJumps`, **default 3 = triple jump**; editable per character, 1–4 in the editor). Because the
  air-dash refreshes on every jump (below), a triple jump grants three dashes:
  jump→dash→jump→dash→jump→dash.
- **Fast-fall:** hold down in the air to cap fall at `fastFallSpeed` instead of `fallSpeed`.
- **Drop-through:** press down on a pass-through platform to fall through it briefly.
- **Shield:** hold shield on the ground (draws a bubble); blocks and pushes back, no knockback.
- **Dash:** double-tap a direction within `TAPWIN` (0.26s) → a burst at `dashSpeed` easing back to
  `runSpeed` over `DASH` (0.28s). Gravity is suspended during a dash so it's flat. **A dash refreshes
  on every jump** (`airDashUsed` resets on landing *and* on each jump, ground or air) — so you can
  jump → air-dash → jump → air-dash → jump → air-dash (one dash per jump, up to the triple
  jump's three), Smash-style. Jump/attack/special cancel a dash.
  Visual = a simple smoke/dust puff trail + kick-off puff (see `02 §7`).
- **Ledge grab & recovery (Smash-style):** falling beside an **outer corner of a solid stage
  platform**, within `LEDGE_X`/`LEDGE_Y` and not rocketing up, you **snap to hang** on the ledge
  (the `ledge` action pose: arms overhead, dangling) — jumps + air-dash refill and you get brief
  invuln. From the hang (after a ~0.14s lock): **Up** = ledge-hop, **toward the stage** = climb up,
  **Down/away** = drop off. State + logic in `Fighter` (`ledge`, `_tryLedgeGrab`, `_updateLedge`).
  Only solid platforms have grabbable ledges; pass-through floats you just land on.

## Attacks — fluid, no-delay, movement-driven (the design north star)
This combat is tuned for **Minecraft-1.8.9 feel**: no wind-up, no commitment, and **movement is the
combo + finisher engine** (not input strings). Don't add startup or movement-locks back in.
- **No delays / no pause:** attacks have **0 startup** (the hitbox/projectile is live the instant you
  press) and **never lock or dampen movement** — you run, jump, and dash *through* a swing. In
  `Fighter.update`, movement runs every frame regardless of the current action; the attack/special
  triggers fire after movement and `_updateAction` runs after them (so a just-pressed Special fires
  the same frame). `_startAction` no longer touches `vx`/`dashT`.
- **Spammy / zero whiff cost:** press to swing as fast as you like; a missed swing costs nothing.
- **Attack (melee):** the `attack` action has a `hit` = `{ x, y, r, damage, kbBase, kbScale, angle }`
  (a circle offset forward, active during the active window). It does **low base knockback** so a
  standing jab barely nudges (you can chain), and the launch comes from **momentum** (below).
- **Special (ranged):** the `special` action has a `projectile` config instead of `hit`:
  `{ speed, damage, kbBase, kbScale, angle, gravity, life, r, cooldown }`. It has a **cooldown**
  (default 1.5s, `Fighter.specialCd`) so it can't be machine-gunned — the melee jab has none. On the active frame it spawns one
  projectile (owned by the game in `Game.projectiles`) that flies forward, hits the opponent, and
  fizzles on hit / solid platform / lifetime / blast zone (with the shrink-puff fade-out).
  - **Aim:** it fires **straight by default** (`angle` is a base offset, normally 0). The launch
    angle = `angle` + a live **aim** read from the held direction at the instant it fires (in
    `Fighter._updateAction`): hold **up** → +`AIM`° (40), **down** → −40°, nothing → straight.
    `spawnProjectile(owner, cfg, aimDeg)` applies it. (`mergeDefaults` resets a legacy base angle of
    6° to 0 so old saves fire straight.)
  - **Aim drives the animation:** the live aim is stored on the fighter (`aimHold`, updated through
    the whole move). `getPose`'s `special` branch tilts the throwing arm (+head/lean) by it, so the
    windup telegraphs the shot; and the projectile's motion streaks trail along its actual velocity
    direction, so an angled shot's trail angles too.

### Momentum
`Fighter.momentum` (0..1) is real stored momentum, *not* raw speed. A **dash charges it to full**;
it **decays** to empty over ~0.55s once you stop dashing; a **jump carries it** (`_carryMomentum`
tops it back to ≥0.85 if you had any, so dash→jump stays charged). While you have momentum you also
move slightly faster (grounded max speed × `1 + 0.22*momentum`). `_fast()` = dashing or
`momentum > 0.4` (`MOM_FAST`) — this gates the speed moves below, so **just running no longer
counts**; you have to dash. The dev gauge (`B`, `Game._devSpeedBar`) shows momentum with the 0.4
"fast" tick.

### Conditional / contextual attacks
The same two buttons fire different moves depending on your state — `Fighter._pickAttack()` and
`_pickSpecial(world)` choose the action name, then `_startAction` runs it. "Fast" = `_fast()` (real
momentum, above).

| Button | State | Move | What it is |
|---|---|---|---|
| **Attack** | grounded, slow | `attack` | the normal jab |
| **Attack** | **airborne** | `hammer` | overhead **hammer slam** — a meteor spike (`angle:-68`, hit below); `_startAction` dives the attacker down (`meteor`). The hammer swings down then **hangs at the slam (hitbox live) until you land** (`_updateAction` holds `a.t` while airborne), then ends |
| **Attack** | **momentum** (ground) | `superpunch` | a committed straight power punch (bigger base knockback) |
| **Special** | no momentum | `special` | the normal ranged shot |
| **Special** | **momentum + close** (opp < 110px) | `ultrapunch` | the big launcher melee |
| **Special** | **momentum + far** | `supershot` | a bigger, faster doodle blast |

All keep 0 startup (the no-delay rule). Every Special-button move shares the special cooldown; the
melee button has its own short `attackCd`. The new moves are full actions in `data.js
defaultActions()` (editable poses, added to the editor's pose list); `mergeDefaults` adds them to
existing saves. The hammer swings an overhead hammer (held prop). The three **speed-special** moves
**morph the whole fighter into a big doodle of the weapon** for the move, then morph back
(`Fighter.render` crossfades body→weapon over a long recovery so you can see it): super punch → white
**boxing glove** 🥊, ultra punch → oversized **accent glove**, super shot → a **cannon** 🚀. The
morph is purely visual — the hitbox/projectile/collision are unchanged, so it doesn't affect balance.
Unlike the instant jab, the super moves have a **short startup** (~7–10 frames) and the weapon
**animates through it**: the glove cocks back and **thrusts to full extension just as the hit lands**;
the cannon **pulses/charges then recoils** as it fires (`Fighter.render` translates/scales the weapon
by the action phase, with the impact anchored at `startup/total`). The brief windup is what makes the
moves read as real strikes instead of a static pop.

**Dev helpers (play mode):** `B` toggles a **"fastness" speed gauge** above each fighter — current
`|vx|` with the fast threshold (`runSpeed*0.85`) ticked, turning accent when you're in the
super-move regime. (Also: `0` overview zoom, `-`/`=` zoom, `\` auto camera.)

To add more moves or per-character variety, see `06`.

## Body collision
Fighters **can't phase through each other** — `Game._resolveBodies()` (each frame, after the
fighters update) resolves an AABB overlap along the smaller axis: side-by-side they push apart
horizontally and their into-each-other velocity is cancelled (a solid bump); stacked, they separate
vertically (you can briefly stand on a head, then slide off). Correction is split between the two.

## Combos — longer chain = more % dealt
A **combo** is tracked per attacker in `Fighter` (`combo`, `comboT`): each landed hit increments
`combo` and refreshes a ~1.1s window (`comboT`) to continue it; let the window lapse, get hit
yourself, or get KO'd and the chain resets. In `_takeHit` the damage dealt is scaled by the
attacker's chain — `hit.damage * (1 + min(0.8, (combo-1) * 0.12))` — so each chained hit lands up to
**+80%** more (at a ~7-hit chain). Movement still *drives* the chain (you must keep connecting within
the window, MC-1.8.9 style); the scaling just rewards it. The bonus compounds into knockback because
knockback already scales with the accumulated %.

### % readout juice (`Game._portrait`)
The corner % gets hand-drawn feedback: a **combo badge** (`N× COMBO`, accent, pops on each hit via
`comboFlash`, fades as `comboT` closes); a **danger glow** as % climbs past ~80% (the number tints
toward accent and trembles, full red-hot by ~150%); and a **powerful-hit punch** — taking a big hit
sets `hitFlash`, which momentarily scales the number up and flashes it accent (bigger launch = bigger
pop). All driven by per-fighter `combo/comboT/comboFlash/hitFlash`, decayed each frame in `update`.

## Ultimates (charged super moves)
Each fighter picks one of three ultimates on the **pre-match pick screen** (`#ult-overlay`, built in
`main.js`; stored on `game.ultPick` and applied to fighters in `rebuild`). The ultimate **charges
from damage you deal**: `Fighter.charge` (0..1) rises by `dealt / CHARGE_NEED` (75% cumulative) in
`_takeHit`. When full, `_ultReady()` is true and the fighter's **lines turn powerful blue**
(`drawFighter` is passed `color: D.COL.power`); the HUD shows a blue charge bar + `★ <ULT> 2×G`.
**Double-tap the special button (G/`/`)** while charged to fire it (a single press is the normal
special). Activation runs `_activateUlt`.

- **Boomerang Hammer** (`ulthammer` action throws it): after a short wind-up the fighter **throws a
  big spinning blue hammer** that flies out to **mid range** (`boomerang.range` ≈ 360px), decelerates,
  then **homes back to the thrower** and is "caught" (`world.spawnBoomerang` → a `boomerang` projectile
  handled by `Game._updateBoomerang`: out → back, flies through platforms, spins). It can hit once on
  the way out and once on the way back (big launch + `Effects.ultHit`).
- **Sniper** (`ult.type==='sniper'`, `_updateSniper`): freeze in place into an aiming stance with a
  pulsing **laser sight** + crosshair and a held rifle (all blue). **Full 360° WASD aiming** — the
  held direction(s) set a target the aim snaps toward fast. **G fires** a very fast, **huge-radius**
  (`SNIPER_SHOT.r≈48`, easy to land), hard-hitting shot along the aim; **F cancels** with a jab.
  Auto-cancels after 6s.
- **Werewolf** (`ult.type==='werewolf'`): a **timed transform** (9s, extended by damage dealt) into
  a clawed beast (`DS.character.drawWolf`, driven by the same pose rig). Buffs via `_wolfStats`:
  ~32% faster, **6 jumps (→ up to 5 air-dashes)**, snappier accel. Melee-focused — **F = alternating
  paw swipe** (`clawswipe`, `ult.paw` flips each time + a claw-streak FX), **G = a big AOE slash**
  (`wolfslash`, large radius, visible blue slash arcs). Each hit deals **+30%**, **drains the wolf's
  own %** (its knockback resistance climbs), and extends the timer (`_takeHit`).

## Knockback (the core formula) — momentum is the finisher
In `Fighter._takeHit(hit, atkFacing, attacker, world)`:
```
damage += hit.damage
launch  = (hit.kbBase * 8 + damage * hit.kbScale * 62) * settings.knockbackScale
into    = attacker.vx * atkFacing                 // attacker speed toward the target
if (into > 0) launch += into * 0.35               // dash/run-in adds knockback (sprint-hit / W-tap)
launch /= weight
vx = cos(angle) * atkFacing * launch
vy = -sin(angle) * launch - 50                    // slight upward pop
hitstun = launch <= 120 ? 0 : min(1.1, (launch-120) * 0.002)   // light hits = no stun
```
- **No stun on light hits (MC 1.8.9 W-tap feel).** A hit below the `STUN_FLOOR` (120
  knockback) imposes **zero hitstun** — the victim slides back but keeps *full control*, so
  they can immediately turn, dash back in, counter-hit, and trade. A standing jab (~47 KB)
  never stuns; stun only kicks in for the dash-in finisher (~276 KB → ~0.3s) and high-% hits,
  so combos still close into a KO as damage climbs. A no-stun hit also **doesn't cancel the
  victim's own swing**, so clean trades land.
- **Movement = power.** A standing jab ≈ 30–50 knockback (combo-able); a dash-in jab ≈ 270 (the
  finisher) — a *slight*, graded speed bonus, not a cliff, so running jabs still combo. This is the whole strategy: chain light jabs at low %, then dash-in or use the Special
  to launch. Knockback also **scales with the victim's % and is divided by `weight`**, so combos
  naturally end into a KO as damage climbs. `angle` is degrees from horizontal, in the attacker's
  facing direction.
- Juice scales with `launch`: bigger hits = bigger impact star, more shake, longer hitstop.
- A **shielding** victim takes no knockback (just chip pushback + a small hitstop).

## Stocks, KO, timer
- Each fighter has `settings.stocks` lives (drawn as hearts). Leaving the **blast zone** costs a
  stock → **KO blast** → respawn (with brief invuln), or elimination if it was the last stock.
- **KO blast (Smash-style flame-jet):** the blast is anchored **at the blast border the fighter
  crosses** (`Fighter._ko` clamps the position to the `blast` bounds, not the stage edge, so it
  originates from the boundary) and a doodle **flame plume spurts back across the stage, opposite
  the launch direction** (`atan2(vy,vx) + π` — the comet-tail look) (`Effects.koBeam`): a wide fan of flickering tongues (outer accent → hot → white-hot core, each
  narrow at the nozzle and flaring to a licking tip), plus expanding shockwave **rings**, a triple
  flash bloom, ~46 streaking sparks + lingering embers, and a hard shake — on top of the burst star
  (`koBurst`). Power scales with launch speed; `_ko` captures the velocity before zeroing it.
- The blast zone is large — `settings.blast` is ~1100px of margin around the 1920×1080 stage — so
  fighters fly well off the page before dying, and the **dynamic camera zooms out to follow them**
  (see `07`). `blast` is derived from the view and not user-editable, so `mergeDefaults` always uses
  the current defaults for it.
- Match ends when one fighter is eliminated, or the **timer** hits 0 (then winner = most stocks,
  tie-break least damage). `timerSeconds: 0` = no timer.

## Global tuning (`settings`, editable in the Settings tab)
`gravity`, `timerSeconds`, `stocks`, `knockbackScale`, `hitstop`, and the `blast` margins.
Design tip baked into the editor: *lower gravity + higher knockback = floatier, more dramatic
launches.*

## Feel philosophy
Responsive and fair: zero-startup, no-commitment jab, generous double jump + air-dash for
recovery, hitstop + shake to make contact feel chunky, and percent-based knockback so comebacks and
edge-guards matter. Keep new mechanics legible at the doodle scale.
