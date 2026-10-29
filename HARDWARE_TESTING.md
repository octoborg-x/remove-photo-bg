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
| Known bad devices | Intel Gen-9 WebGPU stalls, Qualcomm Adreno-6xx (WebGPU slow + visually wrong — §4 phone result / `PHASE1_REPORT.md` §9). |
| Download size | ~185 MB (`model_512.onnx`) — exceeds the §13 100 MB flag. |
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
| 1 | Modern laptop, integrated GPU | WebGPU warm inference time, first-run shader compile time, correct provider line | **Work-host URLs now (run 1 below)**, then Cloudflare Pages + Hugging Face |
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
2. Wait for "Model loaded — provider …" in the log (first load downloads
   ~185 MB; the `#stage` line now shows **real progress + MB** as it streams).
3. Click **Run smoke test**; wait for 5 warm inferences.
4. After it finishes, click **Copy device report**, then paste the clipboard
   directly into the change-2 tracker. It already contains provider, GPU
   adapter + `shader-f16`, cross-origin isolation, the 5 timings, average,
   model size, and the UA — no hand-typing and no photo required.
5. _Optionally_, also capture:
   - page `#stage` text during the first run (shader-compile note prints only
     on the `webgpu` path — which is **off by default**; append
     `?provider=webgpu` to test it)
   - `performance.memory` or `/proc` peak if convenient (class 4)
   - whether a fallback message ever appears
6. The default provider is now **WASM**, so a default run is the CPU probe.
   To exercise the WebGPU path on a not-yet-validated adapter, append
   `?provider=webgpu`. To rule the GPU out explicitly, append `?provider=wasm`.

**Privacy:** the harness never uploads anything. `run-smoke.mjs` additionally
records every network request and fails the summary if any is non-first-party;
the on-page device report is composed and copied entirely in the browser.

**Automated variant (CPU/WASM only, already in the repo):**

```bash
node scripts/run-smoke.mjs "https://work-1-aybthnpldbthpfgf.prod-runtime.all-hands.dev/" \
  --image test-images/glass-wine.jpg --runs 5 --out smoke-results/device-laptop-wasm
```

That writes provider, timings, the output PNG, and `requests.json` (privacy:
all requests must stay first-party). Note: `run-smoke.mjs` forces WASM/software
rendering — it is the *class-2* probe. WebGPU probing must be done by opening
the page in a graphical browser (steps 1–4).

**What to paste back into the report:** the **Copy device report** output (or
the provider line + 5 timings + device/OS/GPU name from `chrome://gpu`), and
whether fallback triggered.

## 4. Verified free-hosting facts (official docs, 2026-10-25)

### Static site hosts

| Host | Free tier (official) | Fits 185 MB model? | Notes |
|---|---|---|---|
| **Cloudflare Pages** | Unlimited static sites on Free; 500 builds/mo; 20,000 files; **25 MiB max file size** | ❌ model must live elsewhere | `developers.cloudflare.com/pages/platform/limits/` |
| **Cloudflare R2 + Pages** | R2 Free: **10 GB-month storage, 1M Class A / 10M Class B ops, egress free** | ✅ **recommend** | Docs explicitly point to R2 for files > 25 MiB; free egress means the 185 MB model costs **$0 bandwidth** |
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
Cloudflare TCP tunnel (Colab has no inbound ports); the mechanism is the one
documented in `notebooks/colab-t4-benchmark.ipynb`. Artifacts committed under
`smoke-results/benchmark-t4/` (`summary.json` with machine-captured
`environment` block, `quality-t4/quality.json` + side-by-side cutouts; the
`masks/` arrays are regenerated by `scripts/compare-models-gpu.py` and
gitignored). The per-field record — model SHA-256, exact runtime, latency,
VRAM, mask IoU — is [`COLAB_T4_REPORT.md`](./COLAB_T4_REPORT.md).

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

### What no free tier provides

A **real, user-visible GPU device** (your laptop, a colleague's laptop, an
Android phone). Free hosting/CI can exercise the CPU fallback and the memory
paths every commit, and ensure the page is reachable over HTTPS with the right
COOP/COEP — but Change-2's WebGPU-on-Intel-Gen9 / on-Adreno numbers still need
a human with hardware. This is not a failure of the architecture; it is the one
unavoidable manual step.

## 5. Recommendation (keep the stack; change only delivery)

1. **Right now:** use the two work-host URLs as throwaway test endpoints
   (Section 3), because they require no account and no deploy.
