import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Loads the real public/inference-worker.js into this Node process with a mocked
// `ort` runtime, so the model-load byte-reuse logic (the thing that decides
// whether a provider switch re-downloads the model) is exercised as real code
// rather than a re-implementation. The worker is a classic script: it reads
// `self`, calls `importScripts`, and posts via `self.postMessage`.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKER_SRC = readFileSync(resolve(ROOT, 'public/inference-worker.js'), 'utf8');

const MODEL_BYTES = 1_500_000; // > MIN_MODEL_BYTES (1 MiB) so size validation passes

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

type WorkerMessage = { kind: string; stage?: string };

function makeWorker({
  hasGpu,
  fetchMock: injectedFetch,
}: {
  hasGpu: boolean;
  fetchMock?: (url: string, opts: { signal: AbortSignal }) => Promise<unknown>;
}) {
  const posted: WorkerMessage[] = [];
  const fetchedUrls: string[] = [];
  const sessionsCreated: string[] = [];

  const ort = {
    env: { wasm: {} as Record<string, unknown>, webgpu: {} as Record<string, unknown> },
    Tensor: class {
      constructor() {}
    },
    InferenceSession: {
      create: async (_bytes: ArrayBuffer, opts: { executionProviders: string[] }) => {
        const ep = opts.executionProviders[0];
        sessionsCreated.push(ep);
        return { run: async () => ({ output: {} }), release: async () => {} };
      },
    },
  };

  const selfMock = {
    location: { href: 'http://localhost/inference-worker.js' },
    postMessage: (m: WorkerMessage) => posted.push(m),
    onmessage: undefined as ((e: { data: unknown }) => void) | undefined,
  };

  const navigatorMock = hasGpu ? { gpu: {}, hardwareConcurrency: 4 } : { hardwareConcurrency: 4 };
  const fetchMock =
    injectedFetch ??
    (async (url: string) => {
      fetchedUrls.push(url);
      return fakeResponse(MODEL_BYTES);
    });

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
    // Strip the runtime importScripts: `ort` is injected instead.
    WORKER_SRC.replace(/^\s*importScripts\([^)]*\);\s*$/m, ''),
  );
  load(
    selfMock,
    ort,
    navigatorMock,
    fetchMock,
    performance,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
  );

  const send = (msg: unknown) => selfMock.onmessage?.({ data: msg });
  const waitForLoad = () =>
    new Promise<void>((resolvePromise) => {
      const tick = setInterval(() => {
        if (posted.some((m) => m.kind === 'load-time' || m.kind === 'error')) {
          clearInterval(tick);
          resolvePromise();
        }
      }, 5);
    });

  return { send, waitForLoad, posted, fetchedUrls, sessionsCreated };
}

describe('inference worker — model byte reuse across provider switches', () => {
  it('does not re-download the model when only the provider changes', async () => {
    const w = makeWorker({ hasGpu: true });

    // First load: no forced provider, a GPU is present -> webgpu then wasm.
    w.send({ kind: 'set-model', modelUrl: '/models/model.onnx', inputSize: 512, outputIsProbability: true, modelId: 'm' });
    await w.waitForLoad();
    expect(w.fetchedUrls).toEqual(['/models/model.onnx']);

    // Provider switch: same URL, forced to wasm.
    w.send({ kind: 'set-model', modelUrl: '/models/model.onnx', inputSize: 512, outputIsProbability: true, modelId: 'm', forceProvider: 'wasm' });
    await w.waitForLoad();

    expect(w.fetchedUrls).toEqual(['/models/model.onnx']); // still a single fetch
    expect(w.posted.some((m) => m.kind === 'loading-progress' && m.stage === 'cache-hit')).toBe(true);
    expect(w.sessionsCreated).toEqual(['webgpu', 'wasm']);
  });

  it('stops the download on cancel-model and reports it as a non-fatal cancel', async () => {
    // A fetch that never resolves on its own, so the only way out is the abort.
    const hangingFetch = (_url: string, opts: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    const w = makeWorker({ hasGpu: false, fetchMock: hangingFetch });

    w.send({ kind: 'set-model', modelUrl: '/models/model.onnx', inputSize: 512, outputIsProbability: true, modelId: 'm' });
    await new Promise((r) => setTimeout(r, 20)); // let the download start
    w.send({ kind: 'cancel-model', reason: 'metered' });
    await w.waitForLoad();

    const err = w.posted.find((m) => m.kind === 'error') as
      | (WorkerMessage & { cancelled?: boolean; fatal?: boolean })
      | undefined;
    expect(err).toBeDefined();
    expect(err?.cancelled).toBe(true);
    expect(err?.fatal).toBe(true);
    // A cancelled load must not report success.
    expect(w.posted.some((m) => m.kind === 'load-time')).toBe(false);
  });

  it('re-downloads when the model URL actually changes', async () => {
    const w = makeWorker({ hasGpu: false });

    w.send({ kind: 'set-model', modelUrl: '/models/a.onnx', inputSize: 512, outputIsProbability: true, modelId: 'a' });
    await w.waitForLoad();
    w.send({ kind: 'set-model', modelUrl: '/models/b.onnx', inputSize: 512, outputIsProbability: true, modelId: 'b' });
    await w.waitForLoad();

    expect(w.fetchedUrls).toEqual(['/models/a.onnx', '/models/b.onnx']);
  });
});
