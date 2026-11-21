import { describe, it, expect } from 'vitest';
import {
  refineMask,
  removeTinyIslands,
  minIslandArea,
  MIN_ISLAND_FRACTION,
  MIN_ISLAND_FRACTION_STRICT,
} from './refine-mask';
import { ISLAND_CLEANUP_FRACTIONS } from './island-cleanup';
import { DEFAULT_FAST_REFINEMENT, resolveRefinementConfig } from './refinement-config';

const W = 40;
const H = 24;

// A guide with a crisp vertical edge and a soft, blurred mask edge in the same
// place — the wine-glass-style case (soft specular edge the model under-resolves).
function scene() {
  const guide = new Float32Array(W * H);
  const mask = new Float32Array(W * H);
  const half = W / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      guide[i] = x < half ? 0.1 : 0.9;
      const d = x - half;
      mask[i] = d <= -6 ? 0 : d >= 6 ? 1 : (d + 6) / 12;
    }
  }
  return { guide, mask };
}

function foregroundExtent(alpha: Float32Array): number {
  let n = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] >= 0.5) n++;
  return n;
}

function maxGradient(alpha: Float32Array): number {
  let g = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 1; x < W; x++) {
      const d = Math.abs(alpha[y * W + x] - alpha[y * W + x - 1]);
      if (d > g) g = d;
    }
  }
  return g;
}

function baseInput() {
  const { guide, mask } = scene();
  return {
    mask,
    maskWidth: W,
    maskHeight: H,
    width: W,
    height: H,
    guide,
    config: DEFAULT_FAST_REFINEMENT,
  };
}

