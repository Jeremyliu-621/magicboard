#!/usr/bin/env python3
"""
CAELLUM data pipeline — ROUGHEN + PAIRING (Colab / CPU, self-contained).

ENV: Colab/Kaggle (or any plain CPU box). This script has NO CUDA, no torch, and
NO repo dependency — it only needs opencv-python, pillow, numpy (and OPTIONALLY
controlnet_aux for the HED edge detector). It deliberately does NOT `import config`
because Colab does not have this repo; the few constants it needs (SHAPE) are
inlined below with a "keep in sync" note.

WHAT IT DOES
  For every finished teacher PNG (produced upstream by data/gen_teacher.py), build a
  crude "kid's rough sketch" version on a 512x512 WHITE canvas:
    1. extract edges/contours  (controlnet_aux HEDdetector if installed, else cv2.Canny)
    2. simplify them           (cv2.approxPolyDP + a downscale/threshold pass)
    3. add hand-jitter/wobble to the points and randomly DROP some segments so the
       drawing looks unfinished, like a child stopped halfway
    4. draw thick, rounded, slightly-wobbly strokes
  It writes the paired dataset that train/train_caellum_ip2p.py consumes:

    data/caellum_pairs/
      rough/<id>.png        # crude input  (512x512, white bg)
      finished/<id>.png     # polished target, normalized (512x512, white bg)
      metadata.jsonl        # one row per pair (see ROW FORMAT below)

  ROW FORMAT (exact, per the spec):
    {"id":"0001","rough":"rough/0001.png","finished":"finished/0001.png",
     "label":"gun","edit_prompt":"turn this into a clean game gun"}

TEACHER LAYOUT (this script auto-detects, gen_teacher.py owns the producer side):
  * per-category subdirs:   <teacher>/gun/0001.png, <teacher>/sword/3.png ...   (label = subdir)
  * flat with label prefix: <teacher>/gun_0001.png, <teacher>/laser_blaster-02.png (label = stem prefix)
  * an optional manifest:   <teacher>/metadata.jsonl with {"file":..., "label":...} rows
                            (or {"image":..., "label":...}) — used when present, else we infer.

EXAMPLE INVOCATION (Colab cell or shell):
  python data/roughen.py \
      --teacher data/caellum_teacher \
      --out data/caellum_pairs \
      --jitter 6.0 --drop 0.18 --variants 1 --seed 0

  # heavier "messier kid" look:
  python data/roughen.py --jitter 10 --drop 0.30 --thickness 9 --variants 2
"""

from __future__ import annotations

import argparse
import json
import os
import random
from pathlib import Path
from typing import Iterable

import cv2
import numpy as np
from PIL import Image

# ---------------------------------------------------------------------------
# Inlined constants — KEEP IN SYNC WITH services/caellum/config.py
# (Colab has no repo, so we cannot `import config` here.)
# ---------------------------------------------------------------------------
SHAPE = 512  # config.SHAPE — every image is 512x512, white background.

# Recognized teacher image extensions.
IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


# ---------------------------------------------------------------------------
# Optional HED edge detector (controlnet_aux). Loaded lazily, falls back to Canny.
# ---------------------------------------------------------------------------
def try_load_hed():
    """Return a controlnet_aux HEDdetector if available, else None (use Canny)."""
    try:
        from controlnet_aux import HEDdetector  # type: ignore
    except Exception:
        return None
    try:
        # Annotators ship on the HF Hub under this id; first call downloads weights.
        det = HEDdetector.from_pretrained("lllyasviel/Annotators")
        print("[roughen] using controlnet_aux HEDdetector for edges")
        return det
    except Exception as exc:  # network down / weights missing -> Canny
        print(f"[roughen] HEDdetector unavailable ({exc!r}); falling back to Canny")
        return None


