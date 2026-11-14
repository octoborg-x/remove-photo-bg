// Phase 1 inference worker (classic worker).
//
// Loads onnxruntime-web through the legacy UMD bundle via importScripts so the
// WASM loader files (under /wasm/) are NOT transformed by Vite's module pipeline
// (which refuses dynamic import() of /public files).
//
// Which ORT bundle to load is decided by the main thread (it knows whether the
// browser has a GPU) and passed on the worker URL:
//   - `?runtime=webgpu`  -> `ort.all.min.js`  (includes the WebGPU backend; the
//     loader then pulls `ort-wasm-simd-threaded.jsep.wasm`, 26.5 MiB)
//   - otherwise          -> `ort.wasm.min.js` (CPU-only, loads
//     `ort-wasm-simd-threaded.wasm`, 13.3 MiB)
//
// The CPU-only bundle is the default because the jsep binary exceeds the
// per-file cap of typical free static hosts (Cloudflare Pages' 25 MiB) and
// cannot live on a foreign origin (ORT's pthread workers bypass the service
// worker, so a cross-origin .wasm never gets the CORP header a COEP page
// demands — verified). Hosts that CAN serve the jsep binary same-origin (local
// preview, larger static hosts) get a working WebGPU path automatically.
// With the CPU-only bundle, a `webgpu` request degrades to WASM via the
// provider-fallback path with a clear message instead of hanging.
//
// Message protocol (see src/features/background-removal/types.ts):
//   in:  {kind:'set-model', modelUrl} | {kind:'run', runId, tensor, width, height} | {kind:'dispose'}
//   out: {kind:'loading-progress', stage, percent, bytes?, totalBytes?, elapsedMs, detail?}
//        | {kind:'load-time', ms, provider, adapter}
//        | {kind:'provider-fallback', from, to, reason}
//        | {kind:'inference-time', ms, runId} | {kind:'result-ready', mask, width, height}
//        | {kind:'error', message, runId?, fatal?}

const RUNTIME = new URL(self.location.href).searchParams.get('runtime') || 'wasm';
importScripts(RUNTIME === 'webgpu' ? '/wasm/ort.all.min.js' : '/wasm/ort.wasm.min.js');

// The UMD bundle declares a top-level `var ort` (a global in this classic
// worker), so `ort` is available directly. Do NOT redeclare it.

ort.env.wasm.wasmPaths = '/wasm/';
// Use all available cores for the threaded WASM build when SharedArrayBuffer is available.
if (typeof SharedArrayBuffer !== 'undefined' && typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
  ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency);
} else {
  ort.env.wasm.numThreads = 1;
}
// On battery-saver laptops the default adapter is often the integrated GPU, which
// cannot fit this model's 411 MB intermediate tensors. Ask for the discrete GPU.
if (ort.env.webgpu) {
  ort.env.webgpu.powerPreference = 'high-performance';
}

// WebGPU is attempted whenever the browser exposes `navigator.gpu` (see
// src/features/background-removal/provider-gate.ts on the main thread). There
// is no allowlist: a session that fails to build on the GPU, or a GPU run that
// allocates/fails, falls back to WASM below with a clear message. The shipped
// CPU-only ORT bundle (ort.wasm.min.js) has no WebGPU backend, so on hosts that
// only serve it the webgpu attempt degrades to WASM with a provider-fallback
// notice instead of hanging — same path a validated-but-unsupported device takes.

let session = null;
let lastProvider = 'none';
let modelUrl = null;
let lastError = null;
let adapterLabel = '';
// Structured diagnostics for the copyable report. Download and session-build
// times are separated so a slow start can be attributed to the network or to
// shader/optimizer work; `webgpuSessionInitialized` distinguishes "a GPU adapter
// exists" from "a WebGPU session actually built"; `sessionFallbackReason` records
// why a webgpu candidate had to fall back to WASM at build time.
let modelDownloadMs = 0;
let sessionInitMs = 0;
let webgpuSessionInitialized = false;
let sessionFallbackReason = null;
let MODEL_SIZE = 512;
// The shipped exports apply sigmoid internally and return probabilities; the
// older 1024 export returned raw logits.
let outputIsProbability = true;
let currentModelId = null;

function post(msg) {
  self.postMessage(msg);
}

// ——— Loading progress ———
// A single wall-clock origin for the whole load, so every checkpoint carries a
// consistent elapsed time for the UI. Stages and percentages are emitted from the
// worker (which knows the real byte counts) rather than inferred on the page.
let loadStartedAt = performance.now();
const PROGRESS_INTERVAL_MS = 250;
let lastStage = null;
let lastReportAt = 0;

