# Progressive refinement report — a usable preview first, then sharper edges

**Date:** 2026-11-12
**Status:** ✅ DONE — refinement is **enabled by default**; `?refine=off` restores the
unrefined Stage-1 result byte-for-byte (A/B baseline).
**Scope:** the 512 px Fast model's soft mask only. The model, its weights, its ONNX
contract and its resolution are **unchanged**. No second model, no second inference
pass, no mode switcher, no cloud/server step. **Budget spent:** $0.

This report continues the evidence-first style of `PHASE1_REPORT.md`. It records what
changed, the measured numbers (not estimates), and an explicit verdict.

## 1. Why this exists

`PHASE1_REPORT.md` §6 established the one visually-confirmed quality gap of the 512 px
export: **softer fine/specular edge detail** than the 1024 px reference (mean IoU@0.5
0.9917 across three runtimes, i.e. the mask *area* already agrees; the difference is
confined to the transition band — ≈2.4 px wide at 512 vs ≈1.4 px at 1024, most visible
on the wine-glass rim). §6 and `COLAB_T4_REPORT.md` §5 report the edge-gradient *metric*
in opposite directions; this task targets the **visually-agreed softness**, not either
number, and measures the transition band directly.

The user-facing change: the one-shot "wait for the mask" flow becomes **"show a usable
preview the moment the 512 px model finishes, then sharpen it live."**

## 2. What changed

New modules (all under `src/features/background-removal/`):

| File | Role |
|---|---|
| `refinement-config.ts` | `FastRefinementConfig`, validated defaults, `resolveRefinementConfig`, URL-param reader |
| `mask-resize.ts` | float soft-mask resize (bilinear/bicubic), letterbox crop, float↔byte, luma guide |
| `guided-filter.ts` | Stage 3: He, Sun & Tang (ECCV 2010) image-guided filter, banded |
| `refine-mask.ts` | Stages 2–4 orchestration (reconstruct → refine → cleanup) |
| `refinement-worker.ts` | module worker running `refineMask` off the main thread |
| `refinement-client.ts` | `RefinementRunner`: worker-with-main-thread-fallback, cancellation by job id |

Edited: `src/main.ts` (staged preview + `?refine` params), `index.html`
(`#refineNotice`), `src/style.css`, `scripts/run-smoke.mjs` (per-run `refineStages`
timings), `scripts/run-browser-tests.mjs` (refinement scenario), plus the two new
fixtures and their source records. **No dependency was added** (see §7).

### Pipeline (inserted between the existing inference and the existing composite)

- **Stage 1 (existing, untouched)** — 512 px inference. On `result-ready` the mask is
  reconstructed to the original size, the flood-fill recovery runs, the user's
  threshold/feather applies, and an **initial preview is composited and shown
  immediately**, then marked exportable (`setConsoleStatus('Preview ready — refining
  edges…')`, `studioPreview()`).
- **Stage 2** — full-resolution soft-mask reconstruction. Bilinear (default) or
  bicubic, clamp to `[0,1]`, NaN/Infinity folded to 0. Stays floating point.
- **Stage 3** — image-guided edge refinement. The original image's luma is the guide,
  the Stage-2 mask the input; the filter snaps the mask edge to the image's real edges.
  No open/close/erode/dilate; no single global blur.
- **Stage 4** — conservative cleanup. Clamp to `[minAlpha,maxAlpha]`, remove only tiny
  isolated islands (area floor scaled to image size), and an image-guided smoothing of
  the transition band only.
- **Stage 5 (existing, extended)** — composite + export. Preview and download read the
  same final alpha; the export is at the original dimensions (never downscaled).

## 3. The refinement algorithm and why

A **guided filter** (He, Sun & Tang, ECCV 2010) — classic, deterministic, non-learned,
and local. It is the right tool for "sharpen a soft mask using the image that produced
it": in a window it fits `q = a·I + b` (a linear model of the guide), so where the guide
has a real edge the output mask follows it, and where the guide is flat the mask is
smoothed. It is O(1) per pixel per pass via box filters, and it neither erodes/dilates
nor thresholds — the two things that would destroy hair, fur and chain links.

Stage 4's transition smoothing was implemented as a **local, guide-weighted average of
semi-transparent pixels only** — no global box blur of the alpha channel (an earlier
draft did exactly that and was caught in review; see §6).

## 4. Measured results (this sandbox, WASM, headless Chromium)

### 4a. Timings — refinement does not regress inference

Per-run, on the existing fixtures (960 px wide), all at full original resolution
(`downscaled:false`):

