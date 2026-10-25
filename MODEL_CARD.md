# MODEL_CARD — BiRefNet_lite (ONNX fp16)

Phase-1 record for the model used by this project. See also
`THIRD_PARTY_LEGAL_NOTICES.md` (hashes/licences) and `PHASE1_REPORT.md`
(measured results and verdict).

## Identity

- **Upstream model**: `ZhengPeng7/BiRefNet_lite`
  - Model page: https://huggingface.co/ZhengPeng7/BiRefNet_lite
  - Source repository: https://github.com/ZhengPeng7/BiRefNet
  - Published licence declaration on the model card: MIT
- **ONNX artifact used**: `onnx-community/BiRefNet_lite-ONNX`
  - Prompt: https://huggingface.co/onnx-community/BiRefNet_lite-ONNX
  - Pinned revision: `de15b22ba131738a16dff04aab8bdf8dc32e3ac1`
  - Exact file: `onnx/model_fp16.onnx`
  - Size: 114,538,221 bytes (≈109 MB)
  - SHA-256: `d39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402`
- **Type**: third-party ONNX export (fp16) of the upstream checkpoint — **not**
  an upstream file. Weights provenance relative to the source checkpoint is per
  the exporting repository; this was not independently re-verified beyond the
  pinned artifact hash in Phase 1.

## Model details

| Aspect | Value |
|---|---|
| Purpose | Binary segmentation / background removal |
| Input | `input_image` — float32, fixed `[1, 3, 1024, 1024]` (NCHW, channel-first) |
| Input fixed vs dynamic | **Fixed 1024×1024** — no dynamic smaller-input fallback |
| Normalization | Resize 1024×1024 bilinear → /255 → ImageNet `mean=[0.485,0.456,0.406]`, `std=[0.229,0.224,0.225]` |
| Output | `output_image` — `[1, 1, 1024, 1024]` raw logits |
| Activation | 1/(1+exp(-x)) on the last channel (sigmoid) |
| Postprocessing | Upscale soft mask to original dimensions (bilinear), use as alpha over the original pixels |
| Runtime | onnxruntime-web 1.29.0 (WebGPU preferred, WASM fallback) |

## Provenance / training-data note

Per MVP_OPENHANDS.md §3: the MIT licence declaration from the official model
page is the project's implementation basis. This is not a claim that every
question about training data has been adjudicated. Date checked: 2026-10-24.

## Distribution note

- Redistributed only as a self-hosted first-party asset from this app's origin.
- Re-downloadable and verifiable via `npm run fetch-models` (fails on SHA-256 mismatch).
- Phase-1 flag: ≈109 MB (over the 100 MB download-size flag in §13).