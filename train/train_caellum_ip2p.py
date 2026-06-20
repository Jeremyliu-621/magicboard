#!/usr/bin/env python
"""
CAELLUM — InstructPix2Pix fine-tune (PRIMARY trainer).

ENV: Colab / Kaggle GPU (CUDA). NOT the Neuron box. This script is self-contained
(it does NOT import services/caellum/config.py — Colab has no repo). The few constants
it needs (SHAPE / categories / prompt style) are inlined below; keep them in sync with
services/caellum/config.py.

What it does
------------
Fine-tunes Stable-Diffusion-v1-5 in the InstructPix2Pix style on our paired dataset:
    original_image = ROUGH kid's sketch   (data/caellum_pairs/rough/<id>.png)
    edited_image   = FINISHED game asset  (data/caellum_pairs/finished/<id>.png)
    edit_prompt    = "turn this into a clean game {label}"
The model learns: (rough image, instruction) -> finished image.

Adapted from the official diffusers example:
    https://github.com/huggingface/diffusers/blob/main/examples/instruct_pix2pix/train_instruct_pix2pix.py
We keep a focused, readable training loop (the official example is ~1000 lines) but the
math is identical: encode the FINISHED target with the VAE -> add noise -> the UNet sees
[noisy_target_latents | original(ROUGH)_image_latents] (9-channel input: 4 noise + 4 image
+ ... actually 8 channels: 4 noisy + 4 conditioning) plus the text embedding of the edit
prompt -> predict the noise (epsilon). This is the InstructPix2Pix conditioning.

The dataset is read from a local metadata.jsonl written by data/roughen.py:
    {"id":"0001","rough":"rough/0001.png","finished":"finished/0001.png",
     "label":"gun","edit_prompt":"turn this into a clean game gun"}

Output: a full diffusers pipeline saved to --output_dir (unet re-fitted to 8-channel
conv_in), loadable later for compile/serve experiments or further conversion.

Example invocation (Colab)
--------------------------
    accelerate launch train/train_caellum_ip2p.py \
        --pretrained_model stable-diffusion-v1-5/stable-diffusion-v1-5 \
        --data_dir data/caellum_pairs \
        --output_dir caellum_ip2p_out \
        --resolution 512 \
        --train_batch_size 4 \
        --gradient_accumulation_steps 4 \
        --max_train_steps 2000 \
        --learning_rate 5e-5 \
        --mixed_precision fp16

You can also run it without accelerate launch (it will use a single device):
    python train/train_caellum_ip2p.py --data_dir data/caellum_pairs ...
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
from diffusers import AutoencoderKL, DDPMScheduler, StableDiffusionInstructPix2PixPipeline, UNet2DConditionModel
from diffusers.optimization import get_scheduler
from transformers import CLIPTextModel, CLIPTokenizer

# --------------------------------------------------------------------------------------
# Inlined constants — keep in sync with services/caellum/config.py
# (Colab has no repo, so we cannot `import config`.)
# --------------------------------------------------------------------------------------
SHAPE = 512  # config.SHAPE — all images are 512x512, white background.

# config.CATEGORIES — only used here as a sanity hint / default prompt fallback.
# KEEP IN SYNC with services/caellum/config.py CATEGORY_BEHAVIOR (the keys).
CATEGORIES = [
    "sword", "knife", "bat", "hammer", "axe",
    "gun", "bow", "slingshot",
    "bomb", "ball", "rock", "bottle", "dart",
    "food", "fruit", "bread", "cake",
    "star", "heart", "gem", "crown",
    "spikes", "saw", "fire", "trap",
    "spring", "trampoline",
    "cloud", "block", "plank",
    "crate", "barrel", "balloon", "key", "coin",
]


def _fallback_prompt(label: str) -> str:
    """Mirror of the edit-prompt convention from the spec / roughen.py."""
    return f"turn this into a clean game {label}"


# --------------------------------------------------------------------------------------
# Dataset: read the local metadata.jsonl produced by data/roughen.py
# --------------------------------------------------------------------------------------
class CaellumPairDataset(Dataset):
    """Yields (rough_pixels, finished_pixels, edit_prompt_str) per pair.

    Pixel tensors are in [-1, 1] (VAE convention). The rough image is the
    InstructPix2Pix "original_image" (conditioning); finished is "edited_image"
    (the target the model must learn to produce).
    """

    def __init__(self, data_dir: str, resolution: int):
        self.data_dir = Path(data_dir)
        meta_path = self.data_dir / "metadata.jsonl"
        if not meta_path.exists():
            raise FileNotFoundError(
                f"metadata.jsonl not found at {meta_path}. "
                f"Run data/roughen.py first to build {data_dir}."
            )

        self.rows: list[dict] = []
        with meta_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    self.rows.append(json.loads(line))
        if not self.rows:
            raise ValueError(f"{meta_path} is empty — no training pairs.")

        # Deterministic 512x512 transform -> [-1, 1]. White bg already baked by roughen.py.
        self.tfm = transforms.Compose(
            [
                transforms.Resize(resolution, interpolation=transforms.InterpolationMode.BILINEAR),
                transforms.CenterCrop(resolution),
                transforms.ToTensor(),  # [0,1]
                transforms.Normalize([0.5], [0.5]),  # -> [-1,1]
            ]
        )
        print(f"[data] loaded {len(self.rows)} pairs from {meta_path}")

    def __len__(self) -> int:
        return len(self.rows)

    def _load(self, rel: str) -> torch.Tensor:
        img = Image.open(self.data_dir / rel).convert("RGB")
        return self.tfm(img)

    def __getitem__(self, idx: int):
        row = self.rows[idx]
        rough = self._load(row["rough"])
        finished = self._load(row["finished"])
        prompt = row.get("edit_prompt") or _fallback_prompt(row.get("label", "object"))
        return {"original": rough, "edited": finished, "prompt": prompt}


def collate(batch):
    original = torch.stack([b["original"] for b in batch]).contiguous().float()
    edited = torch.stack([b["edited"] for b in batch]).contiguous().float()
    prompts = [b["prompt"] for b in batch]
    return {"original": original, "edited": edited, "prompts": prompts}


# --------------------------------------------------------------------------------------
# Adapt the SD1.5 UNet conv_in from 4 -> 8 input channels (InstructPix2Pix surgery).
# This is exactly what the official train_instruct_pix2pix.py does: the conditioning
# image latents (4ch) are concatenated to the noisy latents (4ch). New weight columns
# are zero-initialised so training starts from the base txt2img behaviour.
# --------------------------------------------------------------------------------------
def expand_unet_conv_in(unet: UNet2DConditionModel) -> UNet2DConditionModel:
    in_channels = 8
    out_channels = unet.conv_in.out_channels
    if unet.conv_in.in_channels == in_channels:
        print("[unet] conv_in already 8-channel (resuming an IP2P unet).")
        return unet

    unet.register_to_config(in_channels=in_channels)
    with torch.no_grad():
        new_conv_in = torch.nn.Conv2d(
            in_channels,
            out_channels,
            unet.conv_in.kernel_size,
            unet.conv_in.stride,
            unet.conv_in.padding,
        )
        new_conv_in.weight.zero_()
        new_conv_in.weight[:, :4, :, :].copy_(unet.conv_in.weight)
        new_conv_in.bias.copy_(unet.conv_in.bias)
        unet.conv_in = new_conv_in
    print("[unet] conv_in expanded 4 -> 8 channels (extra channels zero-init).")
    return unet


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="CAELLUM InstructPix2Pix fine-tune (Colab/CUDA).")
    # Either runwayml/stable-diffusion-v1-5 or the maintained mirror work; default to the
    # maintained mirror (the original runwayml repo has been periodically unavailable).
    p.add_argument("--pretrained_model", type=str, default="stable-diffusion-v1-5/stable-diffusion-v1-5")
    p.add_argument("--data_dir", type=str, default="data/caellum_pairs")
    p.add_argument("--output_dir", type=str, default="caellum_ip2p_out")
    p.add_argument("--resolution", type=int, default=SHAPE)
    p.add_argument("--train_batch_size", type=int, default=4)
    p.add_argument("--max_train_steps", type=int, default=2000)
    p.add_argument("--learning_rate", type=float, default=5e-5)
    p.add_argument("--gradient_accumulation_steps", type=int, default=4)
    p.add_argument("--mixed_precision", type=str, default="fp16", choices=["no", "fp16", "bf16"])
    p.add_argument("--conditioning_dropout_prob", type=float, default=0.05,
                   help="IP2P: randomly drop image+text conditioning for classifier-free guidance.")
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

    # ---- load the frozen pieces + the trainable UNet ----
    print(f"[load] pretrained = {args.pretrained_model}")
    tokenizer = CLIPTokenizer.from_pretrained(args.pretrained_model, subfolder="tokenizer")
    text_encoder = CLIPTextModel.from_pretrained(args.pretrained_model, subfolder="text_encoder")
    vae = AutoencoderKL.from_pretrained(args.pretrained_model, subfolder="vae")
    unet = UNet2DConditionModel.from_pretrained(args.pretrained_model, subfolder="unet")
    noise_scheduler = DDPMScheduler.from_pretrained(args.pretrained_model, subfolder="scheduler")

    unet = expand_unet_conv_in(unet)

    vae.requires_grad_(False)
    text_encoder.requires_grad_(False)
    unet.train()

    weight_dtype = torch.float32
    if args.mixed_precision == "fp16":
        weight_dtype = torch.float16
    elif args.mixed_precision == "bf16":
        weight_dtype = torch.bfloat16
    # frozen modules run in the mixed-precision dtype; the UNet stays fp32 for stable grads.
    vae.to(accelerator.device, dtype=weight_dtype)
    text_encoder.to(accelerator.device, dtype=weight_dtype)

    optimizer = torch.optim.AdamW(unet.parameters(), lr=args.learning_rate)

    dataset = CaellumPairDataset(args.data_dir, args.resolution)
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

    # Pre-compute the empty/null text embedding for conditioning dropout (CFG).
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
    print(f"[train] {len(dataset)} pairs | {args.max_train_steps} steps | ~{num_epochs} epochs")

    global_step = 0
    for epoch in range(num_epochs):
        for batch in loader:
            with accelerator.accumulate(unet):
                original = batch["original"].to(accelerator.device, dtype=weight_dtype)
                edited = batch["edited"].to(accelerator.device, dtype=weight_dtype)

                # 1) VAE-encode the FINISHED target -> latents we will denoise.
                latents = vae.encode(edited).latent_dist.sample() * vae_scale
                latents = latents.to(dtype=unet.dtype)

                # 2) VAE-encode the ROUGH original -> conditioning latents (mode, no noise).
                original_latents = vae.encode(original).latent_dist.mode()
                original_latents = original_latents.to(dtype=unet.dtype)

                # 3) sample noise + timesteps, build noisy target latents.
                noise = torch.randn_like(latents)
                bsz = latents.shape[0]
                timesteps = torch.randint(
                    0, noise_scheduler.config.num_train_timesteps, (bsz,), device=latents.device
                ).long()
                noisy_latents = noise_scheduler.add_noise(latents, noise, timesteps)

                # 4) text embedding of the edit prompt.
                encoder_hidden_states = encode_prompts(batch["prompts"]).to(dtype=unet.dtype)

                # 5) InstructPix2Pix conditioning dropout for classifier-free guidance:
                #    independently null out the text and the image conditioning.
                if args.conditioning_dropout_prob > 0:
                    rand = torch.rand(bsz, device=latents.device)
                    # drop text -> use the empty-string embedding
                    text_drop = (rand < 2 * args.conditioning_dropout_prob).view(bsz, 1, 1)
                    null_embed = encode_prompts([""] * bsz).to(dtype=unet.dtype)
                    encoder_hidden_states = torch.where(text_drop, null_embed, encoder_hidden_states)
                    # drop image -> zero the conditioning latents
                    img_keep = (rand >= args.conditioning_dropout_prob).view(bsz, 1, 1, 1).to(original_latents.dtype)
                    img_keep = img_keep * ((rand < 3 * args.conditioning_dropout_prob).logical_not()).view(bsz, 1, 1, 1).to(original_latents.dtype)
                    original_latents = original_latents * img_keep

                # 6) concat: [noisy target (4ch) | conditioning rough (4ch)] -> 8-channel input.
                model_input = torch.cat([noisy_latents, original_latents], dim=1)

                # 7) predict noise + epsilon MSE loss (DDPM eps objective).
                model_pred = unet(model_input, timesteps, encoder_hidden_states).sample
                loss = F.mse_loss(model_pred.float(), noise.float(), reduction="mean")

                accelerator.backward(loss)
                if accelerator.sync_gradients:
                    accelerator.clip_grad_norm_(unet.parameters(), args.max_grad_norm)
                optimizer.step()
                lr_scheduler.step()
                optimizer.zero_grad()

            if accelerator.sync_gradients:
                global_step += 1
                if global_step % 20 == 0:
                    print(f"[step {global_step}/{args.max_train_steps}] loss={loss.item():.4f}")

                if global_step % args.checkpointing_steps == 0 and accelerator.is_main_process:
                    ckpt = os.path.join(args.output_dir, f"checkpoint-{global_step}")
                    accelerator.unwrap_model(unet).save_pretrained(os.path.join(ckpt, "unet"))
                    print(f"[ckpt] saved {ckpt}")

                if global_step >= args.max_train_steps:
                    break
        if global_step >= args.max_train_steps:
            break

    # ---- save the full InstructPix2Pix pipeline ----
    accelerator.wait_for_everyone()
    if accelerator.is_main_process:
        print("[save] assembling StableDiffusionInstructPix2PixPipeline ...")
        pipeline = StableDiffusionInstructPix2PixPipeline.from_pretrained(
            args.pretrained_model,
            unet=accelerator.unwrap_model(unet),
            text_encoder=text_encoder,
            vae=vae,
            torch_dtype=weight_dtype,
        )
        pipeline.save_pretrained(args.output_dir)
        print(f"[done] pipeline saved to {args.output_dir}")
        print(f"[done] download {args.output_dir}/ to the Neuron box for conversion/inference.")


if __name__ == "__main__":
    main()
