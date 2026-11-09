// Post-process the model's probability mask ([1,1,N,N] in [0,1]) into a soft alpha
// mask at the original image dimensions.
//
// Confirmed from upstream handler.py:
//   preds[..., -1].sigmoid()  -> soft mask in [0,1]  (applied in the worker)
//   pred_pil.resize(image.size)  -> upscale mask to original dimensions
// Then mask is used as the image alpha.

export function probabilityToMask(prob: Float32Array): Uint8ClampedArray {
  const mask = new Uint8ClampedArray(prob.length);
  for (let i = 0; i < prob.length; i++) {
    mask[i] = Math.round(Math.min(255, Math.max(0, prob[i] * 255)));
  }
  return mask;
}

/** Crops the model-input mask down to the letterbox content rect (see
 *  `letterboxRect`), returning the square's worth of mask that corresponds to
 *  the image. Any mask value in the padded border is discarded, so the neutral
 *  fill can never leak into the result. */
export function cropLetterboxMask(
  mask: Uint8ClampedArray,
  inputSize: number,
  rect: { x: number; y: number; width: number; height: number },
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) {
    const srcRow = (rect.y + y) * inputSize + rect.x;
    out.set(mask.subarray(srcRow, srcRow + rect.width), y * rect.width);
  }
  return out;
}

export function upscaleMask(
  mask: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8ClampedArray {
  // Bilinear upscale of the mask to the original image dimensions.
  const out = new Uint8ClampedArray(dstW * dstH);
  const sxScale = srcW / dstW;
  const syScale = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const sy = y * syScale;
    const y0 = Math.floor(sy);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const wy = sy - y0;
    for (let x = 0; x < dstW; x++) {
      const sx = x * sxScale;
      const x0 = Math.floor(sx);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const wx = sx - x0;
      const v00 = mask[y0 * srcW + x0];
      const v01 = mask[y0 * srcW + x1];
      const v10 = mask[y1 * srcW + x0];
      const v11 = mask[y1 * srcW + x1];
      const top = v00 * (1 - wx) + v01 * wx;
      const bottom = v10 * (1 - wx) + v11 * wx;
      out[y * dstW + x] = Math.round(top * (1 - wy) + bottom * wy);
    }
  }
  return out;
}

export interface MaskAdjust {
  /** Cutoff (0-100, percent of 255) below which alpha is forced to 0. 0 = off. */
  threshold: number;
  /** Feather radius in destination pixels (0-64). 0 = off. */
  feather: number;
}

export const DEFAULT_MASK_ADJUST: MaskAdjust = { threshold: 0, feather: 0 };

export function isMaskAdjust(v: unknown): v is MaskAdjust {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.threshold === 'number' &&
    Number.isFinite(o.threshold) &&
    o.threshold >= 0 &&
    o.threshold <= 100 &&
    typeof o.feather === 'number' &&
    Number.isFinite(o.feather) &&
    o.feather >= 0 &&
    o.feather <= 64
  );
}

// Applies the user's mask adjustments to an 8-bit alpha mask (already at the
// destination resolution). Threshold first (hard cut), then a separable box
// blur (feather). The threshold clamp before blurring keeps a sharp inner edge
// while softening the outer transition; feather at radius 0 is a no-op, so the
// default settings leave the mask byte-for-byte unchanged.
export function applyMaskAdjust(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  adjust: MaskAdjust,
): Uint8ClampedArray {
  let m = mask;
  if (adjust.threshold > 0) {
    const cutoff = Math.round((adjust.threshold / 100) * 255);
    m = new Uint8ClampedArray(mask.length);
    for (let i = 0; i < mask.length; i++) m[i] = mask[i] > cutoff ? 255 : 0;
  }
  if (adjust.feather <= 0) return m;
  return boxBlur(m, width, height, Math.round(adjust.feather));
}

// Separable box blur with clamp-to-edge borders. Two horizontal passes of the
// intended radius (≈ half the desired feather) avoid the blocky box-artefacts
// of a single pass; the result is a smooth falloff without a true gaussian's
// cost.
function boxBlur(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
): Uint8ClampedArray {
  const pass = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  const r = Math.max(1, radius >> 1);
  // Horizontal.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      pass[row + x] = sum / (2 * r + 1);
      const add = src[row + Math.min(w - 1, x + r + 1)];
      const sub = src[row + Math.max(0, x - r)];
      sum += add - sub;
    }
  }
  // Vertical.
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += pass[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / (2 * r + 1);
      const add = pass[Math.min(h - 1, y + r + 1) * w + x];
      const sub = pass[Math.max(0, y - r) * w + x];
      sum += add - sub;
    }
  }
  return out;
}

export function applyMaskToImage(
  image: ImageData,
  mask: Uint8ClampedArray,
): ImageData {
  const out = new ImageData(image.width, image.height);
  for (let i = 0; i < image.data.length; i += 4) {
    out.data[i] = image.data[i];
    out.data[i + 1] = image.data[i + 1];
    out.data[i + 2] = image.data[i + 2];
    out.data[i + 3] = mask[i / 4];
  }
  return out;
}