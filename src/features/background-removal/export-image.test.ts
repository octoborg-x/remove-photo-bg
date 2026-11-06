import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EXPORT_FORMAT,
  EXPORT_FORMATS,
  exportFormatInfo,
  isExportFormat,
} from './export-image';

// The canvas-encoding functions need a real browser canvas and are covered by
// the browser tests; the format table and its guards are pure and tested here.

describe('EXPORT_FORMATS', () => {
  it('offers PNG first as the default', () => {
    expect(EXPORT_FORMATS[0].id).toBe('png');
    expect(DEFAULT_EXPORT_FORMAT).toBe('png');
    expect(EXPORT_FORMATS[0].supportsAlpha).toBe(true);
  });

  it('offers the common built-in formats', () => {
    expect(EXPORT_FORMATS.map((f) => f.id)).toEqual(['png', 'jpeg', 'webp']);
  });

  it('marks JPEG as opaque (no alpha) and WebP as alpha-capable', () => {
    expect(exportFormatInfo('jpeg').supportsAlpha).toBe(false);
    expect(exportFormatInfo('webp').supportsAlpha).toBe(true);
  });

  it('gives each format a distinct MIME type and extension', () => {
    const mimes = new Set(EXPORT_FORMATS.map((f) => f.mime));
    const extensions = new Set(EXPORT_FORMATS.map((f) => f.extension));
    expect(mimes.size).toBe(EXPORT_FORMATS.length);
    expect(extensions.size).toBe(EXPORT_FORMATS.length);
    expect(exportFormatInfo('png').mime).toBe('image/png');
    expect(exportFormatInfo('jpeg').extension).toBe('jpg');
  });
});

describe('isExportFormat', () => {
  it('accepts the known formats and rejects anything else', () => {
    expect(isExportFormat('png')).toBe(true);
    expect(isExportFormat('jpeg')).toBe(true);
    expect(isExportFormat('webp')).toBe(true);
    expect(isExportFormat('gif')).toBe(false);
    expect(isExportFormat(null)).toBe(false);
    expect(isExportFormat(42)).toBe(false);
  });
});

describe('exportFormatInfo', () => {
  it('falls back to PNG for an unknown id', () => {
    // @ts-expect-error deliberately passing an invalid id
    expect(exportFormatInfo('bmp').id).toBe('png');
  });
});
