# Landing-page facts

Every factual claim on the single-page app (`index.html`) is tied to evidence in
this repository. Numbers are from the repo's own harnesses; nothing on the page
is estimated or borrowed from another product. Re-check this file whenever a
figure on the page changes.

| Page claim | Value | Source |
|---|---|---|
| Model name "QMix Cut-512" (id `qmix-cut-512`) | Product name for the optimised BiRefNet Lite export; not a new architecture | `MODEL_CARD.md` ("Product name vs architecture"), `public/models-manifest.json` |
| Model download size | ~58 MB (60,763,193 B) | `public/models-manifest.json`, `MODEL_CARD.md` |
| One model served, quality equal to the larger variants | int8+fp16 vs fp32 teacher: IoU@0.5 0.9987, 0 pixels crossing the 0.5 threshold | `MODEL_CARD.md` ("Measured parity…") |
| Inference ~4 s per image (CPU/WASM) | 3.6–4.0 s warm on a desktop CPU; ~6.9 s on a phone | `PHASE2_REPORT.md`, `README.md`, `HARDWARE_TESTING.md` §4 |
| Works without a GPU; older/software GPUs default to CPU but stay selectable | `classifyGpuAdapter()` flags software renderers and known-slow GPUs, which become the non-default option and warn when chosen; verified in-browser | `src/features/background-removal/provider-gate.ts`, this change |
| 64-image evaluation, all exported, no crash | 64 images / 8 categories, 64 ok | `EVALUATION.md` |
| 8 of 64 outputs empty | 8 / 64 empty or near-empty | `EVALUATION.md` |
| No image upload; restrictive CSP; SHA-256-pinned model | 0 third-party requests in the smoke harness; CSP in `scripts/write-headers.mjs`; SHA-256 in the manifest | `PHASE2_REPORT.md`, `PHASE3_REPORT.md`, `scripts/run-smoke.mjs` |
| Input limits 20 MB / 4096 px; PNG·JPG·WebP output | `DEFAULT_UPLOAD_LIMITS`, `EXPORT_FORMATS` | `src/features/background-removal/image-validation.ts`, `src/features/background-removal/export-image.ts` |

## Demo images

The before/after pairs under `public/demo/` are the model's own outputs, not
mock-ups:

- `before` = the original test photo (public domain) under `test-images/`.
- `after` = the model's committed cut-out under
  `smoke-results/benchmark-t4/quality-t4/*_512_cut.png` (RGBA), downscaled and
  re-encoded to WebP by `scripts/build-demo-assets.mjs`.

## Model provenance note

`npm run fetch-models` pins `model_512_int8_fp16.onnx` at **60,763,193 B /
`10f1cf12…12bc26`**, which is exactly the file the `Octoborg/remove-photo-bg`
Hugging Face Space serves — verified by a full download (SHA-256 match). This
pin is the value introduced by **PR #67** ("Shrink shipped ONNX artifacts
losslessly and re-pin them"), which is still **open/unmerged** at the time of
writing. The earlier mismatch was simply that `main` still carried the
pre-#67 pin (`524bd904…b17046`, 68,491,168 B) while the Space already served the
smaller artifact. `main` needs PR #67 merged (or an equivalent pin commit) to
carry the same hash; this branch does.

PR #67 also carries `OPTIMIZATION_REPORT.md` and the `scripts/distill/*` parity
tooling that the caveat below refers to; merge it to keep the docs' links live.
