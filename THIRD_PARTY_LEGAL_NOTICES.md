# Third-Party Legal Notices and Disclosure

> Phase 3 status (2026-11-02). This document records the components used and
> redistributed by the current build with their verified hashes and published
> licence declarations. The repeatable dependency + model licence audit is in
> [`LICENSE_AUDIT.md`](./LICENSE_AUDIT.md) (MVP_OPENHANDS.md §4 and the
> "Dependency and Model Licence Audit" section). Nothing here is a legal
> warranty.

Each component remains subject to its own licence and notices.

## BiRefNet_lite model (served as QMix Cut-512)

The served artifact is named **QMix Cut-512** (manifest id `qmix-cut-512`). It is
**not** a newly trained model: it is the optimised **BiRefNet Lite** export
described below, and the BiRefNet attribution in this section applies to it in
full. The file keeps its precision-stating name (`model_512_int8_fp16.onnx`).

- Upstream repository: ZhengPeng7 / BiRefNet — https://github.com/ZhengPeng7/BiRefNet
- Model page: https://huggingface.co/ZhengPeng7/BiRefNet_lite
- ONNX conversion used (third-party): https://huggingface.co/Phoenix-ActuallyFree/BiRefNet_lite_512-ONNX
  - That repo itself declares **no licence** — it has no model card and no
    `license:` metadata (HF API `cardData` empty; README absent; checked
    2026-10-26). The licence that covers this project's use is the **upstream
    MIT** below, which the export's weights are derived from / restated as
    (same tensors, BN folded).
- Shipped artifacts: **three weight-only quantised variants** of the same
  512×512 fp32 export, all served from the `Octoborg/remove-photo-bg` Hugging
  Face Space (`…/resolve/main/models/<file>`). All three are the fp32 teacher
  with quantised *storage* materialised back to fp32 compute, so the runtime
  kernels and the input/output contract are unchanged. The generated
  `public/models-manifest.json` is the runtime source of truth and pins each
  file's SHA-256 (verified by `scripts/fetch-models.mjs`):

  | id (manifest) | file | size (bytes) | SHA-256 | role |
  |---|---|---|---|---|
  | `qmix-cut-512` (file `model_512_int8_fp16.onnx`) | `models/model_512_int8_fp16.onnx` | 60,763,193 | `10f1cf12d614b8b9db8a8dc9183c8525cbf6e020bb230e9b15daaf127012bc26` | the only model served; weight-only int8 backbone (`m.bb.*`, `m.squeeze_module.*`) + fp16 decoder, materialised to fp32, PyTorch debug metadata and duplicate initializers stripped (lossless) |

  The quantisation method and its measured parity (int8+fp16: IoU@0.5 ≥ 0.9987
  vs the teacher, 0 pixels crossing the 0.5 threshold on the repo test images;
  IoU@0.5 0.981 mean on the wider 62-image eval set with one empty-mask miss,
  `clothing-04.jpg`) are recorded in `MODEL_CARD.md`. Two larger
  weight-precision variants were served earlier and have since been withdrawn.
- Fixed 512×512 input; output `[1,1,512,512]` probabilities (sigmoid baked in).
- Upstream vs third-party: third-party ONNX export of the upstream checkpoint
- Weights provenance: verified against `ZhengPeng7/BiRefNet_lite`
  `model.safetensors`. Backbone tensors are bit-identical; the decoder
  convolutions are the upstream weights with BatchNorm folded in (differences
  ~1e-7, i.e. float32 rounding). The quantised variants are derived from that
  export with the output head kept at fp16 (quantising it flips >1000 pixels).
  See `MODEL_CARD.md` for the method.
- Published licence declaration: MIT (per the Hugging Face model card for
  `ZhengPeng7/BiRefNet_lite`, incl. commit `aa62cd87eafb9cc43056d08ef3615a14628b831d`
  "Complete the MIT license in the model card", card YAML `license: mit` and
  tag `license:mit`; verified 2026-10-25)
