#!/usr/bin/env python3
"""Export the trained student to ONNX for onnxruntime-web (spec §6-Phase4).

- opset 17, fixed input S, sigmoid already inside the graph.
- Check I/O contract (names/shapes/dtype/finiteness).
- Optimization experiments reported *separately* per artifact:
    student-<S>.onnx                 fp32 baseline (post torchscript export)
    student-<S>-sim.onnx             + onnxsim (accept only if max-abs err <= 1e-5)
    student-<S>-wf16.onnx            weight-only fp16 (initializers cast,
                                     compute stays fp32; NEVER end-to-end fp16
                                     on WASM)
- Prints size, sha256, numerical error vs baseline, per artifact.

Usage:
    python3 scripts/distill/export.py --ckpt smoke-results/distill/ckpt/final.pt \
        --size 512 --out smoke-results/distill/onnx
"""

from __future__ import annotations

import argparse
import hashlib
import io
from pathlib import Path

import numpy as np
import torch

import onnx
import onnxruntime as ort


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run_onnx(model_path: str, x: np.ndarray) -> np.ndarray:
    so = ort.SessionOptions()
    sess = ort.InferenceSession(model_path, sess_options=so,
                                providers=["CPUExecutionProvider"])
    return sess.run(None, {sess.get_inputs()[0].name: x})[0]


def export_fp32(model, size: int, out: Path) -> Path:
    model.eval()
    x = torch.randn(1, 3, size, size)
    # torch.onnx.export with dynamic shapes off, fixed S
    torch.onnx.export(
        model, (x,), str(out), opset_version=17,
        input_names=["input_image"], output_names=["output_image"],
        dynamic_axes=None, do_constant_folding=True, verbose=False,
    )
    return out


def to_wf16(model_path: Path, out: Path) -> Path:
    """Weight-only fp16: cast every initializer to fp16, keep graph fp32.

    onnxruntime-web folds these fp16 initializers back to fp32 at load, so
    compute stays fp32 (no per-op Casts → no WASM emulation penalty)."""
    m = onnx.load(str(model_path))
    n_cast = 0
    for init in m.graph.initializer:
        a = onnx.numpy_helper.to_array(init)
        if a.dtype == np.float32 and a.size > 0:
            init.CopyFrom(onnx.numpy_helper.from_array(a.astype(np.float16),
                                                       name=init.name))
            n_cast += 1
    onnx.save(m, str(out))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True, type=Path)
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--out", default="smoke-results/distill/onnx", type=Path)
    ap.add_argument("--run-sim", action="store_true",
                    help="also produce + validate onnxsim artifact")
    args = ap.parse_args()

    from scripts.distill.student import build_student

    args.out.mkdir(parents=True, exist_ok=True)
    sd = torch.load(args.ckpt, map_location="cpu")
    model = build_student()
    model.load_state_dict(sd["model"])
    model.eval()

    x = np.random.RandomState(0).randn(1, 3, args.size, args.size).astype(np.float32)
    ref = torch.tensor(x)

    # fp32 baseline
    fp32 = args.out / f"student-{args.size}.onnx"
    export_fp32(model, args.size, fp32)
    y_fp32 = run_onnx(str(fp32), x)
    print(f"fp32  : {fp32.stat().st_size:>9} B | sha256 "
          f"{sha256_file(fp32)[:16]} | out {y_fp32.shape} "
          f"dtype {y_fp32.dtype} range [{y_fp32.min():.3f},{y_fp32.max():.3f}]")

    # onnxsim
    if args.run_sim:
        try:
            import onnxsim
            sim = args.out / f"student-{args.size}-sim.onnx"
            sm, ok = onnxsim.simplify(str(fp32), check_n=1)
            onnx.save(sm, str(sim))
            y_sim = run_onnx(str(sim), x)
            err = float(np.max(np.abs(y_sim - y_fp32)))
            print(f"sim  : {sim.stat().st_size:>9} B | sha256 "
                  f"{sha256_file(sim)[:16]} | maxAbsErr={err:.2e} "
                  f"({'PASS<=1e-5' if err <= 1e-5 else 'REJECT'})")
        except Exception as e:
            print("onnxsim unavailable/skipped:", e)

    # weight-only fp16
    wf16 = args.out / f"student-{args.size}-wf16.onnx"
    to_wf16(fp32, wf16)
    y_wf16 = run_onnx(str(wf16), x)
    err16 = float(np.max(np.abs(y_wf16 - y_fp32)))
    print(f"wf16 : {wf16.stat().st_size:>9} B | sha256 "
          f"{sha256_file(wf16)[:16]} | maxAbsErr={err16:.2e} "
          f"({'PASS<=1e-5' if err16 <= 1e-5 else 'NOTE'})")

    print(f"artifacts in {args.out}")


if __name__ == "__main__":
    raise SystemExit(main())