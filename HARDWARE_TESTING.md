# Hardware testing & free hosting — how to get the Change-2 measurements at $0

Companion to `PHASE1_REPORT.md` §9/§10 and the "hardware part" of the release
review. Goal: answer — *is there free hosting that gets us close to the Change-2
device tests?* — with the repo's current state, the exact numbers currently
missing, and verified free-tier facts from vendor documentation (checked
2026-10-25). The free-GPU benchmark path was validated end-to-end on
2026-10-25 (see §4 and §5).

## 1. Where we actually stand (from the repo)

| Question | Answer (evidence) |
|---|---|
| WebGPU timed on real hardware? | **Yes — one phone (Android, Qualcomm Adreno-6xx), 2026-10-26** (§4, canonical mobile-UA run: WebGPU ≈6709 ms vs WASM ≈6600 ms; both runs WebGPU left opaque artifacts on the subject (WASM clean)). WASM is the safe default. Sandbox itself still has no GPU/WebGPU (`PHASE1_REPORT.md` §Environment honesty). |
| WASM (CPU) measured? | Yes — 4.4–4.6 s warm per image in headless Chromium 155 (`PHASE1_REPORT.md` §5). |
| Known bad devices | Qualcomm Adreno-6xx (WebGPU slow + visually wrong — §4 phone result / `PHASE1_REPORT.md` §9). Intel Gen-9 integrated WebGPU is known-slow (kept off the GPU default); on the desktop measured 2026-11-15 it was **correct but slow**, not stalled (§4 laptop result). |
| Download size | ~58 MB (`model_512_int8_fp16.onnx`), the only artifact served. |
| GPU benchmark run? | **Yes (measured).** **2026-10-28 ran the methodology on a Google Colab Tesla T4** via `scripts/benchmark-pipelines.py --providers CUDAExecutionProvider` (§4/§5) — 10 warm runs/image with device VRAM sampled (512 fp32: 1.16 GB; 1024 fp16: 3.21 GB). First real-GPU measurement of 1024-vs-512: §4 table. Local CPU cross-check in the same script (1024 fp16 ≈14.2–15.6 s warm / ≈8.6 GB peak RSS vs 512 fp32 ≈3.6 s / ≈1.3 GB; mean IoU@0.5 0.992). |

**Implication:** the one number that decides whether the WebGPU path is even
needed as a rescue path is *"open the page in desktop Chrome and report 5 warm
inference times + the provider line."* That can be done by anyone with a
laptop + the current work-host URLs. Free hosting does not create real GPUs,
but it can give testers a real HTTPS page that serves the exact 185 MB model
with the right COOP/COEP headers so the WebGPU + threaded-WASM path actually
engages.

## 2. Four Change-2 device classes → what closes each at $0

| # | Device class | What "close to the test" means | Free path |
|---|---|---|---|
| 1 | Modern laptop, integrated GPU | WebGPU warm inference time, first-run shader compile time, correct provider line | **Work-host URLs now (run 1 below)**, then Vercel + Hugging Face |
| 2 | Laptop/desktop *without* usable WebGPU | WASM path engages; confirm fallback message + timing, no silent cloud fallback | Same URLs with `?provider=wasm` (forces CPU path — feature already exists) |
| 3 | Android phone, representative mobile GPU | WebGPU on mobile; ~185 MB download over mobile data; memory | ✓ measured 2026-10-26 (Adreno-6xx) — see §4; more phones welcome |
| 4 | Low-memory device | Peak memory, `bad_alloc`, watchdog/fallback behavior | Same URLs; in-page error copy already exists (`describeError` in `src/main.ts`) |

All four classes just need a URL that serves model + wasm with
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
require-corp` (already set in `vite.config.ts`, so the current work hosts are
valid test endpoints). No cloud inference, no image upload — testers press the
button on the page.

## 3. Runbook — copy-paste for a real device

**Per device (any OS with Chrome/Edge):**

1. Open https://work-1-aybthnpldbthpfgf.prod-runtime.all-hands.dev/ in Chrome.
2. Wait for the model to finish loading (first load downloads ~68 MB; a small
   ring next to the model name fills with the real percentage, and the
   **Processing** panel expands to a live step list).
3. Choose a photo (drop it, or press **Choose a photo**), then press
   **Remove background**.
4. Expand the **Processing** panel and copy the technical log (it contains the
   provider, model id, and the warm timings). For a scripted run, call
   `window.runSmoke()` from the console and read `window.smokeProvider` /
   `window.smokeModelId` — the automated harness in
   `scripts/run-smoke.mjs` uses the same API.
   For a support-quality capture in one tap, press **Copy report** in the Console
   card header: it copies a `key: value` block with
   the provider, GPU adapter, model, timings, and the **raw-mask
   min/mean/max** plus tail fractions and an `ok (bimodal)` / `SUSPECT`
   verdict (see §9). The same text is also available as `window.deviceReport()`,
   and the structured form as `window.diagnosticReport()`.
5. _Optionally_, also capture:
   - page `#stage` text during the first run (shader-compile note prints only
     on the `webgpu` path; append `?provider=webgpu` to force it, or open the
     page on a GPU machine — WebGPU is the default there)
   - `performance.memory` or `/proc` peak if convenient (class 4)
   - whether a fallback message ever appears
