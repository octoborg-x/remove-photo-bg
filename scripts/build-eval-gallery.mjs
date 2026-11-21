// Builds a static evaluation gallery from local eval runs. Two modes:
//
//   backends (default) — original | WASM/CPU cut-out | WebGPU cut-out, two runs.
//     node scripts/build-eval-gallery.mjs [--wasm <dir>] [--gpu <dir>] [--out <dir>]
//
//   single run (--run) — original | cut-out for ONE run, each card badged with
//   that run's benchmark verdict when `benchmark.json` sits beside `report.json`.
//     node scripts/build-eval-gallery.mjs --run eval-results/after-145
//
// Both modes write to scratch directories under eval-results/ (gitignored);
// scripts/merge-eval-galleries.mjs combines two of them into the committed
// three-layer page at public/eval-gallery/.
//
// Sources (all local, none committed to the gallery as-is):
//   - originals:  eval/images/<id>.{jpg,JPG,png}   (tracked in the repo)
//   - a run dir:  <run>/outputs/<id>.png + report.json [+ benchmark.json]
//
// Output:
//   eval-results/gallery-backends/  <id>-original.webp <id>-wasm.webp <id>-gpu.webp gallery.json
//   eval-results/gallery-2up/       <id>-original.webp <id>-cutout.webp gallery.json
//
// The eval PNGs are ~3 MB each (192 MB total), so everything is downscaled and
// re-encoded to WebP in a headless browser — the same approach as
// scripts/build-demo-assets.mjs. Cut-outs keep their alpha channel.
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOriginal, buildCases, summarize, buildPairs, summarizeRun } from './lib/eval-gallery.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_BIN || '/usr/bin/chromium';
const MAX_W = 768;
const QUALITY = 0.88;

const arg = (name, fallback) => {
  const i = process.argv.lastIndexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const RUN_DIR = arg('--run', null) && resolve(ROOT, arg('--run', null));
const OUT = resolve(ROOT, arg('--out', RUN_DIR ? 'eval-results/gallery-2up' : 'eval-results/gallery-backends'));
const rel = (p) => p.replace(`${ROOT}/`, '');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pngPath = (dir, id) => resolve(dir, 'outputs', `${id}.png`);

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

function reportTotals(enriched, skipped, files) {
  const bytes = readdirSync(OUT)
    .filter((f) => f.endsWith('.webp'))
    .reduce((s, f) => s + readFileSync(resolve(OUT, f)).length, 0);
  console.log(`\n${enriched.length} cases (${skipped.length} skipped) -> ${rel(OUT)}/`);
  console.log(`  ${enriched.length * files} webp files, ${(bytes / 1e6).toFixed(1)} MB`);
}

/** Default mode: original | WASM | WebGPU, from two backend runs. */
async function buildBackendGallery() {
  const WASM_DIR = resolve(ROOT, arg('--wasm', 'eval-results/wasm'));
  const GPU_DIR = resolve(ROOT, arg('--gpu', 'eval-results/webgpu'));
  const wasmReport = readJson(resolve(WASM_DIR, 'report.json'));
  const gpuReport = readJson(resolve(GPU_DIR, 'report.json'));

  const { cases, skipped } = buildCases(wasmReport, gpuReport, {
    hasOriginal: (id) => findOriginal(ROOT, id) !== null,
    hasOutput: (id, backend) => existsSync(pngPath(backend === 'wasm' ? WASM_DIR : GPU_DIR, id)),
  });

  const enriched = [];
  for (const c of cases) {
    const orig = await writeWebp(findOriginal(ROOT, c.id), `${c.id}-original.webp`);
    const wasm = await writeWebp(pngPath(WASM_DIR, c.id), `${c.id}-wasm.webp`);
    const gpu = await writeWebp(pngPath(GPU_DIR, c.id), `${c.id}-gpu.webp`);
    enriched.push({ ...c, width: orig.w, height: orig.h, dims: { wasm, gpu } });
    console.log(`OK  ${c.id}  ${orig.w}x${orig.h}`);
  }

  for (const id of skipped) console.warn(`skip ${id}: missing original or cut-out`);
  const gallery = {
    generatedAt: new Date().toISOString(),
    model: wasmReport.model,
    summary: summarize(enriched),
    cases: enriched,
  };
  writeFileSync(resolve(OUT, 'gallery.json'), JSON.stringify(gallery, null, 2));

  reportTotals(enriched, skipped, 3);
  console.log(`  mean inference: wasm ${gallery.summary.meanWasmMs} ms, webgpu ${gallery.summary.meanGpuMs} ms`);
}

/** Two-up mode: original | cut-out for one run, badged with its benchmark verdicts. */
async function buildTwoUpGallery() {
  const report = readJson(resolve(RUN_DIR, 'report.json'));
  const benchPath = resolve(RUN_DIR, 'benchmark.json');
  const benchmark = existsSync(benchPath) ? readJson(benchPath) : null;

  const { cases, skipped } = buildPairs(report, benchmark, {
    hasOriginal: (id) => findOriginal(ROOT, id) !== null,
    hasOutput: (id) => existsSync(pngPath(RUN_DIR, id)),
  });

  const enriched = [];
  for (const c of cases) {
    const orig = await writeWebp(findOriginal(ROOT, c.id), `${c.id}-original.webp`);
    const cutout = await writeWebp(pngPath(RUN_DIR, c.id), `${c.id}-cutout.webp`);
    enriched.push({ ...c, width: orig.w, height: orig.h, cutout });
    console.log(`OK  ${c.id}  ${orig.w}x${orig.h}${c.verdict ? `  ${c.verdict}` : ''}`);
  }

  for (const id of skipped) console.warn(`skip ${id}: missing original or cut-out`);
  const gallery = {
    generatedAt: new Date().toISOString(),
    mode: 'original-vs-cutout',
    model: report.model,
    run: rel(RUN_DIR),
    benchmark: benchmark !== null,
    summary: summarizeRun(enriched, report.model),
    cases: enriched,
  };
  writeFileSync(resolve(OUT, 'gallery.json'), JSON.stringify(gallery, null, 2));

  reportTotals(enriched, skipped, 2);
  console.log(`  mean inference: ${gallery.summary.meanMs} ms (${gallery.run})`);
  if (benchmark) {
    const v = gallery.summary.verdicts;
    console.log(`  benchmark verdicts: PASS ${v.PASS}, REVIEW ${v.REVIEW}, FAIL ${v.FAIL}, empty ${v.empty}`);
  }
}

if (RUN_DIR) await buildTwoUpGallery();
else await buildBackendGallery();
await browser.close();
