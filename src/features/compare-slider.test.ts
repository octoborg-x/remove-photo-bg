import { describe, it, expect } from 'vitest';
import { clampPercent } from './compare-slider';

describe('clampPercent', () => {
  it('keeps values inside 0–100', () => {
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(50)).toBe(50);
    expect(clampPercent(100)).toBe(100);
  });

  it('clamps out-of-range values', () => {
    expect(clampPercent(-20)).toBe(0);
    expect(clampPercent(140)).toBe(100);
  });

  it('falls back to the midpoint for non-finite input', () => {
    expect(clampPercent(Number.NaN)).toBe(50);
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(100);
  });
});
