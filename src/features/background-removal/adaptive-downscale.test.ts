import { describe, it, expect } from 'vitest';
import {
  recommendSourceScale,
  DESKTOP_MAX_SOURCE_SIDE,
  MOBILE_MAX_SOURCE_SIDE,
  MOBILE_LOW_MEMORY_MAX_SOURCE_SIDE,
  MIN_SOURCE_SIDE,
} from './adaptive-downscale';
import { DEFAULT_UPLOAD_LIMITS, validateDimensions } from './image-validation';

const PHONE_PHOTO = { width: 5712, height: 4284 }; // 24.5 MP, 4:3

describe('recommendSourceScale — device classes', () => {
  it('caps a desktop photo at the documented 4096 upload limit', () => {
    const d = recommendSourceScale({ ...PHONE_PHOTO, deviceClass: 'desktop', deviceMemoryGb: 16 });
    expect(d.downscaled).toBe(true);
    expect(d.width).toBe(DESKTOP_MAX_SOURCE_SIDE);
    expect(d.height).toBe(3072);
    expect(d.capSource).toBe('desktop');
  });

  it('reduces a phone photo to 3072 on its long side', () => {
    const d = recommendSourceScale({ ...PHONE_PHOTO, deviceClass: 'mobile', deviceMemoryGb: 8 });
    expect(d.downscaled).toBe(true);
    expect(d.width).toBe(3072);
    expect(d.height).toBe(2304);
    expect(d.capSource).toBe('mobile');
    expect(d.reason).toBe('Reduced from 5712×4284 to 3072×2304 so this device can process it reliably.');
  });

  it('reduces further on a low-memory phone (<= 2 GB)', () => {
    const d = recommendSourceScale({ ...PHONE_PHOTO, deviceClass: 'mobile', deviceMemoryGb: 2 });
    expect(d.width).toBe(MOBILE_LOW_MEMORY_MAX_SOURCE_SIDE);
    expect(d.height).toBe(1536);
    expect(d.capSource).toBe('mobile-low-memory');
  });

  it('treats 4 GB as a normal mobile device', () => {
    const d = recommendSourceScale({ ...PHONE_PHOTO, deviceClass: 'mobile', deviceMemoryGb: 4 });
    expect(d.width).toBe(MOBILE_MAX_SOURCE_SIDE);
    expect(d.capSource).toBe('mobile');
  });

  it('falls back to core count when deviceMemory is unavailable', () => {
    const low = recommendSourceScale({
      ...PHONE_PHOTO,
      deviceClass: 'mobile',
      deviceMemoryGb: null,
      hardwareConcurrency: 2,
    });
    expect(low.capSource).toBe('mobile-low-memory');
    const normal = recommendSourceScale({
      ...PHONE_PHOTO,
      deviceClass: 'mobile',
      deviceMemoryGb: null,
      hardwareConcurrency: 8,
    });
    expect(normal.capSource).toBe('mobile');
  });

  it('does not reduce on an unknown device class (no signal)', () => {
    const d = recommendSourceScale({ ...PHONE_PHOTO });
    expect(d.capSource).toBe('desktop');
    expect(d.width).toBe(4096);
  });
});

describe('recommendSourceScale — no upscaling', () => {
  it('returns a small image byte-for-byte on every device class', () => {
    for (const deviceClass of ['mobile', 'desktop', 'unknown'] as const) {
      const d = recommendSourceScale({ width: 800, height: 600, deviceClass, deviceMemoryGb: 1 });
      expect(d.downscaled).toBe(false);
      expect(d.scale).toBe(1);
      expect([d.width, d.height]).toEqual([800, 600]);
    }
  });

  it('leaves an image exactly at the cap untouched', () => {
    const d = recommendSourceScale({ width: 3072, height: 2048, deviceClass: 'mobile' });
    expect(d.downscaled).toBe(false);
    expect([d.width, d.height]).toEqual([3072, 2048]);
  });
});

describe('recommendSourceScale — ?maxSourceSide override', () => {
  it('overrides the device cap for scripted runs', () => {
    const d = recommendSourceScale({ width: 4000, height: 3000, maxSourceSide: 2048 });
    expect(d.capSource).toBe('override');
    expect([d.width, d.height]).toEqual([2048, 1536]);
  });

  it('clamps an override above the upload cap down to 4096', () => {
    const d = recommendSourceScale({ width: 8000, height: 6000, maxSourceSide: 9000 });
    expect(d.maxSide).toBe(DESKTOP_MAX_SOURCE_SIDE);
    expect([d.width, d.height]).toEqual([4096, 3072]);
  });

  it('clamps an override below the minimum up to 512', () => {
    const d = recommendSourceScale({ width: 4000, height: 3000, maxSourceSide: 10 });
    expect(d.maxSide).toBe(MIN_SOURCE_SIDE);
    expect([d.width, d.height]).toEqual([512, 384]);
  });

  it('ignores a non-finite or non-positive override', () => {
    for (const maxSourceSide of [0, -1, NaN, Infinity]) {
      const d = recommendSourceScale({ width: 800, height: 600, maxSourceSide });
      expect(d.capSource).toBe('desktop');
      expect(d.downscaled).toBe(false);
    }
  });
});

describe('recommendSourceScale — outer bound interaction', () => {
  it('never chooses a cap above the documented upload limit', () => {
    for (const deviceClass of ['mobile', 'desktop', 'unknown'] as const) {
      for (const deviceMemoryGb of [1, 2, 4, 8, 16]) {
        const d = recommendSourceScale({ ...PHONE_PHOTO, deviceClass, deviceMemoryGb });
        expect(d.maxSide).toBeLessThanOrEqual(DEFAULT_UPLOAD_LIMITS.maxLongestSide);
      }
    }
  });

  it('turns a previously-rejected phone photo into a valid one', () => {
    const input = { width: 8064, height: 6048 }; // 48 MP panorama-ish
    expect(validateDimensions(input.width, input.height).ok).toBe(false);
    const d = recommendSourceScale({ ...input, deviceClass: 'mobile', deviceMemoryGb: 4 });
    expect(validateDimensions(d.width, d.height).ok).toBe(true);
  });

  it('preserves the aspect ratio within rounding', () => {
    const d = recommendSourceScale({ width: 6000, height: 2000, deviceClass: 'mobile' });
    expect(d.width / d.height).toBeCloseTo(3, 1);
  });
});

describe('recommendSourceScale — invalid dimensions', () => {
  it('passes unusable dimensions through for validation to reject', () => {
    for (const [width, height] of [
      [0, 100],
      [100, 0],
      [-1, 100],
      [NaN, 100],
    ]) {
      const d = recommendSourceScale({ width, height, deviceClass: 'mobile' });
      expect(d.downscaled).toBe(false);
      expect(d.scale).toBe(1);
    }
  });
});