describe('refineMask', () => {
  it('sharpens the soft edge without binarising or eroding the subject', async () => {
    const input = baseInput();
    const before = maxGradient(input.mask);
    const { alpha, width, height, timings } = await refineMask(input);
    expect(width).toBe(W);
    expect(height).toBe(H);
    expect(alpha.length).toBe(W * H);
    // Sharper: a steeper peak alpha step across the transition.
    expect(maxGradient(alpha)).toBeGreaterThan(before * 2);
    // Same rough foreground extent (no blanket erode/dilate).
    expect(Math.abs(foregroundExtent(alpha) - foregroundExtent(input.mask))).toBeLessThan(W * H * 0.05);
    // Soft edges preserved: some pixels remain strictly between 0 and 1.
    expect(Array.from(alpha).some((v) => v > 0.05 && v < 0.95)).toBe(true);
    // Range valid.
    expect(Array.from(alpha).every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(timings.workWidth).toBe(W);
  });

  it('enabled:false bypasses the edge + cleanup stages (A/B path)', async () => {
    const input = baseInput();
    const raw = Float32Array.from(input.mask);
    const { alpha } = await refineMask({
      ...input,
      config: resolveRefinementConfig({ enabled: false }),
    });
    // Reconstruction only: same values as the input mask (identity resize).
    expect(Array.from(alpha)).toEqual(Array.from(raw));
  });

  it('clamps output into the configured [minAlpha, maxAlpha] range', async () => {
    const input = baseInput();
    const { alpha } = await refineMask({
      ...input,
      config: resolveRefinementConfig({
        cleanup: {
          enabled: true,
          preserveSoftAlpha: true,
          minAlpha: 0.1,
          maxAlpha: 0.9,
          removeTinyIsolatedNoise: true,
          islandCleanup: 'fine',
        },
      }),
    });
    expect(Array.from(alpha).every((v) => v >= 0.1 - 1e-6 && v <= 0.9 + 1e-6)).toBe(true);
  });

  it('respects cancellation between stages', async () => {
    const input = baseInput();
    await expect(
      refineMask(input, {
        checkCancelled: () => {
          throw new Error('superseded');
        },
      }),
    ).rejects.toThrow('superseded');
  });

  it('reports progress and completes all stages', async () => {
    const stages = new Set<string>();
    await refineMask(baseInput(), {
      onProgress: (stage) => void stages.add(stage),
    });
    expect(stages.has('refine')).toBe(true);
    expect(stages.has('cleanup')).toBe(true);
  });

  it('fails safely on a mismatched mask length', async () => {
    await expect(
      refineMask({ ...baseInput(), mask: new Float32Array(3) }),
    ).rejects.toThrow(/length/);
  });

  it('folds NaN/Infinity in the input mask to a finite [0,1] alpha', async () => {
    const input = baseInput();
    input.mask[10] = NaN;
    input.mask[11] = Infinity;
    input.mask[12] = -Infinity;
    const { alpha } = await refineMask(input);
    expect(Array.from(alpha).every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
  });

  it('preserves obvious foreground/background regions (no blanket erode/dilate)', async () => {
    // A large opaque square on a transparent field, with a matching guide edge:
    // the interior must stay ~1 and the far background ~0 after the whole
    // pipeline (guided filter + island removal + transition smoothing).
    const w = 60;
    const h = 60;
    const guide = new Float32Array(w * h);
    const mask = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inside = x >= 20 && x < 40 && y >= 20 && y < 40;
        guide[y * w + x] = inside ? 0.9 : 0.1;
        mask[y * w + x] = inside ? 1 : 0;
      }
    }
    const { alpha } = await refineMask({
      mask,
      maskWidth: w,
      maskHeight: h,
      width: w,
      height: h,
      guide,
      config: DEFAULT_FAST_REFINEMENT,
    });
    expect(alpha[30 * w + 30]).toBeGreaterThan(0.9); // interior stays foreground
    expect(alpha[2 * w + 2]).toBeLessThan(0.1); // far background stays background
  });

  it('keeps a thin connected structure through the whole pipeline', async () => {
    // A 2px-wide vertical line spanning most of the frame — thin, but connected
    // and far above the island-area floor, so the cleanup must not erase it.
    const w = 40;
    const h = 60;
    const guide = new Float32Array(w * h).fill(0.1);
    const mask = new Float32Array(w * h);
    for (let y = 4; y < h - 4; y++) {
      for (let x = 19; x <= 20; x++) {
        guide[y * w + x] = 0.9;
        mask[y * w + x] = 1;
      }
    }
    const { alpha } = await refineMask({
      mask,
      maskWidth: w,
      maskHeight: h,
      width: w,
      height: h,
      guide,
      config: DEFAULT_FAST_REFINEMENT,
    });
    let kept = 0;
    for (let y = 8; y < h - 8; y++) if (alpha[y * w + 19] >= 0.5 || alpha[y * w + 20] >= 0.5) kept++;
    expect(kept).toBeGreaterThan((h - 16) * 0.8);
  });
});

