#!/usr/bin/env python3
"""Analyse the output PNGs from an evaluation run and write quality metrics.

`run-eval.mjs` records what the *product* did (success, dimensions, timing) and
saves every output PNG. This script measures the *visible* result from those
PNGs — the thing a customer judges — and aggregates it per category.

Because there is no ground-truth mask for these images, these are descriptive
edge-character metrics, not accuracy. Their value is regression comparison: run
the same set after a model/runtime change and a shift in the numbers shows which
categories moved. Visual review of `outputs/*.png` remains the authority for
"is the mask right".

Metrics per image (from the alpha channel):
  foreground_frac     share of the image kept (alpha >= 0.5)
  soft_edge_frac      share of pixels in the transition band (0.02..0.98);
                      high on hair/fur, low on hard product edges
  edge_contrast       mean |d(alpha)/dx| along the boundary — a proxy for how
                      hard the cut is (blurry masks score low)
  components          connected foreground regions; >1 suggests speckle/noise or
                      a genuinely multi-part object
  speckle_frac        foreground components smaller than 0.05% of the image
                      (stray dots a marketplace listing would show as noise)

Usage:
    python3 scripts/eval/analyze-eval.py eval-results/wasm
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]


def analyse_alpha(alpha: np.ndarray) -> dict:
    h, w = alpha.shape
    fg = alpha >= 0.5
    fg_frac = float(fg.mean())
    soft = (alpha > 0.02) & (alpha < 0.98)
    soft_frac = float(soft.mean())
    # Boundary = foreground pixels with at least one background 4-neighbour.
    p = np.pad(fg, 1, constant_values=False)
    interior = p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    boundary = fg & ~interior
    gy, gx = np.gradient(alpha)
    gmag = np.hypot(gx, gy)
    edge_contrast = float(gmag[boundary].mean()) if boundary.any() else 0.0
    return {
        "foreground_frac": round(fg_frac, 5),
        "soft_edge_frac": round(soft_frac, 6),
        "edge_contrast": round(edge_contrast, 5),
        "boundary_px": int(boundary.sum()),
    }


def connected_components(fg: np.ndarray) -> tuple[int, float]:
    """Count 8-connected foreground regions and the fraction that are tiny.

    A small flood-fill is enough here (no scipy); images are capped at a few
    megapixels and this runs offline.
    """
    h, w = fg.shape
    labels = np.zeros((h, w), dtype=np.int32)
    current = 0
    total = h * w
    for y0 in range(h):
        row = fg[y0]
        for x0 in range(w):
            if not row[x0] or labels[y0, x0]:
                continue
            current += 1
            stack = [(y0, x0)]
            labels[y0, x0] = current
            while stack:
                y, x = stack.pop()
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < h and 0 <= nx < w and fg[ny, nx] and not labels[ny, nx]:
                            labels[ny, nx] = current
                            stack.append((ny, nx))
    if current == 0:
        return 0, 0.0
    sizes = np.bincount(labels.ravel())[1:]
    tiny = sizes < 0.0005 * total
    speckle = float(tiny.sum() / current)
    return current, round(speckle, 4)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir", help="directory written by run-eval.mjs")
    args = parser.parse_args()

    run_dir = (ROOT / args.run_dir).resolve() if not Path(args.run_dir).is_absolute() else Path(args.run_dir)
    report_path = run_dir / "report.json"
    if not report_path.exists():
        print(f"No report.json in {run_dir}", file=sys.stderr)
        return 1
    report = json.loads(report_path.read_text())

    per_image = []
    for row in report["rows"]:
        out_png = run_dir / "outputs" / f"{row['id']}.png"
        if not row.get("ok") or not out_png.exists():
            per_image.append({"id": row["id"], "category": row["category"], "ok": False})
            continue
        img = Image.open(out_png).convert("RGBA")
        alpha = np.asarray(img.split()[-1], dtype=np.float32) / 255.0
        metrics = analyse_alpha(alpha)
        components, speckle = connected_components(alpha >= 0.5)
        metrics["components"] = components
        metrics["speckle_frac"] = speckle
        # A mask that keeps essentially nothing is a customer-visible failure
        # even though inference "succeeded", so flag it explicitly.
        metrics["empty_output"] = metrics["foreground_frac"] < 0.01
        metrics["width"], metrics["height"] = img.width, img.height
        per_image.append({"id": row["id"], "category": row["category"], "ok": True, **metrics})

    # Aggregate per category.
    cats: dict[str, list[dict]] = {}
    for m in per_image:
        cats.setdefault(m["category"], []).append(m)

    def mean(vals):
        vals = [v for v in vals if v is not None]
        return round(float(np.mean(vals)), 5) if vals else None

    by_category = {}
    for cat, items in cats.items():
        ok = [i for i in items if i.get("ok")]
        by_category[cat] = {
            "images": len(items),
            "succeeded": len(ok),
            "empty_outputs": sum(1 for i in ok if i.get("empty_output")),
            "mean_foreground_frac": mean([i.get("foreground_frac") for i in ok]),
            "mean_soft_edge_frac": mean([i.get("soft_edge_frac") for i in ok]),
            "mean_edge_contrast": mean([i.get("edge_contrast") for i in ok]),
            "mean_components": mean([i.get("components") for i in ok]),
            "mean_speckle_frac": mean([i.get("speckle_frac") for i in ok]),
        }

    quality = {
        "runDir": str(run_dir.relative_to(ROOT)),
        "provider": report.get("provider"),
        "model": report.get("model"),
        "note": "Descriptive edge-character metrics (no ground truth); use for regression comparison and visual review.",
        "byCategory": by_category,
        "perImage": per_image,
    }
    (run_dir / "quality.json").write_text(json.dumps(quality, indent=2) + "\n")

    # Markdown summary for the report.
    lines = [
        "| category | n | ok | empty | foreground | soft edge | edge contrast | components | speckle |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for cat, s in by_category.items():
        lines.append(
            f"| {cat} | {s['images']} | {s['succeeded']} | {s['empty_outputs']} | "
            f"{s['mean_foreground_frac']} | {s['mean_soft_edge_frac']} | "
            f"{s['mean_edge_contrast']} | {s['mean_components']} | {s['mean_speckle_frac']} |"
        )
    table = "\n".join(lines)
    (run_dir / "quality.md").write_text(table + "\n")
    print(table)
    empties = [m["id"] for m in per_image if m.get("ok") and m.get("empty_output")]
    if empties:
        print(f"\nEmpty/near-empty outputs ({len(empties)}): {', '.join(empties)}")
    print(f"\nWrote {run_dir / 'quality.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
