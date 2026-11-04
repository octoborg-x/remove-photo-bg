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
- **`.env.example`** — names only, **no secret required for browser-only
  inference**. The single optional variable is `VITE_ASSET_BASE` (asset origin);
  blank means same-origin.
- **`PHASE5_REPORT.md`** — this file.
- **Definition-of-done sweep** — below (MVP §12).

## Changed files (whole build)

| Phase | Commit(s) | Key files |
|---|---|---|
| 2 (confirm) | `280ae1f` | `src/features/background-removal/image-validation.ts`, `src/main.ts`, `index.html`, `PHASE2_REPORT.md` |
| 3 (notices/CSP) | `2022311`, `a727001` | `PRIVACY.md`, `MODEL_CARD.md`, `THIRD_PARTY_LEGAL_NOTICES.md`, `LICENSE_AUDIT.md`, `DEPLOY.md`, `scripts/write-headers.mjs`, `scripts/copy-legal-docs.mjs`, `public/no-dev-server.js`, `vite.config.ts`, `vercel.json`, `index.html`, `PHASE3_REPORT.md` |
| 4 (quality) | `5612c1f` | `eslint.config.js`, `vitest.config.ts`, `src/test-setup.ts`, 7 `*.test.ts`, `scripts/run-browser-tests.mjs`, `package.json`, `PHASE4_REPORT.md` |
| 5 (prep) | `545f23c` | `PHASE5_PLAN.md` |
| 5 (delivery) | this branch | `README.md`, `.env.example`, `PHASE5_REPORT.md` |

No source file changed in Phase 5. `package.json` (from Phase 4) now exposes:
`lint`, `test`, `test:watch`, `test:browser`, `verify`.

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

## Actual test results (this branch, `f9e1d5b` + Phase 5)

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | clean (0 errors, 0 warnings) |
| Typecheck | `npm run typecheck` | pass (`tsc --noEmit`) |
| Unit tests | `npm run test` | **60/60 pass** (7 files) |
| Build | `npm run build` | pass (`tsc` + `vite build`) |
| Browser tests | `npm run test:browser` | **10/10 pass** |
| CI smoke | GitHub Actions `wasm-smoke` | pass (4 WASM runs, ~4 min) |
| Prod smoke | `run-smoke.mjs` on `vite preview`, CSP active | 960×1280 RGBA, avg **3.61 s** (WASM), 0 CSP violations |

Unit tests cover validation boundaries, mask maths, progress formatting,
manifest resolution, the provider gate, asset URLs, and a source scan proving
MVP §9's "no app-level upload path". Browser tests cover JPEG/PNG upload →
inference → transparent PNG (colour type 6) + white-background JPG, zero
third-party requests, unsupported/corrupt input errors, worker + manifest
failure surfacing, and keyboard activation. Details in `PHASE4_REPORT.md`.

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
