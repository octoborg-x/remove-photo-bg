// User-triggered "auto colour contour cleanup" for the manual retouch layer.
//
// This is the same image-guided edge refinement Stage 3 of progressive
// refinement runs (`guided-filter.ts`), invoked here as a one-shot action on the
// mask the user is editing. The photo's luma is the guide, so the alpha edge
// snaps to real colour edges; flat regions are smoothed. There is no erode,
// dilate, or global blur, so thin connected structures survive. The optional
// tiny-island pass reuses `removeTinyIslands` from `refine-mask.ts`.
//
// Pure and DOM-free apart from reading an `ImageData` value.

import { guidedFilter } from './guided-filter';
import { lumaFromRgba } from './mask-resize';
import { removeTinyIslands, minIslandArea } from './refine-mask';

export interface ContourCleanupOptions {
  /** Guided-filter window radius in pixels. */
  radius?: number;
  /** Guided-filter regularization; larger is smoother. */
  epsilon?: number;
  /** Blend of the filtered alpha over the raw alpha, 0..1. */
  strength?: number;
  /** >1 follows image edges more tightly. */
  edgeSensitivity?: number;
  /** Rows per band before yielding. */
  chunkRows?: number;
  /** Drop disconnected islands below the bar (off by default). */
  removeTinyIslands?: boolean;
  /** Absolute island-area bar in pixels; defaults to `minIslandArea`. */
  minIslandArea?: number;
  /** Called after each band; may throw to cancel. */
  onChunk?: (rowsDone: number, totalRows: number) => void;
}

/**
 * Conservative defaults. Strength stays below 1 so a hard guide edge sharpens
 * the transition without fully binarising it, and the island pass is off: the
 * user is in control and a deliberate small part must not vanish.
 */
export const DEFAULT_CONTOUR_CLEANUP = {
  radius: 4,
  epsilon: 1e-4,
  strength: 0.9,
  edgeSensitivity: 1,
  chunkRows: 64,
  removeTinyIslands: false,
} as const;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

/**
 * Tightens `alpha` (length `image.width * image.height`, values in [0,1]) to the
 * colour edges in `image`. Returns a new float array; `alpha` is not mutated.
 */
export async function autoContourCleanup(
  image: ImageData,
  alpha: Float32Array,
  opts: ContourCleanupOptions = {},
): Promise<Float32Array> {
  const { width, height } = image;
  if (alpha.length !== width * height) {
    throw new Error(
      `autoContourCleanup: expected ${width * height} alpha values, got ${alpha.length}`,
    );
  }
  const radius = Math.max(1, Math.round(opts.radius ?? DEFAULT_CONTOUR_CLEANUP.radius));
  const epsilon = opts.epsilon ?? DEFAULT_CONTOUR_CLEANUP.epsilon;
  const strength = clamp01(opts.strength ?? DEFAULT_CONTOUR_CLEANUP.strength);
  const edgeSensitivity = opts.edgeSensitivity ?? DEFAULT_CONTOUR_CLEANUP.edgeSensitivity;
  const chunkRows = Math.max(1, Math.round(opts.chunkRows ?? DEFAULT_CONTOUR_CLEANUP.chunkRows));

  const guide = lumaFromRgba(image.data);
  const out = new Float32Array(alpha);
  await guidedFilter(
    guide,
    out,
    width,
    height,
    { radius, epsilon, strength, edgeSensitivity, chunkRows },
    { onChunk: opts.onChunk },
  );

  for (let i = 0; i < out.length; i++) out[i] = clamp01(out[i]);

  if (opts.removeTinyIslands ?? DEFAULT_CONTOUR_CLEANUP.removeTinyIslands) {
    removeTinyIslands(
      out,
      width,
      height,
      opts.minIslandArea ?? minIslandArea(width, height),
    );
  }
  return out;
}
