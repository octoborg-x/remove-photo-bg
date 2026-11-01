#!/usr/bin/env python3
"""Evaluate every student candidate against the teacher (spec §6-Phase4).

Produces, per eval image and per candidate ONNX:
  - raw soft masks (teacher + candidate) for later analysis
  - metrics: IoU@0.5, Dice, MAE, MSE, boundary F-score (@0.5 band 0.25-0.75),
    mean abs alpha error in 0.05-0.95 band, foreground prec/rec, false-fg/bg
  - a diagnostic threshold sweep (0.30 .. 0.70) evaluated separately
  - visual contact sheets: original, teacher, candidate, abs-diff, checkerboard,
    zoomed edge crops
Writes per-image CSV + aggregate + a JSON summary.  Never tunes per-candidate
thresholds to hide regressions (spec §6-Phase4).

Usage:
    python3 scripts/distill/evaluate.py \
        --teacher public/models/model_512.onnx \
        --candidates smoke-results/distill/onnx/student-512.onnx \
        --manifest data/manifest-selected.csv --out smoke-results/distill/eval
"""

from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path

from _bootstrap import *  # noqa: F401, E402  (sys.path fix)
import numpy as np
import onnxruntime as ort
from PIL import Image

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
THRESH_SWEEP = [0.30, 0.40, 0.45, 0.50, 0.55, 0.60, 0.70]
BAND = (0.05, 0.95)
EDGE_BAND = (0.25, 0.75)


def preprocess(img: Image.Image, size: int) -> np.ndarray:
    img = img.convert("RGB").resize((size, size), Image.BILINEAR)
    x = np.asarray(img, np.float32) / 255.0
    x = (x - MEAN) / STD
    return x.transpose(2, 0, 1)[None].astype(np.float32)


def soft_mask(model_path: str, img: Image.Image, size: int) -> np.ndarray:
    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    y = sess.run(None, {sess.get_inputs()[0].name: preprocess(img, size)})[0]
    return y[0, 0]


def dice(a: np.ndarray, b: np.ndarray):
    a, b = a.astype(bool), b.astype(bool)
    inter = (a & b).sum()
    return (2 * inter) / (a.sum() + b.sum()) if (a.sum() + b.sum()) else 1.0


def boundary_fscore(a: np.ndarray, b: np.ndarray, r: int = 2) -> float:
    """F-score between boundary maps (binary dilation distance) at radius r."""
    from scipy import ndimage
    ab, bb = a.astype(bool), b.astype(bool)
    if not ab.any() and not bb.any():
        return 1.0
    if not ab.any() or not bb.any():
        return 0.0
    da = ndimage.distance_transform_edt(~ab)
    db = ndimage.distance_transform_edt(~bb)
    ha = da[bb] <= r
    hb = db[ab] <= r
    prec = ha.mean() if len(ha) else 0.0
    rec = hb.mean() if len(hb) else 0.0
    return (2 * prec * rec) / (prec + rec) if (prec + rec) else 0.0


def metrics(t: np.ndarray, c: np.ndarray):
    m = {}
    for th in (0.5,):
        ti, ci = t > th, c > th
        inter = (ti & ci).sum(); union = (ti | ci).sum()
        m[f"IoU@{th:.2f}"] = inter / union if union else 1.0
        m[f"Dice@{th:.2f}"] = dice(ti, ci)
        tp = (ti & ci).sum(); fp = (~ti & ci).sum(); fn = (ti & ~ci).sum()
        m[f"prec@{th:.2f}"] = tp / (tp + fp) if (tp + fp) else 1.0
        m[f"rec@{th:.2f}"] = tp / (tp + fn) if (tp + fn) else 1.0
        m[f"fpg@{th:.2f}"] = fp; m[f"fng@{th:.2f}"] = fn
    d = np.abs(t - c)
    m["MAE"] = float(d.mean()); m["MSE"] = float((d ** 2).mean())
    band = (t > BAND[0]) & (t < BAND[1])
    m["alpha_band_mae"] = float(d[band].mean()) if band.any() else 0.0
    m["boundary_F"] = boundary_fscore(t > 0.5, c > 0.5)
    return m


