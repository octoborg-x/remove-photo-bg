// Output-alpha classification: the user-visible half of the "washed-out ghost".
//
// The load-bearing regression is the GHOST export a real Adreno-6xx phone
// produced (the image the user attached): a flat, low-confidence mask that
// composites the whole photo at ~20–40% opacity. It has NO pixel above the
// mid-alpha cutoff, so the old `opaquePx === 0` check called it "fully
// transparent" — the opposite of what is on screen. `classifyOutputAlpha` must
// name it `washed` and must NOT flag a normal cut-out, an empty result, or a
// "kept everything" result.
import { describe, it, expect } from 'vitest';
import {
  outputAlphaStats,
  classifyOutputAlpha,
  outputAlphaWarning,
  formatOutputAlphaStats,
  transitionBandFraction,
  NEAR_OPAQUE_ALPHA,
  WASHED_MIN_COVERAGE,
} from './output-alpha';

/** The real ghost export alpha (attached by the user): 256x385, min 2 / mean
 *  58.0 / max 105. Flat and faint over the WHOLE frame, no opaque core. */
function ghostExportAlpha(): Uint8ClampedArray {
  const w = 256;
  const h = 385;
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // A smooth ~51px-period wave in x, constant down every column, spanning
      // ~[2, 105] — matching the measured min/mean/max.
      const wave = 0.5 + 0.5 * Math.sin((2 * Math.PI * x) / 51.2);
      out[y * w + x] = Math.round(2 + wave * 103);
    }
  }
  return out;
}

/** A normal cut-out: transparent background, a solid (255) subject core. */
function cleanCutoutAlpha(): Uint8ClampedArray {
  const w = 200;
  const h = 200;
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = (x - 100) ** 2 + (y - 100) ** 2 < 60 ** 2;
      out[y * w + x] = inside ? 255 : 0;
    }
  }
  return out;
}

describe('outputAlphaStats', () => {
  it('reads a flat alpha array (stride 1)', () => {
    const s = outputAlphaStats(new Uint8ClampedArray([0, 128, 255]));
    expect(s.count).toBe(3);
    expect(s.min).toBe(0);
    expect(s.max).toBe(255);
    expect(s.mean).toBeCloseTo((0 + 128 + 255) / 3, 5);
    expect(s.anyFraction).toBeCloseTo(2 / 3, 5);
    expect(s.opaqueFraction).toBeCloseTo(1 / 3, 5);
  });

  it('reads the alpha channel of an interleaved RGBA buffer', () => {
    // RGB values must be ignored; only every 4th byte from offset 3 is alpha.
    const rgba = new Uint8ClampedArray([9, 9, 9, 0, 9, 9, 9, 255, 9, 9, 9, 128]);
    const s = outputAlphaStats(rgba, 4, 3);
    expect(s.count).toBe(3);
    expect(s.min).toBe(0);
    expect(s.max).toBe(255);
    expect(s.anyFraction).toBeCloseTo(2 / 3, 5);
    expect(s.opaqueFraction).toBeCloseTo(1 / 3, 5);
  });

  it('returns a zeroed profile for an empty buffer', () => {
    const s = outputAlphaStats(new Uint8ClampedArray(0));
    expect(s).toEqual({ count: 0, min: 0, max: 0, mean: 0, anyFraction: 0, opaqueFraction: 0 });
  });
});

describe('classifyOutputAlpha', () => {
  it('flags the real device ghost as "washed", not "empty"', () => {
    const s = outputAlphaStats(ghostExportAlpha());
    // Guard the fixture itself against drift: it must reproduce the device shape.
    expect(s.min).toBeLessThan(10);
    expect(s.max).toBeLessThan(NEAR_OPAQUE_ALPHA);
    expect(s.max).toBeGreaterThan(90);
    expect(s.mean).toBeGreaterThan(40);
    expect(s.mean).toBeLessThan(80);
    expect(s.anyFraction).toBeGreaterThanOrEqual(WASHED_MIN_COVERAGE);
    expect(classifyOutputAlpha(s)).toBe('washed');
  });

  it('does not flag a clean cut-out', () => {
    expect(classifyOutputAlpha(outputAlphaStats(cleanCutoutAlpha()))).toBe('ok');
  });

  it('classifies a fully transparent frame as "empty"', () => {
    expect(classifyOutputAlpha(outputAlphaStats(new Uint8ClampedArray(64)))).toBe('empty');
  });

  it('classifies an all-opaque frame as "kept"', () => {
    const all = new Uint8ClampedArray(64).fill(255);
    expect(classifyOutputAlpha(outputAlphaStats(all))).toBe('kept');
  });

  it('does not flag a faint but SMALL translucent subject (only part of the frame)', () => {
    // A 20x20 patch at alpha 100 inside a 200x200 transparent frame: faint, but
    // it covers ~1% of the frame, so it is a real (if soft) object, not a wash.
    const w = 200;
    const out = new Uint8ClampedArray(w * w);
    for (let y = 90; y < 110; y++) for (let x = 90; x < 110; x++) out[y * w + x] = 100;
    expect(classifyOutputAlpha(outputAlphaStats(out))).toBe('ok');
  });

  it('treats the frame being exactly at the wash threshold as washed', () => {
    const n = 1000;
    const out = new Uint8ClampedArray(n);
    // 90% faint, 10% fully transparent.
    for (let i = 0; i < n; i++) out[i] = i < n * WASHED_MIN_COVERAGE ? 100 : 0;
    expect(classifyOutputAlpha(outputAlphaStats(out))).toBe('washed');
  });
});

describe('outputAlphaWarning', () => {
  it('names the ghost explicitly and points at Copy report', () => {
    const msg = outputAlphaWarning('washed');
    expect(msg).toMatch(/ghost/i);
    expect(msg).toMatch(/Copy report/);
  });

  it('keeps the empty and kept messages, and stays silent when ok', () => {
    expect(outputAlphaWarning('empty')).toMatch(/fully transparent/);
    expect(outputAlphaWarning('kept')).toMatch(/no background was found/);
    expect(outputAlphaWarning('ok')).toBeNull();
  });
});

describe('transitionBandFraction', () => {
  it('is 0 for a hard-edged mask (every pixel flat)', () => {
    // Half background (0), half solid subject (255) — no partial alpha at all.
    const a = new Uint8ClampedArray(100).fill(0);
    a.fill(255, 50);
    expect(transitionBandFraction(a)).toBe(0);
  });

  it('is 1 when every pixel is mid-alpha', () => {
    const a = new Uint8ClampedArray(100).fill(128);
    expect(transitionBandFraction(a)).toBe(1);
  });

  it('counts only the partial band, ignoring flat 0/255 pixels', () => {
    const a = new Uint8ClampedArray(100).fill(0);
    a.fill(255, 50); // 50 flat
    a[0] = 1; // below the low cut (a/255 = 0.004)
    a[1] = 250; // above the high cut (a/255 = 0.980)
    a[2] = 128; // in the band
    expect(transitionBandFraction(a)).toBeCloseTo(1 / 100, 6);
  });

  it('honours a stride/offset for an interleaved RGBA buffer', () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 128]);
    expect(transitionBandFraction(rgba, 4, 3)).toBeCloseTo(1 / 3, 6);
  });
});

describe('formatOutputAlphaStats', () => {
  it('renders a compact one-line summary', () => {
    const s = outputAlphaStats(ghostExportAlpha());
    const line = formatOutputAlphaStats(s);
    expect(line).toMatch(/^min \d+ \/ mean \d+\.\d \/ max \d+ \(any \d+\.\d%, opaque \d+\.\d%\)$/);
  });
});
