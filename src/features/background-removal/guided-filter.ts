// Image-guided edge refinement (Stage 3 of progressive refinement).
//
// This is the classic guided filter of He, Sun & Tang (ECCV 2010) — a fast,
// deterministic, non-learned edge-preserving smoother — not a model and not a
// bilateral approximation. The original full-resolution luma of the photo is the
// guidance image `I`; the reconstructed soft mask is the input `p`; the output
// `q` is a mask whose edges snap to the image's real edges while flat regions
// are smoothed.
//
// It replaces neither the model nor the composite: it only sharpens the soft
// alpha the 512px model already produced, using detail the image itself carries
// (the model never *detects* new structure here). Thin structures are preserved
// because the filter follows the guidance edges; there is no open/close/erode/
// dilate and no global blur.
//
// Memory: the guided filter needs four box-filtered planes (mean_I, mean_p,
// corr_I, corr_Ip) to derive the per-pixel linear coefficients (a, b), and then
// two more box filters of a and b. Holding all six planes at full resolution
// would be six float planes; instead the coefficients are produced in horizontal
// row-bands with the kernel overlap re-read per band, so the transient working
// set is O(band width * (chunkRows + 2*radius)) and only `a` and `b` persist.
// The caller (refine-mask.ts) bounds the persistent set further by capping the
// processing resolution via `maxProcessingPixels`.

export interface GuidedFilterOptions {
  /** Window radius in pixels. */
  radius: number;
  /** Regularization term (guide is in [0,1]). Larger = smoother. */
  epsilon: number;
  /** Blend of filtered over raw alpha, 0..1. */
  strength: number;
  /** >1 follows image edges more tightly (sharper, less smoothing). */
  edgeSensitivity: number;
  /** Output rows produced per band before yielding. */
  chunkRows: number;
}

export interface GuidedFilterHooks {
  /** Called after each band. May throw (e.g. a cancellation error). */
  onChunk?: (rowsDone: number, totalRows: number) => Promise<void> | void;
}

function clampIndex(i: number, n: number): number {
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}

/** Sliding-window box filter of one row, clamp-to-edge. `win = 2r+1`. */
function horizontalBoxRow(
  src: Float32Array,
  srcOff: number,
  w: number,
  r: number,
  win: number,
  dst: Float32Array,
  dstOff: number,
): void {
  let sum = 0;
  for (let k = -r; k <= r; k++) sum += src[srcOff + clampIndex(k, w)];
  for (let x = 0; x < w; x++) {
    dst[dstOff + x] = sum / win;
    sum += src[srcOff + clampIndex(x + r + 1, w)] - src[srcOff + clampIndex(x - r, w)];
  }
}

/** Sliding-window box filter of the elementwise product of two rows. */
function horizontalBoxRowProd(
  a: Float32Array,
  b: Float32Array,
  srcOff: number,
  w: number,
  r: number,
  win: number,
  dst: Float32Array,
  dstOff: number,
): void {
  let sum = 0;
  for (let k = -r; k <= r; k++) {
    const i = srcOff + clampIndex(k, w);
    sum += a[i] * b[i];
  }
  for (let x = 0; x < w; x++) {
    dst[dstOff + x] = sum / win;
    const add = srcOff + clampIndex(x + r + 1, w);
    const sub = srcOff + clampIndex(x - r, w);
    sum += a[add] * b[add] - a[sub] * b[sub];
  }
}

/**
 * Vertical box filter of a horizontally-filtered band. `hband` covers input rows
 * `[ey0, ey1)`; writes output rows `[oy0, oy1)` into `out` starting at row 0.
 * Uses a running per-column sum so the band costs O(w * bandHeight).
 */
function verticalBoxBand(
  hband: Float32Array,
  w: number,
  bandH: number,
  ey0: number,
  r: number,
  win: number,
  oy0: number,
  oy1: number,
  out: Float32Array,
): void {
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += hband[clampIndex(oy0 + k - ey0, bandH) * w + x];
    for (let y = oy0; y < oy1; y++) {
      out[(y - oy0) * w + x] = sum / win;
      sum +=
        hband[clampIndex(y + r + 1 - ey0, bandH) * w + x] -
        hband[clampIndex(y - r - ey0, bandH) * w + x];
    }
  }
}

/**
 * Applies the guided filter to `mask` in place (guide = `guide`, both length
 * w*h, both in [0,1]) and returns the blended alpha:
 *   out = strength * q + (1 - strength) * mask
 * Runs band-by-band, awaiting `hooks.onChunk` after each band so the caller can
 * yield to the event loop or cancel. Pure and deterministic given no hooks.
 */