6. WebGPU is offered whenever the browser exposes an adapter; on a machine with
   a GPU the default run is therefore the **WebGPU probe**. To rule the GPU out
   explicitly (CPU/WASM probe), append `?provider=wasm`. To force the GPU on a
   machine where it was detected but not defaulted, append `?provider=webgpu`.
   Headless CI runs the WASM path (`run-smoke.mjs` forces software rendering
   unless `RUN_GPU=1`).

**Privacy:** the harness never uploads anything. `run-smoke.mjs` additionally
records every network request and fails the summary if any is non-first-party;
the on-page technical log is composed entirely in the browser.

**Automated variant (CPU/WASM only, already in the repo):**

```bash
node scripts/run-smoke.mjs "https://work-1-aybthnpldbthpfgf.prod-runtime.all-hands.dev/" \
  --image test-images/glass-wine.jpg --out smoke-results/device-laptop-wasm
```

That writes provider, timings, the output PNG, and `requests.json` (privacy:
all requests must stay first-party). Without `RUN_GPU=1` it is the *class-2*
probe (software rendering).

**Automated WebGPU probe (Colab T4, scripted).** WebGPU uses the browser's
*local* GPU, so a tunnel from a GPU-less machine cannot exercise it — the
browser must run where the GPU is. On a Colab T4 runtime the whole class-1 probe
is scripted:

```bash
bash scripts/colab-webgpu.sh --only accessory   # drivers + build + RUN_GPU=1 eval
```

