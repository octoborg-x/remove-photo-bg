// Raw-mask statistics: the numbers behind the "washed-out ghost" diagnostic.
//
// The load-bearing regression is the SQUASHED mask — the fingerprint of a second
// sigmoid over an already-probability output, which collapses [0,1] into
// ≈[0.5,0.73] and composites a uniform translucent image. Such a mask has a
// mid-band mean AND empty tails, so `isSuspectRawMask` must flag it. A genuinely
// bimodal mask with the SAME mean (a subject-heavy portrait) must NOT be flagged.
import { describe, it, expect } from 'vitest';
import {
  rawMaskStats,
  isSuspectRawMask,
  emptyRawMaskStats,
  formatRawMaskStats,
  SUSPECT_MEAN_MIN,
  SUSPECT_MEAN_MAX,
} from './raw-mask-stats';

/** A squashed mask: every pixel in [0.5, 0.7], so the mean is ~0.6 and neither
 *  tail (below 0.01 / above 0.95) is populated — the "ghost" fingerprint. */
function squashedMask(n = 512 * 512): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 + (0.7 - 0.5) * (i / (n - 1));
  return out;
}

describe('rawMaskStats', () => {
  it('reports min/mean/max and tail fractions over the whole tensor', () => {
    const s = rawMaskStats(new Float32Array([0, 0.05, 0.5, 0.96, 1]), 5, 1);
    expect(s.min).toBe(0);
    expect(s.max).toBe(1);
    expect(s.mean).toBeCloseTo((0 + 0.05 + 0.5 + 0.96 + 1) / 5, 6);
    expect(s.below_001_fraction).toBeCloseTo(1 / 5, 6);
    expect(s.below_01_fraction).toBeCloseTo(2 / 5, 6);
    expect(s.below_05_fraction).toBeCloseTo(2 / 5, 6);
    expect(s.above_095_fraction).toBeCloseTo(2 / 5, 6);
    expect(s.above_099_fraction).toBeCloseTo(1 / 5, 6);
    expect(s.non_finite_count).toBe(0);
  });

  it('records the shape only when width*height matches the element count', () => {
    expect(rawMaskStats(new Float32Array(4), 2, 2).width).toBe(2);
    // A mismatch reports 0x0 rather than a shape that does not describe the data.
    expect(rawMaskStats(new Float32Array(4), 3, 3).width).toBe(0);
  });

  it('excludes non-finite values from the range/mean but counts them', () => {
    const s = rawMaskStats(new Float32Array([0.2, NaN, Infinity, 0.8]));
    expect(s.non_finite_count).toBe(2);
    expect(s.min).toBeCloseTo(0.2, 6);
    expect(s.max).toBeCloseTo(0.8, 6);
    expect(s.mean).toBeCloseTo(0.5, 6);
  });

  it('does not mutate the input mask', () => {
    const m = new Float32Array([0.1, 0.9]);
    const before = Float32Array.from(m);
    rawMaskStats(m);
    expect(m).toEqual(before);
  });

  it('returns a zeroed block for an empty mask', () => {
    expect(rawMaskStats(new Float32Array(0))).toEqual(emptyRawMaskStats());
  });
});

describe('isSuspectRawMask (the ghost-image regression guard)', () => {
  it('flags the squashed mask: mid-band mean, empty tails', () => {
    const stats = rawMaskStats(squashedMask());
    expect(stats.mean).toBeGreaterThan(0.55);
    expect(stats.mean).toBeLessThan(0.65);
    expect(stats.below_01_fraction).toBe(0);
    expect(stats.above_095_fraction).toBe(0);
    expect(isSuspectRawMask(stats)).toBe(true);
  });

  it('does NOT flag a bimodal mask with the same ~0.6 mean (subject-heavy portrait)', () => {
    const n = 512 * 512;
    const healthy = new Float32Array(n);
    for (let i = 0; i < n; i++) healthy[i] = i < n * 0.6 ? 0 : 1;
    const stats = rawMaskStats(healthy);
    expect(stats.mean).toBeCloseTo(0.4, 1);
    expect(isSuspectRawMask(stats)).toBe(false);
  });

  it('does not flag a mask whose mean is outside the suspicious band', () => {
    // Nearly all background: low mean, not suspect even though it is unimodal.
    const low = rawMaskStats(new Float32Array(512 * 512).fill(0.02));
    expect(low.mean).toBeLessThan(SUSPECT_MEAN_MIN);
    expect(isSuspectRawMask(low)).toBe(false);
    // Nearly all subject: high mean, not suspect.
    const high = rawMaskStats(new Float32Array(512 * 512).fill(0.98));
    expect(high.mean).toBeGreaterThan(SUSPECT_MEAN_MAX);
    expect(isSuspectRawMask(high)).toBe(false);
  });
});

describe('formatRawMaskStats', () => {
  it('renders a compact one-line summary with a tail percentage', () => {
    const line = formatRawMaskStats(rawMaskStats(new Float32Array([0, 1]), 2, 1));
    expect(line).toMatch(/min 0\.000 \/ mean 0\.500 \/ max 1\.000/);
    expect(line).toMatch(/tail 50%\/50%/);
  });

  it('mentions non-finite values only when present', () => {
    expect(formatRawMaskStats(rawMaskStats(new Float32Array([0.5])))).not.toMatch(/non-finite/);
    expect(formatRawMaskStats(rawMaskStats(new Float32Array([NaN, 0.5])))).toMatch(/1 non-finite/);
  });
});
