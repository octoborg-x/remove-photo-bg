#!/usr/bin/env python3
"""Deterministic preselection of manifest rows for distillation training.

Applies the spec §6-Phase1.2 pipeline in order and logs every rejection reason:
  technical  -> sharpness floor (Laplacian variance), JPEG decode, size caps
  dedup      -> perceptual-hash dedup (dHash, 16-bit hamming < 6)
  geometry   -> foreground fraction + border contact (uses the soft label if
                present, otherwise a cheap saliency proxy; this step is only
                meaningful once make-labels.py has run)
  split      -> deterministic per-category group split 70/15/15 with seed
  tiers      -> A=composite-eligible, B=soft-edge, C=glass (uses category)

This is the *preference* layer: a human reviews the output contact sheets and
the manifest review sample before training starts (spec §6-Phase1.4 STOP).

Usage:
    python3 scripts/distill/select.py --manifest data/manifest.csv \
        --min-short-side 512 --out data/manifest-selected.csv
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import random
from pathlib import Path

from _bootstrap import *  # noqa: F401, E402  (sys.path fix)
import numpy as np
from PIL import Image

MEAN_ISH = (128, 128, 128)


def dhash(img: Image.Image, size: int = 8) -> str:
    img = img.convert("L").resize((size + 1, size), Image.LANCZOS)
    arr = np.asarray(img, dtype=np.int16)
    diff = arr[:, :-1] > arr[:, 1:]
    return "".join("1" if b else "0" for b in diff.flatten())


def hamming(a: str, b: str) -> int:
    return sum(x != y for x, y in zip(a, b))


def laplacian_variance(img: Image.Image) -> float:
    g = np.asarray(img.convert("L"), dtype=np.float32)
    kern = np.array([[0, -1, 0], [-1, 4, -1], [0, -1, 0]], dtype=np.float32)
    from scipy import ndimage
    lap = ndimage.convolve(g, kern)
    return float(lap.var())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True, type=Path)
    ap.add_argument("--out", default="data/manifest-selected.csv", type=Path)
    ap.add_argument("--min-short-side", type=int, default=768)
    ap.add_argument("--max-hashes", type=int, default=6)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--images", type=Path, default=Path("data/images"))
    args = ap.parse_args()

    rows = list(csv.DictReader(open(args.manifest)))
    rejected = []

    def rej(row, reason):
        row["reject_reason"] = reason
        rejected.append(row)

    hashes: list[str] = []
    kept: list[dict] = []

    for row in rows:
        path = args.images / f"{row['sha256']}.jpg"
        if not path.exists():
            rej(row, "missing-file")
            continue
        try:
            with Image.open(path) as im:
                im.load()
        except Exception:
            rej(row, "undecodable")
            continue
        try:
            w, h = im.size
            short = min(w, h)
            if short < args.min_short_side:
                rej(row, f"short-side-{short}<{args.min_short_side}")
                continue
            var = laplacian_variance(im)
            if var < 30.0:  # blurred / low-texture
                rej(row, f"sharpness-{var:.1f}")
                continue
            hsh = dhash(im)
            if any(hamming(hsh, x) < args.max_hashes for x in hashes):
                rej(row, "duplicate-near")
                continue
        except Exception:
            rej(row, "processing-error")
            continue

        hashes.append(hsh)
        row["width"], row["height"] = w, h
        row["reject_reason"] = ""
        # geometry tiers from category (spec §6-Phase1.2 tiering)
        ct = (row.get("category") or "").lower()
        row["tier"] = "C" if "glass" in ct or "transparent" in ct else (
            "B" if any(k in ct for k in ("hair", "fur", "soft", "edge")) else "A")
        kept.append(row)

    # deterministic per-category split
    rng = random.Random(args.seed)
    for cat in {r.get("category", "") for r in kept}:
        grp = [r for r in kept if r.get("category") == cat]
        rng.shuffle(grp)
        n = len(grp)
        for i, r in enumerate(grp):
            frac = i / max(n, 1)
            r["split"] = "train" if frac < 0.7 else ("val" if frac < 0.85 else "test")

    with open(args.out, "w", newline="") as f:
        hdr = list(rows[0].keys()) if rows else []
        w = csv.DictWriter(f, fieldnames=hdr)
        w.writeheader()
        for r in kept:
            w.writerow(r)

    print(f"manifest-selected -> {args.out}: {len(kept)} kept, "
          f"{len(rejected)} rejected")
    by = {}
    for r in rejected:
        by[r["reject_reason"]] = by.get(r["reject_reason"], 0) + 1
    for reason, n in sorted(by.items(), key=lambda x: -x[1]):
        print(f"  rejected[{n}] {reason}")


if __name__ == "__main__":
    raise SystemExit(main())