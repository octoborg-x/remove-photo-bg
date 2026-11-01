// Headless smoke-test driver for the Phase 2 harness.
//
// Usage:
//   node scripts/run-smoke.mjs <page-url> [--image <path-or-url>] [--out <dir>] [--runs <n>] [--model <id>] [--provider <wasm|webgpu>]
//
// Launches the system Chromium, opens the page, waits for the auto-loaded model
// (or first changes the selection via ?model= / ?provider= then waits), runs n
// inferences (default 1), collects results (timings, provider, measures index),
// the output PNG data URL (saved to <out>/), and a log of network requests made
// during processing (to verify no image pixels leave the page).
import puppeteer from 'puppeteer-core';

const argUrl = process.argv[2];
if (!argUrl) {
  console.error('Usage: node scripts/run-smoke.mjs <page-url> [--image <path-or-url>] [--out <dir>] [--runs <n>] [--model <id>] [--provider <wasm|webgpu>]');
  process.exit(1);
}
const imgIdx = process.argv.indexOf('--image');
const image = imgIdx >= 0 ? process.argv[imgIdx + 1] : null;
const outIdx = process.argv.indexOf('--out');
const outDir = outIdx >= 0 ? process.argv[outIdx + 1] : './smoke-results';
const runsIdx = process.argv.indexOf('--runs');
const requestedRuns = runsIdx >= 0 ? Number(process.argv[runsIdx + 1]) : 1;
const runs = Number.isFinite(requestedRuns) && requestedRuns >= 1 ? Math.floor(requestedRuns) : 1;
const modelIdx = process.argv.indexOf('--model');
const wantedModel = modelIdx >= 0 ? process.argv[modelIdx + 1] : null;
const providerIdx = process.argv.indexOf('--provider');
const wantedProvider = providerIdx >= 0 ? process.argv[providerIdx + 1] : null;

// ?model=/?provider= drive the app's own overrides (same path a tester would
// use); unknown values are ignored by the app, so the smoke run would then test
// whatever the default is. Fail loudly instead so a typo is never "green".
function injectOverrides(url) {
  const u = new URL(url);
  if (wantedModel) u.searchParams.set('model', wantedModel);
  if (wantedProvider) u.searchParams.set('provider', wantedProvider);
  return u.toString();
}

const CHROME = process.env.CHROME_BIN || '/usr/bin/chromium';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell' /* new headless supports WebGPU; shell is resize-able but no WebGPU */,
  args: ['--no-sandbox', '--disable-gpu', '--disable-webgpu', '--disable-dev-shm-usage', '--enable-logging=stderr'],
  protocolTimeout: 3600000,
  timeout: 3600000,
});

const page = await browser.newPage();
// Record every network request the page makes.
const requests = [];
page.on('request', (req) => {
  const url = req.url();
  // Filter noise (data: URLs, favicon, devtools).
  if (url.startsWith('data:')) return;
  requests.push({
    method: req.method(),
    url: url.slice(0, 200),
    resourceType: req.resourceType(),
  });
});
page.on('console', (msg) => {
  const t = msg.text();
  if (t.includes('log') || t.includes('error')) console.log('[console]', t.slice(0, 300));
});
page.on('pageerror', (err) => console.error('[pageerror]', err.message));

const results = {};
page.on('dialog', async (d) => d.dismiss());

await page.goto(injectOverrides(argUrl), { waitUntil: 'load', timeout: 120000 });

// Wait for the model to be ready (poll; the model download + WASM init can take
// several minutes on first load).
const modelReady = await page
  .waitForFunction('window.smokeModelReady === true', { timeout: 600000 })
  .then(() => true)
  .catch(async () => {
    const st = await page.evaluate(() => ({
      stage: document.getElementById('stage')?.textContent,
      log: document.getElementById('log')?.textContent,
      ready: window.smokeModelReady,
      provider: window.smokeProvider,
      model: window.smokeModelId,
    }));
    console.error('Model did not become ready. Page state:', JSON.stringify(st, null, 2));
    return false;
  });

