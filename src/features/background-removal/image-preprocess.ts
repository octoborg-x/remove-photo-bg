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
// segments it normally.
//
// The letterbox border is filled by REPLICATING the content's edge pixels
// outward (see `replicateEdges`). A flat fill is wrong: with a black border the
// model treats the frame as one huge dark subject and floods the mask. Measured
// on the 1005x260 logo, black padding came back 56% foreground with a fully
// opaque backdrop (corner alpha 249/255) versus the subject's true ~22%;
// replicating the edge gave 24% and corner alpha 0. On the 59-image eval set,
// edge replication agrees with the trusted reference mask at mean IoU 0.92
// (black: 0.89), and rescues the extreme-aspect cases where black floods
// (e.g. a 2:1 product photo: black 32% fg -> edge 11%).
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

/** Replicates an image's border pixels outward into a `size`-square canvas,
 *  centred at `rect`. The area outside `rect` is filled by clamping each pixel
 *  to the content's edge, so the model sees a seamless continuation of the
 *  subject instead of a hard flat border it would mistake for background or a
 *  giant subject. Pure and canvas-free so it can be unit-tested in Node; the
 *  browser path draws the real (resized) pixels and then applies the same
 *  clamping. */
export function replicateEdges(
  pixels: Uint8ClampedArray,
  rect: LetterboxRect,
  size: number = MODEL_SIZE,
  channels = 4,
): Uint8ClampedArray {
  const { x, y, width, height } = rect;
  const out = new Uint8ClampedArray(size * size * channels);
  for (let dy = 0; dy < size; dy++) {
    const sy = Math.min(height - 1, Math.max(0, dy - y));
    for (let dx = 0; dx < size; dx++) {
      const sx = Math.min(width - 1, Math.max(0, dx - x));
      const s = (sy * width + sx) * channels;
      const d = (dy * size + dx) * channels;
      for (let c = 0; c < channels; c++) out[d + c] = pixels[s + c];
    }
  }
  return out;
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
  // Draw the fitted content, then replicate its edge pixels outward into the
  // letterbox border (see `replicateEdges` for why a flat fill fails).
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
  const content = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
  const padded = new ImageData(MODEL_SIZE, MODEL_SIZE);
  padded.data.set(replicateEdges(content.data, rect));
  ctx.putImageData(padded, 0, 0);
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