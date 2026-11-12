import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FAST_REFINEMENT,
  isFastRefinementConfig,
  resolveRefinementConfig,
  refinementConfigFromParams,
} from './refinement-config';

describe('isFastRefinementConfig', () => {
  it('accepts the validated defaults', () => {
    expect(isFastRefinementConfig(DEFAULT_FAST_REFINEMENT)).toBe(true);
  });

  it('rejects malformed or unbounded configs', () => {
    const base = () => structuredClone(DEFAULT_FAST_REFINEMENT);
    const bad: unknown[] = [
      null,
      {},
      { ...base(), enabled: 'yes' },
      { ...base(), maskUpscale: { interpolation: 'nearest' } },
      { ...base(), edgeRefinement: { ...base().edgeRefinement, algorithm: 'bilateral' } },
      { ...base(), edgeRefinement: { ...base().edgeRefinement, radius: 0 } },
      { ...base(), edgeRefinement: { ...base().edgeRefinement, radius: NaN } },
      { ...base(), edgeRefinement: { ...base().edgeRefinement, strength: 2 } },
      { ...base(), edgeRefinement: { ...base().edgeRefinement, epsilon: 0 } },
      { ...base(), cleanup: { ...base().cleanup, preserveSoftAlpha: false } },
      { ...base(), cleanup: { ...base().cleanup, minAlpha: 0.8, maxAlpha: 0.2 } },
      { ...base(), performance: { ...base().performance, chunkRows: 0 } },
    ];
    for (const b of bad) expect(isFastRefinementConfig(b), JSON.stringify(b)).toBe(false);
  });
});

describe('resolveRefinementConfig', () => {
  it('fills defaults when given nothing', () => {
    expect(resolveRefinementConfig()).toEqual(DEFAULT_FAST_REFINEMENT);
  });

  it('clamps out-of-range overrides into a valid config', () => {
    const cfg = resolveRefinementConfig({
      edgeRefinement: {
        enabled: true,
        algorithm: 'guided-filter',
        radius: 999,
        epsilon: -5,
        strength: 9,
        edgeSensitivity: 0,
      },
      cleanup: {
        enabled: true,
        preserveSoftAlpha: true,
        minAlpha: 0.9,
        maxAlpha: 0.1,
        removeTinyIsolatedNoise: true,
      },
      performance: { useWorker: true, chunkRows: 0, maxProcessingPixels: 0 },
    });
    expect(isFastRefinementConfig(cfg)).toBe(true);
    expect(cfg.edgeRefinement.radius).toBe(64);
    expect(cfg.edgeRefinement.strength).toBe(1);
    expect(cfg.edgeRefinement.epsilon).toBeGreaterThanOrEqual(1e-8);
    expect(cfg.cleanup.minAlpha).toBeLessThanOrEqual(cfg.cleanup.maxAlpha);
    expect(cfg.performance.chunkRows).toBeGreaterThanOrEqual(1);
  });
});

describe('refinementConfigFromParams', () => {
  it('disables refinement with ?refine=off', () => {
    expect(refinementConfigFromParams(new URLSearchParams('refine=off')).enabled).toBe(false);
  });

  it('keeps refinement on by default', () => {
    expect(refinementConfigFromParams(new URLSearchParams('')).enabled).toBe(true);
  });

  it('reads numeric knobs and ignores junk', () => {
    const cfg = refinementConfigFromParams(new URLSearchParams('refineRadius=20&refineStrength=abc'));
    expect(cfg.edgeRefinement.radius).toBe(20);
    expect(cfg.edgeRefinement.strength).toBe(DEFAULT_FAST_REFINEMENT.edgeRefinement.strength);
    expect(isFastRefinementConfig(cfg)).toBe(true);
  });

  it('can disable only the edge stage', () => {
    expect(refinementConfigFromParams(new URLSearchParams('refine=edges-off')).edgeRefinement.enabled).toBe(false);
  });
});
