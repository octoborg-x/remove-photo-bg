// Progressive-refinement orchestration (Stages 2-4).
//
// Stage 2  full-resolution soft-mask reconstruction (float, bilinear/bicubic)
// Stage 3  image-guided edge refinement (guided filter, guided-filter.ts)
// Stage 4  conservative cleanup (clamp, tiny-island removal, guided transition
//          smoothing)
//
// Runs on the already-decoded original-resolution image (its luma is the guide)
// and the model's soft probability mask. The mask stays floating point until the
// very end; nothing here thresholds it into a binary source of truth. Pure and
// await-friendly: the caller can run it in a worker or chunked on the main
// thread, and pass hooks to yield between chunks and to abort.

import { resizeMaskFloat, type ResizeInterpolation } from './mask-resize';
import { guidedFilter } from './guided-filter';
import type { FastRefinementConfig } from './refinement-config';

export interface RefineHooks {
  /** Called between chunks; may throw to cancel. */
  onProgress?: (stage: 'upscale' | 'refine' | 'cleanup', fraction: number) => void;
  /** Throws when the job has been superseded/cancelled. */
  checkCancelled?: () => void;
}

export interface RefineTimings {
  /** Stage 2: mask reconstruction, ms. */
  upscaleMs: number;
  /** Stage 3: guided filter, ms. */
  refineMs: number;
  /** Stage 4: cleanup, ms. */
  cleanupMs: number;
  /** Total, ms. */
  totalMs: number;
  /** True when the stage worked on a downscaled copy (maxProcessingPixels cap). */
  downscaled: boolean;
  /** Working resolution actually refined. */
  workWidth: number;
  workHeight: number;
}

export interface RefineResult {
  /** Refined soft alpha at the original image dimensions, in [0,1]. */
  alpha: Float32Array;
  width: number;
  height: number;
  timings: RefineTimings;
}

export interface RefineInput {
  /** The model's probability mask, cropped to the letterbox content rect. */
  mask: Float32Array;
  /** Content-rect dimensions of `mask`. */
  maskWidth: number;
  maskHeight: number;
  /** Original image dimensions the alpha is reconstructed to. */
  width: number;
  height: number;
  /** Luma guide at the original image dimensions (image-preprocess `lumaFromRgba`). */
  guide: Float32Array;
  config: FastRefinementConfig;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

/** Smallest isolated island worth keeping, scaled to the image size. */
export function minIslandArea(width: number, height: number): number {
  return Math.max(16, Math.round(width * height * 2e-5));
}

/**
 * Removes only small isolated foreground islands: 8-connected components of the
 * binarised (>=0.5) mask whose area is below `minArea` have their alpha set to
 * 0. Large structures — including thin ones that are connected — are untouched,
 * so a jewellery chain or a strand of hair survives.
 */
export function removeTinyIslands(
  alpha: Float32Array,
  width: number,
  height: number,
  minArea: number,
): number {
  const n = width * height;
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  const comp: number[] = [];
  let removed = 0;
  for (let start = 0; start < n; start++) {
    if (seen[start] || alpha[start] < 0.5) continue;
    stack.length = 0;
    comp.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const idx = stack.pop() as number;
      comp.push(idx);
      const y = (idx / width) | 0;
      const x = idx - y * width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const ni = ny * width + nx;
          if (!seen[ni] && alpha[ni] >= 0.5) {
            seen[ni] = 1;
            stack.push(ni);
          }
        }
      }
    }
    if (comp.length < minArea) {
      for (const idx of comp) alpha[idx] = 0;
      removed++;
    }
  }
  return removed;
}

/**
 * Conservative, image-guided smoothing of the alpha transition zone only. Each
 * genuinely semi-transparent pixel is replaced by a small local average of its
 * semi-transparent neighbours, weighted down where the guide image differs (so a
 * real image boundary keeps its own alpha instead of being smeared across it).
 *
 * Flat, fully opaque and fully transparent regions are never touched, and no
 * global blur of the alpha channel is computed — only pixels already inside the
 * transition band are rewritten, from their neighbours inside the same band.
 */
