#!/usr/bin/env python3
"""Build the inference-failure gallery under artifacts/failed-inferences/.

Each case is produced by running the SHIPPED model through the real product
pipeline (letterbox preprocess -> ONNX artefact -> crop -> bilinear upscale to
the original dimensions -> alpha), so the stored cut-out is the same failure the
browser produces. For every case the script writes:

    cases/<id>/input.png                  the original photo (gallery-scaled)
    cases/<id>/output.png                 the RGBA cut-out the model produced
    cases/<id>/output-checkerboard.png    the cut-out over a checkerboard
    cases/<id>/comparison.png             input | cut-out, labelled
    cases/<id>/metadata.json              the documented case record

and the top-level manifest.json + summary.json.

The case list, categories and severities live in CASE_SPECS below. Adding a
case is a data edit; the assets are always regenerated from the model.

Usage:
    python3 scripts/eval/build-failure-gallery.py --model /tmp/model.onnx \
        --out artifacts/failed-inferences
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
IMAGE_DIR = ROOT / "eval" / "images"
TEST_DIR = ROOT / "test-images"
MODEL_SIZE = 512
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
MAX_ASSET_SIDE = 800

MODEL_ID = "qmix-cut-512"
MODEL_FILE = "models/model_512_int8_fp16.onnx"

# --- Case list -------------------------------------------------------------
# severity: high | medium | low
# category: empty-output | near-empty-output | partial-subject-removal |
#           washed-out-ghost
#
# `investigation` records what was actually tried against the failure and what it
# measured, so a future reader does not repeat a dead end. Each entry is
# (lever, finding). Only measured results belong here — no hypotheses.
CASE_SPECS = [
    dict(
        caseId="failure-001", image="hair-fur-07", category="empty-output",
        severity="high", verdict="empty",
        observed="The model returned a fully transparent mask: nothing of the "
                 "subject survives. Every pixel is alpha 0.",
        cause="A black-and-white, low-contrast frame (a pale horse on a pale "
              "river bank). With no colour cue and little luminance separation "
              "between subject and background, the model finds no confident "
              "foreground.",
        investigation=[
            ("Raw model output", "min 0.000 / mean 0.000 / max 0.000 — a hard "
             "zero, not a low-confidence mask."),
            ("Model precision", "The fp16 variant (model_512_int0_fp16.onnx) "
             "also returns empty, so this is not an int8 quantisation artefact."),
            ("Input contrast stretch", "Per-channel histogram stretch before "
             "inference leaves the mask max unchanged."),
            ("2x2 tiled inference", "All four tiles return exactly 0.000 — a "
             "closer view does not help."),
            ("Post-inference knobs", "Threshold, feather and the refinement "
             "config all operate on a zero mask and cannot raise it."),
        ],
        fixImplemented=False,
    ),
    dict(
        caseId="failure-002", image="hair-fur-08", category="empty-output",
        severity="high", verdict="empty",
        observed="Fully transparent output. The subject is removed entirely.",
        cause="A very dark, historic black-and-white photograph (mean luminance "
              "68/255). The subject is barely separated from an almost-black "
              "background, so the mask collapses to empty.",
        investigation=[
            ("Raw model output", "min 0.000 / mean 0.00001 / max 0.00005 — "
             "effectively a hard zero."),
            ("Model precision", "fp16 also empty — not a quantisation artefact."),
            ("Input contrast stretch", "No effect on the mask max."),
            ("2x2 tiled inference", "All four tiles return exactly 0.000."),
            ("Post-inference knobs", "Cannot raise a zero mask."),
        ],
        fixImplemented=False,
    ),
    dict(
        caseId="failure-003", image="complex-bg-05", category="empty-output",
        severity="high", verdict="empty",
        observed="Fully transparent output against a cluttered, multi-subject "
                 "background.",
        cause="A crowded night scene with no single dominant subject. The model "
              "has no clear figure to latch onto and returns an empty mask.",
        investigation=[
            ("Raw model output", "min 0.000 / mean 0.00001 / max 0.00006 — "
             "effectively a hard zero."),
            ("Model precision", "fp16 also empty — not a quantisation artefact."),
            ("Input contrast stretch", "No effect on the mask max."),
            ("2x2 tiled inference", "All four tiles return exactly 0.000."),
            ("Post-inference knobs", "Cannot raise a zero mask."),
        ],
        fixImplemented=False,
    ),
    dict(
        caseId="failure-004", image="thin-structure-04", category="empty-output",
        severity="high", verdict="empty",
        observed="Fully transparent output for a close-up of cutlery in a tray.",
        cause="Thin metal structures with specular highlights and very low "
              "foreground area, in a dark wooden tray. Thin, low-area subjects "
              "are the documented hardest class for this model.",
        investigation=[
            ("Raw model output", "min 0.000 / mean 0.000 / max 0.000 — a hard "
             "zero."),
            ("Model precision", "fp16 also empty — not a quantisation artefact."),
            ("Input contrast stretch", "No effect on the mask max."),
            ("2x2 tiled inference",
             "MEASURED FALSE POSITIVE — do not ship this. Three of the four "
             "tiles return exactly 0.000; the fourth floods (fg 0.794, median "
             "0.992) instead of detecting anything. The stitched mask equals "
             "that single tile's mask multiplied by its crossfade weight field "
             "(max abs error 0.00000, correlation 1.00000), so it encodes the "
             "TILE GEOMETRY, not the image: IoU against the metal cutlery is "
             "0.11 and it keeps 13.5% of the dark tray background. Its boundary "
             "gradient contrast is 1.75, versus 8.7–15.0 for real cut-outs. "
             "Scores REVIEW instead of FAIL(empty) only because a mask exists."),
            ("Post-inference knobs", "Cannot raise a zero mask."),
        ],
        fixImplemented=False,
    ),
    dict(
        caseId="failure-005", image="complex-bg-07", category="near-empty-output",
        severity="high", verdict="near-empty",
        observed="Near-empty output: only 0.77% of pixels are kept, so the "
                 "subject (a person in a forest) is almost entirely removed.",
        cause="The subject is a small, low-contrast figure against a tall-tree "
              "forest, a background with strong vertical texture that the model "
              "prefers over the thin human figure.",
        fixImplemented=False,
    ),
    dict(
        caseId="failure-006", image="accessory-07", category="partial-subject-removal",
        severity="medium", verdict="partial",
        observed="Borderline: only 3.8% of pixels are kept. Much of the subject "
                 "is removed; a small fragment survives.",
        cause="A street-scene advertisement pillar with several figures; the "
              "model keeps one small region and discards the rest.",
        fixImplemented=False,
    ),
    dict(
        caseId="failure-007", image="hair-fur-06", category="partial-subject-removal",
        severity="medium", verdict="partial",
        observed="Borderline: 5.3% of pixels kept. The main subject is largely "
                 "removed, leaving only fragments.",
        cause="A herd of wild horses in a dusty, low-contrast setting; the "
              "animals blend into the background.",
        fixImplemented=False,
    ),
    dict(
        caseId="failure-008", image="glass-transparent-06", category="partial-subject-removal",
        severity="medium", verdict="partial",
        observed="Borderline: 5.0% of pixels kept for a scent bottle. Most of "
                 "the subject is removed.",
        cause="A small, translucent glass bottle; transparent subjects have "
              "little solid area for the model to lock onto.",
        fixImplemented=False,
    ),
]

# Documented, real-device failure that cannot be reproduced in this sandbox (no
# Adreno-6xx GPU). Assets are reconstructed from the device report's numbers and
# are labelled synthetic in metadata.
GHOST_SPEC = dict(
    caseId="failure-009", image="product-scent-bottle", category="washed-out-ghost",
    severity="high", verdict="washed",
    observed="The whole frame came out faint and translucent — a washed-out "
             "\"ghost\" — with no opaque foreground core (max alpha 0.41, mean "
             "0.23), yet the photo visible everywhere at ~23% opacity.",
    cause="On a Qualcomm Adreno-6xx phone the WebGPU kernel returned a flat, "
          "low-confidence mask with no confident foreground (the documented "
          "driver/precision hypothesis in HARDWARE_TESTING.md §1/§8). The same "
          "flat shape appears whether or not a fallback ran, so it is the GPU "
          "kernel output itself, not the repo's alpha path.",
    fixImplemented=False,
)


def letterbox_rect(w: int, h: int, size: int = MODEL_SIZE) -> dict:
    scale = size / max(w, h)
    width = max(1, min(size, round(w * scale)))
    height = max(1, min(size, round(h * scale)))
    return {"x": (size - width) // 2, "y": (size - height) // 2, "width": width, "height": height}


def preprocess(img: Image.Image) -> np.ndarray:
    rgb = img.convert("RGB")
    rect = letterbox_rect(*rgb.size)
    content = rgb.resize((rect["width"], rect["height"]), Image.BILINEAR)
    src = np.asarray(content, np.float32) / 255.0
    ys = np.clip(np.arange(MODEL_SIZE) - rect["y"], 0, rect["height"] - 1)
    xs = np.clip(np.arange(MODEL_SIZE) - rect["x"], 0, rect["width"] - 1)
    full = src[np.ix_(ys, xs)]
    x = (full - MEAN) / STD
    return x.transpose(2, 0, 1)[None].astype(np.float32)


def model_alpha(sess, img: Image.Image) -> np.ndarray:
    raw = sess.run(None, {sess.get_inputs()[0].name: preprocess(img)})[0][0, 0]
    rect = letterbox_rect(*img.size)
    cropped = raw[rect["y"]:rect["y"] + rect["height"], rect["x"]:rect["x"] + rect["width"]]
    up = Image.fromarray((cropped * 255).astype(np.uint8)).resize(img.size, Image.BILINEAR)
    return np.asarray(up, np.float32) / 255.0, raw


def raw_mask_stats(m: np.ndarray) -> dict:
    f = m.reshape(-1)
    return {
        "min": round(float(f.min()), 5),
        "mean": round(float(f.mean()), 5),
        "max": round(float(f.max()), 5),
        "below_01_fraction": round(float((f < 0.1).mean()), 5),
        "above_095_fraction": round(float((f > 0.95).mean()), 5),
    }


def classify(alpha: np.ndarray) -> dict:
    a = alpha.reshape(-1)
    mx = float(a.max())
    opaque = float((a >= 230 / 255).mean())
    anyf = float((a > 0).mean())
    if mx <= 0:
        verdict = "empty"
    elif opaque >= 0.995:
        verdict = "kept"
    elif mx < 230 / 255 and anyf >= 0.9:
        verdict = "washed"
    else:
        verdict = "ok"
    return {
        "foreground_frac": round(float((a >= 0.5).mean()), 5),
        "alpha_max_255": int(round(mx * 255)),
        "opaque_fraction": round(opaque, 5),
        "any_fraction": round(anyf, 5),
        "empty": bool(mx <= 0),
        "verdict": verdict,
    }


def checkerboard(w: int, h: int, square: int = 24) -> Image.Image:
    yy, xx = np.mgrid[0:h, 0:w]
    tile = ((yy // square) + (xx // square)) % 2
    arr = np.where(tile[..., None] == 0, 210, 245).astype(np.uint8)
    arr = np.repeat(arr, 3, axis=2)
    return Image.fromarray(arr, "RGB")


def over_checkerboard(rgba: Image.Image, square: int = 24) -> Image.Image:
    bg = checkerboard(rgba.width, rgba.height, square)
    bg.paste(rgba, (0, 0), rgba)
    return bg


def make_comparison(input_img: Image.Image, cutout_rgba: Image.Image, label: str) -> Image.Image:
    on_cb = over_checkerboard(cutout_rgba)
    w = input_img.width + cutout_rgba.width
    h = max(input_img.height, cutout_rgba.height)
    band = 44
    canvas = Image.new("RGB", (w, h + band), (24, 24, 27))
    canvas.paste(input_img.convert("RGB"), (0, band))
    canvas.paste(on_cb, (input_img.width, band))
    draw = ImageDraw.Draw(canvas)
    draw.text((12, 14), "INPUT", fill=(235, 235, 235))
    draw.text((input_img.width + 12, 14), "MODEL OUTPUT (over checkerboard)", fill=(235, 235, 235))
    draw.text((12, band + h + 8), label, fill=(235, 120, 120))
    return canvas


def save_png(img: Image.Image, path: Path) -> None:
    img.save(path, optimize=True)


def scale_to_fit(img: Image.Image, max_side: int = MAX_ASSET_SIDE) -> tuple[Image.Image, float]:
    longest = max(img.size)
    if longest <= max_side:
        return img, 1.0
    s = max_side / longest
    return img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS), round(s, 4)


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    h.update(p.read_bytes())
    return h.hexdigest()


def resolve_image(image_id: str) -> Path:
    for base in (IMAGE_DIR, TEST_DIR):
        for ext in (".jpg", ".JPG", ".jpeg", ".JPEG", ".png", ".webp"):
            p = base / f"{image_id}{ext}"
            if p.exists():
                return p
    raise FileNotFoundError(image_id)


def manifest_entry(image_id: str) -> dict:
    m = json.loads((ROOT / "eval" / "manifest.json").read_text())
    for c in m["categories"]:
        for i in c["images"]:
            if i["id"] == image_id:
                return i
    return {}


def build_case(sess, spec: dict, out_root: Path, command: str) -> dict:
    cid = spec["caseId"]
    case_dir = out_root / "cases" / cid
    case_dir.mkdir(parents=True, exist_ok=True)

    src = resolve_image(spec["image"])
    original = Image.open(src).convert("RGB")
    entry = manifest_entry(spec["image"])

    alpha, raw = model_alpha(sess, original)
    result = classify(alpha)

    # Scale the gallery assets to keep the repo light; record the factor.
    disp, factor = scale_to_fit(original)
    alpha_img = Image.fromarray((alpha * 255).astype(np.uint8)).resize(disp.size, Image.LANCZOS)
    cutout = disp.convert("RGBA")
    cutout.putalpha(alpha_img)

    save_png(disp, case_dir / "input.png")
    save_png(cutout, case_dir / "output.png")
    save_png(over_checkerboard(cutout), case_dir / "output-checkerboard.png")
    save_png(
        make_comparison(disp, cutout, f"{cid} — {spec['category']} ({spec['severity']} severity)"),
        case_dir / "comparison.png",
    )

    metadata = {
        "caseId": cid,
        "title": entry.get("title", spec["image"]),
        "category": spec["category"],
        "severity": spec["severity"],
        "input": {
            "source": str(src.relative_to(ROOT)),
            "title": entry.get("title"),
            "license": entry.get("license"),
            "page": entry.get("page"),
            "width": original.width,
            "height": original.height,
            "sha256_original": sha256_file(src),
            "asset_scale": factor,
        },
        "inference": {
            "model": MODEL_ID,
            "modelFile": MODEL_FILE,
            "modelSha256": "10f1cf12d614b8b9db8a8dc9183c8525cbf6e020bb230e9b15daaf127012bc26",
            "provider": "wasm",
            "inputSize": MODEL_SIZE,
        },
        "result": {
            **result,
            "rawMask": raw_mask_stats(raw),
            "bimodalTail": round(
                raw_mask_stats(raw)["below_01_fraction"] + raw_mask_stats(raw)["above_095_fraction"], 4
            ),
        },
        "reproduction": {
            "status": "reproduced",
            "method": "shipped model over the eval set, offline CPU (ONNX Runtime)",
            "command": command,
        },
        "observedProblem": spec["observed"],
        "suspectedCause": spec["cause"],
        "investigation": [
            {"lever": lever, "finding": finding}
            for lever, finding in spec.get("investigation", [])
        ],
        "fix": {"implemented": spec["fixImplemented"], "description": None, "passesAfterFix": None},
    }
    (case_dir / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"{cid:14} {spec['category']:26} fg={result['foreground_frac']:.4f} "
          f"max={result['alpha_max_255']:3} verdict={result['verdict']}")
    return metadata


def build_ghost_case(out_root: Path, command: str) -> dict:
    """Documented Adreno-6xx WebGPU ghost, reconstructed from the device report.

    The real phone photo is not available in this repo, so the input is a
    stand-in and the output alpha reproduces the DOCUMENTED signature:
    column-constant, max 0.41, mean 0.23, no opaque core. Assets are labelled
    synthetic in metadata and must not be mistaken for a device capture.
    """
    cid = GHOST_SPEC["caseId"]
    case_dir = out_root / "cases" / cid
    case_dir.mkdir(parents=True, exist_ok=True)

    src = resolve_image(GHOST_SPEC["image"])
    original = Image.open(src).convert("RGB")
    entry = manifest_entry(GHOST_SPEC["image"])
    disp, factor = scale_to_fit(original)

    # Column-constant flat ramp: 0.008 .. 0.41, mean ~0.23 (the device numbers).
    cols = np.linspace(0.008, 0.41, disp.width, dtype=np.float32)
    alpha = np.repeat(cols[None, :], disp.height, axis=0)

    save_png(disp, case_dir / "input.png")
    cutout = disp.convert("RGBA")
    cutout.putalpha(Image.fromarray((alpha * 255).astype(np.uint8)))
    save_png(cutout, case_dir / "output.png")
    save_png(over_checkerboard(cutout), case_dir / "output-checkerboard.png")
    save_png(
        make_comparison(disp, cutout, f"{cid} — {GHOST_SPEC['category']} (synthetic reconstruction)"),
        case_dir / "comparison.png",
    )

    metadata = {
        "caseId": cid,
        "title": f"Adreno-6xx WebGPU washed-out ghost (illustrated with {entry.get('title', GHOST_SPEC['image'])})",
        "category": GHOST_SPEC["category"],
        "severity": GHOST_SPEC["severity"],
        "input": {
            "source": str(src.relative_to(ROOT)),
            "title": entry.get("title"),
            "license": entry.get("license"),
            "page": entry.get("page"),
            "width": original.width,
            "height": original.height,
            "sha256_original": sha256_file(src),
            "asset_scale": factor,
            "note": "STAND-IN input: the real Adreno-6xx phone capture is not in "
                    "this repo. This photo is only a carrier for the documented "
                    "alpha signature.",
        },
        "inference": {
            "model": MODEL_ID,
            "modelFile": MODEL_FILE,
            "modelSha256": "10f1cf12d614b8b9db8a8dc9183c8525cbf6e020bb230e9b15daaf127012bc26",
            "provider": "webgpu",
            "device": "Qualcomm Adreno-6xx (Android 10, Chrome 157)",
            "inputSize": MODEL_SIZE,
        },
        "result": {
            "foreground_frac": round(float((alpha >= 0.5).mean()), 5),
            "alpha_max_255": 105,
            "opaque_fraction": 0.0,
            "any_fraction": 1.0,
            "empty": False,
            "verdict": "washed",
            "rawMask": {
                "min": 0.0082, "mean": 0.2322, "max": 0.6424,
                "below_01_fraction": 0.0004, "above_095_fraction": 0.0,
            },
            "bimodalTail": 0.0004,
            "documentedSource": "HARDWARE_TESTING.md §8 (2026-11-15 clean-run capture)",
        },
        "reproduction": {
            "status": "not-reproduced-locally (needs Adreno-6xx hardware)",
            "method": "assets reconstructed from the device report's documented "
                      "signature; the phone photo itself is unavailable",
            "command": command,
        },
        "assetsSynthetic": True,
        "observedProblem": GHOST_SPEC["observed"],
        "suspectedCause": GHOST_SPEC["cause"],
        "fix": {"implemented": GHOST_SPEC["fixImplemented"], "description": None, "passesAfterFix": None},
    }
    (case_dir / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"{cid:14} {GHOST_SPEC['category']:26} (synthetic reconstruction, webgpu)")
    return metadata


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", default=str(ROOT / "artifacts" / "failed-inferences"))
    args = ap.parse_args()

    out_root = Path(args.out)
    if not out_root.is_absolute():
        out_root = ROOT / out_root
    (out_root / "cases").mkdir(parents=True, exist_ok=True)

    command = "python3 scripts/eval/build-failure-gallery.py --model <model.onnx>"

    sess = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    cases = [build_case(sess, spec, out_root, command) for spec in CASE_SPECS]
    cases.append(build_ghost_case(out_root, command))

    # --- manifest.json ---
    manifest = {
        "generatedBy": "scripts/eval/build-failure-gallery.py",
        "model": {"id": MODEL_ID, "file": MODEL_FILE},
        "caseCount": len(cases),
        "cases": [
            {
                "caseId": c["caseId"],
                "category": c["category"],
                "severity": c["severity"],
                "provider": c["inference"]["provider"],
                "model": c["inference"]["model"],
                "input": c["input"]["source"],
                "verdict": c["result"]["verdict"],
                "reproduction": c["reproduction"]["status"],
                "fixImplemented": c["fix"]["implemented"],
                "assetsSynthetic": c.get("assetsSynthetic", False),
                "path": f"cases/{c['caseId']}/metadata.json",
            }
            for c in cases
        ],
    }
    (out_root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    # --- summary.json ---
    def count(key, val):
        return sum(1 for c in cases if c[key] == val)

    by_category: dict[str, int] = {}
    by_provider: dict[str, int] = {}
    by_model: dict[str, int] = {}
    by_severity: dict[str, int] = {}
    for c in cases:
        by_category[c["category"]] = by_category.get(c["category"], 0) + 1
        by_provider[c["inference"]["provider"]] = by_provider.get(c["inference"]["provider"], 0) + 1
        by_model[c["inference"]["model"]] = by_model.get(c["inference"]["model"], 0) + 1
        by_severity[c["severity"]] = by_severity.get(c["severity"], 0) + 1

    borderline = [c["caseId"] for c in cases if c["severity"] == "medium"]
    confirmed = [c["caseId"] for c in cases if c["severity"] == "high"]
    summary = {
        "totalCases": len(cases),
        "confirmedFailures": len(confirmed),
        "confirmedFailureIds": confirmed,
        "borderlineCases": len(borderline),
        "borderlineCaseIds": borderline,
        "failuresByCategory": by_category,
        "failuresByProvider": by_provider,
        "failuresByModel": by_model,
        "failuresBySeverity": by_severity,
        "fixedFailures": sum(1 for c in cases if c["fix"]["implemented"]),
        "unresolvedFailures": sum(1 for c in cases if not c["fix"]["implemented"]),
        "casesPassingAfterFix": sum(1 for c in cases if c["fix"]["passesAfterFix"] is True),
        "syntheticCases": sum(1 for c in cases if c.get("assetsSynthetic")),
    }
    (out_root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")

    write_readme(out_root, cases, summary)
    print(f"\nWrote {out_root}/manifest.json, summary.json and README.md ({len(cases)} cases)")
    return 0


def write_readme(out_root: Path, cases: list[dict], summary: dict) -> None:
    def table(counts: dict[str, int]) -> str:
        rows = "\n".join(f"| {k} | {v} |" for k, v in sorted(counts.items(), key=lambda kv: -kv[1]))
        return f"| key | cases |\n|---|---|\n{rows}"

    lines: list[str] = []
    lines.append("# Failed-inference gallery")
    lines.append("")
    lines.append(
        "Real, reproducible examples of unsuccessful background removal, kept so the "
        "failures can be inspected, classified, compared and reproduced. Each case is a "
        "folder under `cases/` holding the input, the model's cut-out, the cut-out over a "
        "checkerboard, a side-by-side comparison, and a `metadata.json` record."
    )
    lines.append("")
    lines.append(
        "Cases 1–8 were produced by running the **shipped model** (`qmix-cut-512`, "
        f"`{MODEL_FILE}`) through the real product pipeline — letterbox preprocess → ONNX "
        "artefact → crop the padding → bilinear upscale to the original size → alpha. The "
        "offline CPU path (ONNX Runtime) reproduces the browser path exactly, so these are "
        "genuine model failures, not mock-ups. Case 9 is the one real-device failure that "
        "cannot run here (it needs an Adreno-6xx GPU); its assets are a **synthetic "
        "reconstruction** of the documented signature and are labelled as such."
    )
    lines.append("")
    lines.append("## Reproduce")
    lines.append("")
    lines.append("```bash")
    lines.append("python3 -m pip install onnxruntime pillow numpy")
    lines.append("# the shipped artefact (sha256 10f1cf12…)")
    lines.append("curl -L -o /tmp/model.onnx \\")
    lines.append("  https://huggingface.co/spaces/Octoborg/remove-photo-bg/resolve/main/models/model_512_int8_fp16.onnx")
    lines.append("python3 scripts/eval/build-failure-gallery.py --model /tmp/model.onnx")
    lines.append("```")
    lines.append("")
    lines.append("Regenerating rewrites every case folder and the manifest/summary below, so "
                 "the JSON, this document and the images always agree.")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- **Total cases:** {summary['totalCases']}")
    lines.append(f"- **Confirmed failures:** {summary['confirmedFailures']} "
                 f"({', '.join(summary['confirmedFailureIds'])})")
    lines.append(f"- **Borderline cases:** {summary['borderlineCases']} "
                 f"({', '.join(summary['borderlineCaseIds'])})")
    lines.append(f"- **Fixed vs unresolved:** {summary['fixedFailures']} fixed, "
                 f"{summary['unresolvedFailures']} unresolved, "
                 f"{summary['casesPassingAfterFix']} pass after a fix")
    lines.append(f"- **Synthetic (not a live capture):** {summary['syntheticCases']}")
    lines.append("")
    lines.append("**Failures by category**")
    lines.append("")
    lines.append(table(summary["failuresByCategory"]))
    lines.append("")
    lines.append("**Failures by provider**")
    lines.append("")
    lines.append(table(summary["failuresByProvider"]))
    lines.append("")
    lines.append("**Failures by model**")
    lines.append("")
    lines.append(table(summary["failuresByModel"]))
    lines.append("")
    lines.append("**Failures by severity**")
    lines.append("")
    lines.append(table(summary["failuresBySeverity"]))
    lines.append("")
    lines.append("## Cases")
    lines.append("")

    for c in cases:
        cid = c["caseId"]
        base = f"cases/{cid}"
        lines.append(f"### {cid} — {c['category']} ({c['severity']})")
        lines.append("")
        lines.append(f"![{cid} comparison]({base}/comparison.png)")
        lines.append("")
        lines.append("| Field | Value |")
        lines.append("|---|---|")
        lines.append(f"| Case ID | `{cid}` |")
        lines.append(f"| Original image | `{c['input']['source']}` — [{c['input'].get('title', '')}]"
                     f"({c['input'].get('page', '')}) |")
        lines.append(f"| Input size | {c['input']['width']}×{c['input']['height']} |")
        lines.append(f"| Inference result | `{c['result']['verdict']}` — foreground "
                     f"{c['result']['foreground_frac']:.4f}, alpha max {c['result']['alpha_max_255']}/255 |")
        lines.append(f"| Failure category | `{c['category']}` |")
        lines.append(f"| Severity | `{c['severity']}` |")
        lines.append(f"| Model | `{c['inference']['model']}` (`{c['inference']['modelFile']}`) |")
        lines.append(f"| Provider | `{c['inference']['provider']}`"
                     + (f" on {c['inference']['device']}" if c['inference'].get('device') else "") + " |")
        lines.append(f"| Reproduction status | `{c['reproduction']['status']}` |")
        lines.append(f"| Observed problem | {c['observedProblem']} |")
        lines.append(f"| Suspected cause | {c['suspectedCause']} |")
        for item in c.get("investigation", []):
            lines.append(f"| Tested: {item['lever']} | {item['finding']} |")
        fix = c["fix"]
        lines.append(f"| Fix implemented | {'yes' if fix['implemented'] else 'no'} |")
        passes = fix["passesAfterFix"]
        lines.append(f"| Passes after fix | {'n/a — no fix' if passes is None else ('yes' if passes else 'no')} |")
        lines.append("")
        lines.append(f"Assets: [`input.png`]({base}/input.png) · "
                     f"[`output.png`]({base}/output.png) · "
                     f"[`output-checkerboard.png`]({base}/output-checkerboard.png) · "
                     f"[`comparison.png`]({base}/comparison.png) · "
                     f"[`metadata.json`]({base}/metadata.json)")
        lines.append("")

    lines.append("## How a failure is classified")
    lines.append("")
    lines.append("| Category | Meaning |")
    lines.append("|---|---|")
    lines.append("| `empty-output` | The model returned a fully transparent mask (alpha max 0). |")
    lines.append("| `near-empty-output` | A mask exists but keeps almost nothing (<1% of pixels). |")
    lines.append("| `partial-subject-removal` | Only a small fragment of the subject survives (1–10%). |")
    lines.append("| `washed-out-ghost` | The whole frame is faint and translucent, with no opaque core. |")
    lines.append("")
    lines.append("Severity: `high` for a confirmed failure (the subject is lost or the frame "
                 "is unusable), `medium` for a borderline case (most of the subject is lost "
                 "but a fragment survives).")

    (out_root / "README.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
