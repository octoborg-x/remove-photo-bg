// Raw-mask statistics — the most important diagnostic.
//
// Measured directly from the model's ORIGINAL floating-point output (the
// `msg.mask` a `result-ready` carries), BEFORE any probability conversion,
// letterbox crop, upscaling, foreground recovery, thresholding, feathering, or
// edge refinement. The final composited image is never read here, so a bug in
// the post-processing pipeline cannot mask (or fake) what the model actually
// produced.
//
// A correctly-segmenting BiRefNet_lite mask is bimodal: most pixels sit near 0
// (background) or near 1 (subject), so it spans the whole [0,1] range. The
// failure these numbers expose is a mask squashed toward the middle — e.g. a
// second sigmoid over an already-probability output collapses [0,1] into
// ≈[0.5,0.73] — which composites to a uniform, washed-out "ghost" image.
//
// The function is pure and independently testable, and avoids copies: it walks
// the input once and never allocates a second array of the mask.

/**
 * Raw-mask statistics, keyed to the diagnostic report's `rawMask` block.
 *
 * Threshold definitions (fractions are proportions of `count`, i.e. the number
 * of elements examined — non-finite values are counted separately and excluded
 * from the min/mean/max and from every fraction's numerator, but included in
 * `count`):
 *   - `below_001_fraction` — share of elements strictly less than 0.01
 *   - `below_01_fraction`  — share of elements strictly less than 0.1
 *   - `below_05_fraction`  — share of elements strictly less than 0.5
 *   - `above_095_fraction` — share of elements strictly greater than 0.95
 *   - `above_099_fraction` — share of elements strictly greater than 0.99
 */
export interface RawMaskStats {
  width: number;
  height: number;
  min: number;
  mean: number;
  max: number;
  below_001_fraction: number;
  below_01_fraction: number;
  below_05_fraction: number;
  above_095_fraction: number;
  above_099_fraction: number;
  non_finite_count: number;
}

/** Empty/undecodable statistics: a zeroed block rather than a throw. */
export function emptyRawMaskStats(width = 0, height = 0): RawMaskStats {
  return {
    width,
    height,
    min: 0,
    mean: 0,
    max: 0,
    below_001_fraction: 0,
    below_01_fraction: 0,
    below_05_fraction: 0,
    above_095_fraction: 0,
    above_099_fraction: 0,
    non_finite_count: 0,
  };
}

/**
 * Single-pass statistics over the raw model output.
 *
 * `mask` is read-only and never mutated or copied. When `width`/`height` are not
 * supplied (the worker sends a flat `Float32Array` plus the model's square input
 * size), pass them explicitly; when the element count does not match
 * `width * height` the recorded dimensions fall back to `0x0` so a mismatch is
 * visible rather than silently reported as a real shape.
 */
export function rawMaskStats(
  mask: ArrayLike<number>,
  width?: number,
  height?: number,
): RawMaskStats {
  const n = mask.length;
  if (n === 0) return emptyRawMaskStats(width ?? 0, height ?? 0);

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let finite = 0;
  let nonFinite = 0;
  let below001 = 0;
  let below01 = 0;
  let below05 = 0;
  let above095 = 0;
  let above099 = 0;

  for (let i = 0; i < n; i++) {
    const v = mask[i];
    // NaN and ±Infinity are not valid probabilities. Count them and keep them
    // out of the range/mean so one bad element cannot turn the whole report into
    // NaN (which would hide the real distribution).
    if (!Number.isFinite(v)) {
      nonFinite++;
      continue;
    }
    finite++;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    if (v < 0.01) below001++;
    if (v < 0.1) below01++;
    if (v < 0.5) below05++;
    if (v > 0.95) above095++;
    if (v > 0.99) above099++;
  }

  // Only finite elements contribute to the fractions' denominators: a mask that
  // is entirely NaN has no meaningful distribution and reports all-zero stats.
  const denom = finite;
  const w = width ?? 0;
  const h = height ?? 0;
  const shapeOk = width === undefined || height === undefined || w * h === n;
  return {
    width: shapeOk ? w : 0,
    height: shapeOk ? h : 0,
    min: finite ? min : 0,
    mean: finite ? sum / finite : 0,
    max: finite ? max : 0,
    below_001_fraction: denom ? below001 / denom : 0,
    below_01_fraction: denom ? below01 / denom : 0,
    below_05_fraction: denom ? below05 / denom : 0,
    above_095_fraction: denom ? above095 / denom : 0,
    above_099_fraction: denom ? above099 / denom : 0,
    non_finite_count: nonFinite,
  };
}

/**
 * Minimum combined tail mass for a mask to count as bimodal.
 *
 * A correct segmentation is bimodal: its mass sits at 0 (background) and at 1
 * (subject), so the share of pixels within 0.1 of either extreme stays high —
 * every image in the 64-image eval set measures ≥0.99, whether it is a
 * subject-heavy portrait, a tiny product, or a (legitimately) empty result.
 *
 * A mask whose mass is piled in the MIDDLE has almost none: both a double
 * sigmoid over an already-probability output (which squashes [0,1] into
 * ≈[0.5,0.73]) and the real-device flat mask (measured min 0.007 / mean 0.232 /
 * max 0.633, 0% >0.95) land far below it. Those composite to a uniform,
 * washed-out "ghost", so both must be flagged.
 */
export const MIN_BIMODAL_TAIL = 0.4;

/**
 * True when the mask is not bimodal: too little of it sits near 0 (background)
 * or near 1 (subject), so the bulk is stuck in the mid-range and the cut-out
 * composites to a uniform, washed-out "ghost".
 *
 * The test is bimodality alone, deliberately with NO mean band. An earlier
 * version also required `mean ∈ [0.45, 0.80]`, which is the band a double-sigmoid
 * squash clusters in — but the real-device failure is flat at mean ≈0.23 with no
 * foreground core at all, so that guard stayed silent on the very image it
 * existed to catch (HARDWARE_TESTING.md §8). Bimodality catches both shapes and
 * is provider-independent: a correct mask (including a legitimately subject-heavy
 * or nearly-empty one) always puts most of its mass at an extreme.
 */
export function isSuspectRawMask(stats: RawMaskStats): boolean {
  const tail = stats.below_01_fraction + stats.above_095_fraction;
  return tail < MIN_BIMODAL_TAIL;
}

/** Compact one-line form for the console. */
export function formatRawMaskStats(stats: RawMaskStats): string {
  return (
    `min ${stats.min.toFixed(3)} / mean ${stats.mean.toFixed(3)} / max ${stats.max.toFixed(3)} ` +
    `(tail ${(stats.below_01_fraction * 100).toFixed(0)}%/${(stats.above_095_fraction * 100).toFixed(0)}%` +
    (stats.non_finite_count ? `, ${stats.non_finite_count} non-finite` : '') +
    ')'
  );
}
