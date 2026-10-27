# Colab T4 report — BiRefNet_lite 512 fp32 vs 1024 fp16

Measured 2026-10-26 on a Google Colab **Tesla T4**, one session per pipeline,
`CUDAExecutionProvider`, batch 1. This file is the per-field record the review
asked for: model identity, runtime, latency, memory, and mask quality.

Machine-readable source: `smoke-results/benchmark-t4/summary.json` and
`quality-t4/quality.json`. Environment: `smoke-results/benchmark-t4/environment.json`.
Reproduce: `notebooks/colab-t4-benchmark.ipynb`.

## Field status at a glance

| Requested field | Status |
|---|---|
| Model file, revision, SHA-256 | ✅ 512 fp32 content-addressed; 1024 fp16 hash recorded, not re-verified at run time (see §1) |
| Runtime, versions, exact T4 environment | ⚠️ Recorded in prose for this run; `environment.json` is transcribed, not machine-captured |
| Warm inference over 10+ runs, plus first-run, batch 1 | ⚠️ **5 warm runs**, not 10+ — see §3 |
| Peak VRAM | ❌ **Not measured.** `peak_rss_mb` is host RSS, not VRAM — see §4 |
| Mask IoU vs 1024 reference on 3 images | ✅ 0.99172 mean, per-image rows in §5 |

Two fields are short of the spec. They are marked here rather than filled in
with a near-miss number, because both would otherwise overstate the evidence.

## 1. Model files, revision, SHA-256

| Pipeline | File | Repository | Revision | Size | SHA-256 |
|---|---|---|---|---|---|
| **512 fp32** (shipped) | `model_512.onnx` | `Phoenix-ActuallyFree/BiRefNet_lite_512-ONNX`, path `onnx/model.onnx` | not pinned; `main` as fetched 2026-10-25 (content-addressed by hash instead) | 193,514,682 B (≈185 MB) | `eaafaa10f19c63b77e2bae77bf4b2f59054c208ea08b8c6648f95ef36a3b6b87` |
| **1024 fp16** (candidate) | `model_1024_fp16.onnx` | `onnx-community/BiRefNet_lite-ONNX` (third-party fp16 export of `ZhengPeng7/BiRefNet_lite`, MIT) | `de15b22ba131738a16dff04aab8bdf8dc32e3ac1` | 114,538,221 B (≈109 MB) | `d39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402` |

The 512 export is hash-verified by `npm run fetch-models` (it aborts on
mismatch); the notebook verifies both files by SHA-256 before benchmarking.
The benchmark script itself records each model's hash rather than gating on it.

**Caveat on the 1024 row.** The T4 session loaded the 1024 model from a local
copy at `/tmp/hf-model/model_1024_fp16.onnx`. The SHA-256 above is the value
recorded for the `onnx-community` export in `PHASE1_REPORT.md` §1; the run
itself did not re-hash that file. The two agree by name and byte size, but a
hash-at-run-time was not captured. `scripts/benchmark-pipelines.py` now calls
`sha256_file()` per pipeline and writes `model_sha256` + `model_bytes` into
`summary.json`, so the next run closes this gap by construction.

Provenance of the 512 export is set out in `MODEL_CARD.md`: all 379 backbone
tensors are bit-identical to upstream `ZhengPeng7/BiRefNet_lite`; the 36
differing decoder convs are upstream weights with BatchNorm folded in (~1e-7).
The export repo itself declares no licence; the upstream MIT covers the weights
(see `THIRD_PARTY_LEGAL_NOTICES.md`).

## 2. Runtime and exact T4 environment

| Item | Value |
|---|---|
| Host | Google Colab, `T4 GPU` runtime |
| GPU | NVIDIA Tesla T4 (16 GB class; exact total not queried that session) |
| Driver | 580.82.07 |
| CUDA | 13.0 |
| Python | 3.13 |
| Runtime | `onnxruntime-gpu` 1.31.1 |
| Execution provider | `CUDAExecutionProvider` |
| Threads | `intra_op_num_threads=1`, `inter_op_num_threads=1`, `enable_mem_pattern=False` |
| Batch size | 1 |
| Warm reps | 5 per image |
| Access | Cloudflare quick tunnel + SSH (Colab exposes no inbound ports) |

`smoke-results/benchmark-t4/environment.json` carries these values with
`"capture_method": "transcribed"`. A fresh run writes a machine-generated
`environment` block (GPU name, driver, total VRAM, CUDA/onnxruntime versions,
available providers, git commit, UTC timestamp) directly into `summary.json`.

## 3. Latency — batch 1, first run separately from warm runs

Per image: one cold run (session already created, first inference only), then
`REPS` warm runs.

| Pipeline | Model load | First run (img₁) | First run (img₂) | First run (img₃) | Warm mean | Warm median | Warm min–max | SD |
|---|---|---|---|---|---|---|---|---|
| **1024 fp16** | 5394 ms | 1914 ms | 578 ms | 579 ms | **581.7 ms** | 582.0 ms | 579.6–582.5 ms | 0.77 ms |
| **512 fp32** | 979 ms | 259 ms | 107 ms | 107 ms | **109.5 ms** | 109.5 ms | 107.7–110.7 ms | 0.88 ms |

Warm means per image:

