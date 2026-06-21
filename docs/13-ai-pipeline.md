# 13 — AI Pipeline (CAELLUM · CHLOE · JEREMY): Runtime Execution Blueprint

> The plan for turning a player's rough iPad sketch into a polished, **functional**, live
> game entity. Grounded in a cited research sweep (see "Sources" at the end) and verified
> against the actual engine seams. This doc is the runtime (latency-focused) tier; the
> pre-match "level design" tier is sketched at the end.

---

## 0. The two tiers (don't confuse them)

| Tier | When | Latency | Models | Owner |
|---|---|---|---|---|
| **Runtime** (this doc) | mid-match, live | hard real-time, 60fps must never block | few-step distilled diffusion + bounded code-spec LLM | the part **you** build |
| **Pre-match "level design"** | before the match | seconds, latency-tolerant | strong models (Claude, FLUX.2, Sai agent) | separate; §10 |

The runtime tier's job: **draw → playable in <100ms → functional in ~1–2s**, on a 60fps projector
canvas, using AWS Neuron (not CUDA) for the visual model.

---

## 1. Three corrections to the original plan (read first)

The research changed four load-bearing assumptions. The blueprint is built on the corrected versions.

1. **StreamDiffusion will NOT run on Trainium.** It is welded to CUDA + TensorRT + xformers; there
   is no Neuron backend and no CPU path. Its 90+ FPS numbers are RTX-4090-only. → **Do not port it.**
   Replicate only its *idea* (1-step turbo / few-step LCM img2img) via `optimum-neuron`, which ships
   the few-step core natively. Keep real StreamDiffusion as a Tier-3 bonus *only if* an NVIDIA GPU is
   physically at the venue.
2. **Diffusion on Neuron is ~150–400ms per image, not <100ms.** The sub-100ms target is delivered by
   the **instant pure-JS geometry drop-in**, and diffusion is a best-effort **pop-in** on top. This
   is exactly why progressive enhancement is the right design — it was already correct, now it's
   load-bearing.
3. **Training a diffusion (UNet) LoRA on Trainium is NOT officially supported.** `optimum-neuron`
   training tutorials are **LLM-only** (Llama/Qwen SFT-LoRA via `NeuronSFTTrainer`). → If you want a
   custom charcoal style, **train the diffusion LoRA on a borrowed CUDA GPU and *fuse* it at Neuron
   compile time** — or skip it and get the look from ControlNet + a monochrome prompt. **Use Trainium
   for *compile + inference*, not diffusion training.** (See §9 for the legit "trained on Trainium"
   story.)
4. **Don't run CHLOE on Trainium.** The constrained-decoding stacks (XGrammar/Outlines) that make
   "guaranteed-valid spec" work are CUDA/vLLM-only; grammar-masking on Neuron is unproven. → CHLOE is
   a **hosted-API** call (Cerebras/Groq/Claude), off the accelerator entirely.

---

## 2. The architecture in one diagram

```
                              JEREMY (existing ws relay + Redis bus)
  iPad (draw)  ──{t:sketch}──►  server.js  ──XADD jobs:enhance──►  ┌─ CAELLUM worker (inf2/trn, Neuron)
   strokes {pts}                  │  ▲                              │   SDXL-Turbo 1-step + scribble
                                  │  │                              │   ControlNet, img2img strength .3
                                  │  └──XADD jobs:mechanic──────────┼─ CHLOE worker (hosted LLM)
                                  │                                 │   strict-JSON mechanic spec
        host browser (window.DS)  ▼                                 │
  ┌───────────────────────────────────────────┐   results:<lobby>  │
  │ DS.AI (NEW js/ai.js)                        │ ◄──Pub/Sub + WS────┘
  │  • PRE-pass: clean/resample/symmetry  <10ms │   {t:asset, strokes} / {t:mechanic, spec}
  │  • inject v0 strokes -> playable NOW         │
  │  • POST-pass: skeleton-tracing-wasm vectorize│
  │  • swap enhanced strokes in place (same id)  │
  │  • attach CHLOE spec as a component          │
  └───────────────────────────────────────────┘
            │ writes                       │ writes
   ch.skin.parts[*].strokes  OR   DS.Prop (NEW): {strokes, aabb, mechanic}
            │                                   │ on fire:
   DS.draw.strokePts (charcoal, jitter .35)     world.spawnProjectile(holder, cfg, aim)  ← js/game.js:77
```