describe('removeTinyIslands', () => {
  it('removes a small isolated island but keeps a large one', () => {
    const w = 20;
    const h = 20;
    const alpha = new Float32Array(w * h);
    // A big blob (10x10 = 100 px).
    for (let y = 2; y < 12; y++) for (let x = 2; x < 12; x++) alpha[y * w + x] = 1;
    // A tiny 2x2 island (4 px).
    for (let y = 16; y < 18; y++) for (let x = 16; x < 18; x++) alpha[y * w + x] = 1;
    const removed = removeTinyIslands(alpha, w, h, 16);
    expect(removed).toBe(1);
    expect(alpha[2 * w + 2]).toBe(1);
    expect(alpha[16 * w + 16]).toBe(0);
  });

  it('keeps a thin but connected structure', () => {
    const w = 20;
    const h = 20;
    const alpha = new Float32Array(w * h);
    // A 1px-wide vertical line, 18px tall: thin but connected and above minArea.
    for (let y = 1; y < 19; y++) alpha[y * w + 10] = 1;
    const removed = removeTinyIslands(alpha, w, h, 16);
    expect(removed).toBe(0);
    expect(alpha[10 * w + 10]).toBe(1);
  });

  it('keeps a legitimately multi-part subject at the strict threshold', () => {
    // Several separated blobs, each above the strict (5e-4) bar — a bouquet or
    // a cutlery set. Only the one genuinely sub-threshold speck is dropped.
    const w = 200;
    const h = 200;
    const bar = minIslandArea(w, h, undefined, MIN_ISLAND_FRACTION_STRICT);
    expect(bar).toBe(20); // 200 * 200 * 5e-4
    const alpha = new Float32Array(w * h);
    const blobs: Array<[number, number]> = [[10, 10], [80, 20], [30, 120], [140, 150]];
    for (const [bx, by] of blobs) {
      for (let y = by; y < by + 6; y++) for (let x = bx; x < bx + 5; x++) alpha[y * w + x] = 1;
    }
    // One 3x3 = 9 px speck, below the bar.
    for (let y = 190; y < 193; y++) for (let x = 190; x < 193; x++) alpha[y * w + x] = 1;

    const removed = removeTinyIslands(alpha, w, h, bar);
    expect(removed).toBe(1);
    for (const [bx, by] of blobs) expect(alpha[(by + 2) * w + bx + 2]).toBe(1);
    expect(alpha[191 * w + 191]).toBe(0);
  });

  it('keeps a small deliberate part that only the fine variant keeps', () => {
    // A 6x6 = 36 px island: above the 16 px floor both variants share, but
    // below the strict bar of a 200x200 frame (20 px is the strict bar, so use
    // a smaller island than that to separate the variants).
    const w = 200;
    const h = 200;
    const strictBar = minIslandArea(w, h, undefined, MIN_ISLAND_FRACTION_STRICT);
    const fineBar = minIslandArea(w, h, undefined, MIN_ISLAND_FRACTION);
    expect(fineBar).toBe(16);
    expect(strictBar).toBe(20);
    const alpha = new Float32Array(w * h);
    // 4x4 = 16 px island: kept by fine, dropped by strict.
    for (let y = 100; y < 104; y++) for (let x = 100; x < 104; x++) alpha[y * w + x] = 1;
    const fine = Float32Array.from(alpha);
    const strict = Float32Array.from(alpha);
    expect(removeTinyIslands(fine, w, h, fineBar)).toBe(0);
    expect(removeTinyIslands(strict, w, h, strictBar)).toBe(1);
  });
});

describe('minIslandArea', () => {
  it('defaults to the fine 2e-5 fraction with a 16 px floor', () => {
    expect(MIN_ISLAND_FRACTION).toBe(ISLAND_CLEANUP_FRACTIONS.fine);
    expect(MIN_ISLAND_FRACTION_STRICT).toBe(ISLAND_CLEANUP_FRACTIONS.strict);
    expect(minIslandArea(100, 100)).toBe(16); // floor
    expect(minIslandArea(4000, 4000)).toBe(320); // 4000 * 4000 * 2e-5
  });

  it('uses the strict 5e-4 fraction when asked', () => {
    expect(minIslandArea(100, 100, undefined, MIN_ISLAND_FRACTION_STRICT)).toBe(16); // floor
    expect(minIslandArea(4000, 4000, undefined, MIN_ISLAND_FRACTION_STRICT)).toBe(8000);
  });

  it('is resolution-invariant when cleanup runs on a downscaled copy', () => {
    // A 4000x4000 output refined at 1000x1000: the bar must be the same
    // *fraction* of the work grid, not the output pixel count.
    const outputArea = 4000 * 4000;
    expect(minIslandArea(1000, 1000, outputArea)).toBe(20);
    expect(minIslandArea(1000, 1000, outputArea) / (1000 * 1000)).toBeCloseTo(2e-5, 12);
    expect(minIslandArea(4000, 4000, outputArea) / outputArea).toBeCloseTo(2e-5, 12);
    expect(minIslandArea(1000, 1000, outputArea, MIN_ISLAND_FRACTION_STRICT)).toBe(500);
  });
});
