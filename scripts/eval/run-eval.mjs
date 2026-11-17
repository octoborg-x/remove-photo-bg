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
// While a run is in flight it prints the current operation on an interval (the
// app's live stage line + newest Console line), so a stall is visible. Tune the
// cadence with EVAL_PROGRESS_MS (default 10000 ms) or silence it with --quiet /
// EVAL_QUIET=1.
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
import { tmpdir } from 'node:os';
import { browserArgs, headlessMode, gpuRequested, assertHardwareGpu } from '../lib/gpu-browser.mjs';

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

// The editor (drop zone, output, console) lives inside the full-page Studio
// layer, which the header button opens; until then the layer is `visibility:
// hidden`, so a click on #dropZone lands on nothing and no file chooser opens.
// Drive the same customer path the browser tests do: open the Studio first.
async function openStudio(page) {
  // The module script is deferred and the browser may still be busy finishing a
  // previous page's inference, so the button has no listener for a moment. Wait
  // for it, click, and retry once if the first click landed too early.
  await page.waitForSelector('#studioLaunch', { timeout: 60000 });
  const isOpen = () =>
    page.evaluate(() => document.getElementById('studio')?.classList.contains('is-open') === true);
  await page.click('#studioLaunch');
  try {
    await page.waitForFunction(
      () => document.getElementById('studio')?.classList.contains('is-open') === true,
      { timeout: 20000 },
    );
  } catch {
    if (!(await isOpen())) await page.click('#studioLaunch');
    await page.waitForFunction(
      () => document.getElementById('studio')?.classList.contains('is-open') === true,
      { timeout: 20000 },
    );
  }
  // `is-open` starts a 0.28 s opacity/transform transition during which the layer
  // (and every control inside it) is still `visibility: hidden`, so a click would
  // land on nothing. Wait until the drop zone is genuinely visible.
  await page.waitForFunction(
    () => {
      const dz = document.getElementById('dropZone');
      return dz != null && getComputedStyle(dz).visibility === 'visible';
    },
    { timeout: 20000 },
  );
}

// Clicking the input opens the native file chooser, but the deferred module may
// not have attached its click listener yet on a busy runner — so a click can
// land on a dead element. Retry a few times instead of racing. Once a photo is
// chosen the drop zone is hidden and the preview takes over as the picker
// target, so click whichever one is currently visible.
async function chooseFile(page, filePath) {
  await page.waitForSelector('#dropZone', { timeout: 60000 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const chooserPromise = page.waitForFileChooser({ timeout: 10000 }).then(
      (chooser) => ({ chooser }),
      (err) => ({ err }),
    );
    const target = await page.evaluate(() => {
      const dz = document.getElementById('dropZone');
      const pv = document.getElementById('inputPreview');
      const visible = (el) => el && !el.hidden && el.getBoundingClientRect().height > 0;
      if (visible(dz)) return 'dropZone';
      if (visible(pv)) return 'inputPreview';
      return 'dropZone';
    });
    await page.click(`#${target}`);
    const outcome = await chooserPromise;
    if (outcome.chooser) {
      await outcome.chooser.accept([filePath]);
      return;
    }
  }
  throw new Error(`could not open the file chooser for ${filePath}`);
}

function stopServer() {
  if (!server) return;
  try {
    process.kill(-server.pid, 'SIGTERM'); // negative pid = the process group
  } catch {
    server.kill('SIGTERM');
  }
}

// ——— Live progress ———
// A run can stall for minutes in places that used to be silent: the preview
// server coming up, the first model load (download + session build), and each
// image's inference. Every long wait now prints the app's *current* operation on
// an interval — the pinned stage line plus the newest Console line, the same
// text the UI shows — so a stuck run says where it is instead of sitting mute
// until a 15-minute timeout. `--quiet` (or EVAL_QUIET=1) silences the heartbeat;
// EVAL_PROGRESS_MS sets the interval (default 10000 ms).
const PROGRESS_MS = Number(process.env.EVAL_PROGRESS_MS || 10000);
const QUIET = process.argv.includes('--quiet') || process.env.EVAL_QUIET === '1';

function elapsedLabel(startMs) {
  const s = Math.round((Date.now() - startMs) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

// Waits for the preview server, printing a heartbeat so a server that never
// comes up is visible rather than a silent 60 s hang.
async function waitForServer(target, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(target, { method: 'HEAD' });
      if (res.ok || res.status === 404) return;
    } catch {
      /* not up yet */
    }
    if (!QUIET && Date.now() - start >= PROGRESS_MS && (Date.now() - start) % PROGRESS_MS < 300) {
      console.log(`[wait] preview server ${target} (${elapsedLabel(start)})`);
    }
    await sleep(300);
  }
  throw new Error(`server did not start at ${target} within ${timeoutMs} ms`);
}

// Reads the app's live status: the stage line, the newest Console row, and
// whether the page has already surfaced a terminal error ("Error: …"). Never
// throws — a navigation in flight just reads as empty.
async function readAppState(page) {
  try {
    return await page.evaluate(() => {
      const stage = (document.getElementById('processingLabel')?.textContent ?? '').trim();
      const lines = document.querySelectorAll('#consoleOutput .consoleLine');
      const last = (lines[lines.length - 1]?.textContent ?? '').trim();
      return { stage, last, failed: stage.startsWith('Error:') };
    });
  } catch {
    return { stage: '', last: '', failed: false };
  }
}

// Runs `work()` (a long page wait) while printing the current operation every
// PROGRESS_MS. The interval is cleared as soon as the wait settles.
async function withProgress(label, page, work) {
  if (!QUIET) console.log(`[wait] ${label} …`);
  const start = Date.now();
  let busy = false;
  const timer = QUIET
    ? null
    : setInterval(() => {
        if (busy) return;
        busy = true;
        void readAppState(page)
          .then(({ stage, last }) => {
            const where = [stage, last].filter(Boolean).join('  |  ') || 'starting…';
            console.log(`[wait] ${label} — ${where} (${elapsedLabel(start)})`);
          })
          .finally(() => {
            busy = false;
          });
      }, PROGRESS_MS);
  try {
    return await work();
  } finally {
    if (timer) clearInterval(timer);
  }
}

// Waits for the model to load, stopping early when the page reports a terminal
// error so a "Backend not found" fails in seconds instead of after 15 minutes.
async function waitForModelReady(page, label) {
  await withProgress(label, page, () =>
    page.waitForFunction(
      () =>
        window.smokeModelReady === true ||
        (document.getElementById('processingLabel')?.textContent ?? '').trim().startsWith('Error:'),
      { timeout: 900000, polling: 1000 },
    ),
  );
  const { stage, failed } = await readAppState(page);
  if (failed) throw new Error(`the app reported an error before the model was ready: ${stage}`);
}

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'eval/manifest.json'), 'utf8'));
const IMAGE_DIR = resolve(ROOT, 'eval/images');
const totalImages = manifest.categories.reduce((n, c) => n + c.images.length, 0);
let imageNo = 0;

