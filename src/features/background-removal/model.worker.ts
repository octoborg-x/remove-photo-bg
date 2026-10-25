// Inference worker. Runs onnxruntime-web (WASM/WebGPU) inside a Web Worker so
// inference never blocks the main thread.
import * as ort from 'onnxruntime-web';
import type { MainToWorkerMessage, WorkerProgressMessage } from './types';

ort.env.wasm.wasmPaths = '/wasm/';

let session: ort.InferenceSession | null = null;
let lastProvider = 'none';

function post(msg: WorkerProgressMessage): void {
  self.postMessage(msg);
}

const MODEL_SIZE = 1024;

async function createSession(modelUrl: string): Promise<void> {
  post({ kind: 'loading-model', at: 10 });
  // Only attempt WebGPU if the browser actually exposes it (feature-detect).
  // In bare headless/WASM environments this avoids poisoning the WASM fallback.
  const hasWebGPU = typeof (self as unknown as { navigator?: { gpu?: unknown } }).navigator?.gpu !== 'undefined';
  const candidates: ort.InferenceSession.ExecutionProviderName[] = hasWebGPU
    ? ['webgpu', 'wasm']
    : ['wasm'];
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
      session?.release();
      session = null;
    }
  }
  // Final fallback: let ORT pick.
  session = await ort.InferenceSession.create(modelUrl, {
    executionProviders: candidates,
    graphOptimizationLevel: 'all',
  });
  lastProvider = 'wasm';
}

async function runInference(
  tensor: Float32Array,
): Promise<{ mask: Float32Array; timeMs: number }> {
  const feeds = {
    input_image: new ort.Tensor('float32', tensor, [1, 3, MODEL_SIZE, MODEL_SIZE]),
  };
  const t0 = performance.now();
  const results = await session!.run(feeds);
  const timeMs = performance.now() - t0;

  const out = results.output_image.data as Float32Array;
  // output_image is [1, 1, 1024, 1024] logits (fp32 raw conv output). The
  // activation (sigmoid) is applied on the main thread.
  const mask = new Float32Array(out);
  return { mask, timeMs };
}

self.onmessage = async (e: MessageEvent<MainToWorkerMessage>) => {
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
      await session?.release();
      session = null;
    }
  } catch (error) {
    post({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};