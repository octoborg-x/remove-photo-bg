// Evaluation harness: run the *real deployed pipeline* over the fixed image set
// in eval/manifest.json and record, per image, what a customer would see.
//
// It drives the actual page (the real upload path, the classic worker, the real
// model, the real exports) rather than re-implementing inference, so the numbers
// describe the shipped product. For each image it records:
//   - success/failure (and the error, if any),
//   - output dimensions (must equal the input's),
//   - timing and the execution provider,
//   - a transparency/edge summary computed from the output PNG.
//
// Raw output PNGs and the JSON report are written under eval-results/<run>/ so a
// future model or runtime change can be diffed against a fixed baseline.
//
// Usage:
//   node scripts/eval/run-eval.mjs --url http://127.0.0.1:4173/ --provider wasm \
//        --model model_512_int8_fp16 --out eval-results/wasm
//   RUN_GPU=1 node scripts/eval/run-eval.mjs --url ... --provider webgpu ...
//
// Requires: images downloaded (`python3 scripts/eval/build-eval-set.py --download`),
// a built/previewed site, and Chromium (CHROME_BIN or /usr/bin/chromium).
import puppeteer from 'puppeteer-core';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { execSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const provider = arg('provider', 'wasm');
const model = arg('model', null);
const outDir = resolve(ROOT, arg('out', 'eval-results/run'));
const runs = Number(arg('runs', '1'));
const only = arg('only', null);
const CHROME = process.env.CHROME_BIN || '/usr/bin/chromium';

// If no --url is given, serve the production build on a private port (like the
// browser tests do), so a single command runs the whole evaluation.
const PREVIEW_PORT = Number(process.env.EVAL_PORT || 4188);
let providedUrl = arg('url', null);
let server = null;
if (!providedUrl) {
  const viteBin = resolve(ROOT, 'node_modules/.bin/vite');
  server = spawn(viteBin, ['preview', '--port', String(PREVIEW_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  server.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  providedUrl = `http://127.0.0.1:${PREVIEW_PORT}/`;
}
const url = providedUrl;

async function waitForServer(target, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(target, { method: 'HEAD' });
      if (res.ok || res.status === 404) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`server did not start at ${target} within ${timeoutMs} ms`);
}
function stopServer() {
  if (!server) return;
  try {
    process.kill(-server.pid, 'SIGTERM'); // negative pid = the process group
  } catch {
    server.kill('SIGTERM');
  }
}

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'eval/manifest.json'), 'utf8'));
const IMAGE_DIR = resolve(ROOT, 'eval/images');

// Resolve each manifest entry to a local file (any extension).
function localPath(id) {
  for (const ext of ['.jpg', '.JPG', '.jpeg', '.JPEG', '.png', '.webp']) {
    const p = join(IMAGE_DIR, id + ext);
    if (existsSync(p)) return p;
  }
  return null;
}

const args = ['--no-sandbox', '--disable-dev-shm-usage', '--enable-precise-memory-info'];
if (process.env.RUN_GPU !== '1') args.push('--disable-gpu', '--disable-webgpu');

if (server) await waitForServer(url);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args,
  protocolTimeout: 3600000,
  timeout: 3600000,
});

mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, 'outputs'), { recursive: true });

const browserPid = browser.process().pid;
// Sample Chromium's RSS (renderer + worker + utility) to report peak memory.
function treeRssMb() {
  try {
    const out = execSync(
      `ps -e -o pid=,ppid=,rss= | awk '$1==${browserPid} || $2==${browserPid} {print $1}'`,
      { encoding: 'utf8' },
    );
    const pids = new Set([String(browserPid), ...out.split(/\s+/).filter(Boolean)]);
    let totalKb = 0;
    for (const p of pids) {
      try {
        totalKb += parseInt(execSync(`ps -o rss= -p ${p}`, { encoding: 'utf8' }).trim(), 10) || 0;
      } catch {
        /* process gone */
      }
    }
    return Math.round(totalKb / 1024);
  } catch {
    return null;
  }
}

