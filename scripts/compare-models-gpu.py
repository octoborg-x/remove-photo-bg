#!/usr/bin/env python3
"""Compare 1024x1024 fp16 vs 512x512 fp32 masks from the T4 GPU
benchmark (smoke-results/benchmark-t4/masks).

Resizes both computed masks to a common 1024x1024 grid so IoU / abs-diff are
measured on the same pixels; edge sharpness is still measured at each mask's
native resolution (that is the real trade-off the coarser input makes).

Usage: python3 scripts/compare-models-gpu.py [RESULTS_DIR]   # default smoke-results/benchmark-t4
Writes <RESULTS_DIR>/quality-t4/quality.json + per-image cutout PNGs.
"""
import json
import os
import sys

import numpy as np
from PIL import Image

BASE = sys.argv[1] if len(sys.argv) > 1 else "smoke-results/benchmark-t4"
OUT = f"{BASE}/quality-t4"
MASKS = f"{BASE}/masks"
IMAGES = ["product-scent-bottle", "animal-buddy-dog", "glass-wine"]
os.makedirs(OUT, exist_ok=True)

rows = []
for name in IMAGES:
    a = np.load(f"{MASKS}/{name}_1024-fp16.npy")  # 1024 fp16, sigmoid applied
    b = np.load(f"{MASKS}/{name}_512-fp32.npy")   # 512 fp32, probability output

    def up(m):
        return np.asarray(
            Image.fromarray(m.astype(np.float32)).resize((1024, 1024), Image.BILINEAR),
            dtype=np.float32,
        )

    a1, b1 = up(a), up(b)
    ta, tb = a1 >= 0.5, b1 >= 0.5
    inter = np.logical_and(ta, tb).sum()
    union = np.logical_or(ta, tb).sum()
    diff = np.abs(a1 - b1)

    def gmag(m):
        bnd = np.abs(m - 0.5) < 0.25
        return float(np.hypot(*np.gradient(m))[bnd].mean()) if bnd.any() else 0.0

    def band_width(m, size):
        # Grid-independent softness, in ORIGINAL-image pixels: transition-band
        # area divided by the length of the 0.5 level set, both after resampling
        # to the source size so the two masks are measured on the same grid.
        # A per-pixel gradient changes when only the sampling grid changes; this
        # does not.
        r = np.asarray(Image.fromarray(m.astype(np.float32)).resize(size, Image.BILINEAR),
                       dtype=np.float32)
        band = (r > 0.25) & (r < 0.75)
        fg = r >= 0.5
        p = np.pad(fg, 1)  # False border => image edge counts as boundary
        enclosed = p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
        boundary = fg & ~enclosed
        return float(band.sum() / max(boundary.sum(), 1))

    src_size = Image.open(f"test-images/{name}.jpg").size

    row = {
        "image": name,
        "iou_at_0.5": round(float(inter / union), 5),
        "mean_abs_diff": round(float(diff.mean()), 5),
        "p99_abs_diff": round(float(np.percentile(diff, 99)), 4),
        "max_abs_diff": round(float(diff.max()), 4),
        "fg_1024": round(float((a >= 0.5).mean()), 4),
        "fg_512": round(float((b >= 0.5).mean()), 4),
        # Edge sharpness is measured on the common 1024 grid. np.gradient is a
        # per-pixel finite difference, so the same physical edge yields a larger
        # slope on the coarser 512 grid purely from pixel spacing; a
        # native-grid comparison therefore reports 512 as "sharper" even for an
        # identical edge. Do not compare a and b at their native resolutions.
        "edge_1024_common": round(gmag(a1), 4),
        "edge_512_common": round(gmag(b1), 4),
        "bandwidth_1024_px": round(band_width(a, src_size), 3),
        "bandwidth_512_px": round(band_width(b, src_size), 3),
    }
    rows.append(row)
    print(json.dumps(row))

    for tag, m in (("1024", a), ("512", b)):
        src = Image.open(f"test-images/{name}.jpg").convert("RGB")
        alpha = Image.fromarray((m * 255).round().astype(np.uint8), "L").resize(src.size, Image.BILINEAR)
        out = src.copy()
        out.putalpha(alpha)
        out.save(f"{OUT}/{name}_{tag}_cut.png")

mean_iou = float(np.mean([r["iou_at_0.5"] for r in rows]))
result = {
    "rows": rows,
    "mean_iou": round(mean_iou, 5),
    "mean_abs_diff": round(float(np.mean([r["mean_abs_diff"] for r in rows])), 5),
}
with open(f"{OUT}/quality.json", "w") as f:
    json.dump(result, f, indent=2)
print(f"\nmean IoU @0.5: {mean_iou:.5f}")
print(f"mean abs diff: {result['mean_abs_diff']:.5f}")
print(f"wrote {OUT}/quality.json")
