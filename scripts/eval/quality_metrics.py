#!/usr/bin/env python3
"""Shared mask-quality metrics for the accuracy benchmark.

Every metric operates on a single-channel alpha mask in [0, 1] (255-scale values
are normalised by the caller). Two families:

  * descriptive (no ground truth) — the visible shape of the cut-out. These use
    the field names defined in `docs/accuracy-benchmark.md` §3.6–3.8, so a
    `benchmark.json` record and the spec table share one vocabulary.
  * accuracy (ground truth required) — IoU, Dice, boundary-F, MAE and friends
    against a reference mask (§4). The only numbers that are an *accuracy* score;
    without a reference mask they are absent.

The constants that decide the app's own verdict (`NEAR_OPAQUE_ALPHA`,
`KEPT_OPAQUE_FRACTION`, `WASHED_MIN_COVERAGE`, `MIN_BIMODAL_TAIL`) are mirrored
from `src/features/diagnostics/{output-alpha,raw-mask-stats}.ts` so the benchmark
judges a result exactly the way the shipped console does.

numpy is the only dependency (no scipy), so a fresh checkout can run this with
``pip install numpy pillow``.
"""

from __future__ import annotations

import numpy as np

# Mirrored from src/features/diagnostics/output-alpha.ts and raw-mask-stats.ts.
NEAR_OPAQUE_ALPHA = 230 / 255  # the solid-core cutoff
KEPT_OPAQUE_FRACTION = 0.995
WASHED_MIN_COVERAGE = 0.9
MIN_BIMODAL_TAIL = 0.4

# Mirrored from src/features/background-removal/island-cleanup.ts
# (`ISLAND_CLEANUP_FRACTIONS`). `component_stats` counts an island below
# SPECKLE_ISLAND_FRACTION as speckle, which is the app's `strict` variant — the
# bar the Stage-4 cleanup and the flood-recovery despeckle use when that variant
# is selected. `FINE_ISLAND_FRACTION` is the product default. Asserted by
# `--self-test` and by src/features/background-removal/threshold-sync.test.ts.
SPECKLE_ISLAND_FRACTION = 5e-4
FINE_ISLAND_FRACTION = 2e-5


# ——— Descriptive metrics (no ground truth) ———


def alpha_shape_stats(alpha: np.ndarray) -> dict:
    """Edge character of a soft mask (§3.6)."""
    fg = alpha >= 0.5
    soft = (alpha > 0.02) & (alpha < 0.98)
    p = np.pad(fg, 1, constant_values=False)
    interior = p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    boundary = fg & ~interior
    gy, gx = np.gradient(alpha)
    gmag = np.hypot(gx, gy)
    edge_contrast = float(gmag[boundary].mean()) if boundary.any() else 0.0
    return {
        "fg_frac": round(float(fg.mean()), 5),
        "soft_edge_frac": round(float(soft.mean()), 6),
        "edge_contrast": round(edge_contrast, 5),
        "boundary_px": int(boundary.sum()),
    }


def alpha_intensity_stats(alpha: np.ndarray) -> dict:
    """Alpha distribution, including the bimodality tail mass (§3.6)."""
    below = float((alpha < 0.1).mean())
    above = float((alpha > 0.95).mean())
    return {
        "alpha_min": round(float(alpha.min()), 5),
        "alpha_max": round(float(alpha.max()), 5),
        "alpha_mean": round(float(alpha.mean()), 5),
        "alpha_p05": round(float(np.percentile(alpha, 5)), 5),
        "alpha_p50": round(float(np.percentile(alpha, 50)), 5),
        "alpha_p95": round(float(np.percentile(alpha, 95)), 5),
        "opaque_frac": round(float((alpha >= NEAR_OPAQUE_ALPHA).mean()), 5),
        "any_frac": round(float((alpha > 0).mean()), 5),
        "tail_mass": round(below + above, 5),
    }


