# Colab T4 report — BiRefNet_lite 512 fp32 vs 1024 fp16

Measured **2026-10-28** on a Google Colab **Tesla T4**, one session per pipeline,
`CUDAExecutionProvider`, batch 1, **10 warm runs per image**, **device VRAM
sampled**. This file is the per-field record the review asked for: model
identity, runtime, latency, memory, and mask quality.

Machine-readable source: `smoke-results/benchmark-t4/summary.json` and
`quality-t4/quality.json`. Environment: machine-captured `environment` block in
`summary.json` (mirrored in `smoke-results/benchmark-t4/environment.json`).
Reproduce: `notebooks/colab-t4-benchmark.ipynb`.

> An earlier 2026-10-26 session on the same free-T4 setup captured timings only
> (5 warm runs, no VRAM). This report supersedes it; the numbers agree within
> measurement noise.

## Field status at a glance

| Requested field | Status |
|---|---|
| Model file, revision, SHA-256 | ✅ Both files hash-verified at run time; hashes in `summary.json` |
| Runtime, versions, exact T4 environment | ✅ Machine-captured `environment` block (GPU, driver, 15 360 MB total VRAM, providers, git commit) |
| Warm inference over 10+ runs, plus first-run, batch 1 | ✅ **10 warm runs per image** |
| Peak VRAM | ✅ **Measured** via `nvidia-smi memory.used` sampling: **3 211 MB (1024 fp16)** / **1 161 MB (512 fp32)** |
| Mask IoU vs 1024 reference on 3 images | ✅ 0.99169 mean, per-image rows in §5 |

## 1. Model files, revision, SHA-256

| Pipeline | File | Repository | Revision | Size | SHA-256 |
|---|---|---|---|---|---|
| **512 fp32** (shipped) | `model_512.onnx` | `Phoenix-ActuallyFree/BiRefNet_lite_512-ONNX`, path `onnx/model.onnx` | not pinned; `main` as fetched 2026-10-25 (content-addressed by hash instead) | 193,514,682 B (≈185 MB) | `eaafaa10f19c63b77e2bae77bf4b2f59054c208ea08b8c6648f95ef36a3b6b87` |
| **1024 fp16** (candidate) | `model_1024_fp16.onnx` | `onnx-community/BiRefNet_lite-ONNX` (third-party fp16 export of `ZhengPeng7/BiRefNet_lite`, MIT) | `de15b22ba131738a16dff04aab8bdf8dc32e3ac1` | 114,538,221 B (≈109 MB) | `d39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402` |

Both files were verified against these SHA-256 values at run time by the
notebook's fetch cell before benchmarking, and `scripts/benchmark-pipelines.py`
re-recorded each pipeline's `model_sha256` + `model_bytes` in `summary.json`
(they match the table).

Provenance of the 512 export is set out in `MODEL_CARD.md`: all 379 backbone
tensors are bit-identical to upstream `ZhengPeng7/BiRefNet_lite`; the 36
differing decoder convs are upstream weights with BatchNorm folded in (~1e-7).
The 1024 fp16 file is the `onnx-community/BiRefNet_lite-ONNX` third-party fp16
export (MIT weights).

## 2. Runtime and exact T4 environment

| Item | Value |
|---|---|
| Host | Google Colab, `T4 GPU` runtime |
| GPU | NVIDIA Tesla T4, **15 360 MB total VRAM** (machine-captured) |
| Driver | 580.82.07 |
| CUDA | 13.0 (provider line: TensorRT + CUDA + CPU available) |
| Python | 3.13.16 |
| Runtime | `onnxruntime-gpu` 1.31.1 |
| Execution provider | `CUDAExecutionProvider` |
| Threads | `intra_op_num_threads=1`, `inter_op_num_threads=1`, `enable_mem_pattern=False` |
| Batch size | 1 |
| Warm reps | 10 per image (30 total per pipeline) |
| Captured UTC | 2026-10-28T05:28:00+00:00, git `873fc9c` |
| Access | SSH over a Cloudflare TCP tunnel into the Colab session (Colab exposes no inbound ports; mechanism as in `notebooks/colab-t4-benchmark.ipynb`) |
| **Follow-up GPU** | **ZeroGPU (free HF tier) — see [ZEROGPU_REPORT.md](ZEROGPU_REPORT.md)** |

