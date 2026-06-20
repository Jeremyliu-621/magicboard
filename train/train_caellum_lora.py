#!/usr/bin/env python
"""
CAELLUM — text-to-image LoRA fine-tune (LIGHTER FALLBACK trainer).

ENV: Colab / Kaggle GPU (CUDA). NOT the Neuron box. Self-contained — does NOT import
services/caellum/config.py (Colab has no repo). The constants it needs are inlined below;
keep them in sync with services/caellum/config.py.

What it does
------------
When the full InstructPix2Pix fine-tune is too heavy (or we just want a cheap style
adapter), train a standard PEFT LoRA on the SD1.5 UNet using the FINISHED game-asset PNGs
as the targets and a label-conditioned prompt as the text. This is a plain text-to-image
LoRA on the polished targets — it teaches the "clean 2d game asset" look. At serve time
the same LoRA rides on top of img2img/ControlNet over the rough sketch.

Crucially it saves LoRA weights as:
    <output_dir>/pytorch_lora_weights.safetensors
so services/caellum/compile.py can fuse them at AOT-compile time via:
    from_pretrained(..., lora_model_ids=<output_dir>, inline_weights_to_neff=True)

Adapted from the official diffusers LoRA example:
    https://github.com/huggingface/diffusers/blob/main/examples/text_to_image/train_text_to_image_lora.py

Dataset: read from the local metadata.jsonl written by data/roughen.py. We only use the
FINISHED image + the positive (style) prompt here; the rough image is ignored by this
fallback (it is used by the InstructPix2Pix trainer instead).

Example invocation (Colab)
--------------------------
    accelerate launch train/train_caellum_lora.py \
        --pretrained_model stable-diffusion-v1-5/stable-diffusion-v1-5 \
        --data_dir data/caellum_pairs \
        --output_dir caellum_lora_out \
        --resolution 512 \
        --train_batch_size 4 \
        --gradient_accumulation_steps 1 \
        --max_train_steps 1500 \
        --learning_rate 1e-4 \
        --rank 16 \
        --mixed_precision fp16
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path

import torch
import torch.nn.functional as F
from PIL import Image
from torch.utils.data import DataLoader, Dataset
from torchvision import transforms

from accelerate import Accelerator
from accelerate.utils import set_seed
from diffusers import AutoencoderKL, DDPMScheduler, StableDiffusionPipeline, UNet2DConditionModel
from diffusers.optimization import get_scheduler
from diffusers.utils import convert_state_dict_to_diffusers
from peft import LoraConfig
from peft.utils import get_peft_model_state_dict
from safetensors.torch import save_file
from transformers import CLIPTextModel, CLIPTokenizer

# --------------------------------------------------------------------------------------
# Inlined constants — keep in sync with services/caellum/config.py
# --------------------------------------------------------------------------------------
SHAPE = 512  # config.SHAPE

CATEGORIES = [
    "gun", "pistol", "laser blaster", "slingshot", "bow", "crossbow", "cannon",
    "sword", "dagger", "axe", "hammer", "mace", "spear", "shuriken", "boomerang",
    "spike ball", "shield", "bomb", "grenade", "star", "magic staff", "wand",
    "potion", "key", "anvil", "fish", "rocket",
]


def style_prompt_for(label: str) -> str:
    """Mirror of config.prompt_for() — the positive 'clean game asset' style prompt."""
    return (
        f"a clean 2d game asset of a {label}, bold black outline, flat shading, "
        f"centered, simple bold shapes, crisp lines, white background, sticker, icon"
    )


# --------------------------------------------------------------------------------------
# Dataset: FINISHED image + style prompt (rough image unused by this fallback).
# --------------------------------------------------------------------------------------
class FinishedStyleDataset(Dataset):
    def __init__(self, data_dir: str, resolution: int):
        self.data_dir = Path(data_dir)
        meta_path = self.data_dir / "metadata.jsonl"
        if not meta_path.exists():
            raise FileNotFoundError(
                f"metadata.jsonl not found at {meta_path}. Run data/roughen.py first."
            )

        self.rows: list[dict] = []
        with meta_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    self.rows.append(json.loads(line))
        if not self.rows:
            raise ValueError(f"{meta_path} is empty — no training pairs.")

        self.tfm = transforms.Compose(
            [
                transforms.Resize(resolution, interpolation=transforms.InterpolationMode.BILINEAR),
                transforms.CenterCrop(resolution),
                transforms.ToTensor(),
                transforms.Normalize([0.5], [0.5]),
            ]
        )
        print(f"[data] loaded {len(self.rows)} finished targets from {meta_path}")

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, idx: int):
        row = self.rows[idx]
        img = Image.open(self.data_dir / row["finished"]).convert("RGB")
        label = row.get("label", "object")
        return {"pixels": self.tfm(img), "prompt": style_prompt_for(label)}


def collate(batch):
    pixels = torch.stack([b["pixels"] for b in batch]).contiguous().float()
    prompts = [b["prompt"] for b in batch]
    return {"pixels": pixels, "prompts": prompts}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="CAELLUM LoRA fine-tune fallback (Colab/CUDA).")
    p.add_argument("--pretrained_model", type=str, default="stable-diffusion-v1-5/stable-diffusion-v1-5")
    p.add_argument("--data_dir", type=str, default="data/caellum_pairs")
    p.add_argument("--output_dir", type=str, default="caellum_lora_out")
    p.add_argument("--resolution", type=int, default=SHAPE)
    p.add_argument("--train_batch_size", type=int, default=4)
    p.add_argument("--max_train_steps", type=int, default=1500)
    p.add_argument("--learning_rate", type=float, default=1e-4)
    p.add_argument("--gradient_accumulation_steps", type=int, default=1)
    p.add_argument("--mixed_precision", type=str, default="fp16", choices=["no", "fp16", "bf16"])
    p.add_argument("--rank", type=int, default=16, help="LoRA rank (r).")
    p.add_argument("--lora_alpha", type=int, default=16)
    p.add_argument("--dataloader_num_workers", type=int, default=2)
    p.add_argument("--lr_warmup_steps", type=int, default=0)
    p.add_argument("--lr_scheduler", type=str, default="constant")
    p.add_argument("--max_grad_norm", type=float, default=1.0)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--checkpointing_steps", type=int, default=500)
    return p.parse_args()


def main() -> None:
    args = parse_args()
    print(f"[args] {vars(args)}")

    accelerator = Accelerator(
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        mixed_precision=args.mixed_precision,
    )
    if args.seed is not None:
        set_seed(args.seed)

    os.makedirs(args.output_dir, exist_ok=True)

    print(f"[load] pretrained = {args.pretrained_model}")
    tokenizer = CLIPTokenizer.from_pretrained(args.pretrained_model, subfolder="tokenizer")
    text_encoder = CLIPTextModel.from_pretrained(args.pretrained_model, subfolder="text_encoder")
    vae = AutoencoderKL.from_pretrained(args.pretrained_model, subfolder="vae")
    unet = UNet2DConditionModel.from_pretrained(args.pretrained_model, subfolder="unet")
    noise_scheduler = DDPMScheduler.from_pretrained(args.pretrained_model, subfolder="scheduler")

    # Freeze the base — only LoRA adapters train.
    vae.requires_grad_(False)
    text_encoder.requires_grad_(False)
    unet.requires_grad_(False)

    weight_dtype = torch.float32
    if args.mixed_precision == "fp16":
        weight_dtype = torch.float16
    elif args.mixed_precision == "bf16":
        weight_dtype = torch.bfloat16

    vae.to(accelerator.device, dtype=weight_dtype)
    text_encoder.to(accelerator.device, dtype=weight_dtype)
    unet.to(accelerator.device, dtype=weight_dtype)

    # ---- attach LoRA to the UNet attention projections (standard SD LoRA targets) ----
    lora_config = LoraConfig(
        r=args.rank,
        lora_alpha=args.lora_alpha,
        init_lora_weights="gaussian",
        target_modules=["to_k", "to_q", "to_v", "to_out.0"],
    )
    unet.add_adapter(lora_config)

    # Cast trainable LoRA params back to fp32 for stable optimisation.
    lora_params = []
    for param in unet.parameters():
        if param.requires_grad:
            param.data = param.data.float()
            lora_params.append(param)
    print(f"[lora] trainable LoRA tensors: {len(lora_params)} (rank={args.rank})")

    optimizer = torch.optim.AdamW(lora_params, lr=args.learning_rate)

    dataset = FinishedStyleDataset(args.data_dir, args.resolution)
    loader = DataLoader(
        dataset,
        batch_size=args.train_batch_size,
        shuffle=True,
        collate_fn=collate,
        num_workers=args.dataloader_num_workers,
        drop_last=True,
    )

    lr_scheduler = get_scheduler(
        args.lr_scheduler,
        optimizer=optimizer,
        num_warmup_steps=args.lr_warmup_steps * args.gradient_accumulation_steps,
        num_training_steps=args.max_train_steps * args.gradient_accumulation_steps,
    )

    unet, optimizer, loader, lr_scheduler = accelerator.prepare(unet, optimizer, loader, lr_scheduler)

    def encode_prompts(prompts: list[str]) -> torch.Tensor:
        tok = tokenizer(
            prompts,
            padding="max_length",
            max_length=tokenizer.model_max_length,
            truncation=True,
            return_tensors="pt",
        )
        return text_encoder(tok.input_ids.to(accelerator.device))[0]

    vae_scale = vae.config.scaling_factor

    steps_per_epoch = max(1, math.ceil(len(loader) / args.gradient_accumulation_steps))
    num_epochs = math.ceil(args.max_train_steps / steps_per_epoch)
    print(f"[train] {len(dataset)} targets | {args.max_train_steps} steps | ~{num_epochs} epochs")

    global_step = 0
    for epoch in range(num_epochs):
        for batch in loader:
            with accelerator.accumulate(unet):
                pixels = batch["pixels"].to(accelerator.device, dtype=weight_dtype)

                latents = vae.encode(pixels).latent_dist.sample() * vae_scale
                latents = latents.to(dtype=weight_dtype)

                noise = torch.randn_like(latents)
                bsz = latents.shape[0]
                timesteps = torch.randint(
                    0, noise_scheduler.config.num_train_timesteps, (bsz,), device=latents.device
                ).long()
                noisy_latents = noise_scheduler.add_noise(latents, noise, timesteps)

                encoder_hidden_states = encode_prompts(batch["prompts"]).to(dtype=weight_dtype)

                model_pred = unet(noisy_latents, timesteps, encoder_hidden_states).sample
                loss = F.mse_loss(model_pred.float(), noise.float(), reduction="mean")

                accelerator.backward(loss)
                if accelerator.sync_gradients:
                    accelerator.clip_grad_norm_(lora_params, args.max_grad_norm)
                optimizer.step()
                lr_scheduler.step()
                optimizer.zero_grad()

            if accelerator.sync_gradients:
                global_step += 1
                if global_step % 20 == 0:
                    print(f"[step {global_step}/{args.max_train_steps}] loss={loss.item():.4f}")

                if global_step % args.checkpointing_steps == 0 and accelerator.is_main_process:
                    _save_lora(accelerator, unet, os.path.join(args.output_dir, f"checkpoint-{global_step}"))

                if global_step >= args.max_train_steps:
                    break
        if global_step >= args.max_train_steps:
            break

    accelerator.wait_for_everyone()
    if accelerator.is_main_process:
        _save_lora(accelerator, unet, args.output_dir)
        print(f"[done] LoRA saved to {args.output_dir}/pytorch_lora_weights.safetensors")
        print("[done] fuse on the Neuron box: "
              "from_pretrained(..., lora_model_ids=<dir>, inline_weights_to_neff=True)")


def _save_lora(accelerator: Accelerator, unet, out_dir: str) -> None:
    """Write pytorch_lora_weights.safetensors with diffusers-style key names.

    We use the diffusers helper to write the canonical file so that both
    diffusers' load_lora_weights() and optimum-neuron's lora_model_ids fusion can
    consume it.
    """
    os.makedirs(out_dir, exist_ok=True)
    unwrapped = accelerator.unwrap_model(unet)
    lora_state = convert_state_dict_to_diffusers(get_peft_model_state_dict(unwrapped))

    # StableDiffusionPipeline.save_lora_weights writes the canonical
    # pytorch_lora_weights.safetensors with the "unet." prefix that loaders expect.
    StableDiffusionPipeline.save_lora_weights(
        save_directory=out_dir,
        unet_lora_layers=lora_state,
        safe_serialization=True,
    )
    target = os.path.join(out_dir, "pytorch_lora_weights.safetensors")
    if not os.path.exists(target):
        # Defensive fallback: write the file directly if the helper named it differently.
        save_file({f"unet.{k}": v for k, v in lora_state.items()}, target)
    print(f"[ckpt] LoRA weights -> {target}")


if __name__ == "__main__":
    main()
