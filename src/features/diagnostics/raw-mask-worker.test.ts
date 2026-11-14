// End-to-end guard for the "ghost image" failure mode.
//
// The worker must hand the main thread the model's ORIGINAL floating-point mask
// (unmodified), and the main thread must flag a squashed (non-bimodal) mask
// instead of compositing it silently. This drives a synthetic NON-BIMODAL mask
// (mean ~0.6, the double-sigmoid fingerprint) through the REAL worker
// (public/inference-worker.js with a mocked `ort`) and asserts that the mask the
// worker delivers trips the main-thread guard — proving the diagnostic path sees
// what the model actually produced.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rawMaskStats, isSuspectRawMask } from './raw-mask-stats';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKER_SRC = readFileSync(resolve(ROOT, 'public/inference-worker.js'), 'utf8');
const MODEL_BYTES = 1_500_000; // > MIN_MODEL_BYTES (1 MiB) so size validation passes

/** A squashed mask: every pixel in [0.5, 0.7], so the mean is ~0.6 and neither
 *  tail is populated — the "ghost" fingerprint. */
function squashedMask(n = 512 * 512): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 + (0.7 - 0.5) * (i / (n - 1));
  return out;
}

function fakeResponse(size: number) {
  const chunk = new Uint8Array(size);
  let sent = false;
  return {
    ok: true,
    status: 200,
    headers: {
      get: (k: string) => {
        const key = k.toLowerCase();
        if (key === 'content-length') return String(size);
        if (key === 'content-type') return 'application/octet-stream';
        return null;
      },
    },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: chunk };
        },
      }),
    },
  };
}

type WorkerMessage = { kind: string; mask?: Float32Array };

function makeWorker(maskData: Float32Array) {
  const posted: WorkerMessage[] = [];
  const ort = {
    env: { wasm: {} as Record<string, unknown>, webgpu: {} as Record<string, unknown> },
    Tensor: class {
      dispose() {}
    },
    InferenceSession: {
      create: async () => ({
        run: async () => ({ output_image: { data: maskData } }),
        release: async () => {},
      }),
    },
  };
  const selfMock = {
    location: { href: 'http://localhost/inference-worker.js' },
    postMessage: (m: WorkerMessage) => posted.push(m),
    onmessage: undefined as ((e: { data: unknown }) => void) | undefined,
  };
  const load = new Function(
    'self',
    'ort',
    'navigator',
    'fetch',
    'performance',
    'URL',
    'AbortController',
    'setTimeout',
    'clearTimeout',
    WORKER_SRC.replace(/^\s*importScripts\([^)]*\);\s*$/m, ''),
  );
  load(
    selfMock,
    ort,
    { hardwareConcurrency: 4 }, // no GPU -> wasm provider
    async () => fakeResponse(MODEL_BYTES),
    performance,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
  );
  const send = (msg: unknown) => selfMock.onmessage?.({ data: msg });
  const waitFor = (kind: string) =>
    new Promise<void>((resolvePromise) => {
      const tick = setInterval(() => {
        if (posted.some((m) => m.kind === kind || m.kind === 'error')) {
          clearInterval(tick);
          resolvePromise();
        }
      }, 5);
    });
  return { send, waitFor, posted };
}

async function runWith(mask: Float32Array): Promise<Float32Array> {
  const w = makeWorker(mask);
  w.send({
    kind: 'set-model',
    modelUrl: '/models/model.onnx',
    inputSize: 512,
    outputIsProbability: true,
    modelId: 'm',
  });
  await w.waitFor('load-time');
  w.send({ kind: 'run', tensor: new Float32Array(3 * 512 * 512), width: 512, height: 512, runId: 1 });
  await w.waitFor('result-ready');
  const result = w.posted.find((m) => m.kind === 'result-ready');
  if (!result?.mask) throw new Error('worker did not deliver a raw mask');
  return result.mask;
}

describe('a squashed (non-bimodal) mask is flagged, not silently composited', () => {
  it('the worker delivers the raw mask unmodified and the guard flags it', async () => {
    const mask = await runWith(squashedMask());
    // The worker must hand back the model output as-is (no re-squashing, no
    // re-normalisation on the way out).
    expect(mask.length).toBe(512 * 512);
    const stats = rawMaskStats(mask, 512, 512);
    expect(stats.mean).toBeGreaterThan(0.55);
    expect(stats.mean).toBeLessThan(0.65);
    expect(stats.below_01_fraction).toBe(0);
    expect(stats.above_095_fraction).toBe(0);
    expect(isSuspectRawMask(stats)).toBe(true);
  });

  it('a healthy bimodal mask of the same mean is NOT flagged', async () => {
    const n = 512 * 512;
    const healthy = new Float32Array(n);
    for (let i = 0; i < n; i++) healthy[i] = i < n * 0.6 ? 0 : 1;
    const mask = await runWith(healthy);
    const stats = rawMaskStats(mask, 512, 512);
    expect(isSuspectRawMask(stats)).toBe(false);
  });
});
