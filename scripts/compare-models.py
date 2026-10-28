#!/usr/bin/env python3
"""Compare 1024x1024 fp16 vs 512x512 fp32 masks (already saved as float .npy)."""
import json
import os

import numpy as np
from PIL import Image

Q = "smoke-results/measurements/masks"
IMAGES = ["product-scent-bottle", "animal-buddy-dog", "glass-wine"]
rows = []


def up(m, size=(1024, 1024)):
    """Bilinear resize to a common grid so both masks are measured on the same
    pixels. np.gradient is a per-pixel finite difference: the same physical edge
    reads steeper on the coarser 512 native grid, which made a native-grid
    comparison report 512 as *sharper* - a measurement artifact, not the model.
    Always compare on a common grid."""
    return np.asarray(
        Image.fromarray(m.astype(np.float32)).resize(size, Image.BILINEAR),
        dtype=np.float32,
    )


def gmag(m):
    bnd = np.abs(m - 0.5) < 0.25
    return float(np.hypot(*np.gradient(m))[bnd].mean()) if bnd.any() else 0.0


def band_width(m, size):
    # Grid-independent softness in ORIGINAL-image pixels: area of the transition
    # band divided by the length of the 0.5 level set, both after resampling to
    # the source size, so the two masks are measured on the same grid.
    r = up(m, size)
    band = (r > 0.25) & (r < 0.75)
    fg = r >= 0.5
    p = np.pad(fg, 1)  # false border => image edge counts as boundary
    enclosed = p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    boundary = fg & ~enclosed
    return float(band.sum() / max(boundary.sum(), 1))


for name in IMAGES:
    a = np.load(f"{Q}/{name}_1024.npy")  # 1024 fp16 export, sigmoid applied
    b = np.load(f"{Q}/{name}_512.npy")   # 512 fp32 export, probability output

    # Both masks resized to a common 1024 grid: IoU / abs-diff and the edge
    # gradient are then measured on identical pixels.
    a1, b1 = up(a), up(b)
    ta, tb = a1 >= 0.5, b1 >= 0.5
    inter = np.logical_and(ta, tb).sum()
    union = np.logical_or(ta, tb).sum()
    diff = np.abs(a1 - b1)
    src_size = Image.open(f"test-images/{name}.jpg").size

    row = {
        "image": name,
        "iou_at_0.5": round(float(inter / union), 5),
        "mean_abs_diff": round(float(diff.mean()), 5),
        "p99_abs_diff": round(float(np.percentile(diff, 99)), 4),
        "max_abs_diff": round(float(diff.max()), 4),
        "fg_1024": round(float((a >= 0.5).mean()), 4),
        "fg_512": round(float((b >= 0.5).mean()), 4),
        # Edge sharpness measured on the common 1024 grid. Native-grid gradients
        # are grid-dependent and report 512 as "sharper"; do not use them.
        "edge_1024_common": round(gmag(a1), 4),
        "edge_512_common": round(gmag(b1), 4),
        "bandwidth_1024_px": round(band_width(a, src_size), 3),
        "bandwidth_512_px": round(band_width(b, src_size), 3),
    }
    rows.append(row)
    print(json.dumps(row))

    # Visual: side-by-side cutouts on a checkerboard, at native size.
    for tag, m in (("1024", a), ("512", b)):
        src = Image.open(f"test-images/{name}.jpg").convert("RGB")
        out = src.copy()
        out.putalpha(Image.fromarray((m * 255).round().astype(np.uint8), mode="L"))
        out.save(f"{Q}/{name}_{tag}_cut.png")

mean_iou = float(np.mean([r["iou_at_0.5"] for r in rows]))
print(f"\nmean IoU @0.5: {mean_iou:.5f}")
print(f"mean abs diff: {np.mean([r['mean_abs_diff'] for r in rows]):.5f}")

with open(f"{Q}/quality.json", "w") as f:
    json.dump({"rows": rows, "mean_iou": round(mean_iou, 5)}, f, indent=2)