**The whole point:** the engine renders **vector strokes** and runs **data-driven mechanics**. CAELLUM
outputs strokes; CHLOE outputs a data spec. Neither bypasses the engine's existing, verified seams.

---

## 3. The north-star demo, step by step

Two players fighting; a third draws a gun on the iPad.

| t | What happens | Where |
|---|---|---|
| 0ms | iPad finishes a stroke; sends `{t:'sketch', jobId, slot, strokes}` | controller → relay |
| ~5ms | **PRE-pass** cleans the strokes (resample, RDP-simplify, symmetry, close gaps) | `DS.AI.prePass()` |
| **<10ms** | A `DS.Prop` (gun) drops onto the stage as a **playable, pick-up-able object** with a placeholder mechanic | `DS.Prop` + host |
| ~10ms | Relay `XADD`s the job to `jobs:enhance` **and** `jobs:mechanic` | server.js + Redis |
| ~150–400ms | CAELLUM returns an enhanced 512² raster → **POST-pass** vectorizes (centerline) → host **swaps the prop's strokes in place** (same id, rig intact) | CAELLUM + `DS.AI.postPass()` |
| ~1–2s | CHLOE returns `{node:"projectile_weapon", params:{...}}` → host attaches it as the prop's `mechanic` component | CHLOE + `DS.Prop` |
| later | A player walks over the gun, **picks it up**, presses attack → `world.spawnProjectile(holder, cfg, aim)` → shoots the opponent | existing engine |

The gun is **playable before it's pretty, and pretty before it's functional** — and nothing ever
blocks the frame loop.

---

## 4. New files & seams to establish

```
docs/13-ai-pipeline.md          ← this file
js/ai.js                        ← NEW  DS.AI: pre-pass, WS plumbing, post-pass (vectorize), inject/swap
js/prop.js                      ← NEW  DS.Prop: drawn entity (strokes + AABB hitbox + mechanic component)
js/mechanics.js                 ← NEW  DS.Mechanics: the bounded node library + JSON Schema (shared w/ CHLOE)
js/net.js                       ← EXTEND: handle {t:sketch|asset|mechanic}; apply between frames
server.js                       ← EXTEND: AI job message types; Redis Streams bus (or in-process fallback)
vendor/skeleton-tracing.js      ← NEW (vendored, no-build): LingDong centerline vectorizer for the post-pass

services/caellum/               ← NEW Python microservice (runs on inf2/trn)
  compile.py                    ←   optimum-cli export neuron … (run ONCE, cache the .neuron artifact)
  serve.py                      ←   warm pipeline + Redis consumer group `caellum` (XREADGROUP/XACK)
  requirements.txt
services/chloe/                 ← NEW microservice (Node or Python, hosted LLM)
  serve.js                      ←   Redis consumer group `chloe`; strict-JSON spec; ajv validate + clamp
  schema.json                   ←   the mechanic-spec JSON Schema (mirror of js/mechanics.js)
```

**Engine constraints to honor** (from `docs/01`/`02`): no build step — `js/ai.js`/`js/prop.js`/
`js/mechanics.js` attach to `window.DS` and load as plain `<script>` in order; vendor
skeleton-tracing as a UMD `<script>`. Everything in-game stays **vector strokes**, **monochrome ink**.

### Wire protocol (JSON over `/ws`, additive — existing messages unchanged)

```
controller/host → relay : {t:'sketch',   jobId, slot, strokes:[{pts:[[x,y]…], w}], hint?:'gun'}
relay → host (instant)  : {t:'sketch-ack', jobId}                 (host injects PRE-pass v0 now)
relay → host (CAELLUM)  : {t:'asset',     jobId, strokes:[{pts,w}]}   (host swaps strokes in place)
relay → host (CHLOE)    : {t:'mechanic',  jobId, spec:{node, params}} (host attaches component)
```

