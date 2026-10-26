// Shared message types between the main thread and the inference worker.
// Worker -> main
export type WorkerProgressMessage =
  | { kind: 'loading-model'; at: number; bytes?: number }
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
