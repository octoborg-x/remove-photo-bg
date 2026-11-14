// Regression guard for the "ghost image" failure mode: a mask squashed into the
// middle band (the double-sigmoid fingerprint, ≈[0.5,0.73]) must be flagged.
//
// This drives a synthetic NON-BIMODAL mask (mean ~0.6) through the REAL worker
// (public/inference-worker.js loaded with a mocked `ort`), so it asserts both
// halves of the guard: the pure heuristic (maskStats/isSuspiciousMask) AND that
// the worker actually posts an `adapter-warning` + marks the result suspect.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { maskStats, isSuspiciousMask } from './mask-stats';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKER_SRC = readFileSync(resolve(ROOT, 'public/inference-worker.js'), 'utf8');
const MODEL_BYTES = 1_500_000; // > MIN_MODEL_BYTES (1 MiB) so size validation passes

/** A squashed mask: every pixel in [0.5, 0.7], so the mean is ~0.6 and neither
 *  tail (below 0.1 / above 0.9) is populated — the "ghost" fingerprint. */
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

type WorkerMessage = {
  kind: string;
  maskSuspect?: boolean;
  maskStats?: { mean: number; lowFraction: number; highFraction: number };
};

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

describe('a squashed (non-bimodal) mask is flagged, not silently composited', () => {
  it('maskStats reports mean ~0.6 with empty tails and the heuristic flags it', () => {
    const stats = maskStats(squashedMask());
    expect(stats.mean).toBeGreaterThan(0.55);
    expect(stats.mean).toBeLessThan(0.65);
    expect(stats.lowFraction).toBe(0); // nothing below 0.1
    expect(stats.highFraction).toBe(0); // nothing above 0.9
    expect(isSuspiciousMask(stats)).toBe(true);
  });

  it('the worker posts an adapter-warning and marks the result suspect', async () => {
    const w = makeWorker(squashedMask());

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

    const warning = w.posted.find((m) => m.kind === 'adapter-warning');
    expect(warning).toBeDefined();
    expect(warning?.kind === 'adapter-warning').toBe(true);

    const result = w.posted.find((m) => m.kind === 'result-ready');
    expect(result?.maskSuspect).toBe(true);
    expect(result?.maskStats?.mean).toBeCloseTo(0.6, 1);
  });

  it('does not warn for a healthy bimodal mask of the same mean', async () => {
    // Same ~0.6 mean, but genuinely bimodal (60% at 0, 40% at 1).
    const n = 512 * 512;
    const healthy = new Float32Array(n);
    for (let i = 0; i < n; i++) healthy[i] = i < n * 0.6 ? 0 : 1;
    const w = makeWorker(healthy);

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

    expect(w.posted.some((m) => m.kind === 'adapter-warning')).toBe(false);
    expect(w.posted.find((m) => m.kind === 'result-ready')?.maskSuspect).toBe(false);
  });
});
