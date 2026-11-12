import { describe, it, expect } from 'vitest';
import { galleryStep } from './showcase-gallery';

describe('galleryStep', () => {
  it('moves down and right to the next tab, wrapping at the end', () => {
    expect(galleryStep('ArrowDown', 0, 3)).toBe(1);
    expect(galleryStep('ArrowRight', 1, 3)).toBe(2);
    expect(galleryStep('ArrowDown', 2, 3)).toBe(0);
  });

  it('moves up and left to the previous tab, wrapping at the start', () => {
    expect(galleryStep('ArrowUp', 1, 3)).toBe(0);
    expect(galleryStep('ArrowLeft', 0, 3)).toBe(2);
  });

  it('jumps to the first and last tab with Home and End', () => {
    expect(galleryStep('Home', 2, 3)).toBe(0);
    expect(galleryStep('End', 0, 3)).toBe(2);
  });

  it('ignores keys it does not handle', () => {
    expect(galleryStep('Enter', 1, 3)).toBeNull();
    expect(galleryStep('Tab', 1, 3)).toBeNull();
    expect(galleryStep('a', 1, 3)).toBeNull();
  });

  it('returns null when there are no tabs', () => {
    expect(galleryStep('ArrowDown', 0, 0)).toBeNull();
  });
});
