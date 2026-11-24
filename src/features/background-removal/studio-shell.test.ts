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

  it('shows the engine controls sidebar only on the step tab', () => {
    // The top-bar toggle is enabled on the step editor and disabled on the
    // Bulk and Library tabs, where the sidebar is forced closed.
    expect(MAIN).toMatch(/const engineTab = tabHasEngineControls\(studioView\.tab\)/);
    expect(MAIN).toMatch(/if \(!engineTab\) \{\s*setConsoleVisible\(false\);\s*setSidebarCollapsed\(true\);/);
    expect(MAIN).toMatch(/sidebarToggleBtn\.disabled = !engineTab/);
    expect(MAIN).not.toMatch(/sidebarToggleBtn\.hidden = false/);
  });

  it('hides the sidebar entirely when it is collapsed', () => {
    // The collapsed sidebar used to leave a floating icon rail over the image.
    expect(CSS).toMatch(/\.settingsSidebar\[data-collapsed='true'\]\s*\{\s*display:\s*none/s);
    expect(CSS).not.toMatch(/\.settingsSidebar\[data-collapsed='true'\]\s*\{[^}]*position:\s*absolute/s);
  });

  it('disables the console toggle outside the step tab', () => {
    expect(MAIN).toMatch(/consoleToggleBtn\.disabled = !engineTab/);
    expect(MAIN).toMatch(/if \(visible && !tabHasEngineControls\(studioView\.tab\)\) return/);
  });

  it('drives the download menu from the step result or a bulk batch', () => {
    expect(MAIN).toMatch(/function updateDownloadUi\(/);
    expect(MAIN).toMatch(/studioView\.tab === 'step'[\s\S]{0,120}studioView\.hasResult/);
    expect(MAIN).toMatch(/studioView\.tab === 'bulk'[\s\S]{0,120}bulkDoneCount\(bulkState\) > 0/);
    // The old background & export block and its collapse control are gone.
    expect(HTML).not.toContain('id="exportBar"');
    expect(HTML).not.toContain('id="bottomBarCollapse"');
    expect(HTML).toContain('id="downloadMenuBtn"');
    expect(HTML).toContain('id="downloadMenu"');
    expect(MAIN).toMatch(/function toggleDownloadMenu\(/);
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
    expect(MAIN).toMatch(/downloadImageLabelEl\.textContent = `Download \$\{info\.label\}`/);
  });

  it('folds colour and alpha into one colour button that opens the modern picker', () => {
    // One button whose swatch carries the current colour. The old colour input,
    // hex field, spectrum map and transparent toggle are gone.
    expect(HTML).toMatch(/id="bgColorButton"[\s\S]{0,500}?id="bgColorSwatch"/);
    expect(HTML).not.toContain('id="bgColorPicker"');
    expect(HTML).not.toContain('id="bgTransparentBtn"');
    expect(HTML).not.toContain('id="bgHexAlphaInput"');
    expect(HTML).not.toContain('id="bgSpectrumMap"');
    // One shared popover with a saturation/value area, hue and alpha sliders, a
    // hex field and a transparent option.
    expect(HTML).toContain('id="colorPickerPopover"');
    for (const part of ['area', 'hue', 'alpha', 'hex', 'transparent']) {
      expect(HTML).toContain(`data-picker="${part}"`);
    }
    expect(CSS).toMatch(/\.colorPickerArea\s*\{/);
    expect(CSS).toMatch(/\.colorPickerHue\s*\{/);
    expect(CSS).toMatch(/\.colorButtonSwatch::after\s*\{[^}]*background:\s*var\(--swatch/s);
    expect(MAIN).toMatch(/createColorPicker\(document\.getElementById\('colorPickerPopover'\)/);
    expect(MAIN).toMatch(/colorPicker\.toggle\(bgColorButton, background/);
    expect(MAIN).toMatch(/colorPicker\.toggle\(bulkBgButton, bulkBackground/);
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

  it('puts choose-image, colour and download in the result action row', () => {
    const resultPanel = HTML.slice(HTML.indexOf('id="stepResult"'), HTML.indexOf('id="panelBulk"'));
    expect(resultPanel).toMatch(
      /class="resultActions"[\s\S]*id="newPhotoBtn"[\s\S]*id="bgColorButton"[\s\S]*id="downloadMenuBtn"/,
    );
    // The choose-image control is icon-only, with no visible label.
    expect(resultPanel).not.toContain('Choose another photo</button>');
    expect(resultPanel).not.toContain('id="exportBar"');
    // The Bulk tab keeps its own trigger for the same shared download menu.
    expect(HTML).toMatch(/id="panelBulk"[\s\S]*id="bulkDownloadBtn"/);
    expect(HTML).toMatch(/id="downloadMenu"[\s\S]*id="exportFormatSelect"[\s\S]*id="downloadImage"/);
    expect(HTML).not.toContain('id="formatOptions"');
  });

  it('opens the download menu with an image type select and a download action', () => {
    expect(HTML).toMatch(/id="downloadMenuBtn"[\s\S]*?aria-controls="downloadMenu"/);
    expect(MAIN).toMatch(/function openDownloadMenu\(/);
    expect(MAIN).toMatch(/function closeDownloadMenu\(/);
    expect(MAIN).toMatch(/downloadMenuBtn\?\.addEventListener\('click'/);
    expect(MAIN).toMatch(/formatSelectEl\.addEventListener\('change'/);
    expect(CSS).toMatch(/\.downloadMenu\s*\{[^}]*position:\s*fixed/s);
  });

  it('greys the Library tab title while library saving is off', () => {
    expect(MAIN).toMatch(/tabButtons\.library\.dataset\.saving = librarySavingEnabled \? 'on' : 'off'/);
    expect(CSS).toMatch(/\.editorTab\[data-saving='off'\]/);
  });

  it('offers a Bulk tab for up to five photos', () => {
    expect(HTML).toContain('id="panelBulk"');
    expect(HTML).toContain('id="bulkPick"');
    expect(HTML).toContain('id="bulkGrid"');
    expect(MAIN).toMatch(/BULK_LIMIT/);
    expect(MAIN).toMatch(/function addBulkFiles\(/);
    expect(MAIN).toMatch(/function processBulkBatch\(/);
    // Adding photos starts the batch; there is no separate "process all" step.
    expect(HTML).not.toContain('id="bulkProcess"');
    expect(MAIN).toMatch(
      /if \(bulkState\.items\.some\(\(item\) => item\.status === 'queued'\)\) void processBulkBatch\(\)/,
    );
    // Batch output is downloadable in the chosen format on the chosen background,
    // bundled into one ZIP archive.
    expect(HTML).toContain('id="bulkDownloadAll"');
    expect(MAIN).toMatch(/function downloadAllBulk\(/);
    expect(MAIN).toMatch(/canvasToDataUrl\(canvas, exportFormat, background\)/);
    expect(MAIN).toMatch(/createZipBlob\(entries\)/);
    expect(MAIN).toMatch(/dataUrlToBytes\(dataUrl\)/);
    expect(MAIN).toMatch(/link\.download = `background-removed-\$\{entries\.length\}-photos\.zip`/);
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
    // The format select is the explicit choice, so it applies the rule.
    expect(MAIN).toMatch(/chooseExportFormat\(formatSelectEl\.value\)/);
    // A reload restores the same rule: a persisted PNG/WebP format must not sit
    // on a persisted opaque colour and silently export an opaque file.
    expect(MAIN).toMatch(/dropOpaqueBackgroundForAlpha\(exportFormat\)/);
  });

  it('keeps the bulk background in one colour button instead of a picker row', () => {
    expect(HTML).toContain('id="bulkBgButton"');
    expect(HTML).toContain('id="bulkBgSwatch"');
    expect(HTML).not.toContain('id="bulkBgColor"');
    expect(HTML).not.toContain('id="bulkBgAlpha"');
    expect(HTML).not.toContain('id="bulkBgTransparent"');
    expect(MAIN).toMatch(/let bulkBackground: BackgroundChoice/);
    // Choosing a colour paints the checked images straight away; the button is
    // disabled until at least one image is selected, so no apply step is needed.
    expect(HTML).not.toContain('id="bulkBgApply"');
    expect(MAIN).toMatch(
      /bulkBgButton\?\.addEventListener\('click', \(\) => \{\s*colorPicker\.toggle\(bulkBgButton, bulkBackground, \(choice\) => \{[\s\S]*?applyBulkBackground\(choice\)/,
    );
    expect(MAIN).toMatch(/bulkBgButton\.disabled = checked === 0/);
  });

  it('pins the library saving switch to the tab row as an icon-only toggle', () => {
    const tabs = HTML.slice(HTML.indexOf('class="studioTabs"'), HTML.indexOf('id="studioWorkspace"'));
    expect(tabs).toContain('id="librarySaveToggle"');
    expect(tabs).toContain('role="switch"');
    expect(tabs).toContain('class="saveSwitchTrack"');
    // It is no longer one of the Library toolbar icon buttons.
    expect(HTML).not.toMatch(/libraryToolbarRight[\s\S]{0,400}?id="librarySaveToggle"/);
    expect(CSS).toMatch(/\.saveSwitch\s*\{[^}]*margin-left:\s*auto/s);
    expect(MAIN).toMatch(/librarySaveToggleEl\.setAttribute\('aria-checked'/);
    expect(MAIN).toMatch(/librarySaveToggleEl\.hidden = studioView\.tab !== 'library'/);
  });

  it('puts the bulk icon toolbar in the title slot and a figure in the empty state', () => {
    const head = HTML.slice(HTML.indexOf('class="bulkHead"'), HTML.indexOf('id="bulkStatus"'));
    expect(head).toContain('class="bulkToolbar"');
    expect(head).not.toContain('bulkTitle');
    expect(HTML).not.toContain('class="bulkTitle"');
    // Select-all sits alone on the left; add, colour and delete group on the right.
    expect(head).toMatch(
      /class="bulkToolbar"[\s\S]*id="bulkSelectAll"[\s\S]*<\/div>[\s\S]*class="bulkActions"[\s\S]*id="bulkPick"[\s\S]*id="bulkBgButton"[\s\S]*id="bulkDeleteSelected"/,
    );
    // The old paragraph placeholder is replaced by the photo-tab figure, with a
    // multi-photo icon, that also opens the picker.
    const empty = HTML.slice(HTML.indexOf('id="bulkEmpty"'), HTML.indexOf('id="panelLibrary"'));
    expect(empty).toContain('class="emptyState"');
    expect(empty).toContain('id="bulkEmptyPick"');
    expect(empty).toContain('class="emptyStateFigure"');
    expect(empty).not.toMatch(/Pick up to five photos/);
    expect(MAIN).toMatch(/bulkEmptyPickBtn\?\.addEventListener\('click', pickBulkFiles\)/);
  });

  it('uses a history figure for the library placeholder and three storage rows', () => {
    const empty = HTML.slice(HTML.indexOf('id="libraryEmpty"'), HTML.indexOf('id="retouchPanel"'));
    expect(empty).toContain('class="emptyStateFigure"');
    expect(empty).not.toMatch(/Photos you process stay on this device/);
    expect(MAIN).toMatch(/libraryEmptyTextEl\.hidden = !noMatches/);
    const stats = HTML.slice(HTML.indexOf('id="libraryStats"'), HTML.indexOf('id="libraryClear"'));
    expect(stats).toMatch(/>Used<[\s\S]*id="libraryStatUsed"/);
    expect(stats).toMatch(/>Left<[\s\S]*id="libraryStatLeft"/);
    expect(stats).toMatch(/>Total<[\s\S]*id="libraryStatTotal"/);
    expect(stats).not.toMatch(/Types PNG/);
    expect(MAIN).toMatch(/libraryStatUsedEl\.textContent = formatBytes\(usage\.usedBytes\)/);
    expect(MAIN).toMatch(/libraryStatLeftEl\.textContent = formatBytes\(usage\.leftBytes\)/);
    expect(MAIN).toMatch(/libraryStatTotalEl\.textContent = formatBytes\(usage\.budgetBytes\)/);
  });
});

describe('floating notifications', () => {
  it('pins the notification host to the viewport top-right, above the flow', () => {
    expect(CSS).toMatch(/\.toastHost\s*\{[^}]*position:\s*fixed/s);
    expect(CSS).toMatch(/\.toastHost\s*\{[^}]*top:/s);
    expect(CSS).toMatch(/\.toastHost\s*\{[^}]*right:/s);
    // Long copy wraps inside the card instead of widening it off-screen.
    expect(CSS).toMatch(/\.toast\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    // The overlay must not swallow clicks on the header/editor underneath.
    expect(CSS).toMatch(/\.toast\s*\{[^}]*pointer-events:\s*none/s);
    expect(CSS).toMatch(/\.toast \.toastClose\s*\{[^}]*pointer-events:\s*auto/s);
  });

  it('styles every notification kind, including success', () => {
    for (const kind of ['info', 'success', 'warn', 'error']) {
      expect(CSS).toMatch(new RegExp(`\\.toast\\.${kind}\\s*\\{`));
    }
    expect(MAIN).toMatch(/type ToastKind = 'info' \| 'warn' \| 'error' \| 'success'/);
  });

  it('shows the download prompt as a fixed top-right overlay, not an inline banner', () => {
    expect(CSS).toMatch(/\.netWarn\s*\{[^}]*position:\s*fixed/s);
    expect(CSS).toMatch(/\.netWarn\s*\{[^}]*top:/s);
    expect(CSS).toMatch(/\.netWarn\s*\{[^}]*right:/s);
    expect(CSS).toMatch(/\.netWarn\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    expect(CSS).toMatch(/\.netWarn\s*\{[^}]*pointer-events:\s*none/s);
    expect(CSS).toMatch(/\.netWarn button\s*\{[^}]*pointer-events:\s*auto/s);
    expect(CSS).not.toMatch(/\.netWarn\s*\{[^}]*margin-bottom:\s*0\.75rem/s);
  });

  it('stacks the error recovery panel in the fixed notification host', () => {
    // The download-failure panel used to sit in the studio flow and push the
    // content down; it now shares the top-right notification stack.
    expect(HTML.indexOf('id="recovery"')).toBeGreaterThan(HTML.indexOf('id="toastHost"'));
    expect(HTML.indexOf('id="recovery"')).toBeLessThan(HTML.indexOf('id="studioWorkspace"'));
    expect(CSS).toMatch(/\.recovery\s*\{[^}]*pointer-events:\s*none/s);
    expect(CSS).toMatch(/\.recovery \.actions\s*\{[^}]*pointer-events:\s*auto/s);
    expect(CSS).toMatch(/\.recovery\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    // A boot failure must not cover the landing header's Studio button.
    expect(CSS).toMatch(/body:not\(\.studio-open\) \.recovery:not\(\[hidden\]\)\s*\{[^}]*display:\s*none/s);
  });

  it('waits for the user before a run downloads the model over mobile data', () => {
    // The old path confirmed on the user's behalf when a photo was selected.
    expect(MAIN).not.toMatch(/A model download that was paused at the metered-connection prompt resumes/);
    expect(MAIN).toMatch(/const canDownload = await ensureModelLoaded\(\)/);
    expect(MAIN).toMatch(/function ensureModelLoaded\(/);
    expect(MAIN).toMatch(/const confirmed = await requestDownloadConfirmation\(\)/);
    expect(MAIN).toMatch(/function requestDownloadConfirmation\(\): Promise<boolean>/);
    // A dismissed prompt cancels the run instead of leaving it waiting forever.
    expect(MAIN).toMatch(/if \(!canDownload\)\s*\{/);
  });
});
