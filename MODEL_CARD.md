# MODEL_CARD — BiRefNet_lite (ONNX fp16)

Phase-1 record for the model used by this project. See also
`THIRD_PARTY_LEGAL_NOTICES.md` (hashes/licences) and `PHASE1_REPORT.md`
(measured results and verdict).

## Identity

- **Upstream model**: `ZhengPeng7/BiRefNet_lite`
  - Model page: https://huggingface.co/ZhengPeng7/BiRefNet_lite
  - Source repository: https://github.com/ZhengPeng7/BiRefNet
  - Published licence declaration on the model card: MIT
- **ONNX artifact used**: `Phoenix-ActuallyFree/BiRefNet_lite_512-ONNX`
  - Model page: https://huggingface.co/Phoenix-ActuallyFree/BiRefNet_lite_512-ONNX
  - Exact file: `onnx/model.onnx`
  - Size: 193,514,682 bytes (≈185 MB)
  - SHA-256: `eaafaa10f19c63b77e2bae77bf4b2f59054c208ea08b8c6648f95ef36a3b6b87`
  - Fixed input: 512×512
- **Type**: third-party ONNX export (fp32) of the upstream checkpoint — **not**
  an upstream file.
- **Provenance verification performed** (against
  `ZhengPeng7/BiRefNet_lite` `model.safetensors`, 586 tensors):
  - All 379 backbone tensors that map by name are bit-identical (max abs
    difference < 1e-5).
  - The 36 decoder/squeeze convolutions that differ are the upstream weights
    with BatchNorm folded in. Recomputing the fold
    (`w * gamma / sqrt(var + eps)`, `(b - mean) * scale + beta`) reproduces the
    ONNX values to ~1e-7, i.e. float32 rounding only.
  - Conclusion: the published file is a faithful export of the official
    checkpoint with BN folding and a 512×512 fixed input. This matters because
    the exporting repository is a personal account, not an org.

## Model details

| Aspect | Value |
|---|---|
| Purpose | Binary segmentation / background removal |
| Input | `input_image` — float32, fixed `[1, 3, 512, 512]` (NCHW, channel-first) |
| Input fixed vs dynamic | **Fixed 512×512** — no dynamic smaller-input fallback |
| Normalization | Resize 512×512 bilinear → /255 → ImageNet `mean=[0.485,0.456,0.406]`, `std=[0.229,0.224,0.225]` |
| Output | `output_image` — `[1, 1, 512, 512]` probabilities in `[0,1]` |
| Activation | Sigmoid is **baked into the graph**; the output is already a probability map. Do not apply sigmoid again. |
| Postprocessing | Upscale soft mask to original dimensions (bilinear), use as alpha over the original pixels |
| Runtime | onnxruntime-web 1.29.0 (WebGPU preferred, WASM fallback) |
| Peak transient memory | ~1.1 GB at 512×512 (was ~1.5 GB at 1024×1024 on native CPU) |

## Provenance / training-data note

Per MVP_OPENHANDS.md §3: the MIT licence declaration from the official model
page is the project's implementation basis. This is not a claim that every
question about training data has been adjudicated. Date checked: 2026-10-24.

## Distribution note

- Redistributed only as a self-hosted first-party asset from this app's origin.
- Re-downloadable and verifiable via `npm run fetch-models` (fails on SHA-256 mismatch).
- Phase-1 flag: ≈109 MB (over the 100 MB download-size flag in §13).