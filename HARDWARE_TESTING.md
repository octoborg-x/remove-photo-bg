# Hardware testing and free hosting

Companion to `PHASE1_REPORT.md` §9/§10 and the "hardware part" of the release
review. Goal: answer — *is there free hosting that gets us close to the
Change-2 device tests?* — with the repo's current state, the exact numbers
currently missing, and verified free-tier facts from vendor documentation
(checked 2026-10-25). The free-GPU benchmark path was validated end-to-end on
2026-10-25 (see §5).

## 1. Where we actually stand

| Question | Answer (evidence) |
|---|---|
| WebGPU timed on real hardware? | **Never.** Sandbox has no GPU/WebGPU. Only WASM was measured. |
| WASM (CPU) measured? | Yes — 4.3–4.6 s warm per image in headless Chromium 155 (`PHASE1_REPORT.md` §5). |
| Known bad devices | Intel Gen-9 WebGPU stalls, Qualcomm Adreno (`PHASE1_REPORT.md` §9). |
| Download size | ~185 MB (`model_512.onnx`) — exceeds the §13 100 MB flag. |
| GPU benchmark run? | **2026-10-25** — free-GPU kernel pushed to Kaggle (RUNNING), methodology in `Kaggle GPU` §5. |

**Implication:** the number that decides whether the WebGPU path is even needed
as a rescue is *"open the page in desktop Chrome and report 5 warm inference
times + the provider line."* Free hosting does not create real GPUs, but it can
give testers a real HTTPS page that serves the exact 185 MB model with the
right COOP/COEP headers so the WebGPU + threaded-WASM path actually engages.

## 2. Four Change-2 device classes → what closes each at $0

| # | Device class | What "close to the test" means | Free path |
|---|---|---|---|
| 1 | Modern laptop, integrated GPU | WebGPU warm inference time, first-run shader compile time, correct provider line | **Work-host URLs now (runbook §3)**, then Cloudflare Pages/R2 or GitHub Releases + Pages |
| 2 | Laptop/desktop *without* usable WebGPU | WASM path engages; confirm fallback message + timing, no silent cloud fallback | Same URLs with `?provider=wasm` (forces CPU path) |
| 3 | Android phone, representative mobile GPU | WebGPU on mobile; ~185 MB download over mobile data; memory | Same URLs opened in mobile Chrome; R2 free egress makes bandwidth $0 |
| 4 | Low-memory device | Peak memory, `bad_alloc`, watchdog/fallback behavior | Same URLs; in-page error copy exists (`describeError` in `src/main.ts`) |

All four classes just need a URL that serves model + wasm with
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
require-corp` (set in `vite.config.ts`). No cloud inference, no image
upload — testers press the button on the page.

## 3. Runbook — copy-paste for a real device

**Per device (any OS with Chrome/Edge):**

1. Open https://work-1-aybthnpldbthpfgf.prod-runtime.all-hands.dev/ in Chrome.
2. Wait for "Model loaded — provider …" in the `#log` area (first load
   downloads ~185 MB; the `#stage` line shows real progress + MB as it
   streams).
3. Click **Run smoke test (5 warm inferences)**; wait for it to finish.
4. The `#log` records the provider + timings. Record: provider line, the 5
   timings + average, device/OS/GPU from `chrome://gpu`, and whether any
   fallback message appeared.
5. _Optionally_ capture `performance.memory` or `/proc` peak (class 4).
6. For class 2, repeat with `?provider=wasm` appended to the URL.

**Privacy:** the harness never uploads anything. `run-smoke.mjs` additionally
records every network request and fails the summary if any is non-first-party.

**Automated variant (CPU/WASM only, already in the repo):**

```bash
node scripts/run-smoke.mjs "https://work-1-aybthnpldbthpfgf.prod-runtime.all-hands.dev/" \
  --image test-images/glass-wine.jpg --runs 5 --out smoke-results/device-laptop-wasm
```

That writes provider, timings, the output PNG, and `requests.json` (privacy:
all requests must stay first-party). Note: `run-smoke.mjs` forces WASM/software
rendering — it is the *class-2* probe. WebGPU probing must be done by opening
the page in a graphical browser (steps 1–4).

**What to paste back into the report:** the provider line + 5 timings +
device/OS/GPU name from `chrome://gpu`, and whether fallback triggered.

## 4. Verified free-tier hosting facts (official docs, 2026-10-25)

### Static site hosts

