#!/usr/bin/env python3
"""Score an evaluation run against the accuracy-benchmark spec.

Input:  the `report.json` + `outputs/*.png` written by `scripts/eval/run-eval.mjs`,
        plus the optional ground-truth masks under `eval/ground-truth/`.
Output: `benchmark.json` (one record per image + per-category roll-up),
        `checklist.csv` (the flat per-image worksheet), `benchmark.md` (a short
        summary), and `parity.json` when `--parity <other-run>` is given.

This is the scoring engine the spec calls for (`docs/accuracy-benchmark.md` §8
item 3). It implements the §3 measurement checklist, applies the §5 gates, and
emits the §6 per-image verdict (PASS / FAIL(exec|dims|empty|kept|gate) / REVIEW).
Where a ground-truth mask exists it adds the §4 accuracy metrics — the only
absolute quality numbers — and gates them too.

Usage:
    python3 scripts/eval/accuracy-benchmark.py eval-results/wasm \
        [--ground-truth eval/ground-truth] [--thresholds eval/thresholds.json] \
        [--parity eval-results/webgpu]
    python3 scripts/eval/accuracy-benchmark.py --self-test
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from quality_metrics import (  # noqa: E402
    FINE_ISLAND_FRACTION,
    KEPT_OPAQUE_FRACTION,
    MIN_BIMODAL_TAIL,
    NEAR_OPAQUE_ALPHA,
    SPECKLE_ISLAND_FRACTION,
    WASHED_MIN_COVERAGE,
    accuracy_metrics,
    component_stats,
    descriptive_metrics,
    flips,
    hole_stats,
    label_components,
)

ROOT = Path(__file__).resolve().parents[2]

# The checklist column order, grouped as in docs/accuracy-benchmark.md §3.
CHECKLIST_COLUMNS = [
    # identity (§3.1)
    "id", "category", "name", "path", "license", "source",
    "expected_w", "expected_h",
    # minimum acceptable thresholds that apply to this image (§3.2, §5)
    "min_fg_frac", "min_bimodal_tail", "min_alpha_max", "max_speckle_frac",
    "max_infer_ms",
    # execution (§3.3) + dimensions (§3.4)
    "exec_ok", "error", "provider", "out_w", "out_h", "dims_match",
    # timing (§3.5)
    "infer_ms", "wall_ms",
    # alpha character (§3.6)
    "fg_frac", "soft_edge_frac", "edge_contrast", "boundary_px",
    "alpha_min", "alpha_max", "alpha_mean", "alpha_p05", "alpha_p50", "alpha_p95",
    "opaque_frac", "any_frac", "tail_mass", "bimodal_ok",
    # empty (§3.7)
    "empty", "empty_class", "alpha_verdict",
    # segmentation (§3.8)
    "components", "largest_component_frac", "speckle_frac",
    "holes", "hole_area_frac", "border_fg_frac", "bbox_fill", "bbox_touch_border",
    "centroid_offset", "boundary_bandwidth_px",
    "trimap_fg", "trimap_unknown", "trimap_bg",
    # accuracy (§4)
    "has_ground_truth", "iou", "dice", "mae", "mse", "band_mae",
    "boundary_f", "fg_precision", "fg_recall", "empty_gt",
    # verdict (§6)
    "verdict", "failed_gates", "notes",
]


def rel(path: Path) -> str:
    """Path relative to the repo root when possible, else the absolute path."""
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_alpha(png: Path) -> np.ndarray | None:
    """Load a PNG's alpha channel as float [0, 1], or None if unreadable."""
    try:
        img = Image.open(png).convert("RGBA")
    except Exception:
        return None
    return np.asarray(img.split()[-1], dtype=np.float32) / 255.0


def load_gt_mask(gt_dir: Path, image_id: str) -> np.ndarray | None:
    """Load a ground-truth mask for `image_id` as float [0, 1], or None.

    Accepts `<id>.png` (alpha, or luminance if fully opaque) and `<id>.npy`.
    """
    npy = gt_dir / f"{image_id}.npy"
    if npy.exists():
        arr = np.load(npy).astype(np.float32)
        return arr / 255.0 if arr.max() > 1.0 else arr
    png = gt_dir / f"{image_id}.png"
    if png.exists():
        img = Image.open(png).convert("RGBA")
        alpha = np.asarray(img.split()[-1], dtype=np.float32)
        if alpha.min() == 255:  # fully opaque → the mask is stored as luminance
            alpha = np.asarray(img.convert("L"), dtype=np.float32)
        return alpha / 255.0
    return None