function reportProgress(stage, percent, extra) {
  const now = performance.now();
  // Stage changes always go through: a new stage describes new work, even when
  // its percentage equals the previous stage's (the download starts at the same
  // 15% the cache probe ended on, and suppressing that left the UI stuck on
  // "Checking on-device storage…" for the whole download).
  if (stage === lastStage && stage === 'downloading' && now - lastReportAt < PROGRESS_INTERVAL_MS) {
    return;
  }
  lastStage = stage;
  lastReportAt = now;
  post({
    kind: 'loading-progress',
    stage,
    percent,
    elapsedMs: now - loadStartedAt,
    ...(extra || {}),
  });
}

// ORT reports provider allocation failures as bare C++ text (e.g.
// "failed to call OrtRun(). ERROR_CODE: 6, ERROR_MESSAGE: std::bad_alloc").
// BiRefNet's decoder allocates 411 MB tensors, so an under-provisioned GPU
// device fails here rather than at session creation.
const ALLOC_FAILURE = /bad_alloc|out of memory|outofmemory|allocation failed|allocation error|exceeds the (max|buffer)/i;
// A lost device and a dead adapter surface as these strings.
const DEVICE_LOST = /device (was )?lost|device removed|adapter (was )?lost|context lost|GPUDevice/i;

function isProviderFailure(err) {
  // A timeout is a provider failure too: the run never settled, so the only way
  // to make progress is to switch providers. Matching it by message text is
  // fragile, so it is flagged explicitly below.
  if (err && err.name === 'ProviderTimeoutError') return true;
  const text = err instanceof Error ? err.message : String(err);
  return ALLOC_FAILURE.test(text) || DEVICE_LOST.test(text);
}

// Downloads the model bytes ourselves so the UI shows real progress on slow
// mobile/cellular links (ORT's own fetch has no progress callback). Returns an
// ArrayBuffer; the session is built from those bytes so a provider retry
// doesn't re-download the 185 MB over the network.
// A stalled transfer is indistinguishable from a slow one from the outside: the
// response headers arrive, the request sits "pending" in the network panel, and
// no bytes ever come (a proxy buffering the whole 185 MB before forwarding it
// looks exactly like this). Without a watchdog the page waits forever with a
// frozen progress line, so fail loudly instead.
const STALL_TIMEOUT_MS = 30000;

function humanBytes(n) {
  if (!n) return '0 B';
  if (n < 1048576) return Math.round(n / 1024) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

// The in-flight model download's AbortController, so the main thread can stop a
// transfer the moment the connection becomes metered (see the 'cancel-model'
// message). Null whenever nothing is downloading. `downloadAbortReason` is set
// just before abort() so the fetch failure is reported as a deliberate cancel
// rather than a network error.
let downloadController = null;
let downloadAbortReason = null;

function cancelError(reason) {
  const err = new Error(reason);
  err.name = 'CancelError';
  return err;
}

// One retry on a stall: a proxy that wedged one connection usually serves a
// fresh request fine, and a second attempt is worth 30 s when the alternative is
// telling the user the app does not work.
async function downloadModel(url, onProgress) {
  try {
    return await downloadAttempt(url, onProgress);
  } catch (err) {
    if (!err || err.name !== 'StallError') throw err;
    post({
      kind: 'loading-progress',
      stage: 'downloading',
      percent: PCT.CACHE_DONE,
      elapsedMs: performance.now() - loadStartedAt,
      bytes: 0,
      detail: 'retrying after a stall',
    });
    return downloadAttempt(url, onProgress);
  }
}

async function downloadAttempt(url, onProgress) {
  const controller = new AbortController();
  downloadController = controller;
  downloadAbortReason = null;
  let stallReason = null;
  let timer = null;
  const armStallTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stallReason =
        `The model download stalled: no data for ${STALL_TIMEOUT_MS / 1000}s ` +
        `(received ${humanBytes(received)} of ${totalKnown ? humanBytes(totalKnown) : 'an unknown total'}). ` +
        'The asset origin, or a proxy in front of it, is not streaming the file.';
      controller.abort();
    }, STALL_TIMEOUT_MS);
  };
  let received = 0;
  let totalKnown = 0;

  armStallTimer();
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error('Failed to download model: HTTP ' + res.status);
    assertIsModel(res, url);
    const total = Number(res.headers.get('content-length')) || 0;
    totalKnown = total;
    if (!res.body) {
      const buf = await res.arrayBuffer();
      assertModelSize(buf.byteLength, url);
      onProgress(1, buf.byteLength, total || buf.byteLength);
      return buf;
    }
    const reader = res.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armStallTimer();
      chunks.push(value);
      received += value.length;
      onProgress(total > 0 ? Math.min(1, received / total) : 0, received, total);
    }
    const out = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    assertModelSize(received, url);
    return out.buffer;
  } catch (err) {
    // A deliberate cancel (metered switch) takes precedence over the stall
    // heuristic: the fetch rejected with an AbortError, but the reason we stopped
    // is the connection change, not a stalled origin.
    if (downloadAbortReason) throw cancelError(downloadAbortReason);
    if (!stallReason) throw err;
    const stall = new Error(stallReason);
    stall.name = 'StallError';
    throw stall;
  } finally {
    clearTimeout(timer);
    if (downloadController === controller) downloadController = null;
  }
}

