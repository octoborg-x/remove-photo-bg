import { describe, it, expect } from 'vitest';
import {
  ACCEPTED_MIME_TYPES,
  DEFAULT_UPLOAD_LIMITS,
  formatLimitBytes,
  validateFileTypeAndSize,
  validateDimensions,
} from './image-validation';

// validateFileTypeAndSize only reads .type and .size, so a stub avoids
// allocating a real 20 MB File just to test the cap boundary.
function fakeFile(type: string, size: number): File {
  return { type, size, name: 'photo' } as unknown as File;
}

describe('validateFileTypeAndSize', () => {
  it('accepts each declared image type at a normal size', () => {
    for (const type of ACCEPTED_MIME_TYPES) {
      expect(validateFileTypeAndSize(fakeFile(type, 1024))).toEqual({ ok: true });
    }
  });

  it('is case-insensitive about the MIME type', () => {
    expect(validateFileTypeAndSize(fakeFile('IMAGE/PNG', 1024))).toEqual({ ok: true });
  });

  it('rejects an unsupported MIME type, naming it', () => {
    const r = validateFileTypeAndSize(fakeFile('image/gif', 1024));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('image/gif');
  });

  it('rejects a missing/empty MIME type', () => {
    const r = validateFileTypeAndSize(fakeFile('', 1024));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('unknown');
  });

  it('rejects an empty file', () => {
    const r = validateFileTypeAndSize(fakeFile('image/png', 0));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/empty/i);
  });

  it('accepts a file exactly at the size cap', () => {
    const { maxBytes } = DEFAULT_UPLOAD_LIMITS;
    expect(validateFileTypeAndSize(fakeFile('image/jpeg', maxBytes))).toEqual({ ok: true });
  });

  it('rejects a file one byte over the size cap', () => {
    const { maxBytes } = DEFAULT_UPLOAD_LIMITS;
    const r = validateFileTypeAndSize(fakeFile('image/jpeg', maxBytes + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('over');
  });

  it('honours custom limits', () => {
    const limits = { maxBytes: 100, maxLongestSide: 10 };
    expect(validateFileTypeAndSize(fakeFile('image/png', 100), limits)).toEqual({ ok: true });
    expect(validateFileTypeAndSize(fakeFile('image/png', 101), limits).ok).toBe(false);
  });
});

describe('validateDimensions', () => {
  it('accepts square and portrait/landscape images within the cap', () => {
    expect(validateDimensions(512, 512)).toEqual({ ok: true });
    expect(validateDimensions(100, 4096)).toEqual({ ok: true });
    expect(validateDimensions(4096, 100)).toEqual({ ok: true });
  });

  it('rejects a longest side one pixel over the cap', () => {
    const { maxLongestSide } = DEFAULT_UPLOAD_LIMITS;
    const r = validateDimensions(maxLongestSide + 1, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('longest side');
  });

  it('rejects non-positive or non-finite dimensions', () => {
    for (const [w, h] of [
      [0, 100],
      [100, 0],
      [-1, 100],
      [NaN, 100],
      [100, Infinity],
    ]) {
      expect(validateDimensions(w, h).ok).toBe(false);
    }
  });
});

describe('formatLimitBytes', () => {
  it('renders whole megabytes', () => {
    expect(formatLimitBytes(20 * 1024 * 1024)).toBe('20 MB');
    expect(formatLimitBytes(1 * 1024 * 1024)).toBe('1 MB');
  });
});
