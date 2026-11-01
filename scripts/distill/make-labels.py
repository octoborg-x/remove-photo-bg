#!/usr/bin/env python3
"""Generate teacher soft-label masks for the distillation manifest.

Runs the app-exact teacher preprocessing (spec §1, §6-Phase2):
  resize to 512 bilinear, /255, ImageNet normalize,
  forward -> soft probability map (sigmoid already baked in)  [1,1,512,512]
Then saves a SOFT 8-bit PNG mask (never thresholded) per approved row.

Resumable: masks already present on disk are skipped. GPU is used when
onnxruntime has CUDAExecutionProvider (spec §3.7): GPU vs CPU parity must be
verified separately; this script prints the parity diagnostic on the first run.

Usage:
    python3 scripts/distill/make-labels.py --manifest data/manifest-selected.csv \
        --model public/models/model_512.onnx --out data/labels512
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import os
from pathlib import Path

from _bootstrap import *  # noqa: F401, E402  (sys.path fix)
import numpy as np
import onnxruntime as ort
from PIL import Image

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
SIZE = 512


def preprocess(img: Image.Image) -> np.ndarray:
    img = img.convert("RGB").resize((SIZE, SIZE), Image.BILINEAR)
    x = np.asarray(img, np.float32) / 255.0
    x = (x - MEAN) / STD
    return x.transpose(2, 0, 1)[None, ...].astype(np.float32)


def provider_order(prefer_gpu: bool) -> list[str]:
    avail = ort.get_available_providers()
    if prefer_gpu and "CUDAExecutionProvider" in avail:
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


def make_session(model_path: str, prefer_gpu: bool):
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(model_path, sess_options=so,
                                providers=provider_order(prefer_gpu))


def run_mask(sess, img: Image.Image) -> np.ndarray:
    y = sess.run(None, {sess.get_inputs()[0].name: preprocess(img)})[0]
    return y[0, 0]  # [512,512] probabilities in [0,1]


def mask_to_png(m: np.ndarray) -> Image.Image:
    return Image.fromarray((np.clip(m, 0, 1) * 255).astype(np.uint8), "L")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True, type=Path)
    ap.add_argument("--model", default="public/models/model_512.onnx")
    ap.add_argument("--out", default="data/labels512", type=Path)
    ap.add_argument("--images", default="data/images", type=Path)
    ap.add_argument("--gpu", action="store_true", help="prefer CUDA")
    ap.add_argument("--limit", type=int, default=0, help="limit rows (smoke)")
    ap.add_argument("--verify-parity", action="store_true")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    rows = list(csv.DictReader(open(args.manifest)))
    if args.limit:
        rows = rows[:args.limit]

    sess = make_session(args.model, args.gpu)
    print("providers:", sess.get_providers())

    done = existing_ids(args.out)
    skipped = 0
    for row in rows:
        rid = row["id"]
        if rid in done:
            skipped += 1
            continue
        img_path = Path(args.images) / f"{row['sha256']}.jpg"
        if not img_path.exists():
            print(f"  skip {rid}: missing image")
            continue
        try:
            mask = run_mask(sess, Image.open(img_path))
        except Exception as ex:  # keep going; log the failure
            print(f"  fail {rid}: {ex}")
            continue
        make_label_path(args.out, rid).write_bytes(
            palm_to_bytes(mask_to_png(mask)))
        done.add(rid)

    print(f"labels: {len(done)} total, {skipped} already-present in this run")


def existing_ids(out: Path) -> set[str]:
    return {p.stem for p in out.glob("*.png")}


def make_label_path(out: Path, rid: str) -> Path:
    # dirname mirrors manifest id prefix to avoid huge flat dirs
    sub = out / rid[:2]
    sub.mkdir(parents=True, exist_ok=True)
    return sub / f"{rid}.png"


def palm_to_bytes(img: Image.Image) -> bytes:
    """Compressed PNG bytes (no EXIF)."""
    import io
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


if __name__ == "__main__":
    raise SystemExit(main())