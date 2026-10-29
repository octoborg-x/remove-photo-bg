// Removes the model and WASM binaries from the built site so it can be deployed
// to a host with a small per-file limit (Cloudflare Pages: 25 MiB). The binaries
// are served from the remote asset origin instead (see VITE_ASSET_BASE), and the
// service worker proxies them through as same-origin responses.
//
// Run after `vite build`; wired into `npm run build:site`.
import { rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');

if (!existsSync(DIST)) {
  console.error('dist/ not found — run `vite build` first.');
  process.exit(1);
}

// Only the large binary directories are removed; the HTML/JS shell stays.
const TARGETS = ['models', 'wasm'];
for (const dir of TARGETS) {
  const path = resolve(DIST, dir);
  if (!existsSync(path)) continue;
  rmSync(path, { recursive: true, force: true });
  console.log(`Removed dist/${dir}/`);
}

// Report anything still large enough to trip a small host's per-file limit.
const MAX_OK = 25 * 1024 * 1024;
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
  console.error('WARNING: a file still exceeds 25 MiB; Cloudflare Pages will reject it.');
  process.exit(1);
}
