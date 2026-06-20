#!/usr/bin/env python3
"""
CAELLUM teacher-dataset generator — generates polished 2D game-asset target PNGs.

ENV: Colab / Kaggle / any CUDA GPU box (NOT the Neuron workshop box).
     A single GPU is the ONLY hard requirement — this runs fine on a free Colab T4
     or a Kaggle GPU (fp16, ~6-8GB VRAM for SDXL-base at 512x512). No repo, no CUDA
     toolkit setup beyond `pip install torch diffusers transformers accelerate safetensors`.

This is the FIRST stage of the data flow:
    gen_teacher.py  ->  finished target PNGs  ->  roughen.py  ->  (rough, finished, label) pairs

It uses the full SDXL-base diffusers pipeline (CUDA, fp16) to render clean, consistent,
icon/sticker-style game assets across the CAELLUM categories, then writes a manifest.

SELF-CONTAINED: CATEGORIES / SHAPE / STYLE are inlined below (Colab has no repo).
KEEP IN SYNC WITH services/caellum/config.py.

Example invocation (Colab cell or shell):
    !python data/gen_teacher.py --out data/caellum_teacher --per-category 24 \
        --model stabilityai/stable-diffusion-xl-base-1.0 --steps 30

Output:
    <out>/<category>/<i>.png          # 512x512 RGB, white background
    <out>/teacher.jsonl               # one row per image: {"path": ..., "label": ...}
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

# --- KEEP IN SYNC WITH services/caellum/config.py -------------------------------------
# Colab has no repo, so these constants are duplicated inline (see the spec conventions).
SHAPE = 512  # height == width; all assets are 512x512 to match the compile geometry.

# KEEP IN SYNC with services/caellum/config.py CATEGORY_BEHAVIOR (the keys, same order).
# General, everyday nouns (not franchise-specific) so the model generalizes broadly.
CATEGORIES = [
    # melee weapons
    "sword", "knife", "bat", "hammer", "axe",
    # ranged weapons
    "gun", "bow", "slingshot",
    # throwables
    "bomb", "ball", "rock", "bottle", "dart",
    # healing / food
    "food", "fruit", "bread", "cake",
    # buffs
    "star", "heart", "gem", "crown",
    # environment hazards
    "spikes", "saw", "fire", "trap",
    # environment bouncy
    "spring", "trampoline",
    # environment platforms
    "cloud", "block", "plank",
    # destructible props
    "crate", "barrel", "balloon", "key", "coin",
]

# STYLE: the shared look that makes every teacher image a polished, consistent 2D game
# asset. Mirrors config.prompt_for() — bold black outline, flat shading, centered,
# simple bold shapes, white background, icon/sticker. {label} is filled per category.
STYLE = (
    "a clean 2d game asset of a {label}, bold black outline, flat shading, "
    "centered, simple bold shapes, crisp lines, vibrant flat colors, "
    "plain solid white background, sticker, game icon, vector style, "
    "no shadow, no gradient background"
)

# Negative prompt — keep it out of photo/3d territory and away from text/clutter so the
# assets stay clean enough for the roughen.py edge pass to work on.
NEG_PROMPT = (
    "photograph, 3d render, realistic, photorealistic, blurry, color noise, "
    "jpeg artifacts, watermark, text, signature, multiple objects, busy background, "
    "drop shadow, gradient background, frame, border"
)
# --------------------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Generate polished SDXL teacher target PNGs for the CAELLUM dataset (CUDA).",
    )
    p.add_argument(
        "--out",
        type=str,
        default="data/caellum_teacher",
        help="Output directory for the teacher dataset (default: data/caellum_teacher).",
    )
    p.add_argument(
        "--per-category",
        type=int,
        default=24,
        dest="per_category",
        help="How many images to generate per category (default: 24).",
    )
    p.add_argument(
        "--model",
        type=str,
        default="stabilityai/stable-diffusion-xl-base-1.0",
        help="Diffusers SDXL base model id (default: stabilityai/stable-diffusion-xl-base-1.0).",
    )
    p.add_argument(
        "--steps",
        type=int,
        default=30,
        help="num_inference_steps per image (default: 30).",
    )
    p.add_argument(
        "--guidance",
        type=float,
        default=7.0,
        help="classifier-free guidance scale (default: 7.0).",
    )
    p.add_argument(
        "--seed",
        type=int,
        default=0,
        help="Base seed; the per-image seed is base + a running global counter (default: 0).",
    )
    p.add_argument(
        "--categories",
        type=str,
        default=None,
        help="Optional comma-separated subset of categories to generate (default: all).",
    )
    return p.parse_args()


def build_pipeline(model_id: str):
    """Load the full SDXL diffusers pipeline on CUDA in fp16.

    Imports happen inside the function so `--help` works without torch/diffusers
    installed, and so the import-time GPU check produces a clear error if run on a
    box without CUDA.
    """
    import torch
    from diffusers import StableDiffusionXLPipeline

    if not torch.cuda.is_available():
        raise SystemExit(
            "ERROR: no CUDA GPU detected. gen_teacher.py must run on a CUDA box "
            "(free Colab T4 / Kaggle GPU work fine). A GPU is the only requirement."
        )

    print(f"[caellum] loading SDXL pipeline: {model_id} (fp16, CUDA) ...")
    pipe = StableDiffusionXLPipeline.from_pretrained(
        model_id,
        torch_dtype=torch.float16,
        use_safetensors=True,
        variant="fp16",
    )
    pipe = pipe.to("cuda")
    # Trim VRAM so this comfortably fits a free T4 at 512x512.
    pipe.enable_vae_slicing()
    pipe.enable_attention_slicing()
    # Quieter logs: we drive our own progress prints below.
    pipe.set_progress_bar_config(disable=True)
    print("[caellum] pipeline ready.")
    return pipe, torch


def main() -> None:
    args = parse_args()

    if args.categories:
        wanted = [c.strip() for c in args.categories.split(",") if c.strip()]
        unknown = [c for c in wanted if c not in CATEGORIES]
        if unknown:
            print(f"[caellum] WARNING: categories not in the canonical list: {unknown}")
        categories = wanted
    else:
        categories = list(CATEGORIES)

    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)
    manifest_path = out_root / "teacher.jsonl"

    total_target = len(categories) * args.per_category
    print(
        f"[caellum] generating {total_target} images "
        f"({len(categories)} categories x {args.per_category}) "
        f"at {SHAPE}x{SHAPE}, {args.steps} steps -> {out_root}"
    )

    pipe, torch = build_pipeline(args.model)

    written = 0
    global_index = 0  # drives the per-image seed so every image is unique & reproducible
    # Open the manifest once and stream rows as we go, so a crash mid-run still leaves a
    # valid partial manifest for whatever PNGs already landed on disk.
    with manifest_path.open("w", encoding="utf-8") as manifest:
        for category in categories:
            cat_slug = category.replace(" ", "_")
            cat_dir = out_root / cat_slug
            cat_dir.mkdir(parents=True, exist_ok=True)
            prompt = STYLE.format(label=category)

            for i in range(args.per_category):
                seed = args.seed + global_index
                global_index += 1
                generator = torch.Generator(device="cuda").manual_seed(seed)

                image = pipe(
                    prompt=prompt,
                    negative_prompt=NEG_PROMPT,
                    num_inference_steps=args.steps,
                    guidance_scale=args.guidance,
                    height=SHAPE,
                    width=SHAPE,
                    generator=generator,
                ).images[0]

                # Guarantee exact target size even if the model returns a different size.
                if image.size != (SHAPE, SHAPE):
                    image = image.resize((SHAPE, SHAPE))
                # Drop alpha if any; teacher targets are RGB on white (bg-removal is at serve time).
                if image.mode != "RGB":
                    image = image.convert("RGB")

                img_path = cat_dir / f"{i}.png"
                image.save(img_path)

                # Manifest path is stored relative to <out> so the dataset is portable.
                rel_path = os.path.join(cat_slug, f"{i}.png")
                manifest.write(
                    json.dumps({"path": rel_path, "label": category}) + "\n"
                )
                manifest.flush()

                written += 1
                print(
                    f"[caellum] {written}/{total_target}  "
                    f"{category!r}  seed={seed}  -> {img_path}"
                )

    print(
        f"[caellum] DONE. wrote {written} images across {len(categories)} categories.\n"
        f"[caellum] manifest: {manifest_path}\n"
        f"[caellum] next: run data/roughen.py on {out_root} to build the training pairs."
    )


if __name__ == "__main__":
    main()
