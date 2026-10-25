# PHASE1_REPORT — BiRefNet_lite browser feasibility

Revision 2 — 2026-10-25.  
Revision 1 — 2026-10-24 (original feasibility run).

Scope: MVP_OPENHANDS.md §11 Phase 0 + Phase 1 only (§13 first prompt).

> **Revision 2 changes the verdict.** Revision 1 measured the 1024×1024 fp16
> export and concluded that WASM was unusable and WebGPU the only viable path.
> The shipped model is now a 512×512 fp32 export, which invalidates that
> conclusion: WASM completes in seconds, and the quality cost is measurable but
> small. Revision 1 numbers are retained where they are the only evidence
> available (WebGPU), and marked superseded elsewhere.

Environment honesty: this sandbox has **no GPU and no WebGPU** (`/dev/dri`
absent; `--disable-webgpu` in the harness). All in-browser numbers below are the
**WASM (CPU) provider** in headless Chromium 155 with software rendering. No
WebGPU timings are reported because none were measured here. Section 9 lists
exactly what must still be measured on real hardware.

## 1. Provenance table

Shipped model:

| Artifact | Source | Size | SHA-256 |
|---|---|---|---|
| `model_512.onnx` | 512×512 fp32 export; derived from `ZhengPeng7/BiRefNet_lite` (MIT) | 193,514,682 B (≈185 MB) | `eaafaa10f19c63b77e2bae77bf4b2f59054c208ea08b8c6648f95ef36a3b6b87` |

Superseded (revision 1):

| Artifact | Source | Revision | Size | SHA-256 |
|---|---|---|---|---|
| `model_fp16.onnx` | `onnx-community/BiRefNet_lite-ONNX` (Hugging Face), third-party fp16 export of `ZhengPeng7/BiRefNet_lite` | `de15b22ba131738a16dff04aab8bdf8dc32e3ac1` | 114,538,221 B (≈109 MB) | `d39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402` |

Runtime (unchanged from revision 1, re-verified):

| Artifact | Source | Revision | Size | SHA-256 |
|---|---|---|---|---|
| `ort.all.min.js` | onnxruntime-web | 1.29.0 | 819,591 B | `292feb81eb47989f30d40e62e29e2373979e7588231c189e6dd494ff294f069d` |
| `ort-wasm-simd-threaded.mjs` | onnxruntime-web | 1.29.0 | 24,218 B | `5a15f1fd086b3f6c2baf1f35105b8f502653b567e165cef80028870b39748747` |
| `ort-wasm-simd-threaded.wasm` | onnxruntime-web | 1.29.0 | 13,961,845 B | `ec8580a9d7b9476ceee52e10a7f94124e4dc71a019d666ed6d4726697c109a4d` |
| `ort-wasm-simd-threaded.jsep.mjs` | onnxruntime-web (WebGPU backend loader) | 1.29.0 | 46,676 B | `3d68fa7af88c48894d4b0c8629de12018ab73b77519bc0b05dc8d908ad82749f` |
| `ort-wasm-simd-threaded.jsep.wasm` | onnxruntime-web (WebGPU backend) | 1.29.0 | 27,797,172 B | `db816fadbab47a755170c08f933961e231412ac17f5981f9a62e519708a44dea` |

Download/verify is repeatable: `npm run fetch-models` (fails on hash mismatch).
Verified from a clean cache: all artifacts downloaded and all hashes matched.

**Provenance verification of the shipped model.** The 512 export comes from a
personal account rather than a known org, so it was not accepted on trust:

- All **379 backbone tensors are bit-identical** to upstream
  `ZhengPeng7/BiRefNet_lite`.
- The **36 differing decoder convs** are the upstream weights with BatchNorm
  folded in. Recomputing the fold from upstream weights reproduces them to
  ~1e-7.
- No unexpected tensors, no shape changes beyond the input/resize constants.

Licence declarations: model MIT (`ZhengPeng7/BiRefNet_lite` model card; per spec
§3 the project implementation basis); onnxruntime-web MIT. Full licence-text
verification and dependency-tree audit are Phase 3 per §4.

## 2. Model semantics (verified, not assumed)

Revision 2 — the shipped 512 graph:

- **Graph input**: `input_image`, fixed shape `[1, 3, 512, 512]`, float32
  **NCHW** (channel-first). Fixed-512; the input size is baked into
  `Split`/`Resize` constants, so the graph cannot be fed other sizes.
- **Normalization** (matches upstream `handler.py`): resize to 512×512 bilinear,
  divide by 255, ImageNet normalize `mean=[0.485,0.456,0.406]`,
  `std=[0.229,0.224,0.225]`.
- **Output**: `output_image`, shape `[1, 1, 512, 512]`, **probabilities in
  [0,1] — sigmoid is baked into the graph**, unlike revision 1 where it was
  applied client-side.
- **Activation / postprocessing**: take the last channel (already a soft mask) →
  resize mask back to original image dimensions (bilinear) → apply as alpha to
  the original full-resolution pixels.

