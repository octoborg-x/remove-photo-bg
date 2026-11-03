import { describe, it, expect } from 'vitest';
import {
  probabilityToMask,
  upscaleMask,
  applyMaskAdjust,
  applyMaskToImage,
  isMaskAdjust,
  DEFAULT_MASK_ADJUST,
} from './mask-postprocess';

describe('probabilityToMask', () => {
  it('maps [0,1] probabilities to 0-255 bytes', () => {
    const out = probabilityToMask(new Float32Array([0, 0.5, 1]));
    expect(Array.from(out)).toEqual([0, 128, 255]);
  });

  it('clamps out-of-range probabilities instead of wrapping', () => {
    const out = probabilityToMask(new Float32Array([-1, 1.5]));
    expect(Array.from(out)).toEqual([0, 255]);
  });

  it('preserves length', () => {
    expect(probabilityToMask(new Float32Array(16)).length).toBe(16);
  });
});

describe('upscaleMask', () => {
  it('nearest-copies when source and destination match', () => {
    const src = new Uint8ClampedArray([10, 20, 30, 40]);
    expect(Array.from(upscaleMask(src, 2, 2, 2, 2))).toEqual([10, 20, 30, 40]);
  });

  it('produces a constant field when the source is constant', () => {
    const src = new Uint8ClampedArray(4).fill(200);
    const out = upscaleMask(src, 2, 2, 5, 3);
    expect(out.length).toBe(15);
    expect(Array.from(out).every((v) => v === 200)).toBe(true);
  });

  it('interpolates along a horizontal ramp', () => {
    // 2x1 source [0, 255] -> 4x1 destination should rise monotonically.
    const src = new Uint8ClampedArray([0, 255]);
    const out = upscaleMask(src, 2, 1, 4, 1);
    expect(out[0]).toBe(0);
    expect(out[3]).toBe(255);
    expect(out[1]).toBeLessThanOrEqual(out[2]);
  });

  it('handles non-integer scale factors without reading out of bounds', () => {
    const src = new Uint8ClampedArray(9).fill(128);
    const out = upscaleMask(src, 3, 3, 7, 7);
    expect(out.length).toBe(49);
    expect(Array.from(out).every((v) => v === 128)).toBe(true);
  });
});

describe('applyMaskAdjust', () => {
  const makeMask = () => new Uint8ClampedArray([0, 50, 100, 150, 200, 250, 255, 25, 75]);

  it('is a no-op at the defaults (threshold 0, feather 0)', () => {
    const mask = makeMask();
    const out = applyMaskAdjust(mask, 3, 3, DEFAULT_MASK_ADJUST);
    expect(Array.from(out)).toEqual(Array.from(mask));
  });

  it('threshold binarises to 0/255 above the cutoff', () => {
    const out = applyMaskAdjust(makeMask(), 3, 3, { threshold: 50, feather: 0 });
    // cutoff = round(0.5 * 255) = 128; strictly greater than 128 -> 255.
    expect(Array.from(out)).toEqual([0, 0, 0, 255, 255, 255, 255, 0, 0]);
  });

  it('feather keeps length and stays within 0-255', () => {
    const out = applyMaskAdjust(makeMask(), 3, 3, { threshold: 0, feather: 3 });
    expect(out.length).toBe(9);
    expect(Array.from(out).every((v) => v >= 0 && v <= 255)).toBe(true);
  });

  it('feather of a constant field is that constant', () => {
    const src = new Uint8ClampedArray(25).fill(123);
    const out = applyMaskAdjust(src, 5, 5, { threshold: 0, feather: 4 });
    expect(Array.from(out).every((v) => v === 123)).toBe(true);
  });

  it('applies the threshold before feathering (inner edge stays solid)', () => {
    // A hard step 0|255 feathered should keep the far ends at the extremes.
    const src = new Uint8ClampedArray(16);
    for (let i = 0; i < 16; i++) src[i] = i < 8 ? 0 : 255;
    const out = applyMaskAdjust(src, 16, 1, { threshold: 50, feather: 2 });
    expect(out[0]).toBe(0);
    expect(out[15]).toBe(255);
  });
});

describe('isMaskAdjust', () => {
  it('accepts the default shape', () => {
    expect(isMaskAdjust(DEFAULT_MASK_ADJUST)).toBe(true);
  });

  it('rejects out-of-range, non-finite, and malformed values', () => {
    for (const bad of [
      null,
      undefined,
      {},
      { threshold: -1, feather: 0 },
      { threshold: 0, feather: 65 },
      { threshold: NaN, feather: 0 },
      { threshold: 0, feather: 'x' },
    ]) {
      expect(isMaskAdjust(bad)).toBe(false);
    }
  });
});

describe('applyMaskToImage', () => {
  it('copies RGB and writes the mask into the alpha channel', () => {
    const img = new ImageData(2, 2);
    img.data.set([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
    const mask = new Uint8ClampedArray([0, 128, 255, 64]);
    const out = applyMaskToImage(img, mask);
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect(Array.from(out.data)).toEqual([
      10, 20, 30, 0,
      40, 50, 60, 128,
      70, 80, 90, 255,
      100, 110, 120, 64,
    ]);
  });

  it('does not mutate the input image', () => {
    const img = new ImageData(1, 1);
    img.data.set([1, 2, 3, 4]);
    applyMaskToImage(img, new Uint8ClampedArray([200]));
    expect(Array.from(img.data)).toEqual([1, 2, 3, 4]);
  });
});
