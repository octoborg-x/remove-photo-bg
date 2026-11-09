# remove-bg-photo

Browser-first background remover for product/marketplace photos. The BiRefNet
segmentation model runs **inside the user's browser** (ONNX Runtime Web via a
Web Worker); no image pixels leave the device.

> **All five MVP phases are complete** (delivery: [`PHASE5_REPORT.md`](./PHASE5_REPORT.md)).
> Phase 1 (feasibility) is closed in [`PHASE1_REPORT.md`](./PHASE1_REPORT.md);
> Phase 2 (product workflow) in [`PHASE2_REPORT.md`](./PHASE2_REPORT.md); Phase 3
> (legal/privacy documents, footer links, restrictive CSP) in
> [`PHASE3_REPORT.md`](./PHASE3_REPORT.md); Phase 4 (ESLint, Vitest unit tests,
> puppeteer-core browser tests, `npm run verify`) in
> [`PHASE4_REPORT.md`](./PHASE4_REPORT.md). Hardware (WebGPU) tests remain
> postponed until a GPU machine is available.

## Quick start

```bash
npm ci                 # install (Node ≥ 20)
npm run fetch-models   # download + SHA-256-verify the model into public/models/
npm run dev            # http://localhost:12000  (dev:local → Vite's 5173)
```

Open the URL the dev server prints (not `index.html` directly — the page needs
Vite to compile `src/main.ts`). Pick a photo, press **Remove background**, and
download the cut-out as PNG (transparent, default), JPG, or WebP.

```bash
npm run verify         # lint + typecheck + unit tests + production build
npm run test:browser   # real-browser flow tests (needs Chromium + fetched model)
```

No secret or account is required — inference is entirely local. See
[`.env.example`](./.env.example) for the one optional build-time variable.

### Browser requirements

- A modern browser with **Web Workers + WebAssembly SIMD/threads**: Chrome/Edge
  ≥ 90, Firefox ≥ 90, Safari ≥ 15. WebGPU is used automatically when an adapter
  is present; otherwise the app runs on WASM (CPU).
- First visit downloads the model once (~68 MB by default) and caches it in the
  Cache API; later visits load it from the device.

## Result — WASM path on a real phone

![BiRefNet_lite smoke test on an Android phone, WASM provider: input vase photo above a clean transparent-background cutout, with the run log below](./docs/screenshots/phone-wasm-smoke-test.jpg)

Android phone (Chrome 155, mobile UA), `provider=wasm`: 960×1400 input →
transparent PNG, 28.8% opaque, **6880 ms average over 5 warm inferences**.
The same page on the same phone with `provider=webgpu` (Adreno-6xx) was **not
faster** (≈6.6–6.7 s warm) and **mis-segmented the subject** (opaque rails left
on the object), while WASM was clean in every run. Evidence recorded in
`HARDWARE_TESTING.md` §4 and `smoke-results/device-phone-adreno-6xx/`.

The runtime is selectable in the UI (Advanced options → **Runtime**), with
`?provider=wasm` / `?provider=webgpu` overrides. WebGPU is the default **only
when a modern hardware GPU is present**: an adapter that is a software renderer
or is known to be slower or less accurate than the CPU path (Adreno 6xx, Intel
Gen-9) is skipped and the app runs on WASM. `classifyGpuAdapter()` in
`src/features/background-removal/provider-gate.ts` makes that call; the WASM
fallback still catches a GPU that fails to build/run the session, and
`?provider=wasm` rules the GPU out. See `PHASE1_REPORT.md`
§9 for why a wrong-but-clean mask was possible on the phone, and the fallback
behavior described below.

## What works (Phase 1)

- Model download + self-hosted serving (`fetch-models` verifies SHA-256).
- **Persistent model loading:** a service worker (`public/sw.js`) stores the
  model and the ONNX Runtime WASM binaries in the Cache API, so only the first
  visit downloads them. Later visits (including after closing the tab or
  restarting the browser) load from the device instead of re-fetching ~65 MB.
- ONNX Runtime Web (1.29.0) inference on **WASM (threaded)** or **WebGPU**,
  selectable in the UI and via `?provider=wasm` / `?provider=webgpu`. Default:
  WebGPU **only when a modern hardware GPU is present** — a software renderer
  (e.g. SwiftShader/llvmpipe) or a GPU known to be slower or less accurate than
  the CPU path (Adreno 6xx, Intel Gen-9) falls back to WASM. The check lives in
  `classifyGpuAdapter()` in `src/features/background-removal/provider-gate.ts`.
- Minimal page + Worker pre/post-processing: mask upscale to original
  dimensions, alpha composite, and a **format picker** for the download
  (PNG with transparency — the default — plus JPG on a white background and
  WebP when the browser can encode it).
- Headless smoke harness (`run-smoke.mjs`) that records every network request
  (privacy check) and downloads the resulting PNG.
