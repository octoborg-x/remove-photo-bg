// Export helpers: encode the composited cut-out in the format the user picks.

import {
  DEFAULT_BACKGROUND,
  isTransparent,
  opaqueFallback,
  toRgba,
  type BackgroundChoice,
} from './background-color';

export type ExportFormat = 'png' | 'jpeg' | 'webp';

export interface ExportFormatInfo {
  id: ExportFormat;
  /** Short label for the radio control. */
  label: string;
  /** Longer description of what the format does to the transparency. */
  description: string;
  mime: string;
  extension: string;
  /** True when the format keeps the cut-out's transparency. */
  supportsAlpha: boolean;
}

// PNG is first (and the default): it is the only format that guarantees a
// transparent cut-out on every browser and every image tool.
export const EXPORT_FORMATS: readonly ExportFormatInfo[] = [
  {
    id: 'png',
    label: 'PNG',
    description: 'transparent background',
    mime: 'image/png',
    extension: 'png',
    supportsAlpha: true,
  },
  {
    id: 'jpeg',
    label: 'JPG',
    description: 'no transparency',
    mime: 'image/jpeg',
    extension: 'jpg',
    supportsAlpha: false,
  },
  {
    id: 'webp',
    label: 'WebP',
    description: 'smaller file, keeps transparency',
    mime: 'image/webp',
    extension: 'webp',
    supportsAlpha: true,
  },
];

export const DEFAULT_EXPORT_FORMAT: ExportFormat = 'png';

export function isExportFormat(value: unknown): value is ExportFormat {
  return value === 'png' || value === 'jpeg' || value === 'webp';
}

export function exportFormatInfo(format: ExportFormat): ExportFormatInfo {
  return EXPORT_FORMATS.find((f) => f.id === format) ?? EXPORT_FORMATS[0];
}

/**
 * True when the browser's canvas can actually encode this format. WebP is not
 * universal, and a canvas silently falls back to PNG for a format it cannot
 * encode — so probing avoids handing the user a PNG named `.webp`.
 */
export function canEncode(format: ExportFormat): boolean {
  if (format === 'png' || format === 'jpeg') return true;
  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  return probe.toDataURL('image/webp').startsWith('data:image/webp');
}

/**
 * Data URL for the composited result in the requested format, flattened onto the
 * chosen background. The cut-out keeps its alpha; the background is painted
 * underneath. A transparent background passes through untouched for PNG/WebP; a
 * colour (or a partially transparent colour) is composited, and JPEG — which has
 * no alpha channel — is flattened onto the opaque version of the colour.
 */
export function canvasToDataUrl(
  canvas: HTMLCanvasElement,
  format: ExportFormat,
  background: BackgroundChoice = DEFAULT_BACKGROUND,
  quality = 0.92,
): string {
  const needsComposite = format === 'jpeg' || !isTransparent(background);
  if (!needsComposite) {
    if (format === 'png') return canvas.toDataURL('image/png');
    if (canEncode('webp')) return canvas.toDataURL('image/webp', quality);
    return canvas.toDataURL('image/png');
  }

  const bg = document.createElement('canvas');
  bg.width = canvas.width;
  bg.height = canvas.height;
  const ctx = bg.getContext('2d')!;
  // JPEG cannot carry alpha: flatten onto the fully opaque colour.
  ctx.fillStyle = format === 'jpeg' ? opaqueFallback(background) : toRgba(background);
  ctx.fillRect(0, 0, bg.width, bg.height);
  ctx.drawImage(canvas, 0, 0);

  if (format === 'jpeg') return bg.toDataURL('image/jpeg', quality);
  if (format === 'webp') return canEncode('webp') ? bg.toDataURL('image/webp', quality) : bg.toDataURL('image/png');
  return bg.toDataURL('image/png');
}