def classify_output_alpha(stats: dict) -> str:
    """The app's own verdict: empty / washed / kept / ok (§3.7).

    Mirrors `classifyOutputAlpha` in src/features/diagnostics/output-alpha.ts.
    """
    if stats["alpha_max"] <= 0:
        return "empty"
    if stats["opaque_frac"] >= KEPT_OPAQUE_FRACTION:
        return "kept"
    if stats["alpha_max"] < NEAR_OPAQUE_ALPHA and stats["any_frac"] >= WASHED_MIN_COVERAGE:
        return "washed"
    return "ok"


def label_components(mask: np.ndarray) -> np.ndarray:
    """8-connected label image for a boolean mask (0 = background).

    A run-length + union-find pass: runs are extracted per row with numpy and
    linked between adjacent rows, so the cost scales with the number of runs
    rather than the pixel count. (A per-pixel Python flood fill took ~4 s on a
    2879x1280 image and ran twice per image — minutes per sweep; this is
    milliseconds.) No scipy, deterministic. Returns int32 labels.
    """
    h, w = mask.shape
    labels = np.zeros((h, w), dtype=np.int32)
    if not mask.any():
        return labels

    parent: list[int] = []

    def find(x: int) -> int:
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:
            parent[x], x = root, parent[x]
        return root

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    rows: list[tuple[int, np.ndarray, np.ndarray, np.ndarray]] = []
    prev = None  # (starts, ends, ids)
    run_id = 0
    for y in range(h):
        row = mask[y]
        edges = np.flatnonzero(np.diff(np.concatenate(([False], row, [False]))))
        starts, ends = edges[0::2], edges[1::2]
        ids = np.arange(run_id, run_id + starts.size, dtype=np.int64)
        parent.extend(ids.tolist())
        run_id += starts.size
        if prev is not None and prev[2].size and starts.size:
            ps, pe, pids = prev
            # 8-connectivity: runs connect when they overlap or touch by one
            # column; a run in the row below can touch two runs above, so union
            # every overlapping pair (the two-pointer walk keeps this linear).
            i = 0
            for j in range(starts.size):
                while i < ps.size and pe[i] + 1 <= starts[j]:
                    i += 1
                k = i
                while k < ps.size and ps[k] <= ends[j]:
                    union(int(pids[k]), int(ids[j]))
                    k += 1
        rows.append((y, starts, ends, ids))
        prev = (starts, ends, ids)

    # Paint each run with its root's label, numbering in first-seen order.
    root_label: dict[int, int] = {}
    for y, starts, ends, ids in rows:
        for s, e, rid in zip(starts, ends, ids):
            root = find(int(rid))
            label = root_label.get(root)
            if label is None:
                label = len(root_label) + 1
                root_label[root] = label
            labels[y, s:e] = label
    return labels


def component_stats(fg: np.ndarray) -> dict:
    """Foreground regions: count, speckle share, largest-region share (§3.8)."""
    total = fg.size
    labels = label_components(fg)
    n = int(labels.max())
    if n == 0:
        return {"components": 0, "speckle_frac": 0.0, "largest_component_frac": 0.0}
    sizes = np.bincount(labels.ravel())[1:]
    tiny = sizes < SPECKLE_ISLAND_FRACTION * total
    return {
        "components": n,
        "speckle_frac": round(float(tiny.sum() / n), 4),
        "largest_component_frac": round(float(sizes.max() / sizes.sum()), 5),
    }


def hole_stats(fg: np.ndarray) -> dict:
    """Background regions fully enclosed by foreground (§3.8).

    A hole is a background region that does not touch the image border. Many
    holes usually mean the model punched speckle into the subject; a genuinely
    ring-shaped subject (a donut) has exactly one.
    """
    bg = ~fg
    labels = label_components(bg)
    n = int(labels.max())
    if n == 0:
        return {"holes": 0, "hole_area_frac": 0.0}
    border = np.unique(
        np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])
    )
    border_labels = set(int(x) for x in border)
    sizes = np.bincount(labels.ravel())
    hole_labels = [lab for lab in range(1, n + 1) if lab not in border_labels]
    hole_area = int(sum(sizes[lab] for lab in hole_labels))
    return {"holes": len(hole_labels), "hole_area_frac": round(hole_area / fg.size, 5)}


