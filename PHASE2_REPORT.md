# PHASE2_REPORT — Product workflow (confirmed)

Date: 2026-11-02. Scope: MVP_OPENHANDS.md §11 **Phase 2** (product workflow +
the §11 "Expanded Phase 2 scope" of 2026-10-31). Phase 1 is closed
(`PHASE1_REPORT.md`); this run confirms Phase 2 and prepares Phase 3.

> **Verdict: Phase 2 is DONE and verified in a real browser.** Every Phase 2
> acceptance item below is backed by a command output recorded in this run.
> Nothing here is inferred: the environment has **no GPU / no WebGPU**, so all
> in-browser numbers are the **WASM (CPU)** provider and no WebGPU timing is
> claimed.

## 1. What was verified (and how)

| Check | Command / method | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | **PASS** (`tsc --noEmit`, no output) |
| Production build | `npm run build` | **PASS** — 12 modules, `dist/assets/index-*.js` 23.8 kB (gzip 9.2 kB) |
| Model provenance | `npm run fetch-models` | **PASS** — 3/3 artifacts SHA-256 matched (table §2) |
| Default auto-load | `node scripts/run-smoke.mjs …` | **PASS** — `model_512_int8_fp16` loads with no manual pick |
| Model selector | `?model=model_512_int0_fp16` | **PASS** — requested model loads and reports its id |
| Provider selector | DOM inspection | **PASS** — WASM offered; GPU correctly withheld (no adapter) |
| Warm inference | smoke harness, 3 runs | **PASS** — avg **3492.7 ms** (animal-buddy-dog, 960×1260) |
| Transparent PNG | IHDR parse of `output.png` | **PASS** — real RGBA (`colorType=6`), original dimensions |
| White-bg JPG export | DOM inspection | **PASS** — `data:image/jpeg` link shown after a run |
| Upload validation | browser drop of bad inputs | **PASS** — wrong MIME + 21 MB rejected with actionable text |
| Persistence | two navigations, SW store events | **PASS** — stored on visit 1, cache-served on visit 2 |
| No pixels off-device | `requests.json` | **PASS** — 16 requests, all first-party, 0 third-party |

## 2. Model provenance (Phase 2 artifacts)

All three artifacts are served from the `Octoborg/remove-photo-bg` Hugging Face
Space (`…/resolve/main/models/<file>`), verified by `scripts/fetch-models.mjs`
against the pinned SHA-256. The manifest (`public/models-manifest.json`) is the
single source of truth for the selector, the service worker buckets, and the
harness.

| id | file | size (bytes) | SHA-256 | default |
|---|---|---|---|---|
| `model_512_int8_fp16` | `models/model_512_int8_fp16.onnx` | 68,491,168 | `524bd904f68a48c3390bd27ab85d9e8107af0e1b8e79f20197ecdeaad8b17046` | **yes** |
| `model_512_int0_fp16` | `models/model_512_int0_fp16.onnx` | 98,799,684 | `099c89de1d9a3da27af3d5329460f543e5d9390fc45e7ba7d0e7360b378d5f97` | no |
| `model_512_int0_fp32` | `models/model_512_int0_fp32.onnx` | 193,514,682 | `eaafaa10f19c63b77e2bae77bf4b2f59054c208ea08b8c6648f95ef36a3b6b87` | no |

All three: input `input_image` `[1,3,512,512]` float32 NCHW; output
`output_image` `[1,1,512,512]` probabilities in `[0,1]` (sigmoid baked in —
`outputIsProbability: true`). They are weight-only quantisations of the same
BiRefNet_lite 512 fp32 teacher (MIT), materialised to fp32 compute, so the
runtime kernels are unchanged. Measured parity and the `c5_best` lineage are in
`.openhands/memory` and `PHASE1_REPORT.md` §7.

## 3. Measured browser results (headless Chromium, WASM, no GPU)

Environment: Chromium 155, software rendering, `--disable-gpu --disable-webgpu`,
cross-origin isolated (`SharedArrayBuffer` present). These are CPU-only numbers
and an upper bound for the WASM path.

| Measurement | Value |
|---|---|
| Default model auto-load | `model_512_int8_fp16` (65.3 MB), no manual step |
| Model load (first visit, incl. SW store) | ≈ 2043 ms |
| Model load (second visit, cache-served) | ≈ 1257 ms |
| Warm inference, 3 runs (animal-buddy-dog 960×1260) | 3655.6 / 3340.7 / 3481.8 ms — avg **3492.7 ms** |
| Warm inference (glass-wine 960×1280, 1 run) | 3701.6 ms |
| Warm inference (`model_512_int0_fp16`, product-scent-bottle, 1 run) | 3620.9 ms |
| Output PNG | real RGBA, original dimensions (960×1260 / 960×1280) |
| Third-party network requests | **0** |