- Licence source: [ZhengPeng7/BiRefNet LICENSE @ 2713d1293ce8a923d5878f1f30177b78770bf24c](https://github.com/ZhengPeng7/BiRefNet/blob/2713d1293ce8a923d5878f1f30177b78770bf24c/LICENSE)
  (verified 2026-10-25; exact text below)
- Notes: The project implements and tests this checkpoint under its published
  licence declaration. Model training-data provenance is documented in
  `MODEL_CARD.md`. This notice is not a legal warranty.

The MIT licence text below is copied verbatim from the upstream repository at
`2713d1293ce8a923d5878f1f30177b78770bf24c` ("Add the MIT LICENSE", 2024-03-11),
the commit that introduced the file (the file is unchanged on `main`, latest
commit `f7079632d681ecf12161fcea8905682934e59e51`, checked 2026-10-25). A
hand-retyped template is not used per MVP §4.

```
MIT License

Copyright (c) 2024 ZhengPeng

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Alternative 512 exports reviewed (not adopted)

Reviewed 2026-10-25 — two more 512×512 exports exist with a different
input/output contract, so they are documented here for completeness:

| Repo | Files | Licence | Notes |
|---|---|---|---|
| `studioludens/birefnet-lite-512` | `onnx/model.onnx` (191,877,254 B, sha256 `1cb0fb36…52ac`), `onnx/model_fp16.onnx` (98,484,532 B, sha256 `eff9216b…c516`) | MIT (`Copyright (c) 2024 ZhengPeng`; `Copyright (c) 2026 Studio Ludens V.O.F.`) | transformer.js-oriented export; output is single-channel **logits** (sigmoid applied by caller) |
| `BRPOD123/birefnet-lite-512` | same filenames and byte-identical hashes as `studioludens` | MIT (`Copyright (c) 2024 Peng Zheng`; `Copyright (c) 2026 (Studio Ludens…)`) | mirror of `studioludens` |

Not adopted because the **fp16** variant is ~51× slower in the WASM fallback
(≈219 s per warm inference in the headless-Chromium harness vs ≈4.3 s for the
shipped 512 fp32), and the **fp32** variant is 191,877,254 B (≈183 MB) with no
size advantage over the shipped 185 MB artifact while also emitting logits
(requiring an extra client sigmoid). See `PHASE1_REPORT.md` §Model-artifact
review for measured numbers.

## Runtime

- Package: `onnxruntime-web`
- Version: 1.29.0 (installed, `node_modules/onnxruntime-web/package.json`)
- Licence: MIT (`LICENSE` @ tag `v1.29.0`: "Copyright (c) Microsoft Corporation";
  verified 2026-11-02)
- Source: https://github.com/microsoft/onnxruntime
- **Redistributed** artifacts under `public/wasm/` (CPU-only bundle, committed and
  deployed; hashes re-verified 2026-11-02, see `LICENSE_AUDIT.md` §4):
  - `ort.wasm.min.js` (UMD bundle)
    SHA-256 `f87630372da0668a72b4304e062365117cbe432d6060ca146799b1c1888460ae`
  - `ort-wasm-simd-threaded.mjs` (WASM loader)
    SHA-256 `5a15f1fd086b3f6c2baf1f35105b8f502653b567e165cef80028870b39748747`
  - `ort-wasm-simd-threaded.wasm`
    SHA-256 `ec8580a9d7b9476ceee52e10a7f94124e4dc71a019d666ed6d4726697c109a4d`
- **Build-time only** (not committed, fetched only by `fetch-models --webgpu` on
  hosts that can serve the WebGPU backend same-origin):
  - `ort.all.min.js`
    SHA-256 `292feb81eb47989f30d40e62e29e2373979e7588231c189e6dd494ff294f069d`
  - `ort-wasm-simd-threaded.jsep.mjs`
    SHA-256 `3d68fa7af88c48894d4b0c8629de12018ab73b77519bc0b05dc8d908ad82749f`
  - `ort-wasm-simd-threaded.jsep.wasm`
    SHA-256 `db816fadbab47a755170c08f933961e231412ac17f5981f9a62e519708a44dea`
- Required notice text (MIT, verbatim):

```
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Development dependencies

| Component | Exact version | Published licence | Source | Build-time |
|---|---|---|---|---|
| Vite | 5.4.21 | MIT | https://github.com/vitejs/vite | build |
| TypeScript | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript | build |
| puppeteer-core | 23.11.1 | Apache-2.0 | https://github.com/puppeteer/puppeteer | dev/test |
| onnxruntime-node | 1.29.0 | MIT | https://github.com/microsoft/onnxruntime | dev/test |
| license-checker-rseidelsohn | 5.0.1 | BSD-3-Clause | https://github.com/RSeidelsohn/license-checker-rseidelsohn | dev (audit) |

The full direct + transitive tree (247 packages) was audited on 2026-11-02 with
`license-checker-rseidelsohn` 5.0.1; the distribution, flagged items, and
resolutions are in [`LICENSE_AUDIT.md`](./LICENSE_AUDIT.md). No copyleft,
source-available, non-commercial, or unknown licence is present.

## Maintenance

- Preserve upstream copyright and licence notices.
- Record converted/modified files and the source revision.
- Re-check notices whenever model artifacts or dependencies change.
- The model artifact and WASM files are re-downloaded by
  `npm run fetch-models` with SHA-256 verification.