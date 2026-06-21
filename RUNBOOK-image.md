# RUNBOOK — CAELLUM image enhancement (operator step-by-step)

> The human/operator (Sai or a person) runs these steps to stand up the **visual enhancement
> engine**: rough iPad scribble → polished, game-ready RGBA sprite. This is the runtime visual
> half of the AI pipeline. The design and rationale live in
> [`docs/13-ai-pipeline.md`](docs/13-ai-pipeline.md); the implementation contract is
> [`services/caellum/IMPLEMENTATION-SPEC.md`](services/caellum/IMPLEMENTATION-SPEC.md); constants
> are in [`services/caellum/config.py`](services/caellum/config.py).

**Mental model:** *playable before it's pretty.* The game already drops a cleaned, playable prop in
`<10ms` with zero GPU (pure-JS geometry). CAELLUM is the best-effort **pop-in** that makes it
*pretty* ~2–3s later. Nothing here blocks the frame loop, and every rung of the fallback ladder
(§8) is still demoable.

---

## 0. The two environments — what runs where

There are **two separate machines** with **separate Python envs**. Do not install one's deps on the
other.

| Env | What it is | What it runs | Key trait |
|---|---|---|---|
| **Neuron box** | AWS workshop Code Editor / **inf2** instance | `services/caellum/compile.py`, `services/caellum/serve.py` | Has the Neuron SDK (torch-neuronx, neuronx-cc). **No CUDA.** Has this repo, so scripts `import config`. |
| **Colab/Kaggle GPU** | a free **CUDA** notebook box | `data/gen_teacher.py`, `data/roughen.py`, `train/train_caellum_ip2p.py` (or `_lora.py`) | Standard `diffusers` + CUDA torch. Does **not** have this repo → those scripts are self-contained (inline `CATEGORIES`/`SHAPE`/`STYLE`). |

The two halves meet at **two artifacts**:
- The Colab side produces a **LoRA / checkpoint** (download it).
- The Neuron side produces `caellum_neuron/` (the compiled `.neuron` pipeline) and serves it.

The order below is written so the two long poles — **the Neuron compile** and **the Colab
dataset** — start as early as possible and run **in parallel**. See the suggested time order at the
end (§"Suggested time order").

---

## 1. Neuron box setup

On the AWS workshop / inf2 instance, from the repo:

```bash
cd services/caellum
bash setup_neuron.sh
```

`setup_neuron.sh` pip-installs `optimum-neuron`, `diffusers`, `controlnet-aux`, `rembg`, `fastapi`,
and `uvicorn` on top of the workshop's Neuron SDK, echoes the installed versions, and exports
`NEURON_FUSE_SOFTMAX=1` (required for the diffusion compile). Pinned versions are in
`requirements-neuron.txt`.

> **Box choice matters.** SDXL compile needs a big-RAM box (~120GB; inf2.8xlarge or larger).
> SD1.5 is lighter (~35GB). **Prefer the HF Neuron DLAMI / Ubuntu over Amazon Linux 2** — AL2 is
> where the SDXL+ControlNet segfault bites (see step 2).

Sanity check after setup:
```bash
python -c "import optimum.neuron, diffusers, rembg, fastapi; print('caellum deps OK')"
echo "NEURON_FUSE_SOFTMAX=$NEURON_FUSE_SOFTMAX"   # expect 1
```

---

## 2. Compile the model (the long pole — start this FIRST)

Compilation is **AOT** and **slow** (minutes to ~45min) with **static shapes baked in** (512×512,
batch 1 — frozen forever; any change is a full recompile). Output goes to `caellum_neuron/`.

**Always compile the SD1.5 floor first** — it's the guaranteed, well-trodden Neuron+ControlNet path:

```bash
cd services/caellum
python compile.py --base sd15
```

**Then attempt the SDXL primary** (better looks, the quality target):

```bash
python compile.py --base sdxl
```

