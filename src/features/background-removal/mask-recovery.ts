// Recovery for the model's "flooded mask" failure mode.
//
// BiRefNet_lite (QMix Cut-512) segments most photos well, but on some inputs it
// does not separate a subject at all: it returns near-1.0 probability across the
// whole frame, so the "cut-out" is the original image with the background still
// attached. It reproduces identically at int8, fp16 and fp32 precision, so it is
// the model's behaviour on those images, not a quantisation artefact. Measured on
// the 64-image eval set, the failure is characterised by BOTH a very high
// foreground fraction AND a foreground that reaches the image border (the border
// band is kept), e.g. ordinary-product-08.jpg: 96.7% foreground, border band
// 85.8%; large-04.jpg: 95.2% / 78.5%. Well-segmented photos never satisfy both.
//
// When that happens we fall back to a classic, deterministic technique: flood
// fill the connected region reachable from the image border through similar
// colours. Whatever is connected to the border is background; the rest is the
// subject. That is the standard "magic wand from the edges" cut-out and it covers
// the common cases the model floods on — products on a studio/white backdrop,
// screenshots and UI panels, flat-background graphics and logos. On the flooding
// eval images it recovers 4-30% foreground against the model's 87-97%.
//
// The recovery is only used when it actually shrinks the kept region, so a photo
// with a genuinely busy, non-uniform background keeps the model's mask.

import { upscaleMask } from './mask-postprocess';

export interface RecoveryOptions {
  /** Longest side of the working resolution for the flood fill. */
  maxSide?: number;
  /** Per-channel colour tolerance (0-255) when growing the background region. */
  tolerance?: number;
  /** Foreground fraction above which the model is considered to have flooded. */
  floodFraction?: number;
  /** Border-band foreground fraction above which the flood is confirmed. */
  borderFraction?: number;
}

export const DEFAULT_RECOVERY_OPTIONS: Required<RecoveryOptions> = {
  maxSide: 384,
  tolerance: 24,
  floodFraction: 0.75,
  borderFraction: 0.7,
};

/** Fraction of an 8-bit mask at or above `threshold` (default: the 0.5 cut). */
export function foregroundFraction(mask: Uint8ClampedArray, threshold = 128): number {
  let kept = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] >= threshold) kept++;
  return mask.length ? kept / mask.length : 0;
}

/** Fraction of the `band`-wide border ring that is foreground. A subject that
 *  reaches every edge (a flooded mask) scores near 1; a centred subject on a
 *  backdrop scores near 0. */
export function borderForegroundFraction(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  band = 0.06,
  threshold = 128,
): number {
  const bw = Math.max(1, Math.round(width * band));
  const bh = Math.max(1, Math.round(height * band));
  let kept = 0;
  let total = 0;
  for (let y = 0; y < height; y++) {
    const edgeRow = y < bh || y >= height - bh;
    for (let x = 0; x < width; x++) {
      if (!edgeRow && x >= bw && x < width - bw) continue;
      total++;
      if (mask[y * width + x] >= threshold) kept++;
    }
  }
  return total ? kept / total : 0;
}

/** True when the mask looks like the model flooded the frame: almost everything
 *  is kept AND the kept region reaches the image border. */
export function isFloodedMask(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  opts: RecoveryOptions = {},
): boolean {
  const o = { ...DEFAULT_RECOVERY_OPTIONS, ...opts };
  return (
    foregroundFraction(mask) > o.floodFraction &&
    borderForegroundFraction(mask, width, height) > o.borderFraction
  );
}

/** Box-average downsample of RGBA pixels to `ww x wh`, dropping alpha. Keeps the
 *  flood fill cheap and smooths sensor/texture noise that would leak the fill. */
