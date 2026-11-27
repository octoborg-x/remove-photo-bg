import { describe, it, expect } from 'vitest';
import {
  alphaFromByte,
  alphaToByteHex,
  formatHexAlpha,
  hexToHsv,
  hexToRgb,
  hsvToHex,
  normalizeHex,
  parseHexAlpha,
  rgbToHex,
  rgbToHsv,
} from './color-picker';

describe('colour conversion helpers', () => {
  it('normalises shorthand and long hex input', () => {
    expect(normalizeHex('#abc')).toBe('#aabbcc');
    expect(normalizeHex('ABC')).toBe('#aabbcc');
    expect(normalizeHex('#2563EB')).toBe('#2563eb');
    expect(normalizeHex('not-a-colour')).toBeNull();
  });

  it('converts hex to RGB and back', () => {
    expect(hexToRgb('#2563eb')).toEqual({ r: 37, g: 99, b: 235 });
    expect(rgbToHex({ r: 37, g: 99, b: 235 })).toBe('#2563eb');
    // Out-of-range channels are clamped rather than wrapping.
    expect(rgbToHex({ r: -20, g: 300, b: 12.6 })).toBe('#00ff0d');
  });

  it('round-trips hex through HSV without drift', () => {
    for (const hex of ['#ffffff', '#000000', '#ff0000', '#00ff00', '#0000ff', '#2563eb', '#7c3aed']) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });

  it('maps RGB to the expected HSV values', () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, v: 1 });
    expect(rgbToHsv({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, v: 1 });
    const green = rgbToHsv({ r: 0, g: 255, b: 0 });
    expect(green.h).toBe(120);
    expect(green.s).toBe(1);
  });

  it('parses six- and eight-digit hex with alpha', () => {
    expect(parseHexAlpha('#2563eb')).toEqual({ hex: '#2563eb', alpha: 100 });
    expect(parseHexAlpha('2563eb80')).toEqual({ hex: '#2563eb', alpha: alphaFromByte(0x80) });
    expect(parseHexAlpha('#xyz')).toBeNull();
  });

  it('formats an alpha byte back into #rrggbbaa', () => {
    expect(alphaToByteHex(100)).toBe('ff');
    expect(alphaToByteHex(0)).toBe('00');
    expect(formatHexAlpha('#2563eb', 50)).toBe('#2563eb80');
    expect(alphaFromByte(0x80)).toBe(50);
  });
});
