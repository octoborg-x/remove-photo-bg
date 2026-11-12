// Full-resolution reconstruction of the model's soft probability mask (Stage 2
// of progressive refinement).
//
// The 512px model returns a `[1,1,512,512]` probability mask. Cropping the
// letterbox padding leaves a `rect.width x rect.height` float mask that is
// resized to the original image dimensions here, in floating point — never
// quantised to 8-bit first, and never nearest-neighbour, because a nearest
// resize of a soft mask produces a blocky, aliased edge that the refinement
// stage would then have to undo.
//
// Bilinear is the default (matches the reference pipeline's `pred_pil.resize`);
// bicubic is offered for a slightly tighter edge. Both are implemented as a
// separable two-pass resample with clamp-to-edge borders, and every output
// value is clamped to [0,1] with NaN/Infinity folded to 0 so a bad model output
// can never propagate.

export type ResizeInterpolation = 'bilinear' | 'bicubic';

interface TapPlan {
  /** First source index of each destination sample's kernel support. */
  start: Int32Array;
  /** Kernel weights, `taps` per destination sample, row-major. */
  weights: Float32Array;
  taps: number;
}

function cubicKernel(t: number): number {
  const a = Math.abs(t);
  if (a < 1) return (1.5 * a - 2.5) * a * a + 1;
  if (a < 2) return ((-0.5 * a + 2.5) * a - 4) * a + 2;
  return 0;
}

function buildTaps(srcN: number, dstN: number, interpolation: ResizeInterpolation): TapPlan {
  const taps = interpolation === 'bicubic' ? 4 : 2;
  const start = new Int32Array(dstN);
  const weights = new Float32Array(dstN * taps);
  const scale = srcN / dstN;
  for (let d = 0; d < dstN; d++) {
    // Map the destination sample centre back onto the source grid.
    const s = (d + 0.5) * scale - 0.5;
    const base = Math.floor(s);
    if (interpolation === 'bicubic') {
      start[d] = base - 1;
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const w = cubicKernel(s - (base - 1 + k));
        weights[d * 4 + k] = w;
        sum += w;
      }
      // Renormalise so clamp-to-edge support at the borders cannot darken or
      // brighten the result.
      if (sum !== 0) for (let k = 0; k < 4; k++) weights[d * 4 + k] /= sum;
    } else {
      const frac = s - base;
      start[d] = base;
      weights[d * 2] = 1 - frac;
      weights[d * 2 + 1] = frac;
    }
  }
  return { start, weights, taps };
}

function clampIndex(i: number, n: number): number {
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}

/**
 * Resizes a single-channel float mask. Separable (horizontal then vertical),
 * clamp-to-edge, output clamped to [0,1]. Non-finite inputs become 0.
 */
export function resizeMaskFloat(
  src: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  interpolation: ResizeInterpolation = 'bilinear',
): Float32Array {
  if (!(srcW > 0 && srcH > 0 && dstW > 0 && dstH > 0)) {
    throw new Error(`resizeMaskFloat: invalid dimensions ${srcW}x${srcH} -> ${dstW}x${dstH}`);
  }
  if (src.length !== srcW * srcH) {
    throw new Error(
      `resizeMaskFloat: source length ${src.length} does not match ${srcW}x${srcH}`,
    );
  }
  if (srcW === dstW && srcH === dstH) {
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      out[i] = Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
    }
    return out;
  }

  const xPlan = buildTaps(srcW, dstW, interpolation);
  const yPlan = buildTaps(srcH, dstH, interpolation);

  // Horizontal pass: srcW x srcH -> dstW x srcH.
  const mid = new Float32Array(dstW * srcH);
  for (let y = 0; y < srcH; y++) {
    const rowOff = y * srcW;
    const dstOff = y * dstW;
    for (let x = 0; x < dstW; x++) {
      const sx = xPlan.start[x];
      let acc = 0;
      for (let k = 0; k < xPlan.taps; k++) {
        const v = src[rowOff + clampIndex(sx + k, srcW)];
        acc += (Number.isFinite(v) ? v : 0) * xPlan.weights[x * xPlan.taps + k];
      }
      mid[dstOff + x] = acc;
    }
  }

  // Vertical pass: dstW x srcH -> dstW x dstH.
  const out = new Float32Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const sy = yPlan.start[y];
    const wOff = y * yPlan.taps;
    for (let x = 0; x < dstW; x++) {
      let acc = 0;
      for (let k = 0; k < yPlan.taps; k++) {
        acc += mid[clampIndex(sy + k, srcH) * dstW + x] * yPlan.weights[wOff + k];
      }
      out[y * dstW + x] = acc < 0 ? 0 : acc > 1 ? 1 : acc;
    }
  }
  return out;
}

/**
 * Crops the model-input probability mask down to the letterbox content rect,
 * keeping it in floating point. Mirrors `cropLetterboxMask` in
 * `mask-postprocess.ts`, which works on 8-bit masks.
 */
export function cropMaskFloat(
  mask: Float32Array,
  inputSize: number,
  rect: { x: number; y: number; width: number; height: number },
): Float32Array {
  if (mask.length !== inputSize * inputSize) {
    throw new Error(
      `cropMaskFloat: mask length ${mask.length} does not match a ${inputSize}x${inputSize} input`,
    );
  }
  const out = new Float32Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) {
    const srcRow = (rect.y + y) * inputSize + rect.x;
    out.set(mask.subarray(srcRow, srcRow + rect.width), y * rect.width);
  }
  return out;
}

/** 8-bit view of a soft float mask (clamped, rounded). Used to feed the
 *  existing 8-bit flood-fill recovery guard and the user threshold/feather. */
export function alphaToBytes(alpha: Float32Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(alpha.length);
  for (let i = 0; i < alpha.length; i++) {
    const v = alpha[i];
    out[i] = Math.round((Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0) * 255);
  }
  return out;
}

/** Float view of an 8-bit alpha mask. */
export function bytesToAlpha(bytes: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] / 255;
  return out;
}

/**
 * Rec. 601 luma of an RGBA buffer, normalised to [0,1]. The guided filter's
 * guidance image; computed once so the worker never receives the 4x larger RGBA
 * buffer.
 */
export function lumaFromRgba(data: Uint8ClampedArray): Float32Array {
  const n = data.length / 4;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 255;
  }
  return out;
}
