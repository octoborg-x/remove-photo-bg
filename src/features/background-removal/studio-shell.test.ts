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
    // Every sidebar control has an info bubble whose panel it toggles.
    expect((HTML.match(/class="infoBubble"/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(HTML).toContain('data-info-target="tilingInfo"');
    expect(HTML).toContain('data-info-target="refineInfo"');
    expect(MAIN).toMatch(/dataset\.infoTarget/);
  });

  it('hides every explanatory hint behind its info icon', () => {
    // No hint text is visible by default: the prose lives inside a `hidden`
    // info panel, so the sidebar shows controls only until the "?" is clicked.
    for (const id of ['providerInfo', 'maskThresholdInfo', 'maskFeatherInfo', 'tilingInfo', 'refineInfo']) {
      expect(HTML).toMatch(new RegExp(`id="${id}" class="infoPanel" hidden`));
    }
    // The old always-visible hint lines are gone.
    expect(HTML).not.toContain('>Higher values trim translucent halo noise.<');
    expect(HTML).not.toContain('>Softens edge transitions for fur and glass.<');
    expect(HTML).not.toMatch(/class="hint block text-\[11px\] text-slate-400 mt-1" id="tilingHint">/);
  });

  it('shows the tiling recommendation in the info panel, never a toast', () => {
    // The recommendation is stored and rendered into the tiling info panel.
    expect(MAIN).toMatch(/tilingAdvice = rec\.recommended/);
    expect(MAIN).toMatch(/tilingAdviceEl\.hidden = !tilingAdvice/);
    // It is fed the measured soft-edge share, which is what gates it.
    expect(MAIN).toMatch(/maybeRecommendTiling\(transitionBandFraction\(/);
    // The old toast offer (with an action button) is gone.
    expect(MAIN).not.toMatch(/title: 'Sharpen fine edges with tiled inference\?'/);
    expect(MAIN).not.toMatch(/tilingOfferedFor/);
    expect(HTML).toContain('id="tilingApply"');
    expect(MAIN).toMatch(/tilingApplyBtn\?\.addEventListener\('click'/);
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

  it('refines the recovered mask, not the raw mask, when flood recovery fires', () => {
    // Stage 1 may replace a flooded model mask with a border-flood recovery. The
    // refinement stage (Stages 2-4) rebuilds the final alpha, so it must receive
    // the recovered mask — feeding it the raw `croppedFloat` silently discards
    // the recovery and the exported cut-out keeps the background attached
    // (the large-04 regression).
    const refine = MAIN.slice(
      MAIN.indexOf('function compositeAndRefine('),
      MAIN.indexOf('async function refineAndFinalize('),
    );
    expect(refine).toMatch(/recoverForegroundMask\(image, fullResMask\)/);
    // The refine input branches on `recovered`: the recovered full-resolution
    // mask, or the letterbox-cropped raw float mask.
    expect(refine).toMatch(/recovered\s*\?\s*\{ mask: bytesToAlpha\(recoveredMask\)/);
    expect(refine).toMatch(/mask: croppedFloat, width: rect\.width, height: rect\.height/);
    // The refine call passes the chosen mask together with its own dimensions.
    expect(refine).toMatch(/refineAndFinalize\(jobId, image, refineInput\.mask, refineInput\.width, refineInput\.height/);
  });
});
