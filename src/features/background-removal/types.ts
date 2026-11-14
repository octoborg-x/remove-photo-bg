// A model as published by the generated manifest (public/models-manifest.json;
// see scripts/fetch-models.mjs). Single source of truth for the selector, the
// download URL, and the service worker's per-model cache bucket.
export interface ModelManifestEntry {
  id: string;
  /** Path served by this origin through the asset service worker, e.g. '/models/model_512_int8_fp16.onnx'. */
  file: string;
  /** Relative URL the inference worker fetches. */
  url: string;
  size: number;
  sha256: string;
  label: string;
  description?: string;
  inputSize: number;
  /** True when the graph applies its own sigmoid and the output is already [0,1]. */
  outputIsProbability: boolean;
  /** True when this is the default selection when no other criterion applies. */
  default?: boolean;
}

export interface ModelsManifest {
  version: number;
  models: ModelManifestEntry[];
}

// Shared message types between the main thread and the inference worker.
// Worker -> main

/** Named milestones during model loading, so the UI can show what is happening
 *  rather than only a percentage. */
export type LoadStage =
  | 'queued' // set-model received, about to start
  | 'runtime' // ONNX Runtime script/runtime is available
  | 'cache-check' // probing on-device storage for the model
  | 'cache-hit' // model found on this device; no network transfer needed
  | 'downloading' // streaming model bytes from the network
  | 'downloaded' // model bytes are in memory
  | 'creating-session' // ORT is building/optimizing the inference session
  | 'session-ready' // session built; provider chosen
  | 'ready'; // loading finished

export type WorkerProgressMessage =
  | {
      kind: 'loading-progress';
      stage: LoadStage;
      /** Overall progress, 0-100. */
      percent: number;
      /** Bytes transferred so far (downloading stage). */
      bytes?: number;
      /** Total bytes expected, when the server reported a content length. */
      totalBytes?: number;
      /** Milliseconds since loading began, for an elapsed-time readout. */
      elapsedMs: number;
      /** Optional human-readable detail, e.g. "from cache" or the provider. */
      detail?: string;
    }
  | {
      kind: 'load-time';
      ms: number;
      provider: string;
      adapter?: string;
      /** The manifest id the session was built for (e.g. 'model_512_int8_fp16'). */
      modelId?: string;
      /** Model download time, ms (0 on a cache hit / provider switch). */
      downloadMs?: number;
      /** Session build/optimize time, ms. */
      sessionInitMs?: number;
      /** True when a WebGPU session actually built (not merely that an adapter exists). */
      webgpuSessionInitialized?: boolean;
      /** Why a webgpu attempt fell back to WASM, or null. */
      fallbackReason?: string | null;
      /** Structured adapter facts for the copyable diagnostic report. */
      adapterDetails?: {
        vendor?: string | null;
        architecture?: string | null;
        device?: string | null;
        description?: string | null;
        features?: string[];
        maxStorageBufferBindingSize?: number | null;
        maxBufferSize?: number | null;
      } | null;
    }
  | { kind: 'provider-fallback'; from: string; to: string; reason: string }
  | { kind: 'adapter-warning'; message: string }
  | { kind: 'inference-time'; ms: number; runId: number }
  | {
      kind: 'result-ready';
      mask: Float32Array; // 1 x N x N probability mask [0,1]
      width: number; // original image width
      height: number; // original image height
      /** The model's square input size, so the main thread can upscale the mask correctly. */
      inputSize?: number;
      /** The run this mask belongs to, so the page can drop a superseded run's
       *  late result instead of letting it overwrite a newer job. */
      runId?: number;
    }
  | {
      kind: 'error';
      message: string;
      runId?: number;
      fatal?: boolean;
      /** True when the worker stopped deliberately (e.g. a metered-link cancel),
       *  so the page treats it as a pause rather than a failure. */
      cancelled?: boolean;
    };

// Main -> worker
export type MainToWorkerMessage =
  | {
      kind: 'set-model';
      modelUrl: string;
      inputSize?: number;
      outputIsProbability?: boolean;
      forceProvider?: string;
      /**
       * Manifest id of the model being loaded (for reporting + session reuse).
       */
      modelId?: string;
    }
  | {
      kind: 'run';
      runId: number;
      tensor: Float32Array; // [1, 3, N, N] NCHW normalized
      width: number;
      height: number;
    }
  | { kind: 'cancel-model'; reason?: string }
  | { kind: 'dispose' };