def resize_nearest(mask: np.ndarray, width: int, height: int) -> np.ndarray:
    """Nearest-neighbour resize of a mask to (height, width) with pure numpy."""
    h, w = mask.shape
    ys = (np.arange(height) * (h / height)).astype(int).clip(0, h - 1)
    xs = (np.arange(width) * (w / width)).astype(int).clip(0, w - 1)
    return mask[ys][:, xs]


def spec_for(metric: str, category: str, section: dict, thresholds: dict) -> dict | None:
    """Per-category override of a metric spec, else the section value, else None."""
    per = thresholds.get("perCategory", {}).get(category, {})
    if metric in per:
        return per[metric]
    return section.get(metric)


def gate(value: float | None, spec: dict | None, name: str) -> tuple[str, list[str]]:
    """Return (verdict, failed_gate_names) for a bounded metric.

    A `fail_*` bound yields FAIL; a `warn_*` bound yields WARN; the caller
    decides whether a FAIL is a hard failure or a REVIEW depending on the section.
    """
    if value is None or not spec:
        return "PASS", []
    if "fail_below" in spec and value < spec["fail_below"]:
        return "FAIL", [f"{name} {value} < {spec['fail_below']}"]
    if "fail_above" in spec and value > spec["fail_above"]:
        return "FAIL", [f"{name} {value} > {spec['fail_above']}"]
    if "warn_below" in spec and value < spec["warn_below"]:
        return "WARN", [f"{name} {value} < {spec['warn_below']}"]
    if "warn_above" in spec and value > spec["warn_above"]:
        return "WARN", [f"{name} {value} > {spec['warn_above']}"]
    return "PASS", []


def timing_budget(long_side: int, provider: str, thresholds: dict) -> dict | None:
    key = "webgpu" if provider and "webgpu" in provider.lower() else "wasm"
    for band in thresholds.get("timingMs", {}).get(key, []):
        if long_side <= band["maxLongSide"]:
            return band
    return None


def _selftest_components() -> list[str]:
    """Assert the run-length labeler's connectivity on tiny hand-built masks."""
    errors = []
    # Two 1-px squares touching only at a corner are one region under
    # 8-connectivity and two under 4; the labeler is 8-connected.
    diag = np.zeros((2, 2), dtype=bool)
    diag[0, 0] = diag[1, 1] = True
    if int(label_components(diag).max()) != 1:
        errors.append("8-connectivity: diagonal pixels not one region")
    # Two separate squares are two regions, with the smaller as speckle.
    two = np.zeros((3, 5), dtype=bool)
    two[1, 0] = True
    two[1, 3] = two[1, 4] = True
    stats = component_stats(two)
    if stats["components"] != 2:
        errors.append(f"expected 2 components, got {stats['components']}")
    # A ring (hole) is one foreground region enclosing one background region.
    ring = np.ones((5, 5), dtype=bool)
    ring[1:4, 1:4] = False
    holes = hole_stats(ring)
    if holes["holes"] != 1 or holes["hole_area_frac"] <= 0:
        errors.append(f"ring hole not detected: {holes}")
    # A solid block has no hole.
    if hole_stats(np.ones((4, 4), dtype=bool))["holes"] != 0:
        errors.append("solid block reported a hole")
    return errors


def _ts_map_entry(text: str, name: str) -> float | None:
    """Read a `name: <number>` entry out of a TypeScript object literal."""
    import re

    m = re.search(rf"^\s*{name}:\s*([0-9.eE+-]+)", text, re.MULTILINE)
    return float(m.group(1)) if m else None


