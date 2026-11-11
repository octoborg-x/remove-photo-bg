// Dedicated compositor worker (classic).
//
// Applies the background-removal alpha mask to the full-resolution photo pixels
// off the main thread and produces a small display preview, so a large photo
// neither blocks the UI nor forces a full-resolution GPU->CPU read-back on the
// page.
//
// Adapted from the rembg-webgpu compositor worker
// (https://github.com/Remove-Background-ai/rembg-webgpu,
// src/rembg-compositor.worker.ts): the mask is written into the alpha channel in
// bounded 512 px strips and a <=450 px preview is rendered alongside. See
// THIRD_PARTY_LEGAL_NOTICES.md for the attribution.
//
// The page only starts this worker when the browser exposes OffscreenCanvas; it
// falls back to the identical main-thread path (src/.../composite.ts) otherwise,
// and a worker that fails to start or stalls is caught by the caller's timeout.
//
// Protocol (see src/features/background-removal/composite.ts):
//   in:  { kind: 'compose', width, height, image: ImageData, alpha: Uint8Array,
//          previewMax: number }
//   out: { kind: 'composited', canvas: ImageBitmap, preview: ImageBitmap }
//        | { kind: 'error', message: string }

const STRIP_HEIGHT = 512;

function previewSize(width, height, maxSide) {
  const longest = Math.max(width, height);
  const scale = longest > 0 ? Math.min(1, maxSide / longest) : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

self.onmessage = (evt) => {
  const msg = evt.data;
  if (!msg || msg.kind !== 'compose') return;
  try {
    const { width, height, image, alpha, previewMax } = msg;
    if (!width || !height || !image || !alpha) throw new Error('Invalid compose arguments');
    if (alpha.length !== width * height) throw new Error('Alpha length mismatch');
    if (typeof OffscreenCanvas === 'undefined') throw new Error('OffscreenCanvas is not supported');

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D context unavailable');
    ctx.putImageData(image, 0, 0);

    // Write the mask into the alpha channel in bounded strips, so peak memory is
    // one strip rather than a second full-resolution RGBA buffer.
    for (let y0 = 0; y0 < height; y0 += STRIP_HEIGHT) {
      const rows = Math.min(STRIP_HEIGHT, height - y0);
      const strip = ctx.getImageData(0, y0, width, rows);
      const rgba = strip.data;
      const alphaStart = y0 * width;
      for (let row = 0; row < rows; row++) {
        const alphaRow = alphaStart + row * width;
        const pixelRow = row * width * 4;
        for (let x = 0; x < width; x++) {
          rgba[pixelRow + x * 4 + 3] = alpha[alphaRow + x];
        }
      }
      ctx.putImageData(strip, 0, y0);
    }

    // Render the preview before transferring the full canvas: transferToImageBitmap()
    // resets the source canvas, so it must be the last thing drawn from it.
    const size = previewSize(width, height, previewMax);
    const previewCanvas = new OffscreenCanvas(size.width, size.height);
    const previewCtx = previewCanvas.getContext('2d');
    if (!previewCtx) throw new Error('2D context unavailable (preview)');
    previewCtx.drawImage(canvas, 0, 0, size.width, size.height);
    const preview = previewCanvas.transferToImageBitmap();
    const full = canvas.transferToImageBitmap();

    self.postMessage({ kind: 'composited', canvas: full, preview }, [full, preview]);
  } catch (err) {
    self.postMessage({ kind: 'error', message: err && err.message ? err.message : String(err) });
  }
};