| Fixture | Inference (ms) | Stage 2 upscale | Stage 3 filter | Stage 4 cleanup | Refine total | time-to-initial-preview | time-to-final |
|---|---|---|---|---|---|---|---|
| product-scent-bottle (960×1400) | 4118 | 25 | 114 | 46 | 185 | ≈ inference + ≈90 | ≈ +295 |
| animal-buddy-dog (960×1260) | 3674 | 28 | 91 | 51 | 170 | ≈ +90 | ≈ +243 |
| glass-wine (960×1280) | 3538 | 28 | 89 | 57 | 174 | ≈ +90 | ≈ +256 |
| portrait-hair (960×1233) | 3568 | 23 | 86 | 79 | 188 | ≈ +90 | ≈ +291 |
| jewelry-chain (960×995) | 3582 | 16 | 71 | 29 | 116 | ≈ +80 | ≈ +176 |

Stage-1 inference (3.4–4.1 s) matches the documented 512 px WASM baseline (3.3–5.7 s);
refinement adds **≈0.12–0.19 s total**, so time-to-final is inference + ≈0.2 s. A staged
UI check observed the initial preview at **t≈6646 ms** with the "Refining edges…" banner,
and the refined swap at **t≈6926 ms** — the preview is usable for ≈280 ms before the
refined result replaces it atomically.

### 4b. Quality vs the unrefined baseline (the A/B, `?refine=off`)

Refined minus baseline, on the same fixture, full resolution:

| Fixture | px changed >0.1 | fg lost | fg gained | max Δα | background lift | fg kept |
|---|---|---|---|---|---|---|
| product-scent-bottle | 0.71 % | 1012 | 1302 | 0.49 | 0.0003 | 0.9992 |
| animal-buddy-dog | 0.91 % | 1371 | 1138 | 0.44 | 0.0006 | 0.9989 |
| glass-wine | 1.06 % | 1472 | 1027 | 0.40 | 0.0008 | 0.9991 |
| portrait-hair | 0.73 % | 1481 | 967 | 0.49 | 0.0008 | 0.9993 |
| jewelry-chain | 2.09 % | 1764 | 1480 | 0.51 | 0.0016 | 0.9932 |

The change is edge-localised (≤2 % of pixels), foreground/background are preserved
(≥99.3 % of obviously-foreground pixels keep their alpha; background is not lifted
beyond 0.0016), and foreground is lost and gained in balance — edge snapping, not
erosion. Thin structures survive: the jewelry-chain cut-out keeps **identical topology**
(same links, same gaps) in the ASCII alpha map; only the edges are crisper.

### 4c. Sharpness vs the 1024 px reference

Peak edge slope (max |Δα| across the strongest edges), refined vs baseline vs the 1024
reference resampled to the same grid:

| Fixture | baseline | refined | 1024 reference |
|---|---|---|---|
| glass-wine | 0.25 | 0.42 | 0.35 |
| animal-buddy-dog | 0.29 | 0.45 | 0.39 |
| product-scent-bottle | 0.27 | 0.47 | 0.38 |

Refinement moves the peak edge slope from *below* the 1024 reference toward and slightly
past it. This is the honest, band-localised metric; the *whole-image* gradient average is
dominated by flat regions and moves little.

## 5. UI behaviour

States: **Preparing image → Removing background → Preview ready → Refining edges →
Final result ready.** The Stage-1 preview appears the instant it is ready and is
exportable while refinement runs (a "Refining edges…" banner sits over it). The refined
result swaps in **atomically** on success. A new upload bumps a job id and cancels the
running refinement; a stale job's late result is dropped and can never overwrite a newer
preview. No fabricated percentage is shown. If refinement fails or is cancelled, the
last good preview stays on screen and exportable, and every job reaches a terminal state.

## 6. A caught bug worth recording

The first Stage-4 implementation computed a **separable box blur of the entire alpha
channel** and blended it in the transition band. It was subtle (blended only near the
edge) but it is exactly the "single global blur over the whole alpha channel" the spec
forbids, and it made the refined output *softer* than the baseline — the opposite of the
goal. It was replaced with a local, guide-weighted average over semi-transparent pixels
only. Two default sets were also measured and rejected: the initial
`radius=8, epsilon=1e-4, strength=0.85` produced the most ringing, overshoot and
background lift of every candidate (overshoot on 13.8 % of the transition band); the
shipped defaults are `radius=3, epsilon=1e-3, strength=0.5`, chosen for the best
sharpness/halo trade-off measured across all five fixtures.

## 7. Dependencies, privacy, and legal