def _selftest_constants() -> list[str]:
    """Assert the mirrored app constants still match their TypeScript source."""
    errors = []
    src = (ROOT / "src" / "features" / "diagnostics").glob("*.ts")
    text = "\n".join(p.read_text() for p in src)
    expected = {
        "NEAR_OPAQUE_ALPHA = 230": abs(NEAR_OPAQUE_ALPHA - 230 / 255) < 1e-9,
        "KEPT_OPAQUE_FRACTION = 0.995": KEPT_OPAQUE_FRACTION == 0.995,
        "WASHED_MIN_COVERAGE = 0.9": WASHED_MIN_COVERAGE == 0.9,
        "MIN_BIMODAL_TAIL = 0.4": MIN_BIMODAL_TAIL == 0.4,
    }
    for decl, ok in expected.items():
        if not ok or decl not in text:
            errors.append(f"constant drifted: {decl}")

    # The speckle/island area bars live in island-cleanup.ts and are shared by
    # the app's Stage-4 cleanup, the flood-recovery despeckle and this
    # benchmark's speckle gate (issue #145). `fine` is the product default,
    # `strict` must equal the gate. Compare values, not formatting, so 5e-4 and
    # 0.0005 agree.
    bg = ROOT / "src" / "features" / "background-removal"
    variants = bg / "island-cleanup.ts"
    variant_text = variants.read_text() if variants.exists() else ""
    expected_variants = {
        "fine": FINE_ISLAND_FRACTION,
        "strict": SPECKLE_ISLAND_FRACTION,
    }
    for name, want in expected_variants.items():
        value = _ts_map_entry(variant_text, name) if variant_text else None
        if value is None:
            errors.append(f"constant not found: {name} in island-cleanup.ts")
        elif abs(value - want) > 1e-12:
            errors.append(f"constant drifted: {name} = {value} != {want}")
    # Both consumers must still default to the fine variant.
    for filename, name, want_text in (
        ("refine-mask.ts", "MIN_ISLAND_FRACTION", "ISLAND_CLEANUP_FRACTIONS[DEFAULT_ISLAND_CLEANUP]"),
        (
            "mask-recovery.ts",
            "MIN_RECOVERY_ISLAND_FRACTION",
            "ISLAND_CLEANUP_FRACTIONS[DEFAULT_ISLAND_CLEANUP]",
        ),
    ):
        path = bg / filename
        consumer_text = path.read_text() if path.exists() else ""
        if f"export const {name} = {want_text}" not in consumer_text:
            errors.append(f"default drifted: {name} in {filename} is not {want_text}")
    return errors


