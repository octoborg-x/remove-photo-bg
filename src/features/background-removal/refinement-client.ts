// Main-thread client for progressive refinement.
//
// Runs Stages 2-4 in a dedicated module worker (refinement-worker.ts) when the
// browser supports one, and falls back to the identical pure `refineMask` on the
// main thread otherwise (feature-detected). Either way the caller gets progress
// callbacks, can cancel by job id, and is guaranteed exactly one terminal
// outcome. A stale result (an older job's late reply) is dropped by job id.

import { refineMask, type RefineTimings } from './refine-mask';
import type { FastRefinementConfig } from './refinement-config';

export interface RefineRequest {
  jobId: number;
  guide: Float32Array;
  mask: Float32Array;
  maskWidth: number;
  maskHeight: number;
  width: number;
  height: number;
  config: FastRefinementConfig;
  onProgress?: (stage: 'upscale' | 'refine' | 'cleanup', fraction: number) => void;
}

export interface RefineOutcome {
  jobId: number;
  /** Refined soft alpha at the original image dimensions. */
  alpha: Float32Array;
  timings: RefineTimings;
}

/** True when a dedicated module worker can be constructed. */
export function refinementWorkerSupported(): boolean {
  if (typeof Worker === 'undefined' || typeof URL === 'undefined') return false;
  let url: string | null = null;
  try {
    // A module worker requires the `type: 'module'` option; older engines ignore
    // it (making the worker a classic script that cannot use `import`), so this
    // probe keeps the main-thread fallback honest.
    url = URL.createObjectURL(new Blob(['export {};'], { type: 'text/javascript' }));
    const probe = new Worker(url, { type: 'module' });
    probe.terminate();
    return true;
  } catch {
    return false;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

/**
 * Runs refinement for `req`. Resolves with the refined alpha, or with
 * `{ cancelled: true }` when the job was superseded before it finished. Rejects
 * only on a genuine failure.
 */
export class RefinementRunner {
  private worker: Worker | null = null;
  private workerBroken = false;
  private pending: {
    jobId: number;
    resolve: (r: RefineOutcome | { jobId: number; cancelled: true }) => void;
    reject: (e: Error) => void;
    req: RefineRequest;
  } | null = null;

  private ensureWorker(): Worker | null {
    if (this.workerBroken) return null;
    if (this.worker) return this.worker;
    try {
      const worker = new Worker(new URL('./refinement-worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (e: MessageEvent) => this.onWorkerMessage(e);
      worker.onerror = (e) => this.onWorkerError(new Error(e.message || 'Refinement worker failed'));
      this.worker = worker;
      return worker;
    } catch {
      this.workerBroken = true;
      return null;
    }
  }

  private onWorkerMessage(e: MessageEvent): void {
    const msg = e.data as {
      kind: string;
      jobId: number;
      stage?: 'upscale' | 'refine' | 'cleanup';
      fraction?: number;
      alpha?: Float32Array;
      timings?: RefineTimings;
      message?: string;
    };
    const pending = this.pending;
    // A message for a superseded job is dropped.
    if (!pending || msg.jobId !== pending.jobId) return;
    if (msg.kind === 'progress' && msg.stage) {
      pending.req.onProgress?.(msg.stage, msg.fraction ?? 0);
    } else if (msg.kind === 'done' && msg.alpha && msg.timings) {
      this.pending = null;
      pending.resolve({ jobId: msg.jobId, alpha: msg.alpha, timings: msg.timings });
    } else if (msg.kind === 'cancelled') {
      this.pending = null;
      pending.resolve({ jobId: msg.jobId, cancelled: true });
    } else if (msg.kind === 'error') {
      this.pending = null;
      pending.reject(new Error(msg.message || 'Refinement failed'));
    }
  }

  private onWorkerError(err: Error): void {
    // A worker-level failure invalidates the worker; the pending job falls back
    // to the main-thread path rather than failing the whole run.
    this.workerBroken = true;
    try {
      this.worker?.terminate();
    } catch {
      /* already gone */
    }
    this.worker = null;
    const pending = this.pending;
    if (pending) {
      this.pending = null;
      void this.runOnMainThread(pending.req).then(pending.resolve, pending.reject);
    }
    void err;
  }

  private async runOnMainThread(
    req: RefineRequest,
  ): Promise<RefineOutcome | { jobId: number; cancelled: true }> {
    const cancelled = { cancelled: true as const };
    try {
      const result = await refineMask(
        {
          mask: req.mask,
          maskWidth: req.maskWidth,
          maskHeight: req.maskHeight,
          width: req.width,
          height: req.height,
          guide: req.guide,
          config: req.config,
        },
        {
          onProgress: (stage, fraction) => req.onProgress?.(stage, fraction),
          checkCancelled: () => {
            if (this.currentJobId !== req.jobId) throw new Error('superseded');
          },
        },
      );
      return { jobId: req.jobId, alpha: result.alpha, timings: result.timings };
    } catch (err) {
      if (err instanceof Error && err.message === 'superseded') return { jobId: req.jobId, ...cancelled };
      throw err;
    }
  }

  private currentJobId = 0;

  /**
   * Refines `req`. Supersedes any in-flight job (which resolves as cancelled).
   * `useWorker: false` (or an unsupported/broken worker) runs on the main thread.
   */
  async refine(req: RefineRequest): Promise<RefineOutcome | { jobId: number; cancelled: true }> {
    this.cancel();
    this.currentJobId = req.jobId;
    const worker = req.config.performance.useWorker ? this.ensureWorker() : null;
    if (!worker) return this.runOnMainThread(req);
    return new Promise((resolve, reject) => {
      this.pending = { jobId: req.jobId, resolve, reject, req };
      worker.postMessage(
        {
          kind: 'refine',
          jobId: req.jobId,
          guide: req.guide,
          mask: req.mask,
          maskWidth: req.maskWidth,
          maskHeight: req.maskHeight,
          width: req.width,
          height: req.height,
          config: req.config,
        },
        [req.guide.buffer, req.mask.buffer],
      );
    });
  }

  /** Marks the current job superseded. A running worker job stops at its next
   *  chunk boundary and replies `cancelled`. */
  cancel(): void {
    this.currentJobId = 0;
    if (this.pending) {
      const jobId = this.pending.jobId;
      this.worker?.postMessage({ kind: 'cancel', jobId });
    }
  }

  /** Releases the worker. Safe to call repeatedly. */
  dispose(): void {
    this.cancel();
    try {
      this.worker?.terminate();
    } catch {
      /* already gone */
    }
    this.worker = null;
  }
}
