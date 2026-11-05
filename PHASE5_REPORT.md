# Phase 5 report — delivery

**Date:** 2026-11-02
**Status:** ✅ DONE — all five MVP phases complete. The repo is self-describing
(quick start, browser requirements, model-download steps, test commands) and
this report records what was built, what was measured, and what remains.
**Budget spent:** $0.

Phase 5 (MVP §11) is documentation and reporting only; it changes no product
behaviour. The plan is [`PHASE5_PLAN.md`](./PHASE5_PLAN.md).

## Deliverables

- **`README.md`** — added a **Quick start** (three commands) and **Browser
  requirements**; `Requirements`/`Setup` now point at them; the phase banner and
  the final "known limitations" bullet reflect that all five phases are done.
  Added a **Model quality evaluation** section and a **One inference
  implementation** section (drift fix, below).
- **`.env.example`** — names only, **no secret required for browser-only
  inference**. The single optional variable is `VITE_ASSET_BASE` (asset origin);
  blank means same-origin.
- **`PHASE5_REPORT.md`** — this file.
- **`EVALUATION.md`** — the fixed image set, the harness, and the recorded WASM
  baseline (below).
- **`eval/` + `scripts/eval/`** — the evaluation set (`manifest.json`,
  `images/`, `ATTRIBUTION.md`) and its builder/harness/analyser.
- **Definition-of-done sweep** — below (MVP §12).

## Post-Phase-5 review fixes

A review of the delivered repo raised four points; the fixes are recorded here.

### 1. One inference implementation (drift removed)

`src/features/background-removal/model.worker.ts` was a second, TypeScript
inference worker that **nothing loaded** — the app uses the classic
`public/inference-worker.js` (see `README.md` "One inference implementation").
Editing the TypeScript file changed nothing at runtime: a real drift hazard.
The dead file is **removed**, and `single-inference-worker.test.ts` now fails if
a second session-creating worker appears or if the page stops loading the
classic worker. The classic worker is required by the build/runtime (Vite
cannot bundle the ONNX Runtime loader files in `public/wasm/`; the service
worker caches stable URLs), and that reason is documented in the README.

### 2. CI verifies the latest commit

The CI workflow (`.github/workflows/smoke.yml`, `name: ci`) now runs **two
independent gates** on every change that can influence the app:

- `static-checks` — `npm run lint`, `typecheck`, the unit suite, and the offline
  evaluation-set verification. Fast; catches "green build, broken tests" that
  the smoke job alone cannot see.
- `wasm-smoke` — a real build served to real Chromium: the **browser flow tests**
  (upload → inference → exports, error paths, keyboard, privacy) **and** the
  WASM smoke runs across the three models and the mask-override path.

Both fire on `src/**`, `public/**`, `scripts/**`, `eval/**`, `test-images/**`
and build/dependency config. Note: HEAD `1b769da` already had a **successful**
`smoke` run (see the run table); this change widens coverage, it does not fill a
missing verification.

### 3. Model quality evaluated against real images

A fixed, licence-verified 64-image set and a harness that runs the **deployed
pipeline** over it. See `EVALUATION.md`; baseline recorded below.

## Changed files (whole build)

| Phase | Commit(s) | Key files |
|---|---|---|
| 2 (confirm) | `280ae1f` | `src/features/background-removal/image-validation.ts`, `src/main.ts`, `index.html`, `PHASE2_REPORT.md` |
| 3 (notices/CSP) | `2022311`, `a727001` | `PRIVACY.md`, `MODEL_CARD.md`, `THIRD_PARTY_LEGAL_NOTICES.md`, `LICENSE_AUDIT.md`, `DEPLOY.md`, `scripts/write-headers.mjs`, `scripts/copy-legal-docs.mjs`, `public/no-dev-server.js`, `vite.config.ts`, `vercel.json`, `index.html`, `PHASE3_REPORT.md` |
| 4 (quality) | `5612c1f` | `eslint.config.js`, `vitest.config.ts`, `src/test-setup.ts`, 7 `*.test.ts`, `scripts/run-browser-tests.mjs`, `package.json`, `PHASE4_REPORT.md` |
| 5 (prep) | `545f23c` | `PHASE5_PLAN.md` |
| 5 (delivery) | this branch | `README.md`, `.env.example`, `PHASE5_REPORT.md` |
| review fixes | this branch | `public/inference-worker.js` (only), `single-inference-worker.test.ts`, `.github/workflows/smoke.yml`, `eval/**`, `scripts/eval/**`, `EVALUATION.md`, `package.json` |

No source file changed in Phase 5. `package.json` now exposes:
`lint`, `test`, `test:watch`, `test:browser`, `verify`, `eval:set`, `eval:run`,
`eval:analyze`.

## Model revision + hashes

Source of truth: `scripts/fetch-models.mjs` (`MODELS[]`), which generates
`public/models-manifest.json` and **verifies each SHA-256 against the Hugging
Face file at build time**. HF Space:
`https://huggingface.co/spaces/Octoborg/remove-photo-bg` (ref `main`), files
under `models/`.

| id | bytes | SHA-256 |
|---|---|---|
| `model_512_int8_fp16` (**default**) | 68,491,168 | `524bd904f68a48c3390bd27ab85d9e8107af0e1b8e79f20197ecdeaad8b17046` |
| `model_512_int0_fp16` | 98,799,684 | `099c89de1d9a3da27af3d5329460f543e5d9390fc45e7ba7d0e7360b378d5f97` |
| `model_512_int0_fp32` | 193,514,682 | `eaafaa10f19c63b77e2bae77bf4b2f59054c208ea08b8c6648f95ef36a3b6b87` |

WASM runtime (committed in `public/wasm/`, CPU-only ORT bundle):

