# Phase 4 report — quality

**Date:** 2026-11-02
**Status:** ✅ DONE — lint, typecheck, unit tests, browser tests, and the
production build all pass; a real model smoke test renders a correct RGBA PNG.
**Budget spent:** $0.

Phase 4 (MVP §11) adds the missing quality infrastructure the earlier phases did
not have (there was no linter or test runner) and runs it end to end. It changes
no product behaviour except removing dead code the linter found.

## What was added

| Tool | Config | Scope |
|---|---|---|
| ESLint 9 (flat config) | `eslint.config.js` | `src/`, `scripts/`, `public/`, config files |
| Vitest 2 | `vitest.config.ts` + `src/test-setup.ts` | pure logic unit tests |
| puppeteer-core flow runner | `scripts/run-browser-tests.mjs` | real browser end-to-end |
| `npm run verify` | `package.json` | lint + typecheck + unit + build |

New devDependencies: `vitest`, `eslint`, `@eslint/js`, `typescript-eslint`,
`globals`, `@types/node`.

## Unit tests — 60 across 7 files (`npm run test`)

| File | Covers (MVP §9) |
|---|---|
| `image-validation.test.ts` (12) | MIME allow-list, empty file, size cap boundary (exact / +1 byte), custom limits, dimension cap, non-finite dims, `formatLimitBytes` |
| `mask-postprocess.test.ts` (16) | `probabilityToMask` clamp, `upscaleMask` constant/ramp/non-integer scale, threshold binarisation, feather (constant field, threshold-before-feather), `isMaskAdjust` rejection cases, `applyMaskToImage` alpha compositing + no input mutation |
| `load-progress.test.ts` (8) | `formatBytes`/`formatElapsed`, percent clamping, cache-hit wording, every stage labelled |
| `model-manifest.test.ts` (8) | `defaultModelId` (flag / fallback / empty), `resolveModelParam` by id, by file leaf, trimmed, unknown |
| `provider-gate.test.ts` (6) | `isProviderChoice`, `detectWebGpu` (no `navigator.gpu`, null adapter, named adapter, throwing adapter) |
| `asset-cache.test.ts` (3) | `ASSET_BASE` stays `''` when unset, `assetUrl` same-origin path + slash stripping |
| `no-upload-path.test.ts` (7) | **MVP §9 "no app-level upload path":** scans shipped source for `XMLHttpRequest`, `sendBeacon`, `POST/PUT/PATCH`, `FormData`, `fetch(… body:)`, and `/api/` URLs — all must be absent |

`Node 24` provides `File`/`Blob` but not `ImageData`; `src/test-setup.ts`
polyfills `ImageData` for the compositing tests. The `File` stub in the
validation tests is a plain `{type, size}` object (the function reads only those
two fields), so the 20 MB cap boundary is tested without allocating 20 MB.

## Browser tests — 10 checks (`npm run test:browser`)

Runs a real Chromium (headless shell, CPU/WASM) against a dev server it starts
itself, generating its own PNG fixtures (no committed binaries). Measured
results:

| Check | Result |
|---|---|
| JPEG upload → transparent PNG rendered | ✅ `smoke-960x1280.png` |
| PNG export has an alpha channel | ✅ colour type **6** (truecolour+alpha) |
| JPG export offered as white-background JPEG | ✅ `smoke-960x1280.jpg` |
| No third-party requests during processing | ✅ 0 |
| PNG upload → transparent PNG rendered | ✅ |
| Unsupported file type shows an error, no output | ✅ |
| Corrupt image shows a decode error, no output | ✅ |
| Worker startup failure surfaces an error in the UI | ✅ (aborted `/inference-worker.js`) |
| Manifest load failure surfaces an error in the UI | ✅ (aborted `/models-manifest.json`) |
| Drop zone is keyboard-activatable (Enter opens chooser) | ✅ |

Note on failure injection: the model fetch runs inside the inference worker /
service worker, so page-level request interception cannot reach it (confirmed in
Phase 2). The two failures tested here are the page-level ones (worker script and
manifest), which prove a failure reaches the UI rather than hanging silently.

## Lint findings fixed (not suppressed)

- `src/features/background-removal/mask-postprocess.ts` — removed an unused
  `MODEL_SIZE` import.
- `src/features/background-removal/model.worker.ts` — removed the dead
  `webgpuAvailable()` / `adapterSubstrings()` helpers (unreferenced).
- `scripts/copy-legal-docs.mjs` — removed an unused `mkdirSync` import.

The remaining ESLint configuration choices are deliberate and documented in
`eslint.config.js`: `no-empty` allows empty catch blocks (best-effort storage /
cleanup throughout), and the TypeScript files use the TS-aware
`no-unused-vars` while the `.mjs`/`.js` files use the base rule (the base rule
mis-reports names in type-only positions).

## Full pass (`npm run verify`)

```
npm run lint       → clean (0 errors, 0 warnings)
npm run typecheck  → pass (tsc --noEmit)
npm run test       → 60/60 pass
npm run build      → pass (tsc + vite build, dist/ 23.77 kB JS + assets)
```

## Real manual model smoke test

Production build served with `vite preview`, driven by
`scripts/run-smoke.mjs` under the Phase 3 CSP:

- Model: `model_512_int8_fp16`, provider `wasm`.
- Output: real **RGBA** PNG at the original dimensions, non-uniform alpha.
- Warm inference ≈ **3.9 s** (CPU/WASM, this sandbox).
- **0** CSP violations.

## Not done (deferred, as scoped)

- **Hardware/WebGPU tests** — postponed until a GPU machine is available (no GPU
  in this sandbox; all numbers are WASM/CPU).
- **Phase 5 (delivery/report)** — the remaining MVP phase.

## Reproduce

```sh
npm ci
npm run fetch-models     # local model + WASM for the browser tests
npm run verify           # lint + typecheck + unit + build
npm run test:browser     # real-browser flow tests
```
