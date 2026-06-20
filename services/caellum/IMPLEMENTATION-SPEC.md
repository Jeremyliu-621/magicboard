# CAELLUM Image Pipeline — Implementation Spec (read before writing any file)

This is the shared contract for the **visual enhancement engine**: rough drawing → completed,
embellished, game-ready **raster sprite** (transparent background). Every script below must obey
this spec so the pieces fit together. The single source of truth for constants is
`services/caellum/config.py` — import it (Neuron side) or mirror its values (Colab side).

## The two environments (do not mix their deps)
1. **Neuron box** = the AWS workshop Code Editor / inf2 instance. Runs `compile.py` + `serve.py`.
   Has the Neuron SDK (torch-neuronx, neuronx-cc). We add `optimum-neuron`, `diffusers`,
   `controlnet-aux`, `rembg`, `fastapi`, `uvicorn`. **No CUDA here.**
2. **Colab/Kaggle GPU** = a free CUDA box. Runs `data/gen_teacher.py`, `data/roughen.py`,
   `train/train_*.py` (and the notebook). Standard `diffusers` + `torch` (CUDA). Colab does NOT have
   this repo, so these scripts are **self-contained** (inline the CATEGORIES/SHAPE/STYLE from config).

## The flow
```
[Colab]  gen_teacher.py ──► finished target PNGs ──► roughen.py ──► (rough, finished, label) pairs
                                                                        │
                                                          train_caellum_ip2p.py (+lora) ──► LoRA/ckpt
                                                                        │ (download)
[Neuron] compile.py (SD1.5 floor, SDXL primary; fuse LoRA when ready) ──► caellum_neuron/ (.neuron)
                                                                        │
         serve.py: load + PRE-WARM + POST /enhance (rough png + label → enhanced rgba sprite)
```
Runtime enhance = ControlNet(scribble/canny on the sketch) + img2img(strength 0.6) + prompt(label)
→ raster → **rembg background removal** → RGBA sprite. ~2-3s. The game blits the sprite (raster
layer, NOT vector — these embellished props are sprites, per docs/13).

## Files to implement (owner = one agent each)
| File | Env | Purpose |
|---|---|---|
| `services/caellum/setup_neuron.sh` | Neuron | pip-install optimum-neuron+diffusers+controlnet-aux+rembg+fastapi on top of the workshop env; echo versions; set `NEURON_FUSE_SOFTMAX=1` |
| `services/caellum/requirements-neuron.txt` | Neuron | pinned deps for compile+serve |
| `services/caellum/compile.py` | Neuron | AOT-compile SD1.5 (floor) and SDXL (primary) + ControlNet to `caellum_neuron/`; CLI flags `--base sd15\|sdxl`, optional `--lora <dir>` to fuse |
| `services/caellum/serve.py` | Neuron | load `caellum_neuron/`, PRE-WARM, FastAPI `/enhance` + `/healthz`, rembg bg-removal |
| `data/gen_teacher.py` | Colab | SDXL-full (CUDA) → polished target PNGs across CATEGORIES into `data/caellum_teacher/` |
| `data/roughen.py` | Colab | turn each finished PNG into a crude "kid's sketch" (edge→simplify→jitter→drop) + write the paired dataset to `data/caellum_pairs/` |
| `train/train_caellum_ip2p.py` | Colab | InstructPix2Pix fine-tune on the pairs (primary) |
| `train/train_caellum_lora.py` | Colab | img2img LoRA on the pairs (lighter fallback) |
| `train/requirements-train.txt` | Colab | pinned training deps |
| `notebooks/caellum_colab.ipynb` | Colab | valid notebook: gen_teacher → roughen → train, runnable top-to-bottom on Colab |
| `RUNBOOK-image.md` (repo root) | — | human/Sai step-by-step: env, compile, serve, dataset, train, fuse, s3 snapshot, fallbacks |
| `services/caellum/README.md` | — | short orientation for the services/caellum dir |

