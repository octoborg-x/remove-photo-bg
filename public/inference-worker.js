// Phase 1 inference worker (classic worker).
//
// Loads onnxruntime-web through the legacy UMD bundle via importScripts so the
// WASM/JSEP loader files (under /wasm/) are NOT transformed by Vite's module
// pipeline (which refuses dynamic import() of /public files).
//
// Message protocol (see src/features/background-removal/types.ts):
//   in:  {kind:'set-model', modelUrl} | {kind:'run', runId, tensor, width, height} | {kind:'dispose'}
//   out: {kind:'loading-model', at} | {kind:'load-time', ms, provider, adapter}
//        | {kind:'provider-fallback', from, to, reason}
//        | {kind:'inference-time', ms, runId} | {kind:'result-ready', mask, width, height}
//        | {kind:'error', message, runId?, fatal?}
importScripts('/wasm/ort.all.min.js');

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

async function createSession(providers) {
  for (const ep of providers) {
    try {
      session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
      });
      lastProvider = ep;
      if (ep === 'webgpu') adapterLabel = describeAdapter();
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
      post({ kind: 'loading-model', at: 10 });
      // Only attempt WebGPU if the browser actually exposes it. `?provider=wasm`
      // forces the CPU path, which is the escape hatch when a GPU driver stalls.
      const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
      const forced = msg.forceProvider;
      const candidates = forced ? [forced] : hasWebGPU ? ['webgpu', 'wasm'] : ['wasm'];
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
      post({ kind: 'loading-model', at: 90 });
      post({ kind: 'load-time', ms: 0, provider: ep, adapter: adapterLabel });
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