- **No new dependency.** The guided filter, mask resize and cleanup are plain
  TypeScript over `Float32Array`; the worker is the platform's own module worker with a
  main-thread fallback. Bundle impact is one new chunk,
  `dist/assets/refinement-worker-*.js` (**≈7 kB**); the main bundle is unchanged in
  substance. `THIRD_PARTY_LEGAL_NOTICES.md` needs no new entry.
- **Privacy unchanged.** `scripts/verify-network.mjs` re-run after this change reports
  **0 non-first-party requests** (the property it exists to verify). Its auto-generated
  *verdict* string still reads "REVIEW REQUIRED" only because the script also counts any
  `fetch`/`xhr` — and the single one is the pre-existing same-origin
  `GET /models-manifest.json` from `model-manifest.ts`, not an upload. Refinement adds
  no request: it runs entirely on the already-decoded buffer, so no image pixels leave
  the device. (The committed `smoke-results/network-verification.json` was left as the
  last full-app-shell capture rather than overwritten with a dev-server capture that
  would list dozens of Vite module URLs.)
- **No app-level upload path.** `no-upload-path.test.ts` (MVP §9) still passes; it scans
  the shipped sources and `index.html` for fetch/XHR/beacon/FormData upload constructs
  and fails the build if one appears.

## 8. Configuration

`FastRefinementConfig` (see `refinement-config.ts`) with validated defaults:
`enabled:true`, `maskUpscale.interpolation:'bilinear'`,
`edgeRefinement:{enabled:true, algorithm:'guided-filter', radius:3, epsilon:1e-3,
strength:0.5, edgeSensitivity:1}`, `cleanup:{enabled:true, preserveSoftAlpha:true,
minAlpha:0, maxAlpha:1, removeTinyIsolatedNoise:true}`,
`performance:{useWorker:true, chunkRows:64, maxProcessingPixels:4096*4096}`.

The product exposes **no tuning UI**. A few knobs are reachable only by URL for A/B and
debugging: `?refine=off` (or `0`/`false`) bypasses Stages 3–4 exactly;
`?refine=edges-off`, `?refineRadius`, `?refineEpsilon`, `?refineStrength`,
`?refineEdgeSensitivity` override individual fields (out-of-range values are clamped so
no combination can produce an invalid config).

## 9. Test / lint / build results

- `npm run verify` (lint → typecheck → unit → build): **green, 270 unit tests**.
  New unit coverage: config validation (8), guided-filter (6), mask-resize (12),
  refine-mask (resize range, NaN/Infinity, cancellation between stages, thin-structure
  survival, fg/bg preservation, tiny-island removal), refinement-client (main-thread
  path, supersede, cancel, dispose, feature probe).
- `scripts/run-browser-tests.mjs`: **55/55 checks**, including four new refinement checks
  (export keeps original dimensions; stage timings reported; refining banner hidden at
  settle; `?refine=off` bypasses refinement and still exports at full size).
- `scripts/verify-network.mjs`: **0 non-first-party requests**.
- Production build: passes; `refinement-worker` is a separate ≈7 kB chunk.

## 10. Known limitations

- The 512 px model never *detected* the fine detail in the first place; refinement can
  only **snap the mask edge to the image's real edges**, not recover structure the mask
  did not contain. Where the guide image is itself soft (the wine-glass rim's luma is a
  gradual specular gradient), the guided filter cannot sharpen further and may widen the
  transition slightly while steepening its centre. This is the honest ceiling of a
  post-processing stage on a 512 px mask.
- The improvement is band-localised (≤2 % of pixels). It is a refinement, not a new
  quality tier; a user comparing whole images will see crisper thin edges, not a
  dramatic change.
- WebGPU was not exercised here (no GPU in this sandbox); refinement behaves identically
  regardless of which provider produced the mask, since it runs after inference on the
  returned probability tensor.

## 11. Verdict

**GO — ship enabled by default.** Refinement adds ≈0.12–0.19 s after an unchanged
3.4–4.1 s inference, sharpens the transition band toward the 1024 reference, preserves
thin structures and foreground/background extents, keeps the export at original
dimensions, adds no dependency, and does not touch privacy. `?refine=off` gives an exact
baseline for A/B. The one honest caveat is the band-localised ceiling of §10 — post-
processing on a 512 px mask, not a second model.

## 12. Follow-up work (deferred, not rejected — see the task's §9)

Worth scoping separately, each reintroducing a server/Python dependency or a second
model: full alpha matting via PyMatting (trimap + `estimate_alpha_cf` /
`estimate_foreground_ml`) with foreground colour decontamination; a Fast/Balanced/Quality
mode switcher; the 1024 px fp16 export as a Quality path; and the 45-image,
9-category PhotoRoom comparison benchmark.
