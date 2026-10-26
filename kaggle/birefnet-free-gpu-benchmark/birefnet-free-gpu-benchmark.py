#!/usr/bin/env python3
"""
BiRefNet_lite free-GPU benchmark (Kaggle GPU).

Compares the two candidate browser pipelines on a free GPU session:
  1. 1024x1024 fp16 export (onnx-community/BiRefNet_lite-ONNX) — GPU-friendly,
     but too memory-heavy for browser WASM.
  2. 512x512 fp32 export (Phoenix-ActuallyFree/BiRefNet_lite_512-ONNX) — the
     shipped browser artifact.

Methodology matches scripts/benchmark-pipelines.py (one session per pipeline,
cold start separated from N warm runs, peak RSS sampled, masks saved for
quality comparison). On Kaggle we can also record the CUDA/ROCm device name.

Outputs under /kaggle/working/:
  summary.json
  masks/<image>_<pipeline>.npy

Run with: python3 birefnet-free-gpu-benchmark.py [--reps 5] [--provider cuda]
"""

import argparse
import json
import os
import sys
import threading
import time

import numpy as np

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

IMAGES = [
    # (URL, local file). The test images are committed in the octoborg-x
    # repo, so we fetch them from raw.githubusercontent.com; if the network is
    # restricted we synthesise a deterministic stand-in (see _fetch_image).
    ("https://raw.githubusercontent.com/octoborg-x/remove-photo-bg/main/test-images/product-scent-bottle.jpg", "test-images/product-scent-bottle.jpg"),
    ("https://raw.githubusercontent.com/octoborg-x/remove-photo-bg/main/test-images/animal-buddy-dog.jpg", "test-images/animal-buddy-dog.jpg"),
    ("https://raw.githubusercontent.com/octoborg-x/remove-photo-bg/main/test-images/glass-wine.jpg", "test-images/glass-wine.jpg"),
]

# Order matters: run the 1024 (memory-heavy) pipeline first so a co-resident
# session never shares the peak.
PIPELINES = [
    {
        "label": "1024-fp16",
        "model_url": "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model_fp16.onnx",
        "model_sha256": "d39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402",
        "size": 1024,
        "output_is_logits": True,
    },
    {
        "label": "512-fp32",
        "model_url": "https://huggingface.co/Phoenix-ActuallyFree/BiRefNet_lite_512-ONNX/resolve/main/onnx/model.onnx",
        "model_sha256": "eaafaa10f19c63b77e2bae77bf4b2f59054c208ea08b8c6648f95ef36a3b6b87",
        "size": 512,
        "output_is_logits": False,
    },
]


def _download(url: str, dest: str, sha256: str) -> None:
    import hashlib
    if os.path.exists(dest):
        h = hashlib.sha256(open(dest, "rb").read()).hexdigest()
        if h == sha256:
            return dest
    import urllib.request
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    print(f"downloading {url}", flush=True)
    urllib.request.urlretrieve(url, dest)
    h = hashlib.sha256(open(dest, "rb").read()).hexdigest()
    if h != sha256:
        raise RuntimeError(f"SHA-256 mismatch for {dest}: {h} != {sha256}")
    print(f"  downloaded {dest} ({os.path.getsize(dest)//1024} KiB)", flush=True)
    return dest


def _fetch_image(url: str, local: str) -> str:
    """Download an image, or synthesise a deterministic stand-in."""
    if os.path.exists(local):
        return local
    try:
        import urllib.request
        os.makedirs(os.path.dirname(local), exist_ok=True)
        urllib.request.urlretrieve(url, local)
        from PIL import Image
        Image.open(local).verify()
        return local
    except Exception as exc:
        print(f"image download failed ({exc}); using synthetic stand-in", flush=True)
        return _synthetic_image(local)


