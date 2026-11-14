// Guards the raw-mask sanity heuristic and its reporting format. The numbers in
// the "real masks" cases are the actual means measured from the shipped artifact
// (see BUG_INVESTIGATION.md); a correctly-segmenting BiRefNet_lite mask is
// bimodal and must NOT be flagged, while a mask squashed into the middle (the
// double-sigmoid failure mode) MUST be.
import { describe, it, expect } from 'vitest';
import {
  maskStats,
  isSuspiciousMask,
  formatMaskStats,
  SUSPECT_MEAN_MIN,
  SUSPECT_MEAN_MAX,
} from './mask-stats';

/** A bimodal mask: `bg` pixels at ~0, `fg` at ~1, rest spread between. */
function bimodal(bg: number, fg: number, mid = 0): Float32Array {
  const out = new Float32Array(bg + fg + mid);
  let i = 0;
  for (let k = 0; k < bg; k++) out[i++] = 0.02;
  for (let k = 0; k < fg; k++) out[i++] = 0.98;
  for (let k = 0; k < mid; k++) out[i++] = 0.5;
  return out;
}

/** A squashed mask: everything in the double-sigmoid band ≈[0.5, 0.73]. */
function squashed(n = 1000): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 + (0.73 - 0.5) * (i / n);
  return out;
}

describe('maskStats', () => {
  it('computes min/mean/max and the tail fractions in one pass', () => {
    const stats = maskStats(bimodal(60, 40));
    expect(stats.min).toBeCloseTo(0.02, 5);
    expect(stats.max).toBeCloseTo(0.98, 5);
    expect(stats.mean).toBeCloseTo(0.404, 5);
    expect(stats.lowFraction).toBeCloseTo(0.6, 5);
    expect(stats.highFraction).toBeCloseTo(0.4, 5);
  });

  it('handles an empty mask without dividing by zero', () => {
    expect(maskStats(new Float32Array(0))).toEqual({
      min: 0,
      mean: 0,
      max: 0,
      lowFraction: 0,
      highFraction: 0,
    });
  });
});

describe('isSuspiciousMask', () => {
  it('does not flag a bimodal mask even when its mean is subject-heavy', () => {
    // mean 0.6 sits inside the suspect band, but the mask spans 0..1 (tails
    // 60%/40%), so it is a healthy subject-heavy photo, not a squash.
    expect(isSuspiciousMask(maskStats(bimodal(60, 40)))).toBe(false);
  });

  it('flags a mask squashed into the double-sigmoid band', () => {
    const stats = maskStats(squashed());
    expect(stats.mean).toBeGreaterThan(SUSPECT_MEAN_MIN);
    expect(stats.mean).toBeLessThan(SUSPECT_MEAN_MAX);
    expect(isSuspiciousMask(stats)).toBe(true);
  });

  it('does not flag a near-uniform empty mask (mean ~0)', () => {
    const empty = new Float32Array(500); // all zero
    expect(isSuspiciousMask(maskStats(empty))).toBe(false);
  });

  it('does not flag a near-uniform full mask (mean ~1)', () => {
    const full = new Float32Array(500).fill(1);
    expect(isSuspiciousMask(maskStats(full))).toBe(false);
  });

  // Real measured masks from the shipped artifact (offline ONNX, CPU). These are
  // healthy and must never be flagged.
  it.each([
    ['glass-wine', 0.393, 0.602, 0.388],
    ['portrait-hair', 0.575, 0.416, 0.564],
    ['product-scent-bottle', 0.288, 0.709, 0.284],
  ])('passes the measured %s mask', (_name, mean, low, high) => {
    const stats = { min: 0, mean: mean as number, max: 1, lowFraction: low as number, highFraction: high as number };
    expect(isSuspiciousMask(stats)).toBe(false);
  });
});

describe('formatMaskStats', () => {
  it('renders a compact one-line summary', () => {
    const line = formatMaskStats(maskStats(bimodal(60, 40)));
    expect(line).toMatch(/min 0\.020 \/ mean 0\.404 \/ max 0\.980/);
    expect(line).toMatch(/tail 60%\/40%/);
  });
});
