# remove-bg-photo

Browser-first background remover for product/marketplace photos. The BiRefNet
segmentation model runs **inside the user's browser** (ONNX Runtime Web via a
Web Worker); no image pixels leave the device.

> Phase 1 status. This build is the Phase 1 feasibility harness per
> `MVP_OPENHANDS.md` §13 (implement only Phase 0 + Phase 1). The verdict and
> measured results are in [`PHASE1_REPORT.md`](./PHASE1_REPORT.md).

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

- WASM/CPU fallback inference is very slow on this 1024×1024 fixed-input model
  (single inference > 10 min in the Phase-1 sandbox; native CPU ~12 s). WebGPU
  is the only viable production path and could not be measured in the sandbox
  (no GPU/WebGPU).
- Memory: the model's decoder materialises very large intermediate tensors at
  the fixed 1024×1024 input — the largest single activation is 411 MB and peak
  transient usage is roughly 1.8 GB. Devices (or GPU adapters) that cannot
  allocate that fail inside `OrtRun()` with `ERROR_CODE: 6 … std::bad_alloc`.
  The input size is not tunable (the graph hard-codes 1024 via `Split`/`Resize`
  constants, so smaller inputs fail too), and no lower-memory quantised variant
  is published for `BiRefNet_lite`. Mitigations in place: the high-performance
  GPU adapter is requested, and a WebGPU allocation failure automatically
  rebuilds the session on the WASM provider and reports the fallback in the log.
- The full product UI (Phase 2), legal docs (Phase 3), and test suite (Phase 4)
  are not built yet per the Phase-1 prompt.