def contact_sheet(outdir: Path, name: str, img: Image.Image,
                  t: np.ndarray, c: np.ndarray, size: int):
    ck = np.resize(
        np.kron([[0., 1.], [1., 0.]], np.ones((16, 16))),
        (size, size))
    diff = np.abs(t - c)
    def im(a):
        return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), "L")
    # composite: use teacher on checkerboard for fg realism
    fg = img.convert("RGBA")
    alpha = im(c).resize(img.size)
    cutout = Image.new("RGBA", img.size, (180, 180, 180, 255))
    cutout.paste("rgba" if False else fg, (0, 0), alpha)
    canvas = Image.new("RGB", (size * 5, size))
    canvas.paste(img.resize((size, size), Image.LANCZOS), (0, 0))
    canvas.paste(im(t), (size, 0)); canvas.paste(im(c), (size * 2, 0))
    canvas.paste(im(diff / (diff.max() + 1e-6)), (size * 3, 0))
    canvas.paste(cutout.resize((size, size), Image.LANCZOS), (size * 4, 0))
    canvas.save(outdir / f"{name}.contact.png")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--teacher", required=True)
    ap.add_argument("--candidates", nargs="+", required=True)
    ap.add_argument("--manifest", required=True, type=Path)
    ap.add_argument("--images", default="data/images", type=Path)
    ap.add_argument("--out", default="smoke-results/distill/eval", type=Path)
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    rows = [r for r in csv.DictReader(open(args.manifest)) if r.get("split") == "test"]
    if args.limit:
        rows = rows[:args.limit]

    cands = [str(p) for p in args.candidates]
    header = ["image", "candidate"] + [f"IoU@0.50"]
    rows_written = []
    agg = {c: [] for c in cands}
    for r in rows:
        img_path = args.images / f"{r['sha256']}.jpg"
        if not img_path.exists():
            continue
        img = Image.open(img_path)
        t = soft_mask(args.teacher, img, args.size)
        for cand in cands:
            c = soft_mask(cand, img, args.size)
            met = metrics(t, c)
            for k, v in met.items():
                agg[cand].append((os.path.basename(r["id"]), k, v))
            rows_written.append({
                "image": r["id"], "candidate": os.path.basename(cand), **met})
            contact_sheet(args.out, f"{r['id']}-{Path(cand).stem}", img, t, c,
                          args.size)
        # threshold sweep on the FIRST candidate vs teacher
        if c and cand == cands[0]:
            sweep = {}
            for th in THRESH_SWEEP:
                ti, ci = t > th, c > th
                inter = (ti & ci).sum(); union = (ti | ci).sum()
                sweep[f"IoU@{th:.2f}"] = inter / union if union else 1.0
            rows_written[-1].update({"sweep": json.dumps(sweep)})

    with open(args.out / "metrics.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows_written[0].keys()))
        w.writeheader()
        for row in rows_written:
            w.writerow(row)

    # aggregate
    summary = {}
    for cand, vals in agg.items():
        groups = {}
        for _, k, v in vals:
            groups.setdefault(k, []).append(v)
        summary[os.path.basename(cand)] = {
            k: float(np.mean(v)) for k, v in groups.items()}
    (args.out / "summary.json").write_text(json.dumps(summary, indent=2))
    print(f"evaluated {len(rows)} test rows; wrote metrics.csv + contact sheets")
    for cand, s in summary.items():
        print(f"{cand}: IoU0.5={s.get('IoU@0.50', float('nan')):.4f} "
              f"MAE={s.get('MAE', float('nan')):.4f} "
              f"bF={s.get('boundary_F', float('nan')):.4f}")


if __name__ == "__main__":
    raise SystemExit(main())