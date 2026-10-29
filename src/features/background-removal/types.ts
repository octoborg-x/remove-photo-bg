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
  | { kind: 'load-time'; ms: number; provider: string; adapter?: string }
  | { kind: 'provider-fallback'; from: string; to: string; reason: string }
  | { kind: 'adapter-warning'; message: string }
  | { kind: 'inference-time'; ms: number; runId: number }
  | {
      kind: 'result-ready';
      mask: Float32Array; // 1 x N x N probability mask [0,1]
      width: number; // original image width
      height: number; // original image height
    }
  | { kind: 'error'; message: string; runId?: number; fatal?: boolean };

// Main -> worker
export type MainToWorkerMessage =
  | {
      kind: 'set-model';
      modelUrl: string;
      inputSize?: number;
      outputIsProbability?: boolean;
      forceProvider?: string;
    }
  | {
      kind: 'run';
      runId: number;
      tensor: Float32Array; // [1, 3, N, N] NCHW normalized
      width: number;
      height: number;
    }
  | { kind: 'dispose' };