def _synthetic_image(local: str) -> str:
    """Deterministic RGB 'product on a background' frame (960x1280)."""
    from PIL import Image, ImageDraw
    rng = np.random.default_rng(hash(local) % 2**32)
    img = Image.new("RGB", (960, 1280))
    d = ImageDraw.Draw(img)
    # soft gradient background
    bg = np.zeros((1280, 960, 3), dtype=np.uint8)
    for y in range(1280):
        bg[y, :, 0] = int(120 + 60 * np.sin(y / 90))
        bg[y, :, 1] = int(100 + 50 * np.cos(y / 110))
        bg[y, :, 2] = int(90 + 40 * np.sin(y / 130))
    img = Image.fromarray(bg, "RGB")
    d = ImageDraw.Draw(img)
    # a glossy bottle-ish shape + a small blob in the middle
    w, h = img.size
    cx, cy = w // 2, h // 2
    for rect in [
        (cx - 90, cy - 260, cx + 90, cy + 260),
        (cx - 40, cy - 380, cx + 40, cy - 240),
    ]:
        d.rounded_rectangle(rect, radius=30, fill=(40, 70, 160, 255))
    d.ellipse((cx - 130, cy - 60, cx + 130, cy + 60), fill=(220, 40, 40, 255))
    d.ellipse((cx + 200, cy - 300, cx + 260, cy - 240), fill=(40, 180, 90, 255))
    os.makedirs(os.path.dirname(local), exist_ok=True)
    img.save(local)
    return local


def _preprocess_frames(path: str, size: int) -> np.ndarray:
    from PIL import Image
    img = Image.open(path).convert("RGB").resize((size, size), Image.BILINEAR)
    arr = np.asarray(img, dtype=np.float32) / 255.0
    arr = (arr - MEAN) / STD
    return np.ascontiguousarray(arr.transpose(2, 0, 1)[None, ...], dtype=np.float32)


def _peak_rss_mb() -> float:
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return float(line.split()[1]) / 1024.0
    except OSError:
        pass
    return 0.0


