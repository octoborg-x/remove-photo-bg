import { defineConfig } from 'vite';

// Stamped into the page at build/serve time so a stale document is obvious: the
// label, copy and behaviour of this harness change often, and a browser holding
// an old copy silently shows old text with no way to tell.
const BUILD_ID = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');

export default defineConfig({
  base: './',
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [
    {
      name: 'build-stamp',
      transformIndexHtml(html) {
        return html.replaceAll('__BUILD_ID__', BUILD_ID);
      },
    },
  ],
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
      '.prod-runtime.all-hands.dev',
    ],
    headers: {
      // Cross-origin isolation enables SharedArrayBuffer, which onnxruntime-web
      // requires for its threaded WASM runtime (SIMD + multithreading).
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      // `no-cache` still lets a browser reuse a 304'd body, so an edited harness
      // can show old markup after a reload. `no-store` makes every load fetch the
      // current document. Fine in dev: the heavy artifacts are cached by the
      // service worker, not by the HTTP cache.
      'Cache-Control': 'no-store',
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