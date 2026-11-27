import { describe, it, expect } from 'vitest';
import { autoContourCleanup } from './contour-cleanup';

/** Builds an RGBA image whose luma is given per pixel. */
function imageFromLuma(w: number, h: number, luma: (x: number, y: number) => number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round(luma(x, y) * 255);
      const o = (y * w + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return new ImageData(data, w, h);
}

function maxGradient(alpha: Float32Array, w: number, h: number): number {
  let g = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w; x++) {
      const d = Math.abs(alpha[y * w + x] - alpha[y * w + x - 1]);
      if (d > g) g = d;
    }
  }
  return g;
}

function foregroundExtent(alpha: Float32Array): number {
  let n = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] >= 0.5) n++;
  return n;
}

const W = 48;
const H = 32;

function softEdgeScene() {
  const half = W / 2;
  const image = imageFromLuma(W, H, (x) => (x < half ? 0.1 : 0.9));
  const alpha = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = x - half;
      alpha[y * W + x] = d <= -6 ? 0 : d >= 6 ? 1 : (d + 6) / 12;
    }
  }
  return { image, alpha };
}

describe('autoContourCleanup', () => {
  it('tightens a blurred mask edge to the photo edge without eroding the subject', async () => {
    const { image, alpha } = softEdgeScene();
    const before = maxGradient(alpha, W, H);
    const beforeExtent = foregroundExtent(alpha);
    const out = await autoContourCleanup(image, alpha);

    expect(out.length).toBe(W * H);
    expect(Array.from(out).every((v) => v >= 0 && v <= 1)).toBe(true);
    // Sharper: a steeper peak alpha step across the transition.
    expect(maxGradient(out, W, H)).toBeGreaterThan(before * 2);
    // No blanket erode/dilate: the foreground extent is preserved.
    expect(Math.abs(foregroundExtent(out) - beforeExtent)).toBeLessThan(W * H * 0.05);
    // Soft edge preserved: some pixels stay strictly between 0 and 1.
    expect(Array.from(out).some((v) => v > 0.05 && v < 0.95)).toBe(true);
  });

  it('does not mutate the input alpha', async () => {
    const { image, alpha } = softEdgeScene();
    const original = Float32Array.from(alpha);
    await autoContourCleanup(image, alpha);
    expect(Array.from(alpha)).toEqual(Array.from(original));
  });

  it('keeps a thin connected structure through the cleanup', async () => {
    const w = 40;
    const h = 60;
    const image = imageFromLuma(w, h, (x) => (x === 19 || x === 20 ? 0.9 : 0.1));
    const alpha = new Float32Array(w * h);
    for (let y = 4; y < h - 4; y++) {
      alpha[y * w + 19] = 1;
      alpha[y * w + 20] = 1;
    }
    const out = await autoContourCleanup(image, alpha, { radius: 2, strength: 1 });
    let kept = 0;
    for (let y = 8; y < h - 8; y++) if (out[y * w + 19] >= 0.5 || out[y * w + 20] >= 0.5) kept++;
    expect(kept).toBeGreaterThan((h - 16) * 0.8);
  });

  it('folds NaN/Infinity to a finite [0,1] alpha', async () => {
    const w = 16;
    const h = 16;
    const image = imageFromLuma(w, h, () => 0.5);
    const alpha = new Float32Array(w * h).fill(0.5);
    alpha[10] = NaN;
    alpha[11] = Infinity;
    alpha[12] = -Infinity;
    const out = await autoContourCleanup(image, alpha);
    expect(Array.from(out).every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
  });

  it('optionally drops a tiny island but keeps a large blob', async () => {
    const w = 60;
    const h = 60;
    const inside = (x: number, y: number): boolean => {
      const blob = x >= 8 && x < 22 && y >= 8 && y < 22;
      const speck = x >= 45 && x < 47 && y >= 45 && y < 47;
      return blob || speck;
    };
    const image = imageFromLuma(w, h, (x, y) => (inside(x, y) ? 0.9 : 0.1));
    const alpha = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) alpha[y * w + x] = inside(x, y) ? 1 : 0;
    }
    const out = await autoContourCleanup(image, alpha, {
      radius: 2,
      strength: 1,
      removeTinyIslands: true,
      minIslandArea: 16,
    });
    expect(out[15 * w + 15]).toBeGreaterThan(0.9);
    expect(out[46 * w + 46]).toBe(0);
  });

  it('rejects a length mismatch', async () => {
    const image = imageFromLuma(4, 4, () => 0.5);
    await expect(autoContourCleanup(image, new Float32Array(3))).rejects.toThrow(/expected/);
  });
});
