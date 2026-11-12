// Module worker that runs progressive refinement (Stages 2-4) off the main
// thread. Bundled by Vite as a module worker — it imports only pure TS modules
// and never touches onnxruntime, so it does not conflict with the classic
// inference worker's hard "load /wasm as a static file" constraint.
//
// Protocol (see refinement-client.ts):
//   in:  { kind: 'refine', jobId, guide, mask, maskWidth, maskHeight,
//          width, height, config }
//        | { kind: 'cancel', jobId }
//   out: { kind: 'progress', jobId, stage, fraction }
//        | { kind: 'done', jobId, alpha, timings }
//        | { kind: 'error', jobId, message }
//        | { kind: 'cancelled', jobId }
//
// Only one job runs at a time. A newer `refine` (or an explicit `cancel`) marks
// the running job superseded; because the guided filter yields to the event loop
// between chunks, the pending message is processed and the running job stops at
// the next chunk boundary. The page also guards by jobId, so a late result can
// never be mistaken for the current one.

import { refineMask } from './refine-mask';
import type { FastRefinementConfig } from './refinement-config';

interface RefineMessage {
  kind: 'refine';
  jobId: number;
  guide: Float32Array;
  mask: Float32Array;
  maskWidth: number;
  maskHeight: number;
  width: number;
  height: number;
  config: FastRefinementConfig;
}

interface CancelMessage {
  kind: 'cancel';
  jobId: number;
}

type InMessage = RefineMessage | CancelMessage;

let activeJobId = 0;

/** A macrotask yield so a queued `refine`/`cancel` message can be delivered. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

self.onmessage = (e: MessageEvent<InMessage>) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.kind === 'cancel') {
    // Only a cancel for the running job supersedes it.
    if (msg.jobId === activeJobId) activeJobId = -1;
    return;
  }
  if (msg.kind !== 'refine') return;
  activeJobId = msg.jobId;
  void run(msg);
};

async function run(msg: RefineMessage): Promise<void> {
  const { jobId } = msg;
  try {
    const result = await refineMask(
      {
        mask: msg.mask,
        maskWidth: msg.maskWidth,
        maskHeight: msg.maskHeight,
        width: msg.width,
        height: msg.height,
        guide: msg.guide,
        config: msg.config,
      },
      {
        onProgress: (stage, fraction) => {
          self.postMessage({ kind: 'progress', jobId, stage, fraction });
        },
        checkCancelled: async () => {
          await yieldToEventLoop();
          if (activeJobId !== jobId) throw new CancelledError();
        },
      },
    );
    if (activeJobId !== jobId) throw new CancelledError();
    // Transfer the alpha buffer (zero-copy) so a large mask does not cost a
    // structured clone.
    self.postMessage({ kind: 'done', jobId, alpha: result.alpha, timings: result.timings }, [
      result.alpha.buffer,
    ]);
  } catch (err) {
    if (err instanceof CancelledError || activeJobId !== jobId) {
      self.postMessage({ kind: 'cancelled', jobId });
      return;
    }
    self.postMessage({
      kind: 'error',
      jobId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}
