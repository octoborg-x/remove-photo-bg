import { describe, it, expect } from 'vitest';
import { letterboxRect, MODEL_SIZE } from './image-preprocess';

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