- Native-CPU reference inference (`reference-inference.py`) that produces the
  same model's masks fast, for correctness cross-checks.

### One inference implementation (the classic worker)

There is exactly **one** inference implementation, and it is
[`public/inference-worker.js`](./public/inference-worker.js) — a **classic**
(not module) Web Worker loaded by `src/main.ts` as
`new Worker('/inference-worker.js', { type: 'classic' })`. It is the only file
in the repo that calls `onnxruntime`'s `InferenceSession.create`.

It is deliberately *not* a TypeScript module worker under `src/`. A module
worker would be bundled by Vite, and Vite refuses to bundle the ONNX Runtime
loader files (`/wasm/*.mjs`, `/wasm/*.wasm`) that live in `public/` — they must
be fetched at runtime as plain same-origin static files, which is what
`importScripts('/wasm/ort.wasm.min.js')` gives us. Keeping the worker as a
plain file in `public/` also keeps its URLs (`/inference-worker.js`,
`/wasm/…`) out of the hashed build output, so the service worker can cache them
by a stable name. This is a hard constraint of the runtime, not a preference.

> An earlier Phase-1 experiment left a second, TypeScript "reference" worker at
> `src/features/background-removal/model.worker.ts`. It was never referenced by
> the app, so editing it changed nothing at runtime — a real drift hazard. It
> has been removed. `single-inference-worker.test.ts` now fails the build if a
> second session-creating worker appears or if the page stops loading the
> classic worker, so the two cannot diverge again.

## Requirements

