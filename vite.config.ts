import { defineConfig, loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { contentSecurityPolicy } from './scripts/write-headers.mjs';

// Stamped into the page at build/serve time so a stale document is obvious: the
// label, copy and behaviour of this harness change often, and a browser holding
// an old copy silently shows old text with no way to tell.
const BUILD_ID = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');

export default defineConfig(({ mode }) => {
  // Same CSP the deployed site gets (scripts/write-headers.mjs), so `vite dev`
  // and `vite preview` exercise the real policy rather than a laxer one.
  const env = loadEnv(mode, process.cwd(), '');
  const csp = contentSecurityPolicy(env.VITE_ASSET_BASE || '');
  return {
  base: './',
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [
    tailwindcss(),
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
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
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
      'Content-Security-Policy': csp,
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
      'Content-Security-Policy': csp,
    },
  },
  optimizeDeps: {
    // onnxruntime-web ships wasm bundles; include in optimization to avoid
    // browser-side import errors in the worker.
    include: [],
  },
  };
});