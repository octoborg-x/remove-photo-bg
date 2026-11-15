#!/usr/bin/env python3
"""Emit the per-image accuracy-benchmark checklist for the fixed eval set.

The benchmark design and every threshold are defined in
`docs/accuracy-benchmark.md`. This script only materialises the worksheet: one
row per image in `eval/manifest.json`, with the identity/path/threshold columns
prefilled and the measurement columns left blank for a run to fill.

Two files are written (paths configurable):

  eval/benchmark-checklist.csv   machine-readable worksheet
  eval/benchmark-checklist.md    the same rows as a reviewable Markdown table

When a completed harness run exists (`eval-results/<run>/report.json` +
`quality.json`), pass `--run eval-results/<run>` to prefill the measurement
columns so the sheet can be reviewed directly.

Usage:
    python3 scripts/eval/benchmark-checklist.py
    python3 scripts/eval/benchmark-checklist.py --run eval-results/wasm
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
IMAGE_DIR = ROOT / "eval" / "images"

# Thresholds mirrored from docs/accuracy-benchmark.md (single source of truth is
# the doc; these constants only populate the worksheet).
MIN_FOREGROUND_FRAC = 0.01  # below this an output is "empty" (analyze-eval.py)
MIN_BIMODAL_TAIL = 0.40  # raw-mask-stats.ts MIN_BIMODAL_TAIL
NEAR_OPAQUE_ALPHA = 230  # output-alpha.ts NEAR_OPAQUE_ALPHA
MAX_SPECKLE_FRAC = 0.05
WARM_WASM_MS = 8000
WARM_WEBGPU_MS = 2000

MEASUREMENT_COLUMNS = [
    "exec_ok",
    "out_w",
    "out_h",
    "dims_match",
    "infer_ms",
    "wall_ms",
    "provider",
    "fg_frac",
    "soft_edge_frac",
    "edge_contrast",
    "components",
    "speckle_frac",
    "alpha_max",
    "opaque_frac",
    "tail_mass",
    "empty",
    "bimodal_ok",
    "verdict",
    "notes",
]


def md_cell(value: str) -> str:
    """Escape a Markdown table cell so a title's `|` cannot split the row."""
    return str(value).replace("|", "\\|")


def local_ext(img_id: str) -> str:
    for ext in (".jpg", ".JPG", ".jpeg", ".JPEG", ".png", ".webp"):
        if (IMAGE_DIR / f"{img_id}{ext}").exists():
            return ext
    return ""


def load_run(run_dir: Path) -> dict[str, dict]:
    """Map image id -> prefilled measurement cells from a completed run."""
    report = json.loads((run_dir / "report.json").read_text())
    quality = {}
    qpath = run_dir / "quality.json"
    if qpath.exists():
        quality = {m["id"]: m for m in json.loads(qpath.read_text())["perImage"]}
    out: dict[str, dict] = {}
    for row in report["rows"]:
        iid = row["id"]
        q = quality.get(iid, {})
        tail = None
        cells = {
            "exec_ok": "yes" if row.get("ok") else "no",
            "infer_ms": f"{row['avgMs']:.0f}" if row.get("avgMs") else "",
            "wall_ms": str(row.get("wallMs", "")),
            "provider": row.get("provider", ""),
            "fg_frac": q.get("foreground_frac", ""),
            "soft_edge_frac": q.get("soft_edge_frac", ""),
            "edge_contrast": q.get("edge_contrast", ""),
            "components": q.get("components", ""),
            "speckle_frac": q.get("speckle_frac", ""),
        }
        if row.get("output"):
            cells["out_w"] = row["output"]["width"]
            cells["out_h"] = row["output"]["height"]
            cells["dims_match"] = "yes" if row.get("dimensionsCorrect") else "no"
            cells["opaque_frac"] = round(row["output"]["opaqueFrac"], 4)
        cells["empty"] = "yes" if q.get("empty_output") else ("no" if q else "")
        out[iid] = cells
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default=str(ROOT / "eval" / "manifest.json"))
    ap.add_argument("--run", default=None, help="prefill from eval-results/<run>")
    ap.add_argument("--csv", default=str(ROOT / "eval" / "benchmark-checklist.csv"))
    ap.add_argument("--md", default=str(ROOT / "eval" / "benchmark-checklist.md"))
    args = ap.parse_args()

    manifest = json.loads(Path(args.manifest).read_text())
    prefill = load_run(Path(args.run)) if args.run else {}

    header = [
        "id",
        "category",
        "name",
        "path",
        "license",
        "source",
        "expected_w",
        "expected_h",
        *MEASUREMENT_COLUMNS,
    ]
    rows = []
    for cat in manifest["categories"]:
        for img in cat["images"]:
            iid = img["id"]
            row = {
                "id": iid,
                "category": img["category"],
                "name": img["title"],
                "path": f"eval/images/{iid}{local_ext(iid)}",
                "license": img.get("license", ""),
                "source": img.get("page", ""),
                "expected_w": img["width"],
                "expected_h": img["height"],
            }
            for col in MEASUREMENT_COLUMNS:
                row[col] = prefill.get(iid, {}).get(col, "")
            rows.append(row)

    with open(args.csv, "w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=header)
        writer.writeheader()
        writer.writerows(rows)

    md = [
        "# Accuracy benchmark — per-image checklist",
        "",
        f"{len(rows)} images. Thresholds and the measurement definitions are in "
        "`docs/accuracy-benchmark.md`. Blank cells are to be filled by a harness run.",
        "",
        "| id | category | name | path | exp WxH | exec | out WxH | dims | "
        "infer ms | fg | soft edge | edge ctr | comps | speckle | empty | verdict |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        out_dims = f"{r['out_w']}x{r['out_h']}" if r["out_w"] and r["out_h"] else ""
        md.append(
            f"| {r['id']} | {r['category']} | {md_cell(r['name'])} | `{r['path']}` | "
            f"{r['expected_w']}x{r['expected_h']} | {r['exec_ok']} | "
            f"{out_dims} | {r['dims_match']} | {r['infer_ms']} | "
            f"{r['fg_frac']} | {r['soft_edge_frac']} | {r['edge_contrast']} | "
            f"{r['components']} | {r['speckle_frac']} | {r['empty']} | {r['verdict']} |"
        )
    Path(args.md).write_text("\n".join(md) + "\n")

    print(f"Wrote {args.csv}")
    print(f"Wrote {args.md}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