function downsampleRgb(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  ww: number,
  wh: number,
): Uint8Array {
  const out = new Uint8Array(ww * wh * 3);
  for (let y = 0; y < wh; y++) {
    const sy0 = Math.floor((y * height) / wh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * height) / wh));
    for (let x = 0; x < ww; x++) {
      const sx0 = Math.floor((x * width) / ww);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * width) / ww));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1 && sy < height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < width; sx++) {
          const i = (sy * width + sx) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
      }
      const o = (y * ww + x) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  }
  return out;
}

/** Background-seeded flood fill: marks every pixel connected to the image border
 *  through colour steps within `tolerance` as background, and returns a full-size
 *  8-bit mask (255 = subject, 0 = background) at the image's resolution. */
export function floodFillForeground(
  image: ImageData,
  opts: RecoveryOptions = {},
): Uint8ClampedArray {
  const o = { ...DEFAULT_RECOVERY_OPTIONS, ...opts };
  const { data, width, height } = image;
  const scale = Math.min(1, o.maxSide / Math.max(width, height));
  const ww = Math.max(1, Math.round(width * scale));
  const wh = Math.max(1, Math.round(height * scale));
  const rgb = downsampleRgb(data, width, height, ww, wh);

  const bg = new Uint8Array(ww * wh);
  const stack: number[] = [];
  const seed = (idx: number): void => {
    if (!bg[idx]) {
      bg[idx] = 1;
      stack.push(idx);
    }
  };
  for (let x = 0; x < ww; x++) {
    seed(x);
    seed((wh - 1) * ww + x);
  }
  for (let y = 0; y < wh; y++) {
    seed(y * ww);
    seed(y * ww + ww - 1);
  }

  const tol = o.tolerance;
  while (stack.length) {
    const idx = stack.pop() as number;
    const y = (idx / ww) | 0;
    const x = idx - y * ww;
    const ci = idx * 3;
    const r = rgb[ci];
    const g = rgb[ci + 1];
    const b = rgb[ci + 2];
    const grow = (nidx: number): void => {
      if (bg[nidx]) return;
      const ni = nidx * 3;
      if (
        Math.abs(rgb[ni] - r) <= tol &&
        Math.abs(rgb[ni + 1] - g) <= tol &&
        Math.abs(rgb[ni + 2] - b) <= tol
      ) {
        bg[nidx] = 1;
        stack.push(nidx);
      }
    };
    if (x > 0) grow(idx - 1);
    if (x + 1 < ww) grow(idx + 1);
    if (y > 0) grow(idx - ww);
    if (y + 1 < wh) grow(idx + ww);
  }

  const small = new Uint8ClampedArray(ww * wh);
  for (let i = 0; i < small.length; i++) small[i] = bg[i] ? 0 : 255;
  return upscaleMask(small, ww, wh, width, height);
}

/** Applies the flood-fill recovery only when the model flooded the frame and the
 *  recovery meaningfully shrinks the kept region. Returns the model mask
 *  unchanged otherwise, so a well-segmented image is never altered. */
export function recoverForegroundMask(
  image: ImageData,
  modelMask: Uint8ClampedArray,
  opts: RecoveryOptions = {},
): { mask: Uint8ClampedArray; recovered: boolean } {
  const o = { ...DEFAULT_RECOVERY_OPTIONS, ...opts };
  if (!isFloodedMask(modelMask, image.width, image.height, o)) {
    return { mask: modelMask, recovered: false };
  }
  const recovered = floodFillForeground(image, o);
  const modelFg = foregroundFraction(modelMask);
  const recoveredFg = foregroundFraction(recovered);
  // Accept the recovery only when it is a genuine, usable cut-out: it must
  // shrink the kept region a lot (the fill found a separable background), while
  // keeping something (an empty result is its own failure mode) and not eating
  // into a busy scene the model may have been right about.
  if (recoveredFg < 0.01 || recoveredFg > 0.85 || recoveredFg >= modelFg - 0.2) {
    return { mask: modelMask, recovered: false };
  }
  return { mask: recovered, recovered: true };
}
