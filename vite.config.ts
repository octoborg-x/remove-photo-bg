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
    // The public work-host proxy URLs reverse-proxy to these ports; Vite
    // otherwise rejects requests whose Host header is not an allowlisted name.
    allowedHosts: [
      'work-1-aybthnpldbthpfgf.prod-runtime.all-hands.dev',
      'work-2-aybthnpldbthpfgf.prod-runtime.all-hands.dev',
    ],
    headers: {
      // Cross-origin isolation enables SharedArrayBuffer, which onnxruntime-web
      // requires for its threaded WASM runtime (SIMD + multithreading).
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    // The production host sets these via public/_headers; mirror them locally so
    // `vite preview` matches the deployed behavior (and threaded WASM engages).
    host: true,
    port: 4173,
    headers: {
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