def _ensure_runtime():
    """Import onnxruntime, installing it (and numpy/PIL) if needed.

    Kaggle GPU images normally ship onnxruntime-gpu; if a fresh Python 3.13
    image lacks it we try pip, first "-gpu" then plain CPU-only, with retries
    and a 60 s timeout because the sandbox DNS can be flaky. All pip failures
    are surfaced, not swallowed, so a run never silently falls back to CPU if
    the user asked for cuda.
    """
    import socket
    import subprocess

    # Diagnose sandbox egress before spending minutes on pip retries.
    for host in ("pypi.org", "huggingface.co", "raw.githubusercontent.com"):
        try:
            socket.gethostbyname(host)
            print(f"DNS OK  {host}", flush=True)
        except OSError as exc:
            print(f"DNS FAIL {host}: {exc}", flush=True)

    candidates = ["onnxruntime-gpu", "onnxruntime"]
    packages = ["numpy", "pillow", "onnx"]
    for pkg in candidates:
        try:
            print(f"installing {pkg} …", flush=True)
            subprocess.run(
                [sys.executable, "-m", "pip", "-q", "install",
                 "--timeout", "60", "--retries", "6", pkg, *packages],
                check=True,
                env={**os.environ, "PIP_DISABLE_PIP_VERSION_CHECK": "1"},
            )
        except subprocess.CalledProcessError as exc:
            print(f"pip install {pkg} failed: {exc}", flush=True)
            continue
        try:
            import onnxruntime as ort
            return ort
        except ImportError as exc:
            print(f"import onnxruntime after {pkg} install failed: {exc}", flush=True)
    raise SystemExit(
        "onnxruntime unavailable: pip could not install onnxruntime-gpu or "
        "onnxruntime (pypi unreachable from the sandbox?). Enable internet "
        "on the Kaggle kernel or preinstall the wheel."
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=5)
    ap.add_argument(
        "--provider",
        default="cuda",
        help="onnxruntime provider: cuda (Kaggle Nvidia), rocm (SavedModel AMI), cpu",
    )
    args = ap.parse_args()

    try:
        import onnxruntime as ort
    except ImportError:
        ort = _ensure_runtime()

    avail = ort.get_available_providers() or []
    providers = {
        "cuda": ["CUDAExecutionProvider", "CPUExecutionProvider"],
        "rocm": None,  # provider list auto-selected
        "cpu": ["CPUExecutionProvider"],
    }.get(args.provider)
    if args.provider == "cuda" and "CUDAExecutionProvider" not in avail:
        print("WARNING: CUDA provider not available; falling back to CPU.", flush=True)
        providers = ["CPUExecutionProvider"]
    print(f"available providers: {avail}", flush=True)

    out_dir = os.environ.get("KAGGLE_WORKING_DIR", "/kaggle/working")
    os.makedirs(f"{out_dir}/masks", exist_ok=True)

    dev_info = {}
    try:
        import subprocess
        dev_info["nvidia_smi"] = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except Exception:
        dev_info["nvidia_smi"] = None
    try:
        import platform
        dev_info["platform"] = platform.platform()
    except Exception:
        pass

    summary = {
        "note": "Kaggle free-GPU benchmark; methodology mirrors scripts/benchmark-pipelines.py",
        "reps": args.reps,
        "provider": args.provider,
        "device": dev_info,
        "pipelines": [],
    }

    for p in PIPELINES:
        model_path = _download(p["model_url"], f"{out_dir}/models/{os.path.basename(p['label'])}.onnx", p["model_sha256"])
        size = p["size"]

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 4
        opts.enable_cpu_mem_arena = False

        t0 = time.perf_counter()
        try:
            sess = ort.InferenceSession(model_path, sess_options=opts, providers=providers)
        except Exception as exc:  # e.g. OOM on 1024
            summary["pipelines"].append({"label": p["label"], "error": str(exc)})
            print(f"{p['label']}: session creation FAILED: {exc}", flush=True)
            continue
        load_ms = (time.perf_counter() - t0) * 1000
        in_name = sess.get_inputs()[0].name
        out_name = sess.get_outputs()[0].name
        provider_used = sess.get_providers()

        entries = []
        for url, rel in IMAGES:
            local = f"{out_dir}/test-images/{os.path.basename(rel)}"
            _fetch_image(url, local)
            tensor = _preprocess_frames(local, size)

            t0 = time.perf_counter()
            sess.run([out_name], {in_name: tensor})
            cold_ms = (time.perf_counter() - t0) * 1000

            rss: list[float] = []
            stop = threading.Event()

            def sampler():
                while not stop.is_set():
                    rss.append(_peak_rss_mb())
                    time.sleep(0.05)

            st = threading.Thread(target=sampler, daemon=True)
            st.start()
            timings = []
            for _ in range(args.reps):
                t0 = time.perf_counter()
                preds = sess.run([out_name], {in_name: tensor})[0]
                timings.append((time.perf_counter() - t0) * 1000)
            stop.set()
            st.join()

            m = preds[0, -1].astype(np.float32)
            if p["output_is_logits"]:
                m = 1.0 / (1.0 + np.exp(-m.astype(np.float64)))
            m = np.clip(m, 0.0, 1.0).astype(np.float32)

            base = os.path.splitext(os.path.basename(rel))[0]
            np.save(f"{out_dir}/masks/{base}_{p['label']}.npy", m)
            entries.append(
                {
                    "image": os.path.basename(rel),
                    "model_input": [1, 3, size, size],
                    "cold_ms": round(cold_ms, 1),
                    "warm_ms": [round(t, 1) for t in timings],
                    "warm_avg_ms": round(float(np.mean(timings)), 1),
                    "peak_rss_mb": round(max(rss, default=0), 1),
                }
            )
            del preds, m, tensor

        summary["pipelines"].append(
            {
                "label": p["label"],
                "model_url": p["model_url"],
                "model_sha256": p["model_sha256"],
                "load_ms": round(load_ms, 1),
                "provider_used": provider_used,
                "images": entries,
            }
        )
        print(f"{p['label']}: load {load_ms:.0f}ms warm " +
              " ".join(f"{e['warm_avg_ms']:.0f}ms" for e in entries), flush=True)

    with open(f"{out_dir}/summary.json", "w") as f:
        json.dump(summary, f, indent=2)
    print(f"Wrote {out_dir}/summary.json", flush=True)


if __name__ == "__main__":
    main()