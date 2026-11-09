// Pre-process an ImageData (already decoded RGB) into the model's expected
// NCHW Float32 tensor [1, 3, MODEL_SIZE, MODEL_SIZE].
//
// Confirmed from the upstream code/config:
// - fit to (MODEL_SIZE, MODEL_SIZE) with bilinear interpolation (resample=2),
//   preserving the aspect ratio (letterbox) rather than stretching to fill
// - rescale by 1/255
// - normalize with ImageNet mean/std [0.485,0.456,0.406] / [0.229,0.224,0.225]
//
// This does the resize in JS (via an offscreen canvas) and then builds the NCHW
// tensor directly. For Phase 1 the tensor layout correctness matters more than
// matching torch's exact Resize rounding; pixel differences of a few units are
// acceptable for a smoke test, but the pipeline (inference + mask + alpha) must
// be checked end-to-end (see scripts/run-smoke.mjs + HARDWARE_TESTING.md).

// The model's input is square and fixed by its export. BiRefNet_lite is
// exported at 1024x1024 and _lite_512 at 512x512; the smaller input needs ~4x
// less activation memory, which is the difference between fitting in a browser
// and failing with std::bad_alloc.
export const MODEL_SIZE = 512;

// A non-square image is fit into the square input preserving its aspect ratio
// (letterbox) rather than stretched to fill it. Stretching collapses the mask on
// extreme aspect ratios: a 1005x260 logo squashed to 512x512 comes back with a
// peak probability of 0.0002 (an empty result), while the aspect-preserving fit
// segments it normally. On ordinary photos the two agree to ~0.99 IoU, so the
// fit costs nothing there and only rescues the degenerate cases.
//
// The letterbox border is filled black. Over the 62-image eval set black
// rescues the most squash-collapsed images (e.g. a thin-structure photo goes
// 0% -> 80% foreground) with no regression against grey/white borders; the
// model never sees the padded pixels' verdict anyway, because the mask is
// cropped back to the content rect (see `cropLetterboxMask`) before use.
export const LETTERBOX_PAD = 0;

export interface LetterboxRect {
  /** Left offset of the content inside the square model input. */
  x: number;
  /** Top offset of the content inside the square model input. */
  y: number;
  /** Content width after the aspect-preserving resize. */
  width: number;
  /** Content height after the aspect-preserving resize. */
  height: number;
}

/** The largest `size`-square fit of a sourceWidth x sourceHeight image that
 *  keeps its aspect ratio, centred in the square. Pure geometry, so the main
 *  thread can compute the identical rect to crop the mask back. */
export function letterboxRect(
  sourceWidth: number,
  sourceHeight: number,
  size: number = MODEL_SIZE,
): LetterboxRect {
  const scale = size / Math.max(sourceWidth, sourceHeight);
  const width = Math.max(1, Math.min(size, Math.round(sourceWidth * scale)));
  const height = Math.max(1, Math.min(size, Math.round(sourceHeight * scale)));
  return {
    x: Math.floor((size - width) / 2),
    y: Math.floor((size - height) / 2),
    width,
    height,
  };
}

export function resizeToModel(
  source: ImageData,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = MODEL_SIZE;
  canvas.height = MODEL_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const rect = letterboxRect(source.width, source.height);
  ctx.fillStyle = `rgb(${LETTERBOX_PAD}, ${LETTERBOX_PAD}, ${LETTERBOX_PAD})`;
  ctx.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
  ctx.drawImage(
    canvasFromImageData(source),
    0,
    0,
    source.width,
    source.height,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
  );
  return { canvas, ctx };
}

function canvasFromImageData(img: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d')!;
  ctx.putImageData(img, 0, 0);
  return c;
}

export function imageDataToTensor(img: ImageData): Float32Array {
  const { ctx } = resizeToModel(img);
  const resized = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE);
  const N = MODEL_SIZE * MODEL_SIZE;
  const tensor = new Float32Array(3 * N);

  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];

  for (let y = 0; y < MODEL_SIZE; y++) {
    for (let x = 0; x < MODEL_SIZE; x++) {
      const srcIdx = (y * MODEL_SIZE + x) * 4;
      const pxIdx = y * MODEL_SIZE + x;
      for (let c = 0; c < 3; c++) {
        const val = resized.data[srcIdx + c] / 255.0;
        tensor[c * N + pxIdx] = (val - mean[c]) / std[c];
      }
    }
  }
  return tensor;
}