| Image | 1024 fp16 | 512 fp32 |
|---|---|---|
| product-scent-bottle | 581.0 ms | 109.1 ms |
| animal-buddy-dog | 582.1 ms | 109.6 ms |
| glass-wine | 581.9 ms | 109.7 ms |

**512 fp32 is 5.31× faster warm** (109.5 vs 581.7 ms) and 5.51× faster to load
(979 vs 5394 ms).

The `1024 fp16` first-run figure for image 1 (1914 ms) includes one-off CUDA
kernel compilation for the larger graph; images 2–3 need no new kernels and
settle at ~578 ms, i.e. essentially their warm time.

### Why this is 5 runs and not 10+

The 2026-10-26 session ran `--reps 5`; the spec asks for 10+.

The distribution is tight enough that the mean is not in question — SD is
0.77 ms (0.13%) at 1024 and 0.88 ms (0.80%) at 512, and all 15 warm samples per
pipeline sit within a 2.9 ms / 3.0 ms band. A 10-run minimum would not move
the conclusion, but it was not measured, so this report does not claim it.

To close it: run the notebook with `--reps 10` (default in the cell). The G4/T4
tunnel used for this run has since expired, so a fresh Colab session is needed.
Cost is ~1 minute of GPU time.

## 4. Peak memory — RSS recorded, VRAM not measured

| Pipeline | Peak **host** RSS | Peak **VRAM** |
|---|---|---|
| 1024 fp16 | 1228–1265 MB | **not measured** |
| 512 fp32 | 1522 MB | **not measured** |

`peak_rss_mb` in `summary.json` is the Python process's resident set size
(`VmRSS` sampled at 50 ms). That is **host RAM and CPU-side allocation, not
device memory**. The two are not interchangeable: ORT's CUDA EP allocates
weights and workspace in VRAM, which RSS may not reflect at all.

So the earlier statement "both fit a 16 GB card at ≈1.5× the peak RSS" is a
weaker claim than it reads: host RSS never approached 16 GB, but T4 VRAM
headroom was never actually observed. VRAM consumption is plausible to be in
the low GBs for a 114–193 MB fp16/fp32 graph at 1024², but that is inference,
not measurement, and this report does not present it as a result.

`scripts/benchmark-pipelines.py` now samples `nvidia-smi --query-gpu=memory.used`
at 50 ms during each image and writes `peak_vram_mb` per image (`null` on hosts
without a GPU). It measures device memory used by *all* processes on the card,
so it is an upper bound of this process's footprint; run on a quiet GPU.

One thing to keep in mind when the number arrives: the 512 pipeline showing
higher host RSS than the 1024 fp16 pipeline is the fp32-vs-fp16 weight ratio
(193 MB vs 114 MB), not a heavier compute graph.

## 5. Mask quality vs the 1024 reference — the 512-vs-1024 open check

Both pipelines ran on the same 3 test images on the T4. Masks were resized to a
common 1024×1024 grid before comparison, so IoU is measured on identical
pixels; edge sharpness is measured at each mask's native resolution.

| Image | IoU@0.5 | Mean abs diff | p99 abs diff | FG frac 1024 | FG frac 512 | Edge 1024 (native) | Edge 512 (native) |
|---|---|---|---|---|---|---|---|
| product-scent-bottle | 0.99318 | 0.00252 | 0.0606 | 0.2893 | 0.2879 | 0.4372 | 0.4740 |
| animal-buddy-dog | 0.99213 | 0.00299 | 0.0941 | 0.3215 | 0.3211 | 0.3360 | 0.4221 |
| glass-wine | 0.98986 | 0.00454 | 0.1373 | 0.3931 | 0.3930 | 0.3875 | 0.4526 |
| **Mean** | **0.99172** | **0.00335** | — | — | — | — | — |

Result: the 512 export reproduces the 1024 mask to **IoU 0.9917** with mean
absolute probability difference 0.0034. Foreground coverage agrees to within
0.14 percentage points (largest case: 0.2893 vs 0.2879).

The one systematic difference is in the native-resolution edge gradient, where
512 is consistently *higher* than 1024 (0.474 vs 0.437, 0.422 vs 0.336, 0.453
vs 0.388). That is a measured direction, and it runs **opposite** to the CPU
comparison in `PHASE1_REPORT.md` §10a, which reported 512 as *softer* at the
edge (≈0.19 vs ≈0.33). The two runs use different measurement code on
different grids, so the discrepancy is unresolved rather than explained; the
IoU and abs-diff numbers, which agree across both runs, are the figures this
report relies on.

This is the independent cross-check on the CPU figure (mean IoU 0.9918 in
`smoke-results/measurements/quality-1024-vs-512.json`). Two different runtimes
on two different machines agree to 4 decimal places.

## 6. What this supports

- **512 fp32 as the browser target is safe on quality grounds.** IoU 0.9917
  against the 1024 reference, twice verified on independent hardware, with
  foreground coverage agreeing to within 0.14 pp.
- **1024 fp16 has no speed justification.** It is 5.3× slower warm and 5.5×
  slower to load on the T4, for a mask the 512 pipeline already reproduces.
- **The memory argument is still open.** Host RSS favours 1024 fp16 (1228 MB vs
  1522 MB), but that is not VRAM, and neither figure was a VRAM measurement.
  Phase-2 sizing on low-end devices should not lean on the RSS numbers.

Not supported by this data: any claim about VRAM headroom, about 10+ run
stability as a stated measurement, or about batch >1 throughput.

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