def geometry_stats(fg: np.ndarray) -> dict:
    """Bounding box, border leak, and centroid offset (§3.8).

    `border_fg_frac` is the foreground share *of the 2-px frame itself* (a
    background-remains signal), unlike `border_touch_frac` which is the share of
    foreground that happens to sit on the frame.
    """
    h, w = fg.shape
    ys, xs = np.where(fg)
    if ys.size == 0:
        return {
            "bbox_fill": 0.0, "bbox_touch_border": False,
            "border_fg_frac": 0.0, "centroid_offset": 0.0,
        }
    bbox_area = (ys.max() - ys.min() + 1) * (xs.max() - xs.min() + 1)
    touches = bool(ys.min() == 0 or xs.min() == 0 or ys.max() == h - 1 or xs.max() == w - 1)
    band = 2
    frame = np.zeros((h, w), dtype=bool)
    frame[:band, :] = frame[-band:, :] = frame[:, :band] = frame[:, -band:] = True
    border_fg_frac = float((fg & frame).sum() / frame.sum())
    cy, cx = float(ys.mean()), float(xs.mean())
    # Normalised distance of the centroid from the image centre (0 = centred).
    offset = float(np.hypot(cy - (h - 1) / 2, cx - (w - 1) / 2) / np.hypot(h / 2, w / 2))
    return {
        "bbox_fill": round(float(fg.sum() / bbox_area), 5),
        "bbox_touch_border": touches,
        "border_fg_frac": round(border_fg_frac, 5),
        "centroid_offset": round(offset, 5),
    }


def boundary_bandwidth_px(alpha: np.ndarray, boundary: np.ndarray) -> float:
    """Mean width of the soft transition band, in pixels (§3.8).

    Approximated as the soft-edge area divided by the boundary length — a
    resolution-comparable stand-in for the mean 0.1→0.9 crossing distance that
    needs no scipy distance transform. A hard-edged cut is ≈1 px; a blurry cut
    is several px.
    """
    length = int(boundary.sum())
    if length == 0:
        return 0.0
    soft = (alpha > 0.1) & (alpha < 0.9)
    return round(float(soft.sum() / length), 3)


def trimap_stats(alpha: np.ndarray) -> dict:
    """Share of definite-foreground / unknown / definite-background (§3.8)."""
    fg = float((alpha >= 0.95).mean())
    bg = float((alpha <= 0.05).mean())
    return {
        "trimap_fg": round(fg, 5),
        "trimap_unknown": round(1.0 - fg - bg, 5),
        "trimap_bg": round(bg, 5),
    }


def segmentation_stats(alpha: np.ndarray) -> dict:
    """All §3.8 segmentation metrics for one mask, in one dict."""
    fg = alpha >= 0.5
    p = np.pad(fg, 1, constant_values=False)
    interior = p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    boundary = fg & ~interior
    out = {}
    out.update(component_stats(fg))
    out.update(hole_stats(fg))
    out.update(geometry_stats(fg))
    out.update(trimap_stats(alpha))
    out["boundary_bandwidth_px"] = boundary_bandwidth_px(alpha, boundary)
    return out


def descriptive_metrics(alpha: np.ndarray) -> dict:
    """All ground-truth-free metrics for one mask, in one dict."""
    out = {}
    out.update(alpha_shape_stats(alpha))
    out.update(alpha_intensity_stats(alpha))
    out.update(segmentation_stats(alpha))
    out["empty"] = out["fg_frac"] < 0.01
    out["empty_class"] = (
        "fully-transparent" if out["alpha_max"] <= 0
        else ("near-empty" if out["empty"] else "")
    )
    out["bimodal_ok"] = out["tail_mass"] >= MIN_BIMODAL_TAIL
    out["alpha_verdict"] = classify_output_alpha(out)
    return out


