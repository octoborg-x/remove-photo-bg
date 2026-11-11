import { describe, it, expect } from 'vitest';
import {
  PHASE_BANDS,
  bandPercent,
  estimateInferenceMs,
  overallPercent,
  phaseExpectedMs,
  timeFraction,
  type ProcPhase,
} from './processing-progress';

const PHASES: ProcPhase[] = ['download', 'prepare', 'inference', 'finalize'];

describe('bandPercent', () => {
  it('maps a phase fraction into its band', () => {
    for (const phase of PHASES) {
      const [lo, hi] = PHASE_BANDS[phase];
      expect(bandPercent(phase, 0)).toBe(lo);
      expect(bandPercent(phase, 1)).toBe(hi);
    }
  });

  it('clamps out-of-range fractions', () => {
    expect(bandPercent('inference', -1)).toBe(PHASE_BANDS.inference[0]);
    expect(bandPercent('inference', 5)).toBe(PHASE_BANDS.inference[1]);
  });
});

describe('timeFraction', () => {
  it('is the elapsed/expected ratio, capped below 1', () => {
    expect(timeFraction(0, 4000)).toBe(0);
    expect(timeFraction(2000, 4000)).toBeCloseTo(0.5, 5);
    expect(timeFraction(8000, 4000)).toBeLessThan(1);
  });

  it('never returns 1 so a time-estimated phase cannot claim completion', () => {
    expect(timeFraction(999999, 1000)).toBeLessThan(1);
    expect(timeFraction(500, 0)).toBeLessThan(1);
    expect(timeFraction(500, Number.NaN)).toBeLessThan(1);
  });
});

describe('overallPercent', () => {
  it('maps the real download percentage into the download band', () => {
    const [lo, hi] = PHASE_BANDS.download;
    expect(overallPercent('download', 0, 0)).toBe(lo);
    expect(overallPercent('download', 100, 0)).toBe(hi);
    expect(overallPercent('download', 50, 0)).toBeGreaterThan(lo);
    expect(overallPercent('download', 50, 0)).toBeLessThan(hi);
  });

  it('keeps every time-estimated phase inside its band', () => {
    for (const phase of PHASES.filter((p) => p !== 'download')) {
      const [lo, hi] = PHASE_BANDS[phase];
      expect(overallPercent(phase, 0, 0)).toBe(lo);
      expect(overallPercent(phase, 0, 1)).toBe(hi);
      expect(overallPercent(phase, 0, 0.5)).toBeGreaterThanOrEqual(lo);
      expect(overallPercent(phase, 0, 0.5)).toBeLessThanOrEqual(hi);
    }
  });

  it('increases monotonically across the pipeline', () => {
    const bar = [
      overallPercent('download', 0, 0),
      overallPercent('download', 100, 0),
      overallPercent('prepare', 0, 0),
      overallPercent('prepare', 0, 1),
      overallPercent('inference', 0, 0),
      overallPercent('inference', 0, 1),
      overallPercent('finalize', 0, 0),
      overallPercent('finalize', 0, 1),
    ];
    for (let i = 1; i < bar.length; i += 1) {
      expect(bar[i]).toBeGreaterThanOrEqual(bar[i - 1]);
    }
  });
});

describe('estimateInferenceMs', () => {
  it('uses the average of recent runs, floored at 1.5 s', () => {
    expect(estimateInferenceMs([4000, 6000])).toBe(5000);
    expect(estimateInferenceMs([100, 200])).toBe(1500);
  });

  it('falls back to a default when there is no usable sample', () => {
    expect(estimateInferenceMs([])).toBe(6000);
    expect(estimateInferenceMs([0, Number.NaN])).toBe(6000);
  });
});

describe('phaseExpectedMs', () => {
  it('uses the measured inference estimate for the inference phase only', () => {
    expect(phaseExpectedMs('inference', 4321)).toBe(4321);
    expect(phaseExpectedMs('prepare', 4321)).toBeGreaterThan(0);
    expect(phaseExpectedMs('finalize', 4321)).toBeGreaterThan(0);
  });
});
