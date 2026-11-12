import { describe, it, expect } from 'vitest';
import {
  resizeMaskFloat,
  cropMaskFloat,
  alphaToBytes,
  bytesToAlpha,
  lumaFromRgba,
} from './mask-resize';

describe('resizeMaskFloat', () => {
  it('preserves dimensions and the [0,1] range', () => {
    const src = new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.1, 0.9, 0.33, 0.66]);
    const out = resizeMaskFloat(src, 3, 3, 7, 5);
    expect(out.length).toBe(35);
    expect(Array.from(out).every((v) => v >= 0 && v <= 1)).toBe(true);
  });

  it('is an identity (value-wise) at the same size', () => {
    const src = new Float32Array([0, 0.5, 1, 0.2]);
    const out = resizeMaskFloat(src, 2, 2, 2, 2);
    expect(Array.from(out)).toEqual([0, 0.5, 1, expect.closeTo(0.2, 6)]);
  });

  it('keeps a constant field constant', () => {
    const src = new Float32Array(9).fill(0.42);
    const out = resizeMaskFloat(src, 3, 3, 8, 8, 'bicubic');
    expect(Array.from(out).every((v) => Math.abs(v - 0.42) < 1e-6)).toBe(true);
  });

  it('rises monotonically along a horizontal ramp', () => {
    const src = new Float32Array([0, 1]);
    const out = resizeMaskFloat(src, 2, 1, 8, 1);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[7]).toBeCloseTo(1, 5);
    for (let i = 1; i < 8; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1] - 1e-6);
  });

  it('folds NaN and Infinity to 0 and clamps out-of-range values', () => {
    const src = new Float32Array([NaN, Infinity, -1, 2]);
    const out = resizeMaskFloat(src, 2, 2, 2, 2);
    expect(Array.from(out)).toEqual([0, 0, 0, 1]);
  });

  it('never reads out of bounds for non-integer scale factors', () => {
    const src = new Float32Array(12).fill(0.5);
    const out = resizeMaskFloat(src, 4, 3, 7, 5, 'bicubic');
    expect(out.length).toBe(35);
    expect(Array.from(out).every((v) => Number.isFinite(v))).toBe(true);
  });

  it('throws on a mismatched source length', () => {
    expect(() => resizeMaskFloat(new Float32Array(5), 2, 2, 3, 3)).toThrow(/length/);
  });

  it('throws on invalid dimensions', () => {
    expect(() => resizeMaskFloat(new Float32Array(4), 2, 2, 0, 3)).toThrow(/dimensions/);
  });
});

describe('cropMaskFloat', () => {
  const input = new Float32Array([
    0, 0, 0, 0,
    0, 0.1, 0.2, 0,
    0, 0.3, 0.4, 0,
    0, 0, 0, 0,
  ]);

  it('extracts the content rect, discarding padding', () => {
    const out = cropMaskFloat(input, 4, { x: 1, y: 1, width: 2, height: 2 });
    expect(Array.from(out)).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
      expect.closeTo(0.4, 5),
    ]);
  });

  it('throws when the mask does not match the input size', () => {
    expect(() => cropMaskFloat(new Float32Array(9), 4, { x: 0, y: 0, width: 4, height: 4 })).toThrow(
      /input/,
    );
  });
});

describe('alpha <-> byte round-trip', () => {
  it('maps a float mask to 0-255 and back within one byte', () => {
    const alpha = new Float32Array([0, 0.5, 1, 0.2]);
    const bytes = alphaToBytes(alpha);
    expect(Array.from(bytes)).toEqual([0, 128, 255, 51]);
    const back = bytesToAlpha(bytes);
    for (let i = 0; i < alpha.length; i++) expect(Math.abs(back[i] - alpha[i])).toBeLessThan(1 / 255);
  });
});

describe('lumaFromRgba', () => {
  it('computes Rec.601 luma normalised to [0,1]', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    const luma = lumaFromRgba(data);
    expect(luma.length).toBe(3);
    expect(luma[0]).toBeCloseTo(0.299, 3);
    expect(luma[1]).toBeCloseTo(0.587, 3);
    expect(luma[2]).toBeCloseTo(0.114, 3);
  });
});
