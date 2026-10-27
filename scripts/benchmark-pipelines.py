#!/usr/bin/env python3
"""Benchmark 1024 vs 512 inference pipelines with one consistent methodology.

This mirrors the methodology the Kaggle kernel would run on GPU: for each
model, one session, then per image:
  - warm latency over REPS runs (first run = cold start, separated)
  - peak RSS sampled around the run
  - mask saved to npy for downstream quality comparison

Outputs: smoke-results/benchmark/ (summary.json + masks/).

Usage:
  python3 scripts/benchmark-pipelines.py [--providers cpu,...] [--reps 5]
"""
import argparse
import json
import os
import resource
import tempfile
import threading
import time

import numpy as np
import onnxruntime as ort
from PIL import Image

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

IMAGES = [
    "test-images/product-scent-bottle.jpg",
    "test-images/animal-buddy-dog.jpg",
    "test-images/glass-wine.jpg",
]

# (label, model path, is_1024, output_is_logits)
PIPELINES = [
    ("1024-fp16", "/tmp/hf-model/model_1024_fp16.onnx", True, True),
    ("512-fp32", "public/models/model_512.onnx", False, False),
]


def preprocess(image: Image.Image, size: int) -> np.ndarray:
    img = image.convert("RGB").resize((size, size), Image.BILINEAR)
    arr = np.asarray(img, dtype=np.float32) / 255.0
    arr = (arr - MEAN) / STD
    return np.ascontiguousarray(arr.transpose(2, 0, 1)[None, ...], dtype=np.float32)


def peak_rss_mb() -> float:
    """Best-effort /proc RSS, falls back to getrusage."""
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return float(line.split()[1]) / 1024.0
    except OSError:
        pass
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--providers", default="CPUExecutionProvider")
    ap.add_argument("--reps", type=int, default=5)
    args = ap.parse_args()
    providers = [p for p in args.providers.split(",") if p]
    reps = max(1, args.reps)

    os.makedirs("smoke-results/benchmark/masks", exist_ok=True)
    summary = {"providers": providers, "reps": reps, "pipelines": []}

    for label, model_path, is_1024, is_logits in PIPELINES:
        size = 1024 if is_1024 else 512
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        opts.enable_mem_pattern = False

        t_load = time.perf_counter()
        sess = ort.InferenceSession(
            model_path, sess_options=opts, providers=providers
        )
        load_ms = (time.perf_counter() - t_load) * 1000
        in_name = sess.get_inputs()[0].name
        out_name = sess.get_outputs()[0].name

        entries = []
        for path in IMAGES:
            image = Image.open(path)
            tensor = preprocess(image, size)

            # cold start separated from warm runs
            t0 = time.perf_counter()
            sess.run([out_name], {in_name: tensor})
            cold_ms = (time.perf_counter() - t0) * 1000

            rss_samples: list[float] = []
            stop = threading.Event()

            def sampler() -> None:
                while not stop.is_set():
                    rss_samples.append(peak_rss_mb())
                    time.sleep(0.05)

            st = threading.Thread(target=sampler, daemon=True)
            st.start()
            timings = []
            for _ in range(reps):
                t0 = time.perf_counter()
                preds = sess.run([out_name], {in_name: tensor})[0]
                timings.append((time.perf_counter() - t0) * 1000)
            stop.set()
            st.join()

            m = preds[0, -1].astype(np.float32)
            if is_logits:
                m = 1.0 / (1.0 + np.exp(-m.astype(np.float64)))
            m = np.clip(m, 0.0, 1.0).astype(np.float32)

            base = os.path.splitext(os.path.basename(path))[0]
            np.save(f"smoke-results/benchmark/masks/{base}_{label}.npy", m)

            entries.append(
                {
                    "image": os.path.basename(path),
                    "original_size": list(image.size),
                    "model_input": [1, 3, size, size],
                    "cold_ms": round(cold_ms, 1),
                    "warm_ms": [round(t, 1) for t in timings],
                    "warm_avg_ms": round(float(np.mean(timings)), 1),
                    "peak_rss_mb": round(max(rss_samples, default=0), 1),
                    "mask_stats": {
                        "mean": round(float(m.mean()), 6),
                        "p50": int(np.percentile(m, 50) * 255),
                        "p95": int(np.percentile(m, 95) * 255),
                        "p99": int(np.percentile(m, 99) * 255),
                        "fg_frac": round(float((m > 0.5).mean()), 6),
                    },
                }
            )
            del preds, m, tensor

        summary["pipelines"].append(
            {"label": label, "model": model_path, "load_ms": round(load_ms, 1),
             "provider": providers[0], "images": entries}
        )
        print(f"{label}: load {load_ms:.0f}ms, "
              "avgWarm " + " ".join(f"{e['warm_avg_ms']:.0f}ms" for e in entries))

    with open("smoke-results/benchmark/summary.json", "w") as f:
        json.dump(summary, f, indent=2)
    print("Wrote smoke-results/benchmark/summary.json")


if __name__ == "__main__":
    main()