`DS.Net` already processes WS messages **between frames** (latches never lost) — apply `asset`/
`mechanic` the same way: stage them, mutate entity data at the next safe frame boundary, by `jobId`.

---

## 5. CAELLUM — visual enhance (the Neuron half)

**Model:** `stabilityai/sdxl-turbo`, **1 step**, `guidance_scale=0`, **+ scribble/lineart ControlNet**,
img2img **strength ~0.3**, **bf16**, fixed **512×512** (drop to **256²** to cut latency). Serve on
**inf2.xlarge** (cheaper, inference-tuned) — reserve `trn` for any training.

**Why this combo:** ControlNet = *where* lines may go (locks the player's geometry so it can't
hallucinate a new gun); low img2img strength = *how much* gets repainted. Together = "preserve shape,
add minimal lines." Monochrome comes from the prompt (`"charcoal marker line drawing, black ink on
white paper, minimal"` / negative `"color, shading, photo"`).

**Compile (do this FIRST — it's the long pole):**
```bash
optimum-cli export neuron \
  --model stabilityai/sdxl-turbo \
  --controlnet_ids lllyasviel/sd-controlnet-scribble \
  --batch_size 1 --height 512 --width 512 \
  --num_images_per_prompt 1 \
  --auto_cast matmul --auto_cast_type bf16 \
  caellum_neuron/
# env: NEURON_FUSE_SOFTMAX=1
```
- **Static shapes**: batch/H/W are frozen at compile. **Lock one size; any change = full recompile.**
- **Cold start** ~45–60s; compile is minutes (SDXL needs a big-RAM/inf2.8xlarge box) → **pre-warm**
  with a dummy inference at boot, and **snapshot the `caellum_neuron/` artifact to S3** so inference
  survives after the Trainium workshop window closes.
- **Known trap:** `SDXL + ControlNet` has a `neuronx-cc` segfault on Amazon Linux 2 (aws-neuron-sdk
  #1002). **Use the HF Neuron DLAMI / Ubuntu and pin the optimum-neuron known-good versions.** If it
  fights you, fall back to **SD1.5 + ControlNet** (well-trodden) or **SD1.5 + LCM 4-step**.

**Post-pass — vectorize back to strokes (CPU, on the host, ~2–5ms):**
Use **centerline tracing**, NOT contour tracing. potrace/VTracer/ImageTracer trace *both* edges and
double-line every stroke. Use **LingDong `skeleton-tracing`** (Zhang-Suen thinning → polylines, ~2ms
in JS, pure CPU, browser+Node):
1. threshold the raster to a binary mask (Otsu),
2. `TraceSkeleton.fromImageData(img)` → `{polylines}` (each polyline = one stroke's `pts`),
3. 2-pass Euclidean distance transform → per-stroke `w = 2 × median(distance)`,
4. RDP-simplify + spur-prune, map raster→part-local coords (subtract `DS.skin.PIVOTS[part]`),
5. push `{pts, w}` into `ch.skin.parts[part].strokes` (use `DS.skin.assign(ptsLocal)` to bucket) or
   the `DS.Prop`'s strokes. `DS.draw.strokePts` then applies charcoal jitter/double-pass for free.

**Latency budget (realistic):** instant vector drop `<10ms` → Neuron enhance `~150–400ms` → vectorize
`~2–5ms` → WS push `<2ms`. **Progressive enhancement hides the gap.**

---

## 6. CHLOE — mechanic injection (the bounded-library half)

**Decision: CHLOE emits a validated JSON *spec*, never free JavaScript.** There is no sandbox to
escape because no arbitrary code runs. This is what 2025 game-LLM research converged on (a JSON DSL
over a prefab whitelist), and it maps **1:1** onto the engine's existing data-driven mechanics.

**The node library (`js/mechanics.js`)** — ~5–8 trusted atoms, each reusing a verified `world` factory:

| node | params (clamped) | engine call (verified) |
|---|---|---|
| `projectile_weapon` | `speed,damage,kbBase,kbScale,angle,gravity,life,r,cooldown` | `world.spawnProjectile(holder,cfg,aim)` — `js/game.js:77` |
| `melee_weapon` | `reach,damage,kbBase,kbScale,angle` | `world.damageBox` / hit-loop — `js/game.js:76` |
| `boomerang` | `speed,damage,r,…` | `world.spawnBoomerang(holder,cfg,aim)` — `js/game.js:101` |
| `hazard` | `damage,radius,dps` | spike-ball / area effect on a `DS.Prop` |
| `pickup` | `grantsNode` | held-item swap |

`projectile_weapon.params` **is** the engine's existing `projectile:{…}` shape — so a gun's spec drops
straight in with **zero parser**.

**Generation:**
- **Primary:** Cerebras or Groq `gpt-oss-120b` with **strict JSON-Schema constrained decoding**
  (invalid output impossible; ~<1s for a 150–300-token spec). Groq caveat: use `response_format`, not
  tool-calling (it disables structured-output + tools together).
- **De-risked fallback:** **Claude Haiku 4.5** with forced tool use (`tool_choice` →
  `define_mechanic`, `strict:true`, `additionalProperties:false`) — schema-guaranteed, ~0.7s TTFT,
  one vendor, works day one. (Anthropic is a sponsor: $5k credits.)
- **Always:** validate with `ajv` against `schema.json`, then **clamp every numeric param server-side**
  (`damage≤N`, `speed≤M`, `cooldown≥K`). Schema-valid ≠ safe — clamp to stop game-breaking values.

CHLOE runs **off the canvas thread** (1–2s is fine). The prop is pickup-able *before* CHLOE answers
(placeholder mechanic), so a slow/failed CHLOE never blocks the demo — it upgrades the placeholder.

---

## 7. JEREMY — sync (keep what works, add a bus)

- **Transport: keep the existing `ws` relay.** On a projector LAN, WS RTT ≈ 200µs vs a 16.67ms frame —
  indistinguishable from the network floor. **Do not adopt WebTransport** (only experimental Node
  servers, HTTP/3 infra, ~10ms gain on lossy WANs you don't have) **or WebRTC** (P2P signaling/TURN
  cost for a benefit a host-authoritative design can't use).
- **Redis (sponsor: Mac Minis + 25k credits) earns its place ONLY as the relay↔AI-worker bus** — not
  on the player hot path. One **Redis Streams** `jobs` stream; two **consumer groups** (`caellum`
  ~100ms, `chloe` ~1–2s) read the same jobs, fail independently, and `XAUTOCLAIM` recovers a crashed
  worker. Results fan out via **Pub/Sub → host WS** by `jobId`. Adds ~1–2ms on dispatch.
  - **Bonus use:** a **sketch-hash → result** cache in Redis means a repeated doodle skips diffusion
    entirely; also CHLOE's node-memory store.
- **If short on time, skip Redis:** do the dispatch **in-process** in the relay (`fetch` the workers,
  push results on the same WS). Same `{t:sketch}`→`{t:asset}` protocol, zero new infra. Redis is a
  later durability/multi-worker upgrade, not a demo dependency.
- **Framing:** JSON is fine. `msgpackr` (~½ the bytes, pure-JS, no build step) is pure upside for the
  stroke payloads if you have a spare commit — optional polish at 6 players.
- **Authority:** all AI output lands on the **authoritative host** and is broadcast from there. A phone
  never injects entities/mechanics directly (security boundary). Apply between frames (the net.js
  pattern); correlate by `jobId`; in-place swap so rig binding + attached mechanics survive.

---

## 8. Time-boxed execution order (the chronological plan)

**The Trainium window is the binding constraint.** Front-load the compile; everything else can be
built with zero GPU. Run these tracks in parallel.

**Hour 0 — START THE COMPILE (blocks nothing else):**
- Launch inf2.8xlarge (or the workshop env); install Neuron SDK + torch-neuronx + optimum-neuron.
- **Use Simular Sai** (sponsor, computer-use agent) to babysit the brittle env setup + the slow AOT
  `optimum-cli export neuron` compile. Pair with **Claude Code** (sponsor office hours) to write it,
  Sai to run/verify it on the live box.
- Lock **one shape (512²)**. Kick the compile, then walk away — it's minutes-to-45min.

**Track A — Spine + Tier-1 safety net (no GPU, do immediately):**
1. `js/prop.js` — `DS.Prop`: strokes + AABB hitbox + optional `mechanic`; pickup + fire wiring to
   `world.spawnProjectile`.
2. `js/ai.js` `prePass()` — the pure-JS geometry "beautify" (resample, RDP, symmetry-snap, thicken).
3. `js/net.js` + `server.js` — `{t:sketch}` → inject PRE-pass v0 prop (in-process, no Redis yet).
4. **Milestone:** draw on iPad → a cleaned, playable prop drops in **with zero AI**. *This is the demo's
   floor — it cannot fail.*

**Track B — CAELLUM (once the artifact compiles):**
5. `services/caellum/serve.py` — load `caellum_neuron/`, **pre-warm**, expose enhance (Redis consumer
   or HTTP). **Benchmark real latency**; tune strength/conditioning/resolution.
6. `vendor/skeleton-tracing.js` + `js/ai.js` `postPass()` — vectorize + in-place stroke swap.
7. **Milestone:** the rough prop visibly **levels up** ~200ms after it drops.

**Track C — CHLOE:**
8. `js/mechanics.js` + `services/chloe/` — strict-JSON spec → ajv → clamp → attach component.
9. **Milestone:** pick up the gun, **shoot** the opponent.

**Track D — JEREMY hardening (if time):** Redis Streams bus, sketch-hash cache, msgpackr, projector
broadcast.

**Before you leave the Trainium window:** `aws s3 cp caellum_neuron/ s3://… --recursive` so inference
runs after the workshop closes.

---

## 9. The "trained on Trainium" story (corrected & legit)

The hackathon track is *PyTorch on Trainium with Neuron* — so you want a real **training** deliverable,
but **diffusion UNet LoRA training on Trainium is unsupported**. The clean, *supported* win:

- **Train CHLOE's spec model on Trainium.** Fine-tune a small **Qwen/Llama** with `NeuronSFTTrainer`
  (LoRA) on synthetic `(sketch description → mechanic-spec JSON)` pairs. This is exactly what the
  workshop supports, gives you a genuine "trained on Trainium" artifact, and produces CHLOE's model.
  (The closed-weight diffusion-LLM "Mercury" can't be trained/run on Neuron — use an open model.)
- **If you want a custom charcoal *visual* style:** train the diffusion LoRA on a **borrowed CUDA GPU**
  (Colab / sponsor RunPod), then **fuse it at Neuron compile time** (`inline_weights_to_neff=True`).
  For the hackathon, you likely don't need it — ControlNet + the monochrome prompt already nails the
  look, and the engine adds the charcoal jitter for free.
- **Synthetic dataset:** generate `(rough doodle → clean line-art)` and the spec pairs by **degrading
  clean examples** (jitter/drop points) — cheap, and Sai can mass-produce them by driving
  `controller.html`'s draw tool.

---

## 10. Pre-match "level design" tier (latency-tolerant, separate)

Before a match, a **stronger model** (Claude via the $5k credits, or **Sai** as an autonomous agent)
takes a natural-language brief and emits **plain data the engine already consumes**:
- platform layout → `data.stage.platforms` rectangles (the freehand "draw a platform" precedent in
  `js/editor.js:_finishPlatStroke` proves stroke→entity works),
- runtime rules (draw weapons? props? what's allowed),
- character roster + the CHLOE node selections in play.
No latency pressure, no Neuron — just JSON into the existing `Store.data`.

---

## 11. Risk register → cheapest retirement

| # | Risk | Retire it by |
|---|---|---|
| 1 | "<100ms diffusion" is a myth on Neuron (it's 150–400ms) | **Design:** instant <10ms pure-JS vector drop delivers the UX; diffusion is best-effort pop-in. Build Tier-1 FIRST. |
| 2 | Trainium 10h time-box + 45min compiles + cold start | Compile FIRST, lock ONE shape, pre-warm, **snapshot artifact to S3**, serve on inf2. Let Sai run it. |
| 3 | SDXL+ControlNet `neuronx-cc` segfault (#1002) | Pin known-good versions, use HF Neuron DLAMI not AL2; fall back to SD1.5+ControlNet / SD1.5+LCM. |
| 4 | Raster→vector double-lines & clashes with charcoal | Centerline `skeleton-tracing` + RDP, never potrace for strokes. |
| 5 | CHLOE spec-gaming / scope creep to free code | Closed enum node library + numeric clamps + ajv. Expand by adding atoms, never by opening a sandbox. |
| 6 | Hosted-API outage/rate-limit mid-demo (CHLOE) | Pre-provision keys, 1.5s timeout → drop to a preset mechanic so the prop is still pickup-able. |

**Fallback ladder (every rung is demoable):**
- **Visual:** SDXL-Turbo+ControlNet on Neuron → SD1.5+LCM on Neuron → same on a CUDA box → **Tier-1
  pure-JS geometric beautify (zero GPU, guaranteed)**.
- **Mechanics:** constrained-decode LLM → Claude Haiku forced tool use → **client-side heuristic
  sketch→preset mapper (zero model)**.
- **Sync:** Redis Streams bus → in-process `fetch` from relay → **plain JSON over the WS you already
  shipped**.

---

## 12. Sponsor leverage (Berkeley AI Hackathon 2026)

| Sponsor | Use | Prize-eligible |
|---|---|---|
| **Annapurna Labs** (Trainium/Inferentia) | CAELLUM compile + inference; CHLOE-model SFT-LoRA training | ✓ core track |
| **Anthropic** ($5k credits, Claude Code office hours) | CHLOE fallback (Haiku 4.5 forced tool use); pre-match level design; pair-with-Claude-Code for Neuron setup | ✓ |
| **Simular (Sai / Agent S3 / SimuLang)** | Automate the brittle Neuron env + AOT compile; generate synthetic training pairs; pre-match level-design agent | ✓ creative-use prize |
| **Redis** (Mac Minis + 25k credits) | AI job bus (Streams); sketch-hash result cache; CHLOE node memory | ✓ |
| Deepgram / Browserbase / others | optional bonus (e.g. voice "draw a gun" via Deepgram) | — |

---

## Sources (load-bearing)

- StreamDiffusion is CUDA/TensorRT-only: github.com/cumulo-autumn/StreamDiffusion ; arXiv 2312.12491
- optimum-neuron diffusion + ControlNet + SDXL-Turbo + LCM (Neuron-native few-step core):
  huggingface.co/docs/optimum-neuron/.../diffusers/{stable_diffusion,sdxl_turbo,controlnet,lora}
- Neuron static shapes + compile + latency: philschmid.de/inferentia2-stable-diffusion-xl ;
  AWS Inferentia2 SD perf blog
- SDXL+ControlNet Neuron segfault: github.com/aws-neuron/aws-neuron-sdk/issues/1002
- Centerline vectorizer: github.com/LingDong-/skeleton-tracing ; potrace has no centerline
  (sourceforge potrace thread)
- Bounded JSON DSL over prefab whitelist (not free code): arXiv 2510.16952 ; QuickJS-WASM
  (quickjs-emscripten) ; vm2 deprecated/unsafe
- Constrained decoding / fast spec gen: Cerebras & Groq structured-outputs docs ; XGrammar ;
  Claude Haiku 4.5 (artificialanalysis.ai) ; Inception Mercury 2
- Sync: newbe.dev WS-LAN latency ; Redis Streams job-queue tutorial ; msgpackr benchmarks ;
  gabrielgambetta client-prediction/reconciliation
- Sponsors + Sai: ai-hackathon-2026.devpost.com ; simular.ai/sai ; github.com/simular-ai/agent-s
