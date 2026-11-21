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
const CSS = readFileSync(resolve(ROOT, 'src/style.css'), 'utf8');

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
    // ...and flags whether this was a recovery, so the despeckle below runs only
    // on recovered masks and never alters a model mask.
    expect(refine).toMatch(/postprocessStart, recovered\)/);
  });

  it('re-despeckles after refinement, because refinement re-grows the islands', () => {
    // The recovery despeckles the flood-fill output, but Stages 2-4 rebuild the
    // alpha from the soft mask and re-grow small islands, so the speckle returns
    // (large-04: 78 components, ordinary-product-08: 267). The final alpha must
    // be despeckled again, gated on the recovery flag.
    const refine = MAIN.slice(MAIN.indexOf('async function refineAndFinalize('));
    expect(refine).toMatch(/if \(despeckleAfterRefine\) \{/);
    expect(refine).toMatch(/refinedMask = despeckleRecoveredMask\(refinedMask, image\.width, image\.height\)/);
    // The despeckle must land before the composite that paints the result.
    expect(refine.indexOf('despeckleRecoveredMask(refinedMask')).toBeLessThan(
      refine.indexOf('composeResult(image, refinedMask)'),
    );
  });
});

describe('studio UI refinements', () => {
  it('floats the info panels so opening one never reflows the sidebar', () => {
    expect(CSS).toMatch(/\.infoPanel\s*\{[^}]*position:\s*fixed/s);
    expect(MAIN).toMatch(/function positionInfoPanel\(/);
    expect(MAIN).toMatch(/positionInfoPanel\(target, bubble\)/);
    expect(MAIN).toMatch(/window\.addEventListener\('resize', repositionOpenInfoPanel\)/);
  });

  it('shows only the format name for PNG/JPG/WebP', () => {
    // No description is rendered next to the format name.
    expect(MAIN).not.toMatch(/— \$\{available \? format\.description/);
    expect(MAIN).not.toMatch(/Download \$\{info\.label\} \(\$\{info\.description\}\)/);
    expect(MAIN).toMatch(/downloadImageBtn\.textContent = `Download \$\{info\.label\}`/);
  });

  it('uses an icon-only transparent toggle and a multicolour solid-colour control', () => {
    expect(HTML).toMatch(/id="bgTransparentBtn"[^>]*>\s*<span class="bgTransparentChip"/);
    expect(HTML).not.toMatch(/id="bgTransparentBtn"[\s\S]{0,400}?Transparent\s*<\/button>/);
    expect(CSS).toMatch(/\.bgColorSwatch\s*\{[^}]*conic-gradient/s);
    expect(MAIN).toMatch(/bgColorSwatch\.style\.setProperty\('--picked', background\.hex\)/);
  });

  it('adds the before/after slider to the Result editor', () => {
    expect(MAIN).toMatch(/figure\.className = 'compare resultCompare'/);
    expect(MAIN).toMatch(/compareImg compareAfter/);
    expect(MAIN).toMatch(/compareImg compareBefore/);
    expect(CSS).toMatch(/\.resultCompare \.compareBefore\s*\{[^}]*clip-path/s);
    // Reuses the shared compare wiring rather than duplicating drag logic.
    expect(MAIN).toMatch(/initCompareSliders\(outputBox\)/);
  });

  it('keeps the Result slider hidden until the compare button is pressed', () => {
    expect(HTML).toContain('id="resultCompareToggle"');
    expect(HTML).toMatch(/id="resultCompareToggle"[\s\S]*?hidden/);
    expect(MAIN).toMatch(/let resultCompareOn = false/);
    expect(MAIN).toMatch(/resultCompareToggleBtn\?\.addEventListener\('click', \(\) => setResultCompare\(!resultCompareOn\)\)/);
    expect(CSS).toMatch(/\.resultCompare\[data-compare-on='false'\] \.compareRange\s*\{[^}]*display:\s*none/s);
  });

  it('starts with the console and the engine controls hidden', () => {
    expect(HTML).toMatch(/class="studioGrid" data-console="hidden"/);
    expect(HTML).toMatch(/id="settingsSidebar"[^>]*data-collapsed="true"/);
    expect(MAIN).toMatch(/setSidebarCollapsed\(true\);\s*setConsoleVisible\(false\);/);
  });

  it('marks the engine controls as experimental', () => {
    expect(HTML).toMatch(/class="sidebarBadge"[^>]*>Experimental</);
    expect(CSS).toMatch(/\.sidebarBadge\s*\{/);
  });

  it('keeps every re-processed cut-out as its own library version', () => {
    expect(MAIN).toMatch(/type: 'add-version'/);
    expect(MAIN).toMatch(/libraryResultBlobs/);
    expect(MAIN).toMatch(/function openLibraryResult\(/);
    expect(MAIN).toMatch(/function beginLibraryRun\(/);
    // A re-opened result loads the stored PNG instead of re-running inference.
    expect(MAIN).toMatch(/entry\.resultUrl && libraryResultBlobs\.has\(id\)/);
  });

  it('offers a reset-to-defaults control for every engine option', () => {
    expect(HTML).toContain('id="resetEngineBtn"');
    expect(MAIN).toMatch(/function resetEngineOptions\(/);
    expect(MAIN).toMatch(/maskAdjust = \{ \.\.\.DEFAULT_MASK_ADJUST \}/);
    expect(MAIN).toMatch(/tileGrid = 1/);
    expect(MAIN).toMatch(/Object\.assign\(refineConfig, resolveRefinementConfig\(\)\)/);
  });

  it('moves background, format and download into a collapsible bottom sidebar', () => {
    expect(HTML).toMatch(/id="exportBar" class="exportBar bottomBar"/);
    expect(HTML).toContain('id="bottomBarCollapse"');
    // The background block now lives in the bottom bar, not the result panel.
    const resultPanel = HTML.slice(HTML.indexOf('id="panelResult"'), HTML.indexOf('id="panelCompare"'));
    expect(resultPanel).not.toContain('id="bgTransparentBtn"');
    expect(HTML).toMatch(/id="exportToggle"[\s\S]*?<line x1="3" y1="15" x2="21" y2="15"/);
  });

  it('gives the editor the full width on mobile and keeps it scrollable', () => {
    expect(CSS).toMatch(/@media \(max-width: 767px\)\s*\{[\s\S]*?\.studioWorkspace\s*\{\s*flex-direction: column/s);
    expect(CSS).toMatch(/\.studioTabBody\s*\{[^}]*overflow-y: auto/s);
    // The console and engine sidebar start hidden on every screen, not just mobile.
    expect(MAIN).toMatch(/setSidebarCollapsed\(true\)/);
    expect(MAIN).toMatch(/setConsoleVisible\(false\)/);
  });
});
