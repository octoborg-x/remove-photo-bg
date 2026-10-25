import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: {
    format: 'es',
  },
  server: {
    // Expose vite dev server so the page (and chrome headless) can reach it.
    host: true,
    port: 5173,
    headers: {
      // Cross-origin isolation enables SharedArrayBuffer, which onnxruntime-web
      // requires for its threaded WASM runtime (SIMD + multithreading).
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    // onnxruntime-web ships wasm bundles; include in optimization to avoid
    // browser-side import errors in the worker.
    include: [],
  },
});