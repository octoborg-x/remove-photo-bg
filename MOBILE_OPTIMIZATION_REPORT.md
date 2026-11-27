# Mobile optimization report — adaptive source size and fallback grace

**Date:** 2026-11-22
**Status:** implemented and tested in this sandbox; **real-device validation is
open** (see §7). No claim of a mobile success rate is made.
**Scope:** the browser page's main-thread source handling and the provider
default. The 512 px model input, its letterbox contract, the ONNX artifact and
the tiling heuristics are unchanged. No new dependency, no paid service, no
cloud inference.

## 1. What this changes, and what it does not

| Changed | Not changed |
|---|---|
| A decoded source is capped before `getImageData` (4096 desktop / 3072 phone / 2048 low-memory phone). | `MODEL_SIZE = 512`, the letterbox, normalisation, and the ONNX input/output contract. |
| The cap is applied before validation, so a 48 MP phone photo is reduced instead of rejected. | The model artifact, its SHA-256, and the served runtime. |
| An unverified mobile GPU adapter defaults to WASM (opt-in GPU remains). | The `recommendTiling` thresholds; they still see the (possibly smaller) source. |
| A phone gets a 30 s warm WebGPU watchdog instead of 120 s. | The first-run 180 s watchdog, the WASM path (still unbounded), and the fresh-worker restart. |
| The same reduction applies to the bulk upload path and the library source blob. | `loadImageFromUrl` / the eval harness path (deliberately unchanged; see §6). |

The goal is graceful adaptation on a phone. The deliverable is the measured,
reproducible change that works toward it; a real phone is still required to
call it done.

## 2. Phase 0 — what the existing code actually does

| File | Finding |
|---|---|
| `src/features/background-removal/image-validation.ts` | `DEFAULT_UPLOAD_LIMITS` = 20 MB / 4096 px. `validateDimensions` **rejects** any longest side over 4096 as an upload error, before any processing. Modern phone cameras exceed this routinely. |
| `src/features/background-removal/image-preprocess.ts` | Letterboxes the decoded `ImageData` down to 512×512 and builds the NCHW tensor on the **main thread**. The model input is fixed and is not the memory problem. |
| `src/features/background-removal/provider-gate.ts` | `classifyGpuAdapter` already denies software renderers, a slow/incorrect denylist (Adreno-6xx, Intel Gen-9, …), missing `shader-f16`, and a too-small storage binding. It had no device-class input. `detectWebGpu` had no options. |
| `src/features/background-removal/tiling.ts` | `recommendTiling` already scales with the image's long side: it only fires at ≥ 1024 px and ≥ 2.5× upscale, and never suggests more than 2×2 because tiles below 512 px lose detail. It reads `currentImageData`, so it automatically sees a reduced source. |
| `src/main.ts` boot | `resolveProvider` defaults to GPU only when `webGpuUsable()` (adapter passes the gate **and** the host serves the WebGPU bundle). `loadImageFromFile` decoded, validated at `naturalWidth/Height`, then allocated a full-resolution canvas and `getImageData`. `MEMORY_NOTE` documents ~1 GB of transient tensor memory; `describeError` handles `bad_alloc` only **after** a failure. |
| `public/inference-worker.js` | The worker receives a **3×512×512 Float32 tensor** (12.6 MB) that the main thread built, so full-resolution `ImageData` never crosses the worker boundary. There is no size guard in the worker, and none is needed while the tensor is fixed. The WebGPU watchdog is 180 s for the first run / 120 s afterwards; WASM is unbounded. |
| `HARDWARE_TESTING.md` §1, §4, §8 | One real phone measured: Adreno-6xx, WebGPU **6709 ms** warm vs WASM **6600 ms**, and WebGPU left opaque rails on the subject (WASM clean). Intel Gen-9 is correct-but-slow. The "ghost" mask reproduces on a clean WebGPU run with **no** fallback and also on WASM, so it is a device precision issue, not a repo alpha bug. No mobile GPU has been measured correct in this repo. |
| Device detection already present | `readDeviceMobile()` in `network-preflight.ts` (UA-CH `mobile`, then a UA regex) was the only device-class probe, and it was private. It is now exported and reused by both the preflight and the downscaler. `navigator.deviceMemory` was already read in the diagnostic report only. |

## 3. Change 1 — adaptive source downscaling

New pure module: `src/features/background-removal/adaptive-downscale.ts`
(`recommendSourceScale`). It takes the decoded dimensions plus coarse hints and
returns the target size, the cap, why the cap was chosen, and the console
sentence. It never upscales.

### 3.1 Thresholds and the evidence behind each

