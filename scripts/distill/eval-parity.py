#!/usr/bin/env python3
"""Measure a candidate ONNX artifact against the fp32 teacher over the eval set.

Reports, per image and aggregate:
  - max / mean absolute alpha error (the app's real output is a soft alpha)
  - IoU and Dice at the production 0.5 threshold
  - pixels flipped across 0.5
  - mean absolute error inside the soft band (0.05 < a < 0.95), where edge
    quality actually lives
  - boundary-band mean error

Agreement with the teacher is *not* accuracy: there is no ground-truth mask.
Every number here is model-to-model agreement.

Usage:
    python3 -m scripts.distill.eval-parity \
        --teacher public/models/model_512_int0_fp32.onnx \
        --candidate work/opt/cand_all.onnx --out work/opt/all.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


def preprocess(p: Path, size: int = 512) -> np.ndarray:
    im = Image.open(p).convert("RGB").resize((size, size), Image.BILINEAR)
    a = np.asarray(im, dtype=np.float32) / 255.0
    a = (a - MEAN) / STD
    return a.transpose(2, 0, 1)[None].astype(np.float32)


def session(path: Path) -> ort.InferenceSession:
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])


def metrics(a: np.ndarray, b: np.ndarray) -> dict:
    a = a.reshape(-1)
    b = b.reshape(-1)
    d = np.abs(a - b)
    ta, tb = a >= 0.5, b >= 0.5
    inter = np.logical_and(ta, tb).sum()
    union = np.logical_or(ta, tb).sum()
    band = (a > 0.05) & (a < 0.95)
    # Both models can return an all-background mask (no subject found). That is
    # agreement, not IoU 0; report it as a separate flag so it never pollutes the
    # aggregate.
    empty = bool(union == 0)
    return {
        "max_abs": float(d.max()),
        "mae": float(d.mean()),
        "iou": 1.0 if empty else float(inter / union),
        "dice": 1.0 if empty else float(2 * inter / max(1, ta.sum() + tb.sum())),
        "flips": int((ta != tb).sum()),
        "band_mae": float(d[band].mean()) if band.any() else 0.0,
        "empty": empty,
        "bit_exact": bool(np.array_equal(a, b)),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--teacher", required=True, type=Path)
    ap.add_argument("--candidate", required=True, type=Path)
    ap.add_argument("--images", default="eval/images", type=Path)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()

    imgs = sorted(args.images.glob("*.jpg")) + sorted(args.images.glob("*.png"))
    if not imgs:
        raise SystemExit(f"no images in {args.images}")
    st, sc = session(args.teacher), session(args.candidate)

    rows = []
    for i, p in enumerate(imgs, 1):
        x = preprocess(p)
        a = st.run(None, {"input_image": x})[0]
        b = sc.run(None, {"input_image": x})[0]
        m = metrics(a, b)
        m["image"] = p.name
        rows.append(m)
        print(f"[{i:>2}/{len(imgs)}] {p.name:32} maxAbs {m['max_abs']:.4f} "
              f"IoU {m['iou']:.5f} bandMAE {m['band_mae']:.5f} flips {m['flips']}",
              flush=True)

    agg = {
        "n_images": len(rows),
        "max_abs": max(r["max_abs"] for r in rows),
        "mean_iou": float(np.mean([r["iou"] for r in rows])),
        "min_iou": min(r["iou"] for r in rows),
        "mean_dice": float(np.mean([r["dice"] for r in rows])),
        "total_flips": sum(r["flips"] for r in rows),
        "max_flips": max(r["flips"] for r in rows),
        "n_images_with_flips": sum(1 for r in rows if r["flips"] > 0),
        "max_band_mae": max(r["band_mae"] for r in rows),
        "n_empty_both": sum(r["empty"] for r in rows),
        "n_bit_exact": sum(r["bit_exact"] for r in rows),
        "worst_image": min(rows, key=lambda r: r["iou"])["image"],
    }
    print("\naggregate:", json.dumps(agg, indent=2))
    flagged = [r for r in rows if r["flips"] > 0 or r["iou"] < 0.99]
    if flagged:
        print("\nimages with threshold flips or IoU < 0.99:")
        for r in sorted(flagged, key=lambda r: r["iou"]):
            print(f"  {r['image']:32} IoU {r['iou']:.5f} flips {r['flips']:>6} "
                  f"bandMAE {r['band_mae']:.5f}")
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps({"aggregate": agg, "per_image": rows}, indent=2))


if __name__ == "__main__":
    raise SystemExit(main())
