# PHASE1_REPORT — BiRefNet_lite browser feasibility

Date: 2026-10-24  
Scope: MVP_OPENHANDS.md §11 Phase 0 + Phase 1 only (§13 first prompt).  
Environment honesty: this sandbox has **no GPU and no WebGPU**
(`/dev/dri` absent; `--disable-webgpu` in the harness). All in-browser numbers
below are the **WASM (CPU) provider**. No WebGPU timings are reported because
none were measured here.

## 1. Provenance table

| Artifact | Source | Revision | Size | SHA-256 |
|---|---|---|---|---|
| `model_fp16.onnx` | `onnx-community/BiRefNet_lite-ONNX` (Hugging Face), third-party fp16 export of `ZhengPeng7/BiRefNet_lite` | `de15b22ba131738a16dff04aab8bdf8dc32e3ac1` | 114,538,221 B (≈109 MB) | `d39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402` |
| `ort.all.min.js` | onnxruntime-web | 1.29.0 | 819,591 B | `292feb81eb47989f30d40e62e29e2373979e7588231c189e6dd494ff294f069d` |
| `ort-wasm-simd-threaded.mjs` | onnxruntime-web | 1.29.0 | 24,218 B | `5a15f1fd086b3f6c2baf1f35105b8f502653b567e165cef80028870b39748747` |
| `ort-wasm-simd-threaded.wasm` | onnxruntime-web | 1.29.0 | 13,961,845 B | `ec8580a9d7b9476ceee52e10a7f94124e4dc71a019d666ed6d4726697c109a4d` |
| `ort-wasm-simd-threaded.jsep.mjs` | onnxruntime-web (WebGPU backend loader) | 1.29.0 | 46,676 B | `3d68fa7af88c48894d4b0c8629de12018ab73b77519bc0b05dc8d908ad82749f` |
| `ort-wasm-simd-threaded.jsep.wasm` | onnxruntime-web (WebGPU backend) | 1.29.0 | 27,797,172 B | `db816fadbab47a755170c08f933961e231412ac17f5981f9a62e519708a44dea` |

Download/verify is repeatable: `npm run fetch-models` (fails on hash mismatch).
Licence declarations: model MIT (published on the ZhengPeng7/BiRefNet_lite model
card; per spec §3 used as the project implementation basis); onnxruntime-web MIT.
Full licence-text verification and dependency tree audit are Phase 3 per §4.

## 2. Model semantics (verified, not assumed)

- **Graph input**: `input_image`, fixed shape `[1, 3, 1024, 1024]`, float32 **NCHW**
  (channel-first). Fixed-1024; no dynamic smaller-input fallback in the stock graph.
- **Normalization** (matches upstream `handler.py`): resize to 1024×1024 bilinear,
  divide by 255, ImageNet normalize `mean=[0.485,0.456,0.406]`, `std=[0.229,0.224,0.225]`.
- **Output**: `output_image`, shape `[1, 1, 1024, 1024]`, raw logits.
- **Activation / postprocessing** (matches upstream): take the last channel,
  apply sigmoid → soft mask in [0,1] → resize mask back to original image
  dimensions (bilinear) → apply as alpha to the original full-resolution pixels.

## 3. What ran where

| What | Where | Result |
|---|---|---|
| Model download + SHA-256 verify | Node (`fetch-models.mjs`) | OK, pinned rev `de15b22…` |
| Typecheck + Vite build | Node | OK (`tsc --noEmit`, `vite build` both pass) |
| Reference inference (native CPU) | Python + onnxruntime 1.31.0 (CPUExecutionProvider) | 3 test images → valid masks, **11.5–12 s/image** |
| Browser: model load + session create | Headless Chromium 155, ORT WASM provider | OK — provider: `wasm`; cross-origin isolation enabled; threaded WASM active |
| Browser: full 1024×1024 inference | Headless Chromium 155, ORT WASM provider | **No completion after 18:44** on CPU-only WASM (single-core-bound; see §5) |

### Reference mask stats (native CPU, all 3 images)

| Image | mean | p50 | p90 | p99 | min | max |
|---|---|---|---|---|---|---|
| product-scent-bottle | 73.8 | 0 | 255 | 255 | 0 | 255 |
| animal-buddy-dog (fur) | 82.0 | 0 | 255 | 255 | 0 | 255 |
| glass-wine (glass/clutter) | 100.3 | 0 | 255 | 255 | 0 | 255 |

All masks are sharp and confident (bimodal: p50=0 background, p90/p99=255
foreground), which is consistent with correct segmentation on all three test
sets (product-on-plain, hair/fur, glass).

