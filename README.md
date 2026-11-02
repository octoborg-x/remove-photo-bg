# remove-bg-photo

Browser-first background remover for product/marketplace photos. The BiRefNet
segmentation model runs **inside the user's browser** (ONNX Runtime Web via a
Web Worker); no image pixels leave the device.

> **Phase 2 status — product workflow complete and verified.** Phase 1
> (feasibility) is closed in [`PHASE1_REPORT.md`](./PHASE1_REPORT.md); the Phase 2
> product workflow (validation, worker lifecycle, model/runtime selectors,
> auto-load, progress, preview, PNG/JPG export, error states) is confirmed in
> [`PHASE2_REPORT.md`](./PHASE2_REPORT.md). Phase 3 (notices/privacy + licence
> audit) is planned in [`PHASE3_PLAN.md`](./PHASE3_PLAN.md). Hardware (WebGPU)
> tests are postponed until a GPU machine is available.

## Result — WASM path on a real phone

![BiRefNet_lite smoke test on an Android phone, WASM provider: input vase photo above a clean transparent-background cutout, with the run log below](./docs/screenshots/phone-wasm-smoke-test.jpg)

Android phone (Chrome 155, mobile UA), `provider=wasm`: 960×1400 input →
transparent PNG, 28.8% opaque, **6880 ms average over 5 warm inferences**.
The same page on the same phone with `provider=webgpu` (Adreno-6xx) was **not
faster** (≈6.6–6.7 s warm) and **mis-segmented the subject** (opaque rails left
on the object), while WASM was clean in every run. Evidence recorded in
`HARDWARE_TESTING.md` §4 and `smoke-results/device-phone-adreno-6xx/`.

The runtime is now selectable in the UI (the **Model** dropdown also lists
**Runtime: CPU (WASM)** and **Runtime: GPU (WebGPU)**). WebGPU is the default
whenever the browser exposes a GPU adapter; the WASM fallback still catches a
GPU that fails to build/run the session, and `?provider=wasm` rules the GPU
out. The per-adapter validation allowlist was removed — see `PHASE1_REPORT.md`
§9 for why a wrong-but-clean mask was possible on the phone, and the fallback
behavior described below.

## What works (Phase 1)

- Model download + self-hosted serving (`fetch-models` verifies SHA-256).
- **Persistent model loading:** a service worker (`public/sw.js`) stores the
  model and the ONNX Runtime WASM binaries in the Cache API, so only the first
  visit downloads them. Later visits (including after closing the tab or
  restarting the browser) load from the device instead of re-fetching ~235 MB.