`RUN_GPU=1` switches to the new headless mode and adds the Vulkan/WebGPU flags
(`scripts/lib/gpu-browser.mjs`); the harness **fails** if the adapter is a
software renderer (SwiftShader/llvmpipe) instead of real hardware, so a
"webgpu" result is never a software result. See README "WebGPU on a real GPU"
and the driver trap documented by Chrome's guide
(<https://developer.chrome.com/blog/supercharge-web-ai-testing>).

**What to paste back into the report:** the provider line, the warm timings,
and the device/OS/GPU name from `chrome://gpu` — or, for a scripted run, the
`window.smokeProvider` / `window.smokeModelId` values and the `runSmoke()`
result — plus whether a provider fallback triggered.

## 4. Verified free-hosting facts (official docs, 2026-10-25)

### Static site hosts

| Host | Free tier (official) | Fits 185 MB model? | Notes |
|---|---|---|---|
| **GitHub Pages** | Free; **100 GB/mo soft bandwidth**; 1 GB published-site cap; **100 MB max single pushed file** | ❌ file cap | Docs: "GitHub Pages is not intended… commercial SaaS"; 10 min deploy timeout |
| **GitHub Releases** | Files up to **2 GiB each; no bandwidth limit** | ✅ model rail | Keep the 185 MB model as a release asset, fetch with `curl -L` (asset URLs redirect to `objects.githubusercontent.com`) |
| **Netlify Free** | New credit plans: **300 credits/mo hard cap; bandwidth 20 credits/GB ⇒ ~15 GB/mo; 15 credits/deploy** | ❌ bandwidth burn | Model serves would use the whole cap in ~80 downloads |
| **Vercel Hobby** | **100 MB static-file upload cap**; 2,000 min/mo builds on free public | ❌ file cap | Model must be external either way |

### CI/browser-test runners (for regression + the class-2 probe)

| Service | Free facts (official) | Real WebGPU? |
|---|---|---|
| GitHub Actions (standard runners) | **Free on public repos**; Linux arm64/x64; 2,000 min/mo on private plans | ❌ hosted runners expose no usable GPU; SwiftShader gives functional coverage only |
| Cloudflare Workers/Pages Functions | Free: 100,000 req/day, no egress charges | ❌ not a device |
| macOS runners (Actions) | **No free minutes** — macOS billed; and macOS virtualized GPUs are not the four target classes anyway | ❌ |

### Free GPU compute (new, validated 2026-10-25)

| Service | Free facts (official) | Fit |
|---|---|---|
| **Google Colab** | Free T4 **~12 h/session**, no internet by default (fetch models via SSH/tunnel or upload) | ✅ **[done] — 2026-10-28 measured** on a live Tesla T4 (CUDA 13.0, onnxruntime-gpu 1.31.1, 10 reps + VRAM) via SSH over a Cloudflare TCP tunnel into the session: see §4 GPU results |
| **GitHub Actions** | Free on public repos; 2,000 min/mo on private plans; **no usable GPU** | ❌ GPU; fine for WASM/class-2 CI |

The run is fully reproducible: clone the repo, install `onnxruntime-gpu`,
fetch the two models (`public/models/model_512.onnx` +
`/tmp/hf-model/model_1024_fp16.onnx`), then
`python3 scripts/benchmark-pipelines.py --providers CUDAExecutionProvider`.

### GPU results — 2026-10-28, Google Colab Tesla T4 (measured)

Live session: Colab `T4 GPU` runtime, driver 580.82.07 / **CUDA 13.0**,
Python 3.13, `onnxruntime-gpu 1.31.1`, `CUDAExecutionProvider`. Same
methodology + models as `scripts/benchmark-pipelines.py` (one session per
pipeline; 3 images; cold start separated; **10 warm runs**; peak host RSS *and*
**peak device VRAM** sampled). The session was reached over SSH via a
Cloudflare TCP tunnel (Colab has no inbound ports); the harness
(`scripts/benchmark-pipelines.py`) is rerunnable and resumable. Artifacts
committed under
`smoke-results/benchmark-t4/` (`summary.json` with machine-captured
`environment` block, `quality-t4/quality.json` + side-by-side cutouts; the
`masks/` arrays are regenerated by `scripts/compare-models-gpu.py` and
gitignored). The per-field record — model SHA-256, exact runtime, latency,
VRAM, mask IoU — is `smoke-results/benchmark-t4/summary.json` and
`smoke-results/benchmark-t4/environment.json`.

| Pipeline | Model load | Cold (img₁) | Warm avg (10×) | Peak host RSS | Peak **VRAM** |
|---|---|---|---|---|---|
| **1024 fp16** (`model_1024_fp16.onnx`) | 6445 ms | 2018 ms | **585 ms** | 1.22 GB | **3.21 GB** |
| **512 fp32** (`model_512.onnx`) | 1085 ms | 238 ms | **112 ms** | 1.52 GB | **1.16 GB** |

Warm averages are stable across all three images (1024: 585.0/584.8/586.2 ms;
512: 111.8/112.6/112.0 ms). **512 fp32 is ≈5.2× faster than 1024 fp16 on the
T4**, at ≈2.77× *less* device VRAM (1.16 vs 3.21 GB) — and both fit the 15 GB
T4 with wide headroom. Mask quality at the common 1024 grid
(`smoke-results/benchmark-t4/quality-t4/quality.json`): **mean IoU @0.5 =
0.9917**, mean abs diff 0.0034 — no material quality loss from the coarser 512
input (matches the CPU-quality cross-check, mean IoU 0.9918, and the ZeroGPU
0.992).

**vs the committed CPU baseline** (same script, CPU provider): 1024 fp16
14.4–15.6 s → **0.59 s** (~25×); 512 fp32 3.6 s → **0.11 s** (~33×).

### Phone result — 2026-10-26, Android (Qualcomm Adreno-6xx) — first real-phone WebGPU measurement

Ran both paths (same page, 5 warm inferences each) on the phone. Two runs:
"Desktop Site active" (desktop Linux UA) then the canonical retest with
**Desktop Site disabled** (real Android UA:
`Linux; Android 10; ... Chrome/155 Mobile`). Table shows the **mobile-UA
(canonical)** run; the desktop-site run is in the raw reports for comparison.

| Provider | Adapter | Ave (5 warm, ms) | Output quality |
|---|---|---|---|
| **webgpu** | qualcomm adreno-6xx, shader-f16=yes | **6709** (7251/6503/6620/6592/6581) | ❌ opaque rails left on the main object (transparent bg was correct) |
| **wasm** | n/a (not webgpu) | **6600** (6452/6489/6567/6662/6828) | ✅ perfect transparent-background image |

Raw reports: `smoke-results/device-phone-adreno-6xx/{mobile-ua,desktop-site}/`
(webgpu.txt / wasm.txt per run) + `summary.json`. Desktop-site run: webgpu
6525 ms / wasm 6457 ms, same quality outcome. A separate WASM run on the same
phone is the README screenshot (960×1400, 28.8% opaque, 6880 ms avg) — recorded
as `illustration_run` in that `summary.json`.

**What this changes:** on this phone (a class-3 device) WebGPU is **not** faster
than WASM (6709 vs 6600 ms, within noise) *and* it mis-segmented part of the
subject in **both** mobile-UA and desktop-site modes, while WASM was visually
clean both times. This matches the earlier "Known bad
devices" phone for Adreno quirks, and it is the first real-device evidence that
**WebGPU should stay an opt-in path with WASM as the safe default on mobile**
— not the primary provider. The fallback message for non-WASM quality should be
"try WASM," not "your GPU is too weak."

### Laptop result — 2026-11-15, Windows desktop (Intel Gen-9) — first desktop WebGPU measurement

First **class-1 desktop** datapoint (the gap this section's §5 "right now" step
asks for). Windows 11, Chrome 157, cross-origin isolated, `?provider=webgpu`
(forced — the gate keeps Gen-9 on CPU by default, hence `Adapter usable: no`).
Three separate **page sessions**, each a single cold run, captured with **Copy
report**:

| Session (UTC) | Adapter | Selected / Actual provider | Session built | Cold inference | Postprocessing | Raw mask |
|---|---|---|---|---|---|---|
| 08:51 | intel gen-9, shader-f16=yes | webgpu / **webgpu** | yes | 11503 ms | 1110 ms | ok (tail 92.40%) |
| 08:57 | intel gen-9 | webgpu / **webgpu** | yes | 4818 ms | 393 ms | ok (tail 92.40%) |
| 08:58 | intel gen-9 | webgpu / **webgpu** | yes | **4394 ms** | **196 ms** | ok (tail 92.40%) |

- **The mask is correct and deterministic.** All three raw-mask blocks are
  byte-identical (min 0.0000 / mean 0.2590 / max 1.0000; 70.23% below 0.01,
  22.18% above 0.95; 0 non-finite). The GPU path segments the subject correctly on
  real hardware — the first desktop evidence that WebGPU can be *correct* here.
- **The cold→cold decay is driver shader caching, not a warm run.** Every session
  reports `Warm inference: none`, so each is `timings[0]` (`src/main.ts`). The
  11.5 s → 4.8 s → 4.4 s trend (and 1110 → 196 ms postprocessing) is the GPU
  driver reusing WGSL pipelines across sessions, converging on ~4.4 s first-run
  cost for this Gen-9. The **within-session warm** number (second run, same page)
  is still unmeasured.
- **Gen-9 is correct-but-slow, with no stall.** No watchdog trip, no fallback, no
  error in any session — it does *not* hit the "Intel Gen-9 WebGPU stalls" mode
  §1 warns about. It stays off the GPU default (`classifyGpuAdapter` →
  `usable: false`).
- **No fallback fired, so this does not exercise the PR #130 path.** All three:
  `WebGPU session: initialized`, `Actual inference provider: webgpu`,
  `WASM executed inference: no`, `Fallback reason: unknown`. The GPU run
  completed cleanly each time, so the `provider-restart` → fresh-worker restart
  never ran. These reports **neither confirm nor refute** the mid-run-abort
  hypothesis and do **not** reproduce the ghost (which needs `above 0.95 ≈ 0%`,
  max ≈0.63, tail ≈0%).

### What no free tier provides

A **real, user-visible GPU device** (your laptop, a colleague's laptop, an
Android phone). Free hosting/CI can exercise the CPU fallback and the memory
paths every commit, and ensure the page is reachable over HTTPS with the right
COOP/COEP — but the WebGPU-on-Adreno numbers still need a human with hardware
(Intel Gen-9 is now measured: §4 laptop result, correct but slow). This is not a
failure of the architecture; it is the one unavoidable manual step.

## 5. Recommendation (keep the stack; change only delivery)

1. **Right now:** use the two work-host URLs as throwaway test endpoints
   (Section 3), because they require no account and no deploy.
2. **For the GPU-vs-CPU question:** run
   `scripts/benchmark-pipelines.py --providers CUDAExecutionProvider` on a free
   Google Colab T4 (or local CPU) whenever a new model export is considered.
   This gives a reproducible GPU baseline at $0.
3. **Before release — deploy the application on Vercel and keep model weights
   on Hugging Face.** The Vercel build serves the WebGPU runtime same-origin;
   the service worker fetches and caches model weights from the Hugging Face
   asset origin. See `DEPLOY.md` for the deployment configuration.
4. **CI regression (free on the public repo):** GitHub Actions job running
   `npm ci && npm run build && node scripts/run-smoke.mjs` with system
   Chromium software rendering (class-2/memory gate). Do **not** publish
   WebGPU timing claims from CI — software rendering is not a GPU.
5. **Close Change 2 with humans:** distribute Section 3 to owners of (a)
   modern integrated-GPU laptop, (b) older laptop without WebGPU, (c) Android
   phone, (d) low-RAM device. Collect provider line + 5 warm timings from
   each. That fills `PHASE1_REPORT.md` §9.1 and §9.3 and the
   device-compatibility matrix.

**Cost check against `MVP_OPENHANDS.md §10` ($0 dev, <$50/mo target):** the
the deployment uses Vercel for the static application and Hugging Face for
model assets. Review current provider plan limits before launch. The download costs nothing per user until the
HF repo hits rate limits at very high volume. The one cost/performance driver
remains the download itself (185 MB per first-load per device); that is the
reason Change-1 (model size) stays the primary product risk.

## 6. Verified free-tier numbers (official docs, 2026-10-25)

| Fact | Value | Source |
|---|---|---|
| Hugging Face — model hosting | Free; no per-file cap for LFS files; serves CORS (`Access-Control-Allow-Origin: *`, verified by curl 2026-10-29) | huggingface.co |
| GitHub Pages (free) | 100 GB/mo soft bandwidth, 1 GB site cap; not for commercial SaaS | docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits |
| GitHub Releases | Files up to **2 GiB each; no bandwidth limit** | docs.github.com/en/repositories/releasing-projects-on-github/about-releases |
| Netlify Free | 300 credits/mo; bandwidth 20 credits/GB ⇒ ~15 GB/mo; 15 credits/deploy | netlify.com/pricing/ |
| Vercel Hobby | 100 MB static-file upload cap | vercel.com/docs/limits |
| **Google Colab** | Free T4 **~12 h/session**, no internet by default (fetch models via SSH/tunnel or upload) | ✅ **[done] — 2026-10-28 measured** on a live Tesla T4 via SSH over its Cloudflare TCP tunnel; see §4 |

## 7. Evidence URLs (all checked 2026-10-25)

- Workers quotas (100k req/day free): https://developers.cloudflare.com/workers/platform/limits/
- GitHub Pages limits (100 GB/mo soft, non-commercial): https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- GitHub repository limits (100 MB single-file push cap): https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits
- GitHub Releases (2 GiB/file, no bandwidth limit): https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases
- GitHub Actions billing (free on public repos): https://docs.github.com/en/billing/concepts/product-billing/github-actions
- Netlify pricing (300-credit free cap, 20 credits/GB): https://www.netlify.com/pricing/
- Vercel limits (100 MB static-file upload on Hobby): https://vercel.com/docs/limits

## 8. Ghost / washed-out cut-out — what was ruled out (2026-11-14)

A report of a uniform washed-out "ghost" cut-out (background *and* subject
translucent, page backdrop visible through everything) on **mobile Chrome,
provider=webgpu**. That symptom matches a mask squashed into ≈[0.5,0.73] — the
fingerprint of a second sigmoid over an already-probability output (MODEL_CARD.md
"regression hazard"). The investigation below ruled that out with evidence; the
remaining suspect is a real-device WebGPU driver/precision issue (§1 already
lists Qualcomm Adreno-6xx as visually wrong on WebGPU). No logic bug was found in
the alpha/compositing path itself — the one in-repo defect found (a mid-run GPU
fallback that rebuilt a WASM session inside the aborted worker) was fixed in
PR #124; see "The GPU-abort fallback restarts on a fresh worker" below. A later
capture (2026-11-15) shows the ghost needs **no** fallback at all, so that defect
is not its cause — see "2026-11-15: the ghost reproduces on a clean WebGPU run".

### What the pipeline actually does (verified)

| Check | Result | Evidence |
|---|---|---|
| ONNX output contract | single `Sigmoid` node ends the graph; `output_image` is already `[0,1]` probabilities | Python `onnxruntime` inspection of the shipped `model_512_int8_fp16.onnx`; MODEL_CARD.md |
| Second sigmoid in the repo | **none** | `public/inference-worker.js` has exactly one `1 / (1 + Math.exp(…))`, guarded by `if (outputIsProbability) { mask.set(out) } else { … }` (the branch is dead for this model). `mask-postprocess.ts` / `composite.ts` / `mask-resize.ts` / `refine-mask.ts` apply no sigmoid/logit transform |
| Provider-specific mask branches | **none** — one `runInference()` shared by WASM and the WebGPU→WASM fallback | `public/inference-worker.js` `runInference`; both call sites pass the same normalisation |
| Repo vs upstream | byte-identical | local git tree == `origin/main` (0 differing blobs) |
| Artifact served | matches manifest | sha256 `10f1cf12…` == `models-manifest.json` |

### Mask statistics (the decisive numbers)

Offline ONNX run of the shipped artifact on the repo's test images — raw mask,
immediately after inference, before crop/resize (a healthy mask is bimodal,
spanning 0..1):

| Image | min | mean | max | tail `<0.1` / `>0.9` |
|---|---|---|---|---|
| glass-wine.jpg | 0.000 | 0.393 | 1.000 | 60% / 39% |
| portrait-hair.jpg | 0.000 | 0.575 | 1.000 | 42% / 56% |
| product-scent-bottle.jpg | 0.000 | 0.288 | 1.000 | 71% / 28% |

In-browser (headless Chromium, `?provider=wasm`, glass-wine.jpg) the same number
is captured live and shown in the Console and the device report:

```
raw mask: min 0.000 / mean 0.293 / max 1.000 (tail 70%/29%)
raw mask check: ok (bimodal)
```

A double-sigmoid squash would put the mean at ≈0.5–0.73 with almost no pixels in
either tail; every measured mask is the opposite — min 0, max 1, bimodal. The
**WebGPU path itself could not be reproduced in this sandbox**: headless Chromium
falls back to WASM (no hardware GPU), so a real phone is required.

### The device mask is flat, not squashed — and it is the same on BOTH providers

Two Copy-report captures from the reporting phone (Android, Qualcomm
Adreno-6xx) tell the same story, and it is NOT the double-sigmoid band:

| Capture | Provider that ran | min | mean | max | tail `<0.01` / `>0.95` |
|---|---|---|---|---|---|
| report 1 | WASM (webgpu fell back) | 0.0065 | 0.2324 | 0.6437 | 0.69% / **0.00%** |
| report 2 | WebGPU | 0.0068 | 0.2385 | 0.6411 | 0.01% / **0.00%** |

The two providers — a GPU kernel and a CPU kernel on the same artifact —
produce a **near-identical flat mask**, so the failure is not provider-specific
and not a double sigmoid (a squash would put the mean at ≈0.5–0.73 with a
non-zero low tail at ≈0.5; here the low tail is intact at 0 and the *high* tail
is what is missing). The mask has no confident foreground core at all.

Offline reproduction attempts on the shipped artifact **failed to reproduce this
shape from any input transform** (all left a healthy bimodal mask, `max 1.0`):
brightness/contrast/saturation sweeps, gamma 0.4–2.8, sRGB↔linear, RGB↔BGR
swaps, Gaussian blur up to r=16, downscale to 32×32, colour casts, and a
composite over a mid-grey backdrop. A *degenerate* input (any uniform
colour, or an all-zero tensor) produces an **empty** mask (mean ≈ 0), not this
flat ramp — so the phone is feeding a real image, just one this model cannot
confidently segment at that precision. This points at the real-device
WebGPU/WASM **fp16 precision** path (§1 lists Adreno-6xx as visually wrong on
WebGPU), not at the repo's alpha/compositing logic.

### 2026-11-15: the ghost reproduces on a CLEAN WebGPU run — no fallback fired

A second Qualcomm Adreno-6xx phone capture (Android 10, Chrome 157, 256×385
photo, `?provider=webgpu`) reproduces the exact ghost mask — and its runtime
block rules out the mid-run-fallback mechanism that PR #124/#130 addressed:

| Capture | min | mean | max | `<0.01` | `<0.5` | `>0.95` | Verdict |
|---|---|---|---|---|---|---|---|
| 2026-11-14 report 1 | 0.0065 | 0.2324 | 0.6437 | 0.69% | — | 0.00% | SUSPECT |
| 2026-11-14 report 2 | 0.0068 | 0.2385 | 0.6411 | 0.01% | — | 0.00% | SUSPECT |
| **2026-11-15** | 0.0082 | 0.2322 | 0.6424 | 0.04% | 99.88% | 0.00% | SUSPECT (tail 0.04%) |

The runtime block reads `WebGPU session: initialized`, `Selected provider:
webgpu`, **`Actual inference provider: webgpu`**, `WebGPU executed inference:
yes`, `WASM executed inference: no`, `Fallback reason: unknown`. Those fields are
set by `src/main.ts` only after a run *resolves* (`actualProvider` from the
inference that ran; `fallbackReason` only from a `provider-restart` message), so
**the WebGPU run returned a mask without raising a provider error, and no
fallback was ever sent.** That is exactly the path PR #124/#130 was built to
guard (reusing a module after a GPU abort) — and it was not taken here. So either
the GPU kernel returned this wrong mask cleanly, or it aborted *silently* (ORT
resolved with partial data instead of throwing); either way the abort never
surfaced as a provider error, so the fresh-worker restart cannot fire and is
**not** the fix. (The restart is still correct hygiene — never reuse a module
after an abort — but it only triggers on a thrown provider failure.)

This also kills the last in-repo candidate: the mask is neither empty nor
provider-divergent, and the same flat shape appears whether a fallback ran
(2026-11-14 report 1, `WASM`) or not (2026-11-15, `webgpu`). The failure is the
**GPU kernel output itself** on this Adreno-6xx class, consistent with the
driver/precision hypothesis in §1. Note the app already keeps this device off the
GPU default (`Adapter usable: no` → `classifyGpuAdapter`), so the affected path
is the *forced* `?provider=webgpu` opt-in.

### The exported PNG proves the repo pipeline is not the culprit (2026-11-14)

The reporting user also attached the actual **ghost export** (a 256×385 RGBA
PNG) with its device report (`Image dimensions: 256x385`, raw mask min 0.0086 /
mean 0.2284 / max 0.6326, 99.70% below 0.5, 0% above 0.95). Two facts settle it:

- The export's alpha is **column-constant**: 95.1% of its energy sits at
  vertical frequency 0, and its rank-1 share is 0.955. The alpha spans 2–105
  (mean 58 = 0.2275) — i.e. the *export alpha mean equals the report's raw-mask
  mean* (0.2275 ≈ 0.2284). The whole photo shows at ~23% opacity.
- Running the **real repo pipeline** (crop → `upscaleMask` → `refineMask` with
  the real image as the guided filter's guide) on the model mask produced from
  the ghost PNG's own RGB yields a **healthy 2-D** result — `colRank 0.229,
  max 255, mean 98` — nothing like the ghost's `colRank 0.951, max 105, mean
  58`. The mask→alpha→composite path does not flatten a good mask.

So the degenerate mask came from the device, not from this repo's
alpha/compositing code. A double sigmoid is also impossible here: its output is
`≥0.5` everywhere, but the ghost alpha **max is 0.41**.

### Conclusion

The alpha/compositing logic in this repo is correct on both providers — no
double sigmoid, no provider-specific divergence, no model-URL mismatch, and the
post-processing path demonstrably preserves a healthy 2-D mask. The reported
ghost output is therefore most consistent with a **real-device precision issue**
(the Adreno-6xx class already documented in §1/§4), which needs a physical phone
to diagnose further. The 2026-11-15 capture narrows this to a **clean WebGPU
run** — the ghost appears with no fallback and no provider divergence, so it is
the GPU kernel output itself, not any repo code path (the mid-run-fallback defect
fixed in PR #124 was a real bug but is not this ghost's cause). To make the
diagnosis one-tap, the app captures the
raw-mask statistics into the **Copy report** button (§3 step 4), warns in the
Console whenever a mask is not bimodal (§9), and — new — classifies the FINAL
composite alpha so a washed-out result is named as such instead of being
mislabelled "fully transparent".

### Guards added (so a real squash can never ship silently)

- Runtime: the main thread measures the delivered raw mask's min/mean/max
  immediately after inference (`src/features/diagnostics/raw-mask-stats.ts`,
  `isSuspectRawMask`) and warns in the Console when the mask is not bimodal; the
  diagnostic report prints a `SUSPECT` verdict. The measurement lives in ONE
  shared module used by the page (the worker no longer keeps a duplicate copy),
  so the thresholds cannot drift between paths.
- Output-level: `finishResult` also classifies the FINAL composite alpha
  (`src/features/diagnostics/output-alpha.ts`, `classifyOutputAlpha`) into
  `empty` / `washed` / `kept` / `ok` and logs an actionable warning. Before this,
  the ghost — which has **zero** pixels above the mid-alpha cutoff — was reported
  as "fully transparent, so there is no subject to show", the opposite of the
  faint whole-frame wash actually on screen. The `washed` verdict is exactly
  "no near-opaque pixel, yet the faint alpha covers the frame"; a clean cut-out
  reaches alpha 254+, and a faint but small translucent object is not flagged.
- The guard tests **bimodality alone** — the share of pixels in the two tails
  (`<0.01` plus `>0.95`) must be at least `MIN_BIMODAL_TAIL` (0.4). It
  deliberately has **no mean band**: an earlier version required
  `mean ∈ [0.45, 0.80]` (the double-sigmoid band) and therefore stayed silent on
  the actual device capture (mean ≈ 0.23, flat, no core) — the very image it
  existed to catch. Bimodality catches both shapes. Verified against all 69
  images in `eval/images/` + `test-images/`: the lowest tail mass of any correct
  mask is **0.75**, so the 0.4 threshold has a wide margin and no false
  positives.
- Unit tests: `raw-mask-stats.test.ts` (the heuristic, incl. a synthetic
  squashed mask and a same-mean bimodal mask), `output-alpha.test.ts` (the final
  composite classifier, incl. the real ghost signature as `washed` and a
  faint-but-small object as `ok`), `diagnostic-report.test.ts` (the report
  contract + a privacy guard), `raw-mask-worker.test.ts` (drives a synthetic
  squashed mask through the real worker and asserts the guard flags it), and
  `model-output-contract.test.ts` (every served model is
  `outputIsProbability`, the sigmoid appears exactly once and is flag-guarded,
  the mask is normalised in exactly one place, and one `runInference` is shared
  by all providers).

### The GPU-abort fallback restarts on a fresh worker (PR #124)

The one in-repo defect behind the ghost hypothesis was in the **run-time
fallback**, not the alpha path. `ort.all.min.js` bundles WebGPU (JSEP) and WASM
into **one wasm module instance per worker**. A WebGPU run that aborts
mid-execution (`bad_alloc`, a lost device, or the run watchdog) could leave that
shared module in a bad state; the OLD fallback then rebuilt a WASM session
**inside the same worker** (`session = null; await createSession(['wasm'])` in the
run handler) and re-ran there, inheriting the corruption. The output stays
bounded by the graph's sigmoid — so it looks like a plausible mask — but is
structurally wrong, which is the column-constant, low-confidence signature the
device reports show.

The fallback now discards the whole worker instead:

- **Worker** (`public/inference-worker.js`): on a provider failure during a
  WebGPU run it posts `{kind:'provider-restart', from:'webgpu', to:'wasm',
  reason, runId}` and returns. The run handler no longer calls `createSession` a
  second time, so nothing is ever rebuilt inside the aborted module.
- **Page** (`src/main.ts`, `restartOnFreshWorker`): terminates the worker and its
  ORT module (`worker.terminate()`), spawns a **fresh** worker pinned to the CPU
  with a one-shot `overrideProvider` (cleared by that load, so the user's own
  provider choice governs every later load), reloads the model from the on-device
  asset cache, and re-posts the failed run under the **same run id** so its
  pending promise settles instead of hanging.

This is the general-correctness fix — never reuse a module after a GPU EP aborts
mid-run. It was the leading candidate for the ghost, but the 2026-11-15 capture
above **falsifies that**: the ghost reproduces on a clean WebGPU run with no
fallback at all (`Actual inference provider: webgpu`, `WASM executed inference:
no`). Keep this fix — reusing a module after an abort is wrong regardless — but
it is **not** the ghost fix, and real-phone confirmation of the ghost is still
outstanding. Scope is unchanged: no change to the model
artifact, the input resolution, or the provider try-order. The normal
(no-fallback) boot is untouched — same worker factory, no added latency.
`fresh-worker-fallback.test.ts` pins the main-thread half (single factory,
terminate-before-recreate, CPU override, same-run-id retry) and
`model-output-contract.test.ts` pins the worker half.

## 9. Reading a diagnostic report

Press **Copy report** in the Console card header (or call
`window.diagnosticReport()` for the structured object /
`window.deviceReport()` for the text). Key lines:

- `provider:` / `actual provider:` / `gpu adapter:` — which path actually ran.
  `actual provider: wasm` with `webgpu session built: yes` means a WebGPU session
  was created but inference fell back; `(none)` means no run yet.
- `RAW MASK STATISTICS` block — `Min` / `Mean` / `Max` and the tail fractions.
  A healthy mask is bimodal: `Min 0.0000` / `Max 1.0000` with large tail
  fractions. A `SUSPECT` verdict (mean ≈0.5–0.73, near-empty tails) means the
  alpha is squashed — the ghost-image fingerprint.
- `Average inference:` — the timings used for the Change-2 device comparison
  (§1).