if (!modelReady) {
  await browser.close();
  process.exit(1);
}
const readyInfo = await page.evaluate(() => ({
  provider: window.smokeProvider,
  model: window.smokeModelId,
}));
console.log('Model ready. Provider:', readyInfo.provider, '| Model:', readyInfo.model);
if (wantedProvider && readyInfo.provider !== wantedProvider) {
  console.error(`Expected provider ${wantedProvider}, got ${readyInfo.provider}`);
  await browser.close();
  process.exit(1);
}
if (wantedModel && readyInfo.model !== wantedModel) {
  console.error(`Expected model ${wantedModel}, got ${readyInfo.model}`);
  await browser.close();
  process.exit(1);
}

const target = image || 'test-images/glass-wine.jpg';
console.log(`Running smoke test on image: ${target} (${runs} run${runs > 1 ? 's' : ''})`);

const envInfo = await page.evaluate(() => ({
  crossOriginIsolated: globalThis.crossOriginIsolated === true,
  hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  wasmThreads: globalThis.WebAssembly?.ThreadsSupported ?? 'n/a',
}));
console.log('Browser env:', JSON.stringify(envInfo));

const runResult = await page.evaluate(
  async (img, n) => {
    // Expose a promise that resolves when the run completes.
    const result = await window.runSmoke(img, n);
    return result;
  },
  target,
  runs,
);

results.run = runResult;
results.provider = await page.evaluate(() => window.smokeProvider);

// Grab the output PNG data URL + the pre log.
results.outputPngDataUrl = await page.evaluate(() => {
  const img = document.querySelector('#outputBox img');
  return img ? img.getAttribute('src') : null;
});
results.log = await page.evaluate(() => document.querySelector('#log')?.textContent);

import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync(outDir, { recursive: true });

if (results.outputPngDataUrl) {
  const b64 = results.outputPngDataUrl.split(',')[1];
  writeFileSync(`${outDir}/output.png`, Buffer.from(b64, 'base64'));
  console.log(`Saved output PNG to ${outDir}/output.png`);
}
writeFileSync(`${outDir}/requests.json`, JSON.stringify(requests, null, 2));

// Measures index: 0-100 reliability score for the timing measurements.
// It rewards more runs and penalizes spread (coefficient of variation).
const timings = Array.isArray(results.run?.timings) ? results.run.timings : [];
const measuresIndex = (() => {
  if (timings.length === 1) return 40; // one sample: no spread evidence, low trust
  if (timings.length === 0) return 0;
  const mean = timings.reduce((a, b) => a + b, 0) / timings.length;
  const sd = Math.sqrt(
    timings.reduce((a, b) => a + (b - mean) ** 2, 0) / timings.length,
  );
  const cv = mean > 0 ? sd / mean : 1; // coefficient of variation
  // Base: runs help (log scale up to ~10); dispersion caps the score.
  const runScore = Math.min(1, Math.log2(timings.length + 1) / Math.log2(11));
  const stableScore = Math.max(0, 1 - cv); // 1.0 = perfectly stable
  return Math.round(100 * Math.sqrt(runScore * stableScore));
})();

writeFileSync(
  `${outDir}/summary.json`,
  JSON.stringify(
    {
      pageUrl: argUrl,
      image: target,
      provider: results.provider,
      model: results.run?.modelId ?? readyInfo.model,
      run: results.run,
      measuresIndex,
      pageLog: results.log,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ ...results.run, measuresIndex }, null, 2));
console.log(`Saved summary to ${outDir}/summary.json`);

// Report whether any request could carry image pixels.
const suspicious = requests.filter((r) =>
  r.resourceType === 'fetch' || r.resourceType === 'xhr' || r.url.includes('api'),
);
console.log('--- requests during run ---');
for (const r of requests.slice(0, 60)) {
  console.log(`  ${r.method} ${r.resourceType} ${r.url}`);
}
console.log('--- suspicious (fetch/xhr/api) ---', suspicious.length);
for (const r of suspicious) console.log('  ', r.method, r.resourceType, r.url);

await browser.close();