| Cap | Value | Evidence / rationale |
|---|---|---|
| Desktop | **4096 px** | `DEFAULT_UPLOAD_LIMITS.maxLongestSide`; the documented limit. Keeping it means **desktop behaviour is unchanged**. |
| Phone | **3072 px** | 75% of 4096. It keeps a 2×2 tile at 1536 px, above `TILING_MIN_LONG_SIDE = 1024` and well above the 512 px model input, so tiling stays meaningful. **No real-phone memory measurement exists for this number**; it is a conservative bound, not a measured optimum. |
| Low-memory phone | **2048 px** | Half of 4096. Triggered by `navigator.deviceMemory ≤ 2` (the API's lowest reported bucket) or, when memory is absent, `hardwareConcurrency ≤ 2`. This is a heuristic; **untested on hardware**. |
| `?maxSourceSide=` | clamped to **512–4096** | Scripted/A-B override. Clamping keeps the post-downscale image inside the upload cap so validation can never reject what the app just produced. |

`navigator.deviceMemory` is Chromium-only; the fallback to core count is
deliberate, not a second device-sniffing path.

### 3.2 Buffer arithmetic (not a measurement)

RGBA bytes = width × height × 4. These are arithmetic consequences of the caps,
not peak-memory measurements:

| Source | RGBA bytes |
|---|---|
| 4800 × 3200 (15.4 MP) | 58.6 MiB |
| 4096 × 3072 | 48.0 MiB |
| 3072 × 2304 | 27.0 MiB |
| 2048 × 1365 | 10.7 MiB |

The initial browser decode of the original file still happens before the
decision (the browser must decode to know the dimensions). What the change
removes is the **second** full-resolution buffer: the `ImageData`/canvas copy the
pipeline held for the whole run.

### 3.3 Wiring

In `loadImageFromFile`:

1. decode the image (as before);
2. run `recommendSourceScale` on `naturalWidth/naturalHeight`;
3. log `Reduced from W×H to w×h so this device can process it reliably.` when reduced;
4. validate the **reduced** size (the 4096 hard cap stays as an outer sanity check);
5. draw once onto a canvas at the reduced size and call `getImageData` there;
6. for a reduced source, re-encode that canvas once and use it for the preview,
   the before/after slider, tiled runs and the library source blob, then release
   the full-resolution decode.

The bulk upload path makes the same decision for validation and for its card
thumbnail. `loadImageFromUrl` (the eval/smoke path) is unchanged on purpose so
existing benchmark inputs and results stay comparable.

`?maxSourceSide=` is the override. The console line is pinned by a source-level
regression test.

## 4. Change 2 — mobile provider default and watchdog

### 4.1 Evidence

`HARDWARE_TESTING.md` §4's conclusion after the first real-phone run is explicit:
*"WebGPU should stay an opt-in path with WASM as the safe default on mobile."*
The measured phone was Adreno-6xx, which the gate already denies. What the
classifier did **not** handle was an adapter it knows nothing about on a phone:
it would default to GPU with no evidence either way.

### 4.2 Rule

`classifyGpuAdapter(adapter, { deviceClass })` now returns unusable **as the
default** when `deviceClass === 'mobile'` and the adapter has no allow-signal:

```
<label> is an unverified mobile GPU adapter; defaulting to CPU for reliability
```

This is distinct from the existing known-bad reason. The adapter stays
`adapterPresent`, so the UI still offers GPU and `?provider=webgpu` still forces
it; selecting it shows the existing trade-off toast (`gpuChoiceWarning`).
Desktop is untouched.

`CONFIRMED_GOOD_ADAPTER_HINTS` is **empty by design**: no mobile adapter has been
measured correct in this repo, and inventing one would be a fabricated result.
The matching mechanism is exported and unit-tested; an entry is added only with
a real-device `HARDWARE_TESTING.md` result. In practice, therefore, every mobile
adapter currently defaults to WASM; that is a default, not a removal of the GPU.

### 4.3 Watchdog

The existing watchdog does cover "never settles": a `ProviderTimeoutError` is
classified as a provider failure, the worker posts `provider-restart`, and the
page discards it for a fresh CPU worker (`restartOnFreshWorker`). There was no
new silent-failure reproduction available in this sandbox, and none is claimed.

The gap was latency, not coverage: 120 s is 16.5× the worst measured warm run
(7251 ms). The worker now receives `mobile` in `set-model` and uses **30 s** for
a **warm** WebGPU run on a phone — 4.1× the worst measured warm time
(30 000 / 7251 = 4.14). The **first** run keeps 180 s because it compiles
shaders, which has no comparable phone measurement.

## 5. Measured results (this sandbox only)

| Check | Result |
|---|---|
| Unit tests (`npx vitest run`) | **585 passed / 55 files** (baseline was 555; 30 new tests across the downscaler, its wiring guard, the provider gate, and the worker watchdog). |
| Lint (`npx eslint .`) | clean |
| Typecheck (`npx tsc --noEmit`) | clean |
| Production build (`npm run build`) | passes |
| Browser suite (`node scripts/run-browser-tests.mjs`) | **107/107 checks**, including 3 new emulated-viewport checks |

The new browser scenario uses a **390×844 emulated viewport**, an Android UA, a
stubbed `navigator.userAgentData.mobile = true`, and `navigator.deviceMemory = 2`.
It uploads a generated 4800×3200 PNG (15.4 MP, long side over the 4096 cap) and
asserts, from the real page:

- the exported PNG is **2048×1365**, not 4800×3200;
- the Console contains `Reduced from 4800×3200 to 2048×1365`;
- a result is produced with the recovery/OOM panel hidden.

This is an **emulated viewport check**. It proves the page's decision and export
path; it says nothing about a real Android/iOS GPU, real memory pressure, or a
real phone's decode cost.

## 6. Explicitly untested / not measured

- Peak renderer memory on a real phone, before or after the change.
- Real-device decode cost of a 12–48 MP JPEG/PNG (the initial decode is unchanged).
- Any iOS Safari behaviour.
- WebGPU correctness or speed on a mobile adapter that is not Adreno-6xx.
- The 2048 low-memory threshold and the 3072 phone threshold as *optimal*
  values — both are conservative bounds without hardware measurements.
- The 30 s mobile watchdog on hardware. It is unit-tested only for the selected
  budget and the fallback message.
- The `loadImageFromUrl` / eval path, which deliberately keeps its old behaviour.

## 7. Needs a real phone — manual runbook

Mirrors `HARDWARE_TESTING.md` §3. Run on (a) an Android phone with a recent
Chrome, (b) a low-memory/older phone if available, and (c) an iPhone with Safari
if available.

1. Open the deployed page (or a work-host URL) in Chrome on the phone.
2. Wait for the model to finish loading. Open **Studio**.
3. Choose a photo with a long side **over 4096 px** (a 12 MP+ camera photo or a
   panorama). Do not resize it first.
4. Watch the **Console**. It must contain a line of the form
   `Reduced from W×H to w×h so this device can process it reliably.`
   Record the exact line.
5. Let the cut-out finish. Download the PNG and check its dimensions in the
   phone's photo viewer or with `file`/`identify` on a desktop. It should equal
   the reduced size from step 4, not the original.
6. Read the provider line. On an unverified mobile adapter the default should be
   **CPU (WASM)** and the log should say
   `unverified mobile GPU adapter; defaulting to CPU for reliability`.
   If the GPU was selected instead, record the adapter label.
7. Press **Copy report** and paste it back. It carries the adapter, the selected
   and actual provider, the timings, and the raw-mask verdict.
8. Opt in to **GPU (WebGPU)** in Advanced options and run the same photo once.
   Record whether it completes, whether the watchdog fires, and whether the
   mask verdict is `ok (bimodal)` or `SUSPECT`. A wrong mask here is the known
   Adreno class and is not fixed by this change.
9. Optionally call `window.runSmoke()` from the console for scripted timings, and
   note `window.smokeProvider` / `window.smokeModelId`.
10. For memory, note whether the tab reloads/crashes and, if the phone exposes it,
    the peak from `performance.memory` (Chromium) or the browser's task manager.

**What to paste back:** the reduction line, the export dimensions, the provider
line, whether the watchdog fired, the Copy-report block, and the device/OS/GPU
from `chrome://gpu`. Until that exists, this change is "works toward", not
"validated on mobile".

## 8. Rollback and overrides

- `?maxSourceSide=2048` (or any 512–4096 value) caps the source for a scripted
  run without a code change.
- `?provider=wasm` / `?provider=webgpu` force the provider as before.
- The downscaler is one pure module plus the wiring in `loadImageFromFile`,
  `addBulkFiles` and `set-model`; reverting those restores the previous
  behaviour without touching the model or the worker.

## 9. Open items

1. Real-phone validation per §7 (the only way to close this).
2. A confirmed-good mobile adapter entry, once one is measured correct.
3. Peak-memory measurement to validate or tune 3072 / 2048.
4. The Adreno-6xx ghost remains a device-precision issue, unchanged and
   unfixed here (`HARDWARE_TESTING.md` §8).
