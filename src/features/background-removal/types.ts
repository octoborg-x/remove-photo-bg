// Shared message types between the main thread and the inference worker.
// Worker -> main
export type WorkerProgressMessage =
  | { kind: 'loading-model'; at: number }
  | { kind: 'load-time'; ms: number; provider: string }
  | { kind: 'inference-time'; ms: number }
  | {
      kind: 'result-ready';
      mask: Float32Array; // 1 x 1024 x 1024 soft mask [0,1]
      width: number; // original image width
      height: number; // original image height
    }
  | { kind: 'error'; message: string };

// Main -> worker
export type MainToWorkerMessage =
  | { kind: 'set-model'; modelUrl: string }
  | {
      kind: 'run';
      tensor: Float32Array; // [1, 3, 1024, 1024] NCHW normalized
      width: number;
      height: number;
    }
  | { kind: 'dispose' };