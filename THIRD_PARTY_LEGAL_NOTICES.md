# Third-Party Legal Notices and Disclosure

> Phase 1 status. This document records the components used and redistributed by
> the Phase 1 build with their verified hashes and published licence declarations.
> A full repeatable licence audit (`LICENSE_AUDIT.md`) and legal review of every
> licence text is scheduled for Phase 3 per MVP_OPENHANDS.md §4 and §13. Nothing
> here is a legal warranty.

Each component remains subject to its own licence and notices.

## BiRefNet_lite model

- Upstream repository: ZhengPeng7 / BiRefNet — https://github.com/ZhengPeng7/BiRefNet
- Model page: https://huggingface.co/ZhengPeng7/BiRefNet_lite
- ONNX conversion used (third-party, pinned): https://huggingface.co/onnx-community/BiRefNet_lite-ONNX
- Exact revision: `de15b22ba131738a16dff04aab8bdf8dc32e3ac1`
  (see `scripts/fetch-models.mjs`)
- Exact artifact: `onnx/model_fp16.onnx`
- File size: 114,538,221 bytes (≈109 MB)
- SHA-256: `d39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402`
- Upstream vs third-party: third-party ONNX export of the upstream checkpoint
- Published licence declaration: MIT (per the Hugging Face model card for
  `ZhengPeng7/BiRefNet_lite`)
- Licence source: [ZhengPeng7/BiRefNet license](https://github.com/ZhengPeng7/BiRefNet/blob/e49b1256aa0eabb8f9ee03f0d01b268a79a826c4/LICENSE)
  (to be verified in Phase 3 and the exact text pasted below)
- Notes: The project implements and tests this checkpoint under its published
  licence declaration. Model training-data provenance is documented in
  `MODEL_CARD.md`. This notice is not a legal warranty.

Copyright (c) 2024 ZhengPeng

> Phase 3 action: paste the exact MIT licence text from the verified upstream
> source (github.com/ZhengPeng7/BiRefNet/LICENSE at the pinned commit) here.
> A hand-retyped template is not used per MVP §4.

## Runtime

- Package: `onnxruntime-web`
- Version: 1.29.0 (installed, `node_modules/onnxruntime-web/package.json`)
- Licence: MIT
- Source: https://github.com/microsoft/onnxruntime
- Redistributed artifacts under `public/wasm/`:
  - `ort.all.min.js` (UMD bundle)
    SHA-256 `292feb81eb47989f30d40e62e29e2373979e7588231c189e6dd494ff294f069d`
  - `ort-wasm-simd-threaded.mjs` (WASM loader)
    SHA-256 `5a15f1fd086b3f6c2baf1f35105b8f502653b567e165cef80028870b39748747`
  - `ort-wasm-simd-threaded.wasm`
    SHA-256 `ec8580a9d7b9476ceee52e10a7f94124e4dc71a019d666ed6d4726697c109a4d`
  - `ort-wasm-simd-threaded.jsep.mjs`
    SHA-256 `3d68fa7af88c48894d4b0c8629de12018ab73b77519bc0b05dc8d908ad82749f`
  - `ort-wasm-simd-threaded.jsep.wasm`
    SHA-256 `db816fadbab47a755170c08f933961e231412ac17f5981f9a62e519708a44dea`
- Include any required notice text from the onnxruntime LICENSE here (Phase 3).

## Development dependencies

| Component | Exact version | Published licence | Source | Build-time |
|---|---|---|---|---|
| Vite | 5.4.21 | MIT | https://github.com/vitejs/vite | build |
| TypeScript | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript | build |
| puppeteer-core | 23.11.1 | Apache-2.0 | https://github.com/puppeteer/puppeteer | dev/test |
| onnxruntime-node | 1.29.0 | MIT | https://github.com/microsoft/onnxruntime | dev/test |

> Phase 3 action: run a repeatable licence audit of the full dependency tree
> (direct + transitive) per MVP §"Dependency and Model Licence Audit". Verify
> every licence text and record in `LICENSE_AUDIT.md`.

## Maintenance

- Preserve upstream copyright and licence notices.
- Record converted/modified files and the source revision.
- Re-check notices whenever model artifacts or dependencies change.
- The model artifact and WASM files are re-downloaded by
  `npm run fetch-models` with SHA-256 verification.