// Consolidates two static eval galleries into one three-layer gallery:
//
//   layer 0 (bottom) <id>-before.webp    first gallery's cut-out  (older run)
//   layer 1 (middle) <id>-after.webp     second gallery's cut-out (newer run)
//   layer 2 (top)    <id>-original.webp  the source photo
//
// The page (public/eval-gallery/) stacks all three: a horizontal slider wipes
// before -> after, a vertical one reveals the original from the top. WebP files
// are copied, never re-encoded, so the merged gallery is byte-identical to the
// two it replaces.
//
// Usage:
//   node scripts/merge-eval-galleries.mjs [--first <dir>] [--second <dir>]
//     [--out <dir>] [--first-layer wasm] [--second-layer cutout]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeGalleries, summarizeMerged, MERGED_LAYERS } from './lib/eval-gallery.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.lastIndexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const FIRST = resolve(ROOT, arg('--first', 'eval-results/gallery-backends'));
const SECOND = resolve(ROOT, arg('--second', 'eval-results/gallery-2up'));
const OUT = resolve(ROOT, arg('--out', 'public/eval-gallery'));
const FIRST_LAYER = arg('--first-layer', 'wasm');
const SECOND_LAYER = arg('--second-layer', 'cutout');

const rel = (p) => p.replace(`${ROOT}/`, '');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const first = readJson(resolve(FIRST, 'gallery.json'));
const second = readJson(resolve(SECOND, 'gallery.json'));

/** Source file for one layer of one image. */
const sourceOf = (id, key) => {
  if (key === 'before') return resolve(FIRST, `${id}-${FIRST_LAYER}.webp`);
  if (key === 'after') return resolve(SECOND, `${id}-${SECOND_LAYER}.webp`);
  return resolve(FIRST, `${id}-original.webp`);
};

const { cases, skipped } = mergeGalleries(first, second, {
  hasFile: (id, key) => existsSync(sourceOf(id, key)),
});

mkdirSync(OUT, { recursive: true });
for (const c of cases) {
  for (const layer of MERGED_LAYERS) {
    copyFileSync(sourceOf(c.id, layer.key), resolve(OUT, `${c.id}${layer.suffix}`));
  }
}

const summary = summarizeMerged(cases, first.model ?? second.model);
const gallery = {
  generatedAt: new Date().toISOString(),
  mode: 'three-layer',
  model: first.model ?? second.model,
  sources: [
    { layer: 'before', gallery: rel(FIRST), file: `-${FIRST_LAYER}.webp`, run: null, meanMs: summary.meanBeforeMs },
    { layer: 'after', gallery: rel(SECOND), file: `-${SECOND_LAYER}.webp`, run: second.run ?? null, meanMs: summary.meanAfterMs },
    { layer: 'original', gallery: rel(FIRST), file: '-original.webp', run: null, meanMs: null },
  ],
  benchmark: second.benchmark === true,
  summary,
  cases,
};
writeFileSync(resolve(OUT, 'gallery.json'), JSON.stringify(gallery, null, 2));

const bytes = cases.length * MERGED_LAYERS.length;
console.log(`${cases.length} cases (${skipped.length} skipped) -> ${rel(OUT)}/`);
console.log(`  ${bytes} webp files (${MERGED_LAYERS.map((l) => l.key).join(' | ')})`);
console.log(`  mean inference: before ${summary.meanBeforeMs} ms, after ${summary.meanAfterMs} ms`);
if (skipped.length) console.warn(`  skipped: ${skipped.join(', ')}`);