# ---------------------------------------------------------------------------
# Image helpers
# ---------------------------------------------------------------------------
def load_on_white(path: Path, size: int = SHAPE) -> Image.Image:
    """Load any image, flatten transparency onto WHITE, fit-pad to size x size."""
    im = Image.open(path)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        rgba = im.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, rgba).convert("RGB")
    else:
        im = im.convert("RGB")

    # Contain into a square white canvas (preserve aspect, never crop the subject).
    w, h = im.size
    scale = size / max(w, h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    im = im.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGB", (size, size), (255, 255, 255))
    canvas.paste(im, ((size - nw) // 2, (size - nh) // 2))
    return canvas


def edges_from_rgb(rgb: np.ndarray, hed, canny_lo: int, canny_hi: int) -> np.ndarray:
    """Return a uint8 edge map (255 = edge on black) for the given HxWx3 RGB image."""
    if hed is not None:
        try:
            out = hed(Image.fromarray(rgb))  # PIL grayscale-ish edges on black
            e = np.asarray(out.convert("L"))
            _, e = cv2.threshold(e, 40, 255, cv2.THRESH_BINARY)
            return e
        except Exception as exc:
            print(f"[roughen] HED failed on a frame ({exc!r}); using Canny for it")
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    return cv2.Canny(gray, canny_lo, canny_hi)


def simplify_contours(edge: np.ndarray, epsilon_frac: float, min_pts: int):
    """
    Downscale+threshold to fatten/merge strokes, then extract & polygon-simplify
    contours with approxPolyDP. Returns a list of Nx2 int point arrays (full-res).
    """
    h, w = edge.shape[:2]

    # Downscale + threshold pass: merges nearby edges into chunky strokes, which is
    # what a kid actually draws (no hairline detail).
    small = cv2.resize(edge, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
    small = cv2.dilate(small, np.ones((2, 2), np.uint8), iterations=1)
    _, small = cv2.threshold(small, 30, 255, cv2.THRESH_BINARY)
    big = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    big = cv2.dilate(big, np.ones((3, 3), np.uint8), iterations=1)

    contours, _ = cv2.findContours(big, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    polys: list[np.ndarray] = []
    for c in contours:
        peri = cv2.arcLength(c, closed=False)
        if peri < 24:  # skip dust/specks
            continue
        approx = cv2.approxPolyDP(c, epsilon_frac * peri, closed=False)
        pts = approx.reshape(-1, 2)
        if len(pts) >= min_pts:
            polys.append(pts.astype(np.float32))
    return polys


def jitter_and_drop(
    polys: Iterable[np.ndarray],
    rng: random.Random,
    jitter: float,
    drop: float,
) -> list[np.ndarray]:
    """
    Add per-point hand wobble and randomly DROP whole segments / split polylines so
    the sketch looks incomplete. Returns a list of polylines (each Nx2 float).
    """
    np_rng = np.random.default_rng(rng.randint(0, 2**31 - 1))
    out: list[np.ndarray] = []
    for pts in polys:
        # Drop entire strokes sometimes (kid didn't draw that part).
        if rng.random() < drop:
            continue

        # Per-point Gaussian wobble (shaky hand).
        noise = np_rng.normal(0.0, jitter, size=pts.shape).astype(np.float32)
        wob = pts + noise

        # Add a slow low-frequency drift so lines bow, not just buzz.
        if len(wob) >= 3:
            t = np.linspace(0, np.pi * rng.uniform(0.5, 2.0), len(wob))
            drift = (np.stack([np.sin(t), np.cos(t)], axis=1)
                     * jitter * 0.8 * rng.uniform(0.4, 1.0)).astype(np.float32)
            wob = wob + drift

        # Randomly break a polyline into pieces and drop some pieces -> gaps.
        if len(wob) >= 4 and rng.random() < min(0.6, drop * 2.0):
            cut = rng.randint(1, len(wob) - 2)
            head, tail = wob[: cut + 1], wob[cut:]
            for seg in (head, tail):
                if len(seg) >= 2 and rng.random() > drop:
                    out.append(seg)
        else:
            out.append(wob)
    return out


def draw_rough(
    polylines: list[np.ndarray],
    size: int,
    thickness: int,
    rng: random.Random,
) -> Image.Image:
    """Draw thick, rounded, anti-aliased strokes on a WHITE canvas (dark ink)."""
    canvas = np.full((size, size, 3), 255, np.uint8)
    for seg in polylines:
        if len(seg) < 2:
            continue
        pts = np.clip(np.round(seg), 0, size - 1).astype(np.int32)
        # Slight per-stroke thickness wobble + near-black (not pure) ink for a marker feel.
        t = max(2, thickness + rng.randint(-2, 2))
        ink = rng.randint(15, 55)
        cv2.polylines(
            canvas, [pts], isClosed=False, color=(ink, ink, ink),
            thickness=t, lineType=cv2.LINE_AA,
        )
        # Round the endpoints so strokes read as pen taps, not hard cuts.
        for end in (pts[0], pts[-1]):
            cv2.circle(canvas, tuple(int(v) for v in end), max(1, t // 2),
                       (ink, ink, ink), -1, lineType=cv2.LINE_AA)
    return Image.fromarray(canvas)


# ---------------------------------------------------------------------------
# Teacher discovery (find images + infer labels)
# ---------------------------------------------------------------------------
def _clean_label(raw: str) -> str:
    """Normalize a label token: underscores/dashes -> spaces, strip, lowercase."""
    return raw.replace("_", " ").replace("-", " ").strip().lower()


def _label_from_stem(stem: str) -> str:
    """
    Infer a label from a flat filename stem like 'laser_blaster-0007' or 'gun_3'.
    Strip a trailing numeric/index token; whatever remains is the label.
    """
    parts = stem.replace("-", "_").split("_")
    while len(parts) > 1 and parts[-1].isdigit():
        parts.pop()
    # also handle a stem that is e.g. 'gun0007' (digits glued on)
    if len(parts) == 1:
        s = parts[0]
        stripped = s.rstrip("0123456789")
        if stripped and stripped != s:
            return _clean_label(stripped)
    return _clean_label("_".join(parts))


def load_manifest(teacher: Path) -> dict[str, str]:
    """
    If the teacher dir has a metadata/manifest jsonl, return {basename: label}.
    Accepts rows keyed by file|image|path|finished and label|category|class.
    Returns {} when there is no manifest.
    """
    mapping: dict[str, str] = {}
    for name in ("metadata.jsonl", "manifest.jsonl"):
        mf = teacher / name
        if not mf.exists():
            continue
        with mf.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                fkey = (row.get("file") or row.get("image")
                        or row.get("path") or row.get("finished"))
                lab = (row.get("label") or row.get("category") or row.get("class"))
                if fkey and lab:
                    mapping[Path(str(fkey)).name] = _clean_label(str(lab))
        if mapping:
            print(f"[roughen] read {len(mapping)} label hints from {mf.name}")
        break
    return mapping


def discover(teacher: Path) -> list[tuple[Path, str]]:
    """Return [(image_path, label)] from the teacher dir (subdirs OR flat OR manifest)."""
    manifest = load_manifest(teacher)
    items: list[tuple[Path, str]] = []
    for p in sorted(teacher.rglob("*")):
        if not (p.is_file() and p.suffix.lower() in IMG_EXTS):
            continue
        rel = p.relative_to(teacher)
        if p.name in manifest:                       # 1) explicit manifest wins
            label = manifest[p.name]
        elif len(rel.parts) > 1:                     # 2) per-category subdir
            label = _clean_label(rel.parts[0])
        else:                                        # 3) flat: infer from filename
            label = _label_from_stem(p.stem)
        if not label:
            label = "thing"
        items.append((p, label))
    return items


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="Roughen finished CAELLUM teacher PNGs into kid-sketch pairs.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--teacher", default="data/caellum_teacher",
                    help="dir of finished target images (gen_teacher.py output)")
    ap.add_argument("--out", default="data/caellum_pairs",
                    help="output dataset dir (rough/, finished/, metadata.jsonl)")
    ap.add_argument("--variants", type=int, default=1,
                    help="rough variants to generate per finished image")
    ap.add_argument("--jitter", type=float, default=6.0,
                    help="hand-wobble strength in pixels (std of point noise)")
    ap.add_argument("--drop", type=float, default=0.18,
                    help="probability of dropping a stroke/segment (0..1, incompleteness)")
    ap.add_argument("--thickness", type=int, default=7,
                    help="base stroke thickness in pixels")
    ap.add_argument("--epsilon", type=float, default=0.012,
                    help="approxPolyDP epsilon as a fraction of contour perimeter")
    ap.add_argument("--min-pts", type=int, default=2,
                    help="minimum points for a simplified contour to be kept")
    ap.add_argument("--canny-lo", type=int, default=60, help="Canny low threshold")
    ap.add_argument("--canny-hi", type=int, default=160, help="Canny high threshold")
    ap.add_argument("--no-hed", action="store_true",
                    help="force cv2.Canny even if controlnet_aux HED is installed")
    ap.add_argument("--seed", type=int, default=0, help="base RNG seed (reproducible)")
    ap.add_argument("--limit", type=int, default=0,
                    help="cap on teacher images processed (0 = all; for quick tests)")
    return ap.parse_args()


def main() -> None:
    args = parse_args()
    teacher = Path(args.teacher)
    out = Path(args.out)
    rough_dir = out / "rough"
    fin_dir = out / "finished"

    if not teacher.is_dir():
        raise SystemExit(f"[roughen] teacher dir not found: {teacher} "
                         f"(run data/gen_teacher.py first)")

    rough_dir.mkdir(parents=True, exist_ok=True)
    fin_dir.mkdir(parents=True, exist_ok=True)

    items = discover(teacher)
    if args.limit > 0:
        items = items[: args.limit]
    if not items:
        raise SystemExit(f"[roughen] no images found under {teacher}")
    print(f"[roughen] found {len(items)} finished image(s) in {teacher}")

    hed = None if args.no_hed else try_load_hed()
    if hed is None:
        print("[roughen] edge source: cv2.Canny")

    # Rewrite metadata fresh so reruns are idempotent (no duplicate rows).
    meta_path = out / "metadata.jsonl"
    rows: list[dict] = []

    idx = 0
    label_counts: dict[str, int] = {}
    for src, label in items:
        try:
            fin_img = load_on_white(src, SHAPE)
        except Exception as exc:
            print(f"[roughen] SKIP unreadable {src} ({exc!r})")
            continue
        rgb = np.asarray(fin_img)

        edge = edges_from_rgb(rgb, hed, args.canny_lo, args.canny_hi)
        polys = simplify_contours(edge, args.epsilon, args.min_pts)

        for v in range(max(1, args.variants)):
            idx += 1
            pid = f"{idx:04d}"
            rng = random.Random((args.seed * 1_000_003) + idx)

            polylines = jitter_and_drop(polys, rng, args.jitter, args.drop)
            # Guarantee the rough is never totally empty (keep one stroke if all dropped).
            if not polylines and polys:
                polylines = [polys[rng.randrange(len(polys))]]
            rough_img = draw_rough(polylines, SHAPE, args.thickness, rng)

            rough_rel = f"rough/{pid}.png"
            fin_rel = f"finished/{pid}.png"
            rough_img.save(out / rough_rel)
            fin_img.save(out / fin_rel)

            rows.append({
                "id": pid,
                "rough": rough_rel,
                "finished": fin_rel,
                "label": label,
                "edit_prompt": f"turn this into a clean game {label}",
            })
            label_counts[label] = label_counts.get(label, 0) + 1

        if idx % 25 == 0 or idx == len(items) * max(1, args.variants):
            print(f"[roughen] {idx} pairs written...")

    with meta_path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(f"\n[roughen] DONE: {len(rows)} pairs")
    print(f"[roughen]   rough/    -> {rough_dir}")
    print(f"[roughen]   finished/ -> {fin_dir}")
    print(f"[roughen]   metadata  -> {meta_path}")
    print(f"[roughen]   labels seen ({len(label_counts)}):")
    for lab in sorted(label_counts):
        print(f"[roughen]     {lab:<16} {label_counts[lab]}")


if __name__ == "__main__":
    main()
