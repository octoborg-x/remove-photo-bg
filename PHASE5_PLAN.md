# Phase 5 plan — delivery

**Status:** ready to start. Phases 1–4 are DONE (see `PHASE1_REPORT.md` …
`PHASE4_REPORT.md`). Hardware (WebGPU) tests stay postponed until a GPU machine
is available.

Phase 5 (MVP §11) is the delivery/reporting phase: make the repo self-describing
for a new contributor, and record exactly what was built, what was measured, and
what remains. It changes no product behaviour.

## 1. README — install / run / test / build

The README already covers requirements, setup, the smoke test, and deployment.
Close the remaining gaps:

- [ ] One "quick start" block: `npm ci` → `npm run fetch-models` → `npm run dev`,
      with the **browser requirements** (Chromium/Firefox/Safari versions that
      support Web Worker + WASM SIMD threads; WebGPU optional) stated once.
- [ ] Model-download instructions: what `fetch-models` downloads, where it goes
      (`public/models/`), that it is gitignored, and that SHA-256 is verified.
- [ ] Test/build commands are already in the Commands table (`lint`, `test`,
      `test:browser`, `verify`) — link them from the quick start.
- [ ] Point Privacy / Provenance / Notices at `PRIVACY.md`, `MODEL_CARD.md`,
      `THIRD_PARTY_LEGAL_NOTICES.md`, `LICENSE_AUDIT.md`.

## 2. `.env.example` (names only)

Does not exist yet. Add it with **names only, no values, no secret required for
browser-only inference**:

```
# All optional — browser-only inference needs no secret.
# VITE_ASSET_BASE=   # origin serving the model + WASM (blank = this origin)
```

Verify `.env` is gitignored (it is) and that nothing in `src/` reads a secret.

## 3. Delivery report — `PHASE5_REPORT.md`

Record, from real measurements (not estimates):

- [ ] **Changed files** across the whole build, grouped by phase.
- [ ] **Model revision + hash** — the three served artifacts, their bytes and
      SHA-256, and the HF revision (from `scripts/fetch-models.mjs` / the manifest).
- [ ] **Actual test results** — `npm run verify` (lint/typecheck/60 unit/build),
      the 10 browser checks, the CI `wasm-smoke` runs, and the production smoke
      (960×1280 RGBA, avg 3.61 s WASM, 0 CSP violations).
- [ ] **Limitations** — WASM-only latency in this sandbox; hardware/WebGPU
      untested (postponed); no ground-truth masks (all quality numbers are
      agreement-with-teacher); distilled model not shipped.
- [ ] **Deployment steps** — Vercel Git integration + HF asset origin; `VITE_ASSET_BASE` configured
      as a Vercel project environment variable.

## 4. Definition-of-done sweep (MVP §12)

Walk the checklist and mark each item pass/partial with the evidence file:

- [ ] Supported image selected/dropped → `image-validation.ts`, browser test 1/2/6.
- [ ] Pinned model runs in a tested environment → `models-manifest.json` + smoke.
- [ ] Inference does not freeze the UI → Web Worker (`public/inference-worker.js`).
- [ ] Transparent PNG, real alpha, original dimensions → browser test 2, smoke.
- [ ] White-background JPG → browser test 3.
- [ ] Invalid input / unsupported device / model failure / memory failure handled →
      browser tests 6–9 + `main.ts` error paths.
- [ ] No image upload path → `no-upload-path.test.ts` (MVP §9).
- [ ] Privacy + notices present → `PRIVACY.md`, `THIRD_PARTY_LEGAL_NOTICES.md`.

## 5. Branch / push rules

Use a feature branch (`phase5-delivery`). Do **not** force-push or push to
`main`/`staging`/`production` directly. Do not spend money without approval.

## Out of scope

- Hardware/WebGPU testing (postponed — needs a GPU host).
- New product features; Phase 5 is documentation + reporting only.
