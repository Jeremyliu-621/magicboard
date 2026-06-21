#!/usr/bin/env python3
"""
CAELLUM — AOT-compile the base diffusion model + its ControlNet to AWS Neuron.

ENV: the AWS Neuron workshop / inf2 instance ONLY (NO CUDA). Run AFTER setup_neuron.sh.
     This imports `config` (run it from services/caellum/) and uses optimum-neuron to
     trace + compile the chosen base into static-shape .neuron artifacts that serve.py
     loads. Neuron requires FIXED shapes, so SHAPE/BATCH/NUM_IMAGES are baked in here.

What it does:
  - base=sd15 (default, GUARANTEED floor): NeuronStableDiffusionControlNetPipeline
    over stable-diffusion-v1-5 + sd-controlnet-scribble.
  - base=sdxl (PRIMARY/quality): NeuronStableDiffusionXLControlNetPipeline over
    SDXL-base-1.0 + controlnet-canny-sdxl-1.0-small. This path can SEGFAULT in
    neuronx-cc on Amazon Linux 2 (aws-neuron-sdk #1002) — wrapped in try/except with
    a clear "retry with --base sd15" message.
  - optional --lora <dir>: fuse a trained style LoRA at compile time via
    lora_model_ids + inline_weights_to_neff=True.

Example:
  cd services/caellum
  python compile.py --base sd15
  python compile.py --base sdxl --lora ../../train_out/caellum_lora --out caellum_neuron
  python compile.py --base sd15 --out /home/ubuntu/caellum_neuron

Equivalent optimum-cli (kept for reference; the in-Python path below is preferred):
  # SD1.5:
  #   NEURON_FUSE_SOFTMAX=1 optimum-cli export neuron \
  #     -m stable-diffusion-v1-5/stable-diffusion-v1-5 \
  #     --controlnet_ids lllyasviel/sd-controlnet-scribble \
  #     --batch_size 1 --height 512 --width 512 --num_images_per_prompt 1 \
  #     --auto_cast matmul --auto_cast_type bf16 \
  #     caellum_neuron/
  # SDXL:
  #   NEURON_FUSE_SOFTMAX=1 optimum-cli export neuron \
  #     -m stabilityai/stable-diffusion-xl-base-1.0 \
  #     --controlnet_ids diffusers/controlnet-canny-sdxl-1.0-small \
  #     --batch_size 1 --height 512 --width 512 --num_images_per_prompt 1 \
  #     --auto_cast matmul --auto_cast_type bf16 \
  #     caellum_neuron/
  # (When fusing a LoRA, optimum-cli takes:  --lora_model_ids <dir>  --inline_weights_to_neff)
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import traceback

import config


def _set_neuron_env() -> None:
    """Ensure NEURON_FUSE_SOFTMAX=1 even if the user forgot to source setup_neuron.sh."""
    if os.environ.get("NEURON_FUSE_SOFTMAX") != "1":
        os.environ["NEURON_FUSE_SOFTMAX"] = "1"
        print("[env] set NEURON_FUSE_SOFTMAX=1 (was unset/!=1)")
    else:
        print("[env] NEURON_FUSE_SOFTMAX=1 OK")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="AOT-compile the CAELLUM base + ControlNet to Neuron (.neuron) artifacts.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument(
        "--base",
        choices=["sd15", "sdxl"],
        default="sd15",
        help="Which base to compile. sd15 = guaranteed floor; sdxl = primary/quality (segfault risk).",
    )
    p.add_argument(
        "--lora",
        default=None,
        help="Optional path to a trained style LoRA dir to FUSE at compile time "
        "(inline_weights_to_neff=True). Default: config.LORA_DIR.",
    )
    p.add_argument(
        "--out",
        default=config.ARTIFACT_DIR,
        help="Output dir for the serialized Neuron pipeline (what serve.py loads).",
    )
    return p.parse_args()


def _resolve_base(base: str):
    """Return (PipelineClass, model_id, controlnet_id, pretty_name) for the chosen base."""
    # Imported here (not at module top) so `python compile.py --help` works even on a
    # box where optimum-neuron isn't installed yet, and so import errors are explained.
    try:
        from optimum.neuron import (
            NeuronStableDiffusionControlNetPipeline,
            NeuronStableDiffusionXLControlNetPipeline,
        )
    except Exception as exc:  # noqa: BLE001
        print(
            "ERROR: could not import optimum-neuron pipelines. "
            "Run setup_neuron.sh on the Neuron box first.\n"
            f"  underlying import error: {exc}",
            file=sys.stderr,
        )
        raise SystemExit(2)

    if base == "sd15":
        return (
            NeuronStableDiffusionControlNetPipeline,
            config.SD15_MODEL,
            config.SD15_CONTROLNET,
            "SD1.5 + scribble-ControlNet (floor)",
        )
    # sdxl
    return (
        NeuronStableDiffusionXLControlNetPipeline,
        config.SDXL_MODEL,
        config.SDXL_CONTROLNET,
        "SDXL + canny-ControlNet (primary/quality)",
    )


def _compile(pipe_cls, model_id: str, controlnet_id: str, lora_dir, out_dir: str):
    """Run the actual from_pretrained(export=True) compile and save."""
    # Static compile kwargs straight from config (Neuron requires FIXED shapes).
    kwargs = dict(
        export=True,
        controlnet_ids=controlnet_id,
        batch_size=config.BATCH,
        height=config.SHAPE,
        width=config.SHAPE,
        num_images_per_prompt=config.NUM_IMAGES,
        auto_cast="matmul",
        auto_cast_type=config.DTYPE,  # "bf16"
    )

    if lora_dir:
        # Fuse the trained style LoRA into the compiled graph. inline_weights_to_neff
        # bakes the (already-fused) weights into the .neff so serve.py needs nothing extra.
        # ASSUMPTION: lora_model_ids + inline_weights_to_neff are accepted by this
        # optimum-neuron release's from_pretrained (per spec's verified API list). If a
        # version rejects them, use the optimum-cli path in the module docstring instead.
        kwargs["lora_model_ids"] = lora_dir
        kwargs["inline_weights_to_neff"] = True
        print(f"[lora] fusing LoRA from: {lora_dir} (inline_weights_to_neff=True)")
    else:
        print("[lora] no LoRA — compiling the bare base + ControlNet")

    print(f"[compile] model      : {model_id}")
    print(f"[compile] controlnet : {controlnet_id}")
    print(f"[compile] shape      : {config.SHAPE}x{config.SHAPE}  batch={config.BATCH}  "
          f"num_images={config.NUM_IMAGES}  dtype={config.DTYPE}")
    print("[compile] tracing + compiling… (this is the slow part: minutes, not seconds)")

    pipe = pipe_cls.from_pretrained(model_id, **kwargs)

    print(f"[save] writing Neuron artifacts -> {out_dir}")
    os.makedirs(out_dir, exist_ok=True)
    pipe.save_pretrained(out_dir)
    return pipe


def main() -> int:
    args = parse_args()
    _set_neuron_env()

    # --lora defaults to config.LORA_DIR (which is None until a LoRA is trained).
    lora_dir = args.lora if args.lora is not None else config.LORA_DIR
    if lora_dir and not os.path.isdir(lora_dir):
        print(f"ERROR: --lora dir does not exist: {lora_dir}", file=sys.stderr)
        return 2

    pipe_cls, model_id, controlnet_id, pretty = _resolve_base(args.base)

    out_dir = os.path.abspath(args.out)
    print("==============================================================")
    print(" CAELLUM compile  (env: AWS Neuron inf2, no CUDA)")
    print(f"   base : {args.base}  -> {pretty}")
    print(f"   out  : {out_dir}")
    print(f"   lora : {lora_dir if lora_dir else '(none)'}")
    print("==============================================================")

    t0 = time.time()
    try:
        _compile(pipe_cls, model_id, controlnet_id, lora_dir, out_dir)
    except Exception as exc:  # noqa: BLE001
        elapsed = time.time() - t0
        if args.base == "sdxl":
            # Known neuronx-cc segfault on Amazon Linux 2 (aws-neuron-sdk #1002), plus
            # SDXL's much larger RAM footprint. Give the user the concrete fallback.
            print("\n--------------------------------------------------------------")
            print("SDXL COMPILE FAILED after %.0fs." % elapsed)
            print("This is most likely the known neuronx-cc segfault on Amazon Linux 2")
            print("(aws-neuron-sdk issue #1002), or an OOM (SDXL+ControlNet needs ~120GB RAM).")
            print("")
            print("FALLBACK: retry with the guaranteed SD1.5 floor:")
            print("    python compile.py --base sd15")
            print("Or prefer the HF Neuron DLAMI / Ubuntu image for the SDXL path.")
            print("--------------------------------------------------------------")
            print("\nUnderlying error:")
            traceback.print_exc()
            return 1
        # sd15 (the floor) failing is unexpected — surface the full traceback.
        print("\nSD1.5 COMPILE FAILED after %.0fs (unexpected — the floor should work)." % elapsed)
        traceback.print_exc()
        return 1

    elapsed = time.time() - t0
    print("==============================================================")
    print(f"DONE. Compiled '{args.base}' in {elapsed:.0f}s ({elapsed / 60:.1f} min).")
    print(f"Artifacts: {out_dir}")
    print("Reminder: the FIRST inference is a 45-60s COLD START — serve.py pre-warms")
    print("with a dummy pipe(...) call at startup so real /enhance requests stay ~2-3s.")
    print("==============================================================")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
