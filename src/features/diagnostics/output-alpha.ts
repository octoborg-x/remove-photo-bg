// Output-alpha classification — the user-visible half of the "washed-out ghost"
// diagnostic.
//
// `raw-mask-stats.ts` reads the MODEL's output; this reads the FINAL composited
// alpha (the cut-out the user actually sees and exports). The two catch different
// things, and the final alpha is the one that decides whether the result looks
// right:
//
//   - A clean cut-out has a near-opaque foreground core (some pixels at alpha
//     255) and a transparent background, so it is neither empty nor faint.
//   - The ghost failure has NO near-opaque pixel at all, yet the faint alpha
//     covers the whole frame: the model emitted a flat, low-confidence mask
//     (measured on a real Adreno-6xx phone: min 0.008 / mean 0.228 / max 0.412),
//     so every pixel of the photo shows through at ~20–40% — a uniform wash.
//
// The empty and "kept" cases were already handled; the ghost was NOT: it has zero
// pixels above the mid-alpha cutoff, so the old `opaquePx === 0` test reported
// "fully transparent, no subject to show" for an image whose whole frame is
// plainly visible. `classifyOutputAlpha` names that third shape instead.

/**
 * Alpha at or above which a pixel counts as part of the subject's solid core.
 * Every non-empty result in the 64-image eval set reaches 254+, so a result that
 * never reaches this has no confident foreground.
 */
export const NEAR_OPAQUE_ALPHA = 230;

/** A "kept everything" result: essentially the whole frame stays opaque. */
export const KEPT_OPAQUE_FRACTION = 0.995;

/** Coverage above which a faint result is a full-frame wash rather than a small
 *  faint object (e.g. a distant, semi-transparent product). The ghost covers the
 *  whole frame; a legitimately translucent subject covers only part of it. */
export const WASHED_MIN_COVERAGE = 0.9;

export interface OutputAlphaStats {
  /** Pixels examined. */
  count: number;
  /** 0–255. */
  min: number;
  max: number;
  mean: number;
  /** Share of pixels with any visibility at all (alpha > 0). */
  anyFraction: number;
  /** Share of pixels in the subject's solid core (alpha >= NEAR_OPAQUE_ALPHA). */
  opaqueFraction: number;
}

/**
 * Single-pass statistics over an alpha channel. Accepts a plain array (default
 * `stride` 1) or an interleaved RGBA buffer (`stride` 4, `offset` 3) so the caller
 * never has to copy the alpha out of an ImageData. Read-only; never allocates a
 * second buffer.
 */
export function outputAlphaStats(
  alpha: ArrayLike<number>,
  stride = 1,
  offset = 0,
): OutputAlphaStats {
  const step = Math.max(1, Math.floor(stride));
  let count = 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let any = 0;
  let opaque = 0;
  for (let i = offset; i < alpha.length; i += step) {
    const v = alpha[i];
    count++;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    if (v > 0) any++;
    if (v >= NEAR_OPAQUE_ALPHA) opaque++;
  }
  if (count === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, anyFraction: 0, opaqueFraction: 0 };
  }
  return {
    count,
    min,
    max,
    mean: sum / count,
    anyFraction: any / count,
    opaqueFraction: opaque / count,
  };
}

export type OutputAlphaVerdict =
  /** Nothing visible: the mask removed the whole frame. */
  | 'empty'
  /** The whole frame is faintly visible with no opaque core — the ghost. */
  | 'washed'
  /** Essentially nothing removed: the frame stayed opaque. */
  | 'kept'
  /** A normal cut-out with a real foreground core. */
  | 'ok';

/**
 * Classifies the final alpha. Order matters: an empty result (max 0) is checked
 * first, then "kept" (a solid frame can never be faint), then the ghost — faint
 * (no near-opaque pixel) yet covering most of the frame.
 */
export function classifyOutputAlpha(stats: OutputAlphaStats): OutputAlphaVerdict {
  if (stats.count === 0 || stats.max <= 0) return 'empty';
  if (stats.opaqueFraction >= KEPT_OPAQUE_FRACTION) return 'kept';
  if (stats.max < NEAR_OPAQUE_ALPHA && stats.anyFraction >= WASHED_MIN_COVERAGE) return 'washed';
  return 'ok';
}

/** Alpha band (0..1 scale) outside which a pixel counts as flat foreground or
 *  background. Mirrors the guided-filter transition test in `refine-mask.ts`. */
const FLAT_ALPHA_LOW = 0.02;
const FLAT_ALPHA_HIGH = 0.98;

/**
 * Share of pixels that sit in the soft transition band (`0.02 < a < 0.98`) — the
 * partially-transparent edge of a cut-out. A crisp cut-out keeps this small (the
 * three reference masks measure 0.013–0.019); a wide, blurred edge raises it.
 * `recommendTiling` uses it to decide whether tiling would sharpen this image.
 */
export function transitionBandFraction(alpha: ArrayLike<number>, stride = 1, offset = 0): number {
  const step = Math.max(1, Math.floor(stride));
  let count = 0;
  let band = 0;
  for (let i = offset; i < alpha.length; i += step) {
    const v = alpha[i] / 255;
    count++;
    if (v > FLAT_ALPHA_LOW && v < FLAT_ALPHA_HIGH) band++;
  }
  return count === 0 ? 0 : band / count;
}

/** The console message for a non-ok verdict, or null when the result is fine. */
export function outputAlphaWarning(verdict: OutputAlphaVerdict): string | null {
  switch (verdict) {
    case 'empty':
      return 'the mask is fully transparent, so there is no subject to show.';
    case 'kept':
      return 'no background was found, so nothing was removed.';
    case 'washed':
      return (
        'the whole frame came out faint and translucent — a washed-out "ghost" — ' +
        'because the model found no confident foreground. Use Copy report in the ' +
        'Console header for the details.'
      );
    default:
      return null;
  }
}

/** Compact one-line form for the console, mirroring `formatRawMaskStats`. */
export function formatOutputAlphaStats(stats: OutputAlphaStats): string {
  return (
    `min ${stats.min.toFixed(0)} / mean ${stats.mean.toFixed(1)} / max ${stats.max.toFixed(0)} ` +
    `(any ${(stats.anyFraction * 100).toFixed(1)}%, opaque ${(stats.opaqueFraction * 100).toFixed(1)}%)`
  );
}
