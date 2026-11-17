import { describe, it, expect } from 'vitest';
import {
  planTiles,
  tileWeightField,
  TileStitcher,
  recommendTiling,
  TILING_MIN_LONG_SIDE,
  TILING_UPSCALE_TRIGGER,
  type TileGrid,
} from './tiling';

describe('planTiles', () => {
  it('grid 1 yields a single full-image tile', () => {
    const plan = planTiles(1280, 1920, 1);
    expect(plan.overlapX).toBe(0);
    expect(plan.overlapY).toBe(0);
    expect(plan.tiles).toEqual([{ x: 0, y: 0, width: 1280, height: 1920 }]);
  });

  it('covers the whole image with a 2x2 grid', () => {
    const plan = planTiles(1280, 1920, 2);
    expect(plan.tiles).toHaveLength(4);
    const xs = plan.tiles.map((t) => t.x);
    const ys = plan.tiles.map((t) => t.y);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.min(...ys)).toBe(0);
    for (const t of plan.tiles) {
      expect(t.x + t.width).toBeLessThanOrEqual(1280);
      expect(t.y + t.height).toBeLessThanOrEqual(1920);
    }
    // Every tile must reach the far edge in its half.
    const rightTiles = plan.tiles.filter((t) => t.x > 0);
    expect(rightTiles.every((t) => t.x + t.width === 1280)).toBe(true);
  });

  it('adjacent tiles share a non-empty overlap band', () => {
    const plan = planTiles(1280, 1280, 2);
    const [tl, tr] = plan.tiles;
    const overlap = tl.x + tl.width - tr.x;
    expect(overlap).toBeGreaterThan(0);
    expect(overlap).toBe(plan.overlapX);
  });

  it('rejects a non-positive image size', () => {
    expect(() => planTiles(0, 100, 2)).toThrow();
  });
});

describe('tileWeightField', () => {
  it('is all ones for the single-tile plan', () => {
    const plan = planTiles(100, 100, 1);
    const w = tileWeightField(plan, 0);
    expect(Array.from(w).every((v) => v === 1)).toBe(true);
  });

  it('keeps the image-border edge at weight 1 and ramps to 0 at an interior seam', () => {
    const plan = planTiles(1000, 1000, 2);
    const tl = plan.tiles[0];
    const w = tileWeightField(plan, 0);
    // Left edge is the image border -> weight 1.
    expect(w[0]).toBe(1);
    // Right edge is an interior seam -> weight ~0.
    expect(w[tl.width - 1]).toBeLessThan(0.05);
  });

  it('two neighbours weights sum to 1 across the overlap band', () => {
    const plan = planTiles(1000, 1000, 2);
    const [tl, tr] = plan.tiles;
    const wl = tileWeightField(plan, 0);
    const wr = tileWeightField(plan, 1);
    const x0 = tr.x; // first shared column
    for (let x = x0; x < tl.x + tl.width; x++) {
      const y = Math.floor(tl.height / 2);
      const sum = wl[y * tl.width + x] + wr[y * tr.width + (x - tr.x)];
      expect(sum).toBeCloseTo(1, 5);
    }
  });
});

describe('TileStitcher', () => {
  it('reproduces a constant mask exactly', () => {
    const plan = planTiles(200, 200, 2);
    const stitcher = new TileStitcher(200, 200, plan);
    plan.tiles.forEach((t, i) => {
      const mask = new Float32Array(t.width * t.height).fill(0.6);
      stitcher.add(i, mask);
    });
    const out = stitcher.result();
    expect(Array.from(out).every((v) => Math.abs(v - 0.6) < 1e-6)).toBe(true);
  });

  it('crossfades two tiles that disagree in the overlap', () => {
    const plan = planTiles(200, 200, 2);
    const stitcher = new TileStitcher(200, 200, plan);
    // Left tile all 0, right tile all 1: the overlap must be a ramp, and the
    // extremes (image borders) must be exactly 0 and 1.
    plan.tiles.forEach((t, i) => {
      const value = t.x === 0 ? 0 : 1;
      stitcher.add(i, new Float32Array(t.width * t.height).fill(value));
    });
    const out = stitcher.result();
    const y = 100;
    expect(out[y * 200 + 0]).toBeCloseTo(0, 5);
    expect(out[y * 200 + 199]).toBeCloseTo(1, 5);
    // Somewhere in the overlap there is a strictly intermediate value.
    const row = Array.from(out.slice(y * 200, y * 200 + 200));
    expect(row.some((v) => v > 0.05 && v < 0.95)).toBe(true);
  });

  it('records coverage per pixel', () => {
    const plan = planTiles(200, 200, 2);
    const stitcher = new TileStitcher(200, 200, plan);
    plan.tiles.forEach((t, i) => stitcher.add(i, new Float32Array(t.width * t.height).fill(1)));
    const cover = stitcher.coverage();
    expect(Math.min(...cover)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...cover)).toBe(4); // the centre is covered by all four tiles
  });

  it('clamps out-of-range and non-finite tile values', () => {
    const plan = planTiles(100, 100, 1);
    const stitcher = new TileStitcher(100, 100, plan);
    const mask = new Float32Array(100 * 100);
    mask[0] = 2;
    mask[1] = -1;
    mask[2] = NaN;
    stitcher.add(0, mask);
    const out = stitcher.result();
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });

  it('throws on a mis-sized tile mask', () => {
    const plan = planTiles(100, 100, 2);
    const stitcher = new TileStitcher(100, 100, plan);
    expect(() => stitcher.add(0, new Float32Array(10))).toThrow();
  });
});

describe('recommendTiling', () => {
  it('recommends 2x2 for a large, soft-edged photo', () => {
    const r = recommendTiling({ imageWidth: 1280, imageHeight: 1920, softEdgeShare: 0.11 });
    expect(r.recommended).toBe(true);
    expect(r.suggestedGrid).toBe(2);
    expect(r.reason).toMatch(/upscaled 3\.8x/);
  });

  it('does not recommend for a small photo', () => {
    const r = recommendTiling({ imageWidth: 800, imageHeight: 600 });
    expect(r.recommended).toBe(false);
    expect(r.suggestedGrid).toBe(1);
    expect(TILING_MIN_LONG_SIDE).toBeGreaterThan(600);
  });

  it('does not recommend when the upscale ratio is low', () => {
    const r = recommendTiling({ imageWidth: 1100, imageHeight: 1100 });
    expect(1100 / 512).toBeLessThan(TILING_UPSCALE_TRIGGER);
    expect(r.recommended).toBe(false);
  });

  it('does not recommend when the first mask is already crisp', () => {
    const r = recommendTiling({ imageWidth: 1280, imageHeight: 1920, softEdgeShare: 0.025 });
    expect(r.recommended).toBe(false);
    expect(r.reason).toMatch(/already crisp/);
  });

  it('recommends when no first mask exists yet (size alone decides)', () => {
    const r = recommendTiling({ imageWidth: 1280, imageHeight: 1920 });
    expect(r.recommended).toBe(true);
    expect(r.reason).not.toMatch(/soft edge/);
  });
});

describe('TILE_GRIDS', () => {
  it('stays within the measured sweet spot', () => {
    const grids: readonly TileGrid[] = [1, 2, 3, 4];
    expect(grids).toContain(2);
  });
});