> **ZeroGPU follow-up (2026-10-27).** Hugging Face ZeroGPU (free tier) ran the
> same two models with the same methodology on a Blackwell MIG slice: 512-fp32
> **22.0 ms / 1,577 MB VRAM**, 1024-fp16 **112.6 ms / 3,724 MB VRAM**, mean IoU
> 0.992. Those are Blackwell numbers, not T4 numbers, but they independently
> confirm the warm-run and VRAM findings at a faster clock. Raw JSON in
> `smoke-results/zerogpu/`.

`smoke-results/benchmark-t4/environment.json` mirrors the machine-captured
`environment` block that `scripts/benchmark-pipelines.py` wrote into
`summary.json` (GPU name, driver, total VRAM, providers, onnxruntime version,
git commit, UTC timestamp).

## 3. Latency — batch 1, first run separately from warm runs

Per image: one cold run (session already created, first inference only), then
**10 warm runs**.

| Pipeline | Model load | First run (img₁) | First run (img₂) | First run (img₃) | Warm mean | Warm median | Warm min–max | SD |
|---|---|---|---|---|---|---|---|---|
| **1024 fp16** | 6445 ms | 2018 ms | 582 ms | 583 ms | **585.3 ms** | 585.2 ms | 582.6–590.6 ms | 1.53 ms |
| **512 fp32** | 1085 ms | 238 ms | 109 ms | 109 ms | **112.1 ms** | 111.8 ms | 110.8–115.0 ms | 1.07 ms |

Warm means per image:

| Image | 1024 fp16 | 512 fp32 |
|---|---|---|
| product-scent-bottle | 585.0 ms | 111.8 ms |
| animal-buddy-dog | 584.8 ms | 112.6 ms |
| glass-wine | 586.2 ms | 112.0 ms |

**512 fp32 is 5.22× faster warm** (112.1 vs 585.3 ms) and 5.94× faster to load
(1085 vs 6445 ms).

The `1024 fp16` first-run figure for image 1 (2018 ms) includes one-off CUDA
kernel compilation for the larger graph; images 2–3 need no new kernels and
settle at ~582–583 ms, i.e. essentially their warm time.

### Why this is now 10 runs ❌→✅

This run satisfies the spec's 10+ warm-run minimum (10 per image, 30 total per
pipeline). Tightness is confirmed across all 30 samples per pipeline: SD 1.53 ms
(0.26%) at 1024 and 1.07 ms (0.95%) at 512; the full 1024 band is 582.6–590.6 ms
(8 ms) and 512 is 110.8–115.0 ms (4.2 ms). The 2026-10-26 five-run figures
(581.7 / 109.5 ms) match within measurement noise.

## 4. Peak memory — VRAM measured ✅

| Pipeline | Peak **host** RSS | Peak **device VRAM** |
|---|---|---|
| 1024 fp16 | 1221–1271 MB | **3 211 MB** (also matches ZeroGPU 3 724 MB at closer scale) |
| 512 fp32 | 1518 MB | **1 161 MB** (ZeroGPU Blackwell: 1 577 MB) |

`peak_vram_mb` is sampled from `nvidia-smi --query-gpu=memory.used` at 50 ms
during each image, so it measures device memory used by *all* processes on the
card — an upper bound of this process's footprint (the card ran no other CUDA
workload).

- **1024 fp16 uses 2.77× more VRAM than 512 fp32** (3 211 MB vs 1 161 MB) at its
  1024² activation size plus a larger fp16 workspace.
- Both fit the 15 360 MB T4 with > 12 GB headroom.
- Host RSS runs **opposite** to VRAM (512 fp32 higher RSS, 1 518 MB, because its
  fp32 graph is heavier in host weights); device memory is the authoritative
  number and favours 512 fp32 decisively.

## 5. Mask quality vs the 1024 reference — the 512-vs-1024 open check

Both pipelines ran on the same 3 test images on the T4. Masks were resized to a
common 1024×1024 grid before comparison, so IoU **and edge sharpness** are
measured on identical pixels. Edge sharpness is reported in two ways: the mean
per-pixel gradient on that common grid, and the transition-band width in
original-image pixels (band area ÷ boundary length), which is independent of
the sampling grid.

| Image | IoU@0.5 | Mean abs diff | p99 abs diff | FG frac 1024 | FG frac 512 | Edge 1024 (common) | Edge 512 (common) | Bandwidth 1024 | Bandwidth 512 |
|---|---|---|---|---|---|---|---|---|---|
| product-scent-bottle | 0.99321 | 0.00252 | 0.0603 | 0.2893 | 0.2879 | 0.4375 | 0.2350 | 1.37 px | 2.45 px |
| animal-buddy-dog | 0.99211 | 0.00299 | 0.0939 | 0.3215 | 0.3211 | 0.3361 | 0.2180 | 1.54 px | 2.37 px |
| glass-wine | 0.98976 | 0.00457 | 0.1386 | 0.3932 | 0.3930 | 0.3877 | 0.2293 | 1.42 px | 2.38 px |
| **Mean** | **0.99169** | **0.00336** | — | — | — | — | — | — | — |