// A missing model file does not always 404: dev servers and SPAs answer unknown
// paths with their index.html (HTTP 200), so without this check the page
// "downloads" a few KB of HTML and ORT reports the opaque
// "Failed to load model because protobuf parsing failed".
const MIN_MODEL_BYTES = 1024 * 1024; // the smallest real export is ~15 MB

function assertIsModel(res, url) {
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type.includes('text/html')) {
    throw new Error(
      `The model URL returned an HTML page, not the model (HTTP ${res.status} from ${url}). ` +
        'The model file is missing from the server. Run "npm run fetch-models" ' +
        '(or set VITE_ASSET_BASE to the origin that hosts it).',
    );
  }
}

function assertModelSize(bytes, url) {
  if (bytes < MIN_MODEL_BYTES) {
    throw new Error(
      `The model URL returned ${bytes} bytes, which is far too small for an ONNX model ` +
        `(${url}). The file is missing from the server. Run "npm run fetch-models".`,
    );
  }
}

let modelBytes = null;

// Progress is mapped onto fixed bands so each checkpoint is meaningful even
// before a byte total is known:
//   0-5   queued/runtime
//   5-15  probing cache
//   15-90 download (or a quick jump on a cache hit)
//   90-99 session creation
const PCT = { START: 0, RUNTIME: 5, CACHE_DONE: 15, DOWNLOAD_DONE: 90, SESSION_DONE: 99 };

async function createSession(providers) {
  for (const ep of providers) {
    try {
      if (!modelBytes) {
        reportProgress('cache-check', PCT.CACHE_DONE, { detail: 'checking for a cached model' });
        reportProgress('downloading', PCT.CACHE_DONE, { bytes: 0 });
        const dl0 = performance.now();
        modelBytes = await downloadModel(modelUrl, (fraction, bytes, total) => {
          const complete = fraction >= 1;
          reportProgress(
            complete ? 'downloaded' : 'downloading',
            Math.round(PCT.CACHE_DONE + (PCT.DOWNLOAD_DONE - PCT.CACHE_DONE) * fraction),
            { bytes, totalBytes: total || undefined },
          );
        });
        modelDownloadMs = performance.now() - dl0;
      } else {
        // A provider retry reuses the bytes already in memory; no re-download.
        modelDownloadMs = 0;
        reportProgress('cache-hit', PCT.DOWNLOAD_DONE, { detail: 'model already in memory' });
      }
      reportProgress('creating-session', PCT.DOWNLOAD_DONE, { detail: 'provider ' + ep });
      const build0 = performance.now();
      session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
      });
      sessionInitMs = performance.now() - build0;
      lastProvider = ep;
      if (ep === 'webgpu') {
        adapterLabel = describeAdapter();
        webgpuSessionInitialized = true;
      }
      // Keep the downloaded bytes in memory: a provider switch rebuilds the
      // session from them instead of re-fetching the model. They are freed when
      // the model URL actually changes or on dispose.
      reportProgress('session-ready', PCT.SESSION_DONE, { detail: ep });
      return ep;
    } catch (err) {
      session?.release?.();
      session = null;
      lastError = err;
      // Remember why the FIRST candidate (webgpu) failed so the report can say
      // "fell back to WASM" with a concrete reason rather than a bare guess.
      if (!sessionFallbackReason) {
        sessionFallbackReason = ep + ': ' + (err instanceof Error ? err.message : String(err));
      }
    }
  }
  throw lastError ?? new Error('No available execution provider (tried: ' + providers.join(', ') + ')');
}