export function smoothTransitionZone(
  alpha: Float32Array,
  guide: Float32Array,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(1, Math.round(radius));
  const edgeGain = 0.06; // guide luma difference that counts as a real edge
  const src = alpha.slice();
  const updates: Array<[number, number]> = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const a = src[i];
      if (a <= 0.02 || a >= 0.98) continue; // flat regions are left alone
      let sum = 0;
      let wsum = 0;
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(height - 1, y + r);
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width - 1, x + r);
      for (let ny = y0; ny <= y1; ny++) {
        for (let nx = x0; nx <= x1; nx++) {
          const ni = ny * width + nx;
          const na = src[ni];
          if (na <= 0.02 || na >= 0.98) continue;
          const gd = Math.abs(guide[ni] - guide[i]) / edgeGain;
          const gw = 1 / (1 + gd * gd);
          sum += na * gw;
          wsum += gw;
        }
      }
      if (wsum > 0) updates.push([i, sum / wsum]);
    }
  }
  for (const [i, v] of updates) alpha[i] = v;
}

/**
 * Runs Stages 2-4. When `config.enabled` is false (or the edge stage is off),
 * the corresponding stages are skipped and the mask is returned reconstructed
 * but unrefined, so an A/B comparison is exact.
 */
export async function refineMask(input: RefineInput, hooks: RefineHooks = {}): Promise<RefineResult> {
  const { config } = input;
  const t0 = now();
  hooks.checkCancelled?.();

  // ---- Stage 2: reconstruct the soft mask at the working resolution ----
  // `input.mask` is already cropped to the letterbox content rect by the caller
  // (cropMaskFloat), so it is resized straight to the original dimensions here.
  const tUp = now();
  let alpha = resizeMaskFloat(
    input.mask,
    input.maskWidth,
    input.maskHeight,
    input.width,
    input.height,
    config.maskUpscale.interpolation as ResizeInterpolation,
  );
  hooks.checkCancelled?.();
  const upscaleMs = now() - tUp;

  // Cap the working resolution so a 4096px image cannot blow the memory budget.
  const pixels = input.width * input.height;
  const maxPixels = config.performance.maxProcessingPixels;
  let workW = input.width;
  let workH = input.height;
  let guide = input.guide;
  let downscaled = false;
  if (pixels > maxPixels) {
    const scale = Math.sqrt(maxPixels / pixels);
    workW = Math.max(1, Math.round(input.width * scale));
    workH = Math.max(1, Math.round(input.height * scale));
    alpha = resizeMaskFloat(alpha, input.width, input.height, workW, workH, 'bilinear');
    guide = resizeMaskFloat(input.guide, input.width, input.height, workW, workH, 'bilinear');
    downscaled = true;
  }

  // ---- Stage 3: image-guided edge refinement ----
  const tRef = now();
  if (config.enabled && config.edgeRefinement.enabled) {
    await guidedFilter(
      guide,
      alpha,
      workW,
      workH,
      {
        radius: config.edgeRefinement.radius,
        epsilon: config.edgeRefinement.epsilon,
        strength: config.edgeRefinement.strength,
        edgeSensitivity: config.edgeRefinement.edgeSensitivity,
        chunkRows: config.performance.chunkRows,
      },
      {
        onChunk: (done, total) => {
          hooks.onProgress?.('refine', total ? done / total : 1);
          hooks.checkCancelled?.();
        },
      },
    );
  }
  hooks.checkCancelled?.();
  const refineMs = now() - tRef;

  // ---- Stage 4: conservative cleanup ----
  const tClean = now();
  if (config.enabled && config.cleanup.enabled) {
    if (config.cleanup.removeTinyIsolatedNoise) {
      removeTinyIslands(alpha, workW, workH, minIslandArea(workW, workH));
    }
    smoothTransitionZone(alpha, guide, workW, workH, Math.max(2, config.edgeRefinement.radius >> 1));
    const lo = config.cleanup.minAlpha;
    const hi = config.cleanup.maxAlpha;
    for (let i = 0; i < alpha.length; i++) alpha[i] = lo + clamp01(alpha[i]) * (hi - lo);
  } else {
    for (let i = 0; i < alpha.length; i++) alpha[i] = clamp01(alpha[i]);
  }
  hooks.onProgress?.('cleanup', 1);
  hooks.checkCancelled?.();

  // Restore the original resolution if the stage worked downscaled.
  if (downscaled) {
    alpha = resizeMaskFloat(alpha, workW, workH, input.width, input.height, 'bilinear');
  }
  const cleanupMs = now() - tClean;

  return {
    alpha,
    width: input.width,
    height: input.height,
    timings: {
      upscaleMs,
      refineMs,
      cleanupMs,
      totalMs: now() - t0,
      downscaled,
      workWidth: workW,
      workHeight: workH,
    },
  };
}
