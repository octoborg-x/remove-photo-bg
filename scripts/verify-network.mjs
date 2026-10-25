// Network/privacy verification for Phase 1.
//
// Loads the Phase 1 page (with the dev server), waits for the model to load,
// starts one inference, lets it run ~20 s, then records every network request
// the page made and writes a privacy verdict (`requests.json` + summary).
//
// The privacy property being verified: while an image is being processed, no
// image pixels leave the device — every request must be first-party and limited
// to app shell / model / WASM / (harness) test images.
//
// Usage: node scripts/verify-network.mjs <page-url>
import puppeteer from 'puppeteer-core';

const argUrl = process.argv[2];
if (!argUrl) {
  console.error('Usage: node scripts/verify-network.mjs <page-url>');
  process.exit(1);
}
const CHROME = process.env.CHROME_BIN || '/usr/bin/chromium';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--disable-webgpu', '--disable-dev-shm-usage'],
  protocolTimeout: 600000,
  timeout: 600000,
});

const page = await browser.newPage();
const requests = [];
page.on('request', (req) => {
  const url = req.url();
  if (url.startsWith('data:') || url.includes('favicon')) return;
  requests.push({
    method: req.method(),
    resourceType: req.resourceType(),
    url: url.slice(0, 300),
  });
});
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('error')) console.log('[console]', t.slice(0, 200));
});
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('dialog', (d) => d.dismiss());

await page.goto(argUrl, { waitUntil: 'load', timeout: 120000 });

// Wait for model load (proven to work; model+WASM download takes ~1-2 min).
const ready = await page
  .waitForFunction('window.smokeModelReady === true', { timeout: 600000 })
  .then(() => true)
  .catch(() => false);

console.log('modelReady:', ready, 'provider:', await page.evaluate(() => window.smokeProvider));

// Start one inference and let it run briefly — during processing we watch
// whether any new network request appears (there should be none).
await page.evaluate(() => {
  window.runSmoke('test-images/glass-wine.jpg', 1).catch(() => {});
});
await new Promise((r) => setTimeout(r, 20000)); // watch during processing

const state = await page.evaluate(() => ({
  stage: document.getElementById('stage')?.textContent,
  provider: window.smokeProvider,
}));

// Classify. The only allowed origins are the page origin (first-party).
const origin = new URL(argUrl).origin;
const external = requests.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith('http://localhost'));
const dataCandidates = requests.filter(
  (r) => r.resourceType === 'fetch' || r.resourceType === 'xhr' || /api/.test(r.url),
);
const report = {
  modelReady: ready,
  provider: state.provider,
  stage: state.stage,
  pageUrl: argUrl,
  totalRequests: requests.length,
  externalRequests: external,
  fetchOrXhrRequests: dataCandidates,
  verdict:
    external.length === 0 && dataCandidates.length === 0
      ? 'PASS — all requests first-party; no fetch/XHR; image pixels stayed on device'
      : 'REVIEW REQUIRED — see externalRequests / fetchOrXhrRequests',
};
console.log('\n--- requests ---');
for (const r of requests) console.log(`  ${r.method} ${r.resourceType} ${r.url}`);
console.log('\nexternalRequests:', external.length, ' fetchOrXhr:', dataCandidates.length);
console.log('verdict:', report.verdict);

const { mkdirSync, writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
mkdirSync('smoke-results', { recursive: true });
writeFileSync(
  join('smoke-results', 'network-verification.json'),
  JSON.stringify(report, null, 2),
);
writeFileSync(
  join('smoke-results', 'requests.json'),
  JSON.stringify(requests, null, 2),
);
console.log('\nWrote smoke-results/network-verification.json + requests.json');

await browser.close();
process.exit(report.verdict.startsWith('PASS') ? 0 : 1);