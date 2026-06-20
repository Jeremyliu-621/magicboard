# services/caellum — CAELLUM image-enhancement engine

This directory is the **visual enhancement engine** for Doodle Smash: it turns a player's
rough iPad scribble into a polished, game-ready **raster sprite** (transparent background).
Runtime path is *ControlNet (scribble/canny) + img2img + a label prompt → raster → rembg
background removal → RGBA sprite*, ~2–3s. The game blits that sprite (see
[`docs/13-ai-pipeline.md`](../../docs/13-ai-pipeline.md)).

## Read this first
- **[`IMPLEMENTATION-SPEC.md`](IMPLEMENTATION-SPEC.md)** — the shared contract every script in this
  pipeline obeys (flow, file list, **verified** optimum-neuron / diffusers API references, the
  dataset format, conventions). Read it before touching any file here.
- **[`../../RUNBOOK-image.md`](../../RUNBOOK-image.md)** — the human/operator step-by-step: set up
  the box, compile, serve, build the dataset, train, fuse the LoRA, snapshot to S3, and the
  fallback ladder when something fights you.

## Two environments — do not mix their deps
This is the load-bearing fact about the pipeline. The scripts split across **two machines** that
never share a Python env:

1. **Neuron box** (this dir) — the AWS workshop Code Editor / **inf2** instance. Has the Neuron SDK
   (torch-neuronx, neuronx-cc). **No CUDA.** Runs `compile.py` + `serve.py`, which `import config`.
2. **Colab/Kaggle GPU** (`data/`, `train/`, `notebooks/`) — a free **CUDA** box that does *not*
   have this repo. Those scripts are **self-contained** (they inline `CATEGORIES`/`SHAPE`/`STYLE`
   from `config.py` with a "keep in sync" comment) so they run after a single upload.

`config.py` is the single source of truth for shapes, model ids, runtime params, and the HTTP
contract. The Neuron side imports it; the Colab side mirrors it.

## File map
| File | Env | Purpose |
|---|---|---|
| `config.py` | Neuron | **Single source of truth**: static shapes, model ids, enhance params, `/enhance` contract, `prompt_for()`. |
| `setup_neuron.sh` | Neuron | pip-install optimum-neuron + diffusers + controlnet-aux + rembg + fastapi on top of the workshop env; echo versions; export `NEURON_FUSE_SOFTMAX=1`. |
| `requirements-neuron.txt` | Neuron | Pinned deps for compile + serve. |
| `compile.py` | Neuron | AOT-compile **SD1.5 (floor)** and **SDXL (primary)** + ControlNet → `caellum_neuron/`. Flags: `--base sd15\|sdxl`, optional `--lora <dir>` to fuse a trained style LoRA. |
| `serve.py` | Neuron | Load `caellum_neuron/`, **pre-warm**, FastAPI `POST /enhance` + `GET /healthz`, rembg background removal. |
| `IMPLEMENTATION-SPEC.md` | — | The contract (read first). |
| `README.md` | — | This orientation. |

**Sibling Colab files** (not in this dir — they live where Colab expects them):
`data/gen_teacher.py`, `data/roughen.py`, `train/train_caellum_ip2p.py`,
`train/train_caellum_lora.py`, `train/requirements-train.txt`,
`notebooks/caellum_colab.ipynb`.

## Quick start
```bash
# On the Neuron box, from this directory:
bash setup_neuron.sh
python compile.py --base sd15          # the guaranteed floor; do this first
python serve.py                        # pre-warms, then serves /enhance on :8400
```
Full sequence (including the Colab dataset + training and the S3 snapshot) is in
[`../../RUNBOOK-image.md`](../../RUNBOOK-image.md).
