// Phase 1 inference worker (classic worker).
//
// Loads onnxruntime-web through the legacy UMD bundle via importScripts so the
// WASM loader files (under /wasm/) are NOT transformed by Vite's module pipeline
// (which refuses dynamic import() of /public files).
//
// The CPU-only bundle (`ort.wasm.min.js`) is loaded, not `ort.all.min.js`: the
// full bundle pulls an additional 26.5 MiB `.jsep.wasm` for WebGPU that exceeds
// Cloudflare Pages' 25 MiB per-file cap and cannot be split cross-origin (see
// fetch-models.mjs). With this bundle only the CPU (wasm) provider exists.
//
// Message protocol (see src/features/background-removal/types.ts):
//   in:  {kind:'set-model', modelUrl} | {kind:'run', runId, tensor, width, height} | {kind:'dispose'}
//   out: {kind:'loading-progress', stage, percent, bytes?, totalBytes?, elapsedMs, detail?}
//        | {kind:'load-time', ms, provider, adapter}
//        | {kind:'provider-fallback', from, to, reason}
//        | {kind:'inference-time', ms, runId} | {kind:'result-ready', mask, width, height}
//        | {kind:'error', message, runId?, fatal?}
importScripts('/wasm/ort.wasm.min.js');

// The UMD bundle declares a top-level `var ort` (a global in this classic
// worker), so `ort` is available directly. Do NOT redeclare it.

ort.env.wasm.wasmPaths = '/wasm/';
// Use all available cores for the threaded WASM build.
if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
  ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency);
}
// On battery-saver laptops the default adapter is often the integrated GPU, which
// cannot fit this model's 411 MB intermediate tensors. Ask for the discrete GPU.
if (ort.env.webgpu) {
  ort.env.webgpu.powerPreference = 'high-performance';
}

// WebGPU is enabled only on adapters that have been validated to produce a
// correct mask. BiRefNet on onnxruntime-web is precision- and layout-sensitive;
// on Adreno-6xx it silently returned a wrong result (missing foreground, opaque
// rails left on the subject) with no error, so the WASM fallback never fired.
// Until an adapter is verified end-to-end (correct mask + acceptable latency,
// see the laptop test), default to WASM. `?provider=webgpu` still opts in.
//
// Each entry is a lowercase substring of `adapter.info.device ||
// adapter.info.architecture || adapter.info.vendor || adapter.info.description`.
// Keep the list empty until an adapter passes validation.
const VALIDATED_WEBGPU_SUBSTRINGS = [
  // e.g. 'radeon 780m', 'apple m2', 'intel iris xe — validated <date>'
];

function adapterSubstrings() {
  try {
    const a = ort.env.webgpu?.adapter;
    if (!a) return '';
    const info = a.info ?? {};
    return [info.device, info.architecture, info.vendor, info.description]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  } catch {
    return '';
  }
}

// Do NOT call navigator.gpu inside the worker before importScripts has run:
// `adapterSubstrings()` is only meaningful once ort has enumerated the adapter.
function webgpuValidated() {
  const blob = adapterSubstrings();
  if (!blob) return false;
  return VALIDATED_WEBGPU_SUBSTRINGS.some((s) => blob.includes(s));
}

let session = null;
let lastProvider = 'none';
let modelUrl = null;
let lastError = null;
let adapterLabel = '';
let MODEL_SIZE = 512;
// The shipped BiRefNet_lite_512 export applies sigmoid internally and returns
// probabilities; the older 1024 export returned raw logits.
let outputIsProbability = true;

function post(msg) {
  self.postMessage(msg);
}

// ——— Loading progress ———
// A single wall-clock origin for the whole load, so every checkpoint carries a
// consistent elapsed time for the UI. Stages and percentages are emitted from the
// worker (which knows the real byte counts) rather than inferred on the page.
const loadStartedAt = performance.now();
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
    if (!stallReason) throw err;
    const stall = new Error(stallReason);
    stall.name = 'StallError';
    throw stall;
  } finally {
    clearTimeout(timer);
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
        modelBytes = await downloadModel(modelUrl, (fraction, bytes, total) => {
          const complete = fraction >= 1;
          reportProgress(
            complete ? 'downloaded' : 'downloading',
            Math.round(PCT.CACHE_DONE + (PCT.DOWNLOAD_DONE - PCT.CACHE_DONE) * fraction),
            { bytes, totalBytes: total || undefined },
          );
        });
      } else {
        // A provider retry reuses the bytes already in memory; no re-download.
        reportProgress('cache-hit', PCT.DOWNLOAD_DONE, { detail: 'model already in memory' });
      }
      reportProgress('creating-session', PCT.DOWNLOAD_DONE, { detail: 'provider ' + ep });
      session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
      });
      lastProvider = ep;
      if (ep === 'webgpu') adapterLabel = describeAdapter();
      // Once every candidate has been tried, drop the bytes so we don't hold a
      // second 185 MB copy in JS while ORT keeps its own (matters on low-RAM).
      if (ep === providers[providers.length - 1]) modelBytes = null;
      reportProgress('session-ready', PCT.SESSION_DONE, { detail: ep });
      return ep;
    } catch (err) {
      session?.release?.();
      session = null;
      lastError = err;
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
      modelUrl = msg.modelUrl;
      if (msg.inputSize) MODEL_SIZE = msg.inputSize;
      if (typeof msg.outputIsProbability === 'boolean') {
        outputIsProbability = msg.outputIsProbability;
      }
      reportProgress('queued', PCT.START);
      // Only attempt WebGPU if the browser actually exposes it AND the adapter
      // is one we have validated (see VALIDATED_WEBGPU_SUBSTRINGS). An
      // unvalidated GPU can silently produce a wrong mask, so the WASM fallback
      // wouldn't fire. `?provider=webgpu` still forces it as an opt-in.
      const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
      const forced = msg.forceProvider;
      let candidates;
      if (forced) {
        candidates = [forced];
      } else if (hasWebGPU && webgpuValidated()) {
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
      post({ kind: 'load-time', ms: totalMs, provider: ep, adapter: adapterLabel });
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
      post({ kind: 'result-ready', mask: result.mask, width: msg.width, height: msg.height });
      post({ kind: 'inference-time', ms: result.timeMs, runId: msg.runId });
      return;
    }
    if (msg.kind === 'dispose') {
      await session?.release?.();
      session = null;
    }
  } catch (err) {
    post({
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
      runId: msg.kind === 'run' ? msg.runId : undefined,
      fatal: msg.kind === 'set-model',
    });
  }
};