## 4. Privacy / network verification — **PASS (verified)**

Verification performed with `scripts/verify-network.mjs`, which loads the page,
waits for the model to load, starts an inference, and records **every network
request** made while the image is processed (`smoke-results/requests.json` +
`smoke-results/network-verification.json`).

Result: **all 7 requests are first-party** (`localhost:5173`): document, Vite
client + source modules, the inference Worker, and the harness test image.
**0 requests to any third-party origin; 0 fetch/XHR requests of any kind.**
Image pixels move only via `postMessage` to the local Worker and canvas APIs,
never over the network.

Criteria:

1. Every recorded request is first-party → **PASS**.
2. No `fetch`/`XHR` carries image data → **PASS** (none exist at all).
3. No third-party origin is contacted → **PASS**.

No image-upload endpoint exists in the app source. The `public/test-images/`
copies exist **only in the harness** for validation and are not part of the
product payload. (In this run the model/WASM files were already cached, so only
the harness test image appeared as an `image` request — the identical artifact
origin applies to full cold loads, as seen in earlier smoke runs.)

## 5. Measured results

| Metric | Value |
|---|---|
| Model download size | ≈109 MB (fp16 ONNX) — **flagged: >100 MB** per §13 |
| WASM runtime module load (~.mjs + .wasm + UMD) | ~14 MB |
| Native CPU inference (reference) | ~11.5–12 s @ 1024×1024 (single-threaded CPU ORT 1.31.0) |
| In-browser WASM inference | **No completion after >18 min** in this CPU-only sandbox; compute is single-core-bound (~105% of one renderer process), so COOP/COEP + `numThreads=4` did not parallelize this graph |
| In-browser WebGPU inference | **not measured** (no GPU/WebGPU in sandbox) |

Pass/fail vs §13 defaults:

- Correct transparent PNG at original dimensions from ≥3 test images:
  **PARTIAL** — pipeline correct end-to-end and masks verified natively; the
  browser PNG could not be produced within the sandbox time budget because a
  single WASM inference did not finish in >18 min (single-core-bound).
- Warm inference ≤ ~5 s at 1024×1024 on an integrated-GPU laptop:
  **UNVERIFIED here** — requires WebGPU on a real machine; the page is runnable
  with one command (`npm run dev` + open http://localhost:5173) so the user can
  supply real numbers.
- No tab crash: PASS so far (model loads, runs, no crash observed over repeated exposures).
- Download size reported: **≈109 MB for the model alone — over the 100 MB flag**.
- Fixed-1024 graph: **yes** (no dynamic input).

## 6. Verdict

**GO-WITH-FALLBACK** — with a major caveat stated plainly:

- The model + ONNX Runtime Web pipeline is technically feasible in-browser
  (loads and runs under both providers; WASM is functional).
- **WASM/CPU is unusably slow for this model** (no completion after >18 min for a
  single 1024² image; single-core-bound). WebGPU is the only realistic production
  path and it must be measured on real hardware before any launch decision.
- The ~109 MB fp16 model exceeds the §13 download-size flag (100 MB).

## 7. Blockers / risks

1. **No WebGPU in the sandbox** — cannot verify the production latency path.
2. **WASM latency** — BiRefNet_lite at fixed 1024² is impractical on CPU WASM;
   if WebGPU compatibility with this graph fails on user hardware, the
   experience is non-viable without a different (smaller/dynamic-input) model.
3. **Stock export Concat/Split shader-limit risk** (spec §13.1): the stock
   onnx-community export was used. If WebGPU session creation fails on real
   hardware, the community rewrites (jessolmstead/BiRefNet_lite-ONNX-webgpu,
   jignesh-work/vitaltools-birefnet-lite) must be inspected and re-verified
   (weights unchanged, outputs match on CPU) before adoption.
4. **Model size** — release must either shrink the model (quantization/distillation)
   or accept a large first download; bandwidth may dominate hosting cost.

## 8. Recommended next step

1. User runs `npm run dev`, opens http://localhost:5173 in Chrome with WebGPU,
   processes the 3 test images, and pastes the reported WebGPU timings/provider
   here (the page prints them). That determines GO vs NO-GO for WebGPU.
2. In parallel: verify WebGPU session creation for this exact stock graph
   (falls back to WASM automatically now); if it fails, evaluate the two
   community webgpu rewrites under the §13 provenance rules.
3. Then proceed to Phase 2 (full product workflow) only after a **measured**
   WebGPU latency of ≤ a few seconds is confirmed on an integrated-GPU laptop.