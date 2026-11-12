import { describe, it, expect } from 'vitest';
import { RefinementRunner, refinementWorkerSupported } from './refinement-client';
import { DEFAULT_FAST_REFINEMENT, resolveRefinementConfig } from './refinement-config';

const W = 32;
const H = 24;

// The main-thread path is the one under test: a dedicated worker needs a real
// browser, so `useWorker: false` exercises the identical pure `refineMask`.
function request(jobId: number) {
  const guide = new Float32Array(W * H);
  const mask = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      guide[i] = x < W / 2 ? 0.1 : 0.9;
      mask[i] = x < W / 2 ? 0 : 1;
    }
  }
  return {
    jobId,
    guide,
    mask,
    maskWidth: W,
    maskHeight: H,
    width: W,
    height: H,
    config: resolveRefinementConfig({ performance: { ...DEFAULT_FAST_REFINEMENT.performance, useWorker: false } }),
  };
}

describe('RefinementRunner (main-thread path)', () => {
  it('resolves with the refined alpha and stage timings', async () => {
    const runner = new RefinementRunner();
    const outcome = await runner.refine(request(1));
    expect('cancelled' in outcome).toBe(false);
    if ('cancelled' in outcome) return;
    expect(outcome.jobId).toBe(1);
    expect(outcome.alpha.length).toBe(W * H);
    expect(Array.from(outcome.alpha).every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(outcome.timings.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('supersedes an in-flight job (the older one resolves cancelled)', async () => {
    const runner = new RefinementRunner();
    const first = runner.refine(request(1));
    const second = runner.refine(request(2));
    const [a, b] = await Promise.all([first, second]);
    // The older job must not win; it reports cancellation, the newer one wins.
    expect('cancelled' in a).toBe(true);
    expect('cancelled' in b).toBe(false);
    if (!('cancelled' in b)) expect(b.jobId).toBe(2);
  });

  it('cancel() supersedes the current job', async () => {
    const runner = new RefinementRunner();
    const p = runner.refine(request(7));
    runner.cancel();
    const outcome = await p;
    expect('cancelled' in outcome).toBe(true);
  });

  it('dispose() is safe to call repeatedly and after a run', async () => {
    const runner = new RefinementRunner();
    await runner.refine(request(3));
    expect(() => {
      runner.dispose();
      runner.dispose();
    }).not.toThrow();
  });
});

describe('refinementWorkerSupported', () => {
  it('returns a boolean (feature probe never throws)', () => {
    expect(typeof refinementWorkerSupported()).toBe('boolean');
  });
});