## Verified API references (use these EXACTLY — do not invent class/flag names)
**optimum-neuron (compile + serve):**
- Classes: `NeuronStableDiffusionControlNetPipeline` (SD1.5), `NeuronStableDiffusionXLControlNetPipeline` (SDXL),
  `NeuronStableDiffusionImg2ImgPipeline`, `NeuronStableDiffusionXLImg2ImgPipeline`.
- Compile (preferred, in-Python): `Pipe.from_pretrained(MODEL, controlnet_ids=CN_ID, export=True,
  batch_size=1, height=512, width=512, num_images_per_prompt=1, auto_cast="matmul",
  auto_cast_type="bf16")` then `pipe.save_pretrained(ARTIFACT_DIR)`.
- Equivalent CLI (put in a comment): `optimum-cli export neuron -m <model> --controlnet_ids <id>
  --batch_size 1 --height 512 --width 512 --num_images_per_prompt 1 --auto_cast matmul
  --auto_cast_type bf16 caellum_neuron/`.
- LoRA fuse at compile: pass `lora_model_ids=<dir>, inline_weights_to_neff=True` to `from_pretrained`.
- **Static shapes are mandatory.** First inference is a 45-60s cold start → `serve.py` MUST pre-warm
  with a dummy `pipe(...)` call at startup. Set env `NEURON_FUSE_SOFTMAX=1`.
- **Known issue:** SDXL+ControlNet can segfault in `neuronx-cc` on Amazon Linux 2 (aws-neuron-sdk
  #1002). `compile.py` must wrap the SDXL compile in try/except, print a clear message, and tell the
  user to fall back to `--base sd15`. Pin versions in requirements; prefer the HF Neuron DLAMI/Ubuntu.
- ControlNet img2img call: `pipe(prompt, image=init_img, control_image=scribble_img,
  num_inference_steps=STEPS, guidance_scale=GUIDANCE, controlnet_conditioning_scale=CONTROLNET_SCALE,
  strength=STRENGTH, negative_prompt=NEG_PROMPT)`. (If the img2img+controlnet combined pipeline isn't
  available for a base, fall back to plain ControlNet txt2img with the scribble as control — note it.)

**diffusers InstructPix2Pix (training):** base the script on the official
`examples/instruct_pix2pix/train_instruct_pix2pix.py` (SD1.5) — expects a dataset with columns
`(original_image, edit_prompt, edited_image)`. For us: original_image = ROUGH, edited_image = FINISHED,
edit_prompt = "turn this into a clean game {label}". Load from the local `DATASET_DIR` via a
`metadata.jsonl` (see dataset format). Accept CLI args for model, data dir, output dir, steps,
batch, lr, resolution=512. Keep it Colab-runnable (accelerate launch).

**rembg:** `from rembg import remove; out_rgba = remove(pil_rgb)` for background removal → RGBA.

## Dataset format (roughen.py writes it, train reads it)
```
data/caellum_pairs/
  rough/<id>.png        # the crude input (512x512, white bg)
  finished/<id>.png     # the polished target (512x512, white bg)
  metadata.jsonl        # one row per pair:
      {"id":"0001","rough":"rough/0001.png","finished":"finished/0001.png",
       "label":"gun","edit_prompt":"turn this into a clean game gun"}
```
All images **512×512, white background** (matches SHAPE; bg-removal happens at serve time, not in data).

## Conventions
- Python 3.10+, type hints where natural, argparse CLIs, clear `print()` progress, no notebook-only
  magics in `.py` files. Every script: a top docstring saying which ENV it runs in + an example
  invocation. Idempotent where possible. No secrets hardcoded.
- Do NOT touch the game's `js/` files — this is a separate Python subsystem.
- Neuron-side scripts `import config` (run from `services/caellum/`); Colab-side scripts inline the
  constants (CATEGORIES/SHAPE/STYLE) with a comment "keep in sync with services/caellum/config.py".
- Keep it real: use the verified API names above. If unsure whether an exact arg exists, prefer the
  CLI `optimum-cli export neuron` path and note the assumption in a comment.