- ONNX Runtime Web (1.29.0) inference on **WASM (threaded)** or **WebGPU**,
  selectable in the UI and via `?provider=wasm` / `?provider=webgpu`. Default:
  WebGPU when the browser exposes an adapter, else WASM.
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
npm run dev            # http://localhost:12000 (dev:local keeps the Vite default 5173)
```

Open the URL the dev server prints, not `index.html` itself: the page needs Vite
to compile `src/main.ts`, so opening the file directly (or through an editor's
file preview) renders a page that cannot start. On a remote sandbox, use the
https URL that forwards port 12000.

## Persistent model loading

The model and the ONNX Runtime WASM binaries (~14 MB) are large enough that
re-downloading them on every visit is the dominant cost of using the app. Three
model sizes are served, all weight-only quantised and materialised to fp32 so the
runtime kernels are unchanged (the app defaults to the smallest, ~65 MB):

| id | file | size | what |
|---|---|---|---|
| `model_512_int8_fp16` | `models/model_512_int8_fp16.onnx` | 68.5 MB | int8 backbone + fp16 decoder — **default** |
| `model_512_int0_fp16` | `models/model_512_int0_fp16.onnx` | 98.8 MB | fp16 weights (shipped earlier as `c5_best.onnx`) |
| `model_512_int0_fp32` | `models/model_512_int0_fp32.onnx` | 193.5 MB | fp32 teacher, reference quality |

A service worker (`public/sw.js`) keeps them on the device:

- On the first visit, `/models/*` and `/wasm/*` are fetched from the network and
  stored in a versioned Cache API bucket (`remove-bg-assets-<version>`).
- On every later visit the service worker serves them cache-first, so the model
  loads from the device. This survives closing the tab and restarting the
  browser (subject to the browser's normal storage-eviction rules).
- The page waits for the service worker to control it *before* starting the
  inference worker, so the worker's own fetches are cached on the first visit
  too. If the worker cannot take control within 5 s, the app still starts (a
  cache miss is a performance problem, not a correctness one).
- The page log reports `Asset cache ready (N artifact(s) already on this
  device)` and lists what was newly cached.
- The load is reported as named checkpoints (see below), so the UI says what is
  happening rather than only a percentage.

### Loading checkpoints

The worker emits a `loading-progress` message at each milestone, and the page
renders it on the stage line and logs each stage once. The stages are:

`queued` → `runtime` → `cache-check` → `downloading` → `downloaded` →
`creating-session` → `session-ready` → `ready`

Each message carries a monotonic `percent`, the bytes transferred and expected
total (while downloading), and the elapsed time since loading began, so the UI
can show e.g. `Downloading model… 42% (78.1 MB / 185.0 MB, 12.3s)`. On a cached
visit the whole load takes ~1–2 s instead of the first-visit download time.

To force a re-download after changing the model or upgrading ONNX Runtime, bump
`CACHE_VERSION` in `public/sw.js`. For hosts that honor it, `public/_headers`
(Cloudflare Pages syntax) also sets `Cache-Control: immutable` on `/models/*`
and `/wasm/*` as a second layer for browsers where a service worker is
unavailable.

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

## WebGPU on a real GPU (Google Colab, free T4)

The sandbox and CI have no GPU, so the app's WebGPU path could never be
exercised against the real product — until now. `notebooks/colab-webgpu-smoke.ipynb`
runs Google's official headless-Chrome-with-Vulkan recipe on a free Colab T4,
opens the deployed app, forces `?provider=webgpu`, and asserts the provider
comes back as `webgpu` (plus logs timings, the adapter report, and every network
request for the privacy check). Cost: $0.

The GPU path needs the host to actually serve the WebGPU-capable ORT bundle
(the 26.5 MiB `ort-wasm-simd-threaded.jsep.wasm` exceeds Cloudflare Pages' 25 MiB
per-file cap, so the deployed `/wasm/` only has the CPU bundle). Bake it in
before starting the tunnel on the machine that serves the page:

```bash
npm run fetch-models -- --webgpu   # also copies ort.all.min.js + jsep wasm
npm run build                      # or: vite preview after fetch-models --webgpu
npx vite preview --port 4173 &
npx cloudflared tunnel --url http://localhost:4173   # gives the notebook a HTTPS URL
```

Then paste the returned URL into the notebook's `PAGE_URL` cell and run all cells.
The driver honors `RUN_GPU=1 node scripts/run-smoke.mjs …` for a local GPU too,
but the notebook is the supported path (correct Vulkan/WebGPU flags for Colab).

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
| `npm run dev` | Vite dev server on port 12000 (the port remote sandboxes forward) |
| `npm run dev:local` | Vite dev server on its default port 5173 |
| `npm run build` | typecheck + production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run fetch-models` | download + verify model/WASM artifacts (also prepares `public/wasm/` for local dev) |
| `node scripts/run-smoke.mjs <url> [--image …] [--runs n] [--out dir]` | headless browser smoke test |

## Deployment

### Recommended: Vercel (free, no credit card, WebGPU-capable)

The app is a static site with one hard requirement: the WebGPU ORT runtime must
be served same-origin, and its jsep binary is **26.5 MiB** — above Cloudflare
Pages' 25 MiB static-file cap (and a CF Pages Function proxying it would exceed
the free tier's CPU quota). **Vercel Hobby** has no per-file cap relevant here
(~100 MB), **no credit card required**, ~100 GB/mo transfer, and honors
COOP/COEP via `vercel.json` at the CDN layer — so it's the only free host that
can actually serve WebGPU.

Deploy (one-time manual steps in the dashboard):

1. Sign up at vercel.com with GitHub (**Hobby, no card**).
2. **Add New → Project → import `octoborg-x/remove-photo-bg`**.
3. Framework preset: **Vite** (or leave auto-detect). Build command will be
   `npm run vercel:build` (from `vercel.json`), output `dist`.
4. **Add an environment variable**: `VITE_ASSET_BASE =
   https://huggingface.co/spaces/Octoborg/remove-photo-bg/resolve/main/`.
   Without it the app compiles `ASSET_BASE=''` and tries to fetch
   `/models/*.onnx` same-origin, which fails — see `src/asset-cache.ts`.
5. **Deploy**; the build runs `fetch-models --webgpu --no-models` (bakes the
   jsep runtime, skips the hundreds-of-MB model bodies — models come from HF at
   runtime via the service worker) then `vite build` then strips `dist/models/`.

That produces a WebGPU-capable site. Verify with the Colab T4 notebook
(`notebooks/colab-webgpu-smoke.ipynb`).

### Alternatives

- Any static host can serve the **CPU-only** build (`npm run build:site`);
  WebGPU will simply not be offered (probe finds no jsep → graceful WASM).
  This is what the old Cloudflare Pages setup did.
- See [`DEPLOY.md`](./DEPLOY.md) for the architecture (app shell vs remote
  asset origin) and the HF/worker interplay.

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
- Mitigations in place: WebGPU is the default when a GPU adapter exists, the
  high-performance GPU adapter is requested, and a WebGPU session failure
  automatically rebuilds on the WASM provider and reports the fallback in the
  log ("provider fallback: webgpu -> wasm").
- WebGPU is **on by default when the browser exposes an adapter** (no allowlist).
  `navigator.gpu` existing + `requestAdapter()` returning an adapter is enough
  to offer it. A GPU that fails to build/run the session falls back to WASM
  automatically; a silently-wrong mask (observed on Adreno-6xx) is the reason
  the fallback path exists, so verify results on a new device before trusting
  the GPU path (`HARDWARE_TESTING.md` §3, `PHASE1_REPORT.md` §9).
- WebGPU runs are bounded by a watchdog: 180 s for the first run (it compiles
  shaders) and 120 s afterwards. A run that never settles would otherwise leave
  the UI with no output and no error. On timeout the run falls back to WASM.
  WASM runs are deliberately unbounded — they are slow, not stalled.
- The shipped model is float32 internally, so WebGPU no longer depends on the
  adapter's `shader-f16` feature (fp16 emulation was the cause of the Intel
  Gen-9 stalls). The log still reports `shader-f16=yes|no` for the chosen
  adapter, since other model builds may require it.
- `?provider=wasm` and `?provider=webgpu` force a specific backend. Use
  `?provider=wasm` to rule the GPU out when diagnosing a stall; the default
  (no flag) is WebGPU when an adapter exists, else WASM.
- **Mask adjustments:** the UI exposes a mask **threshold** (0–100%, hard cut
  below the cut-off) and **feather** (0–64 px box blur at output resolution).
  Both default to 0/off so the raw model mask is unchanged; they persist in
  `localStorage` and can be driven from URLs for testing
  (`?maskThreshold=30&maskFeather=8`).
- The full product UI ships with Phase 2 (model/provider selectors, auto-load,
  mask threshold/feather); legal docs (Phase 3) and the test suite (Phase 4)
  are not built yet per the phase-1 prompt.
