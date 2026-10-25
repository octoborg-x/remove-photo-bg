// Phase 1 inference worker (classic worker).
//
// Loads onnxruntime-web through the legacy UMD bundle via importScripts so the
// WASM/JSEP loader files (under /wasm/) are NOT transformed by Vite's module
// pipeline (which refuses dynamic import() of /public files).
//
// Message protocol (see src/features/background-removal/types.ts):
//   in:  {kind:'set-model', modelUrl} | {kind:'run', tensor, width, height} | {kind:'dispose'}
//   out: {kind:'loading-model', at} | {kind:'load-time', ms, provider}
//        | {kind:'inference-time', ms} | {kind:'result-ready', mask, width, height}
//        | {kind:'error', message}
importScripts('/wasm/ort.all.min.js');

// The UMD bundle declares a top-level `var ort` (a global in this classic
// worker), so `ort` is available directly. Do NOT redeclare it.

ort.env.wasm.wasmPaths = '/wasm/';
// Use all available cores for the threaded WASM build.
if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
  ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency);
}

let session = null;
let lastProvider = 'none';
const MODEL_SIZE = 1024;

function post(msg) {
  self.postMessage(msg);
}

async function createSession(modelUrl) {
  post({ kind: 'loading-model', at: 10 });
  // Only attempt WebGPU if the browser actually exposes it.
  const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
  const candidates = hasWebGPU ? ['webgpu', 'wasm'] : ['wasm'];
  for (const ep of candidates) {
    try {
      session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
      });
      lastProvider = ep;
      post({ kind: 'loading-model', at: 90 });
      return;
    } catch {
      session?.release?.();
      session = null;
    }
  }
  throw new Error('No available execution provider (tried: ' + candidates.join(', ') + ')');
}

async function runInference(tensor) {
  const feeds = {
    input_image: new ort.Tensor('float32', tensor, [1, 3, MODEL_SIZE, MODEL_SIZE]),
  };
  const t0 = performance.now();
  const results = await session.run(feeds);
  const timeMs = performance.now() - t0;
  const out = results.output_image.data;
  // output_image is [1, 1, 1024, 1024] raw logits. Sigmoid is applied on the
  // main thread during post-processing.
  const mask = new Float32Array(out);
  return { mask, timeMs };
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.kind === 'set-model') {
      await createSession(msg.modelUrl);
      post({ kind: 'load-time', ms: 0, provider: lastProvider });
      return;
    }
    if (msg.kind === 'run') {
      if (!session) throw new Error('Model not loaded');
      const { mask, timeMs } = await runInference(msg.tensor);
      post({ kind: 'inference-time', ms: timeMs });
      post({ kind: 'result-ready', mask, width: msg.width, height: msg.height });
      return;
    }
    if (msg.kind === 'dispose') {
      await session?.release?.();
      session = null;
    }
  } catch (err) {
    post({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};