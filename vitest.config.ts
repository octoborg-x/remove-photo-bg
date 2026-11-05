import { defineConfig } from 'vitest/config';

// Unit tests cover the pure logic (validation, mask maths, progress formatting,
// manifest param resolution). Node 24 provides File/Blob/ImageData natively, so
// no jsdom is needed; DOM-only modules (export-image) are exercised in the
// browser tests instead.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    setupFiles: ['src/test-setup.ts'],
  },
});
