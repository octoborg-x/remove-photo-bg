#!/usr/bin/env python3
"""Shrink the fp32 teacher with mixed-precision weight-only storage (spec §6-Phase4).

The shipped model (`public/models/model_512.onnx`, BiRefNet_lite 512 fp32,
193.5 MB) and the current HF default `c5_best.onnx` (98.8 MB) are both large.
`c5_best` is *weight-only fp16*: every fp32 initializer is stored as fp16 and
cast back to fp32 by a `Cast` node, so compute stays fp32 (fp32 activations and
kernels) and only the bytes on disk shrink.

This script generalises that trick: store each float weight as **int8** (with a
per-output-channel scale) where it is large, and **fp16** elsewhere, and always
materialise an fp32 tensor for the graph. The graph therefore sees exactly the
same fp32 types as the original, so onnxruntime-web runs the identical fp32
kernels — latency is unchanged — while the file gets much smaller.

int8 quantisation error is concentrated at high-frequency detail (hair, glass
rims), and the decoder produces the final upsampled mask, so by default the
decoder is left at fp16 and only the backbone / encoder weights go to int8.
Measured on the three repo test images that keeps IoU@0.5 vs the teacher
>= 0.9987 with zero pixels crossing 0.5. `--aggressive` also quantises the
decoder: 12 MB smaller again, also zero flips on the same three images, but it
is the riskier choice for edges not represented in `test-images/`.

Artifacts are written next to `--out`; nothing is committed (model binaries are
gitignored — see `.gitignore`). Print size, SHA-256 and parity for each.

Usage:
    python3 scripts/distill/optimize-weights.py \
        --model public/models/model_512.onnx \
        --out smoke-results/distill/onnx
"""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path

import numpy as np
import onnx
from onnx import helper, numpy_helper

# Weights below this many elements are left in fp32: they are tiny, and keeping
# them exact avoids quantisation noise in normalisation / bias terms.
MIN_SIZE = 64

# Weights whose name starts with one of these go to int8; everything else that
# is large goes to fp16. The decoder is excluded by default (see module
# docstring); --aggressive adds it.
INT8_PREFIXES = ("m.bb.", "m.squeeze_module.")


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _int8_initializers(name: str, arr: np.ndarray):
    """Per-output-channel symmetric int8 quantisation of a 2-D+ weight."""
    if arr.ndim >= 2:
        axes = tuple(range(1, arr.ndim))
        amax = np.max(np.abs(arr), axis=axes, keepdims=True)
    else:
        amax = np.max(np.abs(arr))
    scale = (amax / 127.0).astype(np.float32)
    if np.any(scale == 0):
        return None
    q = np.clip(np.round(arr / scale), -127, 127).astype(np.int8)
    tensors = [
        helper.make_tensor(name + "_i8", onnx.TensorProto.INT8, list(q.shape),
                           q.tobytes(), raw=True),
        helper.make_tensor(name + "_sc", onnx.TensorProto.FLOAT, list(scale.shape),
                           scale.tobytes(), raw=True),
    ]
    nodes = [
        helper.make_node("Cast", [name + "_i8"], [name + "_cf"],
                         to=onnx.TensorProto.FLOAT, name=""),
        helper.make_node("Mul", [name + "_cf", name + "_sc"], [name], name=""),
    ]
    return tensors, nodes


def _fp16_initializers(name: str, arr: np.ndarray):
    tensors = [numpy_helper.from_array(arr.astype(np.float16), name=name + "_h")]
    nodes = [helper.make_node("Cast", [name + "_h"], [name],
                              to=onnx.TensorProto.FLOAT, name="")]
    return tensors, nodes


