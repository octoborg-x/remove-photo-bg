# Privacy

_Phase 1 status: this document describes the privacy-relevant behavior of the
current build and the Phase-1 verification performed. Statements about the final
product are goals, verified in PRIVACY.md updates when reached._

## Image processing location

- Your image is decoded, processed, and exported **entirely in your browser**.
- Segmentation runs with ONNX Runtime Web inside a [Web Worker](https://developer.mozilla.org/en-US/docs/Web/API/Web_Worker_API)
  (`/inference-worker.js`) using the **WebGPU** provider when available,
  falling back to **WASM** on CPUs without WebGPU.
- No image pixels are rendered through or transmitted by any remote service.

## What the app fetches over the network

The only network requests a client makes are:

1. The app shell (HTML/JS/CSS) from its own origin.
2. The pinned ONNX segmentation model (`public/models/model_fp16.onnx`).
3. The ONNX Runtime Web WASM binaries and loader (`public/wasm/…`).
4. **Test images only in the Phase‑1 harness** (`public/test-images/…`),
   which ship with the repo for validation and are not part of the product.

All assets are served from the app's **own origin**. The product must not embed
third-party analytics, ad pixels, external fonts, remote logging, or error SDKs,
and no fetch/XHR is made with image content.

## Network verification (Phase 1)

The smoke-test driver (`scripts/run-smoke.mjs`) records every network request
made by the headless browser while an image is processed and writes
`smoke-results/requests.json`. Verification steps:

1. Confirm every recorded request is first-party (`localhost` / the app origin)
   and limited to: app shell, model, WASM, or test images.
2. Confirm no `fetch`/`XHR` request body carries image data.
3. Confirm no request targets a third-party origin.

Phase-1 result is recorded in `PHASE1_REPORT.md` together with the raw
`requests.json` summary.

## Data retention / logging

- No server exists, so nothing is stored server-side.
- The app does not log filenames, image content, EXIF, or raw user input.
- File objects and buffers are released after processing.

## Browser requirements

- **WebGPU** (Chrome/Edge on updated desktop, some Android) for usable speeds.
- Otherwise WASM runs the same model but is substantially slower (measured
  >10 min per 1024×1024 image on a CPU-only sandbox; see `PHASE1_REPORT.md`).
- The page requires [cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)
  (COOP/COEP) so ONNX Runtime's threaded WASM build can use `SharedArrayBuffer`.

## Upload limits (Phase 1 build)

- 20 MB file size, 4096 px longest side (configurable in code; enforced in the
  full product flow per MVP spec section 6).