function gpuFeatures() {
  const adapter = ort.env.webgpu?.adapter;
  return adapter?.features ? Array.from(adapter.features) : [];
}

// Adapter name/limits/features make memory and precision failures diagnosable
// from the page log.
function describeAdapter() {
  try {
    const adapter = ort.env.webgpu?.adapter;
    if (!adapter) return '';
    const info = adapter.info ?? {};
    const limits = adapter.limits ?? {};
    const name = [info.vendor, info.architecture, info.device, info.description]
      .filter(Boolean)
      .join(' ');
    const maxBuf = limits.maxStorageBufferBindingSize
      ? `, maxStorageBufferBindingSize=${Math.round(limits.maxStorageBufferBindingSize / 1048576)}MB`
      : '';
    const f16 = adapter.features
      ? `, shader-f16=${adapter.features.has('shader-f16') ? 'yes' : 'no'}`
      : '';
    return (name || 'unknown adapter') + maxBuf + f16;
  } catch {
    return '';
  }
}

// Structured adapter facts for the copyable diagnostic report, so the page does
// not have to re-parse the human-readable `adapterLabel`. All fields are
// best-effort: a browser that hides `info`/`limits` simply reports nulls.
function adapterDetails() {
  try {
    const adapter = ort.env.webgpu?.adapter;
    if (!adapter) return null;
    const info = adapter.info ?? {};
    const limits = adapter.limits ?? {};
    return {
      vendor: info.vendor ?? null,
      architecture: info.architecture ?? null,
      device: info.device ?? null,
      description: info.description ?? null,
      features: adapter.features ? Array.from(adapter.features) : [],
      maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize ?? null,
      maxBufferSize: limits.maxBufferSize ?? null,
    };
  } catch {
    return null;
  }
}