// Build the page URL with the app's own overrides.
function pageUrl() {
  const u = new URL(url);
  u.searchParams.set('provider', provider);
  if (model) u.searchParams.set('model', model);
  return u.toString();
}

// Wait for the model once, in a throwaway page, so we can fail fast if the model
// cannot load at all and learn its id before the per-image loop.
let loadedModel = null;
{
  const p = await browser.newPage();
  p.on('pageerror', () => {});
  await p.goto(pageUrl(), { waitUntil: 'load', timeout: 180000 });
  const ready = await p
    .waitForFunction('window.smokeModelReady === true', { timeout: 900000 })
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    const st = await p.evaluate(() => ({
      stage: document.getElementById('stage')?.textContent,
      log: document.getElementById('log')?.textContent,
    }));
    console.error('Model did not become ready:', JSON.stringify(st, null, 2));
    await browser.close();
    stopServer();
    process.exit(1);
  }
  loadedModel = await p.evaluate(() => window.smokeModelId);
  await p.close();
}

const baselineMb = treeRssMb();
let peakMb = 0;
const memTimer = setInterval(() => {
  const r = treeRssMb();
  if (r && r > peakMb) peakMb = r;
}, 200);

const rows = [];
for (const cat of manifest.categories) {
  if (only && cat.category !== only) continue;
  for (const img of cat.images) {
    const file = localPath(img.id);
    const row = {
      id: img.id,
      category: img.category,
      title: img.title,
      license: img.license,
      source: img.page,
      expected: { width: img.width, height: img.height },
      provider,
      model: loadedModel,
    };
    if (!file) {
      row.ok = false;
      row.error = 'image not downloaded (run build-eval-set.py --download)';
      rows.push(row);
      console.log(`SKIP ${img.id}: ${row.error}`);
      continue;
    }

    // Fresh page per image so one failure cannot poison the next, and so each
    // timing is a clean decode → inference → export cycle.
    const p = await browser.newPage();
    p.on('pageerror', () => {});
    await p.goto(pageUrl(), { waitUntil: 'load', timeout: 180000 });
    await p.waitForFunction('window.smokeModelReady === true', { timeout: 900000 });

    // Drive the genuine customer path: choose a file, then run. Re-clicking run
    // re-runs inference on the already-loaded image, so `--runs` measures warm
    // repeats (the first run carries the cold cost).
    const chooserPromise = p.waitForFileChooser({ timeout: 20000 });
    await p.click('#pickFile');
    (await chooserPromise).accept([file]);
    await p.waitForFunction(() => !document.getElementById('runAll').disabled, { timeout: 30000 });

    const perRunMs = [];
    let state = null;
    let done = false;
    for (let run = 0; run < runs; run++) {
      const t0 = Date.now();
      await p.click('#runAll');
      done = await p
        .waitForFunction(
          () => /^(Done|Error|No output)/.test(document.getElementById('stage')?.textContent ?? ''),
          { timeout: 900000, polling: 300 },
        )
        .then(() => true)
        .catch(() => false);
      perRunMs.push(Date.now() - t0);
      state = await p.evaluate(() => {
        const img = document.querySelector('#outputBox img');
        return {
          stage: document.getElementById('stage')?.textContent ?? '',
          log: document.getElementById('log')?.textContent ?? '',
          dataUrl: img ? img.getAttribute('src') : null,
        };
      });
      if (!done || !state.dataUrl || !state.dataUrl.startsWith('data:image/png')) break;
    }

    const timings = [...(state?.log ?? '').matchAll(/Inference \d+: ([\d.]+) ms/g)].map((m) => Number(m[1]));
    if (!done || !state.dataUrl || !state.dataUrl.startsWith('data:image/png')) {
      row.ok = false;
      row.error = state.stage || 'no output';
      rows.push(row);
      console.log(`FAIL ${img.id}: ${row.error}`);
      await p.close();
      continue;
    }

    row.ok = true;
    row.runs = perRunMs.length;
    row.perRunMs = perRunMs;
    row.wallMs = perRunMs[perRunMs.length - 1];
    row.timings = timings;
    row.avgMs = timings.length ? timings.reduce((a, b) => a + b, 0) / timings.length : null;

    // Decode the output PNG in-page to measure real dimensions + alpha.
    const png = await p.evaluate((dataUrl) => {
      return new Promise((resolveDecode) => {
        const im = new Image();
        im.onload = () => {
          const c = document.createElement('canvas');
          c.width = im.naturalWidth;
          c.height = im.naturalHeight;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(im, 0, 0);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let opaque = 0;
          let transparent = 0;
          let partial = 0;
          for (let i = 3; i < d.length; i += 4) {
            if (d[i] >= 250) opaque++;
            else if (d[i] <= 5) transparent++;
            else partial++;
          }
          const n = d.length / 4;
          resolveDecode({
            width: c.width,
            height: c.height,
            opaqueFrac: opaque / n,
            transparentFrac: transparent / n,
            partialFrac: partial / n,
          });
        };
        im.onerror = () => resolveDecode(null);
        im.src = dataUrl;
      });
    }, state.dataUrl);

    if (png) {
      row.output = png;
      row.dimensionsCorrect = png.width === img.width && png.height === img.height;
    }
    const buf = Buffer.from(state.dataUrl.split(',')[1], 'base64');
    writeFileSync(join(outDir, 'outputs', `${img.id}.png`), buf);
    row.outputBytes = buf.length;

    rows.push(row);
    const dims = png ? `${png.width}x${png.height}` : '?';
    console.log(
      `OK   ${img.id} [${img.category}] ${dims} opaque=${(png?.opaqueFrac ?? 0).toFixed(3)} avg=${row.avgMs?.toFixed(0) ?? '?'}ms`,
    );
    await p.close();
  }
}

