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
  // A 15.4 MP "phone photo" whose long side (4800) exceeds the 4096 upload cap.
  // Solid colour keeps the committed fixture tiny while the decode is realistic.
  writeFileSync(resolve(FIXTURES, 'large-phone-photo.png'), makePng(4800, 3200, [180, 90, 60]));
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

  // ——— Scenario 0: the hero tagline stays on one unbroken, animating line ———
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 360, height: 800 });
    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    const shape = await page.evaluate(() => {
      const el = document.querySelector('.heroTaglineText');
      const wrap = el.closest('.heroTagline');
      const track = el.closest('.heroTaglineTrack');
      const cs = getComputedStyle(el);
      const wcs = getComputedStyle(wrap);
      const tcs = getComputedStyle(track);
      return {
        nowrap: cs.whiteSpace === 'nowrap',
        padding: parseFloat(wcs.paddingLeft) > 0,
        clipped: wcs.overflow === 'hidden' || wcs.overflowX === 'hidden',
        lines: Math.round(el.offsetHeight / parseFloat(cs.lineHeight)),
        copies: track.querySelectorAll('.heroTaglineText').length,
        animation: tcs.animationName,
      };
    });
    record('hero tagline is one unbroken line', shape.nowrap && shape.lines === 1);
    record('hero tagline keeps its padding and clips overflow', shape.padding && shape.clipped);
    record('hero tagline loops with a seamless second copy', shape.copies === 2);
    // A linear marquee moves continuously, so sampling a couple of frames is
    // enough to see the track's transform change.
    let moved = false;
    let prev = await page.evaluate(() => getComputedStyle(document.querySelector('.heroTaglineTrack')).transform);
    for (let attempt = 0; attempt < 24 && !moved; attempt += 1) {
      await sleep(200);
      const now = await page.evaluate(() => getComputedStyle(document.querySelector('.heroTaglineTrack')).transform);
      moved = now !== prev;
      prev = now;
    }
    record('hero tagline scrolls horizontally (marquee animation)', shape.animation === 'taglineMarquee' && moved);
    await page.close();
  }

  // ——— Scenario 0b: the showcase shows one example, switchable from the rail ———
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });

    const readState = () =>
      page.evaluate(() => {
        const gallery = document.querySelector('[data-showcase]');
        const panels = [...gallery.querySelectorAll('[role="tabpanel"]')];
        const tabs = [...gallery.querySelectorAll('[role="tab"]')];
        const visible = panels.filter((p) => !p.hidden);
        const active = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
        const rail = gallery.querySelector('.showcaseRail');
        const railBox = rail.getBoundingClientRect();
        const stageBox = gallery.querySelector('.compareStage').getBoundingClientRect();
        return {
          panelCount: panels.length,
          tabCount: tabs.length,
          visibleCount: visible.length,
          visibleId: visible[0]?.id ?? null,
          selectedId: active?.getAttribute('aria-controls') ?? null,
          activeTabId: active?.id ?? null,
          activeTabTabIndex: active?.tabIndex ?? null,
          railBelowStage: railBox.top >= stageBox.bottom - 1,
          railScrolls: rail.scrollWidth > rail.clientWidth,
        };
      });

    const initial = await readState();
    record(
      'the showcase shows exactly one example at a time',
      initial.panelCount === 9 && initial.tabCount === 9 && initial.visibleCount === 1,
      `visible ${initial.visibleCount}/${initial.panelCount}`,
    );
    record(
      'the first example is selected by default',
      initial.visibleId === 'showcase-panel-1' && initial.selectedId === 'showcase-panel-1',
      `${initial.visibleId} / ${initial.selectedId}`,
    );
    record('the thumbnail rail sits below the stage', initial.railBelowStage);
    record(
      'the thumbnail rail scrolls horizontally to reach all nine examples',
      initial.railScrolls,
      `scroll ${initial.railScrolls}`,
    );

    // Click the third thumbnail. The module script is deferred, so the rail may
    // not have listeners yet on a busy runner — retry until the click lands.
    let afterClick = initial;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await page.click('#showcase-tab-3');
      afterClick = await readState();
      if (afterClick.visibleId === 'showcase-panel-3') break;
      await sleep(150);
    }
    record(
      'clicking a thumbnail switches the visible example',
      afterClick.visibleId === 'showcase-panel-3' && afterClick.visibleCount === 1 && afterClick.activeTabId === 'showcase-tab-3',
      `${afterClick.visibleId}`,
    );

    // Keyboard: focus the active tab and arrow up to the previous example.
    await page.focus('#showcase-tab-3');
    await page.keyboard.press('ArrowUp');
    const afterKey = await readState();
    record(
      'arrow keys move the selection between examples (roving tabindex)',
      afterKey.visibleId === 'showcase-panel-2' &&
        afterKey.activeTabId === 'showcase-tab-2' &&
        afterKey.activeTabTabIndex === 0,
      `${afterKey.visibleId} tabindex ${afterKey.activeTabTabIndex}`,
    );

    // The slider on the newly revealed example still works.
    const pos = await page.evaluate(() => {
      const panel = document.getElementById('showcase-panel-2');
      const range = panel.querySelector('.compareRange');
      range.value = '80';
      range.dispatchEvent(new Event('input', { bubbles: true }));
      return panel.style.getPropertyValue('--pos');
    });
    record('the comparison slider works on the revealed example', pos === '80%', pos);

    // A pointer drag has to track the whole gesture. Dragging a bare <img>
    // starts a native drag-and-drop, which fires `pointercancel` and used to
    // freeze the divider after its first move.
    const stageBox = await page.evaluate(() => {
      const stage = document.querySelector('#showcase-panel-2 .compareStage');
      stage.scrollIntoView({ block: 'center' });
      const r = stage.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const dragY = stageBox.y + stageBox.h / 2;
    await page.mouse.move(stageBox.x + stageBox.w * 0.2, dragY);
    await page.mouse.down();
    await page.mouse.move(stageBox.x + stageBox.w * 0.8, dragY, { steps: 6 });
    await page.mouse.up();
    const dragPos = await page.evaluate(() =>
      document.getElementById('showcase-panel-2').style.getPropertyValue('--pos'),
    );
    record(
      'dragging the comparison stage tracks the pointer across the whole gesture',
      Math.abs(Number.parseFloat(dragPos) - 80) <= 2,
      dragPos,
    );

    await page.close();
  }

  // ——— Scenario 0c: the Plain-Language Reference carousel ———
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });

    const readState = () =>
      page.evaluate(() => {
        const carousel = document.querySelector('[data-support-carousel]');
        const slides = [...carousel.querySelectorAll('[data-support-slide]')];
        const dots = [...carousel.querySelectorAll('[data-support-dot]')];
        const track = carousel.querySelector('[data-support-track]');
        const active = slides.findIndex((s) => s.classList.contains('is-active'));
        const activeDot = dots.findIndex((d) => d.classList.contains('is-active'));
        const visible = slides.filter((s) => !s.hasAttribute('inert'));
        const match = /translateX\((-?[\d.]+)%\)/.exec(track.style.transform);
        return {
          slideCount: slides.length,
          dotCount: dots.length,
          visibleCount: visible.length,
          active,
          activeDot,
          translatePct: match ? parseFloat(match[1]) : NaN,
          trackTransition: getComputedStyle(track).transitionDuration,
          activeDotWidth: getComputedStyle(dots[active] ?? dots[0]).width,
        };
      });

    const initial = await readState();
    record(
      'the reference carousel shows one capability at a time',
      initial.slideCount === 6 && initial.dotCount === 6 && initial.visibleCount === 1 && initial.active === 0,
      `visible ${initial.visibleCount}/${initial.slideCount} active ${initial.active}`,
    );
    record(
      'the carousel track slides with an animated transform',
      initial.translatePct === 0 && parseFloat(initial.trackTransition) > 0,
      `${initial.translatePct}% / ${initial.trackTransition}`,
    );

    // The deferred module may not have listeners yet on a busy runner: retry.
    let afterNext = initial;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await page.click('[data-support-next]');
      afterNext = await readState();
      if (afterNext.active === 1) break;
      await sleep(150);
    }
    record(
      'the next arrow advances to the second capability',
      afterNext.active === 1 && afterNext.activeDot === 1 && afterNext.visibleCount === 1,
      `active ${afterNext.active} dot ${afterNext.activeDot}`,
    );
    // The dot widens over a 0.3s transition; let it settle before measuring.
    await sleep(400);
    const settled = await readState();
    record(
      'advancing slides the track and grows the active dot',
      settled.translatePct === -100 && parseFloat(settled.activeDotWidth) > 8,
      `${settled.translatePct}% dot ${settled.activeDotWidth}`,
    );

    await page.click('[data-support-prev]');
    const afterPrev = await readState();
    record('the previous arrow returns to the first capability', afterPrev.active === 0, `active ${afterPrev.active}`);

    // Wrapping: one step back from the first slide lands on the last.
    await page.click('[data-support-prev]');
    const afterWrap = await readState();
    record('stepping back from the first capability wraps to the last', afterWrap.active === 5, `active ${afterWrap.active}`);

    // Keyboard: right arrow on the carousel advances.
    await page.focus('[data-support-next]');
    await page.keyboard.press('ArrowRight');
    const afterKey = await readState();
    record('arrow keys move the carousel', afterKey.active === 0, `active ${afterKey.active}`);

    // Dots jump straight to a slide.
    await page.click('[data-support-dot]:nth-child(4)');
    const afterDot = await readState();
    record('a dot jumps straight to its capability', afterDot.active === 3, `active ${afterDot.active}`);

    await page.close();
  }

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
    await chooseFile(page, resolve(ROOT, 'test-images/glass-wine.jpg'));

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
        log: document.getElementById('consoleOutput')?.textContent ?? '',
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

    // One step tab, titled after the current step: the result view now carries
    // the before/after slider instead of a separate Compare tab.
    const stepState = await page.evaluate(() => {
      const tab = document.getElementById('tabStep');
      const toggle = document.getElementById('resultCompareToggle');
      const beforeEl = document.querySelector('#outputBox .resultCompare .compareBefore');
      const beforeHidden = beforeEl ? getComputedStyle(beforeEl).display === 'none' : false;
      toggle?.click();
      const afterClick = {
        pressed: toggle?.getAttribute('aria-pressed'),
        beforeDisplay: beforeEl ? getComputedStyle(beforeEl).display : '',
      };
      toggle?.click();
      return {
        title: tab?.textContent?.trim() ?? '',
        selected: tab?.getAttribute('aria-selected') === 'true',
        resultVisible: !document.getElementById('stepResult')?.hidden,
        before: document.querySelector('#outputBox .resultCompare .compareBefore')?.getAttribute('src') ?? '',
        after: document.querySelector('#outputBox .resultCompare .compareAfter')?.getAttribute('src') ?? '',
        compareToggle: !!toggle && toggle.hidden === false,
        beforeHidden,
        afterClick,
        beforeHiddenAgain: beforeEl ? getComputedStyle(beforeEl).display === 'none' : false,
      };
    });
    record(
      'the single step tab is titled Result and builds the before/after slider',
      stepState.title === 'Result' &&
        stepState.selected &&
        stepState.resultVisible &&
        stepState.before.length > 0 &&
        stepState.after.startsWith('data:image/'),
      `${stepState.title} / before ${stepState.before.length > 0} / after ${stepState.after.slice(0, 22)}`,
    );
    record(
      'the compare button floats over the image and gates the before/after slider',
      stepState.compareToggle &&
        stepState.beforeHidden &&
        stepState.afterClick.pressed === 'true' &&
        stepState.afterClick.beforeDisplay !== 'none' &&
        stepState.beforeHiddenAgain,
      `toggle ${stepState.compareToggle} hidden ${stepState.beforeHidden} → ${stepState.afterClick.beforeDisplay} → hidden ${stepState.beforeHiddenAgain}`,
    );

    // Bulk and Library are available once a result exists, and the old Compare
    // tab is gone. Wait for refinement to settle so the engine is no longer
    // owned by the run (the Bulk tab is disabled while it is).
    await page.waitForFunction(() => !document.getElementById('tabBulk')?.disabled, { timeout: 600000 });
    const tabsState = await page.evaluate(() => ({
      compareGone: !document.getElementById('tabCompare') && !document.getElementById('panelCompare'),
      bulkEnabled: !document.getElementById('tabBulk')?.disabled,
      libraryEnabled: !document.getElementById('tabLibrary')?.disabled,
      exportParent: document.getElementById('exportBar')?.parentElement?.className ?? '',
    }));
    record(
      'Bulk and Library tabs replace Compare, with background & export to the right of the sidebar',
      tabsState.compareGone &&
        tabsState.bulkEnabled &&
        tabsState.libraryEnabled &&
        tabsState.exportParent.includes('studioTabBody'),
      `compareGone ${tabsState.compareGone} bulk ${tabsState.bulkEnabled} library ${tabsState.libraryEnabled} exportIn ${tabsState.exportParent}`,
    );

    // The Background & Export header collapses and restores its own body.
    const exportBarState = await page.evaluate(() => {
      const toggle = document.getElementById('bottomBarCollapse');
      const body = document.getElementById('bottomBarBody');
      const display = () => (body ? getComputedStyle(body).display : '');
      const initial = { expanded: toggle?.getAttribute('aria-expanded'), display: display() };
      toggle?.click();
      const collapsed = { expanded: toggle?.getAttribute('aria-expanded'), display: display() };
      toggle?.click();
      return { initial, collapsed, restored: display() };
    });
    record(
      'the Background & Export header shows and hides its body',
      exportBarState.initial.expanded === 'true' &&
        exportBarState.initial.display !== 'none' &&
        exportBarState.collapsed.expanded === 'false' &&
        exportBarState.collapsed.display === 'none' &&
        exportBarState.restored !== 'none',
      `${exportBarState.initial.expanded}/${exportBarState.initial.display} → ${exportBarState.collapsed.expanded}/${exportBarState.collapsed.display} → ${exportBarState.restored}`,
    );

    // Background picker: one system colour input (a solid colour exports as JPG,
    // no alpha to carry) repaints the compare view; the transparent toggle
    // returns a real alpha PNG.
    const bgState = await page.evaluate(() => {
      const picker = document.getElementById('bgColorPicker');
      picker.value = '#2563eb';
      picker.dispatchEvent(new Event('input', { bubbles: true }));
      const afterColor = {
        download: document.getElementById('downloadImage')?.getAttribute('download') ?? '',
        pressed: document.getElementById('bgTransparentBtn')?.getAttribute('aria-pressed'),
        compareAfter: document.querySelector('#outputBox .resultCompare .compareAfter')?.getAttribute('src') ?? '',
      };
      document.getElementById('bgTransparentBtn').click();
      const afterTransparent = {
        download: document.getElementById('downloadImage')?.getAttribute('download') ?? '',
        current: document.getElementById('bgCurrent')?.textContent ?? '',
      };
      return { afterColor, afterTransparent };
    });
    record(
      'picking a solid background exports JPG and repaints the compare view',
      bgState.afterColor.download.endsWith('.jpg') &&
        bgState.afterColor.pressed === 'false' &&
        bgState.afterColor.compareAfter.startsWith('data:image/'),
      bgState.afterColor.download,
    );
    record(
      'transparent keeps a PNG export',
      bgState.afterTransparent.download.endsWith('.png') &&
        bgState.afterTransparent.current === 'transparent',
      bgState.afterTransparent.current,
    );

    // PNG/WebP are the alpha-capable formats, so choosing one after a solid
    // colour must hand back a transparent cut-out instead of an opaque file
    // (the "PNG and WebP don't take alpha" report).
    const alphaFormatState = await page.evaluate(async () => {
      const picker = document.getElementById('bgColorPicker');
      picker.value = '#ffffff';
      picker.dispatchEvent(new Event('input', { bubbles: true }));
      const solid = document.getElementById('downloadImage')?.getAttribute('download') ?? '';
      document.querySelector('#formatOptions input[value=png]').click();
      const dl = document.getElementById('downloadImage');
      const href = dl?.getAttribute('href') ?? '';
      const img = new Image();
      img.src = href;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let transparent = 0;
      for (let i = 3; i < data.length; i += 4 * 97) if (data[i] === 0) transparent += 1;
      const alpha = document.getElementById('bgAlpha');
      return {
        solid,
        download: dl?.getAttribute('download') ?? '',
        current: document.getElementById('bgCurrent')?.textContent ?? '',
        transparent,
        alphaDisabled: alpha.disabled,
        alphaValue: document.getElementById('bgAlphaValue')?.textContent ?? '',
      };
    });
    record(
      'selecting PNG after a solid colour restores a transparent cut-out',
      alphaFormatState.solid.endsWith('.jpg') &&
        alphaFormatState.download.endsWith('.png') &&
        alphaFormatState.current === 'transparent' &&
        alphaFormatState.transparent > 0,
      `${alphaFormatState.solid} → ${alphaFormatState.download} (${alphaFormatState.current}, transparent samples=${alphaFormatState.transparent})`,
    );
    record(
      'the alpha slider is inert on a transparent background',
      alphaFormatState.alphaDisabled && alphaFormatState.alphaValue === '—',
      `disabled=${alphaFormatState.alphaDisabled} value=${alphaFormatState.alphaValue}`,
    );

    // ——— Manual retouch: open → stroke → Save, then open → Cancel ———
    // The edit icon lives only on the Result tab. Opening it swaps the
    // background & export block for the retouch panel in the same slot; Save
    // commits the edited alpha and restores the block, Cancel restores it
    // pixel-for-pixel.
    const retouchEntry = await page.evaluate(() => {
      const btn = document.getElementById('resultEditToggle');
      const panel = document.getElementById('retouchPanel');
      const exportBar = document.getElementById('exportBar');
      const rect = btn?.getBoundingClientRect();
      return {
        hasBtn: !!btn,
        hidden: btn ? btn.hidden : true,
        visible: !!rect && rect.width > 0 && rect.height > 0,
        panelHidden: panel ? panel.hidden : true,
        sameSlot:
          panel?.parentElement === exportBar?.parentElement &&
          panel?.parentElement?.classList.contains('studioTabBody') === true,
      };
    });
    record(
      'the retouch edit icon appears on the Result tab in the export slot',
      retouchEntry.hasBtn &&
        retouchEntry.hidden === false &&
        retouchEntry.visible &&
        retouchEntry.panelHidden &&
        retouchEntry.sameSlot,
      `btn ${retouchEntry.hasBtn} hidden ${retouchEntry.hidden} visible ${retouchEntry.visible} sameSlot ${retouchEntry.sameSlot}`,
    );

    const retouchSave = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const loadPixels = async (href) => {
        const img = new Image();
        img.src = href;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return { c, ctx, data: ctx.getImageData(0, 0, c.width, c.height).data };
      };
      const alphaAt = async (href, fx, fy) => {
        const { c, data } = await loadPixels(href);
        const x = Math.min(c.width - 1, Math.max(0, Math.round(c.width * fx)));
        const y = Math.min(c.height - 1, Math.max(0, Math.round(c.height * fy)));
        return data[(y * c.width + x) * 4 + 3];
      };
      const findOpaque = async (href) => {
        const { c, data } = await loadPixels(href);
        const stepX = Math.max(8, Math.floor(c.width / 24));
        const stepY = Math.max(8, Math.floor(c.height / 24));
        for (let y = 8; y < c.height; y += stepY) {
          for (let x = 8; x < c.width; x += stepX) {
            const a = data[(y * c.width + x) * 4 + 3];
            if (a > 200) return { fx: x / c.width, fy: y / c.height };
          }
        }
        return { fx: 0.5, fy: 0.5 };
      };
      const dl = document.getElementById('downloadImage');
      const beforeHref = dl.getAttribute('href');
      const pt = await findOpaque(beforeHref);
      const beforeAlpha = await alphaAt(beforeHref, pt.fx, pt.fy);

      document.getElementById('resultEditToggle').click();
      await sleep(40);
      const panel = document.getElementById('retouchPanel');
      const exportBar = document.getElementById('exportBar');
      const canvas = document.getElementById('retouchCanvas');
      const openState = {
        panelHidden: panel?.hidden,
        exportHidden: exportBar?.hidden,
        canvas: !!canvas,
      };

      // Erase is guaranteed to change an opaque centre pixel.
      document.getElementById('retouchErase').click();
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width * pt.fx;
      const cy = rect.top + rect.height * pt.fy;
      const ev = (type, x, y) =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          pointerId: 7,
          pointerType: 'mouse',
          isPrimary: true,
          buttons: type === 'pointerup' ? 0 : 1,
        });
      canvas.dispatchEvent(ev('pointerdown', cx, cy));
      canvas.dispatchEvent(ev('pointermove', cx + Math.max(4, rect.width * 0.06), cy));
      canvas.dispatchEvent(ev('pointerup', cx + Math.max(4, rect.width * 0.06), cy));

      const undo = document.getElementById('retouchUndo');
      const redo = document.getElementById('retouchRedo');
      const undoEnabled = !undo.disabled;
      undo.click();
      const redoEnabled = !redo.disabled;
      redo.click();

      document.getElementById('retouchSave').click();
      for (let i = 0; i < 200 && !panel.hidden; i++) await sleep(50);

      const afterHref = dl.getAttribute('href');
      const afterAlpha = await alphaAt(afterHref, pt.fx, pt.fy);
      return {
        beforeAlpha,
        afterAlpha,
        undoEnabled,
        redoEnabled,
        openState,
        panelHiddenAfter: panel.hidden,
        exportHiddenAfter: exportBar.hidden,
        download: dl.getAttribute('download'),
        log: document.getElementById('consoleOutput')?.textContent ?? '',
      };
    });
    record(
      'opening retouch hides the background & export block and shows the brush canvas',
      retouchSave.openState.panelHidden === false &&
        retouchSave.openState.exportHidden === true &&
        retouchSave.openState.canvas === true,
      `panel ${retouchSave.openState.panelHidden} export ${retouchSave.openState.exportHidden} canvas ${retouchSave.openState.canvas}`,
    );
    record(
      'undo/redo toggles per stroke while retouching',
      retouchSave.undoEnabled === true && retouchSave.redoEnabled === true,
      `undo ${retouchSave.undoEnabled} redo ${retouchSave.redoEnabled}`,
    );
    record(
      'a retouch stroke + Save changes the exported alpha and restores the export block',
      retouchSave.beforeAlpha > 200 &&
        retouchSave.afterAlpha < 50 &&
        retouchSave.panelHiddenAfter === true &&
        retouchSave.exportHiddenAfter === false &&
        retouchSave.download.endsWith('.png') &&
        /Manual retouch saved: 1 stroke/.test(retouchSave.log),
      `alpha ${retouchSave.beforeAlpha} → ${retouchSave.afterAlpha}, panel ${retouchSave.panelHiddenAfter}, export ${retouchSave.exportHiddenAfter}`,
    );

    const retouchCancel = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const dl = document.getElementById('downloadImage');
      const beforeHref = dl.getAttribute('href');
      document.getElementById('resultEditToggle').click();
      await sleep(40);
      const canvas = document.getElementById('retouchCanvas');
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width * 0.5;
      const cy = rect.top + rect.height * 0.5;
      const ev = (type, x, y) =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          pointerId: 8,
          pointerType: 'mouse',
          isPrimary: true,
          buttons: type === 'pointerup' ? 0 : 1,
        });
      document.getElementById('retouchErase').click();
      canvas.dispatchEvent(ev('pointerdown', cx, cy));
      canvas.dispatchEvent(ev('pointerup', cx, cy));
      document.getElementById('retouchCancel').click();
      await sleep(60);
      return {
        unchanged: dl.getAttribute('href') === beforeHref,
        panelHidden: document.getElementById('retouchPanel').hidden,
        exportHidden: document.getElementById('exportBar').hidden,
        overlayGone: !document.getElementById('retouchCanvas'),
        editVisible: document.getElementById('resultEditToggle').hidden === false,
      };
    });
    record(
      'Cancel restores the pre-edit export pixel-for-pixel',
      retouchCancel.unchanged &&
        retouchCancel.panelHidden === true &&
        retouchCancel.exportHidden === false &&
        retouchCancel.overlayGone === true &&
        retouchCancel.editVisible === true,
      `unchanged ${retouchCancel.unchanged} panel ${retouchCancel.panelHidden} export ${retouchCancel.exportHidden} overlayGone ${retouchCancel.overlayGone}`,
    );

    const retouchTabs = await page.evaluate(() => {
      const btn = document.getElementById('resultEditToggle');
      document.getElementById('tabBulk').click();
      const bulkHidden = btn.hidden;
      document.getElementById('tabStep').click();
      const stepHidden = btn.hidden;
      return { bulkHidden, stepHidden };
    });
    record(
      'the retouch edit icon is hidden outside the Result tab',
      retouchTabs.bulkHidden === true && retouchTabs.stepHidden === false,
      `bulk ${retouchTabs.bulkHidden} step ${retouchTabs.stepHidden}`,
    );

    // Theme: the toggle pins an explicit mode and flips the page surface. The
    // colour change is transitioned, so read it after the swap settles.
    const themeBefore = await page.evaluate(() => ({
      attr: document.documentElement.getAttribute('data-theme'),
      bg: getComputedStyle(document.body).backgroundColor,
    }));
    await page.evaluate(() => document.getElementById('themeToggle').click());
    await sleep(500);
    const themeAfter = await page.evaluate(() => ({
      attr: document.documentElement.getAttribute('data-theme'),
      bg: getComputedStyle(document.body).backgroundColor,
    }));
    record(
      'the theme toggle switches to an explicit mode and repaints the page',
      (themeAfter.attr === 'light' || themeAfter.attr === 'dark') && themeBefore.bg !== themeAfter.bg,
      `${themeAfter.attr} (${themeBefore.bg} → ${themeAfter.bg})`,
    );

    // The header brand swaps to the light-ink lockup in dark mode (and back),
    // then collapses to the figure-only mark on scroll in either theme. The
    // crossfade is transitioned, so read each state after it settles.
    const brandState = () =>
      page.evaluate(() => {
        const op = (id) => Number(getComputedStyle(document.getElementById(id)).opacity);
        return { lockup: op('brandLockup'), light: op('brandLockupLight'), mark: op('brandMark') };
      });
    const setTheme = (t) =>
      page.evaluate((theme) => {
        if (theme === null) document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', theme);
      }, t);
    await setTheme('light');
    await sleep(500);
    const brandLight = await brandState();
    await setTheme('dark');
    await sleep(500);
    const brandDark = await brandState();
    await page.evaluate(() => window.scrollTo(0, 400));
    await sleep(500);
    const brandDarkScrolled = await brandState();
    await page.evaluate(() => window.scrollTo(0, 0));
    await setTheme(null);
    record(
      'the brand swaps to the light-ink lockup in dark mode and the mark on scroll',
      brandLight.lockup === 1 &&
        brandLight.light === 0 &&
        brandDark.lockup === 0 &&
        brandDark.light === 1 &&
        brandDarkScrolled.mark === 1 &&
        brandDarkScrolled.light === 0,
      `light ${brandLight.lockup}/${brandLight.light} → dark ${brandDark.lockup}/${brandDark.light} → scrolled mark ${brandDarkScrolled.mark}`,
    );

    // The header is direction-aware: scrolling DOWN collapses it (shorter bar,
    // brand crossfades to the mark, Studio label drops), scrolling UP expands it,
    // and the top of the page is always full height. Scroll with a Node-side
    // settle between steps (headless rAF alone is racy).
    const headerAt = async (y) => {
      await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
      await sleep(350);
      return page.evaluate(() => ({
        collapsed: document.getElementById('siteHeader').dataset.collapsed,
        y: Math.round(window.scrollY),
        innerH: Math.round(document.querySelector('.siteHeaderInner').getBoundingClientRect().height),
        labelW: Math.round(document.querySelector('.studioLaunchText').getBoundingClientRect().width),
      }));
    };
    const hTop = await headerAt(0); // rest
    const hDown = await headerAt(400); // scroll down → collapse
    const hUp = await headerAt(200); // scroll up → expand
    const hTopAgain = await headerAt(0); // back at the top → expand
    // A viewport resize (e.g. the mobile system bar or devtools) must not leave
    // the header stuck collapsed at the top of the page.
    await page.setViewport({ width: 1280, height: 720 });
    await sleep(350);
    const hAfterResize = await page.evaluate(() => ({
      collapsed: document.getElementById('siteHeader').dataset.collapsed,
      innerH: Math.round(document.querySelector('.siteHeaderInner').getBoundingClientRect().height),
    }));
    await page.setViewport({ width: 1280, height: 900 });
    await sleep(200);
    await page.evaluate(() => window.scrollTo(0, 0));
    const markWidth = await page.evaluate(() => {
      const mark = document.getElementById('brandMark');
      const lockup = document.getElementById('brandLockup');
      return {
        markW: mark.getBoundingClientRect().width,
        h: lockup.getBoundingClientRect().height,
      };
    });
    record(
      'the header collapses on scroll down and expands on scroll up',
      hTop.collapsed === 'false' &&
        hDown.collapsed === 'true' &&
        hUp.collapsed === 'false' &&
        hTopAgain.collapsed === 'false',
      `top:${hTop.collapsed} down400:${hDown.collapsed} up200:${hUp.collapsed} top:${hTopAgain.collapsed}`,
    );
    record(
      'the collapsed header is shorter and drops the Studio label',
      hDown.innerH < hTop.innerH && hDown.labelW === 0 && hTop.labelW > 0,
      `height ${hTop.innerH}→${hDown.innerH}px, label ${hTop.labelW}→${hDown.labelW}px`,
    );
    record(
      'the header is never stuck collapsed at the top after a resize',
      hAfterResize.collapsed === 'false' && hAfterResize.innerH === hTop.innerH,
      `collapsed:${hAfterResize.collapsed} height:${hAfterResize.innerH}px`,
    );
    record(
      'the collapsed mark is ~25% narrower than the lockup figure',
      markWidth.markW > 0 && markWidth.markW < markWidth.h * 0.6,
      `mark ${markWidth.markW.toFixed(1)}px vs brand height ${markWidth.h.toFixed(1)}px`,
    );

    // The console lives in the studio workspace as a flat terminal: one
    // monospace line per event, newest at the bottom, with a prompt glyph. There
    // are no threads, chevrons, or collapsible groups, and no pipeline-dot row.
    // The Zero-Upload statement is hidden behind a clickable icon.
    // The console starts hidden now; show it so its layout can be measured.
    const consoleStartsHidden = await page.evaluate(
      () => document.querySelector('.studioGrid')?.dataset.console === 'hidden',
    );
    record('the console is hidden by default', consoleStartsHidden === true, String(consoleStartsHidden));
    await page.evaluate(() => document.getElementById('consoleToggle').click());

    const panelState = await page.evaluate(() => {
      const consoleEl = document.querySelector('.consoleCard');
      const inStudio = !!document.getElementById('studio')?.contains(consoleEl);
      const label = document.getElementById('processingLabel')?.textContent ?? '';
      const output = document.getElementById('consoleOutput');
      const lines = Array.from(output?.querySelectorAll('.consoleLine') ?? []);
      const lineText = lines.map((l) => l.querySelector('.consoleLineText')?.textContent ?? '');
      const promptCount = lines.filter((l) => l.querySelector('.consoleLinePrompt')?.textContent).length;
      const privacyHiddenBefore = document.getElementById('privacyStatement')?.hidden ?? false;
      const privacyBtn = document.getElementById('privacyToggle');
      const head = privacyBtn?.closest('.consoleHead');
      const privacyInHead = !!head && /console/i.test(head.textContent ?? '');
      const privacyBorderless = getComputedStyle(privacyBtn).borderTopWidth === '0px';
      const privacyNoLabel = !privacyBtn?.parentElement?.querySelector('.privacyToggleLabel');
      privacyBtn?.click();
      const privacyHiddenAfter = document.getElementById('privacyStatement')?.hidden ?? true;
      // The old "vertical" components and the categorised log are gone.
      const noStepList = !document.getElementById('stepList');
      const noLogDots = !document.getElementById('logDots');
      const noLogGroups = !document.getElementById('logGroups');
      const noThreads = document.querySelectorAll('.consoleGroup, .consoleChevron, .logGroup').length === 0;
      // The live status is the terminal's last line: a prompt-prefixed row pinned
      // to the foot of the console card, below the scroll area (so it is always
      // visible), and there is no duplicate stage band anywhere.
      const statusLine = document.getElementById('consoleStatusLine');
      const statusInCard = statusLine?.closest('.consoleCard') === consoleEl;
      const statusHasPrompt = !!statusLine?.querySelector('.consoleLinePrompt')?.textContent;
      const statusTextEl = document.getElementById('processingLabel');
      const statusIsTextOfLine = !!statusLine?.contains(statusTextEl);
      const scrollBox = document.querySelector('.consoleScroll')?.getBoundingClientRect();
      const statusBox = statusLine?.getBoundingClientRect();
      const statusBelowScroll = !!scrollBox && !!statusBox && statusBox.top >= scrollBox.bottom - 1;
      const noStageBand = !document.getElementById('stage') && !document.querySelector('.consoleStage');
      // The console card's background spans the full studio width (no inset).
      const studioW = document.getElementById('studio')?.getBoundingClientRect().width ?? 0;
      const cardBox = consoleEl?.getBoundingClientRect() ?? { left: 0, right: 0, width: 0 };
      const fullWidth = cardBox.width >= studioW - 1;
      // Every print pins the terminal to its newest line.
      const scroll = document.querySelector('.consoleScroll');
      const atBottom = scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 2 : false;
      return {
        inStudio,
        label,
        lineCount: lines.length,
        lineText,
        promptCount,
        privacyHiddenBefore,
        privacyHiddenAfter,
        privacyInHead,
        privacyBorderless,
        privacyNoLabel,
        noStepList,
        noLogDots,
        noLogGroups,
        noThreads,
        statusInCard,
        statusHasPrompt,
        statusIsTextOfLine,
        statusBelowScroll,
        noStageBand,
        fullWidth,
        cardLeft: Math.round(cardBox.left),
        studioW: Math.round(studioW),
        atBottom,
      };
    });
    record(
      'the console sits in the studio with its live status label',
      panelState.inStudio === true && /done/i.test(panelState.label),
      `inStudio ${panelState.inStudio} label "${panelState.label}"`,
    );
    record(
      'the console removed the pipeline-dot row and the log-chevron row',
      panelState.noStepList === true && panelState.noLogDots === true,
      `noStepList ${panelState.noStepList} noLogDots ${panelState.noLogDots}`,
    );
    record(
      'the console prints flat terminal lines, not collapsible threads',
      panelState.lineCount > 0 &&
        panelState.noLogGroups === true &&
        panelState.noThreads === true &&
        panelState.promptCount === panelState.lineCount,
      `lines ${panelState.lineCount} noLogGroups ${panelState.noLogGroups} noThreads ${panelState.noThreads} prompts ${panelState.promptCount}`,
    );
    record(
      'the console output is scrolled to its newest line',
      panelState.atBottom === true,
      `atBottom ${panelState.atBottom}`,
    );
    record(
      'the live status is the terminal last line, pinned below the scroll area',
      panelState.statusInCard === true &&
        panelState.statusHasPrompt === true &&
        panelState.statusIsTextOfLine === true &&
        panelState.statusBelowScroll === true &&
        panelState.noStageBand === true,
      `inCard ${panelState.statusInCard} prompt ${panelState.statusHasPrompt} text ${panelState.statusIsTextOfLine} belowScroll ${panelState.statusBelowScroll} noStageBand ${panelState.noStageBand}`,
    );
    record(
      'the console background spans the full studio width',
      panelState.fullWidth === true,
      `card left ${panelState.cardLeft} vs studio width ${panelState.studioW}`,
    );
    record(
      'the privacy statement is hidden until its icon is clicked',
      panelState.privacyHiddenBefore === true && panelState.privacyHiddenAfter === false,
      `${panelState.privacyHiddenBefore} → ${panelState.privacyHiddenAfter}`,
    );
    record(
      'the privacy icon sits borderless beside the Console heading with no label',
      panelState.privacyInHead === true &&
        panelState.privacyBorderless === true &&
        panelState.privacyNoLabel === true,
      `inHead ${panelState.privacyInHead} borderless ${panelState.privacyBorderless} noLabel ${panelState.privacyNoLabel}`,
    );
    // Copy report: an always-visible button in the console header whose report
    // carries real GPU/mask facts and no image or personal data. It must be
    // visible WITHOUT opening any disclosure (a regression once buried it in a
    // collapsed <details>, so the button existed in the DOM but a user could not
    // see or click it).
    const reportState = await page.evaluate(() => {
      const btn = document.getElementById('copyReport');
      const inConsoleHead = !!btn?.closest('.consoleHead');
      const insideClosedDetails = !!btn?.closest('details:not([open])');
      const rect = btn?.getBoundingClientRect();
      const style = btn ? getComputedStyle(btn) : null;
      const visible =
        !!rect &&
        rect.width > 0 &&
        rect.height > 0 &&
        style?.visibility !== 'hidden' &&
        style?.display !== 'none' &&
        style?.opacity !== '0';
      const btnLabel = (btn?.textContent ?? '').trim();
      const report = window.diagnosticReport?.() ?? null;
      const text = window.deviceReport?.() ?? '';
      return {
        hasBtn: !!btn,
        inConsoleHead,
        insideClosedDetails,
        visible,
        btnLabel,
        hasReport: !!report,
        schema: report?.schemaVersion ?? null,
        hasRawMaskBlock: /RAW MASK STATISTICS/.test(text),
        hasMean: /Mean:/.test(text),
        hasGpuSection: /GPU/.test(text),
        leaksImage: /data:image|base64,/.test(text),
      };
    });
    record(
      'the Copy report button is visible in the console header without opening a disclosure',
      reportState.hasBtn === true &&
        reportState.inConsoleHead === true &&
        reportState.insideClosedDetails === false &&
        reportState.visible === true &&
        reportState.btnLabel === 'Copy report',
      `btn ${reportState.hasBtn} inConsoleHead ${reportState.inConsoleHead} insideClosedDetails ${reportState.insideClosedDetails} visible ${reportState.visible} label "${reportState.btnLabel}"`,
    );
    record(
      'the Copy report button copies a report with real GPU + raw-mask facts',
      reportState.hasReport === true &&
        reportState.hasRawMaskBlock === true &&
        reportState.hasMean === true &&
        reportState.hasGpuSection === true,
      `report ${reportState.hasReport} maskBlock ${reportState.hasRawMaskBlock} mean ${reportState.hasMean} gpu ${reportState.hasGpuSection}`,
    );
    record(
      'the diagnostic report carries no image data',
      reportState.leaksImage === false,
      `leaksImage ${reportState.leaksImage}`,
    );

    // The Processing-tab status text must stay light in both themes: it sits on
    // the always-dark wallpaper, so a theme token that inverts would vanish.
    const procContrast = await page.evaluate(() => {
      const text = document.querySelector('.procStatusText');
      const read = (theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        const c = getComputedStyle(text).color;
        const m = c.match(/\d+/g).map(Number);
        // Relative luminance (sRGB, rough) — must be a light ink (>0.5).
        const lum = (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
        return lum;
      };
      const light = read('light');
      const dark = read('dark');
      return { light, dark };
    });
    record(
      'the processing status text stays light on the dark wallpaper in both themes',
      procContrast.light > 0.5 && procContrast.dark > 0.5,
      `light ${procContrast.light.toFixed(2)} dark ${procContrast.dark.toFixed(2)}`,
    );


    // Console show/hide + drag-resize: the toggle button and the in-card close
    // both hide it; the resize handle grows it to the 50% cap and returns to the
    // 20% floor, which is also its default resting height.
    const consoleControls = await page.evaluate(async () => {
      const grid = document.querySelector('.studioGrid');
      const col = document.getElementById('studioConsoleCol');
      const toggle = document.getElementById('consoleToggle');
      const closeBtn = document.getElementById('consoleClose');
      const handle = document.getElementById('consoleResize');
      const gridH = grid.getBoundingClientRect().height;
      const openH = col.getBoundingClientRect().height;
      const cap = gridH * 0.5;
      const floor = gridH * 0.2;
      // Drag the handle up hard: the console must stop at the 50% cap.
      const r = handle.getBoundingClientRect();
      const y0 = r.top + r.height / 2;
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientY: y0, pointerId: 1 }));
      handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: y0 - 900, pointerId: 1 }));
      const grownH = col.getBoundingClientRect().height;
      // Drag down hard: it returns to the 20% floor (its default height).
      handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: y0 + 900, pointerId: 1 }));
      const shrunkH = col.getBoundingClientRect().height;
      handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientY: y0 + 900, pointerId: 1 }));
      closeBtn.click();
      const hiddenByClose = grid.dataset.console === 'hidden';
      const togglePressedWhenHidden = toggle.getAttribute('aria-pressed');
      toggle.click();
      const shownAgain = grid.dataset.console !== 'hidden';
      const togglePressedWhenShown = toggle.getAttribute('aria-pressed');
      return { gridH, openH, cap, floor, grownH, shrunkH, hiddenByClose, shownAgain, togglePressedWhenHidden, togglePressedWhenShown };
    });
    record(
      'the console has a show/hide toggle and an in-card close button',
      consoleControls.hiddenByClose === true &&
        consoleControls.shownAgain === true &&
        consoleControls.togglePressedWhenHidden === 'false' &&
        consoleControls.togglePressedWhenShown === 'true',
      `hidden ${consoleControls.hiddenByClose} → shown ${consoleControls.shownAgain}`,
    );
    record(
      'the console top edge resizes between 20% and 50%',
      consoleControls.grownH <= consoleControls.cap + 1 &&
        consoleControls.grownH > consoleControls.openH + 1 &&
        consoleControls.shrunkH < consoleControls.grownH &&
        consoleControls.shrunkH <= consoleControls.openH + 1 &&
        consoleControls.shrunkH >= consoleControls.floor - 1,
      `open ${Math.round(consoleControls.openH)} cap ${Math.round(consoleControls.cap)} floor ${Math.round(consoleControls.floor)} grown ${Math.round(consoleControls.grownH)} shrunk ${Math.round(consoleControls.shrunkH)}`,
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
    await chooseFile(page, pngPath);
    // Choosing the photo auto-starts the run; no button to click.
    await page.waitForFunction(() => document.querySelector('#outputBox img') !== null, { timeout: 600000 });
    const src = await page.evaluate(() => document.querySelector('#outputBox img')?.getAttribute('src') ?? '');
    record('PNG upload → transparent PNG rendered', src.startsWith('data:image/png'));
    await page.close();
  }

  // ——— Scenario 2b: the step tab swaps the drop zone for the preview ———
  // The drop zone is the default; once a photo is chosen it is replaced by the
  // preview (never both at once) and the step tab advances to the run.
  {
    const page = await browser.newPage();
    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    await openStudio(page);
    await page.waitForFunction('window.smokeModelReady === true', { timeout: 600000 });

    const initial = await page.evaluate(() => {
      const visible = (el) => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
      return {
        dropZone: visible(document.getElementById('dropZone')),
        preview: visible(document.getElementById('inputPreview')),
      };
    });
    record('the step tab shows only the drop-zone placeholder before a photo is chosen', initial.dropZone && !initial.preview);

    await chooseFile(page, resolve(ROOT, 'test-images/glass-wine.jpg'));
    await page.waitForFunction(
      () => document.getElementById('stepInput')?.classList.contains('has-preview') === true,
      { timeout: 30000 },
    );
    // Choosing a photo auto-starts the run, so the step tab advances to the
    // Processing view; the preview lives in the now-hidden photo view.
    await page.waitForFunction(
      () => {
        const visible = (id) => {
          const el = document.getElementById(id);
          return !!el && !el.hidden && el.getBoundingClientRect().height > 0;
        };
        return visible('stepProcessing') || visible('stepResult');
      },
      { timeout: 600000 },
    );
    const afterSelect = await page.evaluate(() => {
      const stepInput = document.getElementById('stepInput');
      const preview = document.getElementById('inputPreview');
      return {
        hasPreviewClass: stepInput?.classList.contains('has-preview') ?? false,
        previewSrc: preview?.querySelector('img')?.getAttribute('src') ?? '',
        photoViewHidden: stepInput?.hidden ?? false,
        dropZoneInPhotoView: !!stepInput?.contains(document.getElementById('dropZone')),
      };
    });
    record(
      'the step tab replaces the drop zone with the preview and advances to the run',
      afterSelect.hasPreviewClass &&
        afterSelect.previewSrc.length > 0 &&
        afterSelect.photoViewHidden &&
        afterSelect.dropZoneInPhotoView,
    );

    // The Result step offers "Choose another photo" as the picker target.
    await page.waitForFunction(() => document.getElementById('stepResult') && !document.getElementById('stepResult').hidden, {
      timeout: 600000,
    });
    const [chooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 10000 }).catch(() => null),
      page.click('#newPhotoBtn'),
    ]);
    if (chooser) await chooser.cancel();
    record('the Result step offers "Choose another photo"', !!chooser);
    await page.close();
  }

  // ——— Scenario 3: invalid MIME is rejected before decode ———
  {
    const page = await browser.newPage();
    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    await openStudio(page);
    await page.waitForFunction('window.smokeModelReady === true', { timeout: 600000 });
    await chooseFile(page, resolve(ROOT, 'smoke-results/phase4-browser/not-an-image.txt'));
    await page.waitForFunction(
      () => /Unsupported file type/.test(document.getElementById('processingLabel')?.textContent ?? ''),
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
    await chooseFile(page, resolve(ROOT, 'smoke-results/phase4-browser/corrupt.png'));
    await page.waitForFunction(
      () => /Failed to decode|ERROR/.test(document.getElementById('processingLabel')?.textContent ?? ''),
      { timeout: 10000 },
    );
    const hasOutput = await page.evaluate(() => document.querySelector('#outputBox img') !== null);
    record('corrupt image shows a decode error and no output', hasOutput === false);
    // The failure also surfaces as a floating error notification (top-right, red).
    const toast = await page.evaluate(() => {
      const t = document.querySelector('#toastHost .toast.error');
      if (!t) return null;
      const hostEl = document.getElementById('toastHost');
      const host = hostEl.getBoundingClientRect();
      const r = t.getBoundingClientRect();
      const body = getComputedStyle(t.querySelector('.toastBody')).color;
      const stage = document.getElementById('processingLabel');
      const hostStyle = getComputedStyle(hostEl);
      return {
        onRight: Math.abs(window.innerWidth - host.right) < 40,
        nearTop: host.top < 60,
        floatAbove: r.width > 0,
        redText: /rgb\(\s*127|\s*252, 165, 165/.test(body),
        stageError: stage?.classList.contains('is-error') === true,
        fixed: hostStyle.position === 'fixed',
        scrolls: hostStyle.overflowY === 'auto',
        bounded: hostStyle.maxHeight !== 'none',
      };
    });
    record(
      'errors show a red floating notification at the top-right',
      !!toast && toast.onRight && toast.nearTop && toast.floatAbove && toast.redText,
      toast ? `right:${toast.onRight} top:${toast.nearTop} red:${toast.redText}` : 'no error toast',
    );
    record(
      'the notification stack is fixed and scrolls instead of overflowing the screen',
      !!toast && toast.fixed && toast.scrolls && toast.bounded,
      toast ? `fixed:${toast.fixed} scrolls:${toast.scrolls} bounded:${toast.bounded}` : 'no toast',
    );
    record('the stage line turns to the error colour theme', !!toast && toast.stageError);
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
        () => /Error:/.test(document.getElementById('processingLabel')?.textContent ?? ''),
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
        () => /manifest/i.test(document.getElementById('processingLabel')?.textContent ?? ''),
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

    // On a busy runner the tab can still be backgrounded and a programmatic
    // focus silently ignored. Re-assert activation, then give the focus a
    // moment to land before retrying.
    let focused = false;
    for (let attempt = 0; attempt < 5 && !focused; attempt += 1) {
      await page.bringToFront();
      await page.focus('#dropZone');
      await sleep(200);
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

    // Choosing a photo is not consent to spend mobile data: the run must wait
    // for the confirmation instead of starting the download on its own.
    await chooseFile(page, resolve(ROOT, 'test-images/glass-wine.jpg'));
    await sleep(2000);
    const startedAfterPhoto = await page.evaluate(() => window.smokeModelReady === true);
    const promptStillShown = await page.evaluate(
      () => (document.getElementById('netWarn')?.hidden ?? true) === false,
    );
    record(
      'choosing a photo on mobile data waits for the download confirmation',
      startedAfterPhoto === false && promptStillShown === true,
      `ready:${startedAfterPhoto} prompt:${promptStillShown}`,
    );

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
    // The prompt is a modal: if the cache check missed, it stays up and the
    // model never becomes ready. So wait for readiness, then assert the prompt
    // is not showing — a brief flicker on a loaded runner must not fail this.
    const ready = await page
      .waitForFunction('window.smokeModelReady === true', { timeout: 600000 })
      .then(() => true)
      .catch(() => false);
    const promptShown = await page.evaluate(
      () => (document.getElementById('netWarn')?.hidden ?? true) === false,
    );
    record(
      'a cached model loads over a metered link without prompting',
      promptShown === false && ready === true,
    );
    await page.close();
  }

  // ——— Scenario 9: the periodic fetch loop downloads once Wi-Fi appears ———
  // Boots on a metered link (the prompt shows, nothing downloads), then flips the
  // stubbed connection to Wi-Fi. The page's background timer must start the
  // download on its own — no photo chosen, no button pressed.
  {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      // Mutable so the test can change the link mid-session.
      window.__conn = { type: 'cellular' };
      Object.defineProperty(navigator, 'connection', {
        configurable: true,
        get: () => window.__conn,
      });
      Object.defineProperty(navigator, 'userAgentData', {
        configurable: true,
        get: () => ({ mobile: false }),
      });
      Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => false });
    });
    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    await openStudio(page);
    const cdp = await page.createCDPSession();
    await cdp.send('Storage.clearDataForOrigin', {
      origin: pageUrl.origin,
      storageTypes: 'cache_storage',
    });
    await page.reload({ waitUntil: 'load', timeout: 120000 });
    await openStudio(page);

    const promptShown = await page
      .waitForFunction(
        () => (document.getElementById('netWarn')?.hidden ?? true) === false,
        { timeout: 30000 },
      )
      .then(() => true)
      .catch(() => false);
    await sleep(2000);
    const startedWhileMetered = await page.evaluate(() => window.smokeModelReady === true);

    // Switch to Wi-Fi; the timer (2 s) must start the download without any input.
    await page.evaluate(() => {
      window.__conn = { type: 'wifi' };
    });
    const startedAfterWifi = await page
      .waitForFunction('window.smokeModelReady === true', { timeout: 90000 })
      .then(() => true)
      .catch(() => false);
    record(
      'a metered visit waits for the prompt, then the loop downloads once Wi-Fi appears',
      promptShown === true && startedWhileMetered === false && startedAfterWifi === true,
    );
    await page.close();
  }

  // ——— Scenario 10: a Wi-Fi download is paused the moment the link goes metered ———
  // Boots on Wi-Fi with a cold cache so the model download begins, stalls the
  // model request (CDP Fetch on the service-worker target, which is what actually
  // fetches the bytes) so the transfer is genuinely mid-flight, then flips the
  // stubbed connection to cellular. The guard must stop the download and raise a
  // notice telling the user to take action; confirming resumes it.
  {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      // Mutable connection with a real "change" event, so the page's live guard
      // fires exactly as it would when a phone drops off Wi-Fi.
      const listeners = [];
      window.__conn = {
        type: 'wifi',
        addEventListener: (type, fn) => {
          if (type === 'change') listeners.push(fn);
        },
      };
      window.__fireConn = () => listeners.forEach((fn) => fn());
      Object.defineProperty(navigator, 'connection', {
        configurable: true,
        get: () => window.__conn,
      });
      Object.defineProperty(navigator, 'userAgentData', {
        configurable: true,
        get: () => ({ mobile: false }),
      });
      Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => false });
    });

    // Attach the Fetch domain to the service-worker target (created after load)
    // and hold the first model request open, so the download stalls mid-flight.
    let holdNext = true;
    let heldRequestId = null;
    let swClient = null;
    const attached = new Set();
    const scanAttach = async () => {
      for (const t of browser.targets()) {
        if (t.type() !== 'service_worker') continue;
        if (attached.has(t.url())) continue;
        attached.add(t.url());
        try {
          const c = await t.createCDPSession();
          await c.send('Fetch.enable', {
            patterns: [{ urlPattern: '*onnx*', requestStage: 'Request' }],
          });
          c.on('Fetch.requestPaused', (e) => {
            if (/onnx/.test(e.request.url) && holdNext) {
              holdNext = false;
              heldRequestId = e.requestId;
              swClient = c;
              return; // hold it open: the download is now mid-flight
            }
            c.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
          });
        } catch {
          /* target went away */
        }
      }
    };
    const scanTimer = setInterval(() => void scanAttach(), 100);
    await scanAttach();

    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    await openStudio(page);
    const cdp = await page.createCDPSession();
    await cdp.send('Storage.clearDataForOrigin', {
      origin: pageUrl.origin,
      storageTypes: 'cache_storage',
    });
    await page.reload({ waitUntil: 'load', timeout: 120000 });
    await openStudio(page);

    // The download must reach the wire (the held request) before we flip links.
    const downloadStarted = await page
      .waitForFunction(
        () => /Downloading model|Loading model/i.test(document.getElementById('processingLabel')?.textContent ?? ''),
        { timeout: 60000 },
      )
      .then(() => true)
      .catch(() => false);
    // Wait until the SW request is actually held (download mid-flight).
    const held = await (async () => {
      for (let i = 0; i < 100; i += 1) {
        if (heldRequestId) return true;
        await sleep(100);
      }
      return false;
    })();
    record(
      'a Wi-Fi model download reaches the wire before the link changes',
      downloadStarted && held,
      `started ${downloadStarted} held ${held}`,
    );

    // Flip to cellular and fire the change event.
    await page.evaluate(() => {
      window.__conn.type = 'cellular';
      window.__fireConn();
    });

    const paused = await page
      .waitForFunction('window.smokeModelPaused === true', { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    const warnShown = await page.evaluate(
      () => (document.getElementById('netWarn')?.hidden ?? true) === false,
    );
    const warnText = await page.evaluate(
      () => document.getElementById('netWarnText')?.textContent ?? '',
    );
    record(
      'switching to mobile data stops the download and warns the user',
      paused && warnShown && /mobile data/i.test(warnText) && /paused/i.test(warnText),
      `paused ${paused} warn ${warnShown} "${warnText.replace(/\s+/g, ' ').slice(0, 80)}"`,
    );

    const stillNotReady = await page.evaluate(() => window.smokeModelReady === true);
    record('the model is not ready while the download is paused', stillNotReady === false);

    // Dismissing the notice must not silently restart the transfer on mobile
    // data: the guard holds until the user confirms (or Wi-Fi returns).
    await page.click('#netWarnDismiss');
    await sleep(2000);
    const readyAfterDismiss = await page.evaluate(() => window.smokeModelReady === true);
    record(
      'dismissing the pause notice does not resume the download on mobile data',
      readyAfterDismiss === false,
    );

    // Release the held request so the worker can shut down cleanly.
    if (swClient && heldRequestId) {
      await swClient
        .send('Fetch.failRequest', { requestId: heldRequestId, errorReason: 'Aborted' })
        .catch(() => {});
    }
    clearInterval(scanTimer);
    await page.close();
  }

  // ——— Scenario 11: progressive refinement (Stage 1 preview → refined final) ———
  // The 512px model's soft mask is refined on the already-decoded original by an
  // image-guided filter. The export must keep the original dimensions, the
  // refinement must report its stage timings, and ?refine=off must reproduce the
  // unrefined Stage-1 result exactly (the A/B baseline).
  {
    const page = await browser.newPage();
    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    await openStudio(page);
    await page.waitForFunction('window.smokeModelReady === true', { timeout: 600000 });
    await chooseFile(page, resolve(ROOT, 'test-images/glass-wine.jpg'));
    await page.waitForFunction(() => document.querySelector('#outputBox img') !== null, { timeout: 600000 });
    // Wait for the refined final result to replace the interim preview.
    await page.evaluate(() => window.waitForJobSettled());
    const refined = await page.evaluate(async () => {
      const dl = document.getElementById('downloadImage');
      const im = new Image();
      im.src = dl.href;
      await im.decode();
      const notice = document.getElementById('refineNotice');
      return {
        download: dl.getAttribute('download'),
        w: im.naturalWidth,
        h: im.naturalHeight,
        stages: window.smokeRefineStages ?? null,
        noticeHidden: notice ? notice.hidden : true,
      };
    });
    record(
      'refined export keeps the original dimensions (960x1280)',
      refined.w === 960 && refined.h === 1280,
      refined.download,
    );
    record(
      'refinement reports its stage timings (upscale/filter/cleanup)',
      refined.stages !== null &&
        typeof refined.stages.upscaleMs === 'number' &&
        typeof refined.stages.refineMs === 'number' &&
        typeof refined.stages.cleanupMs === 'number',
      refined.stages ? `total ${Math.round(refined.stages.totalMs)}ms` : 'null',
    );
    record('the refining banner is hidden once the final result is ready', refined.noticeHidden === true);
    // The output-alpha classifier runs on the final composite: a clean cut-out
    // must report its alpha and must NOT be mislabelled as a washed-out ghost or
    // as "fully transparent".
    const alphaReport = await page.evaluate(() => {
      const text = document.getElementById('consoleOutput')?.textContent ?? '';
      return {
        hasOutputAlpha: /Output alpha: min \d+/.test(text),
        ghostWarning: /WARNING: .*ghost/i.test(text),
        fullyTransparent: /WARNING: .*fully transparent/i.test(text),
      };
    });
    record(
      'the console reports the output alpha and does not cry ghost on a clean cut-out',
      alphaReport.hasOutputAlpha && !alphaReport.ghostWarning && !alphaReport.fullyTransparent,
      `outputAlpha=${alphaReport.hasOutputAlpha}`,
    );
    await page.close();

    // A/B baseline: ?refine=off bypasses Stages 3-4 (no stage timings, same size).
    const base = await browser.newPage();
    const offUrl = new URL(pageUrl.toString());
    offUrl.searchParams.set('refine', 'off');
    await base.goto(offUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    await openStudio(base);
    await base.waitForFunction('window.smokeModelReady === true', { timeout: 600000 });
    await chooseFile(base, resolve(ROOT, 'test-images/glass-wine.jpg'));
    await base.waitForFunction(() => document.querySelector('#outputBox img') !== null, { timeout: 600000 });
    await base.evaluate(() => window.waitForJobSettled());
    const off = await base.evaluate(async () => {
      const dl = document.getElementById('downloadImage');
      const im = new Image();
      im.src = dl.href;
      await im.decode();
      return { w: im.naturalWidth, h: im.naturalHeight, stages: window.smokeRefineStages ?? null };
    });
    record(
      '?refine=off bypasses refinement (no stage timings) and still exports at full size',
      off.stages === null && off.w === 960 && off.h === 1280,
      `stages=${off.stages} ${off.w}x${off.h}`,
    );
    await base.close();
  }

  // ——— Scenario: home page section order ———
  // The Before & After showcase sits after the "What SmartCutAI Supports"
  // reference section (a plain DOM-order check; no studio needed).
  {
    const page = await browser.newPage();
    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    const order = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('section[id]')].map((s) => s.id);
      return { support: ids.indexOf('support'), showcase: ids.indexOf('showcase'), how: ids.indexOf('how') };
    });
    record(
      'the Before & After showcase follows the What-Supported section',
      order.support !== -1 && order.showcase !== -1 && order.showcase > order.support && order.how < order.support,
      `how ${order.how} support ${order.support} showcase ${order.showcase}`,
    );
    await page.close();
  }

  // ——— Scenario: studio engine sidebar (settings) ———
  // The gear popover is gone; the engine controls live in a left sidebar on the
  // Step tab. It collapses via a chevron and drag-resizes up to 50% of the
  // workspace; the Bulk and Library tabs cannot open it or the console.
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    await openStudio(page);
    await page.waitForFunction('window.smokeModelReady === true', { timeout: 600000 });

    const markup = await page.evaluate(async () => {
      const sidebar = document.getElementById('settingsSidebar');
      const toggle = document.getElementById('sidebarToggle');
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const collapsedDisplay = sidebar ? getComputedStyle(sidebar).display : '';
      const collapsedVisible = !!sidebar && sidebar.offsetParent !== null;
      // The sidebar starts hidden. Expand it to check the shared left-column
      // geometry, then collapse it again.
      toggle?.click();
      await wait(320);
      const sidebarLeftOfBody = (() => {
        const sb = sidebar?.getBoundingClientRect();
        const body = document.querySelector('.studioTabBody')?.getBoundingClientRect();
        return !!sb && !!body && sb.right <= body.left + 1;
      })();
      const expandedVisible = !!sidebar && sidebar.offsetParent !== null && sidebar.getBoundingClientRect().width > 0;
      toggle?.click();
      await wait(320);
      return {
        hasSidebar: !!document.getElementById('settingsSidebar'),
        hasToggle: !!document.getElementById('sidebarToggle'),
        hasCollapse: !!document.getElementById('sidebarCollapse'),
        hasResize: !!document.getElementById('sidebarResize'),
        gearGone: !document.getElementById('settingsGearBtn') && !document.getElementById('advancedMenu'),
        photoTab: document.getElementById('tabStep')?.textContent?.trim(),
        barToggleHiddenOnPhoto: document.getElementById('sidebarToggle')?.hidden,
        barToggleDisabledOnPhoto: document.getElementById('sidebarToggle')?.disabled,
        // The sidebar is a sibling of the tab body (the panel area) — not
        // nested inside the Result panel as it once was.
        sidebarLeftOfBody,
        expandedVisible,
        collapsedDisplay,
        collapsedVisible,
        defaultCollapsed: document.getElementById('settingsSidebar')?.dataset.collapsed,
        experimentalTag: document.querySelector('#settingsSidebar .sidebarBadge')?.textContent?.trim(),
      };
    });
    record('the step tab starts as "Photo"', markup.photoTab === 'Photo', markup.photoTab);
    record(
      'the engine controls are a shared left sidebar (gear popover removed)',
      markup.hasSidebar && markup.hasToggle && markup.hasCollapse && markup.hasResize && markup.gearGone && markup.sidebarLeftOfBody,
      `sidebar ${markup.hasSidebar} toggle ${markup.hasToggle} collapse ${markup.hasCollapse} resize ${markup.hasResize} gearGone ${markup.gearGone} leftOfBody ${markup.sidebarLeftOfBody}`,
    );
    record(
      'the settings sidebar is hidden when collapsed and expands on the Step tab',
      markup.barToggleHiddenOnPhoto === false &&
        markup.barToggleDisabledOnPhoto === false &&
        markup.collapsedDisplay === 'none' &&
        markup.collapsedVisible === false &&
        markup.expandedVisible === true,
      `toggle hidden ${markup.barToggleHiddenOnPhoto} disabled ${markup.barToggleDisabledOnPhoto} collapsed display "${markup.collapsedDisplay}" visible ${markup.collapsedVisible} expanded visible ${markup.expandedVisible}`,
    );
    record(
      'the engine controls start collapsed and carry an experimental tag',
      markup.defaultCollapsed === 'true' && markup.experimentalTag === 'Experimental',
      `collapsed: ${markup.defaultCollapsed} tag: ${markup.experimentalTag}`,
    );

    // The top-bar show/hide button expands the sidebar from its collapsed
    // default and collapses it again, staying in sync.
    const barToggle = await page.evaluate(async () => {
      const sb = document.getElementById('settingsSidebar');
      const toggle = document.getElementById('sidebarToggle');
      const collapsedW = sb.getBoundingClientRect().width;
      toggle.click();
      await new Promise((r) => setTimeout(r, 320));
      const expandedW = sb.getBoundingClientRect().width;
      const pressedExpanded = toggle.getAttribute('aria-pressed');
      toggle.click();
      await new Promise((r) => setTimeout(r, 320));
      return { collapsedW, expandedW, pressedExpanded, collapsedAgainW: sb.getBoundingClientRect().width };
    });
    record(
      'the top-bar show/hide button expands and re-collapses the settings sidebar',
      barToggle.expandedW > barToggle.collapsedW && barToggle.pressedExpanded === 'true' && barToggle.collapsedAgainW < barToggle.expandedW,
      `collapsed ${Math.round(barToggle.collapsedW)} → expanded ${Math.round(barToggle.expandedW)} → collapsed ${Math.round(barToggle.collapsedAgainW)}`,
    );

    // Expand + collapse via the in-sidebar chevron.
    const collapse = await page.evaluate(async () => {
      const sb = document.getElementById('settingsSidebar');
      const chevron = document.getElementById('sidebarCollapse');
      const collapsedW = sb.getBoundingClientRect().width;
      chevron.click();
      await new Promise((r) => setTimeout(r, 320));
      const expandedW = sb.getBoundingClientRect().width;
      const pressedExpanded = chevron.getAttribute('aria-pressed');
      chevron.click();
      await new Promise((r) => setTimeout(r, 320));
      return { collapsedW, expandedW, pressedExpanded, collapsedAgainW: sb.getBoundingClientRect().width };
    });
    record(
      'the settings sidebar expands and re-collapses from its chevron',
      collapse.expandedW > collapse.collapsedW && collapse.pressedExpanded === 'true' && collapse.collapsedAgainW < collapse.expandedW,
      `collapsed ${Math.round(collapse.collapsedW)} → expanded ${Math.round(collapse.expandedW)} → collapsed ${Math.round(collapse.collapsedAgainW)}`,
    );

    // Drag the right edge: grows toward the 50% cap, then shrinks but stays usable.
    const resize = await page.evaluate(async () => {
      const sb = document.getElementById('settingsSidebar');
      const ws = document.getElementById('studioWorkspace');
      const h = document.getElementById('sidebarResize');
      document.getElementById('sidebarCollapse').click();
      await new Promise((res) => setTimeout(res, 320));
      const r = h.getBoundingClientRect();
      const x0 = r.left + r.width / 2;
      const y0 = r.top + r.height / 2;
      const openW = sb.getBoundingClientRect().width;
      const cap = ws.getBoundingClientRect().width * 0.5;
      h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x0, clientY: y0, pointerId: 1 }));
      h.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x0 + 3000, clientY: y0, pointerId: 1 }));
      await new Promise((res) => setTimeout(res, 320));
      const grownW = sb.getBoundingClientRect().width;
      h.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x0 - 3000, clientY: y0, pointerId: 1 }));
      await new Promise((res) => setTimeout(res, 320));
      const shrunkW = sb.getBoundingClientRect().width;
      h.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x0, clientY: y0, pointerId: 1 }));
      return { openW, cap, grownW, shrunkW };
    });
    record(
      'the settings sidebar drag-resizes up to 50% of the workspace',
      resize.grownW <= resize.cap + 1 && resize.grownW >= resize.openW - 1 && resize.shrunkW < resize.grownW && resize.shrunkW > 0,
      `open ${Math.round(resize.openW)} cap ${Math.round(resize.cap)} grown ${Math.round(resize.grownW)} shrunk ${Math.round(resize.shrunkW)}`,
    );

    // The console and engine controls are step-editor tools: the Bulk and
    // Library tabs close them and disable their top-bar toggles.
    const gating = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const grid = document.querySelector('.studioGrid');
      const consoleToggle = document.getElementById('consoleToggle');
      const sidebarToggle = document.getElementById('sidebarToggle');
      const consoleCol = document.getElementById('studioConsoleCol');
      const sidebar = document.getElementById('settingsSidebar');
      const snap = () => ({
        consoleShown: grid?.dataset.console === 'shown',
        consoleDisabled: consoleToggle?.disabled,
        consoleDisplay: consoleCol ? getComputedStyle(consoleCol).display : '',
        sidebarDisabled: sidebarToggle?.disabled,
        sidebarCollapsed: sidebar?.dataset.collapsed === 'true',
        sidebarDisplay: sidebar ? getComputedStyle(sidebar).display : '',
      });
      // On the Step tab both controls can be opened.
      consoleToggle.click();
      if (sidebar?.dataset.collapsed === 'true') sidebarToggle.click();
      await wait(320);
      const step = snap();
      // Bulk: both are closed and their toggles are disabled.
      document.getElementById('tabBulk').click();
      await wait(320);
      const bulk = snap();
      // A disabled toggle must not reopen them.
      consoleToggle.click();
      sidebarToggle.click();
      await wait(120);
      const bulkAfterClicks = snap();
      // Library behaves the same way.
      document.getElementById('tabLibrary').click();
      await wait(320);
      const library = snap();
      document.getElementById('tabStep').click();
      await wait(120);
      const backToStep = snap();
      return { step, bulk, bulkAfterClicks, library, backToStep };
    });
    record(
      'the Bulk and Library tabs cannot enable the console or engine controls',
      gating.step.consoleShown &&
        gating.step.consoleDisabled === false &&
        gating.step.sidebarDisplay !== 'none' &&
        gating.step.sidebarDisabled === false &&
        gating.bulk.consoleShown === false &&
        gating.bulk.consoleDisabled === true &&
        gating.bulk.consoleDisplay === 'none' &&
        gating.bulk.sidebarDisabled === true &&
        gating.bulk.sidebarCollapsed === true &&
        gating.bulk.sidebarDisplay === 'none' &&
        gating.bulkAfterClicks.consoleShown === false &&
        gating.bulkAfterClicks.sidebarCollapsed === true &&
        gating.library.consoleDisabled === true &&
        gating.library.consoleDisplay === 'none' &&
        gating.library.sidebarDisabled === true &&
        gating.library.sidebarDisplay === 'none' &&
        gating.backToStep.consoleDisabled === false &&
        gating.backToStep.sidebarDisabled === false,
      JSON.stringify(gating),
    );
    await page.close();
  }

  // ——— Scenario: emulated mobile viewport downsizes an oversized source ———
  // This is an EMULATED viewport (mobile UA + deviceMemory=2 + touch viewport),
  // not a real phone. It proves the page chooses a smaller source and exports at
  // that size; it says nothing about a real Android/iOS GPU or memory budget.
  {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/157.0.0.0 Mobile Safari/537.36',
    );
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'userAgentData', {
        configurable: true,
        get: () => ({ mobile: true }),
      });
      Object.defineProperty(navigator, 'deviceMemory', {
        configurable: true,
        get: () => 2,
      });
    });
    const mobileUrl = new URL(pageUrl.toString());
    mobileUrl.searchParams.set('provider', 'wasm');
    await page.goto(mobileUrl.toString(), { waitUntil: 'load', timeout: 120000 });
    await openStudio(page);
    await page.waitForFunction('window.smokeModelReady === true', { timeout: 600000 });
    await chooseFile(page, resolve(FIXTURES, 'large-phone-photo.png'));
    await page.waitForFunction(() => document.querySelector('#outputBox img') !== null, {
      timeout: 600000,
    });
    const state = await page.evaluate(() => ({
      // The preview <img> is display-sized, so the export is the only place
      // that proves the result's real dimensions.
      href: document.getElementById('downloadImage')?.getAttribute('href') ?? '',
      log: document.getElementById('consoleOutput')?.textContent ?? '',
      recoveryHidden: document.getElementById('recovery')?.hidden ?? true,
      stage: document.getElementById('stage')?.textContent ?? '',
    }));
    // PNG IHDR: width at byte 16, height at byte 20 (after sig + length + type).
    const png = Buffer.from(state.href.split(',')[1] ?? '', 'base64');
    const exportWidth = png.length >= 24 ? png.readUInt32BE(16) : 0;
    const exportHeight = png.length >= 24 ? png.readUInt32BE(20) : 0;
    record(
      'emulated mobile: a 4800×3200 source exports at 2048×1365',
      exportWidth === 2048 && exportHeight === 1365,
      `${exportWidth}x${exportHeight}`,
    );
    record(
      'emulated mobile: the reduction is logged',
      /Reduced from 4800×3200 to 2048×1365/.test(state.log),
    );
    record(
      'emulated mobile: the oversized photo reaches a result without an OOM path',
      state.recoveryHidden === true && !/bad_alloc|out of memory/i.test(state.stage),
      state.stage.replace(/\s+/g, ' ').slice(0, 60),
    );
    await page.close();
  }

  // ——— Scenario: analytics is consent-gated, text-only, and non-blocking ———
  // Points the client at a same-origin fake endpoint (?analytics=/__analytics)
  // and records the event bodies in-page (sendBeacon bodies are not exposed to
  // puppeteer's request interception), then checks the counting rules and the
  // privacy guarantee (no image data ever leaves the page).
  {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      window.__analyticsEvents = [];
      window.__analyticsReports = [];
      const record = (kind, body) => {
        if (body == null) return;
        try {
          const parsed = typeof body === 'string' ? JSON.parse(body) : body;
          if (parsed == null) return;
          (kind === 'report' ? window.__analyticsReports : window.__analyticsEvents).push(parsed);
        } catch {
          /* ignore */
        }
      };
      const origBeacon = navigator.sendBeacon?.bind(navigator);
      navigator.sendBeacon = (url, data) => {
        if (String(url).includes('/__analytics/')) {
          const kind = String(url).includes('quality-reports') ? 'report' : 'event';
          if (data instanceof Blob) data.text().then((t) => record(kind, t));
          else record(kind, data);
          return true;
        }
        return origBeacon ? origBeacon(url, data) : false;
      };
      const origFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        if (String(url).includes('/__analytics/')) {
          record(String(url).includes('quality-reports') ? 'report' : 'event', init?.body ?? '');
          return Promise.resolve(new Response('{}', { status: 200 }));
        }
        return origFetch(input, init);
      };
    });
    const analyticsUrl = new URL(pageUrl.toString());
    analyticsUrl.searchParams.set('analytics', '/__analytics');
    analyticsUrl.searchParams.set('provider', 'wasm');
    await page.goto(analyticsUrl.toString(), { waitUntil: 'load', timeout: 120000 });

    const events = () => page.evaluate(() => window.__analyticsEvents.map((e) => e.event_name));

    // 1. The consent banner is shown before any decision, and nothing is sent.
    const bannerShown = await page
      .waitForSelector('#consentBanner:not([hidden])', { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    record('the analytics consent banner is shown before a decision', bannerShown === true);
    record('no event is sent before consent', (await events()).length === 0, `${(await events()).length} sent`);

    // 2. Declining sends nothing and creates no identifier.
    await page.click('#consentReject');
    const afterReject = await page.evaluate(() => ({
      banner: document.getElementById('consentBanner')?.hidden === false,
      visitor: localStorage.getItem('remove-bg:analytics-visitor'),
    }));
    record(
      'declining analytics sends nothing and stores no identifier',
      afterReject.banner === false && afterReject.visitor === null && (await events()).length === 0,
    );

    // 3. Change the choice via the footer control, then allow. Use a DOM click
    // (the footer sits at the very bottom of a long page) and wait for the
    // banner before reading its state.
    await page.evaluate(() => document.getElementById('analyticsSettingsBtn')?.click());
    await page
      .waitForFunction(() => document.getElementById('consentBanner')?.hidden === false, { timeout: 5000 })
      .catch(() => {});
    const bannerBack = await page.evaluate(
      () => document.getElementById('consentBanner')?.hidden === false,
    );
    record('the footer control re-opens the consent choice', bannerBack === true);
    await page.click('#consentAccept');

    // 4. Process an image: the lifecycle events must arrive, once each.
    await openStudio(page);
    await chooseFile(page, resolve(FIXTURES, 'input.png'));
    await page.waitForFunction('window.smokeModelReady === true', { timeout: 600000 }).catch(() => {});
    await page.waitForFunction(
      () => !!document.querySelector('#outputBox img'),
      { timeout: 600000 },
    ).catch(() => {});
    await sleep(500);

    const names = await events();
    record(
      'a successful process emits started + succeeded + first-success once each',
      names.filter((n) => n === 'image_processing_started').length === 1 &&
        names.filter((n) => n === 'image_processing_succeeded').length === 1 &&
        names.filter((n) => n === 'first_successful_image_processed').length === 1,
      names.join(','),
    );

    // 5. Trigger a download: exactly one download_initiated.
    await page.click('#downloadImage');
    await sleep(400);
    record(
      'a download action emits download_initiated',
      (await events()).filter((n) => n === 'download_initiated').length === 1,
    );

    // 6. Privacy: no captured body carries image data or a filename.
    const bodies = await page.evaluate(() => JSON.stringify(window.__analyticsEvents));
    record(
      'no analytics payload carries image data or a filename',
      !/base64|data:image|\.png|\.jpg|input\.png/i.test(bodies),
    );

    // 7. The quality-report form: diagnostics are off by default and the report
    //    is a separate, explicit action (works even with analytics declined).
    await page.click('#reportProblemBtn');
    const formOpen = await page.evaluate(
      () => document.getElementById('qualityReportForm')?.hidden === false,
    );
    const diagnosticsOff = await page.evaluate(
      () => document.getElementById('reportDiagnosticsPreview')?.hidden === true,
    );
    record('the report form opens with diagnostics off by default', formOpen === true && diagnosticsOff === true);

    // Submitting with no category is refused client-side.
    await page.click('#reportSubmit');
    const refused = await page.evaluate(() => {
      const err = document.getElementById('reportError');
      return err && err.hidden === false && /category/i.test(err.textContent || '');
    });
    record('the report form refuses a submission with no category', refused === true);

    // A valid report is posted to the quality-reports endpoint.
    await page.select('#reportCategory', 'poor_edges');
    await page.click('#reportAttachDiagnostics');
    const previewShown = await page.evaluate(
      () => document.getElementById('reportDiagnosticsPreview')?.hidden === false,
    );
    const previewText = await page.evaluate(
      () => document.getElementById('reportDiagnosticsJson')?.textContent || '',
    );
    record(
      'ticking diagnostics shows the exact payload before sending',
      previewShown === true && previewText.includes('schemaVersion'),
    );
    // The upload view must not carry the browser fingerprint fields.
    record(
      'the diagnostics upload view clears the browser fingerprint fields',
      /"userAgent"\s*:\s*""/.test(previewText) && /"platform"\s*:\s*null/.test(previewText),
    );
    await page.click('#reportSubmit');
    await sleep(400);
    const reports = await page.evaluate(() => window.__analyticsReports);
    record(
      'a valid report is posted to the quality-reports endpoint',
      reports.length === 1 && reports[0].category === 'poor_edges',
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
