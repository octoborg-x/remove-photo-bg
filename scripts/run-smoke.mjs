// Headless smoke-test driver for the Phase 1 harness.
//
// Usage:
//   node scripts/run-smoke.mjs <page-url> [--image <path-or-url>] [--out <dir>]
//
// Launches the system Chromium, opens the Phase 1 page, waits for the model to
// load, runs WARM_RUNS inferences, collects results (timings, provider), the
// output PNG data URL (saved to <out>/), and a log of network requests made
// during processing (to verify no image pixels leave the page).
import puppeteer from 'puppeteer-core';

const argUrl = process.argv[2];
if (!argUrl) {
  console.error('Usage: node scripts/run-smoke.mjs <page-url> [--image <path-or-url>] [--out <dir>]');
  process.exit(1);
}
const imgIdx = process.argv.indexOf('--image');
const image = imgIdx >= 0 ? process.argv[imgIdx + 1] : null;
const outIdx = process.argv.indexOf('--out');
const outDir = outIdx >= 0 ? process.argv[outIdx + 1] : './smoke-results';
const runsIdx = process.argv.indexOf('--runs');
const runs = runsIdx >= 0 ? Number(process.argv[runsIdx + 1]) : 5;

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

await page.goto(argUrl, { waitUntil: 'load', timeout: 120000 });

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
    }));
    console.error('Model did not become ready. Page state:', JSON.stringify(st, null, 2));
    return false;
  });

if (!modelReady) {
  await browser.close();
  process.exit(1);
}
console.log('Model ready. Provider:', await page.evaluate(() => window.smokeProvider));

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
writeFileSync(
  `${outDir}/summary.json`,
  JSON.stringify(
    {
      pageUrl: argUrl,
      image: target,
      provider: results.provider,
      run: results.run,
      pageLog: results.log,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(results.run, null, 2));
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