clearInterval(memTimer);
await browser.close();
stopServer();

const successes = rows.filter((r) => r.ok);
const failures = rows.filter((r) => !r.ok);
const dimsWrong = successes.filter((r) => r.dimensionsCorrect === false);
const byCategory = {};
for (const r of rows) {
  byCategory[r.category] ??= { total: 0, ok: 0, avgMs: [], opaqueFrac: [], partialFrac: [] };
  const b = byCategory[r.category];
  b.total++;
  if (r.ok) {
    b.ok++;
    if (r.avgMs) b.avgMs.push(r.avgMs);
    if (r.output) {
      b.opaqueFrac.push(r.output.opaqueFrac);
      b.partialFrac.push(r.output.partialFrac);
    }
  }
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const categorySummary = Object.fromEntries(
  Object.entries(byCategory).map(([k, b]) => [
    k,
    {
      total: b.total,
      succeeded: b.ok,
      successRate: b.total ? +(b.ok / b.total).toFixed(3) : null,
      meanInferMs: mean(b.avgMs) === null ? null : Math.round(mean(b.avgMs)),
      meanOpaqueFrac: mean(b.opaqueFrac) === null ? null : +mean(b.opaqueFrac).toFixed(4),
      meanPartialFrac: mean(b.partialFrac) === null ? null : +mean(b.partialFrac).toFixed(4),
    },
  ]),
);

const successAvg = successes.map((r) => r.avgMs).filter(Boolean);
const report = {
  generatedAt: new Date().toISOString(),
  pageUrl: pageUrl(),
  provider,
  model: loadedModel,
  runsPerImage: runs,
  peakBrowserRssMb: peakMb || null,
  baselineBrowserRssMb: baselineMb || null,
  summary: {
    total: rows.length,
    succeeded: successes.length,
    failed: failures.length,
    dimensionsWrong: dimsWrong.length,
    successRate: rows.length ? +(successes.length / rows.length).toFixed(3) : null,
    meanInferMs: mean(successAvg) === null ? null : Math.round(mean(successAvg)),
  },
  byCategory: categorySummary,
  rows,
};
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\n${successes.length}/${rows.length} images succeeded; ${dimsWrong.length} with wrong dimensions`);
console.log(`Wrote ${join(outDir, 'report.json')}`);

if (failures.length || dimsWrong.length) process.exit(1);
