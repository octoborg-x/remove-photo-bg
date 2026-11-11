// Compositing helpers for turning an alpha mask + source pixels into a cut-out
// canvas and a small preview.
//
// The preview sizing and the strip-wise (512 px) compositing loop are adapted
// from the rembg-webgpu library (https://github.com/Remove-Background-ai/rembg-webgpu,
// src/rembg-compositor.worker.ts), which composites the mask onto the source
// image in bounded horizontal strips and always renders a ≤450 px preview for
// fast UI feedback. The strip bound caps peak memory on very large images.
//
// Unlike the reference — which owns the full pipeline, a dedicated compositor
// worker and a main-thread fallback — this app composites on the main thread in
// `main.ts` (which the result, compare and export views all share) and ships
// only the CPU/WASM runtime, so only the two genuinely reusable pieces are
// ported here: `applyMaskToImage` (the strip-wise loop) and `previewSize` (the
// ≤450 px rule).

export interface PreviewSize {
  width: number;
  height: number;
}

export interface CompositedResult {
  /** Full-resolution cut-out (original pixels, alpha from the mask). */
  canvas: HTMLCanvasElement;
  /** On-screen preview, at most `PREVIEW_MAX_SIDE` on its longest side. */
  preview: HTMLCanvasElement;
}

/** How long the compositor worker gets before the main thread takes over. */
export const COMPOSITE_WORKER_TIMEOUT_MS = 20000;

/** Height of one compositing strip. Bounds the peak working set on large images. */
export const COMPOSITE_STRIP_HEIGHT = 512;

/** Longest side of a generated preview. */
export const PREVIEW_MAX_SIDE = 450;

/**
 * Fits `width`×`height` inside a `maxSide`-square preview, preserving the aspect
 * ratio and never upscaling. Always returns at least 1×1 so a preview can be
 * drawn for any real image.
 */
export function previewSize(width: number, height: number, maxSide = PREVIEW_MAX_SIDE): PreviewSize {
  const longest = Math.max(width, height);
  const scale = longest > 0 ? Math.min(1, maxSide / longest) : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Writes `mask` into the alpha channel of `image`, returning the cut-out pixels.
 * The RGB channels are left untouched, so the mask is the only thing that
 * changes. The write is done in horizontal strips of `COMPOSITE_STRIP_HEIGHT`
 * rows, which keeps the per-row alpha offset arithmetic local and is the shape
 * the reference library uses to bound memory.
 *
 * `mask` is an 8-bit alpha channel at the image's resolution (see
 * `mask-postprocess.ts`). Throws when the mask is not exactly width×height, so a
 * mis-scaled mask fails loudly instead of producing a torn image.
 */
export function applyMaskToImage(
  image: ImageData,
  mask: Uint8ClampedArray,
): ImageData {
  const { width, height } = image;
  if (mask.length !== width * height) {
    throw new Error(
      `Mask size mismatch: expected ${width * height} alpha values for ${width}x${height}, got ${mask.length}`,
    );
  }
  const out = new ImageData(width, height);
  out.data.set(image.data);
  for (let y0 = 0; y0 < height; y0 += COMPOSITE_STRIP_HEIGHT) {
    const rows = Math.min(COMPOSITE_STRIP_HEIGHT, height - y0);
    for (let row = 0; row < rows; row++) {
      const alphaRowStart = (y0 + row) * width;
      const rgbaRowStart = alphaRowStart * 4;
      for (let x = 0; x < width; x++) {
        out.data[rgbaRowStart + x * 4 + 3] = mask[alphaRowStart + x];
      }
    }
  }
  return out;
}

function canvasFromImageData(image: ImageData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  return canvas;
}

function downscale(source: HTMLCanvasElement, maxSide: number): HTMLCanvasElement {
  const { width, height } = previewSize(source.width, source.height, maxSide);
  if (width === source.width && height === source.height) return source;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

/** Runs one compose in the dedicated worker, rejecting on an error reply, a
 *  worker `error` event, or the timeout. */
function composeInWorker(
  image: ImageData,
  alpha: Uint8ClampedArray,
  maxSide: number,
  timeoutMs: number,
): Promise<CompositedResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    let worker: Worker;
    try {
      worker = new Worker('/compositor-worker.js', { type: 'classic' });
    } catch (err) {
      rejectPromise(err);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => finish(new Error('The compositor worker did not respond in time')), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    const finish = (err: Error | null, result?: CompositedResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) rejectPromise(err);
      else resolvePromise(result as CompositedResult);
    };
    worker.onerror = (e) => finish(new Error(e.message || 'The compositor worker failed'));
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { kind?: string; canvas?: ImageBitmap; preview?: ImageBitmap; message?: string };
      if (msg?.kind === 'composited' && msg.canvas && msg.preview) {
        finish(null, {
          canvas: bitmapToCanvas(msg.canvas),
          preview: bitmapToCanvas(msg.preview),
        });
      } else if (msg?.kind === 'error') {
        finish(new Error(msg.message || 'Compositing failed'));
      }
    };
    worker.postMessage({ kind: 'compose', width: image.width, height: image.height, image, alpha, previewMax: maxSide });
  });
}

function bitmapToCanvas(bitmap: ImageBitmap): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

/**
 * Composites the mask onto the image and returns the full-resolution cut-out
 * plus a preview, running the work in the dedicated OffscreenCanvas worker when
 * the browser supports it and on the main thread otherwise. Any worker failure
 * (unsupported, failed to start, errored, or timed out) silently falls back to
 * the main thread, so the result is identical either way.
 */
export async function composeResult(
  image: ImageData,
  mask: Uint8ClampedArray,
  maxSide = PREVIEW_MAX_SIDE,
): Promise<CompositedResult> {
  const canWorker =
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap !== 'undefined';
  if (canWorker) {
    try {
      return await composeInWorker(image, mask, maxSide, COMPOSITE_WORKER_TIMEOUT_MS);
    } catch {
      // Fall through to the main-thread path.
    }
  }
  const canvas = canvasFromImageData(applyMaskToImage(image, mask));
  return { canvas, preview: downscale(canvas, maxSide) };
}
