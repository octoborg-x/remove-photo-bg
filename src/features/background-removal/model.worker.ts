// Inference worker. Runs onnxruntime-web (WASM/WebGPU) inside a Web Worker so
// inference never blocks the main thread.
import * as ort from 'onnxruntime-web';
import type { MainToWorkerMessage, WorkerProgressMessage } from './types';

ort.env.wasm.wasmPaths = '/wasm/';
// On battery-saver laptops the default adapter is often the integrated GPU, which
// cannot fit this model's 411 MB intermediate tensors. Ask for the discrete GPU.
if (ort.env.webgpu) ort.env.webgpu.powerPreference = 'high-performance';

let session: ort.InferenceSession | null = null;
let lastProvider = 'none';
let modelUrl: string | null = null;
let lastError: unknown = null;
let adapterLabel = '';

function post(msg: WorkerProgressMessage): void {
  self.postMessage(msg);
}

const MODEL_SIZE = 1024;

// ORT reports provider allocation failures as bare C++ text (e.g.
// "failed to call OrtRun(). ERROR_CODE: 6, ERROR_MESSAGE: std::bad_alloc").
// BiRefNet's decoder allocates 411 MB tensors, so an under-provisioned GPU
// device fails here rather than at session creation.
const ALLOC_FAILURE =
  /bad_alloc|out of memory|outofmemory|allocation failed|allocation error|exceeds the (max|buffer)/i;

// A lost device and a dead adapter surface as these strings.
const DEVICE_LOST =
  /device (was )?lost|device removed|adapter (was )?lost|context lost|GPUDevice/i;

function isProviderFailure(err: unknown): boolean {
  // A timed-out run never settled, so switching providers is the only way
  // forward. It is flagged by name rather than matched as text.
  if (err instanceof Error && err.name === 'ProviderTimeoutError') return true;
  const text = err instanceof Error ? err.message : String(err);
  return ALLOC_FAILURE.test(text) || DEVICE_LOST.test(text);
}

async function createSession(
  providers: ort.InferenceSession.ExecutionProviderName[],
): Promise<void> {
  for (const ep of providers) {
    try {
      session = await ort.InferenceSession.create(modelUrl!, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
      });
      lastProvider = ep;
      if (ep === 'webgpu') adapterLabel = describeAdapter();
      return;
    } catch (err) {
      lastError = err;
      session?.release();
      session = null;
    }
  }
  throw lastError ?? new Error(`No available execution provider (tried: ${providers.join(', ')})`);
}

type AdapterLike = {
  info?: Record<string, string>;
  limits?: { maxStorageBufferBindingSize?: number };
  features?: Set<string>;
};

function adapterInfo(): AdapterLike | undefined {
  return ort.env.webgpu?.adapter as AdapterLike | undefined;
}

function gpuFeatures(): string[] {
  const features = adapterInfo()?.features;
  return features ? Array.from(features) : [];
}

// Adapter name/limits/features make memory and precision failures diagnosable
// from the page log.
function describeAdapter(): string {
  const adapter = adapterInfo();
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
}

// A WebGPU run that never settles leaves the UI with no output and no error, so
// bound it. The GPU should finish in seconds; the WASM fallback legitimately
// takes many minutes, so no watchdog is applied there.
const FIRST_WEBGPU_TIMEOUT_MS = 180000;
const WEBGPU_TIMEOUT_MS = 120000;
let webgpuRunCount = 0;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.name = 'ProviderTimeoutError';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runInference(
  tensor: Float32Array,
): Promise<{ mask: Float32Array; timeMs: number }> {
  const feeds = {
    input_image: new ort.Tensor('float32', tensor, [1, 3, MODEL_SIZE, MODEL_SIZE]),
  };
  const t0 = performance.now();
  try {
    const run = session!.run(feeds);
    let results;
    if (lastProvider === 'webgpu') {
      const limit =
        webgpuRunCount === 0 ? FIRST_WEBGPU_TIMEOUT_MS : WEBGPU_TIMEOUT_MS;
      webgpuRunCount++;
      try {
        results = await withTimeout(
          run,
          limit,
          `WebGPU run did not finish in ${limit / 1000}s (device lost, or the shader stalled)`,
        );
      } catch (err) {
        // Race() leaves the GPU run pending; swallow its eventual rejection.
        run.catch(() => {});
        throw err;
      }
    } else {
      results = await run;
    }
    const timeMs = performance.now() - t0;

    const out = results.output_image.data as Float32Array;
    // output_image is [1, 1, 1024, 1024] logits (fp32 raw conv output). The
    // activation (sigmoid) is applied on the main thread.
    const mask = new Float32Array(out);
    return { mask, timeMs };
  } finally {
    feeds.input_image.dispose?.();
  }
}

self.onmessage = async (e: MessageEvent<MainToWorkerMessage>) => {
  const msg = e.data;
  try {
    if (msg.kind === 'set-model') {
      modelUrl = msg.modelUrl;
      post({ kind: 'loading-model', at: 10 });
      // Only attempt WebGPU if the browser actually exposes it (feature-detect).
      // In bare headless/WASM environments this avoids poisoning the WASM fallback.
      const hasWebGPU =
        typeof (self as unknown as { navigator?: { gpu?: unknown } }).navigator?.gpu !== 'undefined';
      const forced = msg.forceProvider as
        | ort.InferenceSession.ExecutionProviderName
        | undefined;
      await createSession(forced ? [forced] : hasWebGPU ? ['webgpu', 'wasm'] : ['wasm']);
      if (lastProvider === 'webgpu' && !gpuFeatures().includes('shader-f16')) {
        post({
          kind: 'adapter-warning',
          message:
            'this GPU does not support shader-f16, but the model is float16. ' +
            'WebGPU will be slow or may stall; use ?provider=wasm to force the CPU.',
        });
      }
      post({ kind: 'loading-model', at: 90 });
      post({ kind: 'load-time', ms: 0, provider: lastProvider, adapter: adapterLabel });
      return;
    }
    if (msg.kind === 'run') {
      if (!session) throw new Error('Model not loaded');
      let result;
      try {
        result = await runInference(msg.tensor);
      } catch (err) {
        if (lastProvider !== 'webgpu' || !isProviderFailure(err)) throw err;
        // The GPU could not hold this model's intermediate tensors. Rebuild the
        // session on the CPU provider and retry once so the user still gets a result.
        post({
          kind: 'provider-fallback',
          from: 'webgpu',
          to: 'wasm',
          reason: err instanceof Error ? err.message : String(err),
        });
        await session?.release();
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
      await session?.release();
      session = null;
    }
  } catch (error) {
    post({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      runId: msg.kind === 'run' ? msg.runId : undefined,
      fatal: msg.kind === 'set-model',
    });
  }
};