> **Regression hazard.** Applying sigmoid to this graph again silently produces
> an all-opaque mask (probabilities squashed to ≈[0.5,0.73]). The worker
> therefore normalises to [0,1] and declares the contract via `set-model` rather
> than assuming it, so swapping the artifact cannot reintroduce the bug
> silently.

## 3. What ran where

Revision 2:

| What | Where | Result |
|---|---|---|
| Model download + SHA-256 verify | Node (`fetch-models.mjs`) | OK, hash matched from clean cache |
| Typecheck + Vite build | Node | OK (`tsc --noEmit`, `vite build`; dist 8.67 kB JS) |
| Reference inference (native CPU) | Python + onnxruntime 1.31.0 (CPUExecutionProvider) | 3 test images → valid masks, **2.2–2.6 s/image** |
| Browser: model load + session create | Headless Chromium 155, ORT WASM provider | OK — provider `wasm`; cross-origin isolation enabled; threaded WASM active |
| Browser: full 512×512 inference | Headless Chromium 155, ORT WASM provider | **Completes** — 5/5 warm inferences on all 3 test images |
| Browser: peak memory | Headless Chromium 155, external RSS sampling | **2206 MB peak** (1266 MB above an idle-Chromium baseline) |
| Privacy / network | `scripts/verify-network.mjs` | PASS — 9 requests, all first-party, 0 fetch/XHR |

Superseded (revision 1): browser inference did not complete after >18 min on the
1024 fp16 export, and the browser PNG could not be produced in the time budget.

### Reference mask stats (native CPU, 3 images)

Revision 2 (512 fp32):

| Image | mean | p50 | p90 | p99 | min | max |
|---|---|---|---|---|---|---|
| product-scent-bottle | 73.4 | 0 | 255 | 255 | 0 | 255 |
| animal-buddy-dog (fur) | 81.8 | 0 | 255 | 255 | 0 | 255 |
| glass-wine (glass/clutter) | 100.2 | 0 | 255 | 255 | 0 | 255 |

Revision 1 (1024 fp16) reported 73.8 / 82.0 / 100.3 for the same three images —
a difference of ≤0.4/255 in mean mask level.

## 4. Privacy / network verification — **PASS (verified, revision 2)**

Verification performed with `scripts/verify-network.mjs`, which loads the page,
waits for the model to load, starts an inference, and records **every network
request** made while the image is processed
(`smoke-results/requests.json` + `smoke-results/network-verification.json`).

Result: **all 9 requests are first-party** (`localhost:5173`): document, Vite
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
product payload.

## 5. Measured results (revision 2)

| Metric | Value |
|---|---|
| Model download size | **≈185 MB** (fp32 ONNX) — **flagged: >100 MB** per §13 |
| WASM runtime module load (`.mjs` + `.wasm` + UMD) | ~14 MB |
| Native CPU inference (reference) | **2.2–2.6 s** @ 512×512 |
| In-browser WASM inference (warm) | **3.3–5.7 s** per image; 5/5 warm runs succeeded |
| In-browser peak memory | **2206 MB total RSS**, 1266 MB above idle-Chromium baseline |
| In-browser WebGPU inference | **not measured** (no GPU/WebGPU in sandbox) |

Warm-inference detail (headless, software rendering, glass-wine 1280×960):

```
Inference 1: 5731.9 ms   (cold, includes graph upload/warmup)
Inference 2: 4444.9 ms
Inference 3: 4556.4 ms
Inference 4: 4464.0 ms
Inference 5: 4644.3 ms
```

These are software-rendering WASM numbers on a 4-core sandbox and should be
treated as an upper bound for CPU-only devices.

### Where the memory goes, and why 512 is the fix

Cap-constrained runs made the 1024 failure mechanism explicit. Under a 6 GB
virtual-memory cap the 1024 graph failed inside the decoder:

```
BFCArena::AllocateRawInternal ... Failed to allocate memory for
requested buffer of size 822083584
```

A single **822 MB contiguous** activation buffer for one node. That is the
`std::bad_alloc` users hit: ORT asks the WASM heap for one 822 MB block, the
allocation fails, and `OrtRun()` returns `ERROR_CODE: 6`. Shrinking the input
grid by 4× shrinks every activation by 4×; the largest request drops to roughly
206 MB, which fits comfortably.

Pass/fail vs §13 defaults:

- Correct transparent PNG at original dimensions from ≥3 test images:
  **PASS** — all three test classes produce clean cutouts (product-on-plain,
  hair/fur, glass/clutter).
- Warm inference ≤ ~5 s at the target resolution on an integrated-GPU laptop:
  **PASS on WASM software rendering** at 4.4–4.6 s warm. The original criterion
  was written for 1024×1024 on WebGPU; this is the CPU-only upper bound, not the
  expected user experience on capable hardware.
- No tab crash: **PASS** — no crash over repeated runs.
- Download size reported: **≈185 MB for the model alone — over the 100 MB
  flag**.
- Fixed-size graph: **yes** (512×512, no dynamic input).

## 6. Quality cost of 512 vs 1024 (new in revision 2)

