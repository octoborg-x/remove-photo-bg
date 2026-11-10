// Browser flow tests (MVP §9) driven by puppeteer-core against a live dev
// server. Covers the end-to-end paths the unit tests cannot: real uploads, real
// inference, both exports, error surfacing, keyboard access, and the privacy
// property that no third-party request is made while processing.
//
// Usage:
//   node scripts/run-browser-tests.mjs [--url <page-url>] [--keep-server]
// Defaults to starting its own `vite` dev server on an ephemeral port.
//
// Requires a local model + WASM in public/ (npm run fetch-models) and Chromium.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CHROME = process.env.CHROME_BIN || '/usr/bin/chromium';
const PORT = Number(process.env.BROWSER_TEST_PORT || 4399);

// ——— Fixtures (generated, not committed) ———
// A minimal valid PNG encoder keeps the fixtures reproducible without checking
// in binaries: signature + IHDR + zlib(IDAT) + IEND.
const FIXTURES = resolve(ROOT, 'smoke-results/phase4-browser');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour (RGB)
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      raw[p] = rgb[0];
      raw[p + 1] = rgb[1];
      raw[p + 2] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writeFixtures() {
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(resolve(FIXTURES, 'input.png'), makePng(64, 48, [180, 90, 60]));
  writeFileSync(resolve(FIXTURES, 'not-an-image.txt'), 'this is not an image\n');
  // A file the browser labels as PNG (by extension) but whose bytes are not a
  // decodable image — the decode path must reject it.
  writeFileSync(resolve(FIXTURES, 'corrupt.png'), Buffer.from('not really a png at all'));
}

writeFixtures();

const urlArgIdx = process.argv.indexOf('--url');
const providedUrl = urlArgIdx >= 0 ? process.argv[urlArgIdx + 1] : null;
const keepServer = process.argv.includes('--keep-server');

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// The editor (drop zone, output, console) now lives inside the full-page Studio
// layer, which the header button opens. Every scenario that drives the editor
// must open it first.
async function openStudio(page) {
  await page.click('#studioLaunch');
  await page.waitForFunction(
    () => document.getElementById('studio')?.classList.contains('is-open') === true,
    { timeout: 10000 },
  );
}

async function waitForServer(url, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok || res.status === 404) return true;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`dev server did not start at ${url} within ${timeoutMs} ms`);
}

let server = null;
if (!providedUrl) {
  // Run vite's own binary directly (not through npx) and in its own process
  // group, so cleanup kills the whole tree — an npx wrapper leaves the real
  // server orphaned and holding the port.
  const viteBin = resolve(ROOT, 'node_modules/.bin/vite');
  server = spawn(viteBin, ['--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
}

const baseUrl = providedUrl || `http://127.0.0.1:${PORT}/`;
const pageUrl = new URL(baseUrl);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-webgpu',
    '--enable-logging=stderr',
  ],
  protocolTimeout: 3600000,
  timeout: 3600000,
});

