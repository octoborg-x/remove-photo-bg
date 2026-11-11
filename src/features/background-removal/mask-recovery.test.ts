import { describe, it, expect } from 'vitest';
import {
  foregroundFraction,
  borderForegroundFraction,
  isFloodedMask,
  floodFillForeground,
  recoverForegroundMask,
  DEFAULT_RECOVERY_OPTIONS,
} from './mask-recovery';

/** Solid-colour RGBA ImageData. */
function solid(width: number, height: number, rgb: [number, number, number]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

function fillRect(
  img: ImageData,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgb: [number, number, number],
): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
      img.data[i + 3] = 255;
    }
  }
}

function maskOf(width: number, height: number, value: number): Uint8ClampedArray {
  return new Uint8ClampedArray(width * height).fill(value);
}

describe('foregroundFraction', () => {
  it('is 1 for an all-opaque mask and 0 for an all-transparent one', () => {
    expect(foregroundFraction(maskOf(10, 10, 255))).toBe(1);
    expect(foregroundFraction(maskOf(10, 10, 0))).toBe(0);
  });

  it('counts the half-kept mask as 0.5', () => {
    const m = new Uint8ClampedArray(100);
    for (let i = 0; i < 50; i++) m[i] = 255;
    expect(foregroundFraction(m)).toBeCloseTo(0.5);
  });
});

describe('borderForegroundFraction', () => {
  it('is 1 when the whole frame is foreground', () => {
    expect(borderForegroundFraction(maskOf(40, 40, 255), 40, 40)).toBe(1);
  });

  it('is 0 for a centred subject that never touches the border', () => {
    const m = maskOf(40, 40, 0);
    for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) m[y * 40 + x] = 255;
    expect(borderForegroundFraction(m, 40, 40)).toBe(0);
  });
});

describe('isFloodedMask', () => {
  it('flags a full-frame opaque mask', () => {
    expect(isFloodedMask(maskOf(64, 64, 255), 64, 64)).toBe(true);
  });

  it('does not flag a small centred subject', () => {
    const m = maskOf(64, 64, 0);
    for (let y = 24; y < 40; y++) for (let x = 24; x < 40; x++) m[y * 64 + x] = 255;
    expect(isFloodedMask(m, 64, 64)).toBe(false);
  });

  it('does not flag a subject that covers most of the frame but not the border', () => {
    // ~81% foreground overall, but a clear background margin all round.
    const m = maskOf(64, 64, 0);
    for (let y = 4; y < 60; y++) for (let x = 4; x < 60; x++) m[y * 64 + x] = 255;
    expect(foregroundFraction(m)).toBeGreaterThan(0.75);
    expect(isFloodedMask(m, 64, 64)).toBe(false);
  });
});

describe('floodFillForeground', () => {
  it('keeps a centred subject and drops the uniform border', () => {
    const img = solid(80, 80, [255, 255, 255]);
    fillRect(img, 30, 30, 20, 20, [20, 20, 20]);
    const fg = floodFillForeground(img);
    expect(fg.length).toBe(80 * 80);
    // The subject centre is kept.
    expect(fg[40 * 80 + 40]).toBe(255);
    // The far corner (background) is dropped.
    expect(fg[0]).toBe(0);
    // The recovered foreground is a small share of the frame.
    expect(foregroundFraction(fg)).toBeLessThan(0.25);
  });

  it('keeps nothing when the image is a single uniform colour', () => {
    const img = solid(50, 50, [200, 100, 50]);
    const fg = floodFillForeground(img);
    expect(foregroundFraction(fg)).toBe(0);
  });

  it('respects the tolerance: a subject beyond it is kept', () => {
    // Background varies within tolerance (so the fill crosses it) while the
    // subject differs well beyond tolerance (so the fill stops at its edge).
    const img = solid(80, 80, [200, 200, 200]);
    for (let y = 0; y < 80; y++) {
      for (let x = 0; x < 80; x++) {
        if (x < 40) fillRect(img, x, y, 1, 1, [212, 212, 212]);
      }
    }
    fillRect(img, 30, 30, 20, 20, [20, 20, 20]);
    const fg = floodFillForeground(img, { tolerance: 24 });
    expect(fg[40 * 80 + 40]).toBe(255);
    expect(fg[0]).toBe(0);
    expect(foregroundFraction(fg)).toBeLessThan(0.2);
  });
});

describe('recoverForegroundMask', () => {
  it('recovers a subject on a uniform backdrop when the model flooded the frame', () => {
    const img = solid(100, 100, [245, 245, 245]);
    fillRect(img, 35, 35, 30, 30, [40, 90, 200]);
    const flooded = maskOf(100, 100, 255);
    const { mask, recovered } = recoverForegroundMask(img, flooded);
    expect(recovered).toBe(true);
    expect(foregroundFraction(mask)).toBeLessThan(0.25);
  });

  it('leaves a well-segmented mask untouched', () => {
    const img = solid(100, 100, [245, 245, 245]);
    fillRect(img, 35, 35, 30, 30, [40, 90, 200]);
    const good = maskOf(100, 100, 0);
    for (let y = 35; y < 65; y++) for (let x = 35; x < 65; x++) good[y * 100 + x] = 255;
    const { mask, recovered } = recoverForegroundMask(img, good);
    expect(recovered).toBe(false);
    expect(mask).toBe(good);
  });

  it('keeps the model mask when the flood fill finds no separable background', () => {
    // Flooded model mask over a uniform image: the fill removes everything, so
    // recovery would be empty — reject it and keep the model output.
    const img = solid(80, 80, [10, 10, 10]);
    const flooded = maskOf(80, 80, 255);
    const { mask, recovered } = recoverForegroundMask(img, flooded);
    expect(recovered).toBe(false);
    expect(mask).toBe(flooded);
  });

  it('uses the documented default thresholds', () => {
    expect(DEFAULT_RECOVERY_OPTIONS.floodFraction).toBe(0.75);
    expect(DEFAULT_RECOVERY_OPTIONS.borderFraction).toBe(0.7);
  });
});