| file | bytes | SHA-256 |
|---|---|---|
| `ort.wasm.min.js` | 50,196 | `f87630372da0668a72b4304e062365117cbe432d6060ca146799b1c1888460ae` |
| `ort-wasm-simd-threaded.mjs` | 24,218 | `5a15f1fd086b3f6c2baf1f35105b8f502653b567e165cef80028870b39748747` |
| `ort-wasm-simd-threaded.wasm` | 13,961,845 | `ec8580a9d7b9476ceee52e10a7f94124e4dc71a019d666ed6d4726697c109a4d` |

`onnxruntime-web` is pinned to **1.29.0**.

## Actual test results (this branch, `f9e1d5b` + Phase 5 + review fixes)

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | clean (0 errors, 0 warnings) |
| Typecheck | `npm run typecheck` | pass (`tsc --noEmit`) |
| Unit tests | `npm run test` | **64/64 pass** (8 files) |
| Build | `npm run build` | pass (`tsc` + `vite build`) |
| Browser tests | `npm run test:browser` | **10/10 pass** |
| CI `static-checks` | GitHub Actions | lint + typecheck + unit + eval-set verify |
| CI `wasm-smoke` | GitHub Actions | browser tests + 4 WASM runs |
| Prod smoke | `run-smoke.mjs` on `vite preview`, CSP active | 960×1280 RGBA, avg **3.61 s** (WASM), 0 CSP violations |
| Evaluation (WASM) | `npm run eval:run` + `eval:analyze` | **64/64 succeeded, 0 wrong dims**, mean 4.1 s, 8 empty outputs |

The extra 4 unit tests are `single-inference-worker.test.ts` (drift guard).

### CI runs around HEAD

The latest commit was verified before this branch:

| SHA | Workflow | Conclusion |
|---|---|---|
| `1b769da` (HEAD) | smoke | success |
| `a5149cd` | smoke | success |
| `2388ce3` | smoke | success |

### Model quality baseline (WASM)

See [`EVALUATION.md`](./EVALUATION.md) for the full table. Summary: 64/64
images succeeded at the correct dimensions on `model_512_int8_fp16`; mean
inference 4097 ms; peak browser RSS 555 MB. The eight empty/near-empty outputs
are the first thing to review — several are dark or low-contrast frames. These
are descriptive edge metrics, not accuracy; there is no ground-truth mask.

Unit tests cover validation boundaries, mask maths, progress formatting,
manifest resolution, the provider gate, asset URLs, the single-inference-worker
drift guard, and a source scan proving MVP §9's "no app-level upload path".
Browser tests cover JPEG/PNG upload → inference → transparent PNG (colour type
6) + white-background JPG, zero third-party requests, unsupported/corrupt input
errors, worker + manifest failure surfacing, and keyboard activation. Details in
`PHASE4_REPORT.md`.

## Limitations

- **No GPU in this build environment.** Every number here is WASM/CPU. Hardware
  (WebGPU) testing is **postponed** until a GPU machine is available; the
  `Copy device report` button and `HARDWARE_TESTING.md` §3 runbook are the path.
  One phone WebGPU run (Adreno-6xx) was *not* faster than WASM and mis-segmented
  the subject — verify on any new device before trusting the GPU path.
- **Latency:** WASM warm inference is ~3.5–5 s/image here and slower on weak
  CPUs. WebGPU is the intended production path where available.
- **No ground-truth masks.** All quality figures are *agreement with the fp32
  teacher*, not accuracy (int8+fp16 IoU@0.5 0.9987, fp16 0.9999 vs the teacher).
- **Distilled model not shipped** — Phase 1 distillation is exploratory; the
  served artifacts are quantised variants of the official `BiRefNet_lite`.
- **512×512 input** softens edges vs the 1024 export (transition band ~2.4 px vs
  ~1.4 px); see `README.md` "Known limitations".

## Deployment steps

**Model assets (Hugging Face).** The model lives in the HF Space
`Octoborg/remove-photo-bg`; `VITE_ASSET_BASE` points at
`https://huggingface.co/spaces/Octoborg/remove-photo-bg/resolve/main/`.

**Application hosting (Vercel).** Deploy the static application through Vercel
Git integration. The build uses `npm run vercel:build`, publishes `dist/`,
prepares the WebGPU runtime, skips model weights, copies legal documents, and
removes `dist/models/`. Set `VITE_ASSET_BASE` in the Vercel project
environment variables. Production response headers are configured in
`vercel.json`.

See [`DEPLOY.md`](./DEPLOY.md) for current deployment instructions.

## Definition of done (MVP §12)

| Item | State | Evidence |
|---|---|---|
| Supported image can be selected/dropped | ✅ | `image-validation.ts`; browser tests 1/2/6 |
| Exact pinned model runs in a tested environment | ✅ | `models-manifest.json` (SHA-256), prod smoke |
| Inference does not freeze the UI | ✅ | Web Worker `public/inference-worker.js` |
| Transparent PNG has real alpha + original dimensions | ✅ | browser test 2 (colour type 6); 960×1280 smoke |
| White-background JPG works | ✅ | browser test 3 |
| Invalid input / unsupported device / model failure / memory failure handled | ✅ | browser tests 6–9; `main.ts` error paths |
| No app-level image upload path | ✅ | `no-upload-path.test.ts` (MVP §9) |
| Privacy + notices present | ✅ | `PRIVACY.md`, `THIRD_PARTY_LEGAL_NOTICES.md`, footer links |

## Reproduce

```sh
npm ci
npm run fetch-models     # local model + WASM for the browser tests
npm run verify           # lint + typecheck + 60 unit tests + build
npm run test:browser     # real-browser flow tests
```
