import { describe, it, expect } from 'vitest';
import { carouselStep } from './support-carousel';

describe('carouselStep', () => {
  it('moves forward with ArrowRight and ArrowDown, wrapping at the end', () => {
    expect(carouselStep('ArrowRight', 0, 6)).toBe(1);
    expect(carouselStep('ArrowDown', 1, 6)).toBe(2);
    expect(carouselStep('ArrowRight', 5, 6)).toBe(0);
  });

  it('moves back with ArrowLeft and ArrowUp, wrapping at the start', () => {
    expect(carouselStep('ArrowLeft', 1, 6)).toBe(0);
    expect(carouselStep('ArrowUp', 0, 6)).toBe(5);
  });

  it('jumps to the first and last card with Home and End', () => {
    expect(carouselStep('Home', 3, 6)).toBe(0);
    expect(carouselStep('End', 0, 6)).toBe(5);
  });

  it('ignores keys it does not handle', () => {
    expect(carouselStep('Enter', 1, 6)).toBeNull();
    expect(carouselStep('Tab', 1, 6)).toBeNull();
    expect(carouselStep('a', 1, 6)).toBeNull();
  });

  it('returns null when there are no slides', () => {
    expect(carouselStep('ArrowRight', 0, 0)).toBeNull();
  });
});