The `measuresIndex` (harness reliability score) was **75** on the 3-run sample
(rewards run count, penalises spread).

## 4. Phase 2 acceptance items (MVP §11 + §12)

- [x] Supported image selected/dropped (file picker **and** drop zone).
- [x] Pinned model runs in the browser on the tested environment (WASM).
- [x] Inference does not freeze the UI (runs in a Web Worker).
- [x] Transparent PNG has real alpha and original dimensions.
- [x] White-background JPG works.
- [x] Model selector lists all served models; runtime selector offers GPU only
      when `navigator.gpu` + adapter exist, else CPU; choice persisted.
- [x] Default model + provider auto-detected and **auto-loaded** on page start.
- [x] Invalid input (wrong MIME, oversized) and model-load failure are handled
      with actionable messages; OOM guidance is provider-aware.
- [x] No image pixels leave the device (16 first-party requests, 0 third-party).
- [x] Model revision, artifact hash, licence source recorded (§2).

## 5. Gap closed in this run

MVP §6/§12 require upload **validation** (JPEG/PNG/WebP, 20 MB, 4096 px longest
side, MIME/decode checked — never the extension) and drag-and-drop. These were
absent from the Phase 2 build, so they were added:

- `src/features/background-removal/image-validation.ts` — type/size check before
  decode, dimension check after, `DEFAULT_UPLOAD_LIMITS` (20 MB / 4096 px).
- `index.html` — a keyboard-operable drop zone (`role=button`, `tabindex`, Enter/
  Space), disclosed limits, focus-visible styles, reduced-motion guard.
- `src/main.ts` — drag/drop handlers, validation wired into `loadImageFromFile`,
  and the filename removed from the log (MVP §8: no filenames/EXIF in logs).

Verified in the browser: `text/plain` → "Unsupported file type"; 21 MB →
"over the 20 MB limit"; a valid 1×1 PNG → "Image ready". No filenames appear in
the log.

## 6. Hardware tests — postponed (per instruction)

Phase 1 left one open requirement: **WebGPU latency and correctness on real
hardware** (`PHASE1_REPORT.md` §9). The only real-device data point is the
Android/Adreno-6xx phone (`HARDWARE_TESTING.md` §4), where WebGPU was not faster
and mis-segmented the subject while WASM was clean. This sandbox still has no
GPU, so WebGPU remains **unmeasured here** and is not claimed.

Per the instruction for this run, the hardware tests are **postponed until
hardware is available**. The device-report button (`Copy device report`) and the
runbook in `HARDWARE_TESTING.md` §3 remain the path to close that item when a
machine with a GPU is available.

## 7. Ready for Phase 3 (notices/privacy)

Phase 2 stops here. Phase 3 is **Notices/privacy** (MVP §11): finalise
`MODEL_CARD.md`, `THIRD_PARTY_LEGAL_NOTICES.md`, `PRIVACY.md` from verified
sources, add footer links and a restrictive CSP, run the repeatable dependency +
model licence audit into `LICENSE_AUDIT.md`, and preserve required notices
without claiming every training-data question is resolved.

Draft Phase 3 task list (see `PHASE3_PLAN.md`):

1. Licence audit tooling (`license-checker-rseidelsohn` for npm, `pip-licenses`
   only if Python components exist) → `LICENSE_AUDIT.md`.
2. Refresh `THIRD_PARTY_LEGAL_NOTICES.md` for the three quantised models and the
   pinned onnxruntime-web WASM artifacts.
3. Update `MODEL_CARD.md` to the shipped default (`model_512_int8_fp16`).
4. Update `PRIVACY.md` (per-model cache buckets, drop-zone/validation, no
   filenames logged) and add footer links to Privacy + Third-party notices.
5. Add a CSP to the host header config and to `vite.config.ts` dev headers,
   after testing the actual runtime requirements.

## 8. Files changed in this run

- `PHASE2_REPORT.md` (new), `PHASE3_PLAN.md` (new)
- `src/features/background-removal/image-validation.ts` (new)
- `src/main.ts`, `index.html` (validation + drop zone)
- `docs/screenshots/phase2-ui.png` (evidence)