export async function guidedFilter(
  guide: Float32Array,
  mask: Float32Array,
  w: number,
  h: number,
  opts: GuidedFilterOptions,
  hooks: GuidedFilterHooks = {},
): Promise<Float32Array> {
  if (guide.length !== w * h || mask.length !== w * h) {
    throw new Error(
      `guidedFilter: expected ${w * h} values, got guide ${guide.length} / mask ${mask.length}`,
    );
  }
  const r = Math.max(1, Math.round(opts.radius));
  const win = 2 * r + 1;
  // edgeSensitivity > 1 shrinks the regularization term (edges followed more
  // tightly); < 1 grows it (more smoothing). Never below a small floor.
  const sens = Math.max(0.05, opts.edgeSensitivity);
  const eps = Math.max(1e-8, opts.epsilon / (sens * sens));
  const strength = Math.max(0, Math.min(1, opts.strength));
  const chunkRows = Math.max(1, Math.round(opts.chunkRows));
  const N = w * h;

  // Coefficients persist for the second box-filter pass.
  const a = new Float32Array(N);
  const b = new Float32Array(N);

  const maxBandH = Math.min(h, chunkRows + 2 * r);
  const hI = new Float32Array(w * maxBandH);
  const hP = new Float32Array(w * maxBandH);
  const hII = new Float32Array(w * maxBandH);
  const hIP = new Float32Array(w * maxBandH);
  const vA = new Float32Array(w * chunkRows);
  const vB = new Float32Array(w * chunkRows);
  const vC = new Float32Array(w * chunkRows);
  const vD = new Float32Array(w * chunkRows);

  // Pass A: per-pixel linear coefficients a, b.
  for (let oy0 = 0; oy0 < h; oy0 += chunkRows) {
    const oy1 = Math.min(h, oy0 + chunkRows);
    const ey0 = Math.max(0, oy0 - r);
    const ey1 = Math.min(h, oy1 + r);
    const bandH = ey1 - ey0;
    for (let y = ey0; y < ey1; y++) {
      const off = (y - ey0) * w;
      const src = y * w;
      horizontalBoxRow(guide, src, w, r, win, hI, off);
      horizontalBoxRow(mask, src, w, r, win, hP, off);
      horizontalBoxRowProd(guide, guide, src, w, r, win, hII, off);
      horizontalBoxRowProd(guide, mask, src, w, r, win, hIP, off);
    }
    verticalBoxBand(hI, w, bandH, ey0, r, win, oy0, oy1, vA);
    verticalBoxBand(hP, w, bandH, ey0, r, win, oy0, oy1, vB);
    verticalBoxBand(hII, w, bandH, ey0, r, win, oy0, oy1, vC);
    verticalBoxBand(hIP, w, bandH, ey0, r, win, oy0, oy1, vD);
    for (let y = oy0; y < oy1; y++) {
      const o = y * w;
      const bo = (y - oy0) * w;
      for (let x = 0; x < w; x++) {
        const mi = vA[bo + x];
        const mp = vB[bo + x];
        const varI = vC[bo + x] - mi * mi;
        const covIp = vD[bo + x] - mi * mp;
        const ai = covIp / (varI + eps);
        a[o + x] = ai;
        b[o + x] = mp - ai * mi;
      }
    }
    await hooks.onChunk?.(oy1, h);
  }

  // Pass B: box-filter a and b, then q = mean_a * guide + mean_b, blended.
  for (let oy0 = 0; oy0 < h; oy0 += chunkRows) {
    const oy1 = Math.min(h, oy0 + chunkRows);
    const ey0 = Math.max(0, oy0 - r);
    const ey1 = Math.min(h, oy1 + r);
    const bandH = ey1 - ey0;
    for (let y = ey0; y < ey1; y++) {
      const off = (y - ey0) * w;
      const src = y * w;
      horizontalBoxRow(a, src, w, r, win, hI, off);
      horizontalBoxRow(b, src, w, r, win, hP, off);
    }
    verticalBoxBand(hI, w, bandH, ey0, r, win, oy0, oy1, vA);
    verticalBoxBand(hP, w, bandH, ey0, r, win, oy0, oy1, vB);
    for (let y = oy0; y < oy1; y++) {
      const o = y * w;
      const bo = (y - oy0) * w;
      for (let x = 0; x < w; x++) {
        const q = vA[bo + x] * guide[o + x] + vB[bo + x];
        const qc = q < 0 ? 0 : q > 1 ? 1 : q;
        mask[o + x] = strength * qc + (1 - strength) * mask[o + x];
      }
    }
    await hooks.onChunk?.(oy1, h);
  }

  return mask;
}
