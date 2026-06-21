# 08 — Roadmap & Future Directions

## The direction
The headline is the **live AI creation pipeline**: players draw on an iPad and the game injects
**refined, functional** entities into a projected match in real time. Two engines do the work and the
network ties them together — full design in **`13-ai-pipeline.md`**:
- **CAELLUM** — real-time *visual enhancement* (rough sketch → polished doodle, <100ms felt latency).
- **CHLOE** — real-time *mechanic injection* (a drawn gun becomes a working weapon via a bounded,
  data-driven "node library" — no `eval`).
- **JEREMY** — the WebSocket relay + Redis bus that fans sketches out to the AI services and results
  back to the projector display.

Alongside it, the **pre-match level editor** grows into an **agentic authoring tool**: multiple
agents + sponsor-track tech + a trained model take a natural-language brief and emit the same plain
data the editor already writes (`data.stage.platforms`, rosters, runtime rules like "weapons may be
drawn this round", CHLOE node choices). It's latency-tolerant, so it can use stronger models.

## Creative frontier — after the core pipeline
The "make whatever you want and put it in" feel. These extend the existing seams; tackle them **after**
the CAELLUM/CHLOE/trained-model work lands. Each notes the cutting-edge tech and the sponsor that fits.

**Near — amplify the existing pipeline:**
- **Draw-your-own projectile / attack.** The special fires *the thing you drew*; CHLOE infers its
  props. (Extends `world.spawnProjectile`.)
- **Material / physics inference.** A drawn balloon floats, an anvil is heavy, a spring bounces — a
  VLM maps appearance → stats (`weight`, `gravityScale`, bounce). "It behaves like it looks."
- **Voice + sketch (multimodal creation).** Speak intent while drawing ("a bouncy slime that splits
  when hit"); speech-to-text feeds *both* CAELLUM's prompt and CHLOE's spec. *(Deepgram)*
- **Creation gallery / "doodle-dex".** Every creation is shareable (QR) and queues into the arena;
  spectators draw between rounds. *(Redis — store + sketch-hash cache so repeats skip diffusion.)*

**Mid — new modalities & rigging:**
- **Universal auto-rig for non-humanoid drawings.** Infer a skeleton from arbitrary stroke topology
  (snake, car, blob) so *any* creature animates, not just the humanoid rig. (Learned auto-rigging /
  skeleton extraction.)
- **Draw-the-motion.** Draw a path or gesture → the entity's movement pattern (a loop = orbiting
  hazard, a zigzag = erratic mover). Sketch-to-*behavior*, not just sketch-to-look.
- **Multi-keyframe animation.** Draw 2–3 poses → AI in-betweens them into a custom attack animation.
  (Frame interpolation / video diffusion — *Pika*.)
- **Live stage re-skin.** "Make it a haunted castle" re-themes the arena via the same diffusion path
  applied to background/decor. *(Midjourney for the high-fidelity, latency-tolerant pre-match tier.)*

**Far — agentic & emergent:**
- **Emergent interaction rules.** Entities carry tags; an agent proposes reactions (fire+ice→steam,
  bomb+fan→blown around) — true sandbox "chemistry" between whatever players draw.
- **AI director.** An agent watches the match and spawns hazards / rule-changes to keep it exciting,
  or generates a whole mode from one line ("lava rises every 10s"). The beefed-up editor, at runtime.
  *(Fetch AI / Cognition / Simular Sai for the agent layer.)*
- **Crowd evolution.** Phones vote on CAELLUM variants; an evolutionary loop breeds the crowd favorite.
- **Sketch depth / parallax.** Depth estimation on a doodle → a subtle pseudo-3D pop on the projector.
- **Summon-by-description (no drawing).** Type or say "a dragon" → the text-to-image path generates it
  for the pre-match editor.

**Reliability / observability (do alongside, sponsor-aligned):**
- *Arize* — eval and monitor CAELLUM & CHLOE output quality + latency. *Sentry* — error tracking on the
  live microservices. *Browserbase / Cognition* — agentic tooling to auto-generate and test maps/mechanics.

## Gameplay / content backlog (still valid)
- **Character select** so both players choose from the full roster (only `roster[0/1]` are wired now).
- **"＋ new character"** button so users add roster slots instead of reskinning Sprout/Acorn.
- More moves: directional/aerial attacks, a grab/throw, chargeable special.
- Smarter/optional CPU opponent (current AI is attract-mode only, in `Game._ai`).
- Per-character distinct projectiles / stats presets.

## Known limitations (and the why)
- **Limbs are single pieces** (no elbow/knee bend) — simpler rig, reads fine for doodles. Adding 2-
  segment drawn limbs would mean splitting each arm/leg part and a second joint angle.
- **2 fighters only** in a match by default (engine spawns `roster[0]`/`[1]`; phones scale it to N —
  see `11`). Multi-fighter still needs HUD + spawn polish.
- **No pose-caching in play** yet (direct render); fine for a few fighters, revisit for many drawn
  entities/overlays at once.
- **Storage migration is coarse** (key bump wipes saves; in-place migrations are ad hoc in
  `mergeDefaults`). Fine for an early project; formalize if it grows.

## Optional, far-future: real-world CV/AR
A computer-vision module *could* detect real-world flat surfaces from a camera and produce
`data.stage.platforms`, compositing the game over a video feed — and the architecture keeps that seam
clean (stage geometry is data; rendering is isolated behind `js/draw.js`). But this is now an
**optional, far-future nicety, not the project's goal** (the creation pipeline is). If ever built:
webcam via `getUserMedia` → detect rects (MediaPipe / TensorFlow.js / OpenCV.js) → map to view-space
platforms → composite the transparent game canvas over the video → stabilize (smoothing/hysteresis).
Keep it behind the same seam the editor and AI pipeline write to.

## Guardrails when extending
- Don't break the **aesthetic** (`02`) or the **rig-is-constant** principle (`01`/`04`).
- Keep new tunables **in `data.js` and editable** (`05`).
- AI-generated content must land on the **authoritative host** and flow through existing data seams —
  **never `eval` model output** (see `13` for CHLOE's bounded node library).
- Verify visually with the **dev URL hooks + on-page banner** (`09`) — there's no console in normal runs.
