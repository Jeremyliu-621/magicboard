#!/usr/bin/env python3
"""
CAELLUM /enhance HTTP server — runs on the NEURON BOX (AWS workshop inf2 instance).

ENV: Neuron / workshop env ONLY (torch-neuronx, neuronx-cc, optimum-neuron, diffusers,
controlnet-aux, rembg, fastapi, uvicorn). NO CUDA here. This script `import config` and is
meant to be run from inside `services/caellum/` so the sibling `config.py` is importable.

What it does:
  - Loads the AOT-compiled ControlNet pipeline from config.ARTIFACT_DIR (the .neuron artifacts
    produced by compile.py). The pipeline class is chosen to match config.ACTIVE_BASE.
  - PRE-WARMS the pipeline at startup with one dummy pipe(...) call to absorb the 45-60s Neuron
    cold start (static shapes => first inference triggers a slow trace/load). Logs the warm time.
  - Serves FastAPI:
        POST  {config.ENHANCE_ENDPOINT}  rough sketch PNG + label -> enhanced RGBA sprite
        GET   {config.HEALTH_ENDPOINT}   liveness / warm state
    on host 0.0.0.0 : config.PORT.

Runtime enhance pipeline (per IMPLEMENTATION-SPEC):
    decode rough PNG -> resize/pad to SHAPE x SHAPE on WHITE -> derive control image
    (scribble = binarized/cleaned strokes for sd15; canny edges for the sdxl/canny base)
    -> ControlNet text2img with config params + prompt_for(label) (the scribble locks the
       drawn layout; the prompt embellishes it into a clean game asset)
    -> rembg.remove() -> transparent RGBA sprite -> return {sprite_b64, ms, base}.

Example invocation (from services/caellum/, after compile.py has populated caellum_neuron/):
    NEURON_FUSE_SOFTMAX=1 python serve.py
    # or pick a port / artifact dir explicitly:
    NEURON_FUSE_SOFTMAX=1 python serve.py --artifact-dir caellum_neuron --port 8400
    # smoke test:
    curl -s localhost:8400/healthz
    curl -s -X POST localhost:8400/enhance \
         -H 'content-type: application/json' \
         -d "{\"image_b64\":\"$(base64 -i sketch.png)\",\"label\":\"sword\"}"

FUTURE (JEREMY): this HTTP endpoint is the v0 transport. The same handler body
(`enhance_bytes(...)`) is designed to drop into a Redis Streams consumer loop instead:
a worker would `XREADGROUP` enhance jobs off a stream, call `enhance_bytes()`, and `XADD`
the resulting sprite to a results stream — no FastAPI in the hot path. The decode/enhance/
encode core is deliberately framework-agnostic so that swap is mechanical.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import io
import os
import time
import traceback
from typing import Any, Optional

# config is the single source of truth (Neuron side imports it directly).
import config


# --------------------------------------------------------------------------------------
# Globals populated at startup by load_pipeline(). Kept module-level so the FastAPI
# handlers (and a future Redis consumer) can reach the warm pipeline without re-loading.
# --------------------------------------------------------------------------------------
PIPE: Any = None                 # the loaded optimum-neuron pipeline
ACTIVE_BASE: str = config.ACTIVE_BASE
WARM: bool = False               # flips True once pre-warm completes
PIPELINE_CLASS_NAME: str = ""    # for /healthz visibility
CONTROL_MODE: str = ""           # "scribble" (sd15) or "canny" (sdxl), for /healthz


# --------------------------------------------------------------------------------------
# Pipeline loading — class is selected to MATCH config.ACTIVE_BASE.
# Uses the EXACT optimum-neuron class names from the spec's verified API list.
# --------------------------------------------------------------------------------------
def load_pipeline(artifact_dir: str, base: str):
    """
    Load the compiled ControlNet pipeline from `artifact_dir` for the given base.

    base == "sd15" -> NeuronStableDiffusionControlNetPipeline      (+ scribble control)
    base == "sdxl" -> NeuronStableDiffusionXLControlNetPipeline    (+ canny control)

    These are AOT-compiled artifacts: from_pretrained loads the serialized .neuron graphs
    (no export here — that already happened in compile.py).
    """
    global CONTROL_MODE
    if base == "sd15":
        # Spec verified class name.
        from optimum.neuron import NeuronStableDiffusionControlNetPipeline as PipeCls
        CONTROL_MODE = "scribble"
    elif base == "sdxl":
        # Spec verified class name. SDXL CN is the canny-conditioned base (config.SDXL_CONTROLNET).
        from optimum.neuron import NeuronStableDiffusionXLControlNetPipeline as PipeCls
        CONTROL_MODE = "canny"
    else:
        raise ValueError(
            f"config.ACTIVE_BASE must be 'sd15' or 'sdxl', got {base!r}"
        )

    print(f"[serve] loading compiled pipeline ({PipeCls.__name__}) from {artifact_dir!r} ...")
    t0 = time.time()
    # The compiled artifacts already carry the baked-in static shapes/dtype from compile.py,
    # so from_pretrained just deserializes + loads onto the NeuronCores.
    pipe = PipeCls.from_pretrained(artifact_dir)
    print(f"[serve] pipeline loaded in {time.time() - t0:.1f}s")
    return pipe, PipeCls.__name__


# --------------------------------------------------------------------------------------
# Image helpers — all output is SHAPE x SHAPE on WHITE (matches config + dataset format).
# --------------------------------------------------------------------------------------
def _decode_png(image_b64: str):
    """Decode a base64 PNG (the rough sketch, any size) into an RGB PIL image on white."""
    from PIL import Image

    try:
        raw = base64.b64decode(image_b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"image_b64 is not valid base64: {exc}") from exc
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Exception as exc:  # PIL raises a grab-bag of exceptions on bad data
        raise ValueError(f"image_b64 is not a decodable image: {exc}") from exc

    # Flatten any alpha onto white so transparent sketches don't go black.
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        from PIL import Image as _Image

        bg = _Image.new("RGBA", img.size, (255, 255, 255, 255))
        bg.alpha_composite(img.convert("RGBA"))
        img = bg.convert("RGB")
    else:
        img = img.convert("RGB")
    return img


def _resize_pad_square(img, size: int):
    """Resize the sketch to fit inside `size`x`size`, centered, padded on WHITE (no distortion)."""
    from PIL import Image

    w, h = img.size
    if w == 0 or h == 0:
        raise ValueError("image has zero dimension")
    scale = min(size / w, size / h)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    resized = img.resize((new_w, new_h), Image.LANCZOS)
    canvas = Image.new("RGB", (size, size), (255, 255, 255))
    canvas.paste(resized, ((size - new_w) // 2, (size - new_h) // 2))
    return canvas


def _make_control_image(init_img, mode: str):
    """
    Derive the ControlNet conditioning image from the (already squared) sketch.

    mode == "scribble": clean the strokes into a black-on-white scribble. We binarize to
        strong black lines on white — a HED/scribble detector would over-interpret a kid's
        line drawing, so for line-art input a thresholded clean-up is the faithful control.
    mode == "canny": run a Canny edge detector (controlnet-aux) — required by the
        config.SDXL_CONTROLNET (diffusers/controlnet-canny-sdxl-1.0-small) base.

    Returns a SHAPE x SHAPE RGB PIL image.
    """
    from PIL import Image

    if mode == "canny":
        # controlnet-aux ships the canonical Canny detector used with diffusers ControlNet.
        from controlnet_aux import CannyDetector

        canny = CannyDetector()
        # Defaults (100/200) are the diffusers-documented canny thresholds; output is RGB.
        ctrl = canny(init_img)
        if ctrl.size != (init_img.width, init_img.height):
            ctrl = ctrl.resize(init_img.size, Image.NEAREST)
        return ctrl.convert("RGB")

    # mode == "scribble": threshold to crisp black strokes on white.
    gray = init_img.convert("L")
    # Anything not near-white becomes black stroke; rest becomes white.
    bw = gray.point(lambda p: 0 if p < 200 else 255, mode="L")
    return bw.convert("RGB")


def _encode_png_b64(pil_img) -> str:
    """Encode a PIL image as base64 PNG (preserving alpha for the RGBA sprite)."""
    buf = io.BytesIO()
    pil_img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _cutout_bg(rgb_img):
    """Make the connected, solid-ish background transparent -> clean RGBA sprite.

    Flood-fills inward from all four corners with a tolerance, so a flat OR slightly-noisy/grey
    background is removed as one connected region while the asset's bold outline stops the fill.
    Far more robust than a per-pixel colour key when the model paints a textured grey background.
    """
    import numpy as np
    from PIL import Image, ImageDraw

    img = rgb_img.convert("RGB")
    w, h = img.size
    SENT = (255, 0, 255)  # magenta sentinel (never occurs in a charcoal doodle)
    # pass 1: flood-fill the connected background from the corners AND edge midpoints, with a
    # generous tolerance so it bridges a sketchy/hatched texture without bleeding into the dark asset.
    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
             (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
    for xy in seeds:
        try:
            ImageDraw.floodfill(img, xy, SENT, thresh=85)
        except Exception:
            pass
    arr = np.array(img.convert("RGBA"))
    rgb = arr[:, :, :3].astype(np.int16)
    sent = (rgb[:, :, 0] == 255) & (rgb[:, :, 1] == 0) & (rgb[:, :, 2] == 255)
    # pass 2: mop up any near-white / light-grey stragglers the fill missed (keeps the dark
    # outline + any saturated fills, so the asset itself stays).
    bright = rgb.mean(axis=2)
    sat = rgb.max(axis=2) - rgb.min(axis=2)
    light_gray = (bright > 175) & (sat < 28)
    arr[:, :, 3] = np.where(sent | light_gray, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, "RGBA")


# --------------------------------------------------------------------------------------
# Core enhance — framework-agnostic so a future Redis Streams consumer can call it directly.
# --------------------------------------------------------------------------------------
def enhance_bytes(
    image_b64: str,
    label: str,
    steps: Optional[int] = None,
    strength: Optional[float] = None,
) -> dict:
    """
    Rough sketch (base64 PNG) + label -> {"sprite_b64", "ms", "base"}.

    Raises ValueError on bad input; the HTTP layer maps that to a JSON error.
    """
    if PIPE is None:
        raise RuntimeError("pipeline not loaded yet")
    if not isinstance(label, str) or not label.strip():
        raise ValueError("label is required and must be a non-empty string")

    n_steps = int(steps) if steps is not None else config.STEPS
    denoise = float(strength) if strength is not None else config.STRENGTH
    if n_steps <= 0:
        raise ValueError("steps must be a positive integer")
    if not (0.0 < denoise <= 1.0):
        raise ValueError("strength must be in (0.0, 1.0]")

    t0 = time.time()

    # 1) decode + normalize to SHAPE x SHAPE on white
    sketch = _decode_png(image_b64)
    init_img = _resize_pad_square(sketch, config.SHAPE)

    # 2) derive the control image (scribble for sd15, canny for sdxl)
    control_img = _make_control_image(init_img, CONTROL_MODE)

    # 3) ControlNet TEXT2IMG. For the optimum-neuron ControlNet pipelines, `image=` IS the
    #    ControlNet conditioning image, and there is NO `strength`/init-image (those belong to a
    #    separate ControlNet-img2img pipeline that optimum-neuron does not reliably expose). The
    #    scribble/canny locks the drawn LAYOUT while the prompt+label drives the embellishment —
    #    exactly the "complete it + add a handle/pattern" behavior we want. `denoise` is accepted
    #    for API-compat/logging but only takes effect if you later wire an img2img-ControlNet base.
    prompt = config.prompt_for(label.strip())
    print(
        f"[serve] enhance label={label!r} base={ACTIVE_BASE} steps={n_steps} "
        f"cn_scale={config.CONTROLNET_SCALE} ctrl={CONTROL_MODE} (strength={denoise}, reserved)"
    )
    result = PIPE(
        prompt,
        image=control_img,
        num_inference_steps=n_steps,
        guidance_scale=config.GUIDANCE,
        controlnet_conditioning_scale=config.CONTROLNET_SCALE,
        negative_prompt=config.NEG_PROMPT,
    )
    raster = result.images[0]

    # 4) cut the (plain) background to transparent -> clean RGBA sprite. The prompt forces a solid
    #    background, so we key out the corner colour rather than rely on rembg (which left a grey box
    #    and needed a 170MB model download on first use).
    sprite = _cutout_bg(raster.convert("RGB"))

    sprite_b64 = _encode_png_b64(sprite)
    ms = int((time.time() - t0) * 1000)
    print(f"[serve] enhance done in {ms}ms")
    return {"sprite_b64": sprite_b64, "ms": ms, "base": ACTIVE_BASE}


# --------------------------------------------------------------------------------------
# Pre-warm — one dummy pipe(...) call to eat the 45-60s Neuron cold start at startup.
# --------------------------------------------------------------------------------------
def prewarm() -> None:
    """Run a single throwaway inference so the first real /enhance is fast (~2-3s)."""
    global WARM
    from PIL import Image

    print("[serve] pre-warming pipeline (absorbing 45-60s Neuron cold start)...")
    t0 = time.time()
    dummy = Image.new("RGB", (config.SHAPE, config.SHAPE), (255, 255, 255))
    control = _make_control_image(dummy, CONTROL_MODE)
    try:
        PIPE(
            config.prompt_for("ball"),
            image=control,
            num_inference_steps=config.STEPS,
            guidance_scale=config.GUIDANCE,
            controlnet_conditioning_scale=config.CONTROLNET_SCALE,
            negative_prompt=config.NEG_PROMPT,
        )
        WARM = True
        print(f"[serve] pre-warm complete in {time.time() - t0:.1f}s — ready to serve")
    except Exception:
        # Don't crash the server on a warm failure; /healthz will report not-warm and the
        # first real request will pay the cold-start cost instead.
        print("[serve] WARNING: pre-warm failed; first request will be slow:")
        traceback.print_exc()


# --------------------------------------------------------------------------------------
# FastAPI app
# --------------------------------------------------------------------------------------
def build_app():
    """Construct the FastAPI app. Imported lazily so non-serve tooling can import this module."""
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse
    from fastapi.middleware.cors import CORSMiddleware

    app = FastAPI(title="CAELLUM enhance", version="0.1")
    # The game runs from a different origin (file:// or the relay host) and calls /enhance from
    # the browser, so allow cross-origin requests.
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    @app.get(config.HEALTH_ENDPOINT)
    def healthz() -> dict:
        return {
            "status": "ok" if (PIPE is not None and WARM) else "loading",
            "warm": WARM,
            "loaded": PIPE is not None,
            "base": ACTIVE_BASE,
            "pipeline": PIPELINE_CLASS_NAME,
            "control": CONTROL_MODE,
            "shape": config.SHAPE,
        }

    # This box's FastAPI mis-classifies EVERY typed handler param as a required query param
    # (it did it to a raw `Request` AND to a Pydantic body model -> 422, loc:["query",...]) — a
    # fastapi/pydantic version skew. Only /healthz (no params) survives. So we bypass FastAPI's
    # parameter machinery entirely with a plain STARLETTE route: add_route passes the raw request
    # positionally with NO type introspection, and we read the JSON body by hand.
    async def enhance_endpoint(request):
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={"error": "request body must be JSON"})
        if not isinstance(data, dict):
            return JSONResponse(status_code=400, content={"error": "request body must be a JSON object"})
        image_b64 = data.get("image_b64")
        if not isinstance(image_b64, str) or not image_b64:
            return JSONResponse(status_code=400, content={"error": "image_b64 (base64 PNG string) is required"})
        try:
            out = enhance_bytes(image_b64, data.get("label", "thing"),
                                steps=data.get("steps"), strength=data.get("strength"))
            return JSONResponse(content=out)
        except ValueError as exc:
            return JSONResponse(status_code=400, content={"error": str(exc)})  # bad client input
        except Exception as exc:
            traceback.print_exc()
            return JSONResponse(status_code=500, content={"error": f"enhance failed: {exc}"})

    app.add_route(config.ENHANCE_ENDPOINT, enhance_endpoint, methods=["POST"])
    return app


def init_server(artifact_dir: str, base: str, skip_warm: bool = False) -> None:
    """Load + (optionally) pre-warm the pipeline, populating module globals."""
    global PIPE, ACTIVE_BASE, PIPELINE_CLASS_NAME
    ACTIVE_BASE = base
    PIPE, PIPELINE_CLASS_NAME = load_pipeline(artifact_dir, base)
    if skip_warm:
        print("[serve] --skip-warm set: NOT pre-warming (first request will cold-start)")
    else:
        prewarm()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Serve the compiled CAELLUM ControlNet pipeline over HTTP (Neuron box)."
    )
    parser.add_argument(
        "--artifact-dir",
        default=config.ARTIFACT_DIR,
        help=f"dir holding the compiled .neuron pipeline (default: {config.ARTIFACT_DIR})",
    )
    parser.add_argument(
        "--base",
        default=config.ACTIVE_BASE,
        choices=["sd15", "sdxl"],
        help=f"which compiled base to load (default from config: {config.ACTIVE_BASE})",
    )
    parser.add_argument("--host", default="0.0.0.0", help="bind host (default: 0.0.0.0)")
    parser.add_argument(
        "--port", type=int, default=config.PORT, help=f"bind port (default: {config.PORT})"
    )
    parser.add_argument(
        "--skip-warm",
        action="store_true",
        help="skip the startup pre-warm (debug only; first /enhance will be slow)",
    )
    args = parser.parse_args()

    # Neuron requires the fused-softmax env; set it if the launcher forgot (spec convention).
    os.environ.setdefault("NEURON_FUSE_SOFTMAX", "1")

    print(f"[serve] CAELLUM enhance starting | base={args.base} | artifacts={args.artifact_dir}")
    if not os.path.isdir(args.artifact_dir):
        raise SystemExit(
            f"[serve] artifact dir {args.artifact_dir!r} not found — run compile.py first "
            f"(e.g. `python compile.py --base {args.base}`)."
        )

    init_server(args.artifact_dir, args.base, skip_warm=args.skip_warm)

    import uvicorn

    app = build_app()
    print(f"[serve] listening on http://{args.host}:{args.port}  "
          f"(POST {config.ENHANCE_ENDPOINT}, GET {config.HEALTH_ENDPOINT})")
    # Single worker: the pipeline is loaded once into this process and bound to the NeuronCores.
    uvicorn.run(app, host=args.host, port=args.port, workers=1, log_level="info")


if __name__ == "__main__":
    main()