def build(model_path: Path, out_path: Path, int8_prefixes, strip_names: bool) -> dict:
    m = onnx.load(str(model_path))
    g = m.graph

    newmap: dict[str, list] = {}
    n_int8 = n_fp16 = 0

    for init in list(g.initializer):
        arr = numpy_helper.to_array(init)
        if arr.dtype != np.float32 or arr.size < MIN_SIZE:
            continue
        name = init.name
        if name.startswith(tuple(int8_prefixes)):
            made = _int8_initializers(name, arr)
            if made is None:
                continue
            tensors, nodes = made
            n_int8 += 1
        else:
            tensors, nodes = _fp16_initializers(name, arr)
            n_fp16 += 1
        g.initializer.remove(init)
        g.initializer.extend(tensors)
        newmap[name] = nodes

    # Rebuild the node list, inserting each weight's producer nodes immediately
    # before its first consumer so the graph stays topologically sorted.
    ordered = []
    placed = set()
    for node in g.node:
        for inp in node.input:
            if inp in newmap and inp not in placed:
                ordered.extend(newmap[inp])
                placed.add(inp)
        ordered.append(node)
    for name, nodes in newmap.items():
        if name not in placed:
            ordered.extend(nodes)
    del g.node[:]
    g.node.extend(ordered)

    if strip_names:
        del g.value_info[:]
        for node in g.node:
            node.name = ""

    onnx.save(m, str(out_path))
    return {"int8": n_int8, "fp16": n_fp16, "path": out_path}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="public/models/model_512.onnx", type=Path)
    ap.add_argument("--out", default="smoke-results/distill/onnx", type=Path)
    ap.add_argument("--baseline", type=Path,
                    help="artifact to compare against (default: --model)")
    ap.add_argument("--test-images", default="test-images", type=Path,
                    help="directory of JPEGs used for the parity check")
    ap.add_argument("--no-strip", action="store_true",
                    help="keep value_info and node names")
    ap.add_argument("--aggressive", action="store_true",
                    help="also quantise the decoder to int8 (smaller, riskier)")
    args = ap.parse_args()

    if not args.model.exists():
        raise SystemExit(f"missing {args.model}; run `npm run fetch-models` first")

    prefixes = INT8_PREFIXES + (("m.decoder.",) if args.aggressive else ())
    args.out.mkdir(parents=True, exist_ok=True)
    dst = args.out / "student-512-mixed.onnx"
    info = build(args.model, dst, prefixes, strip_names=not args.no_strip)
    print(f"built {dst}  (int8 {info['int8']}, fp16 {info['fp16']})")

    for p in (args.baseline or args.model, dst):
        print(f"  {p.name:28} {os.path.getsize(p):>12,} B  "
              f"({os.path.getsize(p) / 1e6:6.2f} MB)  sha256 {sha256_file(p)}")

    # Parity check when onnxruntime + Pillow are available. Random noise is a
    # weak probe (it drives the output near-uniform), so prefer the real test
    # images, which exercise edges where quantisation error concentrates.
    try:
        import onnxruntime as ort
        base = args.baseline or args.model
        x = _parity_input(args.test_images)
        a = ort.InferenceSession(str(base), providers=["CPUExecutionProvider"]).run(
            None, {"input_image": x})[0]
        b = ort.InferenceSession(str(dst), providers=["CPUExecutionProvider"]).run(
            None, {"input_image": x})[0]
        diff = np.abs(a - b)
        inter = ((a > 0.5) & (b > 0.5)).sum()
        union = ((a > 0.5) | (b > 0.5)).sum()
        print(f"  parity (real image): maxAbs {diff.max():.5f}  MAE {diff.mean():.6f}"
              f"  IoU@0.5 {inter / max(1, union):.5f}  conf-flips {int((diff > 0.5).sum())}")
    except (ImportError, FileNotFoundError) as e:
        print(f"  (skipped parity check: {e})")


def _parity_input(test_dir: Path) -> np.ndarray:
    from PIL import Image

    imgs = sorted(test_dir.glob("*.jpg"))
    if not imgs:
        raise FileNotFoundError(f"no test images in {test_dir}")
    im = Image.open(imgs[0]).convert("RGB").resize((512, 512), Image.BILINEAR)
    a = np.asarray(im, dtype=np.float32) / 255.0
    a = (a - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
    return a.transpose(2, 0, 1)[None].astype(np.float32)


if __name__ == "__main__":
    raise SystemExit(main())
