#!/usr/bin/env python3
"""Optimise the served BiRefNet_lite ONNX artifacts.

Two independent, separately-reported transformations:

1. **Lossless cleanup** (no numerical change, verified bit-exact):
   - drop the `metadata_props` torch.onnx leaves on every node
     (`namespace`, `pkg.torch.onnx.class_hierarchy`, `...fx_node`, `...name_scopes`,
     `...stack_trace`) and on the graph (`pkg.torch.export.ExportedProgram.*`).
     On the shipped 68.5 MB build that is ~6.2 MB of debug strings.
   - collapse byte-identical initializers to one copy (the deformable-attention
     sampling grids are duplicated per decoder block).
   - optionally drop `value_info` and node names.

2. **Weight-only quantisation** (opt-in, changes the bytes on disk only):
   store a weight as int8 with a per-output-channel scale, or fp16, and
   materialise a fp32 tensor for the graph, so onnxruntime-web runs the same
   fp32 kernels and only the download shrinks.

Usage:
    # lossless only
    python3 -m scripts.distill.optimize-onnx \
        --model public/models/model_512_int8_fp16.onnx \
        --out work/opt/clean.onnx --scope none
    # int8 backbone + decoder, fp16 head
    python3 -m scripts.distill.optimize-onnx \
        --model public/models/model_512_int0_fp32.onnx \
        --out work/opt/small.onnx --scope all
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

import numpy as np
import onnx
from onnx import helper, numpy_helper

# Weights below this many elements stay fp32 (tiny, and exactness matters for
# normalisation / bias terms).
MIN_SIZE = 64

# int8 scopes. "decoder_conv" takes only the decoder Conv weights, whose
# quantisation error stays inside a single conv and is absorbed by the following
# BatchNorm/relu; the deformable-attention sampling grids (output head) are the
# fragile part and stay fp16.
SCOPES = ("none", "backbone", "bb_only", "squeeze", "squeeze_dec",
          "decoder_conv", "dec_conv_safe", "bb_dec_conv", "bb_dec_conv_safe",
          "all", "aggressive")


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _int8(name: str, arr: np.ndarray):
    """Per-output-channel symmetric int8 quantisation."""
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
        helper.make_tensor(name + "_sc", onnx.TensorProto.FLOAT,
                           list(scale.shape), scale.tobytes(), raw=True),
    ]
    nodes = [
        helper.make_node("Cast", [name + "_i8"], [name + "_cf"],
                         to=onnx.TensorProto.FLOAT, name=""),
        helper.make_node("Mul", [name + "_cf", name + "_sc"], [name], name=""),
    ]
    return tensors, nodes


def _fp16(name: str, arr: np.ndarray):
    tensors = [numpy_helper.from_array(arr.astype(np.float16), name=name + "_h")]
    nodes = [helper.make_node("Cast", [name + "_h"], [name],
                              to=onnx.TensorProto.FLOAT, name="")]
    return tensors, nodes


def strip_debug_metadata(model) -> int:
    """Remove torch.onnx node/graph metadata. Returns bytes removed."""
    removed = 0
    for node in model.graph.node:
        for mp in node.metadata_props:
            removed += len(mp.SerializeToString())
        del node.metadata_props[:]
    for mp in model.graph.metadata_props:
        removed += len(mp.SerializeToString())
    del model.graph.metadata_props[:]
    for mp in model.metadata_props:
        removed += len(mp.SerializeToString())
    del model.metadata_props[:]
    return removed


def dedupe_initializers(model) -> tuple[int, int]:
    """Point duplicate initializers at one copy. Returns (groups, bytes saved)."""
    g = model.graph
    seen: dict[tuple, str] = {}
    rename: dict[str, str] = {}
    saved = 0
    groups = 0
    for init in list(g.initializer):
        key = (init.data_type, tuple(init.dims), bytes(init.raw_data))
        if key in seen:
            rename[init.name] = seen[key]
            per = {onnx.TensorProto.FLOAT: 4, onnx.TensorProto.FLOAT16: 2,
                   onnx.TensorProto.INT8: 1, onnx.TensorProto.INT64: 8}.get(
                       init.data_type, 1)
            saved += per * int(np.prod(init.dims))
            g.initializer.remove(init)
        else:
            seen[key] = init.name
    for node in g.node:
        for i, inp in enumerate(node.input):
            if inp in rename:
                node.input[i] = rename[inp]
    for i, inp in enumerate(g.input):
        if inp.name in rename:
            g.input[i].name = rename[inp.name]
    return len(rename), saved


def quantize(model, scope: str, int8_decoder_conv: bool, strip_names: bool):
    """Rewrite float initializers as int8/fp16 + fp32 materialisation nodes."""
    g = model.graph
    conv_weights = {n.input[1] for n in g.node if n.op_type == "Conv"}

    def want_int8(name: str) -> bool:
        if scope == "none":
            return False
        # Deformable-conv internals sample the feature map at learned offsets;
        # a quantised offset/modulator/regular weight moves the sampling grid,
        # which is where the catastrophic empty-mask failures came from.
        deformable = any(k in name for k in
                         (".offset_conv.", ".modulator_conv.", ".regular_conv."))
        if scope == "backbone":
            return name.startswith(("m.bb.", "m.squeeze_module."))
        if scope == "bb_only":
            return name.startswith("m.bb.")
        if scope == "squeeze":
            return name.startswith("m.squeeze_module.")
        if scope == "squeeze_dec":
            return (name.startswith("m.squeeze_module.")
                    or (name.startswith("m.decoder.") and name in conv_weights
                        and not deformable))
        if scope == "decoder_conv":
            return name.startswith("m.decoder.") and name in conv_weights
        if scope == "dec_conv_safe":
            return (name.startswith("m.decoder.") and name in conv_weights
                    and not deformable)
        if scope == "bb_dec_conv":
            return (name.startswith(("m.bb.", "m.squeeze_module."))
                    or (name.startswith("m.decoder.") and name in conv_weights))
        if scope == "bb_dec_conv_safe":
            return ((name.startswith(("m.bb.", "m.squeeze_module."))
                     or (name.startswith("m.decoder.") and name in conv_weights))
                    and not deformable)
        if scope == "all":
            return name.startswith("m.")
        if scope == "aggressive":
            return True
        return False

    newmap: dict[str, list] = {}
    n_int8 = n_fp16 = 0
    for init in list(g.initializer):
        arr = numpy_helper.to_array(init)
        if arr.dtype != np.float32 or arr.size < MIN_SIZE:
            continue
        name = init.name
        if want_int8(name):
            made = _int8(name, arr)
            if made is None:
                continue
            tensors, nodes = made
            n_int8 += 1
        else:
            tensors, nodes = _fp16(name, arr)
            n_fp16 += 1
        g.initializer.remove(init)
        g.initializer.extend(tensors)
        newmap[name] = nodes

    ordered = []
    placed: set[str] = set()
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
    return n_int8, n_fp16


def run(model_path: Path, out_path: Path, scope: str, dedupe: bool,
        strip_meta: bool, strip_value_info: bool, strip_names: bool) -> dict:
    m = onnx.load(str(model_path))
    before = model_path.stat().st_size
    info = {"before": before}

    info["meta_removed"] = strip_debug_metadata(m) if strip_meta else 0
    if strip_value_info:
        info["value_info_removed"] = len(m.graph.value_info)
        del m.graph.value_info[:]
    if scope == "none":
        info["n_int8"] = info["n_fp16"] = 0
        if strip_names:
            del m.graph.value_info[:]
            for node in m.graph.node:
                node.name = ""
    else:
        info["n_int8"], info["n_fp16"] = quantize(m, scope, True, strip_names)
    # Quantisation re-creates byte-identical tensors (the sampling grids are the
    # same value under several names), so dedupe after it, not before.
    if dedupe:
        groups, saved = dedupe_initializers(m)
        info["dedupe_groups"] = groups
        info["dedupe_saved"] = saved

    onnx.checker.check_model(m)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(m, str(out_path))
    info["after"] = out_path.stat().st_size
    info["sha256"] = sha256_file(out_path)
    return info


def parity(base: Path, cand: Path, test_dir: Path) -> dict | None:
    try:
        import onnxruntime as ort
        from PIL import Image
    except ImportError:
        return None
    imgs = sorted(test_dir.glob("*.jpg"))
    if not imgs:
        return None
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sa = ort.InferenceSession(str(base), so, providers=["CPUExecutionProvider"])
    sb = ort.InferenceSession(str(cand), so, providers=["CPUExecutionProvider"])
    agg = {"max_abs": 0.0, "mae": 0.0, "iou": 1.0, "flips": 0, "bit_exact": True}
    for p in imgs:
        x = _input(p)
        a = sa.run(None, {"input_image": x})[0]
        b = sb.run(None, {"input_image": x})[0]
        d = np.abs(a - b)
        inter = ((a > 0.5) & (b > 0.5)).sum()
        union = ((a > 0.5) | (b > 0.5)).sum()
        agg["max_abs"] = max(agg["max_abs"], float(d.max()))
        agg["mae"] = max(agg["mae"], float(d.mean()))
        agg["iou"] = min(agg["iou"], float(inter / max(1, union)))
        agg["flips"] += int((d > 0.5).sum())
        agg["bit_exact"] = agg["bit_exact"] and bool(np.array_equal(a, b))
    return agg


def _input(p: Path) -> np.ndarray:
    from PIL import Image
    im = Image.open(p).convert("RGB").resize((512, 512), Image.BILINEAR)
    a = np.asarray(im, dtype=np.float32) / 255.0
    a = (a - np.array([0.485, 0.456, 0.406], np.float32)) / np.array(
        [0.229, 0.224, 0.225], np.float32)
    return a.transpose(2, 0, 1)[None].astype(np.float32)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--scope", default="none", choices=SCOPES)
    ap.add_argument("--no-dedupe", action="store_true")
    ap.add_argument("--no-strip-metadata", action="store_true")
    ap.add_argument("--strip-value-info", action="store_true")
    ap.add_argument("--strip-names", action="store_true")
    ap.add_argument("--baseline", type=Path)
    ap.add_argument("--test-images", default="test-images", type=Path)
    args = ap.parse_args()

    if not args.model.exists():
        raise SystemExit(f"missing {args.model}")

    info = run(args.model, args.out, args.scope, not args.no_dedupe,
               not args.no_strip_metadata, args.strip_value_info, args.strip_names)
    b, a = info["before"], info["after"]
    print(f"{args.out}")
    print(f"  size   {b:>12,} -> {a:>12,} B  ({b / 1e6:.2f} -> {a / 1e6:.2f} MB, "
          f"-{(b - a) / b * 100:.1f}%)")
    print(f"  sha256 {info['sha256']}")
    print(f"  metadata removed {info['meta_removed']:,} B; "
          f"dedupe {info.get('dedupe_groups', 0)} groups "
          f"{info.get('dedupe_saved', 0):,} B; int8 {info['n_int8']} fp16 {info['n_fp16']}")
    r = parity(args.baseline or args.model, args.out, args.test_images)
    if r:
        print(f"  parity: maxAbs {r['max_abs']:.6f}  MAE {r['mae']:.8f}  "
              f"IoU@0.5 {r['iou']:.6f}  conf-flips {r['flips']}  "
              f"bit-exact {r['bit_exact']}")


if __name__ == "__main__":
    raise SystemExit(main())