| Host | Free tier (official) | Fits 185 MB model? | Notes |
|---|---|---|---|
| **Cloudflare Pages** | Unlimited static sites on Free; 500 builds/mo; 20,000 files; **25 MiB max file size** | ❌ model must live elsewhere | `developers.cloudflare.com/pages/platform/limits/` |
| **Cloudflare R2 + Pages** | R2 Free: **10 GB-month storage, 1M Class A / 10M Class B ops, egress free** | ✅ **recommend** | Docs point to R2 for files > 25 MiB; free egress means the 185 MB model costs **$0 bandwidth** |
| **GitHub Pages** | Free; **100 GB/mo soft bandwidth**; 1 GB published-site cap; **100 MB max single pushed file** | ❌ file cap | Docs: "GitHub Pages is not intended… commercial SaaS"; 10 min deploy timeout |
| **GitHub Releases** | Files up to **2 GiB each; no bandwidth limit** | ✅ model rail | Keep the 185 MB model as a release asset, fetch with `curl -L` |
| **Netlify Free** | New credit plans: **300 credits/mo hard cap; bandwidth 20 credits/GB ⇒ ~15 GB/mo** | ❌ bandwidth burn | Model serves would use the cap in ~80 downloads |
| **Vercel Hobby** | **100 MB static-file upload cap**; 2,000 min/mo builds on free public | ❌ file cap | Model must be external either way |

### Free GPU compute (new, validated 2026-10-25)

| Service | Free facts (official) | Fit |
|---|---|---|
| **Kaggle** | Free GPU session (Nvidia Tesla T4 x2 or P100) **30 h/week**, internet on, private kernels | ✅ **[done]** — kernel pushed & ran: `octoxdev/birefnet-lite-free-gpu-benchmark-1024-vs-512` |
| **Google Colab** | Free T4 **~12 h/session**, no internet by default (upload test data as dataset) | ✅ untested — same methodology works |
| **GitHub Actions** | Free on public repos; 2,000 min/mo on private plans; **no usable GPU** | ❌ GPU; fine for WASM/class-2 CI |

The Kaggle kernel (`kaggle/birefnet-free-gpu-benchmark/`) is self-contained:
it downloads the two candidate ONNX models, reproduces the
`scripts/benchmark-pipelines.py` methodology (cold start, N warm runs, peak
RSS, masks saved), and records the nvidia-smi device name. Credentials were
provided and the kernel is running at the time of writing — first real-GPU
measurement of the 1024-vs-512 question.

### What no free tier provides

A **real, user-visible GPU device** (your laptop, a colleague's laptop, an
Android phone). Free hosting/CI can exercise the CPU fallback and memory paths
every commit, and ensure the page is reachable over HTTPS with the right
COOP/COEP — but Change-2's WebGPU-on-Intel-Gen9 / on-Adreno numbers still need
a human with hardware.

## 5. Recommendation (keep the stack; change only delivery)

1. **Right now:** use the two work-host URLs as throwaway test endpoints
   (Section 3) — no account, no deploy.
2. **For the GPU-vs-CPU question:** run the pushed Kaggle kernel (or the local
   `scripts/benchmark-pipelines.py`) whenever a new model export is
   considered. This gives a reproducible GPU baseline at $0.
3. **Before release — deploy to Cloudflare Pages (app + wasm) and put
   `model_512.onnx` in a public Cloudflare R2 bucket (CORS +
   `Cache-Control: immutable`, long `max-age`).** Rationale: $0 recurring, R2
   egress free (so the 185 MB model costs **$0 bandwidth**), Pages fine for a
   static SPA. Headers to set: COOP/COEP as in `vite.config.ts`, plus
   `Cache-Control: immutable` on `/models/*` and `/wasm/*`.
   - Alternative model rails at $0: Cloudflare R2 (separate public bucket),
     GitHub Releases (`curl -L` redirect), Hugging Face (`no-store` cache
     header, third-party domain).
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
recommended path is $0/month: Cloudflare Pages has no bandwidth charge and R2
egress is free, so the model download costs nothing per user until volume is
high enough to trigger rate limits. The one cost/performance driver remains the
download itself (185 MB per first-load per device); that is the reason
Change-1 (model size) stays the primary product risk.

## 6. Verified free-tier numbers (official docs, 2026-10-25)

| Fact | Value | Source |
|---|---|---|
| R2 Free storage | **10 GB-month** | developers.cloudflare.com/r2/pricing/ |
| R2 Free operations | 1M Class A + 10M Class B ops/month | same |
| R2 egress (data transfer to Internet) | **Free** | same |
| Pages Free builds | **500 builds/month**, 1 at a time | developers.cloudflare.com/pages/platform/limits/ |
| Pages Free files | **20,000 files per site** | same |
| Pages max single-file size | **25 MiB** (docs point to R2) | same |
| GitHub Pages (free) | 100 GB/mo soft bandwidth, 1 GB site cap; not for commercial SaaS | docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits |
| GitHub Releases | Files up to **2 GiB each; no bandwidth limit** | docs.github.com/en/repositories/releasing-projects-on-github/about-releases |
| Netlify Free | 300 credits/mo; 20 credits/GB ⇒ ~15 GB/mo | netlify.com/pricing/ |
| Vercel Hobby | 100 MB static-file upload cap | vercel.com/docs/limits |
| Kaggle GPU | **30 h/week free** (Nvidia T4 x2 / P100), internet on | kaggle.com/docs/notebooks |