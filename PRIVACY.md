# Privacy

_Phase 3 status (2026-11-02): this document describes the privacy-relevant
behavior of the current build and the verification performed. It is a factual
description, not a legal warranty._

## Image processing location

- Your image is decoded, processed, and exported **entirely in your browser**.
- Segmentation runs with ONNX Runtime Web inside a [Web Worker](https://developer.mozilla.org/en-US/docs/Web/API/Web_Worker_API)
  (`/inference-worker.js`) using the **WebGPU** provider when the browser exposes
  an adapter **and** the host serves the WebGPU-capable runtime, otherwise
  **WASM** on the CPU.
- No image pixels are rendered through or transmitted by any remote service.

## What the app fetches over the network

The only network requests a client makes are:

1. The app shell (HTML/JS/CSS) from its own origin.
2. The pinned ONNX segmentation model (default
   `model_512_int8_fp16.onnx`, or the user-selected variant), proxied through the
   app's own origin by the service worker.
3. The ONNX Runtime Web WASM binaries and loader (`/wasm/…`), same-origin.
4. **Test images only in the development harness** (`public/test-images/…`),
   which ship with the repo for validation and are not part of the product.

No third-party analytics, ad pixels, external fonts, remote logging, or error
SDKs are embedded, and no fetch/XHR is made with image content.

## Network verification

The smoke-test driver (`scripts/run-smoke.mjs`) records every network request
made by the headless browser while an image is processed and writes
`smoke-results/<run>/requests.json`. Criteria:

1. Every recorded request is first-party (`localhost` / the app origin) and
   limited to: app shell, model, WASM, or test images.
2. No `fetch`/`XHR` request body carries image data.
3. No request targets a third-party origin.

**Phase 2 verification (2026-11-02):** 16 requests, **all first-party, 0
third-party** (`smoke-results/phase2-final/requests.json`). Phase-1 verification
is in `PHASE1_REPORT.md` §4.

## Data retention / logging

- No server exists, so nothing is stored server-side.
- The app does **not** log filenames, image content, EXIF, or raw user input.
  (Phase 2 removed the filename from the image-load log line; only pixel
  dimensions are logged.)
- File objects and buffers are released after processing.

## On-device storage (asset cache)

- To avoid re-downloading the model and the ONNX Runtime WASM binaries on every
  visit, a service worker stores them in the browser's Cache API.
- Models are stored in a **per-model bucket** keyed by manifest id + content hash
  (`remove-bg-model-<id>-<sha8>`), so switching or upgrading a model never
  touches another model's cached bytes. The WASM runtime uses one shared bucket
  (`remove-bg-assets-<version>`). A changed model revision produces a new bucket
  and the stale one is pruned on the next activation.
- Only those two artifact types are stored. No image pixels, filenames, EXIF, or
  other user data are ever written to the cache.
- The cache is first-party and stays on the device. It can be cleared at any time
  through the browser's site-data settings; the next visit then re-downloads the
  artifacts once.

## Browser requirements

- A **WebGPU** adapter (Chrome/Edge on updated desktop, some Android) enables the
  GPU path. On a GPU that fails to build/run the session, the app falls back to
  WASM and reports the fallback in the log.
- Otherwise WASM runs the same model on the CPU; it is slower (measured ~3–5 s
  per image in the CPU-only sandbox, see `PHASE2_REPORT.md`).
- The page requires [cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)
  (COOP/COEP) so ONNX Runtime's threaded WASM build can use `SharedArrayBuffer`.

## Upload limits

- Accepted formats: JPEG, PNG, WebP (MIME checked, extension never trusted).
- **20 MB** maximum file size; **4096 px** maximum longest side. Both are
  disclosed in the UI and enforced before/after decoding.
- A photo larger than the device's source cap is reduced on this device before
  it is read into memory (4096 px on desktop; 3072 px on a phone, or 2048 px on
  a phone reporting ≤ 2 GB of memory). The Console states the reduction, and the
  export uses the reduced size. The original is never upscaled.
- Files that fail validation are rejected with an actionable message; no partial
  or decoded data is retained.

## Product analytics (added 2026-11-14)

_This section describes the optional, privacy-first analytics system. It never
receives your images or anything derived from them._

**What is measured.** Anonymous counts of: a session starting; background
removal starting, succeeding, or failing; the first successful removal per
anonymous browser; and a download being initiated. If you submit the optional
**Report a quality problem** form, the problem category, an optional description
you type (≤500 characters), the build id, the model id, and — only if you tick
the box — a small technical diagnostics block are stored.

**What is never collected.** Image pixels, filenames, EXIF, image URLs or other
image metadata; your name, email, phone, or any account or contact information;
IP addresses for analytics storage; cookies for tracking; browser fingerprints.
The analytics server does not record your IP address — the only identifier is a
random, anonymous id stored in your browser.

**Consent.** Analytics is **off until you allow it**. A banner asks once; if you
decline, nothing is sent and no identifier is created. You can change or withdraw
your choice any time via **Analytics settings** in the footer, which also deletes
the anonymous id. Declining analytics never blocks image processing, downloads, or
quality reports.

**Anonymous id.** A random UUID from your browser's cryptographic generator,
stored in first-party local storage only after you allow analytics, rotated after
**90 days**, never derived from anything identifying. Clearing your browser
storage, using another browser, or using another device creates a new id — so the
"returning" figure counts anonymous browsers, not verified people.

**Where it goes.** Events are sent to a first-party SmartCutAI Cloudflare Worker
and stored in Cloudflare Workers Analytics Engine (three-month retention).
Quality reports are stored in Cloudflare D1. No third-party analytics SDK, ad
network, session replay, or heatmap is used.

**Landing-page traffic.** If enabled, Cloudflare Web Analytics records page views,
referrers, and coarse geography. It is a cookieless Cloudflare technology, and its
beacon is loaded **only after you allow analytics** (never before). See
`docs/analytics-architecture.md` for how it relates to the in-app consent choice.

Withdrawing consent stops future custom events and deletes the anonymous id. The
Cloudflare Web Analytics beacon cannot be removed from an already-loaded page, so
that one page view is still reported; a reload after withdrawing loads nothing.

See `docs/analytics-architecture.md`, `docs/analytics-events.md`, and
`docs/quality-reporting.md` for the full detail.