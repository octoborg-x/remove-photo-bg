// Pre-process an ImageData (already decoded RGB) into the model's expected
// NCHW Float32 tensor [1, 3, 1024, 1024].
//
// Confirmed from the upstream code/config:
// - resize to (1024, 1024) with bilinear interpolation (resample=2)
// - rescale by 1/255
// - normalize with ImageNet mean/std [0.485,0.456,0.406] / [0.229,0.224,0.225]
//
// This does the resize in JS (via an offscreen canvas) and then builds the NCHW
// tensor directly. For Phase 1 the tensor layout correctness matters more than
// matching torch's exact Resize rounding; pixel differences of a few units are
// acceptable for a smoke test, but the pipeline (inference + mask + alpha) must
// be validated end-to-end.

export const MODEL_SIZE = 1024;

export function resizeToModel(
  source: ImageData,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = MODEL_SIZE;
  canvas.height = MODEL_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    canvasFromImageData(source),
    0,
    0,
    source.width,
    source.height,
    0,
    0,
    MODEL_SIZE,
    MODEL_SIZE,
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