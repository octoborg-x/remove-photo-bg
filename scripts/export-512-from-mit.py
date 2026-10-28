#!/usr/bin/env python3
"""Re-export the 512×512 BiRefNet_lite ONNX artifact directly from the MIT
checkpoint.

Why this exists
---------------
The previously shipped ONNX (from the `Phoenix-ActuallyFree/BiRefNet_lite_512-ONNX`
HF mirror) is a faithful export, but that mirror declares **no licence** and its
commit SHA is unpinned. This script rebuilds the same artifact from the
upstream `ZhengPeng7/BiRefNet_lite` checkpoint at a **pinned commit**, under the
upstream **MIT** licence, and bakes the same output contract:

  input:  `input_image`  float32 [1,3,512,512]  (NCHW, ImageNet-normalised)
  output: `output_image` float32 [1,1,512,512]  probabilities  (sigmoid baked in)

The app (see src/main.ts, src/features/..., public/inference-worker.js) sets
`MODEL_OUTPUT_IS_PROBABILITY = true`, so the graph must keep that behaviour.

Usage
-----
    python3 scripts/export-512-from-mit.py [--out public/models/model_512.onnx]

Requirements: torch (CPU), transformers, safetensors, onnx, numpy.
The checkpoint is downloaded from the pinned upstream commit; no Phoenix mirror
is touched.

Licence: upstream ZhengPeng7/BiRefNet, MIT. See THIRD_PARTY_LEGAL_NOTICES.md.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import torch


# Pinned upstream revision. Commit "Complete the MIT license in the model card"
# (2026-08-29) — the exact snapshot this project's provenance records verified.
# Bumping this SHA requires re-verifying the provenance section of MODEL_CARD.md
# and THIRD_PARTY_LEGAL_NOTICES.md (weight hash comparison, licence text).
VERIFIED_COMMIT = "aa62cd87eafb9cc43056d08ef3615a14628b831d"

REPO = "ZhengPeng7/BiRefNet_lite"
MODEL_SIZE = 512
MODEL_NAME = "model_512.onnx"
SIGMOID_BAKED = True

# SANITY: the upstream handler applies `preds[..., -1].sigmoid()`. In eval mode
# the model emits a single map from decoder `conv_out1`, so the raw logit should
# already be the main prediction; we bake sigmoid so the ONNX output is a
# probability map, exactly like the previously shipped artifact.
def _download_checkpoint(dst: Path) -> None:
    from huggingface_hub import snapshot_download

    # Note: no "already exists" early-return here. `dst` is a fresh temp dir
    # per invocation; a stale dir with the same name from a killed run must not
    # be reused (it may miss files). Downloads are small (~170 MB) and the HF
    # cache makes re-entrant runs fast.
    print(f"downloading {REPO}@{VERIFIED_COMMIT} to {dst}")
    snapshot_download(
        repo_id=REPO,
        revision=VERIFIED_COMMIT,
        local_dir=str(dst),
        force_download=True,
    )
    print("checkpoint downloaded")


def _load_model(ckpt_dir: Path):
    """Load upstream BiRefNet_lite weights without relying on AutoModel.

    The upstream repo's `config.json` declares `model_type` hack
    ("SegformerForSemanticSegmentation"), which transformers >= 5 refuses in
    the auto-mapping path. We load `birefnet.BiRefNet` directly instead:

      1. pre-register `BiRefNet_config` so `birefnet.py`'s relative import
         (`from .BiRefNet_config import BiRefNetConfig`) resolves;
      2. import `birefnet.py` as a plain module;
      3. instantiate BiRefNet(config), then load the safetensors state dict.

    The model is a pure-CNN decoder (conv + bilinear upsample), so the same
    weights run at any input size; we export at 512×512 to match the app's
    fixed input and the ~1.1 GB WASM-memory budget.
    """
    import importlib.util
    import sys

    ckpt = str(ckpt_dir)
    sys.path.insert(0, ckpt)

    # 1. Pre-register the sibling config module so the relative import works.
    cfg_name = "BiRefNet_config"
    if cfg_name not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            cfg_name, str(ckpt_dir / "BiRefNet_config.py")
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        sys.modules[cfg_name] = mod

    # 2. Import birefnet.py as a module. Give it a package name so its
    #    `from .BiRefNet_config import BiRefNetConfig` resolves to a child
    #    module that we register below.
    bn_name = "birefnet_upstream"
    spec = importlib.util.spec_from_file_location(bn_name, str(ckpt_dir / "birefnet.py"))
    bn = importlib.util.module_from_spec(spec)
    bn.__package__ = bn_name
    sys.modules[bn_name] = bn
    sys.modules[f"{bn_name}.{cfg_name}"] = sys.modules[cfg_name]
    spec.loader.exec_module(bn)
    BiRefNetConfig = bn.BiRefNetConfig

    # The upstream BiRefNet.__init__ ignores the passed config beyond
    # bb_pretrained and overwrites self.config with its own Config(); we only
    # need bb_pretrained=False because we load the *lite* checkpoint weights.
    config = BiRefNetConfig(bb_pretrained=False)
    model = bn.BiRefNet(bb_pretrained=False, config=config)
    model.eval()

    from safetensors.torch import load_file

    state = load_file(str(ckpt_dir / "model.safetensors"))
    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing:
        raise RuntimeError(f"missing keys when loading weights: {missing[:10]}…")
    if unexpected:
        print(f"WARNING: {len(unexpected)} unexpected keys ignored: {unexpected[:5]}…")
    return model


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/models/model_512.onnx")
    ap.add_argument("--keep-temp", action="store_true", help="keep the temp checkpoint dir")
    ap.add_argument("--no-verify", action="store_true", help="skip the reference-inference sanity run after export")
    args = ap.parse_args()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="birefnet-lite-") as td:
        ckpt_dir = Path(td)
        _download_checkpoint(ckpt_dir)

        import torch.onnx  # noqa: F401  (ensures opset registry available)

        import sys

        sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor"))
        import deform_conv2d_onnx_exporter

        # Register a symbolic that decomposes torchvision::deform_conv2d into
        # standard ONNX ops. The decoder's ASPPDeformable head uses DCNv2;
        # without a symbolic the TorchScript exporter refuses the custom op.
        deform_conv2d_onnx_exporter.register_deform_conv2d_onnx_op()

        model = _load_model(ckpt_dir)
        model.eval()

        # Freeze BN running stats for deterministic export.
        for m in model.modules():
            if isinstance(m, torch.nn.modules.batchnorm._BatchNorm):
                m.training = False

        dummy = torch.randn(1, 3, MODEL_SIZE, MODEL_SIZE)

        # Wrap: take forward's single prediction map and bake sigmoid if set.
        class ExportWrapper(torch.nn.Module):
            def __init__(self, inner):
                super().__init__()
                self.inner = inner
                self.bake = SIGMOID_BAKED

            def forward(self, x):
                preds = self.inner(x)
                # eval mode -> single map already at full res; upstream handler uses [-1]
                out = preds[-1]
                if self.bake:
                    return torch.sigmoid(out)
                return out

        wrapped = ExportWrapper(model)

        torch.onnx.export(
            wrapped,
            dummy,
            str(out_path),
            input_names=["input_image"],
            output_names=["output_image"],
            opset_version=17,
            dynamic_axes=None,  # fixed 512×512 to match the app's fixed input
            do_constant_folding=True,
            dynamo=False,  # stable TorchScript exporter, no onnxscript needed
        )
        print("wrote", out_path)

    sha = _sha256_file(out_path)
    print("SHA-256:", sha)
    print(f"bytes: {out_path.stat().st_size}")

    if args.no_verify:
        return

    print("--- verifying with onnxruntime CPU ---")
    import onnxruntime as ort
    import onnx

    onnx.checker.check_model(str(out_path))
    sess = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    in_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name
    print("inputs:", [(i.name, i.shape, i.type) for i in sess.get_inputs()])
    print("outputs:", [(o.name, o.shape, o.type) for o in sess.get_outputs()])
    probe = dummy.numpy()
    res = sess.run([out_name], {in_name: probe})[0]
    print("output range:", float(np.min(res)), "..", float(np.max(res)))
    assert res.shape == (1, 1, MODEL_SIZE, MODEL_SIZE), res.shape
    assert float(np.min(res)) >= 0.0 and float(np.max(res)) <= 1.0
    print("OK — output is [1,1,512,512] probabilities (sigmoid baked in)")


if __name__ == "__main__":
    main()