2. **For the GPU-vs-CPU question:** run
   `scripts/benchmark-pipelines.py --providers CUDAExecutionProvider` on a free
   Google Colab T4 (or local CPU) whenever a new model export is considered.
   This gives a reproducible GPU baseline at $0.
3. **Before release — deploy the small site to Cloudflare Pages, keep the model
   on Hugging Face.** This is implemented; see `DEPLOY.md`. The split is forced
   by two verified constraints:
   - **The threaded WASM runtime must be same-origin.** onnxruntime-web's pthread
     workers fetch their own subresources directly, bypassing the service worker,
     so a cross-origin `.wasm` never gets the `Cross-Origin-Resource-Policy`
     header a COEP page needs and `InferenceSession.create` hangs forever.
   - **Pages caps a single static file at 25 MiB**, below the 26.5 MiB
     `ort-wasm-simd-threaded.jsep.wasm` the runtime loads for the WebGPU backend
     even with WebGPU off.

   So: the **model** is fetched straight from Hugging Face by the service worker
   (proxied and cached same-origin; HF serves CORS + no size cap, verified), and
   the **WASM runtime** is the **CPU-only bundle** (`ort.wasm.min.js`, 13.3 MiB)
   shipped as a same-origin Pages static file. The site itself stays ~400 KB.
   WebGPU is not attempted in this configuration (the `jsep` binary cannot fit on
   Pages without a card-billing feature like R2); `?provider=wasm` is the only
   provider. Rationale: $0 recurring and no credit card anywhere; HF has no
   per-file cap and a public repo costs nothing.
   - Alternative model rails that cost $0 but cache worse or live off-origin:
     GitHub Releases (`curl -L` redirect to `objects.githubusercontent.com`,
     native CORS unsupported — the SW must have CORS headers, so this needs a
     worker-side fallback), or Cloudflare R2 (requires a payment method).
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
recommended path is $0/month and needs **no credit card**: Cloudflare Pages has
no bandwidth charge for the small static site, and Hugging Face serves the model
for free on its CDN (public repo). The download costs nothing per user until the
HF repo hits rate limits at very high volume. The one cost/performance driver
remains the download itself (185 MB per first-load per device); that is the
reason Change-1 (model size) stays the primary product risk.

## 6. Verified free-tier numbers (official docs, 2026-10-25)

| Fact | Value | Source |
|---|---|---|
| Hugging Face — model hosting | Free; no per-file cap for LFS files; serves CORS (`Access-Control-Allow-Origin: *`, verified by curl 2026-10-29) | huggingface.co |
| Pages Free builds | **500 builds/month**, 1 at a time | developers.cloudflare.com/pages/platform/limits/ |
| Pages Free files | **20,000 files per site** | same |
| Pages max single-file size | **25 MiB** | same |
| GitHub Pages (free) | 100 GB/mo soft bandwidth, 1 GB site cap; not for commercial SaaS | docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits |
| GitHub Releases | Files up to **2 GiB each; no bandwidth limit** | docs.github.com/en/repositories/releasing-projects-on-github/about-releases |
| Netlify Free | 300 credits/mo; bandwidth 20 credits/GB ⇒ ~15 GB/mo; 15 credits/deploy | netlify.com/pricing/ |
| Vercel Hobby | 100 MB static-file upload cap | vercel.com/docs/limits |
| **Google Colab** | Free T4 **~12 h/session**, no internet by default (fetch models via SSH/tunnel or upload) | ✅ **[done] — 2026-10-28 measured** on a live Tesla T4 via SSH over its Cloudflare TCP tunnel; see §4 |

## 7. Evidence URLs (all checked 2026-10-25)

- R2 pricing (free tier, egress note): https://developers.cloudflare.com/r2/pricing/
- Cloudflare Pages limits (25 MiB file cap, 500 builds/mo): https://developers.cloudflare.com/pages/platform/limits/
- Workers quotas (100k req/day free): https://developers.cloudflare.com/workers/platform/limits/
- GitHub Pages limits (100 GB/mo soft, non-commercial): https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- GitHub repository limits (100 MB single-file push cap): https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits
- GitHub Releases (2 GiB/file, no bandwidth limit): https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases
- GitHub Actions billing (free on public repos): https://docs.github.com/en/billing/concepts/product-billing/github-actions
- Netlify pricing (300-credit free cap, 20 credits/GB): https://www.netlify.com/pricing/
- Vercel limits (100 MB static-file upload on Hobby): https://vercel.com/docs/limits