- Node.js ≥ 20 (tested on v24)
- A browser with Web Workers + WebAssembly SIMD/threads (see
  [Browser requirements](#browser-requirements)); WebGPU is optional
- System Chromium for the headless smoke/browser tests (`/usr/bin/chromium`;
  override with `CHROME_BIN`)
- Python 3 + `pip` (only for the optional reference-inference script)
- A GPU with WebGPU is recommended for latency (see `PHASE1_REPORT.md`); WASM
  works everywhere

## Setup

See [Quick start](#quick-start) for the three commands. Open the URL the dev
server prints, not `index.html` itself: the page needs Vite to compile
`src/main.ts`, so opening the file directly (or through an editor's file
preview) renders a page that cannot start. On a remote sandbox, use the https
URL that forwards port 12000.

## Persistent model loading

The model and the ONNX Runtime WASM binaries (~14 MB) are large enough that
re-downloading them on every visit is the dominant cost of using the app. A
single model is served — the smallest artifact, weight-only quantised and
materialised to fp32 so the runtime kernels and the mask are identical to the
full-precision teacher:

The served artifact is named **QMix Cut-512** (technical id `qmix-cut-512`), an
optimised **BiRefNet Lite** variant — the file keeps its precision-stating name:

| id (product name) | file | size | what |
|---|---|---|---|
| `qmix-cut-512` (QMix Cut-512) | `models/model_512_int8_fp16.onnx` | 60.8 MB | int8 backbone + fp16 decoder; PyTorch debug metadata and duplicate initializers stripped (lossless). On the repo test images it reproduces the fp32 teacher at IoU@0.5 0.9987 with 0 pixels crossing the 0.5 threshold; on the wider 62-image eval set it averages 0.981 with one empty-mask miss (`clothing-04.jpg`). |

Every artifact was the raw export with its PyTorch `torch.onnx` debug metadata
and duplicate initializers removed (`scripts/distill/optimize-onnx.py --scope
none`), which is lossless: outputs are bit-identical, only the download is
smaller. See `OPTIMIZATION_REPORT.md` for the wider-set caveat.

Three weight-precision variants existed earlier (`model_512_int8_fp16`,
`model_512_int0_fp16`, `model_512_int0_fp32`). They are the **same graph**, and
because every variant is materialised to fp32 before running, the larger two
changed no visible output — only the download size. They were therefore removed
and the smallest is served alone; `?model=` still resolves for scripted runs.

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

### Loading checkpoints and the three user-visible phases

The worker emits a `loading-progress` message at each milestone, and the page
renders it on the stage line and logs each stage once. The stages are:

`queued` → `runtime` → `cache-check` → `downloading` → `downloaded` →
`creating-session` → `session-ready` → `ready`

The UI groups those stages into the three things a visitor actually cares about,
so "waiting" is never a blank screen:

1. **Downloading the model** — the one measurable step. A small animated ring
   appears next to the model name and fills with the real percentage; the copy
   reads `Downloading <model> — 42%`.
2. **Preparing the model** — cache lookup, ONNX Runtime load and session
   creation. The ring spins indeterminately (there is no honest percentage here)
   and the copy reads `Preparing the model…`.
3. **Removing the background** — inference and compositing, shown in a small
   collapsed **Processing** panel that expands to a live step list
   (Download model → Prepare model → Remove background → Create image) plus the
   run log. While it works, the word *Processing* animates its colour.

Each progress message carries a monotonic `percent`, the bytes transferred and
expected total (while downloading), and the elapsed time since loading began.
On a cached visit the whole load takes ~1–2 s instead of the first-visit
download time.

### First-visit download confirmation

Before the first large download the page reads the (Chromium-only) Network
Information API. Wi-Fi, ethernet, and an unknown/desktop connection load
straight away; a **cellular or data-saver** connection shows a confirmation
stating the model size, and the download starts only after **Download**. A
phone or tablet with no Wi-Fi signal is treated as metered even on a fast link,
because Chrome on Android reports only `effectiveType: '4g'` for LTE and omits
the `type` field. The confirmation is skipped when the model is **already on
the device** (a Cache API check, so there is nothing left to download). Consent
is not remembered: the prompt is a per-session decision, so a later visit over
mobile data asks again. The model size is stated next to the model name
regardless of connection, and pressing **Remove background** also starts a
paused download. `?model=`/ `?provider=` overrides skip the prompt.

### Export format

The download section offers a format radio group — **PNG** (default; keeps the
transparent cut-out), **JPG** (composited onto white), and **WebP** (keeps
transparency, smaller file) — and a single download link that re-encodes the
result when the choice changes, without re-running inference. A format the
browser cannot encode (WebP on some builds) is shown disabled rather than
silently producing a mislabelled file. The choice is persisted and can be
forced with `?format=png|jpeg|webp`.

### If something goes wrong

Failures are explained in plain language with a one-tap retry instead of a raw
exception:

- **Download failed** — retry the download, or pick a smaller model.
- **Out of memory** — close other tabs, try a smaller photo, or use a smaller model.
- **Engine did not start** — reload the page and try again.

To force a re-download after changing the model or upgrading ONNX Runtime, bump
`CACHE_VERSION` in `public/sw.js`. Vercel response headers are configured in `vercel.json`; the service worker
handles versioned asset caching.

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

The GPU path needs the host to serve the WebGPU-capable ORT bundle. Fetch it
before starting the local preview server:

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

## Model quality evaluation (fixed image set)

Model comparisons in `PHASE*_REPORT.md` mostly measure *agreement with another
model*, which does not answer the customer's question: does the cut-out look
right? `eval/` adds a fixed, licence-verified image set and a harness that runs
the **real deployed pipeline** over it, so results are reproducible and can be
diffed after any model or runtime change.

- `eval/manifest.json` — 64 images across 8 categories (ordinary product,
  clothing, hair/fur, glass & transparent packaging, small accessory, complex
  background, large image, thin structure), 8 each. Every entry records the
  licence, source page, pinned thumbnail URL, dimensions and SHA-256.
- `eval/ATTRIBUTION.md` — the per-image credit list (generated from the
  manifest). The set uses only CC0, public domain, "no restrictions" and CC BY
  images: no ShareAlike, so the redistributed set imposes no copyleft on the
  repository (which is otherwise copyleft-free; see `LICENSE_AUDIT.md`).
- `eval/images/` — the images themselves (committed, so the set is stable).
- `scripts/eval/build-eval-set.py` — rebuilds the manifest from Wikimedia
  Commons. It searches by category, keeps only approved licences and browser-
  decodable rasters, and pins a standard-width thumbnail URL per image.
- `scripts/eval/run-eval.mjs` — drives the shipped page over every image via the
  genuine upload path and records success/failure, output dimensions, timing and
  peak browser memory, saving each output PNG under `eval-results/<run>/`.
- `scripts/eval/analyze-eval.py` — measures edge-character metrics from those
  PNGs (foreground share, soft-edge band, edge contrast, components, speckle)
  and writes `quality.json` / `quality.md`.

```bash
npm run eval:set                       # download the pinned images (once)
npm run build
npm run eval:run -- --provider wasm --out eval-results/wasm
npm run eval:analyze                   # or: python3 scripts/eval/analyze-eval.py eval-results/wasm
# WebGPU, on a machine that has it:
RUN_GPU=1 npm run eval:run -- --provider webgpu --out eval-results/webgpu
```

The metrics are descriptive, not accuracy scores (there is no ground-truth mask
for these images). Use them for regression comparison and review
`eval-results/<run>/outputs/*.png` visually — a mask that looks correct to the
customer matters more than a faster inference time. See
[`EVALUATION.md`](./EVALUATION.md) for the full method and the recorded baseline
(64/64 succeeded, 0 wrong dimensions, mean 4.1 s/image, 8 empty outputs).

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server on port 12000 (the port remote sandboxes forward) |
| `npm run dev:local` | Vite dev server on its default port 5173 |
| `npm run build` | typecheck + production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (flat config) over `src/`, `scripts/`, `public/` |
| `npm run test` | Vitest unit tests (validation, mask maths, progress, manifest) |
| `npm run test:browser` | puppeteer-core flow tests (upload, inference, exports, errors, keyboard) |
| `npm run eval:set` | download the fixed evaluation images (`eval/images/`) |
| `npm run eval:run` | run the deployed pipeline over the evaluation set (WASM; `RUN_GPU=1` for WebGPU) |
| `npm run eval:analyze` | edge-character metrics from an evaluation run's output PNGs |
| `npm run verify` | lint + typecheck + unit tests + build |
| `npm run fetch-models` | download + verify model/WASM artifacts (also prepares `public/wasm/` for local dev) |
| `npm run license:audit` | dependency licence audit (all permissive; see `LICENSE_AUDIT.md`) |
| `node scripts/run-smoke.mjs <url> [--image …] [--runs n] [--out dir]` | headless browser smoke test |

## Deployment

### Vercel (Hobby)

Vercel serves the application and WebGPU-capable ONNX Runtime assets from the
same origin. Model weights remain hosted on Hugging Face and are fetched at
runtime by the service worker.

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

See [`DEPLOY.md`](./DEPLOY.md) for the asset architecture and deployment details.

## Privacy

- Processing happens entirely in the browser; pixels never leave the device.
  See [`PRIVACY.md`](./PRIVACY.md).
- A restrictive Content-Security-Policy is applied in development and preview
  by `vite.config.ts`, and in production by Vercel response headers in
  `vercel.json`: `default-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`,
  `connect-src 'self'` (plus the asset origin only when `VITE_ASSET_BASE` is
  set), `worker-src 'self' blob:`, `object-src 'none'`, `frame-ancestors 'none'`.
  `'wasm-unsafe-eval'` is the minimal allowance onnxruntime-web needs to compile
  its WebAssembly module; no JS `eval` is permitted.
- The smoke harness records all network requests; results are in
  `PHASE1_REPORT.md`, `PHASE2_REPORT.md`, and `smoke-results*/requests.json`.

## Repository code licence

The original Project Materials in this repository are **proprietary and
all-rights-reserved** under [LICENSE](./LICENSE). Unless you have separate
written permission from the copyright holder, you may not use, copy, modify,
redistribute, sublicense, sell, or create derivative works from those materials.
Repository access is not a licence to reuse the code.

This proprietary licence covers only original project materials owned by the
copyright holder, such as application source, project scripts, configuration,
and project documentation. It does **not** relicense third-party components,
model weights, ONNX Runtime binaries, npm dependencies, datasets, or other
externally sourced materials. Those remain subject to their own licences and
required notices, documented below. If a third-party licence grants rights
that cannot be restricted by this repository licence, that third-party licence
continues to govern that component.

A private GitHub repository controls who can access the repository; the
licence separately states what recipients are permitted to do with the
copyrighted materials. See [LICENSE](./LICENSE) for the terms.

## Licensing / notices

- [`THIRD_PARTY_LEGAL_NOTICES.md`](./THIRD_PARTY_LEGAL_NOTICES.md) — model and
  dependency provenance, hashes, and exact licence texts.
- [`LICENSE_AUDIT.md`](./LICENSE_AUDIT.md) — full dependency licence audit
  (Phase 3): 247 packages, all permissive, no copyleft. Reproduce with
  `npm run license:audit`.
- [`MODEL_CARD.md`](./MODEL_CARD.md) — model provenance and semantics.
- The app footer links these documents; the build copies them into `dist/`
  (`scripts/copy-legal-docs.mjs`) so the links resolve on the deployed site.

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
- **Extreme aspect ratios used to return an empty mask; fixed.** Stretching a
  non-square photo into the 512×512 input collapsed the subject on some images:
  a 1005×260 logo (≈3.9:1) came back with a peak probability of 0.0002, and
  several near-square eval photos (`accessory-08`, `ordinary-product-08`,
  `thin-structure-04`) likewise segmented to nothing. Pre-processing now fits
  the image into the square preserving its aspect ratio (letterbox) and crops
  the border off the mask before upscaling. The letterbox border is filled by
  **replicating the content's edge pixels** outward rather than a flat colour: a
  flat (black) border made the model flood the mask on wide images (the 1005×260
  logo came back ~56% foreground with an opaque backdrop at ~249/255; edge
  replication gives ~24% with a clean 0-alpha backdrop). On ordinary photos the
  two agree to ~0.99 IoU, so this only affects the degenerate cases. See
  `image-preprocess.ts` / `mask-postprocess.ts`.
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
- All five MVP phases are complete: the product UI (Phase 2), legal/privacy
  docs + CSP (Phase 3), and the lint/unit/browser test suite (Phase 4) are all
  in. See [`PHASE5_REPORT.md`](./PHASE5_REPORT.md) for the delivery summary.
