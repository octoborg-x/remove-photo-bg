import { describe, it, expect, afterEach } from 'vitest';
import {
  previewSize,
  applyMaskToImage,
  composeResult,
  PREVIEW_MAX_SIDE,
  COMPOSITE_STRIP_HEIGHT,
} from './composite';

describe('previewSize', () => {
  it('keeps a landscape image inside the max side', () => {
    expect(previewSize(1000, 500)).toEqual({ width: 450, height: 225 });
  });

  it('keeps a portrait image inside the max side', () => {
    expect(previewSize(500, 1000)).toEqual({ width: 225, height: 450 });
  });

  it('never upscales a small image', () => {
    expect(previewSize(100, 50)).toEqual({ width: 100, height: 50 });
  });

  it('is exactly the max side on the longest edge', () => {
    const s = previewSize(3000, 2000);
    expect(Math.max(s.width, s.height)).toBe(PREVIEW_MAX_SIDE);
  });

  it('never returns a zero dimension for an extreme aspect ratio', () => {
    const s = previewSize(4000, 3);
    expect(s.width).toBe(PREVIEW_MAX_SIDE);
    expect(s.height).toBeGreaterThanOrEqual(1);
  });

  it('honours a custom max side', () => {
    expect(previewSize(1000, 1000, 100)).toEqual({ width: 100, height: 100 });
  });
});

describe('applyMaskToImage', () => {
  // A 2x2 image with a distinct colour in every pixel.
  const image = new ImageData(
    new Uint8ClampedArray([
      10, 11, 12, 255,
      20, 21, 22, 255,
      30, 31, 32, 255,
      40, 41, 42, 255,
    ]),
    2,
    2,
  );

  it('writes the mask into the alpha channel only', () => {
    const out = applyMaskToImage(image, new Uint8ClampedArray([0, 64, 128, 255]));
    expect(Array.from(out.data)).toEqual([
      10, 11, 12, 0,
      20, 21, 22, 64,
      30, 31, 32, 128,
      40, 41, 42, 255,
    ]);
  });

  it('does not mutate the source image', () => {
    const before = Array.from(image.data);
    applyMaskToImage(image, new Uint8ClampedArray([0, 0, 0, 0]));
    expect(Array.from(image.data)).toEqual(before);
  });

  it('rejects a mask whose length does not match the image', () => {
    expect(() => applyMaskToImage(image, new Uint8ClampedArray([1, 2, 3]))).toThrow(
      /Mask size mismatch/,
    );
  });

  it('handles an image taller than one strip', () => {
    const h = COMPOSITE_STRIP_HEIGHT + 7;
    const w = 3;
    const pixels = new Uint8ClampedArray(w * h * 4).fill(200);
    const tall = new ImageData(pixels, w, h);
    const mask = new Uint8ClampedArray(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = i % 256;

    const out = applyMaskToImage(tall, mask);
    for (let i = 0; i < mask.length; i++) {
      expect(out.data[i * 4 + 3]).toBe(mask[i]);
    }
    // RGB preserved.
    expect(out.data[0]).toBe(200);
  });
});

// Node has no DOM. The compositor's fallback path only needs
// document.createElement('canvas') with a 2D context that stores the ImageData
// it is given, which is enough to assert the fallback produces a real cut-out.
const canvasStore = new WeakMap<object, ImageData>();
const realDocument = (globalThis as { document?: unknown }).document;

function installFakeCanvasDom(): void {
  (globalThis as { document?: unknown }).document = {
    createElement(tag: string) {
      if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
      const canvas = {
        width: 0,
        height: 0,
        getContext() {
          return {
            putImageData(img: ImageData) {
              canvasStore.set(canvas, img);
            },
            drawImage() {},
            getImageData() {
              return canvasStore.get(canvas) ?? new ImageData(canvas.width || 1, canvas.height || 1);
            },
          };
        },
      };
      return canvas;
    },
  };
}

describe('composeResult (main-thread fallback)', () => {
  afterEach(() => {
    (globalThis as { document?: unknown }).document = realDocument;
  });

  it('composites and returns a preview when the worker APIs are unavailable', async () => {
    installFakeCanvasDom();
    // Worker/OffscreenCanvas/createImageBitmap are all absent in Node, so the
    // fallback path runs.
    const img = new ImageData(new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]), 2, 1);
    const mask = new Uint8ClampedArray([0, 255]);

    const { canvas, preview } = await composeResult(img, mask);
    expect(canvas.width).toBe(2);
    expect(canvas.height).toBe(1);
    const out = canvas.getContext('2d')!.getImageData(0, 0, 2, 1);
    expect(Array.from(out.data)).toEqual([10, 20, 30, 0, 40, 50, 60, 255]);
    // A small image needs no downscale, so the preview is the cut-out itself.
    expect(preview).toBe(canvas);
  });

  it('downscales the preview to the max side for a large image', async () => {
    installFakeCanvasDom();
    const img = new ImageData(new Uint8ClampedArray(1000 * 500 * 4), 1000, 500);
    const mask = new Uint8ClampedArray(1000 * 500).fill(255);

    const { canvas, preview } = await composeResult(img, mask);
    expect(canvas.width).toBe(1000);
    expect(preview.width).toBe(PREVIEW_MAX_SIDE);
    expect(preview.height).toBe(225);
  });
});