def self_test() -> int:
    """Offline check of the metrics + gate logic against synthetic masks.

    Builds a throwaway run directory (a good circle, an empty mask, a
    background-kept mask, a wrong-dimension row and a failed row) with a
    ground-truth circle, then asserts the expected verdicts and that IoU is
    computed. Also asserts the mirrored app constants still match the TS source.
    Runs in CI with only numpy + pillow.
    """
    import contextlib
    import io
    import tempfile

    errors = _selftest_constants() + _selftest_components()

    with tempfile.TemporaryDirectory() as tmp:
        run = Path(tmp) / "run"
        (run / "outputs").mkdir(parents=True)
        gt = Path(tmp) / "gt"
        gt.mkdir()

        h = w = 200
        yy, xx = np.mgrid[0:h, 0:w]
        dist = np.hypot(yy - 100, xx - 100)
        # A realistic good cut: a ~2 px feathered edge (real model output is a
        # soft sigmoid, never a perfectly binary mask).
        circle = np.clip((60.5 - dist) / 2.0 + 0.5, 0.0, 1.0).astype(np.float32)

        def save_alpha(image_id: str, alpha: np.ndarray) -> None:
            rgba = np.zeros((*alpha.shape, 4), dtype=np.uint8)
            rgba[..., 3] = (alpha * 255).astype(np.uint8)
            Image.fromarray(rgba, "RGBA").save(run / "outputs" / f"{image_id}.png")

        save_alpha("ordinary-product-01", circle)                 # good
        save_alpha("hair-fur-01", np.zeros((h, w), np.float32))   # empty
        save_alpha("complex-bg-01", np.ones((h, w), np.float32))  # bg kept
        save_alpha("clothing-01", circle)                         # wrong dims
        # washed ghost: faint, no opaque core, covers the frame
        save_alpha("glass-transparent-01", np.full((h, w), 0.23, np.float32))

        def row(iid, cat, ok, **kw):
            base = dict(id=iid, category=cat, title=iid, ok=ok,
                        expected=dict(width=w, height=h), provider="wasm", model="m")
            base.update(kw)
            return base

        rows = [
            row("ordinary-product-01", "ordinary-product", True, avgMs=3000, wallMs=4000),
            row("hair-fur-01", "hair-fur", True, avgMs=3000, wallMs=4000),
            row("complex-bg-01", "complex-bg", True, avgMs=3000, wallMs=4000),
            row("glass-transparent-01", "glass-transparent", True, avgMs=3000, wallMs=4000),
            row("clothing-01", "clothing", True, avgMs=3000, wallMs=4000,
                expected=dict(width=500, height=500)),
            row("large-01", "large", False, error="no output",
                expected=dict(width=1920, height=1000)),
        ]
        (run / "report.json").write_text(json.dumps(
            dict(provider="wasm", model="self-test", generatedAt="now", rows=rows)))

        # Ground truth: the same circle at the mask's 0.5 crossing (radius 60.5),
        # so a correct prediction scores IoU ≈ 1.
        gt_circle = (dist < 60.5).astype(np.float32)
        Image.fromarray((gt_circle * 255).astype(np.uint8), "L").save(gt / "ordinary-product-01.png")

        argv = sys.argv
        sys.argv = ["accuracy-benchmark.py", str(run), "--ground-truth", str(gt)]
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                rc = main()
        finally:
            sys.argv = argv
        if rc != 0:
            errors.append("main() returned non-zero")

        result = json.loads((run / "benchmark.json").read_text())
        by_id = {r["id"]: r for r in result["perImage"]}
        checks = [
            (by_id["ordinary-product-01"]["verdict"] == "PASS", "good image not PASS"),
            (by_id["ordinary-product-01"]["iou"] is not None, "IoU not computed"),
            (by_id["ordinary-product-01"]["iou"] >= 0.99, "aligned GT IoU should be ~1"),
            (by_id["hair-fur-01"]["verdict"] == "FAIL(empty)", "empty image wrong verdict"),
            (by_id["glass-transparent-01"]["verdict"] == "FAIL(empty)", "washed image wrong verdict"),
            (by_id["complex-bg-01"]["verdict"] == "FAIL(kept)", "bg-kept image wrong verdict"),
            (by_id["clothing-01"]["verdict"] == "FAIL(dims)", "wrong-dims image wrong verdict"),
            (by_id["large-01"]["verdict"] == "FAIL(exec)", "failed-execution image wrong verdict"),
            (result["summary"]["with_ground_truth"] == 1, "ground-truth count wrong"),
        ]
        errors += [msg for ok, msg in checks if not ok]

    if errors:
        for msg in errors:
            print(f"self-test FAIL: {msg}", file=sys.stderr)
        return 1
    print("accuracy-benchmark self-test: OK")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir", nargs="?", help="directory written by run-eval.mjs")
    parser.add_argument("--ground-truth", default="eval/ground-truth")
    parser.add_argument("--thresholds", default="eval/thresholds.json")
    parser.add_argument("--manifest", default="eval/manifest.json")
    parser.add_argument("--parity", default=None,
                        help="another run dir; write per-image mask flips (spec §3.9)")
    parser.add_argument("--self-test", action="store_true",
                        help="run the offline metric/gate self-test and exit")
    args = parser.parse_args()

    if args.self_test:
        return self_test()
    if not args.run_dir:
        parser.error("run_dir is required (or use --self-test)")

    run_dir = Path(args.run_dir)
    if not run_dir.is_absolute():
        run_dir = (ROOT / run_dir).resolve()
    report_path = run_dir / "report.json"
    if not report_path.exists():
        print(f"No report.json in {run_dir}", file=sys.stderr)
        return 1

    report = json.loads(report_path.read_text())
    thresholds = json.loads((ROOT / args.thresholds).read_text())
    uni = thresholds["universal"]
    seg = thresholds["segmentation"]
    acc = thresholds.get("accuracy", {})
    gt_dir = (ROOT / args.ground_truth) if not Path(args.ground_truth).is_absolute() else Path(args.ground_truth)

    # Manifest gives license/source and the pinned expected size per id.
    manifest_meta: dict[str, dict] = {}
    manifest_path = ROOT / args.manifest
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        for cat in manifest.get("categories", []):
            for img in cat.get("images", []):
                manifest_meta[img["id"]] = img

    records = []

    def emit(rec: dict, verdict: str, failed: list[str]) -> None:
        """Append a record with every checklist key present (None when unset),
        so the JSON schema and the CSV columns are stable on every path."""
        for col in CHECKLIST_COLUMNS:
            rec.setdefault(col, None)
        rec["verdict"] = verdict
        rec["failed_gates"] = failed
        records.append(rec)

    for row in report["rows"]:
        iid = row["id"]
        meta = manifest_meta.get(iid, {})
        budget = timing_budget(
            max(row.get("expected", {}).get("width", meta.get("width")) or 0,
                row.get("expected", {}).get("height", meta.get("height")) or 0),
            row.get("provider") or "", thresholds)
        rec = {
            "id": iid,
            "name": row.get("title", meta.get("title", iid)),
            "category": row["category"],
            "license": meta.get("license"),
            "source": meta.get("page"),
            # §3.2 — the thresholds that apply to this image, so a row is
            # self-documenting and a reader can see the bar it was judged against.
            "min_fg_frac": uni["min_fg_frac"],
            "min_bimodal_tail": uni["min_bimodal_tail"],
            "min_alpha_max": uni["min_alpha_max"],
            "max_speckle_frac": uni["max_speckle_frac"],
            "max_infer_ms": budget["fail_above"] if budget else None,
            "exec_ok": bool(row.get("ok")),
            "error": row.get("error"),
            "expected_w": row.get("expected", {}).get("width", meta.get("width")),
            "expected_h": row.get("expected", {}).get("height", meta.get("height")),
            "provider": row.get("provider"),
        }
        out_png = run_dir / "outputs" / f"{iid}.png"
        rec["path"] = rel(out_png) if out_png.exists() else None
        failed: list[str] = []

        if not rec["exec_ok"]:
            emit(rec, "FAIL(exec)", [f"execution failed: {row.get('error')}"])
            continue

        alpha = load_alpha(out_png) if out_png.exists() else None
        if alpha is None:
            emit(rec, "FAIL(exec)", ["output PNG missing or unreadable"])
            continue

        rec["out_h"], rec["out_w"] = alpha.shape
        rec["dims_match"] = (
            rec["out_w"] == rec["expected_w"] and rec["out_h"] == rec["expected_h"]
        )
        rec["infer_ms"] = round(row["avgMs"], 1) if row.get("avgMs") else None
        rec["wall_ms"] = row.get("wallMs")

        rec.update(descriptive_metrics(alpha))

        # §6 verdict, in the doc's order: exec → dims → empty/washed → kept.
        if not rec["dims_match"]:
            emit(rec, "FAIL(dims)", [
                f"dimensions {rec['out_w']}x{rec['out_h']} != "
                f"{rec['expected_w']}x{rec['expected_h']}"
            ])
            continue
        if rec["alpha_verdict"] in ("empty", "washed"):
            failed.append(f"{rec['alpha_verdict']} output")
            emit(rec, "FAIL(empty)", failed)
            continue
        if rec["alpha_verdict"] == "kept":
            failed.append("mask kept the background")
            emit(rec, "FAIL(kept)", failed)
            continue

        # §5.1 universal gates beyond the verdict (bimodal ghost guard, opaque
        # core, speckle). These are hard FAILs.
        hard_fail = []
        if not rec["bimodal_ok"]:
            hard_fail.append(f"bimodal tail {rec['tail_mass']} < {uni['min_bimodal_tail']}")
        if rec["alpha_max"] < uni["min_alpha_max"]:
            hard_fail.append(f"alpha_max {rec['alpha_max']} < {uni['min_alpha_max']}")
        if rec["speckle_frac"] > uni["max_speckle_frac"]:
            hard_fail.append(f"speckle_frac {rec['speckle_frac']} > {uni['max_speckle_frac']}")
        if budget and rec["infer_ms"] is not None:
            v, f = gate(rec["infer_ms"], budget, "infer_ms")
            if v == "FAIL":
                hard_fail += f
        if hard_fail:
            emit(rec, "FAIL(gate)", hard_fail)
            continue

        # §5.2 segmentation sanity → REVIEW (needs a human eye, not a hard fail).
        review = []
        frag = spec_for("min_largest_component_frac", rec["category"],
                        {"min_largest_component_frac": seg["min_largest_component_frac"]}, thresholds)
        if frag and rec["largest_component_frac"] < frag:
            review.append(
                f"fragmented: largest {rec['largest_component_frac']} < {frag}"
            )
        if rec["border_fg_frac"] > seg["max_border_fg_frac"] and not rec["bbox_touch_border"]:
            review.append(f"border leak: border_fg_frac {rec['border_fg_frac']} > {seg['max_border_fg_frac']}")
        if rec["hole_area_frac"] > seg["review_hole_area_frac"]:
            review.append(f"holes: hole_area_frac {rec['hole_area_frac']} > {seg['review_hole_area_frac']}")
        if not (seg["min_boundary_bandwidth_px"] <= rec["boundary_bandwidth_px"] <= seg["max_boundary_bandwidth_px"]):
            review.append(f"boundary bandwidth {rec['boundary_bandwidth_px']} px out of range")

        # §5.3 accuracy gates, only where a ground-truth mask exists.
        rec["has_ground_truth"] = False
        gt = load_gt_mask(gt_dir, iid) if gt_dir.exists() else None
        if gt is not None:
            rec["has_ground_truth"] = True
            if gt.shape != alpha.shape:
                gt = resize_nearest(gt, alpha.shape[1], alpha.shape[0])
            am = accuracy_metrics(alpha, gt)
            rec.update(am)
            if not am["empty_gt"]:
                for metric in ("iou", "dice", "mae", "boundary_f", "fg_recall", "fg_precision"):
                    v, f = gate(am[metric], acc.get(metric), metric)
                    if v == "FAIL":
                        hard_fail += f
                    elif v == "WARN":
                        review += f

        if hard_fail:
            emit(rec, "FAIL(gate)", hard_fail)
        elif review:
            emit(rec, "REVIEW", review)
        else:
            emit(rec, "PASS", [])

    # ——— Aggregate per category ———
    def mean(vals):
        vals = [v for v in vals if v is not None]
        return round(float(np.mean(vals)), 5) if vals else None

    by_category = {}
    for cat in sorted({r["category"] for r in records}):
        items = [r for r in records if r["category"] == cat]
        ok = [r for r in items if r["exec_ok"]]
        scored = [r for r in ok if r["has_ground_truth"] and not r.get("empty_gt")]
        by_category[cat] = {
            "images": len(items),
            "succeeded": len(ok),
            "passed": sum(1 for r in items if r["verdict"] == "PASS"),
            "failed": sum(1 for r in items if r["verdict"].startswith("FAIL")),
            "review": sum(1 for r in items if r["verdict"] == "REVIEW"),
            "empty_outputs": sum(1 for r in ok if r.get("empty")),
            "mean_fg_frac": mean([r.get("fg_frac") for r in ok]),
            "mean_soft_edge_frac": mean([r.get("soft_edge_frac") for r in ok]),
            "mean_edge_contrast": mean([r.get("edge_contrast") for r in ok]),
            "mean_components": mean([r.get("components") for r in ok]),
            "mean_speckle_frac": mean([r.get("speckle_frac") for r in ok]),
            "mean_hole_area_frac": mean([r.get("hole_area_frac") for r in ok]),
            "mean_inference_ms": mean([r.get("infer_ms") for r in ok]),
            "n_ground_truth": len(scored),
            "mean_iou": mean([r.get("iou") for r in scored]),
            "mean_dice": mean([r.get("dice") for r in scored]),
            "mean_boundary_f": mean([r.get("boundary_f") for r in scored]),
            "mean_mae": mean([r.get("mae") for r in scored]),
        }

    scored = [r for r in records if r["has_ground_truth"] and not r.get("empty_gt")]
    summary = {
        "total": len(records),
        "succeeded": sum(1 for r in records if r["exec_ok"]),
        "passed": sum(1 for r in records if r["verdict"] == "PASS"),
        "failed": sum(1 for r in records if r["verdict"].startswith("FAIL")),
        "review": sum(1 for r in records if r["verdict"] == "REVIEW"),
        "empty_outputs": sum(1 for r in records if r.get("empty")),
        "with_ground_truth": len(scored),
        "mean_iou": mean([r["iou"] for r in scored]),
        "mean_dice": mean([r["dice"] for r in scored]),
        "mean_boundary_f": mean([r["boundary_f"] for r in scored]),
        "mean_mae": mean([r["mae"] for r in scored]),
    }
    benchmark = {
        "runDir": rel(run_dir),
        "provider": report.get("provider"),
        "model": report.get("model"),
        "generatedAt": report.get("generatedAt"),
        "spec": "docs/accuracy-benchmark.md",
        "note": (
            "Per-image checklist + §6 verdicts. IoU/Dice/boundary-F/MAE are "
            "absolute accuracy and appear only for images with a ground-truth "
            "mask; everything else is descriptive (regression comparison)."
        ),
        "summary": summary,
        "byCategory": by_category,
        "perImage": records,
    }
    (run_dir / "benchmark.json").write_text(json.dumps(benchmark, indent=2) + "\n")

    # ——— checklist.csv ———
    with (run_dir / "checklist.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=CHECKLIST_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        for r in records:
            flat = dict(r)
            flat["failed_gates"] = "; ".join(r.get("failed_gates") or [])
            writer.writerow(flat)

    # ——— benchmark.md ———
    s = summary
    lines = [
        f"# Accuracy benchmark — {benchmark['runDir']}",
        "",
        f"Provider **{benchmark['provider']}**, model **{benchmark['model']}**.",
        "Spec: `docs/accuracy-benchmark.md`.",
        "",
        f"- Executed: **{s['succeeded']} / {s['total']}**",
        f"- PASS: **{s['passed']}** · REVIEW: **{s['review']}** · FAIL: **{s['failed']}** · empty: **{s['empty_outputs']}**",
    ]
    if s["with_ground_truth"]:
        lines.append(
            f"- Accuracy (n={s['with_ground_truth']} with ground truth): "
            f"mean IoU **{s['mean_iou']}**, Dice **{s['mean_dice']}**, "
            f"boundary-F **{s['mean_boundary_f']}**, MAE **{s['mean_mae']}**"
        )
    else:
        lines.append(
            "- Accuracy: **not measured** — no ground-truth masks under "
            f"`{args.ground_truth}/`. Add reference masks (see that directory's "
            "README) to turn the descriptive metrics into accuracy scores."
        )
    lines += [
        "",
        "| category | n | ok | pass | review | fail | empty | fg | soft | speckle | iou | dice | bF | infer ms |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for cat, c in by_category.items():
        lines.append(
            f"| {cat} | {c['images']} | {c['succeeded']} | {c['passed']} | {c['review']} | "
            f"{c['failed']} | {c['empty_outputs']} | {c['mean_fg_frac']} | "
            f"{c['mean_soft_edge_frac']} | {c['mean_speckle_frac']} | {c['mean_iou']} | "
            f"{c['mean_dice']} | {c['mean_boundary_f']} | {c['mean_inference_ms']} |"
        )
    (run_dir / "benchmark.md").write_text("\n".join(lines) + "\n")

    # ——— optional parity block (§3.9) ———
    if args.parity:
        parity_dir = Path(args.parity)
        if not parity_dir.is_absolute():
            parity_dir = (ROOT / parity_dir).resolve()
        parity = {}
        for r in records:
            other = parity_dir / "outputs" / f"{r['id']}.png"
            mine = run_dir / "outputs" / f"{r['id']}.png"
            a = load_alpha(mine) if mine.exists() else None
            b = load_alpha(other) if other.exists() else None
            if a is None or b is None or a.shape != b.shape:
                parity[r["id"]] = None
                continue
            parity[r["id"]] = {
                "flips": flips(a, b),
                "flip_frac": round(flips(a, b) / a.size, 6),
                "identical": bool(np.array_equal(a, b)),
            }
        (run_dir / "parity.json").write_text(json.dumps({
            "other": rel(parity_dir), "perImage": parity,
        }, indent=2) + "\n")
        low = [k for k, v in parity.items() if v and v["flip_frac"] > 0.01]
        if low:
            lines.append("")
            lines.append(f"Parity vs {rel(parity_dir)}: {len(low)} image(s) differ >1%: {', '.join(low)}")

    print("\n".join(lines))
    fails = [r["id"] for r in records if r["verdict"].startswith("FAIL")]
    if fails:
        print(f"\nFAIL ({len(fails)}): {', '.join(fails)}")
    print(f"\nWrote {run_dir / 'benchmark.json'}, checklist.csv, benchmark.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
