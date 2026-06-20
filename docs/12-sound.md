# 12 — Sound design (procedural audio)

Every sound effect is **synthesised at runtime** with the Web Audio API — there are no audio
files. This keeps the project no-build and `file://`-friendly, carries no licensing baggage, stays
loudness-consistent, and lets each cue fire on the *exact* game frame (the same call sites as the
visual juice in `effects.js`), so audio always matches the tuned timing.

Sonic identity: hand-drawn **charcoal-on-paper**. Sounds are soft and "papery/inky" — filtered-noise
swishes (pencil strokes), round triangle/sine blips, woody ticks, and muffled thumps — never harsh
digital tones.

## Engine — `js/audio.js` (`DS.Audio`)
- **Lazy + gesture-unlocked.** The `AudioContext` and graph are built on the first user gesture
  (browsers block audio until then). `play()` is silent until the context is `running`, so headless
  loads and the pre-click menu make no noise and throw nothing.
- **Master chain:** `master gain (0.6) → DynamicsCompressor (soft limiter) → gentle low-pass → out`.
  The limiter keeps a 6-player pile-up from clipping. Two synthesised **convolution reverbs** are
  available as per-cue *sends*: a short room (`send`, used sparingly on KO/ults/big hits) and a long,
  soft **aura** reverb (`send2`, ~2 s) reserved for the marquee `ult_hit` so it blooms and rings out
  without smearing fast combat.
- **Primitives:** `_tone` (oscillator + AD envelope, optional glide/vibrato) and `_noiseHit`
  (filtered noise burst). Cues are built by layering these.
- **Discipline:** per-cue **throttle** (frequent cues like jabs/landings can't machine-gun), a
  **polyphony cap** (`MAXVOICES`), pitch **jitter** so repeats vary, and camera-aware **stereo pan**
  (`_pan(x)` places a sound where the fighter is, relative to the live camera).
- **Control:** mute toggle on the **M** key and the topbar **🔊** button (persisted to
  localStorage). `setVolume()` exists for future UI.

## What makes sound (and where it's hooked)
Hooked at the precise code sites so timing tracks the frame data:
- **Swings/casts** — `Fighter._startAction`: per-move whoosh (`swing_jab`/`swing_punch`/
  `swing_hammer`/`swing_claw`/`swing_wolf`); ranged moves with real wind-up play a rising
  `charge_up` sized to the move's `startup`, so the **shot** lands on its own active frame.
- **Impacts** — `Fighter._takeHit`: `hit_light`/`hit_heavy` (chosen by knockback power, which also
  scales loudness), `block` on a shielded hit; `ult_hit` on an ultimate connect.
- **Movement** — `jump` (ground/air variants), `dash`, `land` (only a real fall, scaled by impact
  speed), `spike` on a hammer-slam landing, `ledge`, `drop`, `shield` (rising edge).
- **KO & ultimates** — `ko` (blast), `charge_ready` when an ultimate fills, and per-type activation
  stingers `ult_hammer`/`ult_sniper`/`ult_wolf`.
- **Projectiles** — `game.js` spawn closures: `shot` (pitch/weight by speed — basic spark vs the
  heavier supershot), `sniper_shot`, `boomerang`; plus `box_break`/`box_hit` on breakables and a
  soft `fizzle` when a shot dies on a wall.
- **Modes** — `gem_spawn`/`gem_pickup` (Gem Grab), `score` (a new King takes the hill / a K.O. Rush
  point), and a single `win` stinger when any mode ends a match (announced once in `Game.update`).
- **Flow & UI** — countdown `count` ticks rising to a `go`, `join` as each fighter card reveals,
  `ready`, `ui_move`/`ui_confirm`/`ui_back` on menu/lobby interactions, and a faint `draw` scratch
  per stroke on the draw pad.

Sound is **host-only** — the phone controllers stay silent (audio belongs on the shared screen).

## Adding a cue
1. Add a recipe to the `CUES` map in `audio.js` (compose `_tone`/`_noiseHit`; set a sensible gain
   and an optional reverb `send`). Add a `THROTTLE` entry if it can fire rapidly.
2. Call `DS.Audio && DS.Audio.play('name', { x })` at the event site (guarded, pass `x` for pan).

## Levels / verification
Incidental movement (jump, dash) is mixed low so it stays out of the way; the **impacts** are the
stars — `hit_heavy`, `hit_proj` (projectile connects), `spike` (hammer slam) and `ult_hit` are each
layered for punch: a high crack transient + a pitch-dropping sub-thump + a gritty mid body + a short
room tail, scaled by knockback power. Projectile and hammer hits are routed to the meaty cues in
`_takeHit` (a hit carrying a `speed` is ranged → `hit_proj`; a `meteor` slam → `hit_heavy`).

Tested headless (Playwright, `--autoplay-policy=no-user-gesture-required`): every cue fires through
real game code paths with no errors, mute zeroes the master, and a worst-case barrage of the loudest
layered impacts (6× overlapping `spike`/`hit_heavy`/`hit_proj`/`ult_hit`/`ko`) peaks at **~0.76**
post-limiter — punchy but still below clipping, while individual hits land hard.