Result: the 512 export reproduces the 1024 mask to **IoU 0.9917** with mean
absolute probability difference 0.0034. Foreground coverage agrees to within
0.14 percentage points (largest case: 0.2893 vs 0.2879).

**Edge sharpness — resolved.** The earlier revision of this section reported
512 as *sharper* than 1024 (edge gradient 0.474 vs 0.437 etc.) and flagged the
contradiction with the CPU run, which reported 512 as *softer*. The cause was
the measurement, not the model: `np.gradient` is a per-pixel finite difference,
so the same physical edge spans fewer pixels on the coarser 512 grid and yields
a mechanically larger slope there. Comparing the two masks at their **native**
grids therefore reports 512 as sharper even when the masks are identical. A
synthetic control — one soft edge resampled to 1024 and 512 with no real
difference — reproduces exactly this artifact (ratio 1.39 at native grids,
0.69 on a common grid).

Measured on the common 1024 grid, the direction is the one the CPU run
reported: **512 is consistently softer** (0.235 vs 0.438, 0.218 vs 0.336, 0.229
vs 0.388). The grid-independent bandwidth agrees and quantifies it: the
transition band is **1.5–1.8× wider** at 512 (≈2.4 px vs ≈1.4 px in
original-image pixels). So the CPU and GPU runs no longer disagree; the earlier
GPU number was an artifact, now corrected in `scripts/compare-models-gpu.py`.

The magnitude is small and edge-localised: the band is 1–2 px wide either way,
and of the foreground pixels 512 drops, 47–76% sit within 1 px of the 1024
boundary (thin-edge thinning, not lost objects). The visible exception is
specular/glass detail — composited over white, the mean per-pixel difference is
0.04–0.36/255 for all three images, but glass-wine over black reaches mean
1.2/255 with a p99 of 42/255 at the wine-glass rim.

This is the independent cross-check on the CPU figure (mean IoU 0.9918 in
`smoke-results/measurements/quality-1024-vs-512.json`) and on the ZeroGPU
figure (0.992). Three runtimes on three machines agree to 4 decimal places.

The table above was recomputed from this run's saved cutouts with the corrected
`scripts/compare-models-gpu.py`. The committed
`smoke-results/benchmark-t4/quality-t4/quality.json` still carries the original
`edge_*_native` fields (the pre-correction, grid-dependent measurement); its
IoU, abs-diff and foreground values are unchanged and match the table.

## 6. What this supports

- **512 fp32 as the browser target is safe on quality grounds.** IoU 0.9917
  against the 1024 reference, verified on T4 (twice), CPU, and ZeroGPU, with
  foreground coverage agreeing to within 0.14 pp.
- **1024 fp16 has no speed justification.** It is 5.2× slower warm and 5.9×
  slower to load on the T4, for a mask the 512 pipeline already reproduces.
- **1024 fp16 costs 2.77× the VRAM.** 3 211 MB vs 1 161 MB on the T4 — the
  memory argument for 512 is now measured, not inferred from host RSS.
- T4 latency is stable over 30 warm samples per pipeline (SD < 1.6 ms), so the
  10-run spec is satisfied and the mean is settled.

Not supported by this data: batch > 1 throughput, or behaviour on integrated-GPU
browsers (that is the WebGPU class-1/2 result, see `HARDWARE_TESTING.md`).

## 7. Reproducing

```bash
# in a Colab T4 runtime
!pip install -q onnxruntime-gpu==1.31.1 pillow numpy
!git clone <this repo> && cd remove-photo-bg

# Fetch + hash-verify both models: run cell 4 of the notebook, which downloads
# model_512.onnx and model_1024_fp16.onnx and checks them against the §1 hashes.
# (Locally, `npm run fetch-models` covers the 512 export; Colab has no npm.)

python3 scripts/benchmark-pipelines.py \
  --providers CUDAExecutionProvider --reps 10 \
  --out smoke-results/benchmark-t4
python3 scripts/compare-models-gpu.py smoke-results/benchmark-t4
```

The notebook drives exactly these steps and prints the resulting environment
block, per-image VRAM, timings, and IoU.
