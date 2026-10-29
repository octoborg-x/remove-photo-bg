// Inference worker. Runs onnxruntime-web (WASM/WebGPU) inside a Web Worker so
// inference never blocks the main thread.
import * as ort from 'onnxruntime-web';
import type { LoadStage, MainToWorkerMessage, WorkerProgressMessage } from './types';

ort.env.wasm.wasmPaths = '/wasm/';
// On battery-saver laptops the default adapter is often the integrated GPU, which
// cannot fit this model's 411 MB intermediate tensors. Ask for the discrete GPU.
if (ort.env.webgpu) ort.env.webgpu.powerPreference = 'high-performance';

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
const VALIDATED_WEBGPU_SUBSTRINGS: string[] = [
  // e.g. 'radeon 780m', 'apple m2', 'intel iris xe — validated <date>'
];

function adapterSubstrings(): string {
  try {
    // Reuse the AdapterLike cast: ort.env.webgpu.adapter is TryGetGlobalType<'GPUAdapter'>,
    // which resolves to {} without @webgpu/types, so .info is not visible on it directly.
    const adapter = adapterInfo();
    if (!adapter) return '';
    const info = adapter.info ?? {};
    return [info.device, info.architecture, info.vendor, info.description]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  } catch {
    return '';
  }
}

function webgpuValidated(): boolean {
  const blob = adapterSubstrings();
  if (!blob) return false;
  return VALIDATED_WEBGPU_SUBSTRINGS.some((s) => blob.includes(s));
}

let session: ort.InferenceSession | null = null;
let lastProvider = 'none';
let modelUrl: string | null = null;
let lastError: unknown = null;
let adapterLabel = '';

function post(msg: WorkerProgressMessage): void {
  self.postMessage(msg);
}

// Mirrors the live worker (public/inference-worker.js): a shared clock plus a
// helper so every checkpoint carries a consistent elapsed time. NOTE: this
// module is currently unreferenced — the app uses the classic worker in
// public/inference-worker.js. Kept in sync so the two do not drift.
const loadStartedAt = performance.now();
let lastPercent = -1;

function reportProgress(
  stage: LoadStage,
  percent: number,
  extra: { bytes?: number; totalBytes?: number; detail?: string } = {},
): void {
  if (stage === 'downloading' && percent === lastPercent) return;
  lastPercent = percent;
  post({
    kind: 'loading-progress',
    stage,
    percent,
    elapsedMs: performance.now() - loadStartedAt,
    ...extra,
  });
}

let MODEL_SIZE = 512;
// The shipped 512 export applies sigmoid internally and returns probabilities;
// the older 1024 export returned raw logits.
let outputIsProbability = true;

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

// Downloads the model bytes ourselves so the UI can show real progress on
// slow mobile/cellular links (ORT's own fetch has no progress callback).
// Returns an ArrayBuffer; the session is then created from those bytes so the
// network transfer is not repeated when the worker retries a provider.
async function downloadModel(
  url: string,
  onProgress: (fraction: number, bytes: number) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download model: HTTP ${res.status}`);
  const totalReadable = Number(res.headers.get('content-length')) || 0;
  const reader = res.body?.getReader();
  if (!reader) {
    // No streaming body (e.g. a transform stripped it) — fall back to arrayBuffer.
    return await res.arrayBuffer();
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (totalReadable > 0) onProgress(Math.min(1, received / totalReadable), received);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}

let modelBytes: ArrayBuffer | null = null;

async function createSession(
  providers: ort.InferenceSession.ExecutionProviderName[],
): Promise<void> {
  for (const ep of providers) {
    try {
      if (!modelBytes) {
        reportProgress('cache-check', 15);
        modelBytes = await downloadModel(modelUrl!, (f, bytes) => {
          reportProgress(f >= 1 ? 'downloaded' : 'downloading', Math.round(15 + 75 * f), { bytes });
        });
      }
      reportProgress('creating-session', 90);
      session = await ort.InferenceSession.create(
        // Pass the bytes directly so a provider retry doesn't re-download.
        modelBytes!,
        {
          executionProviders: [ep],
          graphOptimizationLevel: 'all',
        },
      );
      lastProvider = ep;
      if (ep === 'webgpu') adapterLabel = describeAdapter();
      // If this was the last provider we will try, the bytes are no longer
      // needed for a fallback; drop them so we don't keep 185 MB in JS while
      // ORT holds its own copy in the WASM/GPU heap (matters on low-RAM mobile).
      if (ep === providers[providers.length - 1]) {
        modelBytes = null;
      }
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
    // Normalise to a [0,1] probability map so the main thread never has to know
    // whether this export emits logits or probabilities.
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

self.onmessage = async (e: MessageEvent<MainToWorkerMessage>) => {
  const msg = e.data;
  try {
    if (msg.kind === 'set-model') {
      modelUrl = msg.modelUrl;
      if (msg.inputSize) MODEL_SIZE = msg.inputSize;
      if (typeof msg.outputIsProbability === 'boolean') {
        outputIsProbability = msg.outputIsProbability;
      }
      reportProgress('queued', 0);
      // Only attempt WebGPU if the browser exposes it AND the adapter is one we
      // have validated. An unvalidated GPU can silently produce a wrong mask, so
      // the WASM fallback would never fire. `?provider=webgpu` still forces it.
      const hasWebGPU =
        typeof (self as unknown as { navigator?: { gpu?: unknown } }).navigator?.gpu !== 'undefined';
      const forced = msg.forceProvider as
        | ort.InferenceSession.ExecutionProviderName
        | undefined;
      const candidates: ort.InferenceSession.ExecutionProviderName[] = forced
        ? [forced]
        : hasWebGPU && webgpuValidated()
          ? ['webgpu', 'wasm']
          : ['wasm'];
      await createSession(candidates);
      if (lastProvider === 'webgpu' && !gpuFeatures().includes('shader-f16')) {
        post({
          kind: 'adapter-warning',
          message:
            'this GPU does not support shader-f16, but the model is float16. ' +
            'WebGPU will be slow or may stall; use ?provider=wasm to force the CPU.',
        });
      }
      reportProgress('ready', 100, { detail: lastProvider });
      post({ kind: 'load-time', ms: performance.now() - loadStartedAt, provider: lastProvider, adapter: adapterLabel });
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
