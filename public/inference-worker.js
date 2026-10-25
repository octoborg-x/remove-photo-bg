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
const MODEL_SIZE = 1024;

function post(msg) {
  self.postMessage(msg);
}

// ORT reports provider allocation failures as bare C++ text (e.g.
// "failed to call OrtRun(). ERROR_CODE: 6, ERROR_MESSAGE: std::bad_alloc").
// BiRefNet's decoder allocates 411 MB tensors, so an under-provisioned GPU
// device fails here rather than at session creation.
const ALLOC_FAILURE = /bad_alloc|out of memory|outofmemory|allocation failed|allocation error|exceeds the (max|buffer)/i;

function isAllocationFailure(err) {
  return ALLOC_FAILURE.test(err instanceof Error ? err.message : String(err));
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

// Adapter name/limits make memory failures diagnosable from the page log.
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
    return (name || 'unknown adapter') + maxBuf;
  } catch {
    return '';
  }
}

async function runInference(tensor) {
  const feeds = {
    input_image: new ort.Tensor('float32', tensor, [1, 3, MODEL_SIZE, MODEL_SIZE]),
  };
  const t0 = performance.now();
  try {
    const results = await session.run(feeds);
    const timeMs = performance.now() - t0;
    const out = results.output_image.data;
    // output_image is [1, 1, 1024, 1024] raw logits. Sigmoid is applied on the
    // main thread during post-processing.
    const mask = new Float32Array(out);
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
      post({ kind: 'loading-model', at: 10 });
      // Only attempt WebGPU if the browser actually exposes it.
      const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
      const ep = await createSession(hasWebGPU ? ['webgpu', 'wasm'] : ['wasm']);
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
        if (lastProvider !== 'webgpu' || !isAllocationFailure(err)) throw err;
        // The GPU could not hold this model's intermediate tensors. Rebuild the
        // session on the CPU provider and retry once so the user still gets a result.
        const reason = err instanceof Error ? err.message : String(err);
        post({ kind: 'provider-fallback', from: 'webgpu', to: 'wasm', reason });
        await session?.release?.();
        session = null;
        await createSession(['wasm']);
        result = await runInference(msg.tensor);
      }
      post({ kind: 'inference-time', ms: result.timeMs, runId: msg.runId });
      post({ kind: 'result-ready', mask: result.mask, width: msg.width, height: msg.height });
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