try {
  if (!providedUrl) await waitForServer(pageUrl.toString());

  // ——— Scenario 1: JPEG upload → inference → both exports ———
  {
    const page = await browser.newPage();
    const requests = [];
    page.on('request', (req) => {
      const u = req.url();
      if (!u.startsWith('data:')) requests.push(u);
    });
    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    await openStudio(page);
    await page.waitForFunction('window.smokeModelReady === true', { timeout: 600000 });

    // Upload through the real file chooser (the button creates the input).
    const chooserPromise = page.waitForFileChooser({ timeout: 10000 });
    await page.click('#dropZone');
    const chooser = await chooserPromise;
    await chooser.accept([resolve(ROOT, 'test-images/glass-wine.jpg')]);

    // Wait for the app to decode + auto-start the run. There is no "Remove
    // background" button any more: choosing the photo starts the run.
    const hasRunButton = await page.evaluate(() => !!document.getElementById('runAll'));
    record('the "Remove background" button is gone (upload starts the run)', !hasRunButton);
    await page.waitForFunction(
      () => document.querySelector('#outputBox img') !== null,
      { timeout: 600000 },
    );

    const exportState = await page.evaluate(() => {
      const dl = document.getElementById('downloadImage');
      const radios = Array.from(document.querySelectorAll('#formatOptions input[type=radio]'));
      const img = document.querySelector('#outputBox img');
      return {
        dlHref: dl?.getAttribute('href') ?? '',
        dlDownload: dl?.getAttribute('download') ?? '',
        dlHidden: dl ? dl.hidden : true,
        dlText: dl?.textContent ?? '',
        radios: radios.map((r) => ({ value: r.value, checked: r.checked, disabled: r.disabled })),
        imgSrc: img?.getAttribute('src') ?? '',
        outputSectionHidden: document.getElementById('outputSection')?.hidden ?? true,
        log: document.getElementById('log')?.textContent ?? '',
      };
    });
    record(
      'JPEG upload → transparent PNG rendered',
      exportState.imgSrc.startsWith('data:image/png') && exportState.dlHref.startsWith('data:image/png'),
      exportState.dlDownload,
    );
    // PNG colour type byte (offset 25) must be 6 (truecolour + alpha).
    const pngB64 = exportState.dlHref.split(',')[1] ?? '';
    const colourType = Buffer.from(pngB64, 'base64')[25];
    record('PNG export has an alpha channel (colour type 6)', colourType === 6, `colourType=${colourType}`);
    record(
      'download section offers PNG (default) + JPG + WebP radios and one download link',
      exportState.outputSectionHidden === false &&
        exportState.dlHidden === false &&
        exportState.dlDownload.endsWith('.png') &&
        exportState.radios.length === 3 &&
        exportState.radios.some((r) => r.value === 'png' && r.checked) &&
        exportState.radios.some((r) => r.value === 'jpeg') &&
        exportState.radios.some((r) => r.value === 'webp'),
      `${exportState.dlDownload} / [${exportState.radios.map((r) => r.value).join(',')}]`,
    );

    // Switching the format re-encodes the same result into the chosen format.
    const jpegState = await page.evaluate(() => {
      const jpeg = document.querySelector('#formatOptions input[value=jpeg]');
      jpeg.click();
      const dl = document.getElementById('downloadImage');
      return { href: dl?.getAttribute('href') ?? '', download: dl?.getAttribute('download') ?? '' };
    });
    record(
      'selecting JPG re-encodes the download as a white-background JPEG',
      jpegState.href.startsWith('data:image/jpeg') && jpegState.download.endsWith('.jpg'),
      jpegState.download,
    );

    // The technical-details block lives in the studio workspace and lists the
    // steps in the order they ran. It is an always-visible status card (a div,
    // not a collapsed disclosure), so there is no open/closed state to assert.
    const panelState = await page.evaluate(() => {
      const details = document.getElementById('techDetails');
      const inStudio = !!document.getElementById('studio')?.contains(details);
      const label = document.getElementById('processingLabel')?.textContent ?? '';
      const steps = Array.from(document.querySelectorAll('#stepList li')).map((li) => ({
        text: li.textContent ?? '',
        state: li.dataset.state,
      }));
      return {
        inStudio,
        visible: details ? getComputedStyle(details).display !== 'none' : false,
        label,
        steps,
      };
    });
    record(
      'technical details sits in the studio workspace and lists download/prepare/inference/export steps',
      panelState.inStudio === true &&
        panelState.visible === true &&
        panelState.steps.length >= 4 &&
        panelState.steps.every((s) => s.state === 'done') &&
        panelState.steps.some((s) => /download/i.test(s.text)) &&
        panelState.steps.some((s) => /prepare/i.test(s.text)) &&
        panelState.steps.some((s) => /remove background/i.test(s.text)),
      panelState.steps.map((s) => `${s.state}:${s.text}`).join(' | '),
    );
    record(
      'the technical-details label reports the finished process',
      /done/i.test(panelState.label),
      panelState.label,
    );

    // Privacy: every request during processing is same-origin (no third party).
    const thirdParty = requests.filter((u) => {
      try {
        return new URL(u).origin !== pageUrl.origin;
      } catch {
        return false;
      }
    });
    record('no third-party requests during processing', thirdParty.length === 0, thirdParty.slice(0, 3).join(', '));
    await page.close();
  }

  // ——— Scenario 2: PNG upload → inference ———
  {
    const page = await browser.newPage();
    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    await openStudio(page);
    await page.waitForFunction('window.smokeModelReady === true', { timeout: 600000 });
    const pngPath = resolve(ROOT, 'smoke-results/phase4-browser/input.png');
    const chooserPromise = page.waitForFileChooser({ timeout: 10000 });
    await page.click('#dropZone');
    (await chooserPromise).accept([pngPath]);
    // Choosing the photo auto-starts the run; no button to click.
    await page.waitForFunction(() => document.querySelector('#outputBox img') !== null, { timeout: 600000 });
    const src = await page.evaluate(() => document.querySelector('#outputBox img')?.getAttribute('src') ?? '');
    record('PNG upload → transparent PNG rendered', src.startsWith('data:image/png'));
    await page.close();
  }

  // ——— Scenario 3: invalid MIME is rejected before decode ———
  {
    const page = await browser.newPage();
    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    await openStudio(page);
    await page.waitForFunction('window.smokeModelReady === true', { timeout: 600000 });
    const chooserPromise = page.waitForFileChooser({ timeout: 10000 });
    await page.click('#dropZone');
    (await chooserPromise).accept([resolve(ROOT, 'smoke-results/phase4-browser/not-an-image.txt')]);
    await page.waitForFunction(
      () => /Unsupported file type/.test(document.getElementById('stage')?.textContent ?? ''),
      { timeout: 10000 },
    );
    const hasOutput = await page.evaluate(() => document.querySelector('#outputBox img') !== null);
    record('unsupported file type shows an error and no output', hasOutput === false);
    await page.close();
  }

  // ——— Scenario 4: corrupt image (right MIME, bad bytes) is rejected ———
  {
    const page = await browser.newPage();
    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    await openStudio(page);
    await page.waitForFunction('window.smokeModelReady === true', { timeout: 600000 });
    const chooserPromise = page.waitForFileChooser({ timeout: 10000 });
    await page.click('#dropZone');
    (await chooserPromise).accept([resolve(ROOT, 'smoke-results/phase4-browser/corrupt.png')]);
    await page.waitForFunction(
      () => /Failed to decode|ERROR/.test(document.getElementById('stage')?.textContent ?? ''),
      { timeout: 10000 },
    );
    const hasOutput = await page.evaluate(() => document.querySelector('#outputBox img') !== null);
    record('corrupt image shows a decode error and no output', hasOutput === false);
    await page.close();
  }

  // ——— Scenario 5: worker + manifest failures reach the UI ———
  // The model fetch itself runs inside the inference worker/service worker, so
  // page-level interception cannot reach it. These two failures are page-level
  // (the worker script and the manifest are fetched by the page) and prove that
  // a failure surfaces as an on-screen error instead of a silent hang.
  {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (/\/inference-worker\.js/.test(req.url())) req.abort();
      else req.continue();
    });
    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    await openStudio(page);
    const sawError = await page
      .waitForFunction(
        () => /Error:/.test(document.getElementById('stage')?.textContent ?? ''),
        { timeout: 60000 },
      )
      .then(() => true)
      .catch(() => false);
    record('worker startup failure surfaces an error in the UI', sawError);
    const recoveryShown = await page.evaluate(
      () => (document.getElementById('recovery')?.hidden ?? true) === false,
    );
    record('worker failure shows a recovery panel', recoveryShown);
    await page.close();
  }
  {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (/\/models-manifest\.json/.test(req.url())) req.abort();
      else req.continue();
    });
    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    await openStudio(page);
    const sawError = await page
      .waitForFunction(
        () => /manifest/i.test(document.getElementById('stage')?.textContent ?? ''),
        { timeout: 60000 },
      )
      .then(() => true)
      .catch(() => false);
    record('manifest load failure surfaces an error in the UI', sawError);
    await page.close();
  }

  // ——— Scenario 6: keyboard-only activation of the drop zone ———
  // `input.click()` only opens the file chooser while the document is the
  // active, focused one, and this scenario runs late in a CI job that has
  // opened and closed several pages. Assert the focus actually landed before
  // pressing, and retry: a swallowed press would report a real regression in
  // the keyboard affordance, so we must distinguish "focus never landed" from
  // "Enter did nothing".
  {
    const page = await browser.newPage();
    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    await openStudio(page);
    await page.waitForFunction('window.smokeModelReady === true', { timeout: 600000 });
    await page.bringToFront();

    let focused = false;
    for (let attempt = 0; attempt < 3 && !focused; attempt += 1) {
      await page.focus('#dropZone');
      focused = await page.evaluate(() => document.activeElement?.id === 'dropZone');
    }
    if (!focused) {
      // Not a product failure: report it as such instead of a bogus "no chooser".
      record('drop zone is keyboard-activatable (Enter opens the chooser)', false);
      console.log('  (could not focus #dropZone; document.activeElement never became it)');
    } else {
      let opened = false;
      for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
        const chooserPromise = page.waitForFileChooser({ timeout: 10000 }).then(
          (chooser) => ({ chooser }),
          (err) => ({ err }),
        );
        await page.keyboard.press('Enter');
        const outcome = await chooserPromise;
        if (outcome.chooser) {
          await outcome.chooser.cancel();
          opened = true;
        }
      }
      record('drop zone is keyboard-activatable (Enter opens the chooser)', opened);
    }
    await page.close();
  }

  // ——— Scenario 7: metered-connection preflight ———
  // The decision module is unit-tested; this proves the page actually gates the
  // first download behind a confirmation with the model size, and that
  // confirming proceeds. The Network Information API is stubbed before scripts
  // run (it is read-only in the browser) with the exact regression shape: a
  // fast link reporting only `effectiveType: '4g'` and no `type`, on a mobile
  // device, which must still warn. The Cache API is cleared first so this is a
  // genuine cold visit rather than a cache hit.
  {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'connection', {
        configurable: true,
        get: () => ({ effectiveType: '4g', saveData: false }),
      });
      Object.defineProperty(navigator, 'userAgentData', {
        configurable: true,
        get: () => ({ mobile: true }),
      });
      // The app skips the prompt in automated sessions (CI's Chromium reports a
      // metered-looking connection). Opt this page out so the prompt path runs.
      Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => false });
    });
    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    await openStudio(page);
    // Make the visit cold: drop the model the earlier scenarios cached, before
    // the app boots. CDP clears Cache Storage without loading the page, so the
    // model cannot be re-cached mid-flight the way a post-load clear would allow.
    const cdp = await page.createCDPSession();
    await cdp.send('Storage.clearDataForOrigin', {
      origin: pageUrl.origin,
      storageTypes: 'cache_storage',
    });
    await page.reload({ waitUntil: 'load', timeout: 120000 });
    await openStudio(page);
    const warnShown = await page
      .waitForFunction(
        () => (document.getElementById('netWarn')?.hidden ?? true) === false,
        { timeout: 30000 },
      )
      .then(() => true)
      .catch(() => false);
    const warnText = await page.evaluate(
      () => document.getElementById('netWarnText')?.textContent ?? '',
    );
    record(
      'metered connection shows a download confirmation with the model size',
      warnShown && /\d+(\.\d+)? MB/.test(warnText),
      warnText.replace(/\s+/g, ' ').slice(0, 90),
    );
    const hasRemember = await page.evaluate(
      () => !!document.getElementById('netWarnRemember'),
    );
    record('the download confirmation no longer offers a "remember" checkbox', !hasRemember);

    // Confirm: the download starts and the prompt goes away.
    await page.click('#netWarnConfirm');
    const startedAfterConfirm = await page
      .waitForFunction('window.smokeModelReady === true', { timeout: 600000 })
      .then(() => true)
      .catch(() => false);
    const warnGone = await page.evaluate(
      () => (document.getElementById('netWarn')?.hidden ?? true) === true,
    );
    record('confirming the download starts the model load', startedAfterConfirm && warnGone);
    await page.close();
  }

  // ——— Scenario 8: a cached model skips the metered prompt ———
  // A missing prompt here can only be the on-device cache check.
  {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'connection', {
        configurable: true,
        get: () => ({ effectiveType: '4g', saveData: false }),
      });
      Object.defineProperty(navigator, 'userAgentData', {
        configurable: true,
        get: () => ({ mobile: true }),
      });
      Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => false });
    });
    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    await openStudio(page);
    const promptShown = await page
      .waitForFunction(
        () => (document.getElementById('netWarn')?.hidden ?? true) === false,
        { timeout: 5000 },
      )
      .then(() => true)
      .catch(() => false);
    const ready = await page
      .waitForFunction('window.smokeModelReady === true', { timeout: 600000 })
      .then(() => true)
      .catch(() => false);
    record(
      'a cached model loads over a metered link without prompting',
      promptShown === false && ready === true,
    );
    await page.close();
  }
} finally {
  await browser.close();
  if (server && !keepServer) {
    try {
      process.kill(-server.pid, 'SIGTERM'); // negative pid = the process group
    } catch {
      server.kill('SIGTERM');
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
if (failed.length) {
  console.error('Failed:', failed.map((f) => f.name).join('; '));
  process.exit(1);
}