// Resolve each manifest entry to a local file (any extension).
function localPath(id) {
  for (const ext of ['.jpg', '.JPG', '.jpeg', '.JPEG', '.png', '.webp']) {
    const p = join(IMAGE_DIR, id + ext);
    if (existsSync(p)) return p;
  }
  return null;
}

const args = browserArgs(process.env, ['--enable-precise-memory-info']);

// A `--provider webgpu` run needs a real GPU. Without RUN_GPU=1 the Chromium
// flags above disable WebGPU outright, so the forced-WebGPU path can only fail
// with "no available backend found. ERR: [webgpu] backend not found" — the app's
// hard `?provider=webgpu` override has no WASM fallback. Say so before the run
// spends minutes downloading the model. (`--provider wasm` is always safe.)
if (provider === 'webgpu' && !gpuRequested()) {
  console.warn(
    '[warn] --provider webgpu with RUN_GPU unset: this Chromium disables WebGPU, so the ' +
      'forced GPU path will fail ("backend not found"). Re-run with RUN_GPU=1 on a host ' +
      'that has a real GPU (e.g. Colab T4), or use --provider wasm.',
  );
}

if (server) await waitForServer(url);

// A single line up front so the run's shape is visible: what, where, and how the
// progress heartbeat is configured.
console.log(
  `[run] provider=${provider}${model ? ` model=${model}` : ''} runs/image=${runs} ` +
    `images=${totalImages} out=${outDir}${QUIET ? ' (progress: off)' : ` (progress every ${PROGRESS_MS} ms)`}`,
);

// A single browser instance cannot survive the whole 64-image sweep: after ~50
// full-resolution inferences headless Chromium's renderer dies and every later
// `newPage()` throws `Protocol error (Target.createTarget): Session with given
// id not found`. Relaunch on demand so one dead renderer cannot abort the run.
async function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: headlessMode(),
    // A stable profile keeps the model in the HTTP cache across a relaunch, so
    // recovering from a renderer crash does not re-download the weights. It lives
    // in the OS temp dir, never the repo, so it cannot pollute lint/build output.
    userDataDir: join(tmpdir(), `smartcut-eval-${process.pid}`),
    args,
    protocolTimeout: 3600000,
    timeout: 3600000,
  });
}
function browserIsDead(err) {
  const msg = String(err?.message ?? err);
  return (
    /Target\.createTarget|Session with given id not found|Protocol error|Target closed|Connection closed|Session closed/i.test(
      msg,
    ) || browser?.connected === false
  );
}

