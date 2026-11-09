import { describe, it, expect } from 'vitest';
import { letterboxRect, replicateEdges, MODEL_SIZE } from './image-preprocess';

describe('letterboxRect', () => {
  it('fills the square exactly for a square source', () => {
    expect(letterboxRect(800, 800)).toEqual({
      x: 0,
      y: 0,
      width: MODEL_SIZE,
      height: MODEL_SIZE,
    });
  });

  it('fits a wide image to full width and pads top/bottom', () => {
    // 1005x260 (the logo that collapsed): the long side maps to 512.
    const r = letterboxRect(1005, 260);
    expect(r.width).toBe(MODEL_SIZE);
    expect(r.height).toBe(Math.round((260 * MODEL_SIZE) / 1005));
    expect(r.x).toBe(0);
    expect(r.y).toBe(Math.floor((MODEL_SIZE - r.height) / 2));
  });

  it('fits a tall image to full height and pads left/right', () => {
    const r = letterboxRect(960, 1400);
    expect(r.height).toBe(MODEL_SIZE);
    expect(r.width).toBe(Math.round((960 * MODEL_SIZE) / 1400));
    expect(r.y).toBe(0);
    expect(r.x).toBe(Math.floor((MODEL_SIZE - r.width) / 2));
  });

  it('keeps the content inside the square and preserves the aspect ratio', () => {
    for (const [w, h] of [
      [1005, 260],
      [960, 1400],
      [1280, 853],
      [200, 4000],
      [4000, 200],
    ]) {
      const r = letterboxRect(w, h);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(MODEL_SIZE);
      expect(r.y + r.height).toBeLessThanOrEqual(MODEL_SIZE);
      // The fitted content keeps the source aspect ratio to within rounding.
      const srcAspect = w / h;
      const fitAspect = r.width / r.height;
      expect(Math.abs(fitAspect - srcAspect) / srcAspect).toBeLessThan(0.02);
    }
  });

  it('honours an explicit model size', () => {
    expect(letterboxRect(1024, 512, 384)).toEqual({
      x: 0,
      y: 96,
      width: 384,
      height: 192,
    });
  });

  it('never produces a zero-sized rect for a degenerate source', () => {
    const r = letterboxRect(10000, 1);
    expect(r.width).toBe(MODEL_SIZE);
    expect(r.height).toBeGreaterThanOrEqual(1);
  });
});

describe('replicateEdges', () => {
  // 2x2 content: distinct colour per corner so we can tell which edge won.
  const content = new Uint8ClampedArray([
    10, 0, 0, 255, /* TL */ 20, 0, 0, 255, /* TR */
    30, 0, 0, 255, /* BL */ 40, 0, 0, 255, /* BR */
  ]);

  it('copies the content into its rect unchanged', () => {
    const rect = { x: 1, y: 1, width: 2, height: 2 };
    const out = replicateEdges(content, rect, 4, 4);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        const o = ((1 + y) * 4 + (1 + x)) * 4;
        const s = (y * 2 + x) * 4;
        expect(out[o]).toBe(content[s]);
      }
    }
  });

  it('replicates edge pixels outward instead of leaving a flat border', () => {
    // A wide content rect (2x1 at y=1) pads the top/bottom rows by clamping.
    const wide = new Uint8ClampedArray([100, 0, 0, 255, 200, 0, 0, 255]);
    const rect = { x: 1, y: 1, width: 2, height: 1 };
    const out = replicateEdges(wide, rect, 4, 4);
    const at = (x: number, y: number) => out[(y * 4 + x) * 4];
    // Row 0 (above the content) copies the content row verbatim.
    expect([at(1, 0), at(2, 0)]).toEqual([100, 200]);
    // Row 3 (below) is the same, and the left/right columns clamp to the edge.
    expect([at(1, 3), at(2, 3)]).toEqual([100, 200]);
    expect(at(0, 1)).toBe(100); // left column = leftmost content pixel
    expect(at(3, 1)).toBe(200); // right column = rightmost content pixel
    // No pixel is left at the old flat fill (0,0,0,0).
    expect(out.every((_, i) => i % 4 !== 3 || out[i] === 255)).toBe(true);
  });
});
