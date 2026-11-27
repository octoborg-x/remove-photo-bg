import { describe, it, expect } from 'vitest';
import {
  applyStroke,
  replayBrushStrokes,
  initialBrushHistory,
  pushBrushStroke,
  undoBrushStroke,
  redoBrushStroke,
  canUndoBrush,
  canRedoBrush,
  type BrushStroke,
} from './brush-edit';

const W = 32;
const H = 32;

function alphaAt(alpha: Float32Array, x: number, y: number): number {
  return alpha[y * W + x];
}

function restorePoint(x: number, y: number, size = 10, feather = 0): BrushStroke {
  return { tool: 'restore', points: [{ x, y }], size, feather };
}

function erasePoint(x: number, y: number, size = 10, feather = 0): BrushStroke {
  return { tool: 'erase', points: [{ x, y }], size, feather };
}

describe('applyStroke', () => {
  it('restores alpha inside the brush and leaves the outside untouched', () => {
    const base = new Float32Array(W * H);
    const out = applyStroke(base, W, H, restorePoint(10, 10));
    expect(alphaAt(out, 10, 10)).toBeCloseTo(1, 6);
    expect(alphaAt(out, 2, 2)).toBe(0);
    // The input is a base mask and must never be mutated in place.
    expect(alphaAt(base, 10, 10)).toBe(0);
  });

  it('erases alpha inside the brush and leaves the outside untouched', () => {
    const base = new Float32Array(W * H).fill(1);
    const out = applyStroke(base, W, H, erasePoint(16, 16));
    expect(alphaAt(out, 16, 16)).toBeCloseTo(0, 6);
    expect(alphaAt(out, 2, 2)).toBe(1);
    expect(alphaAt(base, 16, 16)).toBe(1);
  });

  it('feathers the edge: hard disc is fully opaque, soft disc fades out', () => {
    const base = new Float32Array(W * H);
    const hard = applyStroke(base, W, H, restorePoint(16, 16, 10, 0));
    const soft = applyStroke(base, W, H, restorePoint(16, 16, 10, 0.8));
    // A pixel near the rim: the hard brush still covers it fully, the soft one
    // only partially.
    const rim = alphaAt(hard, 20, 16);
    const softRim = alphaAt(soft, 20, 16);
    expect(rim).toBeCloseTo(1, 6);
    expect(softRim).toBeGreaterThan(0);
    expect(softRim).toBeLessThan(rim);
    // The centre is opaque for both.
    expect(alphaAt(soft, 16, 16)).toBeCloseTo(1, 6);
  });

  it('paints the whole path between two points, not just the endpoints', () => {
    const base = new Float32Array(W * H).fill(1);
    const out = applyStroke(base, W, H, {
      tool: 'erase',
      points: [{ x: 4, y: 16 }, { x: 28, y: 16 }],
      size: 6,
      feather: 0,
    });
    expect(alphaAt(out, 4, 16)).toBeCloseTo(0, 6);
    expect(alphaAt(out, 16, 16)).toBeCloseTo(0, 6);
    expect(alphaAt(out, 28, 16)).toBeCloseTo(0, 6);
    expect(alphaAt(out, 16, 2)).toBe(1);
  });

  it('scales a stroke from canvas coordinates onto the alpha grid', () => {
    // The stroke was recorded on a 100x100 canvas but the alpha is 50x50.
    const base = new Float32Array(50 * 50);
    const out = applyStroke(base, 50, 50, restorePoint(50, 50, 10), 100, 100);
    expect(out[25 * 50 + 25]).toBeCloseTo(1, 6);
    expect(out[10 * 50 + 10]).toBe(0);
  });

  it('rejects a length mismatch', () => {
    expect(() => applyStroke(new Float32Array(3), W, H, restorePoint(1, 1))).toThrow(/expected/);
  });

  it('honours per-point pressure', () => {
    const base = new Float32Array(W * H);
    const full = applyStroke(base, W, H, { tool: 'restore', points: [{ x: 16, y: 16, pressure: 1 }], size: 10, feather: 0 });
    const half = applyStroke(base, W, H, { tool: 'restore', points: [{ x: 16, y: 16, pressure: 0.5 }], size: 10, feather: 0 });
    expect(alphaAt(half, 16, 16)).toBeCloseTo(0.5, 6);
    expect(alphaAt(full, 16, 16)).toBeCloseTo(1, 6);
  });
});

describe('replayBrushStrokes', () => {
  it('is deterministic and matches applying the strokes in sequence', () => {
    const base = new Float32Array(W * H).fill(0.5);
    const strokes: BrushStroke[] = [
      restorePoint(10, 10, 8, 0.4),
      erasePoint(18, 18, 6, 0.2),
      { tool: 'restore', points: [{ x: 5, y: 25 }, { x: 25, y: 5 }], size: 4, feather: 0.5 },
    ];
    const a = replayBrushStrokes(base, W, H, strokes);
    const b = replayBrushStrokes(base, W, H, strokes);
    expect(Array.from(a)).toEqual(Array.from(b));

    let sequential: Float32Array = base;
    for (const stroke of strokes) sequential = applyStroke(sequential, W, H, stroke);
    expect(Array.from(a)).toEqual(Array.from(sequential));
    // The base is untouched.
    expect(Array.from(base).every((v) => v === 0.5)).toBe(true);
  });
});

describe('brush history', () => {
  const a = restorePoint(4, 4);
  const b = erasePoint(8, 8);

  it('pushes strokes and clears redo', () => {
    let h = initialBrushHistory();
    h = pushBrushStroke(h, a);
    h = pushBrushStroke(h, b);
    expect(h.strokes).toEqual([a, b]);
    expect(canUndoBrush(h)).toBe(true);
    expect(canRedoBrush(h)).toBe(false);
  });

  it('undoes and redoes stroke by stroke, in order', () => {
    let h = pushBrushStroke(pushBrushStroke(initialBrushHistory(), a), b);
    h = undoBrushStroke(h);
    expect(h.strokes).toEqual([a]);
    expect(canRedoBrush(h)).toBe(true);
    h = undoBrushStroke(h);
    expect(h.strokes).toEqual([]);
    expect(canUndoBrush(h)).toBe(false);
    h = redoBrushStroke(h);
    expect(h.strokes).toEqual([a]);
    h = redoBrushStroke(h);
    expect(h.strokes).toEqual([a, b]);
    expect(canRedoBrush(h)).toBe(false);
  });

  it('a new stroke after undo clears the redo stack', () => {
    let h = pushBrushStroke(pushBrushStroke(initialBrushHistory(), a), b);
    h = undoBrushStroke(h);
    h = pushBrushStroke(h, a);
    expect(h.strokes).toEqual([a, a]);
    expect(canRedoBrush(h)).toBe(false);
  });

  it('undo/redo on an empty history is a no-op', () => {
    const h = initialBrushHistory();
    expect(undoBrushStroke(h)).toBe(h);
    expect(redoBrushStroke(h)).toBe(h);
  });
});