let browser = await launchBrowser();

// Completed per-image rows, collected as the sweep proceeds.
const rows = [];

mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, 'outputs'), { recursive: true });

let browserPid = browser.process().pid;
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

// Open a fresh page, relaunching the browser if its renderer has died. Retries a
// couple of times so a transient crash costs one image's page, not the run.
async function newPage() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await browser.newPage();
    } catch (err) {
      if (attempt === 2 || !browserIsDead(err)) throw err;
      console.error(`[relaunch] browser lost after ${rows.length} images: ${err.message}`);
      try {
        await browser.close();
      } catch {
        /* already gone */
      }
      browser = await launchBrowser();
      browserPid = browser.process().pid;
    }
  }
  throw new Error('unreachable');
}

// Wait for the model once, in a throwaway page, so we can fail fast if the model
// cannot load at all and learn its id before the per-image loop.
let loadedModel = null;
{
  const p = await newPage();
  p.on('pageerror', () => {});
  await p.goto(pageUrl(), { waitUntil: 'load', timeout: 180000 });
  // On a GPU host, confirm the adapter is real hardware before spending minutes
  // on the sweep. A software renderer (SwiftShader/llvmpipe) means the flags or
  // drivers are wrong, and every WebGPU timing would be a lie. Fail cleanly
  // (close the browser and preview server) instead of dumping a stack trace.
  if (gpuRequested()) {
    try {
      const { label } = await assertHardwareGpu(p);
      console.log(`[gpu] WebGPU adapter: ${label}`);
    } catch (err) {
      console.error(`\n${err instanceof Error ? err.message : String(err)}`);
      await browser.close().catch(() => {});
      stopServer();
      process.exit(1);
    }
  }
  const ready = await waitForModelReady(p, 'loading model (first page)')
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    const st = await p.evaluate(() => ({
      stage: document.getElementById('processingLabel')?.textContent,
      log: document.getElementById('consoleOutput')?.textContent,
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
    // timing is a clean decode → inference → export cycle. A renderer crash or a
    // page error is contained to this image so the sweep still finishes.
    let p = null;
    try {
      p = await newPage();
      p.on('pageerror', () => {});
      imageNo += 1;
      const label = `${img.id} [${img.category}] ${imageNo}/${totalImages}`;
      await p.goto(pageUrl(), { waitUntil: 'load', timeout: 180000 });
      await waitForModelReady(p, `${label}: model ready`);

      // Drive the genuine customer path: choose a file, which auto-starts the run.
      // `runSmoke` re-runs inference on the already-loaded image, so `--runs`
      // measures warm repeats (the first run carries the cold cost).
      await withProgress(`${label}: upload + inference`, p, async () => {
        await openStudio(p);
        await chooseFile(p, file);
        await p.waitForFunction(
          () => /^(Done|Error|No output)/.test(document.getElementById('processingLabel')?.textContent ?? ''),
          { timeout: 900000, polling: 300 },
        );
      });

      const perRunMs = [];
      let state = null;
      let done = false;
      for (let run = 0; run < runs; run++) {
        const t0 = Date.now();
        if (run > 0) {
          // Warm repeat: run again on the already-loaded image and wait on the
          // run's own promise (the stage is already "Done", so polling it would
          // return immediately and record a bogus timing).
          await withProgress(`${label}: warm run ${run + 1}/${runs}`, p, () =>
            p.evaluate(() => window.runSmoke()),
          );
        }
        done = await p
          .waitForFunction(
            () => /^(Done|Error|No output)/.test(document.getElementById('processingLabel')?.textContent ?? ''),
            { timeout: 900000, polling: 300 },
          )
          .then(() => true)
          .catch(() => false);
        perRunMs.push(Date.now() - t0);
        state = await p.evaluate(() => {
          // The result panel shows a ≤450 px *display* preview in `#outputBox`; the
          // full-resolution cut-out lives on the download link's `href` (see
          // `applyFormatUi` in src/main.ts). Measure the export, not the preview,
          // or every image reports wrong dimensions.
          const link = document.getElementById('downloadImage');
          return {
            stage: document.getElementById('processingLabel')?.textContent ?? '',
            log: document.getElementById('consoleOutput')?.textContent ?? '',
            dataUrl: link && !link.hidden ? link.getAttribute('href') : null,
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
    } catch (err) {
      // A dead renderer, a timeout, or a page error must not abort the sweep:
      // record the image as failed and carry on with the next one.
      row.ok = false;
      row.error = String(err?.message ?? err);
      rows.push(row);
      console.log(`FAIL ${img.id}: ${row.error}`);
    } finally {
      try {
        await p?.close();
      } catch {
        /* page or browser already gone */
      }
    }
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
