import { describe, it, expect } from 'vitest';
import { guidedFilter } from './guided-filter';

// A synthetic scene: a hard vertical edge in the guide at x = w/2, and a mask
// whose edge is in the same place but blurred (a wide transition band). The
// guided filter should tighten the mask's transition towards the guide edge
// while leaving the flat interiors alone.
function makeScene(w: number, h: number) {
  const guide = new Float32Array(w * h);
  const mask = new Float32Array(w * h);
  const half = Math.floor(w / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      guide[i] = x < half ? 0 : 1;
      // Mask: 0 well inside the left, 1 well inside the right, linear ramp of
      // width 10 px straddling the boundary.
      const d = x - half;
      mask[i] = d <= -5 ? 0 : d >= 5 ? 1 : (d + 5) / 10;
    }
  }
  return { guide, mask };
}

// Peak per-pixel alpha step across the transition. A guided filter that follows
// the guide's hard edge raises this sharply; a plain blur would lower it. This
// is the same gradient-based sharpness signal the repo's compare-models.py uses.
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

describe('guidedFilter', () => {
  it('tightens a blurred edge towards the guide edge', async () => {
    const w = 64;
    const h = 32;
    const { guide, mask } = makeScene(w, h);
    const before = maxGradient(mask, w, h);
    const out = await guidedFilter(guide, mask, w, h, {
      radius: 8,
      epsilon: 1e-4,
      strength: 1,
      edgeSensitivity: 1,
      chunkRows: 8,
    });
    const after = maxGradient(out, w, h);
    expect(after).toBeGreaterThan(before * 2);
    expect(out.length).toBe(w * h);
    expect(Array.from(out).every((v) => v >= 0 && v <= 1)).toBe(true);
  });

  it('leaves flat regions unchanged', async () => {
    const w = 32;
    const h = 16;
    const guide = new Float32Array(w * h).fill(0.5);
    const mask = new Float32Array(w * h).fill(0.7);
    const out = await guidedFilter(guide, mask, w, h, {
      radius: 4,
      epsilon: 1e-4,
      strength: 1,
      edgeSensitivity: 1,
      chunkRows: 4,
    });
    expect(Array.from(out).every((v) => Math.abs(v - 0.7) < 1e-4)).toBe(true);
  });

  it('strength 0 returns the raw mask unchanged', async () => {
    const w = 16;
    const h = 16;
    const { guide, mask } = makeScene(w, h);
    const original = Float32Array.from(mask);
    const out = await guidedFilter(guide, mask, w, h, {
      radius: 4,
      epsilon: 1e-4,
      strength: 0,
      edgeSensitivity: 1,
      chunkRows: 4,
    });
    expect(Array.from(out)).toEqual(Array.from(original));
  });

  it('awaits onChunk once per band in each pass', async () => {
    const w = 8;
    const h = 10;
    const guide = new Float32Array(w * h).fill(0.5);
    const mask = new Float32Array(w * h).fill(0.5);
    const calls: number[] = [];
    await guidedFilter(
      guide,
      mask,
      w,
      h,
      { radius: 2, epsilon: 1e-4, strength: 1, edgeSensitivity: 1, chunkRows: 4 },
      { onChunk: (done) => void calls.push(done) },
    );
    // 3 bands (4,8,10) x 2 passes.
    expect(calls).toEqual([4, 8, 10, 4, 8, 10]);
  });

  it('propagates a cancellation error thrown by onChunk', async () => {
    const w = 8;
    const h = 8;
    const guide = new Float32Array(w * h).fill(0.5);
    const mask = new Float32Array(w * h).fill(0.5);
    let n = 0;
    await expect(
      guidedFilter(
        guide,
        mask,
        w,
        h,
        { radius: 2, epsilon: 1e-4, strength: 1, edgeSensitivity: 1, chunkRows: 2 },
        {
          onChunk: () => {
            if (++n === 2) throw new Error('cancelled');
          },
        },
      ),
    ).rejects.toThrow('cancelled');
  });

  it('throws on a length mismatch', async () => {
    await expect(
      guidedFilter(new Float32Array(4), new Float32Array(3), 2, 2, {
        radius: 1,
        epsilon: 1e-4,
        strength: 1,
        edgeSensitivity: 1,
        chunkRows: 1,
      }),
    ).rejects.toThrow(/expected/);
  });
});
