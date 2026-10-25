// Post-process the raw model output (logits, [1,1,1024,1024]) into a soft alpha
// mask at the original image dimensions.
//
// Confirmed from upstream handler.py:
//   preds[..., -1].sigmoid()  -> soft mask in [0,1]
//   pred_pil.resize(image.size)  -> upscale mask to original dimensions
// Then mask is used as the image alpha.

import { MODEL_SIZE } from './image-preprocess';

export function logitsToMask(logits: Float32Array): Uint8ClampedArray {
  const mask = new Uint8ClampedArray(logits.length);
  for (let i = 0; i < logits.length; i++) {
    // sigmoid
    const s = 1 / (1 + Math.exp(-logits[i]));
    mask[i] = Math.round(Math.min(255, Math.max(0, s * 255)));
  }
  return mask;
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