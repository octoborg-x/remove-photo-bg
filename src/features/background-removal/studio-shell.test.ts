// Source-level guards for the studio shell wired in main.ts: the shared settings
// sidebar, the Library tab, the export bar, and the tiled-inference path. These
// cannot be exercised in the sandbox (they need a DOM + a real model run), so
// they are pinned at the source level, like single-inference-worker.test.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..');
const MAIN = readFileSync(resolve(ROOT, 'src/main.ts'), 'utf8');
const HTML = readFileSync(resolve(ROOT, 'index.html'), 'utf8');

describe('studio shell wiring (main.ts + index.html)', () => {
  it('registers a tab button and panel for every tab in STUDIO_TABS', () => {
    // The maps must cover the full tab set, or a tab click would throw.
    for (const id of ['tabInput', 'tabProcessing', 'tabResult', 'tabCompare', 'tabLibrary']) {
      expect(HTML).toContain(`id="${id}"`);
    }
    for (const id of ['panelInput', 'panelProcessing', 'panelResult', 'panelCompare', 'panelLibrary']) {
      expect(HTML).toContain(`id="${id}"`);
    }
    expect(MAIN).toMatch(/library:\s*document\.getElementById\('tabLibrary'\)/);
    expect(MAIN).toMatch(/library:\s*document\.getElementById\('panelLibrary'\)/);
  });

  it('keeps the settings sidebar available in every tab', () => {
    // The top-bar toggle is no longer gated on the result tab.
    expect(MAIN).toMatch(/sidebarToggleBtn\.hidden = false/);
    expect(MAIN).not.toMatch(/sidebarToggleBtn\.hidden = studioView\.tab !== 'result'/);
  });

  it('drives the export bar from the result state and toggles it from the top bar', () => {
    expect(MAIN).toMatch(/exportToggleBtn\.hidden = !studioView\.hasResult/);
    expect(MAIN).toMatch(/function setExportBarOpen\(/);
    expect(MAIN).toMatch(/setExportBarOpen\(!exportBarOpen\)/);
    expect(HTML).toContain('id="exportToggle"');
    expect(HTML).toContain('id="exportBar"');
  });

  it('exposes tiling + edge-refinement controls in the shared sidebar', () => {
    for (const id of ['tilingSelect', 'refineToggle', 'refineStrength', 'refineEdgeSensitivity']) {
      expect(HTML).toContain(`id="${id}"`);
    }
    // Each control has an info bubble whose panel it toggles.
    expect((HTML.match(/class="infoBubble"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(HTML).toContain('data-info-target="tilingInfo"');
    expect(HTML).toContain('data-info-target="refineInfo"');
    expect(MAIN).toMatch(/dataset\.infoTarget/);
  });

  it('routes a tiled run through the stitcher and the shared composite path', () => {
    // A result whose run id belongs to a tiled run must not go through the
    // single-image path.
    expect(MAIN).toMatch(/tiledRuns\.get\(msg\.runId\)/);
    expect(MAIN).toMatch(/handleTiledResultReady\(/);
    // The stitched mask is handed to the same Stage-1 → refine → composite path.
    const tiled = MAIN.slice(
      MAIN.indexOf('function handleTiledResultReady('),
      MAIN.indexOf('async function runTiledInference('),
    );
    expect(tiled).toMatch(/stitcher\.result\(\)/);
    expect(tiled).toMatch(/compositeAndRefine\(/);
  });

  it('re-posts the failed TILE, not the whole image, on a fresh worker', () => {
    const restart = MAIN.slice(
      MAIN.indexOf('async function restartOnFreshWorker('),
      MAIN.indexOf('function finishedRun('),
    );
    expect(restart).toMatch(/tiled\.state\.tiles\[tiled\.tileIndex\]/);
  });

  it('falls back to a single pass below the tiling minimum long side', () => {
    expect(MAIN).toMatch(/tileGrid > 1 && longSide >= TILING_MIN_LONG_SIDE/);
  });
});
