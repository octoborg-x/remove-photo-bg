// A GPU run that aborts mid-execution must never be retried inside the worker
// that just aborted it: `ort.all.min.js` bundles WebGPU (JSEP) and WASM into ONE
// wasm module instance per worker, so a WASM session rebuilt there can inherit a
// corrupted module and silently return a numerically wrong (flat, washed-out)
// mask. `model-output-contract.test.ts` pins the WORKER half of that contract
// (the run handler posts `provider-restart` and never calls `createSession` a
// second time). This file pins the MAIN-THREAD half, which nothing covered: the
// page must actually discard the aborted worker and continue on a brand-new one
// pinned to the CPU, reusing the failed run's id so its pending promise settles.
//
// Source-level, like `single-inference-worker.test.ts`, so it runs in CI with no
// GPU (a real WebGPU run can never start in the sandbox, so the path cannot be
// exercised end to end here).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..');
const MAIN = readFileSync(resolve(ROOT, 'src/main.ts'), 'utf8');

/** The body of a top-level function, from its declaration to the next one. */
function functionBody(source: string, declaration: string, nextDeclaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `missing declaration: ${declaration}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(nextDeclaration, start);
  expect(end, `missing following declaration: ${nextDeclaration}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

const RESTART = functionBody(MAIN, 'async function restartOnFreshWorker(', 'function finishedRun(');
const CREATE_WORKER = functionBody(MAIN, 'function createInferenceWorker(', 'function handleWorkerMessage(');
const HANDLE = functionBody(MAIN, 'function handleWorkerMessage(', '// Progressive-refinement state');

describe('a failed GPU run is retried on a FRESH worker, never in the aborted one', () => {
  it('routes the worker’s provider-restart signal to the fresh-worker path', () => {
    expect(HANDLE).toMatch(/msg\.kind === 'provider-restart'/);
    expect(HANDLE).toMatch(/restartOnFreshWorker\(msg\)/);
  });

  it('constructs the inference worker in exactly one place', () => {
    // One factory, so the normal boot and the fallback cannot drift; and it is
    // the only site that instantiates the inference worker script.
    const factory = MAIN.match(/function createInferenceWorker\s*\(/g) ?? [];
    expect(factory.length).toBe(1);
    const instantiations = MAIN.match(/new Worker\(\s*'\/inference-worker\.js'/g) ?? [];
    expect(instantiations.length).toBe(1);
    expect(CREATE_WORKER).toMatch(/new Worker\(\s*'\/inference-worker\.js'/);
  });

  it('discards the aborted worker BEFORE building its replacement', () => {
    // Ordering matters: terminate the old worker (and its ORT module) first, or
    // the replacement would briefly coexist with the corrupted one.
    const terminateAt = RESTART.search(/worker\??\.terminate\(\)/);
    expect(terminateAt).toBeGreaterThanOrEqual(0);
    const recreateAt = RESTART.search(/worker = createInferenceWorker\(\)/);
    expect(recreateAt).toBeGreaterThan(terminateAt);
    // The old handle is dropped, so nothing can post to the aborted worker.
    expect(RESTART).toMatch(/worker = null/);
  });

  it('pins the retry to the CPU with a one-shot override that the next load consumes', () => {
    expect(RESTART).toMatch(/overrideProvider\s*=/);
    expect(RESTART).toMatch(/to === 'webgpu' \? 'webgpu' : 'wasm'/);
    // The override is read by loadSelectedModel and cleared there, so the user's
    // own provider choice governs every later load (no permanent CPU pin).
    expect(MAIN).toMatch(/if \(overrideProvider\) return overrideProvider;/);
    expect(MAIN).toMatch(/overrideProvider = null;/);
  });

  it('re-runs the SAME failed run id so the caller’s pending promise settles', () => {
    // runOneInference stores the promise under runId; the retry must reuse it or
    // runSmoke would hang forever on a run that never resolves.
    expect(RESTART).toMatch(/postRunMessage\(msg\.runId, currentImageData\)/);
    expect(RESTART).toMatch(/if \(!pendingRuns\.has\(msg\.runId\)/);
    expect(RESTART).toMatch(/await waitForModel\(\)/);
  });

  it('leaves the normal (no-fallback) boot on the same factory, with no extra work', () => {
    // The fallback is opt-in via the provider-restart message only; a healthy
    // run never terminates or recreates the worker.
    const initWorker = functionBody(MAIN, 'async function initWorker(', 'function createInferenceWorker(');
    expect(initWorker).toMatch(/worker = createInferenceWorker\(\)/);
    expect(initWorker).not.toMatch(/terminate/);
  });

  it('agrees with the worker on the provider-restart wire contract', () => {
    // The two ends must stay in sync: the worker sends `from/to/reason/runId`,
    // the page reads exactly those fields.
    expect(RESTART).toMatch(/from: string/);
    expect(RESTART).toMatch(/to: string/);
    expect(RESTART).toMatch(/reason: string/);
    expect(RESTART).toMatch(/runId: number/);
  });
});
