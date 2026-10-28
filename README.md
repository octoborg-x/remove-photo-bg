# remove-bg-photo

Browser-first background remover for product/marketplace photos. The BiRefNet
segmentation model runs **inside the user's browser** (ONNX Runtime Web via a
Web Worker); no image pixels leave the device.

> Phase 1 status. This build is the Phase 1 feasibility harness per
> `MVP_OPENHANDS.md` §13 (implement only Phase 0 + Phase 1). The verdict and
> measured results are in [`PHASE1_REPORT.md`](./PHASE1_REPORT.md).

## Result — WASM path on a real phone

![BiRefNet_lite smoke test on an Android phone, WASM provider: input vase photo above a clean transparent-background cutout, with the run log below](./docs/screenshots/phone-wasm-smoke-test.jpg)

Android phone (Chrome 155, mobile UA), `provider=wasm`: 960×1400 input →
transparent PNG, 28.8% opaque, **6880 ms average over 5 warm inferences**.
The same page on the same phone with `provider=webgpu` (Adreno-6xx) was **not
faster** (≈6.6–6.7 s warm) and **mis-segmented the subject** (opaque rails left
on the object), while WASM was clean in every run. The worker currently tries
`['webgpu', 'wasm']` in that order, so on this device class the clean output
needs `?provider=wasm` — evidence recorded in `HARDWARE_TESTING.md` §4 and
`smoke-results/device-phone-adreno-6xx/`.

## What works (Phase 1)

- Model download + self-hosted serving (`fetch-models` verifies SHA-256).
- ONNX Runtime Web (1.29.0) inference on **WebGPU** when available, with a
  **WASM (threaded)** fallback.
- Minimal page + Worker pre/post-processing: mask upscale to original
  dimensions, alpha composite, transparent PNG export.
- Headless smoke harness (`run-smoke.mjs`) that records every network request
  (privacy check) and downloads the resulting PNG.
- Native-CPU reference inference (`reference-inference.py`) that produces the
  same model's masks fast, for correctness cross-checks.

## Requirements

- Node.js ≥ 20 (tested on v24)
- System Chromium for the headless smoke test (`/usr/bin/chromium`; override with `CHROME_BIN`)
- Python 3 + `pip` (only for the optional reference-inference script)
- A GPU with WebGPU is strongly recommended (see latency notes in `PHASE1_REPORT.md`)

## Setup

```bash
npm install
npm run fetch-models   # downloads model + WASM into public/ with SHA-256 checks
npm run dev            # http://localhost:5173
```

## Browser smoke test (headless)

```bash
# model load + 1 inference + transparency PNG + network request log
node scripts/run-smoke.mjs "http://localhost:5173/" \
  --image test-images/glass-wine.jpg --runs 1 --out smoke-results-final
```

Outputs to `--out`:
- `output.png` — transparent PNG (result of the pipeline)
- `requests.json` — every network request made during processing (privacy: must all be first-party)
- `summary.json` — provider, timings, page log

## Reference inference (native CPU, fast)

```bash
pip install pillow numpy onnxruntime
python3 scripts/reference-inference.py                # default: the 3 test images
python3 scripts/reference-inference.py test-images/glass-wine.jpg
# outputs smoke-results/reference/*.mask.png + summary.json (~12 s/image, vs >10 min WASM)
```

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | typecheck + production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run fetch-models` | download + verify model/WASM artifacts |
| `node scripts/run-smoke.mjs <url> [--image …] [--runs n] [--out dir]` | headless browser smoke test |

## Privacy

- Processing happens entirely in the browser. See [`PRIVACY.md`](./PRIVACY.md).
- The smoke harness records all network requests; verification results are in
  `PHASE1_REPORT.md` and `smoke-results-final/requests.json`.

## Licensing / notices

- [`THIRD_PARTY_LEGAL_NOTICES.md`](./THIRD_PARTY_LEGAL_NOTICES.md) — Phase-1
  provenance + hashes; full licence audit pending Phase 3.
- [`MODEL_CARD.md`](./MODEL_CARD.md) — model provenance and semantics.

## Known Phase-1 limitations

- Input resolution is the dominant memory cost, and it is fixed per export.
  The original 1024×1024 export peaked at ~1.5 GB of transient activation memory
  in native CPU inference (largest single tensor 411 MB), and its graph
  hard-codes 1024 via `Split`/`Resize` constants, so it cannot be fed a smaller
  image. That exceeded both the browser's WASM heap and the GPU memory of the
  target devices, failing inside `OrtRun()` with `ERROR_CODE: 6 … std::bad_alloc`.
  The shipped model is therefore the same official `BiRefNet_lite` backbone
  exported at a fixed 512×512 input, which peaks at ~1.1 GB and runs on both
  WebGPU and WASM.
- **Known quality limitation (measured):** the 512 input reproduces the 1024
  mask at IoU 0.992 with sub-1/255 mean difference, but its edge is genuinely
  softer — the transition band at the subject boundary is ~1.5–1.8× wider
  (≈2.4 px vs ≈1.4 px). The difference is edge-localised and most visible on
  specular/glass detail (a wine-glass rim reads slightly softer and fainter);
  product and fur silhouettes are visually equivalent. This is an accepted
  trade-off, not a defect. Note that an earlier edge-sharpness metric reported
  the opposite direction; that was a grid-sampling artifact, corrected in
  `COLAB_T4_REPORT.md` §5.
- WASM/CPU inference on the 512×512 export takes roughly 3–6 s per image
  (native CPU ~2.2 s), so the CPU path is usable rather than a last resort.
- A quantised variant was evaluated and rejected: dynamic int8 shrank the file
  by only 12% and ran 2.3× slower, because Conv dominates and its kernels stay
  float. fp16 weights ran ~2× slower on CPU for the same reason.
- Mitigations in place: the high-performance GPU adapter is requested, and a
  WebGPU failure automatically rebuilds the session on the WASM provider and
  reports the fallback in the log.
- WebGPU runs are bounded by a watchdog: 180 s for the first run (it compiles
  shaders) and 120 s afterwards. A run that never settles would otherwise leave
  the UI with no output and no error. On timeout the run falls back to WASM.
  WASM runs are deliberately unbounded — they are slow, not stalled.
- The shipped model is float32 internally, so WebGPU no longer depends on the
  adapter's `shader-f16` feature (fp16 emulation was the cause of the Intel
  Gen-9 stalls). The log still reports `shader-f16=yes|no` for the chosen
  adapter, since other model builds may require it.
- `?provider=wasm` forces the CPU path. Use it to rule the GPU out when
  diagnosing a stall, or to get a result on a machine whose driver cannot run
  this model.
- The full product UI (Phase 2), legal docs (Phase 3), and test suite (Phase 4)
  are not built yet per the Phase-1 prompt.
