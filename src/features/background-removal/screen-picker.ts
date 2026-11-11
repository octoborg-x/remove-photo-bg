// One system colour picker for the Studio background: the browser's native
// `<input type="color">` plus a screen eyedropper. The eyedropper prefers the
// EyeDropper API (Chrome/Edge) and falls back to sampling a click on the live
// tab via html2canvas-free screenshotting is not available, so the fallback uses
// the screen capture path only when the API is absent. Kept DOM-light and pure
// where possible so the colour maths is unit-testable.

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function clampChannel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const h = (n: number) => clampChannel(n).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/**
 * Average the colour of a small square sample centred on (x, y), clamped to the
 * image bounds. Averaging a few pixels hides the single-pixel sensor noise that
 * makes a one-pixel eyedropper feel "wrong".
 */
export function sampleAverage(data: Uint8ClampedArray, width: number, height: number, x: number, y: number, radius = 2): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const x0 = Math.max(0, x - radius);
  const x1 = Math.min(width - 1, x + radius);
  const y0 = Math.max(0, y - radius);
  const y1 = Math.min(height - 1, y + radius);
  for (let sy = y0; sy <= y1; sy++) {
    for (let sx = x0; sx <= x1; sx++) {
      const i = (sy * width + sx) * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count++;
    }
  }
  if (count === 0) return { r: 255, g: 255, b: 255 };
  return { r: r / count, g: g / count, b: b / count };
}

interface EyeDropperResult {
  sRGBHex: string;
}

interface EyeDropperInstance {
  open(): Promise<EyeDropperResult>;
}

type EyeDropperCtor = new () => EyeDropperInstance;

/** True when the browser can pick a colour from anywhere on screen. */
export function supportsScreenPicker(): boolean {
  return typeof (globalThis as { EyeDropper?: unknown }).EyeDropper === 'function';
}

/**
 * Open the system eyedropper and resolve to a `#rrggbb` string, or null if the
 * user cancelled or the API is unavailable. Rejects are normalised to null so
 * the caller can treat "no pick" and "cancelled" the same way.
 */
export async function pickColorFromScreen(): Promise<string | null> {
  const Ctor = (globalThis as { EyeDropper?: EyeDropperCtor }).EyeDropper;
  if (typeof Ctor !== 'function') return null;
  try {
    const result = await new Ctor().open();
    return normalizeHex(result.sRGBHex);
  } catch {
    return null;
  }
}

export function normalizeHex(hex: string): string | null {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHex(rgb) : null;
}
