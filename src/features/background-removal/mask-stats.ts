// Raw-mask sanity statistics.
//
// A correctly-segmenting BiRefNet_lite mask is bimodal: most pixels sit near 0
// (background) or near 1 (subject), so it spans the whole [0,1] range. The
// failure this guards against is a mask squashed toward the middle — for
// example a second sigmoid over an already-probability output collapses [0,1]
// into ≈[0.5,0.73] — which composites to a uniform, washed-out "ghost" image.
//
// The statistics are measured once, right after inference (in the worker, see
// public/inference-worker.js) and folded into the user-copyable device report so
// a real-device tester can capture them in one tap.

export interface MaskStats {
  min: number;
  mean: number;
  max: number;
  /** Fraction of pixels below LOW_EDGE (background). */
  lowFraction: number;
  /** Fraction of pixels above HIGH_EDGE (subject). */
  highFraction: number;
}

/** A pixel below this is counted as clear background; above HIGH_EDGE, subject. */
const LOW_EDGE = 0.1;
const HIGH_EDGE = 0.9;

/** A mask whose mean sits in this band is where a squashed mask clusters. */
export const SUSPECT_MEAN_MIN = 0.45;
export const SUSPECT_MEAN_MAX = 0.8;

/**
 * Minimum combined tail mass (`lowFraction + highFraction`) for a mask to count
 * as bimodal. A healthy portrait can legitimately average ~0.6 (it is mostly
 * subject) but still spans 0..1, so the mean alone is not enough to flag it; a
 * squashed mask has almost no pixels in either tail.
 */
const MIN_BIMODAL_TAIL = 0.4;

/** Single-pass min/mean/max and tail fractions of a probability mask. */
export function maskStats(mask: ArrayLike<number>): MaskStats {
  const n = mask.length;
  if (n === 0) return { min: 0, mean: 0, max: 0, lowFraction: 0, highFraction: 0 };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let low = 0;
  let high = 0;
  for (let i = 0; i < n; i++) {
    const v = mask[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    if (v < LOW_EDGE) low++;
    else if (v > HIGH_EDGE) high++;
  }
  return { min, mean: sum / n, max, lowFraction: low / n, highFraction: high / n };
}

/**
 * True when the mask looks squashed toward the middle: its mean is in the
 * suspicious band AND it is not bimodal (too few pixels in either tail). A
 * legitimately subject-heavy photo is bimodal and is not flagged.
 */
export function isSuspiciousMask(stats: MaskStats): boolean {
  const midMean = stats.mean >= SUSPECT_MEAN_MIN && stats.mean <= SUSPECT_MEAN_MAX;
  const bimodal = stats.lowFraction + stats.highFraction >= MIN_BIMODAL_TAIL;
  return midMean && !bimodal;
}

/** Compact one-line form for the console and the device report. */
export function formatMaskStats(stats: MaskStats): string {
  return (
    `min ${stats.min.toFixed(3)} / mean ${stats.mean.toFixed(3)} / max ${stats.max.toFixed(3)} ` +
    `(tail ${(stats.lowFraction * 100).toFixed(0)}%/${(stats.highFraction * 100).toFixed(0)}%)`
  );
}
