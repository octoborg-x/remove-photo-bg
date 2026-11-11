import { describe, it, expect } from 'vitest';
import {
  clampChannel,
  hexToRgb,
  normalizeHex,
  rgbToHex,
  sampleAverage,
  supportsScreenPicker,
} from './screen-picker';

describe('rgbToHex / hexToRgb', () => {
  it('round-trips a colour', () => {
    expect(rgbToHex({ r: 37, g: 99, b: 235 })).toBe('#2563eb');
    expect(hexToRgb('#2563eb')).toEqual({ r: 37, g: 99, b: 235 });
  });

  it('accepts a hex without the leading #', () => {
    expect(hexToRgb('ffffff')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('rejects malformed hex', () => {
    expect(hexToRgb('#abc')).toBeNull();
    expect(hexToRgb('nope')).toBeNull();
  });

  it('normalises case and shorthand-free hex', () => {
    expect(normalizeHex('#ABCDEF')).toBe('#abcdef');
    expect(normalizeHex('bad')).toBeNull();
  });

  it('clamps and rounds channels', () => {
    expect(clampChannel(300)).toBe(255);
    expect(clampChannel(-5)).toBe(0);
    expect(clampChannel(12.6)).toBe(13);
    expect(clampChannel(NaN)).toBe(0);
  });
});

describe('sampleAverage', () => {
  // A 4x4 image: left half black, right half white.
  const width = 4;
  const height = 4;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = x < 2 ? 0 : 255;
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }

  it('averages the sampled neighbourhood', () => {
    // Centre on the boundary (x=1) with radius 1 → samples columns 0..2.
    const avg = sampleAverage(data, width, height, 1, 1, 1);
    expect(avg.r).toBeCloseTo((0 + 0 + 255) / 3, 5);
  });

  it('clamps the sample to the image bounds', () => {
    const avg = sampleAverage(data, width, height, 0, 0, 2);
    expect(avg.r).toBeGreaterThan(0);
    expect(avg.r).toBeLessThan(255);
  });
});

describe('supportsScreenPicker', () => {
  it('is false when the EyeDropper API is absent', () => {
    const g = globalThis as { EyeDropper?: unknown };
    const had = 'EyeDropper' in g;
    const prev = g.EyeDropper;
    delete g.EyeDropper;
    expect(supportsScreenPicker()).toBe(false);
    if (had) g.EyeDropper = prev;
  });

  it('is true when the EyeDropper API is present', () => {
    const g = globalThis as { EyeDropper?: unknown };
    const prev = g.EyeDropper;
    g.EyeDropper = class {};
    expect(supportsScreenPicker()).toBe(true);
    if (prev === undefined) delete g.EyeDropper;
    else g.EyeDropper = prev;
  });
});
