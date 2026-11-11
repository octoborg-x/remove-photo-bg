import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BACKGROUND,
  TRANSPARENT,
  describeChoice,
  formatForChoice,
  isBackgroundChoice,
  isTransparent,
  opaqueFallback,
  toRgba,
  type BackgroundChoice,
} from './background-color';

const color = (hex: string, alpha = 100): BackgroundChoice => ({ kind: 'color', hex, alpha });

describe('isTransparent', () => {
  it('treats the transparent option and a zero-alpha colour as transparent', () => {
    expect(isTransparent(TRANSPARENT)).toBe(true);
    expect(isTransparent(color('#123456', 0))).toBe(true);
  });

  it('treats a painted colour as opaque', () => {
    expect(isTransparent(color('#123456', 100))).toBe(false);
    expect(isTransparent(color('#123456', 40))).toBe(false);
  });
});

describe('toRgba', () => {
  it('expands a hex colour and the alpha percentage', () => {
    expect(toRgba(color('#2563eb', 100))).toBe('rgba(37, 99, 235, 1)');
    expect(toRgba(color('#ffffff', 25))).toBe('rgba(255, 255, 255, 0.25)');
  });

  it('clamps the alpha into 0–100', () => {
    expect(toRgba(color('#000000', 250))).toBe('rgba(0, 0, 0, 1)');
    expect(toRgba(color('#000000', -10))).toBe('rgba(0, 0, 0, 0)');
  });
});

describe('opaqueFallback', () => {
  it('uses the colour at full opacity for JPEG', () => {
    expect(opaqueFallback(color('#2563eb', 30))).toBe('#2563eb');
  });

  it('falls back to white when the choice is transparent', () => {
    expect(opaqueFallback(TRANSPARENT)).toBe('#ffffff');
    expect(opaqueFallback(color('#2563eb', 0))).toBe('#ffffff');
  });
});

describe('formatForChoice', () => {
  it('uses PNG for a transparent background', () => {
    expect(formatForChoice(TRANSPARENT)).toBe('png');
    expect(formatForChoice(color('#2563eb', 0))).toBe('png');
  });

  it('uses JPG for a solid colour and PNG for a see-through one', () => {
    expect(formatForChoice(color('#2563eb'))).toBe('jpeg');
    expect(formatForChoice(color('#ffffff'))).toBe('jpeg');
    expect(formatForChoice(color('#2563eb', 40))).toBe('png');
  });
});

describe('isBackgroundChoice', () => {
  it('accepts a well-formed choice', () => {
    expect(isBackgroundChoice(TRANSPARENT)).toBe(true);
    expect(isBackgroundChoice(color('#abcdef', 50))).toBe(true);
  });

  it('rejects malformed choices', () => {
    expect(isBackgroundChoice(null)).toBe(false);
    expect(isBackgroundChoice({ kind: 'color', hex: 'red', alpha: 100 })).toBe(false);
    expect(isBackgroundChoice({ kind: 'nope', hex: '#ffffff', alpha: 100 })).toBe(false);
    expect(isBackgroundChoice({ kind: 'color', hex: '#ffffff' })).toBe(false);
  });
});

describe('describeChoice', () => {
  it('summarises transparent and colour choices', () => {
    expect(describeChoice(TRANSPARENT)).toBe('transparent');
    expect(describeChoice(color('#2563eb', 40))).toBe('#2563eb at 40%');
  });
});

describe('DEFAULT_BACKGROUND', () => {
  it('starts transparent', () => {
    expect(DEFAULT_BACKGROUND).toEqual(TRANSPARENT);
  });
});
