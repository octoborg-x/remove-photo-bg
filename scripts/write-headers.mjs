// Generates dist/_headers with a restrictive CSP for the built site.
//
// Why a generator: the app is same-origin except when the model is served from a
// remote asset origin (VITE_ASSET_BASE, e.g. Hugging Face). `connect-src` must
// allow that origin or the service worker's model fetch is blocked, and the
// origin is only known at build time. With no asset base the policy stays
// `connect-src 'self'` (MVP §8: "Use connect-src 'self' if every required
// runtime/model asset is self-hosted").
//
// Everything else is self-hosted: app shell, WASM runtime, fonts. onnxruntime-web
// spawns its pthread workers and blob URL from the same origin, hence
// `worker-src 'self' blob:`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');
const TEMPLATE = resolve(ROOT, 'public', '_headers');

// Origin(s) the browser may connect to. `VITE_ASSET_BASE` is a full URL prefix
// (e.g. https://huggingface.co/spaces/<owner>/<repo>/resolve/main/). Hugging Face
// redirects /resolve/ to a *.hf.co CDN, so allow both the origin and the CDN.
export function assetOrigins(assetBase) {
  if (!assetBase || !assetBase.trim() || assetBase.trim() === '/') return [];
  let origin;
  try {
    origin = new URL(assetBase).origin;
  } catch {
    console.warn(`write-headers: VITE_ASSET_BASE is not a URL, ignoring: ${assetBase}`);
    return [];
  }
  const origins = new Set([origin]);
  // Hugging Face redirects /resolve/ to a CDN on *.hf.co (and sometimes a
  // *.huggingface.co CDN host). Both must be reachable or the model fetch fails
  // the CSP after the redirect.
  if (origin === 'https://huggingface.co' || origin.endsWith('.huggingface.co')) {
    origins.add('https://*.huggingface.co');
    origins.add('https://*.hf.co');
  }
  return [...origins];
}

export function contentSecurityPolicy(assetBase) {
  const connect = ["'self'", ...assetOrigins(assetBase)].join(' ');
  return [
    "default-src 'self'",
    // `'wasm-unsafe-eval'` (not `'unsafe-eval'`) lets onnxruntime-web compile its
    // WebAssembly module. Chromium blocks `WebAssembly.instantiate` under a bare
    // `script-src 'self'`; this keyword permits only WASM compilation, not JS
    // eval, so it is the minimal allowance. Supported in Chrome 97+, Firefox
    // 102+, Safari 16.4+.
    "script-src 'self' 'wasm-unsafe-eval'",
    // Inline styles are set on elements by main.ts (e.g. hiding the download
    // link) and in index.html; no inline scripts are used, so script-src stays
    // otherwise strict.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' blob: data:",
    `connect-src ${connect}`,
    // onnxruntime-web spawns pthread workers and a blob: worker from the origin.
    "worker-src 'self' blob:",
    "font-src 'self' https://fonts.gstatic.com data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "manifest-src 'self'",
  ].join('; ');
}

// Insert the CSP header into the `/*` block of the template. The template already
// carries COOP/COEP (required for SharedArrayBuffer) and the cache rules.
export function withCsp(template, csp) {
  const marker = /(^\/\*\n)([\s\S]*?)(\n\n)/m;
  if (!marker.test(template)) throw new Error('public/_headers: /* block not found');
  return template.replace(marker, (_m, open, body, tail) => {
    if (/Content-Security-Policy:/.test(body)) return `${open}${body}${tail}`;
    return `${open}${body}\n  Content-Security-Policy: ${csp}${tail}`;
  });
}

// Only run when executed directly, so the exports stay importable for tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const assetBase = process.env.VITE_ASSET_BASE || '';
  const csp = contentSecurityPolicy(assetBase);
  const template = existsSync(TEMPLATE) ? readFileSync(TEMPLATE, 'utf8') : '/*\n\n';
  const out = withCsp(template, csp);
  if (!existsSync(DIST)) {
    console.error('write-headers: dist/ not found — run `vite build` first.');
    process.exit(1);
  }
  writeFileSync(resolve(DIST, '_headers'), out);
  console.log(`write-headers: dist/_headers written (connect-src from ${assetBase || 'same-origin'})`);
  console.log(`  CSP: ${csp}`);
}