def alpha_stats(alpha: np.ndarray) -> dict:
    """Shape stats plus the baseline's legacy `foreground_frac` key."""
    out = alpha_shape_stats(alpha)
    out["foreground_frac"] = out["fg_frac"]
    return out


# ——— Accuracy metrics (ground truth required) ———


def dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    """Binary dilation by a square of the given radius, via 3x3 shifts."""
    out = mask.copy()
    for _ in range(radius):
        p = np.pad(out, 1, constant_values=False)
        out = (
            p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
            | p[:-2, :-2] | p[:-2, 2:] | p[2:, :-2] | p[2:, 2:] | out
        )
    return out


def boundary(mask: np.ndarray) -> np.ndarray:
    """Boundary pixels: foreground pixels with a background 4-neighbour."""
    p = np.pad(mask, 1, constant_values=False)
    interior = p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    return mask & ~interior


def accuracy_metrics(pred_alpha: np.ndarray, gt_alpha: np.ndarray, tol: int = 2) -> dict:
    """The §4 accuracy metrics of a prediction against ground truth.

    `pred_alpha` and `gt_alpha` must be the same shape, in [0, 1]. Binary metrics
    use the >= 0.5 region; MAE/MSE use the soft values. `empty_gt` marks a row
    whose ground truth is itself all-background (agreement, not a real IoU).
    """
    if pred_alpha.shape != gt_alpha.shape:
        raise ValueError(
            f"shape mismatch: pred {pred_alpha.shape} vs gt {gt_alpha.shape}"
        )
    a = pred_alpha >= 0.5
    b = gt_alpha >= 0.5
    inter = int((a & b).sum())
    union = int((a | b).sum())
    gt_empty = int(b.sum()) == 0
    iou = (inter / union) if union else None
    denom = int(a.sum()) + int(b.sum())
    dice = (2 * inter / denom) if denom else None
    precision = (inter / int(a.sum())) if int(a.sum()) else None
    recall = (inter / int(b.sum())) if int(b.sum()) else None
    mae = float(np.abs(pred_alpha - gt_alpha).mean())
    mse = float(((pred_alpha - gt_alpha) ** 2).mean())
    band = (gt_alpha > 0.05) & (gt_alpha < 0.95)
    band_mae = float(np.abs(pred_alpha - gt_alpha)[band].mean()) if band.any() else 0.0

    bp = boundary(a)
    bg = boundary(b)
    if not bp.any() and not bg.any():
        bf = 1.0
    else:
        bp_dil = dilate(bp, tol)
        bg_dil = dilate(bg, tol)
        p = float((bp & bg_dil).sum() / bp.sum()) if bp.any() else 0.0
        r = float((bg & bp_dil).sum() / bg.sum()) if bg.any() else 0.0
        bf = (2 * p * r / (p + r)) if (p + r) else 0.0

    return {
        "iou": round(iou, 5) if iou is not None else None,
        "dice": round(dice, 5) if dice is not None else None,
        "boundary_f": round(bf, 5),
        "mae": round(mae, 5),
        "mse": round(mse, 5),
        "band_mae": round(band_mae, 5),
        "fg_precision": round(precision, 5) if precision is not None else None,
        "fg_recall": round(recall, 5) if recall is not None else None,
        "empty_gt": gt_empty,
    }


def flips(mask_a: np.ndarray, mask_b: np.ndarray) -> int:
    """Pixels whose >= 0.5 classification differs between two masks (§3.9)."""
    return int(((mask_a >= 0.5) != (mask_b >= 0.5)).sum())
