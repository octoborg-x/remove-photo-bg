import { describe, it, expect } from 'vitest';
import { carouselStep, wrapIndex } from './support-carousel';

describe('carouselStep', () => {
  it('moves right and down to the next slide, wrapping at the end', () => {
    expect(carouselStep('ArrowRight', 0, 3)).toBe(1);
    expect(carouselStep('ArrowDown', 1, 3)).toBe(2);
    expect(carouselStep('ArrowRight', 2, 3)).toBe(0);
  });

  it('moves left and up to the previous slide, wrapping at the start', () => {
    expect(carouselStep('ArrowLeft', 1, 3)).toBe(0);
    expect(carouselStep('ArrowUp', 0, 3)).toBe(2);
  });

  it('jumps to the first and last slide with Home and End', () => {
    expect(carouselStep('Home', 2, 3)).toBe(0);
    expect(carouselStep('End', 0, 3)).toBe(2);
  });

  it('ignores keys it does not handle', () => {
    expect(carouselStep('Enter', 1, 3)).toBeNull();
    expect(carouselStep('Tab', 1, 3)).toBeNull();
    expect(carouselStep('a', 1, 3)).toBeNull();
  });

  it('returns null when there are no slides', () => {
    expect(carouselStep('ArrowRight', 0, 0)).toBeNull();
  });
});

describe('wrapIndex', () => {
  it('wraps forward and backward past the ends', () => {
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(-4, 3)).toBe(2);
  });

  it('leaves an in-range index unchanged', () => {
    expect(wrapIndex(0, 3)).toBe(0);
    expect(wrapIndex(2, 3)).toBe(2);
  });

  it('yields 0 when there are no slides', () => {
    expect(wrapIndex(5, 0)).toBe(0);
  });
});
