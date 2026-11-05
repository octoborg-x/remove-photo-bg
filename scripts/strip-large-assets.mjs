// Removes model weights from the deployment bundle. The model is served from
// the Hugging Face asset origin (VITE_ASSET_BASE), and the service worker
// fetches and caches it for browser inference.
//
// The WASM runtime is NOT stripped: the CPU-only bundle (
// `ort-wasm-simd-threaded.wasm`, 13.3 MiB) fits under the per-file cap and must
// be served same-origin for the threaded runtime to work (see fetch-models.mjs).
//
// Run after `vite build`; wired into `npm run vercel:build`.
import { rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');

if (!existsSync(DIST)) {
  console.error('dist/ not found — run `vite build` first.');
  process.exit(1);
}

// Only the model directory is removed; the HTML/JS shell and the WASM runtime
// stay.
const TARGETS = ['models'];
for (const dir of TARGETS) {
  const path = resolve(DIST, dir);
  if (!existsSync(path)) continue;
  rmSync(path, { recursive: true, force: true });
  console.log(`Removed dist/${dir}/`);
}

// Report the largest remaining deployment asset. The WebGPU runtime
// binary is intentionally included in the Vercel bundle.
const MAX_OK = 30 * 1024 * 1024;
function walk(dir) {
  let biggest = { size: 0, path: '' };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = walk(full);
      if (inner.size > biggest.size) biggest = inner;
    } else {
      const size = statSync(full).size;
      if (size > biggest.size) biggest = { size, path: full };
    }
  }
  return biggest;
}
const largest = walk(DIST);
console.log(`Largest remaining file: ${largest.path.replace(ROOT + '/', '')} (${largest.size} bytes)`);
if (largest.size > MAX_OK) {
  console.error('WARNING: a remaining deployment asset exceeds the expected 30 MiB budget.');
  process.exit(1);
}