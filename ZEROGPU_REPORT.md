# ZeroGPU benchmark report (HF free-tier GPU)

**Date:** 2026-10-27 · **Hardware:** NVIDIA RTX PRO 6000 Blackwell Server Edition,
MIG 2g.48gb slice on Hugging Face **ZeroGPU** · **Runtime:** torch 2.13.0+cu130,
CUDA 13.0, onnxruntime(-gpu) 1.31.1, Python 3.12.12 · **Space:**
[`Octoborg/remove-photo-bg-benchmark`](https://huggingface.co/spaces/Octoborg/remove-photo-bg-benchmark)

## Why this exists

The Colab T4 GPU tier expired, so `COLAB_T4_REPORT.md` had two data gaps:
**10+ warm runs** and **peak VRAM** (only 5 reps and no VRAM were captured).
This report closes both gaps on Hugging Face's free tier (ZeroGPU) and adds a
second hardware point (Blackwell, not T4) with the **same methodology and the
same two ONNX models** used for the T4 numbers.

## Results (10 warm runs/image, real CUDA, SHA-256-verified models)

| metric | 512-fp32 | 1024-fp16 |
|---|---|---|
| warm mean (all images) | **22.0 ms** | **112.6 ms** |
| warm median | 21.4 ms | 112.5 ms |
| warm min/max | 21.3 / 27.8 ms | 112.2 / 113.5 ms |
| SD | 1.63 | 0.31 |
| first-run cold | 75.3 ms | 235.9 ms |
| peak VRAM (device-wide) | **1,577 MB** | **3,724 MB** |
| model size on disk | 193.5 MB | 114.5 MB |
| model SHA-256 (prefix) | `eaafaa10…` | `d39b897c…` |

Quality vs the 1024 reference (resized to common 1024² grid; edge sharpness at
native resolution):

| image | IoU@0.5 | mean \|Δ\| | fg 1024 / 512 | edge 1024 / 512 |
|---|---|---|---|---|
| product-scent-bottle | 0.99319 | 0.00252 | 0.2893 / 0.2878 | 0.4375 / 0.4741 |
| animal-buddy-dog | 0.99214 | 0.00298 | 0.3215 / 0.3211 | 0.3361 / 0.4221 |
| glass-wine | 0.98985 | 0.00455 | 0.3931 / 0.3930 | 0.3877 / 0.4526 |
| **mean** | **0.99173** | — | — | — |

Same relationship as on the T4: the coarser 512 input is **faster and less
memory-hungry** but has **sharper edges at native resolution** (0.4741/0.4221/
0.4526 vs 0.4375/0.3361/0.3877), with near-identical foreground fractions and
IoU ~0.992.

## How to rerun

1. Open the [Space](https://huggingface.co/spaces/Octoborg/remove-photo-bg-benchmark)
   (or `curl -X POST .../gradio_api/call/run`), press *Run benchmark*.
2. Wait ~8 s for the 10-warm-run pass; the Space renders a Markdown digest.
3. Full JSON: `/gradio_api/file=/tmp/spaces-run/summary.json` and
   `/gradio_api/file=/tmp/spaces-run/quality.json` (also mirrored back into the
   Space repo as `latest-summary.json` / `latest-quality.json`).

## What ZeroGPU is (and is not)

- **Free for personal accounts.** ZeroGPU is genuinely free: free accounts in
  good standing can host **up to 2 Gradio Spaces on ZeroGPU**. No credits, no
  billing.
- **Not a T4 and not an exabyte of shell.** It's a shared pool of RTX Pro 6000
  Blackwell (currently) with **no SSH and no interactive shell** — you run a
  Gradio (or static) app, and CUDA is only available inside
  `@spaces.GPU`-decorated functions. Outside those, CUDA is emulated and
  `torch.cuda.is_available()` is `False` (it *appears* available but allocations
  don't touch the real GPU).
- **Quotas.** Free accounts get **~5 minutes of GPU/day**, and a single
  `@spaces.GPU` call has a small max duration (~1–2 min; `duration` is also
  multiplied by a per-model `duration_factor` of **1.5** on this Blackwell
  class). Use `duration=90` or lower, and keep all GPU work inside one call.
- **Pre-receive hook rejects binary blobs** — test images were base64-embedded
  in `app.py` instead.
- **Paid HF Jobs on T4** exist (billed per minute, `t4-small`/`t4-medium` as of
  Oct 2026) but are **not** free — they need a payment method, so they are not
  part of this test path.

## Free-tier footprint

- Gradio Space created with `space_hardware=SpaceHardware.ZERO_A10G`
  (`SpaceHardware.ZERO_A10G` unambiguously selects ZeroGPU).
- `create_repo(repo_type="space", space_sdk="gradio", space_hardware="zero-a10g")`
  — creating a *plain* GPU Space (cpu-basic) on a free account returns
  **HTTP 402** ("requires PRO"); creating it *as ZeroGPU* succeeds with the
  same write-scoped token.
- Verified end-to-end: `BUILDING → APP_STARTING → RUNNING (zero-a10g)`, live
  SSE run, artifacts retrieved via `/gradio_api/file=…`.

## Artifacts

- `smoke-results/zerogpu/summary.json` — full machine-captured environment +
  per-pipeline warm/cold/VRAM/mask-stats.
- `smoke-results/zerogpu/quality.json` — IoU / diff / edge rows.
- `smoke-results/zerogpu/masks/*.npy` — raw probability masks for both runs.
- `notebooks/colab-t4-benchmark.ipynb` — T4 manual; the Space `app.py` mirrors
  it for automatic reruns.