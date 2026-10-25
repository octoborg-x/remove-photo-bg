#!/usr/bin/env python3
"""Native-CPU reference inference for Phase 1 correctness validation.

Matches the upstream BiRefNet pre/post-processing (handler.py):
  - pad/resize to (MODEL_SIZE, MODEL_SIZE) bilinear
  - rescale 1/255, ImageNet normalize
  - forward -> probability map [1,1,MODEL_SIZE,MODEL_SIZE] (sigmoid is baked in)
  - resize mask back to original size

Outputs:
  smoke-results/reference/<name>.mask.png   soft mask (grayscale PNG)
  smoke-results/reference/<name>.mask.npy   raw mask array
  smoke-results/reference/summary.json      metrics (mean, percentiles, time)

Usage: python3 scripts/reference-inference.py [image ...]
"""

import json
import os
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image

MODEL_SIZE = 512
MODEL_URL = os.environ.get(
    "BIREFNET_MODEL",
    "public/models/model_512.onnx",
)

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def preprocess(image: Image.Image) -> np.ndarray:
    img = image.convert("RGB")
    img = img.resize((MODEL_SIZE, MODEL_SIZE), Image.BILINEAR)
    arr = np.asarray(img, dtype=np.float32) / 255.0
    arr = (arr - MEAN) / STD
    # HWC -> CHW -> NCHW
    arr = arr.transpose(2, 0, 1)[None, ...].astype(np.float32)
    return arr


def main() -> None:
    images = sys.argv[1:] or [
        "test-images/product-scent-bottle.jpg",
        "test-images/animal-buddy-dog.jpg",
        "test-images/glass-wine.jpg",
    ]
    out_dir = "smoke-results/reference"
    os.makedirs(out_dir, exist_ok=True)

    sess = ort.InferenceSession(
        MODEL_URL,
        providers=["CPUExecutionProvider"],
        sess_options=ort.SessionOptions(),
    )
    print("Model loaded:", MODEL_URL)
    print("Providers:", sess.get_providers())
    in_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name

    summary = {"model": MODEL_URL, "inputs": [], "images": []}
    for path in images:
        image = Image.open(path)
        tensor = preprocess(image)
        t0 = time.perf_counter()
        preds = sess.run([out_name], {in_name: tensor})[0]
        elapsed = time.perf_counter() - t0

        # This export already applies sigmoid, so the map is a probability in
        # [0,1]. Resize it back to the original image size.
        mask = np.clip(preds[0, -1].astype(np.float64), 0.0, 1.0)
        mask = (mask * 255.0).round().astype(np.uint8)
        mask_pil = Image.fromarray(mask, mode="L").resize(image.size, Image.BILINEAR)

        base = os.path.splitext(os.path.basename(path))[0]
        mask_pil.save(os.path.join(out_dir, f"{base}.mask.png"))
        np.save(os.path.join(out_dir, f"{base}.mask.npy"), mask.astype(np.float32))

        entry = {
            "image": path,
            "original_size": list(image.size),
            "infer_ms": round(elapsed * 1000, 1),
            "mask_png": f"{base}.mask.png",
            "mask_stats": {
                "mean": round(float(mask.mean()), 6),
                "min": int(mask.min()),
                "max": int(mask.max()),
                "p50": int(np.percentile(mask, 50)),
                "p90": int(np.percentile(mask, 90)),
                "p99": int(np.percentile(mask, 99)),
            },
        }
        summary["images"].append(entry)
        print(json.dumps(entry, indent=2))

    with open(os.path.join(out_dir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print("Wrote smoke-results/reference/summary.json")


if __name__ == "__main__":
    main()