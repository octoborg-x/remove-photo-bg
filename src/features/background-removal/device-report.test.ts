// The copyable device report must carry exactly the facts a "washed-out cut-out"
// investigation needs: the provider, the GPU adapter, the model, the timings and
// the raw-mask min/mean/max, plus an explicit suspect/ok verdict. These tests
// pin that contract so a future refactor cannot silently drop the mask line.
import { describe, it, expect } from 'vitest';
import { buildDeviceReport } from './device-report';
import type { MaskStats } from './mask-stats';

const healthy: MaskStats = { min: 0, mean: 0.393, max: 1, lowFraction: 0.602, highFraction: 0.388 };

function base(overrides: Partial<Parameters<typeof buildDeviceReport>[0]> = {}) {
  return buildDeviceReport({
    buildId: '20261114000000',
    userAgent: 'Mozilla/5.0 (Test)',
    provider: 'wasm',
    modelId: 'qmix-cut-512',
    adapter: '',
    loadMs: 950,
    timings: [4200, 4100],
    maskStats: healthy,
    maskSuspect: false,
    crossOriginIsolated: true,
    hardwareConcurrency: 8,
    ...overrides,
  });
}

describe('buildDeviceReport', () => {
  it('includes the environment, provider, adapter and model lines', () => {
    const report = base({ provider: 'webgpu', adapter: 'Qualcomm Adreno 640' });
    expect(report).toMatch(/provider: webgpu/);
    expect(report).toMatch(/gpu adapter: Qualcomm Adreno 640/);
    expect(report).toMatch(/model: qmix-cut-512/);
    expect(report).toMatch(/cross-origin isolated: yes/);
    expect(report).toMatch(/hardware concurrency: 8/);
  });

  it('reports the raw mask and marks a healthy mask ok', () => {
    const report = base();
    expect(report).toMatch(/raw mask: min 0\.000 \/ mean 0\.393 \/ max 1\.000/);
    expect(report).toMatch(/raw mask check: ok \(bimodal\)/);
  });

  it('marks a suspicious mask loudly', () => {
    const squashed: MaskStats = { min: 0.5, mean: 0.61, max: 0.73, lowFraction: 0, highFraction: 0 };
    const report = base({ maskStats: squashed, maskSuspect: true });
    expect(report).toMatch(/raw mask check: SUSPECT/);
  });

  it('says the mask was not measured when no run has happened', () => {
    const report = base({ maskStats: null, maskSuspect: false, timings: [] });
    expect(report).toMatch(/raw mask: not measured yet/);
    expect(report).toMatch(/warm inference: none/);
  });

  it('summarises warm timings with an average', () => {
    const report = base({ timings: [4200, 4100] });
    expect(report).toMatch(/warm inference: 4200, 4100 ms \(avg 4150 ms\)/);
  });

  it('notes the CPU path when there is no adapter', () => {
    expect(base({ adapter: '' })).toMatch(/gpu adapter: \(none — CPU path\)/);
  });
});
