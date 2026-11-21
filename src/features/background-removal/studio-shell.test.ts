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
    for (const id of ['tabStep', 'tabBulk', 'tabLibrary']) {
      expect(HTML).toContain(`id="${id}"`);
    }
    for (const id of ['panelStep', 'panelBulk', 'panelLibrary']) {
      expect(HTML).toContain(`id="${id}"`);
    }
    expect(MAIN).toMatch(/step:\s*document\.getElementById\('tabStep'\)/);
    expect(MAIN).toMatch(/bulk:\s*document\.getElementById\('tabBulk'\)/);
    expect(MAIN).toMatch(/library:\s*document\.getElementById\('tabLibrary'\)/);
    expect(MAIN).toMatch(/bulk:\s*document\.getElementById\('panelBulk'\)/);
  });

  it('keeps one step tab whose title follows the current step', () => {
    // The old Photo/Processing/Result/Compare tabs are gone; one tab carries the
    // step title from the pure state helper.
    expect(HTML).not.toContain('id="tabInput"');
    expect(HTML).not.toContain('id="tabProcessing"');
    expect(HTML).not.toContain('id="tabResult"');
    expect(HTML).not.toContain('id="tabCompare"');
    expect(HTML).not.toContain('id="panelCompare"');
    expect(MAIN).toMatch(/tabButtons\.step\.textContent = stepTitle\(studioView\)/);
    expect(MAIN).toMatch(/stepInputEl\.hidden = phase !== 'input'/);
    expect(MAIN).toMatch(/stepProcessingEl\.hidden = phase !== 'processing'/);
    expect(MAIN).toMatch(/stepResultEl\.hidden = phase !== 'result'/);
    // A result view still offers a way back to the photo picker.
    expect(HTML).toContain('id="newPhotoBtn"');
    expect(MAIN).toMatch(/newPhotoBtn\?\.addEventListener\('click', chooseFile\)/);
  });

  it('keeps the settings sidebar available in every tab', () => {
    // The top-bar toggle is no longer gated on the result tab.
    expect(MAIN).toMatch(/sidebarToggleBtn\.hidden = false/);
    expect(MAIN).not.toMatch(/sidebarToggleBtn\.hidden = studioView\.tab !== 'result'/);
  });

  it('drives the background & export section from the step result or a bulk batch', () => {
    expect(MAIN).toMatch(/function updateExportBarVisibility\(/);
    expect(MAIN).toMatch(/studioView\.tab === 'step'[\s\S]{0,120}studioView\.hasResult/);
    expect(MAIN).toMatch(/studioView\.tab === 'bulk'[\s\S]{0,120}bulkDoneCount\(bulkState\) > 0/);
    // The old top-bar toggle and collapsible bottom bar are gone.
    expect(HTML).not.toContain('id="exportToggle"');
    expect(HTML).not.toContain('id="bottomBarCollapse"');
    expect(MAIN).not.toMatch(/function setExportBarOpen\(/);
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
    // ...with the island-cleanup bar the engine controls selected, so the
    // recovery despeckle matches the Stage-4 variant.
    expect(refine).toMatch(
      /recoverForegroundMask\(image, fullResMask, \{\s*minIslandFraction: islandFraction\(refineConfig\.cleanup\.islandCleanup\),?\s*\}\)/,
    );
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
    expect(refine).toMatch(
      /refinedMask = despeckleRecoveredMask\(\s*refinedMask,\s*image\.width,\s*image\.height,\s*islandFraction\(refineConfig\.cleanup\.islandCleanup\),\s*\)/,
    );
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

  it('exposes the island cleanup variant in the engine controls', () => {
    expect(HTML).toContain('id="islandCleanupSelect"');
    expect(HTML).toMatch(/<option value="fine">/);
    expect(HTML).toMatch(/<option value="strict">/);
    expect(MAIN).toMatch(/refineConfig\.cleanup\.islandCleanup = islandCleanupSelect\.value/);
    // A variant change invalidates the on-screen cut-out like any other knob.
    expect(MAIN).toMatch(/refineConfig\.cleanup\.islandCleanup,\s*\]\s*\.join\('\|'\)/);
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

  it('places background & export to the right of the settings sidebar, inside the tab body', () => {
    // The section lives in the tab body (the column to the right of the shared
    // settings sidebar), not in the result panel or the old bottom bar.
    const bodyStart = HTML.indexOf('id="studioWorkspace"');
    const exportStart = HTML.indexOf('id="exportBar"');
    const bodyEnd = HTML.indexOf('id="recovery"');
    expect(bodyStart).toBeGreaterThan(-1);
    expect(exportStart).toBeGreaterThan(bodyStart);
    expect(exportStart).toBeLessThan(bodyEnd);
    expect(HTML).not.toContain('class="exportBar bottomBar" hidden role="region" aria-label="Background and export">\n                <div class="bottomBarHead">\n                  <div class="bottomBarHeadTitle">\n                    <span class="w-2 h-2 rounded-full bg-blue-600"></span>\n                    <h4 class="bottomBarTitle">Background &amp; Export</h4>\n                  </div>\n                  <button');
    const resultPanel = HTML.slice(HTML.indexOf('id="panelStep"'), HTML.indexOf('id="panelBulk"'));
    expect(resultPanel).not.toContain('id="bgTransparentBtn"');
    // The Bulk tab and the step tab share the same section in that column.
    expect(HTML).toMatch(/id="panelBulk"[\s\S]*id="panelLibrary"[\s\S]*id="exportBar"/);
  });

  it('offers a Bulk tab for up to five photos', () => {
    expect(HTML).toContain('id="panelBulk"');
    expect(HTML).toContain('id="bulkPick"');
    expect(HTML).toContain('id="bulkProcess"');
    expect(HTML).toContain('id="bulkGrid"');
    expect(MAIN).toMatch(/BULK_LIMIT/);
    expect(MAIN).toMatch(/function addBulkFiles\(/);
    expect(MAIN).toMatch(/function processBulkBatch\(/);
    // Batch output is downloadable in the chosen format on the chosen background.
    expect(HTML).toContain('id="bulkDownloadAll"');
    expect(MAIN).toMatch(/function downloadAllBulk\(/);
    expect(MAIN).toMatch(/canvasToDataUrl\(canvas, exportFormat, background\)/);
  });

  it('saves bulk cut-outs to the library and can stop saving or clear history', () => {
    // A bulk run goes through the same loader, so its result fills a library
    // entry exactly like a single run.
    expect(MAIN).toMatch(/await loadImageFromFile\(file, librarySavingEnabled\)/);
    expect(MAIN).toMatch(/if \(!librarySavingEnabled \|\| token !== libraryRunToken\) return/);
    expect(HTML).toContain('id="librarySaveToggle"');
    expect(HTML).toContain('id="libraryClear"');
    expect(MAIN).toMatch(/function applyLibrarySaveUi\(/);
    expect(MAIN).toMatch(/function clearLibrary\(/);
    expect(MAIN).toMatch(/reduceSession\(session, \{ type: 'clear' \}\)/);
    expect(MAIN).toMatch(/LS_LIBRARY_SAVE/);
  });

  it('gives the editor the full width on mobile and keeps it scrollable', () => {
    expect(CSS).toMatch(/@media \(max-width: 767px\)\s*\{[\s\S]*?\.studioWorkspace\s*\{\s*flex-direction: column/s);
    expect(CSS).toMatch(/\.studioTabBody\s*\{[^}]*overflow-y: auto/s);
    // The console and engine sidebar start hidden on every screen, not just mobile.
    expect(MAIN).toMatch(/setSidebarCollapsed\(true\)/);
    expect(MAIN).toMatch(/setConsoleVisible\(false\)/);
  });

  it('keeps an alpha-capable format from inheriting an opaque background', () => {
    // PNG/WebP exist to carry transparency, so selecting one is a request for a
    // transparent cut-out. A solid colour would paint over the alpha and the
    // file would be opaque even though the format supports alpha (the reported
    // "PNG and WebP don't take alpha" result). A see-through colour already
    // carries alpha, so it is kept.
    expect(MAIN).toMatch(/function dropOpaqueBackgroundForAlpha\(/);
    expect(MAIN).toMatch(/exportFormatInfo\(format\)\.supportsAlpha/);
    expect(MAIN).toMatch(/background\.kind !== 'color' \|\| background\.alpha < 100/);
    // The radio is the explicit choice, so it applies the rule.
    expect(MAIN).toMatch(/chooseExportFormat\(format\.id\)/);
    // A reload restores the same rule: a persisted PNG/WebP format must not sit
    // on a persisted opaque colour and silently export an opaque file.
    expect(MAIN).toMatch(/dropOpaqueBackgroundForAlpha\(exportFormat\)/);
  });

  it('makes the alpha slider inert unless a colour background is active', () => {
    // Dragging "Alpha" on a transparent background used to paint an opaque white
    // one, which flattened PNG/WebP exports.
    expect(MAIN).toMatch(/bgAlphaInput\.disabled = !color/);
    expect(MAIN).toMatch(/if \(background\.kind !== 'color'\) return;/);
    // A colour first picked from transparent starts fully opaque, not at the
    // slider's stale value.
    expect(MAIN).toMatch(/background\.kind === 'color' \? Number\(bgAlphaInput\.value\) : 100/);
  });
});