> **Known trap — SDXL+ControlNet segfault.** `neuronx-cc` can segfault compiling SDXL+ControlNet on
> Amazon Linux 2 (aws-neuron-sdk **#1002**). `compile.py` wraps the SDXL compile in try/except,
> prints a clear message, and tells you to fall back. **If SDXL segfaults or OOMs, stay on SD1.5**
> (`--base sd15`) — the demo's visual floor is fine. Re-attempt SDXL only on the HF Neuron DLAMI /
> Ubuntu with pinned known-good versions.

`config.py` has `ACTIVE_BASE` (`"sd15"` until SDXL is verified, then flip to `"sdxl"`) — `serve.py`
loads whatever `ACTIVE_BASE` points at. Keep it `sd15` unless the SDXL compile *and* a warm
inference both succeed.

*(The equivalent `optimum-cli export neuron …` command is documented inside `compile.py` as a
comment, in case you need to run the CLI path by hand.)*

---

## 3. Serve it (pre-warm + the /enhance endpoint)

```bash
cd services/caellum
python serve.py
```

`serve.py` loads `caellum_neuron/`, runs a **dummy inference to pre-warm** (first inference is a
45–60s cold start — pre-warming pays that cost once, at boot, not on the first player), then exposes
FastAPI on port **8400**:

- `GET /healthz` → readiness (only OK after pre-warm completes).
- `POST /enhance` → the rough sketch in, the enhanced RGBA sprite out.

Wait for the pre-warm to finish, then check health:
```bash
curl -s http://localhost:8400/healthz
```

**Hit `/enhance` with a base64 PNG.** The request is `{"image_b64", "label", "steps"?, "strength"?}`
and the response is `{"sprite_b64", "ms", "base"}` (per the contract in `config.py`). Example using
any PNG sketch file:

```bash
# Build the JSON body from a local rough sketch PNG and POST it.
python - <<'PY'
import base64, json, urllib.request
b64 = base64.b64encode(open("sketch.png", "rb").read()).decode()
body = json.dumps({"image_b64": b64, "label": "gun"}).encode()
req = urllib.request.Request(
    "http://localhost:8400/enhance", data=body,
    headers={"Content-Type": "application/json"})
resp = json.load(urllib.request.urlopen(req))
print("ms:", resp["ms"], "base:", resp["base"])
open("sprite.png", "wb").write(base64.b64decode(resp["sprite_b64"]))
print("wrote sprite.png (enhanced RGBA, background removed)")
PY
```

Or, if you prefer a pure-`curl` one-liner (base64-encode inline):
```bash
B64=$(base64 -w0 sketch.png 2>/dev/null || base64 sketch.png | tr -d '\n')
curl -s -X POST http://localhost:8400/enhance \
  -H 'Content-Type: application/json' \
  -d "{\"image_b64\":\"$B64\",\"label\":\"gun\"}" \
  | python -c "import sys,json,base64; r=json.load(sys.stdin); open('sprite.png','wb').write(base64.b64decode(r['sprite_b64'])); print('ms',r['ms'],'base',r['base'])"
```

Open `sprite.png` — it should be the cleaned-up, embellished sprite with a transparent background.
Benchmark the `ms` field and tune `STRENGTH` / `CONTROLNET_SCALE` / `STEPS` in `config.py` if needed
(2–3s budget).

---

## 4. Build the dataset (Colab GPU — run in parallel with the compile)

Switch to the **Colab/Kaggle CUDA** box. Either run the notebook (§"Notebook shortcut" below) or the
two scripts by hand. Upload `data/gen_teacher.py`, `data/roughen.py`, and
`train/requirements-train.txt` to Colab (they're self-contained — no repo needed), then:

```bash
pip install -r train/requirements-train.txt

# (1) Generate polished TARGET PNGs with full SDXL across every category → data/caellum_teacher/
python data/gen_teacher.py

# (2) Turn each finished PNG into a crude "kid's sketch" and write the paired dataset
python data/roughen.py
```

`roughen.py` writes `data/caellum_pairs/` with `rough/<id>.png`, `finished/<id>.png`, and
`metadata.jsonl` (one `{id, rough, finished, label, edit_prompt}` row per pair). All images are
**512×512, white background** — background removal happens at *serve* time, not in the data.

---

## 5. Train (Colab GPU)

Still on Colab, with `data/caellum_pairs/` in place:

**Primary — InstructPix2Pix** (treats the edit as "rough → finished"):
```bash
accelerate launch train/train_caellum_ip2p.py \
  --dataset_dir data/caellum_pairs \
  --output_dir  caellum_ip2p_out \
  --resolution 512
```

**Fallback — img2img LoRA** (lighter, faster, lower memory — use if InstructPix2Pix OOMs or you're
short on GPU time):
```bash
accelerate launch train/train_caellum_lora.py \
  --dataset_dir data/caellum_pairs \
  --output_dir  caellum_lora_out \
  --resolution 512
```

Pick whichever finishes and looks best. The output dir holds the trained weights to download.

---

## 6. Fuse the trained weights at compile (back on the Neuron box)

Download the trained LoRA/checkpoint dir from Colab to the Neuron box, then **re-run `compile.py`
with `--lora`** so the style is baked into the `.neuron` artifact (Neuron fuses LoRA *at compile
time* — there's no runtime LoRA load):

```bash
cd services/caellum
# <best> = sd15 or sdxl, whichever compiled cleanly and looks best
python compile.py --base <best> --lora /path/to/caellum_lora_out
```

This recompiles `caellum_neuron/` with the style fused in (`inline_weights_to_neff=True`). Then
restart `serve.py` (step 3) to serve the fused build. If the LoRA hurts more than it helps, just
recompile without `--lora` — ControlNet + the monochrome prompt already get most of the look.

---

## 7. Snapshot the artifact to S3 (before the workshop window closes)

The Trainium/inf2 workshop window is time-boxed and the compile is the long pole. **Snapshot the
compiled artifact to S3 so inference survives after the box goes away:**

```bash
aws s3 cp caellum_neuron/ s3://<your-bucket>/caellum/caellum_neuron/ --recursive
```

To restore later (on any Neuron box), pull it back and serve — no recompile needed:
```bash
aws s3 cp s3://<your-bucket>/caellum/caellum_neuron/ caellum_neuron/ --recursive
python serve.py
```

Do this **before you leave the Trainium window** — it's the cheapest insurance against the time-box.

---

## 8. Fallback ladder (every rung is demoable)

Take the highest rung that works; never block on a higher one.

**Visual (CAELLUM):**
1. **SDXL + ControlNet on Neuron** — best looks (the primary).
2. → **SD1.5 + ControlNet on Neuron** — if SDXL segfaults (#1002) or OOMs. *This is the floor you
   compile first and the one to trust.* Set `--base sd15` / `ACTIVE_BASE="sd15"`.
3. → **same pipeline, plain ControlNet txt2img** (scribble as control) if the img2img+ControlNet
   combined pipeline isn't available for a base — note it and run txt2img.
4. → **base-only** (no ControlNet) if ControlNet itself fights the compile.

**Training:**
- **InstructPix2Pix** (`train_caellum_ip2p.py`) → **img2img LoRA** (`train_caellum_lora.py`) →
  **no LoRA at all** (skip training; ControlNet + monochrome prompt carries the style).
- **No Colab GPU available → base-only:** skip the whole dataset+train track and ship the
  *uncustomized* compiled base. The serve path still enhances; it just isn't style-tuned.

**Everything below CAELLUM:** the game's own **pure-JS geometric beautify** (resample/RDP/symmetry,
zero GPU) is the guaranteed floor — the prop is playable with no model at all. CAELLUM only ever
*upgrades* that; it can't block it.

---

## Notebook shortcut (Colab)

[`notebooks/caellum_colab.ipynb`](notebooks/caellum_colab.ipynb) runs steps 4–5 top-to-bottom on
Colab: install deps → upload/clone note → `gen_teacher.py` → `roughen.py` → `train_caellum_ip2p.py`
(accelerate launch) → zip + download the trained weights. Open it in Colab, run all cells, download
the zip, then continue at step 6 on the Neuron box.

---

## Suggested time order (front-load the two long poles)

The two slow, blocking tracks are the **Neuron compile** (§2) and the **Colab dataset** (§4) — kick
both off at the very start and let them run while you do everything else. They're independent until
the fuse step (§6).

| When | Neuron box | Colab GPU |
|---|---|---|
| **t0 — start both** | §1 setup → §2 `compile.py --base sd15` (then attempt `--base sdxl`). | §4 `gen_teacher.py` → `roughen.py` (the dataset; slow). |
| **while compiling** | §3 once the floor compiles: `serve.py`, pre-warm, curl `/enhance`, **benchmark + tune**. | §5 `train_caellum_ip2p.py` (or `_lora.py`). |
| **as soon as the floor serves** | §7 **snapshot `caellum_neuron/` to S3** immediately — don't wait for the LoRA. | finish training; **download** the weights. |
| **when the LoRA lands** | §6 `compile.py --base <best> --lora <dir>` → restart `serve.py` → §7 re-snapshot. | (done) |

Rule of thumb: **get the SD1.5 floor serving and snapshotted to S3 first** (that's a guaranteed,
demoable result), *then* chase SDXL and the fused style as upgrades. Reference design:
[`docs/13-ai-pipeline.md`](docs/13-ai-pipeline.md) §8 (time-boxed execution) and §11 (fallbacks).
