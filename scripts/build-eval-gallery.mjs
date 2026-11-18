// Builds the static evaluation gallery: for each of the 64 eval images, a
// three-up card (original | WASM/CPU cut-out | WebGPU cut-out).
//
// Sources (all local, none committed to the gallery as-is):
//   - originals:  eval/images/<id>.{jpg,JPG,png}   (tracked in the repo)
//   - WASM run:   eval-results/wasm/outputs/<id>.png   + report.json
//   - WebGPU run: eval-results/webgpu/outputs/<id>.png + report.json
//
// Output (committed, served at /eval-gallery/):
//   public/eval-gallery/<id>-original.webp
//   public/eval-gallery/<id>-wasm.webp
//   public/eval-gallery/<id>-gpu.webp
//   public/eval-gallery/gallery.json
//
// The eval PNGs are ~3 MB each (192 MB total), so everything is downscaled and
// re-encoded to WebP in a headless browser — the same approach as
// scripts/build-demo-assets.mjs. Cut-outs keep their alpha channel.
//
// Usage: node scripts/build-eval-gallery.mjs [--wasm <dir>] [--gpu <dir>]
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOriginal, buildCases, summarize } from './lib/eval-gallery.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_BIN || '/usr/bin/chromium';
const OUT = resolve(ROOT, 'public', 'eval-gallery');
const MAX_W = 768;
const QUALITY = 0.88;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const WASM_DIR = resolve(ROOT, arg('--wasm', 'eval-results/wasm'));
const GPU_DIR = resolve(ROOT, arg('--gpu', 'eval-results/webgpu'));

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const wasmReport = readJson(resolve(WASM_DIR, 'report.json'));
const gpuReport = readJson(resolve(GPU_DIR, 'report.json'));

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.goto('about:blank');

/** Downscales + re-encodes one image file to a WebP data URL (alpha preserved). */
async function toWebp(path) {
  const mime = /\.png$/i.test(path) ? 'image/png' : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${readFileSync(path).toString('base64')}`;
  return page.evaluate(
    async (src, maxW, q) => {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('decode failed'));
        i.src = src;
      });
      const scale = Math.min(1, maxW / img.naturalWidth);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      const webp = c.toDataURL('image/webp', q);
      return { dataUrl: webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/png'), w, h };
    },
    dataUrl,
    MAX_W,
    QUALITY,
  );
}

async function writeWebp(srcPath, destName) {
  const { dataUrl, w, h } = await toWebp(srcPath);
  writeFileSync(resolve(OUT, destName), Buffer.from(dataUrl.split(',')[1], 'base64'));
  return { w, h };
}

const pngPath = (dir, id) => resolve(dir, 'outputs', `${id}.png`);
const { cases, skipped } = buildCases(wasmReport, gpuReport, {
  hasOriginal: (id) => findOriginal(ROOT, id) !== null,
  hasOutput: (id, backend) => existsSync(pngPath(backend === 'wasm' ? WASM_DIR : GPU_DIR, id)),
});

const enriched = [];
for (const c of cases) {
  const original = findOriginal(ROOT, c.id);
  const orig = await writeWebp(original, `${c.id}-original.webp`);
  const wasm = await writeWebp(pngPath(WASM_DIR, c.id), `${c.id}-wasm.webp`);
  const gpu = await writeWebp(pngPath(GPU_DIR, c.id), `${c.id}-gpu.webp`);
  enriched.push({ ...c, width: orig.w, height: orig.h, dims: { wasm, gpu } });
  console.log(`OK  ${c.id}  ${orig.w}x${orig.h}`);
}

await browser.close();

for (const id of skipped) console.warn(`skip ${id}: missing original or cut-out`);

const gallery = {
  generatedAt: new Date().toISOString(),
  model: wasmReport.model,
  summary: summarize(enriched),
  cases: enriched,
};
writeFileSync(resolve(OUT, 'gallery.json'), JSON.stringify(gallery, null, 2));

const bytes = readdirSync(OUT)
  .filter((f) => f.endsWith('.webp'))
  .reduce((s, f) => s + readFileSync(resolve(OUT, f)).length, 0);
console.log(`\n${enriched.length} cases (${skipped.length} skipped) -> public/eval-gallery/`);
console.log(`  ${enriched.length * 3} webp files, ${(bytes / 1e6).toFixed(1)} MB`);
console.log(`  mean inference: wasm ${gallery.summary.meanWasmMs} ms, webgpu ${gallery.summary.meanGpuMs} ms`);
