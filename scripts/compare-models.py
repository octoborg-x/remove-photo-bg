#!/usr/bin/env python3
"""Compare 1024x1024 fp16 vs 512x512 fp32 masks (already saved as float .npy)."""
import json
import os

import numpy as np
from PIL import Image

Q = "smoke-results/measurements/masks"
IMAGES = ["product-scent-bottle", "animal-buddy-dog", "glass-wine"]
rows = []

for name in IMAGES:
    a = np.load(f"{Q}/{name}_1024.npy")  # 1024 fp16 export, sigmoid applied
    b = np.load(f"{Q}/{name}_512.npy")   # 512 fp32 export, probability output

    ta, tb = a >= 0.5, b >= 0.5
    inter = np.logical_and(ta, tb).sum()
    union = np.logical_or(ta, tb).sum()
    diff = np.abs(a - b)

    # Edge sharpness: mean gradient magnitude across the transition band, which
    # is where a coarser input grid would show up first.
    band = np.abs(a - 0.5) < 0.25
    gmag = lambda m: float(np.hypot(*np.gradient(m))[band].mean()) if band.any() else 0.0

    row = {
        "image": name,
        "iou_at_0.5": round(float(inter / union), 5),
        "mean_abs_diff": round(float(diff.mean()), 5),
        "p99_abs_diff": round(float(np.percentile(diff, 99)), 4),
        "max_abs_diff": round(float(diff.max()), 4),
        "fg_1024": round(float(ta.mean()), 4),
        "fg_512": round(float(tb.mean()), 4),
        "edge_1024": round(gmag(a), 4),
        "edge_512": round(gmag(b), 4),
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