// The first WebGPU run compiles kernels for the whole graph and can take far
// longer than a warm run, especially on older integrated GPUs. Later runs are
// bounded tightly because a stall there means the device is gone.
const FIRST_WEBGPU_TIMEOUT_MS = 180000;
const WEBGPU_TIMEOUT_MS = 120000;
let webgpuRunCount = 0;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.name = 'ProviderTimeoutError';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runInference(tensor) {
  const feeds = {
    input_image: new ort.Tensor('float32', tensor, [1, 3, MODEL_SIZE, MODEL_SIZE]),
  };
  const t0 = performance.now();
  try {
    const run = session.run(feeds);
    // No watchdog for WASM: minutes-long CPU runs are expected, not stalls.
    let results;
    if (lastProvider === 'webgpu') {
      const limit = webgpuRunCount === 0 ? FIRST_WEBGPU_TIMEOUT_MS : WEBGPU_TIMEOUT_MS;
      webgpuRunCount++;
      try {
        results = await withTimeout(
          run,
          limit,
          `WebGPU run did not finish in ${limit / 1000}s (device lost, or the shader stalled)`,
        );
      } catch (err) {
        // Race() left the GPU run pending; swallow its eventual rejection so an
        // abandoned run does not surface as an unhandled promise rejection.
        run.catch(() => {});
        throw err;
      }
    } else {
      results = await run;
    }
    const timeMs = performance.now() - t0;
    const out = results.output_image.data;
    // Normalise to a [0,1] probability map here, so the main thread never has to
    // know whether this export emits logits or probabilities.
    const mask = new Float32Array(out.length);
    if (outputIsProbability) {
      mask.set(out);
    } else {
      for (let i = 0; i < out.length; i++) mask[i] = 1 / (1 + Math.exp(-out[i]));
    }
    return { mask, timeMs };
  } finally {
    feeds.input_image.dispose?.();
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.kind === 'set-model') {
      // A new set-model usually means a different model artefact: drop the
      // previous session so memory from one model never leaks into the next,
      // and reset the load timeline/progress so the UI reports a fresh load
      // (not a continuation of the previous model's). The downloaded bytes are
      // only dropped when the URL actually changes — a provider switch re-sends
      // the SAME url, and rebuilding the session on another execution provider
      // only needs those bytes in memory, so re-fetching them is pure waste
      // (the service worker would serve them from cache anyway). A cancelled
      // download leaves `modelBytes` null (it is only assigned once the whole
      // file has arrived), so resuming re-fetches from the start.
      await session?.release?.();
      session = null;
      if (msg.modelUrl !== modelUrl) modelBytes = null;
      lastProvider = 'none';
      lastError = null;
      currentModelId = msg.modelId || null;
      modelUrl = msg.modelUrl;
      // Reset the per-load diagnostics so a stale value from a previous model or
      // provider never leaks into the next report.
      modelDownloadMs = 0;
      sessionInitMs = 0;
      webgpuSessionInitialized = false;
      sessionFallbackReason = null;
      if (msg.inputSize) MODEL_SIZE = msg.inputSize;
      if (typeof msg.outputIsProbability === 'boolean') {
        outputIsProbability = msg.outputIsProbability;
      }
      loadStartedAt = performance.now();
      lastStage = null;
      lastReportAt = 0;
      reportProgress('queued', PCT.START);
      // Attempt WebGPU whenever the browser exposes it; a failed webgpu
      // candidate falls back to WASM inside createSession (no hang).
      const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
      const forced = msg.forceProvider;
      let candidates;
      if (forced) {
        candidates = [forced];
      } else if (hasWebGPU) {
        candidates = ['webgpu', 'wasm'];
      } else {
        candidates = ['wasm'];
      }
      reportProgress('runtime', PCT.RUNTIME, {
        detail: 'providers: ' + candidates.join(', '),
      });
      const ep = await createSession(candidates);
      if (ep === 'webgpu' && !gpuFeatures().includes('shader-f16')) {
        // The shipped model is float16 internally; without shader-f16 the driver
        // emulates it, which is where slow and stalled runs come from.
        post({
          kind: 'adapter-warning',
          message:
            'this GPU does not support shader-f16, but the model is float16. ' +
            'WebGPU will be slow or may stall; use ?provider=wasm to force the CPU.',
        });
      }
      const totalMs = performance.now() - loadStartedAt;
      reportProgress('ready', 100, { detail: ep });
      post({
        kind: 'load-time',
        ms: totalMs,
        provider: ep,
        adapter: adapterLabel,
        modelId: currentModelId,
        // Structured diagnostics for the copyable report.
        downloadMs: modelDownloadMs,
        sessionInitMs,
        webgpuSessionInitialized,
        fallbackReason: sessionFallbackReason,
        adapterDetails: adapterDetails(),
      });
      return;
    }
    if (msg.kind === 'run') {
      if (!session) throw new Error('Model not loaded');
      let result;
      try {
        result = await runInference(msg.tensor);
      } catch (err) {
        if (lastProvider !== 'webgpu' || !isProviderFailure(err)) throw err;
        // The GPU could not run this model (allocation failure, lost device, or a
        // run that never settled). Rebuild on the CPU provider and retry once so
        // the user still gets a result.
        const reason = err instanceof Error ? err.message : String(err);
        post({ kind: 'provider-fallback', from: 'webgpu', to: 'wasm', reason });
        try {
          await session?.release?.();
        } catch {
          // A released-after-hang session may throw; the rebuild is what matters.
        }
        session = null;
        await createSession(['wasm']);
        result = await runInference(msg.tensor);
      }
      // result-ready first: the main thread renders the image before the promise
      // for this run settles, so the output is on screen before the summary.
      post({
        kind: 'result-ready',
        mask: result.mask,
        width: msg.width,
        height: msg.height,
        inputSize: MODEL_SIZE,
        // Echo the run id so the page can drop a late result that belongs to a
        // superseded run (a newer upload started before this one finished).
        runId: msg.runId,
      });
      post({ kind: 'inference-time', ms: result.timeMs, runId: msg.runId });
      return;
    }
    if (msg.kind === 'cancel-model') {
      // Stop an in-flight model download (the main thread sends this when the
      // connection becomes metered). The fetch rejects with an AbortError, which
      // downloadAttempt rethrows as a CancelError, and the set-model try/catch
      // below posts it back as a non-fatal error. Bytes are left in memory for a
      // provider switch, but a cancelled transfer has none yet.
      if (downloadController) {
        downloadAbortReason = msg.reason || 'Model download cancelled.';
        downloadController.abort();
      }
      return;
    }
    if (msg.kind === 'dispose') {
      await session?.release?.();
      session = null;
      modelBytes = null;
    }
  } catch (err) {
    post({
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
      runId: msg.kind === 'run' ? msg.runId : undefined,
      fatal: msg.kind === 'set-model',
      // A deliberate cancel (metered switch) is not a failure: the main thread
      // re-arms the download prompt instead of showing an error recovery.
      cancelled: err instanceof Error && err.name === 'CancelError',
    });
  }
};
