// Export helpers: encode the composited cut-out in the format the user picks.

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
    description: 'white background',
    mime: 'image/jpeg',
    extension: 'jpg',
    supportsAlpha: false,
  },
  {
    id: 'webp',
    label: 'WebP',
    description: 'smaller file, transparent background',
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
 * Data URL for the composited result in the requested format. JPEG has no alpha
 * channel, so the transparent cut-out is composited onto white first; PNG and
 * WebP keep the real transparency.
 */
export function canvasToDataUrl(
  canvas: HTMLCanvasElement,
  format: ExportFormat,
  quality = 0.92,
): string {
  if (format === 'png') return canvas.toDataURL('image/png');
  if (format === 'webp') {
    if (!canEncode('webp')) return canvas.toDataURL('image/png');
    return canvas.toDataURL('image/webp', quality);
  }
  const white = document.createElement('canvas');
  white.width = canvas.width;
  white.height = canvas.height;
  const ctx = white.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, white.width, white.height);
  ctx.drawImage(canvas, 0, 0);
  return white.toDataURL('image/jpeg', quality);
}