Measured, not assumed. Both models run over the same three images; masks
compared as full-resolution float arrays (resized as float, not quantised to
8-bit first). Raw data: `smoke-results/measurements/quality-1024-vs-512.json`;
reproducible via `scripts/run-model-masks.py` + `scripts/compare-models.py`.

| Image | IoU @0.5 | mean abs diff | p99 abs diff | fg 1024 | fg 512 |
|---|---|---|---|---|---|
| product-scent-bottle | 0.99316 | 0.00236 | 0.0544 | 28.93% | 28.78% |
| animal-buddy-dog | 0.99250 | 0.00281 | 0.0873 | 32.15% | 32.11% |
| glass-wine | 0.98971 | 0.00445 | 0.1339 | 39.32% | 39.30% |

**Mean IoU 0.99179; mean absolute mask difference 0.00321** (i.e. <1/255 on
average). Foreground coverage agrees to within 0.15 percentage points, so 512
does not systematically gain or lose object area.

**Honest caveat on edge sharpness.** Mean gradient magnitude across the
transition band is 0.34–0.36 at 1024 versus 0.17–0.20 at 512. That difference is
**partly an artifact of the resampling ratio**: the 512 mask is upscaled ~2.5×
to reach native size, while the 1024 mask is upscaled ~1.25×, and upsampling
necessarily smooths a boundary. The metric therefore overstates the loss. Visual
inspection of native-resolution cutouts shows the practical difference is
confined to thin specular detail (the wine-glass rim shows a slightly softer,
fainter edge); fur and product silhouettes are visually equivalent.

**Conclusion:** 512 costs a small, mostly edge-localised amount of refinement and
buys a working pipeline. Anyone who needs the last few percent of hair/specular
edge fidelity should treat this as the known trade-off, not a defect.

## 7. Smaller-variant options evaluated (new in revision 2)

Quantization was measured, not assumed, because the obvious answer to "the model
is too big" is "quantize it".

| Variant | Size | Result |
|---|---|---|
| fp32 512 (shipped) | 185 MB | Baseline. Works on WASM, 4.4–4.6 s warm. |
| fp16 512 | ~95 MB | **Rejected** — ~2× slower on CPU; fp16 kernels are emulated. |
| int8 dynamic | ~12% smaller | **Rejected** — Conv layers are not quantised by dynamic quant, so the saving is trivial. |
| int8 + Conv quant | 150.5 MB | **Rejected** — 2.3× slower. |

The download-size reduction that matters is the input resolution, not the
numeric precision: 1024→512 cuts activations 4×, which is what removes the
`bad_alloc`.

## 8. Verdict (revised)

**GO on WASM — with two accepted costs and one unmeasured requirement.**

Revision 1's verdict (`GO-WITH-FALLBACK`, on the premise that WASM was unusable)
is superseded: that premise came from the 1024 fp16 export.

- The pipeline is feasible and **now demonstrably works end-to-end in a browser
  on the CPU-only path**, with clean cutouts on all three test classes.
- The two accepted costs:
  1. **≈185 MB first download** — over the §13 100 MB flag. This is the single
     largest product risk and a hosting/CDN cost question, not a technical one.
  2. **Softer thin edges** than the 1024 model (IoU 0.992, sub-1/255 mean
     difference, visible mainly on specular detail).
- The unmeasured requirement: **WebGPU latency on real hardware.** WASM now
  passes the ≤5 s bar here, but on a weak device it may not, and the WebGPU path
  that would rescue such devices has never been timed.

## 9. Blockers / risks (revised)

1. **No WebGPU measurement** — the production latency path on capable hardware
   is still unverified. This is the top open item.
2. **`bad_alloc` on unknown hardware** — reduced 4× by the 512 grid, but not
   eliminated for very low-memory devices. Peak measured 2206 MB total RSS in a
   software-rendering sandbox; real devices with less RAM headroom may still
   fail. No user-facing guidance exists yet for that case.
3. **Device compatibility matrix is empty** — two failing hardware classes have
   been observed in the field (Intel Gen-9 WebGPU stalls, Qualcomm Adreno). The
   fallback path is verified, but what works on which device is not recorded.
4. **Download size** — 185 MB exceeds the §13 flag; bandwidth may dominate
   hosting cost and is a UX barrier on mobile data.
5. **Resolved since revision 1:** the stock-export Concat/Split shader-limit
   risk and the fp16-emulation stall both applied to the 1024/fp16 pairing and
   no longer apply to the shipped artifact.

## 10. Recommended next step

1. **Run `npm run dev` on the machine that produced the `bad_alloc`** and paste
   the reported provider + 5 warm timings here. This is the only number that
   decides whether WebGPU is needed as a rescue path at all, and it is a
   five-minute task. `scripts/measure-browser-memory.mjs` can be pointed at that
   machine to capture its memory profile alongside the timings.
2. **Decide the 185 MB download question** — accept it, move inference
   server-side, or invest in distillation to a genuinely smaller model. This is
   a product decision, not an engineering one, and it gates Phase 2 scope.
3. Proceed to Phase 2 (full product workflow) once (1) is measured and (2) is
   decided.
