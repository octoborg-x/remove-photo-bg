// Main thread: orchestrates the Phase 2 product workflow.
// - loads a local test image
// - auto-loads the default model on page start (selectable, per-model + per-
//   provider buckets/persistence)
// - sends images to the worker for inference
// - composites the mask and renders/downloads a transparent PNG (and JPG)
import './fonts.css';
import './style.css';
import {
  imageDataToTensor,
  letterboxRect,
  MODEL_SIZE,
} from './features/background-removal/image-preprocess';
import {
  probabilityToMask,
  cropLetterboxMask,
  upscaleMask,
  applyMaskAdjust,
  DEFAULT_MASK_ADJUST,
  isMaskAdjust,
  type MaskAdjust,
} from './features/background-removal/mask-postprocess';
import { composeResult, previewSize } from './features/background-removal/composite';
import {
  initialBrushHistory,
  pushBrushStroke,
  redoBrushStroke,
  replayBrushStrokes,
  undoBrushStroke,
  canRedoBrush,
  canUndoBrush,
  type BrushHistory,
  type BrushStroke,
  type BrushTool,
} from './features/background-removal/brush-edit';
import { autoContourCleanup } from './features/background-removal/contour-cleanup';
import { recoverForegroundMask, despeckleRecoveredMask } from './features/background-removal/mask-recovery';
import { isIslandCleanup, islandFraction } from './features/background-removal/island-cleanup';
import {
  rawMaskStats,
  formatRawMaskStats,
  isSuspectRawMask,
  emptyRawMaskStats,
  type RawMaskStats,
} from './features/diagnostics/raw-mask-stats';
import {
  outputAlphaStats,
  classifyOutputAlpha,
  outputAlphaWarning,
  transitionBandFraction,
  formatOutputAlphaStats,
} from './features/diagnostics/output-alpha';
import {
  buildDiagnosticReport,
  formatDiagnosticReport,
} from './features/diagnostics/diagnostic-report';
import { cropMaskFloat, alphaToBytes, bytesToAlpha, lumaFromRgba, resizeMaskFloat } from './features/background-removal/mask-resize';
import {
  planTiles,
  TileStitcher,
  recommendTiling,
  TILING_MIN_LONG_SIDE,
  type TileGrid,
} from './features/background-removal/tiling';
import {
  initialSession,
  reduceSession,
  activeEntry,
  summarizeLibrary,
  formatBytes,
  type SessionEntry,
  type SessionState,
} from './features/background-removal/session-library';
import { RefinementRunner } from './features/background-removal/refinement-client';
import {
  refinementConfigFromParams,
  resolveRefinementConfig,
  type FastRefinementConfig,
} from './features/background-removal/refinement-config';
import {
  canvasToDataUrl,
  canEncode,
  exportFormatInfo,
  isExportFormat,
  EXPORT_FORMATS,
  DEFAULT_EXPORT_FORMAT,
  type ExportFormat,
} from './features/background-removal/export-image';
import { createZipBlob, dataUrlToBytes } from './features/background-removal/zip';
import {
  validateFileTypeAndSize,
  validateDimensions,
  DEFAULT_UPLOAD_LIMITS,
} from './features/background-removal/image-validation';
import {
  recommendSourceScale,
  type SourceScaleDecision,
} from './features/background-removal/adaptive-downscale';
import {
  ensureAssetCache,
  cachedAssetCount,
  isUrlCached,
  onAssetCacheMessage,
  ASSET_BASE,
} from './features/background-removal/asset-cache';
import { describeProgress, phaseForStage, PHASE_LABELS } from './features/background-removal/load-progress';
import {
  estimateInferenceMs,
  overallPercent,
  phaseExpectedMs,
  timeFraction,
  type ProcPhase,
} from './features/background-removal/processing-progress';
import {
  shouldConfirmDownload,
  downloadConfirmationText,
  shouldAutoFetchModel,
  currentConnectionClass,
  connectionChangeAction,
  meteredSwitchNotice,
  readDeviceMobile,
  type ConnectionClass,
} from './features/background-removal/network-preflight';
import {
  detectWebGpu,
  isProviderChoice,
  PROVIDER_LABELS,
  webGpuRuntimeHosted,
} from './features/background-removal/provider-gate';
import {
  fetchModelsManifest,
  defaultModelId,
  resolveModelParam,
} from './features/background-removal/model-manifest';
import { initCompareSliders } from './features/compare-slider';
import { initShowcaseGallery } from './features/showcase-gallery';
import { initSupportCarousel } from './features/support-carousel';
import { initCommandPalette } from './features/command-palette';
import { initLandingWorkspace } from './features/workspace-preview';
import {
  isThemePreference,
  nextTheme,
  resolveTheme,
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from './features/theme';
import {
  DEFAULT_BACKGROUND,
  isBackgroundChoice,
  isTransparent,
  describeChoice,
  formatForChoice,
  toRgba,
  TRANSPARENT,
  type BackgroundChoice,
} from './features/background-removal/background-color';
import {
  initialStudioView,
  reduceStudio,
  scrubConsoleLine,
  shouldInertSibling,
  stepPhase,
  stepTitle,
  STUDIO_TABS,
  tabEnabled,
  tabHasEngineControls,
  type StudioTab,
} from './features/background-removal/studio-view';
import {
  BULK_LIMIT,
  addBulkItem,
  bulkActiveCount,
  bulkCapacity,
  bulkCheckedCount,
  bulkDoneCount,
  bulkPendingCount,
  clearFinishedBulkItems,
  initialBulkState,
  removeBulkItem,
  removeBulkItems,
  selectBulkItem,
  selectedBulkItem,
  setBulkBackground,
  setBulkChecked,
  setBulkCheckedAll,
  updateBulkItem,
  type BulkItem,
  type BulkState,
} from './features/background-removal/bulk-batch';
import { classifyLogLine } from './features/background-removal/console-log';
import {
  pickColorFromScreen,
  supportsScreenPicker,
} from './features/background-removal/screen-picker';
import { initAnalyticsUi, type AnalyticsUi } from './features/analytics/ui';
import type { FailureReason } from './features/analytics/events';
import type {
  LoadStage,
  ModelManifestEntry,
  WorkerProgressMessage,
} from './features/background-removal/types';

// Replaced at build/serve time by the build-stamp plugin in vite.config.ts.
declare const __BUILD_ID__: string;

const consoleOutputEl = document.getElementById('consoleOutput')!;
const consoleScrollEl = document.querySelector<HTMLElement>('.consoleScroll')!;
const outputBox = document.getElementById('outputBox')!;
const outputSection = document.getElementById('outputSection')!;
const refineNoticeEl = document.getElementById('refineNotice')!;
const providerToggle = document.getElementById('providerToggle')! as HTMLSelectElement;
const downloadImageBtn = document.getElementById('downloadImage')! as HTMLAnchorElement;
const formatOptionsEl = document.getElementById('formatOptions')!;
const providerHint = document.getElementById('providerHint')!;
const maskThresholdInput = document.getElementById('maskThreshold')! as HTMLInputElement;
const maskThresholdValue = document.getElementById('maskThresholdValue')!;
const maskFeatherInput = document.getElementById('maskFeather')! as HTMLInputElement;
const maskFeatherValue = document.getElementById('maskFeatherValue')!;
const dropZone = document.getElementById('dropZone')!;
const limitBytesEl = document.getElementById('limitBytes')!;
const limitSideEl = document.getElementById('limitSide')!;
const processingLabel = document.getElementById('processingLabel')!;
const recoveryEl = document.getElementById('recovery')!;
const netWarnEl = document.getElementById('netWarn')!;
const netWarnText = document.getElementById('netWarnText')!;
const netWarnConfirm = document.getElementById('netWarnConfirm')! as HTMLButtonElement;
const netWarnDismiss = document.getElementById('netWarnDismiss')! as HTMLButtonElement;
const toastHost = document.getElementById('toastHost')!;

// ——— Studio layer, editor tabs, processing progress ———
const studioEl = document.getElementById('studio')!;
const studioLaunchBtn = document.getElementById('studioLaunch')! as HTMLButtonElement;
const studioCloseBtn = document.getElementById('studioClose')! as HTMLButtonElement;
const studioSplashEl = document.getElementById('studioSplash');
const procPctEl = document.getElementById('procPct')!;
const procStageLabelEl = document.getElementById('procStageLabel')!;
const tabButtons: Record<StudioTab, HTMLButtonElement> = {
  step: document.getElementById('tabStep')! as HTMLButtonElement,
  bulk: document.getElementById('tabBulk')! as HTMLButtonElement,
  library: document.getElementById('tabLibrary')! as HTMLButtonElement,
};
const tabPanels: Record<StudioTab, HTMLElement> = {
  step: document.getElementById('panelStep')!,
  bulk: document.getElementById('panelBulk')!,
  library: document.getElementById('panelLibrary')!,
};
const resultCompareToggleBtn = document.getElementById('resultCompareToggle') as HTMLButtonElement | null;
const stepInputEl = document.getElementById('stepInput')!;
const stepProcessingEl = document.getElementById('stepProcessing')!;
const stepResultEl = document.getElementById('stepResult')!;
const newPhotoBtn = document.getElementById('newPhotoBtn') as HTMLButtonElement | null;
const inputPreviewEl = document.getElementById('inputPreview')!;
const inputPreviewImg = document.getElementById('inputPreviewImg')! as HTMLImageElement;
const bgTransparentBtn = document.getElementById('bgTransparentBtn')! as HTMLButtonElement;
const bgColorPicker = document.getElementById('bgColorPicker')! as HTMLInputElement;
const bgColorSwatch = document.getElementById('bgColorSwatch')!;
const bgEyeDropperBtn = document.getElementById('bgEyeDropper')! as HTMLButtonElement;
const bgAlphaInput = document.getElementById('bgAlpha')! as HTMLInputElement;
const bgAlphaValue = document.getElementById('bgAlphaValue')!;
const bgCurrentEl = document.getElementById('bgCurrent')!;
const privacyToggle = document.getElementById('privacyToggle')! as HTMLButtonElement;
const privacyStatement = document.getElementById('privacyStatement')!;
const siteHeaderEl = document.getElementById('siteHeader')!;
const studioGridEl = document.querySelector<HTMLElement>('.studioGrid')!;
const consoleToggleBtn = document.getElementById('consoleToggle')! as HTMLButtonElement;
const consoleCloseBtn = document.getElementById('consoleClose')! as HTMLButtonElement;
const deviceReportBtn = document.getElementById('copyReport')! as HTMLButtonElement;
const consoleResizeEl = document.getElementById('consoleResize')!;
const consoleCardEl = document.querySelector<HTMLElement>('.consoleCard')!;
// Result-tab settings sidebar (engine controls). Declared here with the other
// studio refs because renderStudioView() (below) reads the top-bar toggle.
const settingsSidebarEl = document.getElementById('settingsSidebar') as HTMLElement | null;
const sidebarToggleBtn = document.getElementById('sidebarToggle') as HTMLButtonElement | null;
const sidebarCollapseBtn = document.getElementById('sidebarCollapse') as HTMLButtonElement | null;
const sidebarResizeEl = document.getElementById('sidebarResize');
// The export (background + format + download) section, placed to the right of
// the settings sidebar inside the active tab body.
const exportBarEl = document.getElementById('exportBar') as HTMLElement | null;
const bottomBarCollapseBtn = document.getElementById('bottomBarCollapse') as HTMLButtonElement | null;
// Manual retouch layer (Result tab only): an overlay edit button on the image
// and a compact panel that swaps in for the background/export block.
const resultEditToggleBtn = document.getElementById('resultEditToggle') as HTMLButtonElement | null;
const retouchPanelEl = document.getElementById('retouchPanel') as HTMLElement | null;
const retouchToolButtons: Record<BrushTool, HTMLButtonElement | null> = {
  restore: document.getElementById('retouchRestore') as HTMLButtonElement | null,
  erase: document.getElementById('retouchErase') as HTMLButtonElement | null,
};
const retouchSizeInput = document.getElementById('retouchSize') as HTMLInputElement | null;
const retouchSizeValueEl = document.getElementById('retouchSizeValue');
const retouchFeatherInput = document.getElementById('retouchFeather') as HTMLInputElement | null;
const retouchFeatherValueEl = document.getElementById('retouchFeatherValue');
const retouchAutoCleanupBtn = document.getElementById('retouchAutoCleanup') as HTMLButtonElement | null;
const retouchUndoBtn = document.getElementById('retouchUndo') as HTMLButtonElement | null;
const retouchRedoBtn = document.getElementById('retouchRedo') as HTMLButtonElement | null;
const retouchSaveBtn = document.getElementById('retouchSave') as HTMLButtonElement | null;
const retouchCancelBtn = document.getElementById('retouchCancel') as HTMLButtonElement | null;
// Bulk queue: up to five photos processed one after another.
const bulkPickBtn = document.getElementById('bulkPick') as HTMLButtonElement | null;
const bulkProcessBtn = document.getElementById('bulkProcess') as HTMLButtonElement | null;
const bulkGridEl = document.getElementById('bulkGrid');
const bulkEmptyEl = document.getElementById('bulkEmpty');
const bulkCountEl = document.getElementById('bulkCount');
const bulkStatusEl = document.getElementById('bulkStatus');
const bulkDownloadAllBtn = document.getElementById('bulkDownloadAll') as HTMLButtonElement | null;
const bulkSelectAllEl = document.getElementById('bulkSelectAll') as HTMLInputElement | null;
const bulkSelectionCountEl = document.getElementById('bulkSelectionCount');
const bulkDeleteSelectedBtn = document.getElementById('bulkDeleteSelected') as HTMLButtonElement | null;
const bulkClearFinishedBtn = document.getElementById('bulkClearFinished') as HTMLButtonElement | null;
const bulkBgColorInput = document.getElementById('bulkBgColor') as HTMLInputElement | null;
const bulkBgAlphaInput = document.getElementById('bulkBgAlpha') as HTMLInputElement | null;
const bulkBgAlphaValueEl = document.getElementById('bulkBgAlphaValue');
const bulkBgApplyBtn = document.getElementById('bulkBgApply') as HTMLButtonElement | null;
const bulkBgTransparentBtn = document.getElementById('bulkBgTransparent') as HTMLButtonElement | null;
// Session library controls.
const libraryGridEl = document.getElementById('libraryGrid');
const libraryEmptyEl = document.getElementById('libraryEmpty');
const libraryClearBtn = document.getElementById('libraryClear') as HTMLButtonElement | null;
const librarySaveToggleEl = document.getElementById('librarySaveToggle') as HTMLButtonElement | null;
const librarySaveHintEl = document.getElementById('librarySaveHint');
const libraryStatsEl = document.getElementById('libraryStats');
const libraryFilterInput = document.getElementById('libraryFilter') as HTMLInputElement | null;
const librarySelectAllEl = document.getElementById('librarySelectAll') as HTMLInputElement | null;
const librarySelectionCountEl = document.getElementById('librarySelectionCount');
const libraryExportSelectedBtn = document.getElementById('libraryExportSelected') as HTMLButtonElement | null;
// The workspace whose width bounds the sidebar drag (it is shared by all tabs).
const resultWorkspaceEl = document.getElementById('studioWorkspace');
// Tiled-inference + edge-refinement engine controls (shared sidebar).
const tilingSelect = document.getElementById('tilingSelect') as HTMLSelectElement | null;
const tilingValueEl = document.getElementById('tilingValue');
const tilingHintEl = document.getElementById('tilingHint');
const tilingAdviceEl = document.getElementById('tilingAdvice');
const tilingApplyBtn = document.getElementById('tilingApply') as HTMLButtonElement | null;
const refineToggle = document.getElementById('refineToggle') as HTMLSelectElement | null;
const refineValueEl = document.getElementById('refineValue');
const refineFieldEl = document.getElementById('refineField');
const refineStrengthInput = document.getElementById('refineStrength') as HTMLInputElement | null;
const refineStrengthValueEl = document.getElementById('refineStrengthValue');
const refineEdgeSensitivityInput = document.getElementById('refineEdgeSensitivity') as HTMLInputElement | null;
const refineEdgeSensitivityValueEl = document.getElementById('refineEdgeSensitivityValue');
const islandCleanupSelect = document.getElementById('islandCleanupSelect') as HTMLSelectElement | null;
const islandCleanupValueEl = document.getElementById('islandCleanupValue');
let studioView = initialStudioView();

// ——— Manual retouch state (declared before the first render) ———
// The session is a working copy of the mask at preview and full resolution. The
// committed result canvases are never touched until Save, so Cancel is exactly
// pixel-for-pixel. Strokes are recorded in the preview canvas's coordinate
// space and replayed onto the full-resolution grid on Save.
let lastResultAlpha: Uint8ClampedArray | null = null;
let retouchSession: RetouchSession | null = null;
let retouchModeOpen = false;
let retouchOverlay: HTMLCanvasElement | null = null;
const RETOUCH_DEFAULT_SIZE = 48;
const RETOUCH_DEFAULT_FEATHER = 40; // percent
// Read by updateRetouchUi() during the first render, so declared here too.
let resultCompareFigure: HTMLElement | null = null;
let resultCompareOn = false;

// ——— Bulk queue ———
// The source blobs and full-resolution cut-outs are kept here, keyed by the ids
// the pure bulk state assigns. Object URLs live on the state entries.
let bulkState: BulkState = initialBulkState();
const bulkBlobs = new Map<number, Blob>();
const bulkResults = new Map<number, HTMLCanvasElement>();
let bulkBatchRunning = false;
// While a batch owns the engine its progress stays visible; clicking another tab
// releases this pin so the user is never yanked back.
let bulkTabPinned = false;

// ——— Session library ———
// The images processed during this browser session. Pure state lives in
// session-library.ts; the blobs (for re-opening an entry) and the display name
// are kept here, on the main thread. Nothing is persisted.
let session: SessionState = initialSession();
const libraryBlobs = new Map<number, Blob>();
// The full-resolution PNG cut-out for every completed library version, kept so
// a version can be re-opened, re-composited on another background and
// downloaded without running inference again.
const libraryResultBlobs = new Map<number, Blob>();
// The library entry the current run's result belongs to. A preview and its
// refined final update the same entry; a fresh re-process adds a new version.
let currentRunStoredEntryId: number | null = null;
// Guards against a slow PNG encode from an older run landing after a newer run
// has started (the queue is serial, the token is the run identity).
let libraryRunToken = 0;
// When off, new cut-outs are neither added to the library nor written into it.
// The preference is kept so a user who turned saving off is not re-enrolled by a
// reload (the library itself is still session-only and cleared on reload).
const LS_LIBRARY_SAVE = 'remove-bg:library-save';
let librarySavingEnabled =
  loadPref<boolean>(LS_LIBRARY_SAVE, (v): v is boolean => typeof v === 'boolean') ?? true;
let currentImageName = 'Photo';
// Library view state: the name filter and the entries ticked for export.
let libraryFilterQuery = '';
const libraryChecked = new Set<number>();

// Disclose the real limits in the UI (MVP §6) rather than hardcoding them in the
// markup, so a changed limit never leaves stale copy on the page.
limitBytesEl.textContent = `${Math.round(DEFAULT_UPLOAD_LIMITS.maxBytes / 1048576)} MB`;
limitSideEl.textContent = String(DEFAULT_UPLOAD_LIMITS.maxLongestSide);

// ——— Studio layer + editor tabs ———
// The studio opens as a full-page layer (its own top bar + workspace) launched
// from the header. The editor has one step tab whose label follows the current
// step (Photo → Processing → Result), plus the Bulk queue and the Library.
function renderStudioView(): void {
  for (const tab of STUDIO_TABS) {
    const selected = studioView.tab === tab;
    tabButtons[tab].setAttribute('aria-selected', String(selected));
    tabButtons[tab].disabled = !tabEnabled(studioView, tab) && !selected;
    tabPanels[tab].hidden = !selected;
  }
  const phase = stepPhase(studioView);
  tabButtons.step.textContent = stepTitle(studioView);
  stepInputEl.hidden = phase !== 'input';
  stepProcessingEl.hidden = phase !== 'processing';
  stepResultEl.hidden = phase !== 'result';
  if (studioView.percent === null) {
    procPctEl.textContent = '—';
  } else {
    procPctEl.textContent = `${studioView.percent}%`;
  }
  // While a run is in flight, the console is marked busy so the status label
  // animates. (The console is a flat terminal — no thread labels to sweep.)
  consoleCardEl.dataset.running = String(studioView.running);
  // The refinement banner sits over the already-usable preview while the edge
  // stage runs, and disappears the instant the refined result is swapped in.
  refineNoticeEl.hidden = !studioView.refining;
  // The console and engine controls belong to the step editor. Leaving that tab
  // closes them and disables their top-bar toggles so a queue tab cannot turn
  // them back on.
  const engineTab = tabHasEngineControls(studioView.tab);
  if (!engineTab) {
    setConsoleVisible(false);
    setSidebarCollapsed(true);
  }
  consoleToggleBtn.disabled = !engineTab;
  if (sidebarToggleBtn) sidebarToggleBtn.disabled = !engineTab;
  updateExportBarVisibility();
  updateRetouchUi();
  updateBulkStatus();
}

function setStudioTab(tab: StudioTab, force = false): void {
  if (!force && !tabEnabled(studioView, tab)) return;
  // Retouch belongs to the step result; leaving the step tab discards an open
  // session exactly like Cancel.
  if (retouchModeOpen && tab !== 'step') cancelRetouchMode(true);
  if (bulkBatchRunning && tab !== 'bulk') bulkTabPinned = false;
  studioView = { ...studioView, tab };
  renderStudioView();
  if (tab === 'bulk') renderBulk();
}

// The re-process button's visibility depends on the studio's running/result
// state, so it is refreshed alongside every view transition (the helper itself
// is declared below, with the mask controls it also depends on).
function applyStudioView(): void {
  if (bulkBatchRunning && bulkTabPinned) studioView = { ...studioView, tab: 'bulk' };
  renderStudioView();
  updateReprocessButton();
}

function studioSelectImage(): void {
  studioView = reduceStudio(studioView, { type: 'select-image' });
  applyStudioView();
}

function studioRunStart(): void {
  studioView = reduceStudio(studioView, { type: 'run-start' });
  applyStudioView();
}

function studioProgress(percent: number | null): void {
  studioView = reduceStudio(studioView, { type: 'progress', percent });
  applyStudioView();
}

function studioPreview(): void {
  studioView = reduceStudio(studioView, { type: 'preview' });
  applyStudioView();
}

function studioResult(): void {
  studioView = reduceStudio(studioView, { type: 'result' });
  applyStudioView();
}

function studioError(): void {
  studioView = reduceStudio(studioView, { type: 'error' });
  applyStudioView();
}

// The studio covers the page, so everything behind it must leave the tab order
// and the accessibility tree. Walking up from the studio and inerting each
// ancestor's siblings covers the whole page (header, footer, other sections)
// without a wrapper element.
function setBackgroundInert(on: boolean): void {
  let node: HTMLElement = studioEl;
  while (node.parentElement) {
    for (const sibling of Array.from(node.parentElement.children)) {
      const el = sibling as HTMLElement;
      if (shouldInertSibling(el.id, el === node)) el.inert = on;
    }
    node = node.parentElement;
  }
}

const STUDIO_SPLASH_MS = 1000;
const STUDIO_SPLASH_FADE_MS = 400;
let studioSplashTimer: number | null = null;
let studioSplashFadeTimer: number | null = null;

function playStudioSplash(): void {
  const splash = studioSplashEl;
  if (!splash) return;
  if (studioSplashTimer != null) window.clearTimeout(studioSplashTimer);
  if (studioSplashFadeTimer != null) window.clearTimeout(studioSplashFadeTimer);
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  splash.hidden = false;
  splash.classList.remove('is-hidden');
  // Restart the sheen and spin animations on every open.
  splash.getBoundingClientRect();
  studioSplashTimer = window.setTimeout(() => {
    splash.classList.add('is-hidden');
    studioSplashFadeTimer = window.setTimeout(() => {
      splash.hidden = true;
      studioSplashFadeTimer = null;
    }, reduced ? 0 : STUDIO_SPLASH_FADE_MS);
    studioSplashTimer = null;
  }, reduced ? 0 : STUDIO_SPLASH_MS);
}

function hideStudioSplash(): void {
  if (studioSplashTimer != null) window.clearTimeout(studioSplashTimer);
  if (studioSplashFadeTimer != null) window.clearTimeout(studioSplashFadeTimer);
  studioSplashTimer = null;
  studioSplashFadeTimer = null;
  if (!studioSplashEl) return;
  studioSplashEl.classList.add('is-hidden');
  studioSplashEl.hidden = true;
}

function openStudio(): void {
  closeMenu();
  studioEl.classList.add('is-open');
  studioEl.setAttribute('aria-hidden', 'false');
  document.body.classList.add('studio-open');
  setBackgroundInert(true);
  studioEl.scrollTop = 0;
  renderStudioView();
  playStudioSplash();
  // The workspace has a size again, so a dragged console height can be re-clamped.
  if (consoleHeightPx != null) applyConsoleHeight(consoleHeightPx);
  // A terminal opens on its newest line.
  scrollConsoleToBottom();
  (document.activeElement as HTMLElement | null)?.blur();
  studioCloseBtn.focus();
}

function closeStudio(): void {
  studioEl.classList.remove('is-open');
  studioEl.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('studio-open');
  setBackgroundInert(false);
  hideStudioSplash();
  studioLaunchBtn.focus();
}

studioLaunchBtn.addEventListener('click', openStudio);
studioCloseBtn.addEventListener('click', closeStudio);
document.querySelectorAll<HTMLElement>('[data-studio-launch]').forEach((btn) => {
  btn.addEventListener('click', openStudio);
});
for (const tab of STUDIO_TABS) {
  tabButtons[tab].addEventListener('click', () => setStudioTab(tab));
}

// ——— Console column: show/hide, close, and drag-resize ———
// The console drags between 20% and 50% of the workspace height; its resting
// default is the 20% track in CSS. `null` means "use that default"; a number is
// an explicit, clamped pixel height.
const CONSOLE_MAX_FRACTION = 0.5;
const CONSOLE_MIN_FRACTION = 0.2;
const CONSOLE_MIN_PX = 96;
let consoleHeightPx: number | null = null;

function setConsoleVisible(visible: boolean): void {
  if (visible && !tabHasEngineControls(studioView.tab)) return;
  studioGridEl.dataset.console = visible ? 'shown' : 'hidden';
  consoleToggleBtn.setAttribute('aria-pressed', String(visible));
  consoleToggleBtn.setAttribute('aria-label', visible ? 'Hide console' : 'Show console');
  if (visible) {
    applyConsoleHeight(consoleHeightPx);
    // Lines printed while the console was hidden left it at the top; a terminal
    // opens on its newest line.
    scrollConsoleToBottom();
  }
}

// Pins the console to an explicit pixel height (or back to the default) so a
// drag can resize it. The value is clamped to the 20%–50% range.
function applyConsoleHeight(px: number | null): void {
  const gridH = studioGridEl.getBoundingClientRect().height;
  if (!gridH) return;
  if (px == null) {
    consoleHeightPx = null;
    studioGridEl.style.removeProperty('--console-h');
    return;
  }
  const max = gridH * CONSOLE_MAX_FRACTION;
  const min = Math.max(CONSOLE_MIN_PX, gridH * CONSOLE_MIN_FRACTION);
  const height = Math.max(min, Math.min(px, max));
  consoleHeightPx = height;
  studioGridEl.style.setProperty('--console-h', `${Math.round(height)}px`);
}

let resizeStartY = 0;
let resizeStartH = 0;
let resizing = false;

consoleResizeEl.addEventListener('pointerdown', (e) => {
  const pointer = e as PointerEvent;
  const col = document.getElementById('studioConsoleCol');
  if (!col) return;
  resizing = true;
  resizeStartY = pointer.clientY;
  resizeStartH = col.getBoundingClientRect().height;
  consoleResizeEl.setPointerCapture(pointer.pointerId);
  document.body.classList.add('console-resizing');
});
consoleResizeEl.addEventListener('pointermove', (e) => {
  if (!resizing) return;
  const pointer = e as PointerEvent;
  // Dragging the handle down moves the console's top edge down, so the height
  // shrinks by the same delta.
  applyConsoleHeight(resizeStartH - (pointer.clientY - resizeStartY));
});
function endResize(): void {
  if (!resizing) return;
  resizing = false;
  document.body.classList.remove('console-resizing');
}
consoleResizeEl.addEventListener('pointerup', endResize);
consoleResizeEl.addEventListener('pointercancel', endResize);
consoleResizeEl.addEventListener('keydown', (e) => {
  const key = (e as KeyboardEvent).key;
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return;
  e.preventDefault();
  const col = document.getElementById('studioConsoleCol');
  const current = col ? col.getBoundingClientRect().height : 0;
  applyConsoleHeight(current + (key === 'ArrowUp' ? 24 : -24));
});
window.addEventListener('resize', () => {
  if (consoleHeightPx != null) applyConsoleHeight(consoleHeightPx);
});

consoleToggleBtn.addEventListener('click', () => {
  setConsoleVisible(studioGridEl.dataset.console === 'hidden');
});
consoleCloseBtn.addEventListener('click', () => {
  setConsoleVisible(false);
  consoleToggleBtn.focus();
});

// ——— Slide-in menu (burger) ———
// Right-hand panel holding the navigation, the user profile and the theme mode.
const menuToggleBtn = document.getElementById('menuToggle')! as HTMLButtonElement;
const menuPanelEl = document.getElementById('menuPanel')!;
const menuScrimEl = document.getElementById('menuScrim')!;
const menuCloseBtn = document.getElementById('menuClose')! as HTMLButtonElement;

function openMenu(): void {
  menuScrimEl.hidden = false;
  menuPanelEl.classList.add('is-open');
  menuPanelEl.setAttribute('aria-hidden', 'false');
  menuToggleBtn.setAttribute('aria-expanded', 'true');
  menuCloseBtn.focus();
}

function closeMenu(): void {
  if (!menuPanelEl.classList.contains('is-open')) return;
  menuPanelEl.classList.remove('is-open');
  menuPanelEl.setAttribute('aria-hidden', 'true');
  menuToggleBtn.setAttribute('aria-expanded', 'false');
  menuScrimEl.hidden = true;
}

menuToggleBtn.addEventListener('click', () => {
  if (menuPanelEl.classList.contains('is-open')) closeMenu();
  else openMenu();
});
menuCloseBtn.addEventListener('click', closeMenu);
menuScrimEl.addEventListener('click', closeMenu);
// Following a menu link closes the panel so the target section is visible.
menuPanelEl.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener('click', closeMenu);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const cmdDialog = document.getElementById('cmdPalette');
  if (cmdDialog && !cmdDialog.hidden) return;
  if (menuPanelEl.classList.contains('is-open')) closeMenu();
  else if (studioEl.classList.contains('is-open')) closeStudio();
});
renderStudioView();

// ——— Theme (light/dark) ———
// The page follows the operating system by default; the toggle stores an
// explicit override. The resolved mode is applied as `data-theme` on <html>,
// which every colour token reads (src/style.css). The same choice is mirrored on
// the theme controls (header + studio), so both stay in sync.
const themeToggles = [
  document.getElementById('themeToggle'),
  document.getElementById('studioThemeToggle'),
].filter((el): el is HTMLButtonElement => el instanceof HTMLButtonElement);
const menuThemeModes = Array.from(
  document.querySelectorAll<HTMLButtonElement>('[data-theme-mode]'),
);

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function applyTheme(preference: ThemePreference): void {
  const resolved = resolveTheme(preference, systemPrefersDark());
  // With no override, removing the attribute lets `color-scheme: light dark`
  // follow the OS; an explicit choice pins it.
  if (preference === 'system') document.documentElement.removeAttribute(THEME_ATTRIBUTE);
  else document.documentElement.setAttribute(THEME_ATTRIBUTE, preference);
  for (const btn of themeToggles) {
    btn.setAttribute('aria-pressed', String(preference !== 'system'));
    btn.title =
      preference === 'system'
        ? `Theme: follow system (${resolved})`
        : `Theme: ${resolved}`;
  }
  // Keep the menu's Light/Dark/System control in step with the header toggle.
  for (const btn of menuThemeModes) {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeMode === preference));
  }
}

/** Pin an explicit mode (or 'system') from the menu's theme control. */
function setThemePreference(preference: ThemePreference): void {
  savePref(THEME_STORAGE_KEY, preference);
  document.documentElement.classList.add('theme-transition');
  applyTheme(preference);
  window.setTimeout(() => document.documentElement.classList.remove('theme-transition'), 300);
}

function currentPreference(): ThemePreference {
  const stored = loadPref<ThemePreference>(THEME_STORAGE_KEY, isThemePreference);
  return stored ?? 'system';
}

function toggleTheme(): void {
  const resolved = resolveTheme(currentPreference(), systemPrefersDark());
  const preference = nextTheme(resolved);
  savePref(THEME_STORAGE_KEY, preference);
  // Animate the swap, then drop the transition class so later changes (and
  // initial paint) are instant.
  document.documentElement.classList.add('theme-transition');
  applyTheme(preference);
  window.setTimeout(() => document.documentElement.classList.remove('theme-transition'), 300);
}

for (const btn of themeToggles) btn.addEventListener('click', toggleTheme);
for (const btn of menuThemeModes) {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.themeMode;
    if (isThemePreference(mode)) setThemePreference(mode);
  });
}
applyTheme(currentPreference());
// Keep 'system' in step with an OS theme change while no override is set.
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (currentPreference() === 'system') applyTheme('system');
});

// Enable transitions only after the first frame so the initial paint uses the
// final hidden/uncollapsed state instead of animating from the CSS defaults.
requestAnimationFrame(() => document.documentElement.classList.add('ui-ready'));

// ——— Floating notifications ———
// Top-right, fixed over the page, stacked vertically. Each dismisses itself after
// 10 s and has a close button; several at once stack downward in the order they
// arrived. The host is a direct child of <body>, so a notification never reflows
// the page and is never clipped by a scrolling column.
type ToastKind = 'info' | 'warn' | 'error' | 'success';
const TOAST_DEFAULT_MS = 10000;

function showToast(
  message: string,
  opts: {
    kind?: ToastKind;
    title?: string;
    durationMs?: number;
  } = {},
): void {
  const kind = opts.kind ?? 'info';
  const toast = document.createElement('div');
  toast.className = kind === 'info' ? 'toast' : `toast ${kind}`;
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');

  const body = document.createElement('div');
  body.className = 'toastBody';
  if (opts.title) {
    const title = document.createElement('strong');
    title.className = 'toastTitle';
    title.textContent = opts.title;
    body.appendChild(title);
  }
  body.appendChild(document.createTextNode(message));

  const close = document.createElement('button');
  close.className = 'toastClose';
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.textContent = '×';

  const remove = (): void => {
    clearTimeout(timer);
    toast.remove();
  };
  close.addEventListener('click', remove);

  toast.appendChild(body);
  toast.appendChild(close);
  toastHost.appendChild(toast);
  const timer = setTimeout(remove, opts.durationMs ?? TOAST_DEFAULT_MS);
}

// Persisted user preferences: provider and mask adjustments.
// Scrubbed to safe values on read so stale/corrupt entries are ignored.
const LS_PROVIDER = 'remove-bg:provider';
const LS_MASK_ADJUST = 'remove-bg:mask-adjust';
const LS_EXPORT_FORMAT = 'remove-bg:export-format';

function loadPref<T>(key: string, guard: (v: unknown) => v is T): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    const parsed: unknown = JSON.parse(raw);
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be full/blocked; persistence is a nice-to-have.
  }
}

let currentImage: HTMLImageElement | null = null;
let currentImageData: ImageData | null = null;
let currentObjectUrl: string | null = null;
// The step photo's object URL while a bulk batch swaps images through the same
// loader; the batch restores it when it finishes.
let protectedObjectUrl: string | null = null;
let worker: Worker | null = null;
let modelReady = false;
let modelError: string | null = null;
// True between posting a set-model and the worker's load-time/error reply, so a
// second caller (e.g. Remove background after a paused download) never
// double-posts the load.
let modelLoadInFlight = false;
// Set as soon as the worker posts anything at all; distinguishes "never started"
// from "working on a long download".
let workerResponded = false;
// Set when the worker script itself fails to start. A dead worker can never load
// a model, so the boot path must not auto-load over the error it already put on
// screen (that would replace the actionable error with a permanent "Loading…").
let workerFailed = false;
const modelWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

const WARM_RUNS = 1;
const WORKER_START_TIMEOUT_MS = 15000;
const timings: number[] = [];
let loadTimeMs = 0;

// ——— Diagnostic report state (Copy report) ———
// Raw-mask statistics measured from the model's original floating-point output
// (msg.mask), before any post-processing. Null until the first run.
let lastRawMaskStats: RawMaskStats | null = null;
// Structured GPU adapter facts from the worker (WebGPU path only).
let lastAdapterDetails: {
  vendor?: string | null;
  architecture?: string | null;
  device?: string | null;
  description?: string | null;
  features?: readonly string[];
  maxStorageBufferBindingSize?: number | null;
  maxBufferSize?: number | null;
} | null = null;
// Load/inference timings and execution state for the report. Distinguishing
// "a GPU adapter exists" from "a WebGPU session built" from "a run actually
// executed" is the whole point of the execution section.
let downloadMs: number | null = null;
let sessionInitMs: number | null = null;
let webgpuSessionInitialized = false;
let inferenceRan = false;
// The provider that ACTUALLY executed the last inference ('none' before any run),
// which can differ from `selectedProvider` after a GPU→WASM fallback.
let actualProvider: 'webgpu' | 'wasm' | 'none' = 'none';
let fallbackReason: string | null = null;
// Post-processing measurements + outcomes for the report.
let postprocessingMs: number | null = null;
let maskRecoveryTriggered = false;
let refinementSucceeded: boolean | null = null;
// Processing errors, kept so a report taken after a failure still carries them.
const diagnosticErrors: string[] = [];

// ——— Model + provider selection ———
let models: ModelManifestEntry[] = [];
let selectedModel: ModelManifestEntry | null = null;
let selectedProvider: 'webgpu' | 'wasm' = 'wasm';
// GPU availability is the app's actual decision; recorded so the device report
// can say why. webGpuRuntimeHosted distinguishes "browser has WebGPU" from
// "this host can actually serve the WebGPU-capable ORT bundle".
let gpuState: Awaited<ReturnType<typeof detectWebGpu>> | null = null;
let runtimeHasWebGpuBundle = false;
let maskAdjust: MaskAdjust = { ...DEFAULT_MASK_ADJUST };
const urlParams = new URLSearchParams(location.search);
// ?provider=, ?model= and the mask controls keep overriding for testing even
// with a saved pref.
const forcedProvider = urlParams.get('provider');
const forcedModel = urlParams.get('model');
// ?maxSourceSide= caps the decoded source for scripted runs and A/B checks. It
// is clamped by recommendSourceScale, so it can never exceed the upload cap.
const forcedMaxSourceSide = (() => {
  const raw = urlParams.get('maxSourceSide');
  if (raw == null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
})();

function readDeviceMemoryGb(): number | null {
  if (typeof navigator === 'undefined') return null;
  const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** The one place the page decides how large a decoded source may be. */
function sourceScaleDecision(width: number, height: number): SourceScaleDecision {
  return recommendSourceScale({
    width,
    height,
    deviceClass: readDeviceMobile() ? 'mobile' : 'desktop',
    deviceMemoryGb: readDeviceMemoryGb(),
    hardwareConcurrency: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? null : null,
    maxSourceSide: forcedMaxSourceSide,
  });
}

// Mask adjust prefs: read once, persisted on change. The URL params
// ?maskThreshold= and ?maskFeather= override for automated/headless runs.
function initMaskAdjust(): MaskAdjust {
  const raw = loadPref<MaskAdjust>(LS_MASK_ADJUST, isMaskAdjust);
  const fromUrl = (name: string): number => {
    const v = Number(urlParams.get(name));
    return Number.isFinite(v) ? v : NaN;
  };
  const threshold = Number.isFinite(fromUrl('maskThreshold'))
    ? Math.min(100, Math.max(0, fromUrl('maskThreshold')))
    : raw?.threshold ?? DEFAULT_MASK_ADJUST.threshold;
  const feather = Number.isFinite(fromUrl('maskFeather'))
    ? Math.min(64, Math.max(0, fromUrl('maskFeather')))
    : raw?.feather ?? DEFAULT_MASK_ADJUST.feather;
  return { threshold, feather };
}

function saveMaskAdjust(): void {
  savePref(LS_MASK_ADJUST, maskAdjust);
}

function applyMaskUi(): void {
  maskThresholdInput.value = String(maskAdjust.threshold);
  maskThresholdValue.textContent = maskAdjust.threshold > 0 ? `${maskAdjust.threshold}%` : 'off';
  maskFeatherInput.value = String(maskAdjust.feather);
  maskFeatherValue.textContent = maskAdjust.feather > 0 ? `${maskAdjust.feather}px` : 'off';
}

// Clears a previous result so a newly chosen photo never sits above a stale
// export, and hides the download section until a fresh mask is rendered.
function clearOutput(): void {
  // A new photo or a re-process discards any in-progress retouch session. The
  // edit was never committed, so dropping it is exactly a Cancel.
  if (retouchSession || retouchModeOpen) discardRetouchSession();
  // Cancel any queued library write from the result being replaced.
  libraryRunToken += 1;
  outputBox.innerHTML = '';
  outputBox.classList.remove('hasResultCompare');
  resultCompareFigure = null;
  downloadImageBtn.hidden = true;
  downloadImageBtn.removeAttribute('href');
  lastResultCanvas = null;
  lastPreviewCanvas = null;
  lastResultAlpha = null;
  setResultCompare(false);
  if (resultCompareToggleBtn) resultCompareToggleBtn.hidden = true;
  outputSection.hidden = true;
  updateExportBarVisibility();
}

// ——— Export format ———
// The composited cut-out is kept so changing the format (or the background)
// re-encodes without re-running inference.
let lastResultCanvas: HTMLCanvasElement | null = null;
// Bumped whenever a new cut-out is painted, so the export cache can never serve
// an encoding of a canvas that was repainted in place.
let resultRevision = 0;
// The on-screen preview, at most ≤450 px on its longest side, so switching the
// background or format never re-encodes a full-resolution PNG just to repaint
// the display. Rebuilt whenever a new result is composited.
let lastPreviewCanvas: HTMLCanvasElement | null = null;
// The before/after slider in the Result editor, reused across background changes.
// (`resultCompareFigure`/`resultCompareOn` are declared before the first render.)
let exportFormat: ExportFormat = initExportFormat();

// ——— Manual retouch session ———
interface RetouchSession {
  fullImage: ImageData;
  fullWidth: number;
  fullHeight: number;
  fullBaseAlpha: Float32Array;
  previewImage: ImageData;
  previewWidth: number;
  previewHeight: number;
  previewBaseAlpha: Float32Array;
  previewCleanupAlpha: Float32Array | null;
  history: BrushHistory;
  tool: BrushTool;
  /** Brush diameter in preview-canvas pixels. */
  size: number;
  /** Soft-edge fraction of the brush radius, 0..1. */
  feather: number;
  cleanupApplied: boolean;
  drawing: BrushStroke | null;
  saving: boolean;
}

function setResultCompare(on: boolean): void {
  resultCompareOn = on;
  if (resultCompareFigure) resultCompareFigure.dataset.compareOn = on ? 'true' : 'false';
  if (resultCompareToggleBtn) {
    resultCompareToggleBtn.setAttribute('aria-pressed', String(on));
    const label = on ? 'Hide comparison with the original' : 'Compare with the original photo';
    resultCompareToggleBtn.setAttribute('aria-label', label);
    resultCompareToggleBtn.setAttribute('title', label);
  }
}

resultCompareToggleBtn?.addEventListener('click', () => setResultCompare(!resultCompareOn));

function initExportFormat(): ExportFormat {
  const fromUrl = urlParams.get('format');
  if (fromUrl) {
    if (isExportFormat(fromUrl) && isFormatAvailable(fromUrl)) return fromUrl;
    log(`Ignoring unknown/unavailable ?format="${fromUrl}"; using ${DEFAULT_EXPORT_FORMAT}.`);
  }
  const pref = loadPref<ExportFormat>(LS_EXPORT_FORMAT, isExportFormat);
  if (pref && isFormatAvailable(pref)) return pref;
  return DEFAULT_EXPORT_FORMAT;
}

// A format the browser cannot encode (WebP on some builds) is never offered, so
// the user can never pick a format that silently produces a mislabelled file.
function isFormatAvailable(format: ExportFormat): boolean {
  return canEncode(format);
}

function renderFormatOptions(): void {
  formatOptionsEl.innerHTML = '';
  for (const format of EXPORT_FORMATS) {
    const available = isFormatAvailable(format.id);
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'exportFormat';
    input.value = format.id;
    input.checked = format.id === exportFormat;
    input.disabled = !available;
    input.addEventListener('change', () => {
      if (!input.checked) return;
      chooseExportFormat(format.id);
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode(format.label));
    if (!available) {
      const hint = document.createElement('span');
      hint.className = 'formatHint';
      hint.textContent = 'not supported';
      label.appendChild(hint);
    }
    formatOptionsEl.appendChild(label);
  }
}

function setExportFormat(format: ExportFormat): void {
  if (format === exportFormat || !isFormatAvailable(format)) return;
  exportFormat = format;
  savePref(LS_EXPORT_FORMAT, format);
  applyFormatUi();
  log(`Export format: ${exportFormatInfo(format).label}`);
}

/**
 * Drops a fully opaque background when an alpha-capable format is chosen.
 *
 * PNG/WebP exist to carry transparency, so selecting one is a request for a
 * transparent cut-out. A solid colour paints over that alpha and the file is
 * opaque even though the format supports alpha — the "PNG/WebP have no alpha"
 * report. A see-through colour (alpha < 100) already carries alpha, so it is
 * kept. Returns true when the background changed.
 */
function dropOpaqueBackgroundForAlpha(format: ExportFormat): boolean {
  if (!exportFormatInfo(format).supportsAlpha) return false;
  if (background.kind !== 'color' || background.alpha < 100) return false;
  background = { ...DEFAULT_BACKGROUND };
  saveBackground();
  return true;
}

/** The format radio is the user's explicit choice, so it may clear a colour. */
function chooseExportFormat(format: ExportFormat): void {
  if (dropOpaqueBackgroundForAlpha(format)) {
    updateBackgroundUi();
    renderResultPreview();
  }
  setExportFormat(format);
}

// Repoint the download action at the current context: the step result on the
// step tab, or the selected bulk cut-out on the Bulk tab.
function applyFormatUi(): void {
  renderFormatOptions();
  refreshExportActions();
}

function bulkDownloadName(item: BulkItem, extension: string): string {
  const base = item.name.replace(/\.[^.]+$/, '') || `photo-${item.id}`;
  return `${base}-background-removed-${item.width}x${item.height}.${extension}`;
}

// Encoding a full-resolution canvas is expensive, and the progress ticks repaint
// the view many times. Cache the encoded data URL per canvas + format + background.
let exportCache: { canvas: HTMLCanvasElement; revision: number; format: ExportFormat; bg: string; href: string } | null = null;

function refreshExportActions(): void {
  const info = exportFormatInfo(exportFormat);
  const onBulk = studioView.tab === 'bulk';
  const bulkItem = onBulk ? selectedBulkItem(bulkState) : null;
  const canvas = onBulk ? (bulkItem ? bulkResults.get(bulkItem.id) ?? null : null) : lastResultCanvas;
  if (canvas) {
    const bg = onBulk ? bulkItem?.background ?? background : background;
    const bgKey = `${bg.kind}|${bg.hex}|${bg.alpha}`;
    const cached =
      exportCache &&
      exportCache.canvas === canvas &&
      exportCache.revision === resultRevision &&
      exportCache.format === exportFormat &&
      exportCache.bg === bgKey
        ? exportCache.href
        : null;
    const href = cached ?? canvasToDataUrl(canvas, exportFormat, bg);
    exportCache = { canvas, revision: resultRevision, format: exportFormat, bg: bgKey, href };
    downloadImageBtn.textContent = `Download ${info.label}`;
    downloadImageBtn.href = href;
    downloadImageBtn.download = bulkItem
      ? bulkDownloadName(bulkItem, info.extension)
      : `background-removed-${canvas.width}x${canvas.height}.${info.extension}`;
    downloadImageBtn.hidden = false;
  } else {
    downloadImageBtn.hidden = true;
    downloadImageBtn.removeAttribute('href');
  }
  if (bulkDownloadAllBtn) {
    const done = bulkDoneCount(bulkState);
    const targets = bulkExportTargets();
    bulkDownloadAllBtn.hidden = !onBulk || done === 0;
    bulkDownloadAllBtn.textContent =
      targets.length < done ? `Download selected ZIP (${targets.length})` : `Download ZIP (${done})`;
    bulkDownloadAllBtn.disabled = targets.length === 0;
  }
}

// The background & export section is meaningful only where there is something
// to export: the step result, or a Bulk batch with at least one cut-out.
function updateExportBarVisibility(): void {
  if (!exportBarEl) return;
  const visible =
    studioView.tab === 'step'
      ? studioView.hasResult
      : studioView.tab === 'bulk'
        ? bulkDoneCount(bulkState) > 0
        : false;
  // The retouch panel takes this slot while editing; the background & export
  // block returns untouched when the session closes.
  exportBarEl.hidden = !visible || retouchModeOpen;
  if (visible && !retouchModeOpen) refreshExportActions();
}

// The Background & Export header can collapse its own body, mirroring the
// settings sidebar. The collapsed state stays put across tab switches.
function setExportBarCollapsed(collapsed: boolean): void {
  if (!exportBarEl) return;
  exportBarEl.dataset.collapsed = collapsed ? 'true' : 'false';
  if (!bottomBarCollapseBtn) return;
  bottomBarCollapseBtn.setAttribute('aria-pressed', String(!collapsed));
  bottomBarCollapseBtn.setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? 'Show background and export' : 'Hide background and export';
  bottomBarCollapseBtn.setAttribute('aria-label', label);
  bottomBarCollapseBtn.setAttribute('title', label);
}
bottomBarCollapseBtn?.addEventListener('click', () => {
  setExportBarCollapsed(exportBarEl?.dataset.collapsed !== 'true');
});
setExportBarCollapsed(false);

renderFormatOptions();

// The download is a plain `<a download>`; the click is the moment the browser
// download is initiated. We do not claim the file was saved to disk — only that
// a download action was started.
downloadImageBtn.addEventListener('click', () => {
  if (downloadImageBtn.hidden || !downloadImageBtn.getAttribute('href')) return;
  trackDownloadInitiated();
});

// ——— Background colour ———
// One system picker replaces the old swatch palette: a transparent toggle, the
// browser's native colour input, and a screen eyedropper (EyeDropper API). The
// alpha slider refines a chosen colour. The choice paints the result preview,
// feeds the export encoder and repaints the compare view, so all three agree.
const LS_BACKGROUND = 'remove-bg:background';
let background: BackgroundChoice = initBackground();

function initBackground(): BackgroundChoice {
  const fromUrl = urlParams.get('bg');
  if (fromUrl) {
    if (fromUrl === 'transparent') return DEFAULT_BACKGROUND;
    const m = /^([0-9a-f]{6})(?:-(\d{1,3}))?$/i.exec(fromUrl);
    if (m) {
      const alpha = m[2] ? Number(m[2]) : 100;
      return { kind: 'color', hex: `#${m[1].toLowerCase()}`, alpha: Math.max(0, Math.min(100, alpha)) };
    }
    log(`Ignoring unknown ?bg="${fromUrl}"; using a transparent background.`);
  }
  return loadPref<BackgroundChoice>(LS_BACKGROUND, isBackgroundChoice) ?? DEFAULT_BACKGROUND;
}

function saveBackground(): void {
  savePref(LS_BACKGROUND, background);
}

// Re-render the result preview from the stored cut-out, composited onto the
// chosen background. The preview is always a PNG (the only format that can show
// real transparency); a transparent choice lets the checkerboard show through.
// The ≤450 px display canvas is used so a background/format change never
// re-encodes a full-resolution PNG; the full-resolution cut-out still feeds the
// export (see `applyFormatUi`).
function renderResultPreview(): void {
  const display = lastPreviewCanvas ?? lastResultCanvas;
  if (!display) return;

  const afterSrc = canvasToDataUrl(display, 'png', background);
  // Build the slider once per result. Rebuilding it on every background change
  // would re-register its window listeners on each alpha-slider tick.
  let figure = resultCompareFigure;
  if (!figure || !figure.isConnected) {
    figure = document.createElement('figure');
    figure.className = 'compare resultCompare';
    figure.dataset.compare = '';
    figure.dataset.pos = '50';
    figure.setAttribute('aria-label', 'Before and after comparison');
    // The composite is first so the smoke harness (`#outputBox img`) still reads
    // the cut-out; the original sits on top, clipped to the left of the divider.
    figure.innerHTML = `
      <div class="compareStage">
        <img class="compareImg compareAfter" alt="Background removed" />
        <img class="compareImg compareBefore" alt="Original photo" />
        <div class="compareDivider" aria-hidden="true"><span class="compareGrip">↔</span></div>
      </div>
      <input class="compareRange" type="range" min="0" max="100" step="1" value="50"
        aria-label="Reveal the original photo: left is before, right is after" />
    `;
    outputBox.appendChild(figure);
    outputBox.classList.add('hasResultCompare');
    initCompareSliders(outputBox);
    resultCompareFigure = figure;
    setResultCompare(resultCompareOn);
    if (resultCompareToggleBtn) resultCompareToggleBtn.hidden = false;
  }
  // Size the stage to the photo instead of the full panel, so the checkerboard
  // is only behind the image and the cut-out uses the available height.
  figure.style.aspectRatio = `${display.width} / ${display.height}`;
  const after = figure.querySelector<HTMLImageElement>('.compareAfter');
  const before = figure.querySelector<HTMLImageElement>('.compareBefore');
  if (after) after.src = afterSrc;
  if (before) before.src = currentObjectUrl ?? '';
}

function updateBackgroundUi(): void {
  const color = background.kind === 'color';
  bgTransparentBtn.setAttribute('aria-pressed', String(isTransparent(background)));
  bgCurrentEl.textContent = describeChoice(background);
  // The alpha slider refines a chosen colour and is inert for a transparent
  // background. Leaving it live let a stray drag paint an opaque white
  // background, which silently flattened PNG/WebP exports.
  bgAlphaInput.disabled = !color;
  if (color) {
    bgColorPicker.value = background.hex;
    bgColorSwatch.style.setProperty('--picked', background.hex);
    bgAlphaInput.value = String(background.alpha);
    bgAlphaValue.textContent = `${background.alpha}%`;
  } else {
    bgAlphaInput.value = '100';
    bgAlphaValue.textContent = '—';
  }
}

// Apply a background choice: repaint the preview + compare, re-encode the export,
// and switch the format to match (transparent → PNG, solid colour → JPG).
function setBackground(choice: BackgroundChoice): void {
  background = choice;
  saveBackground();
  const target = formatForChoice(background);
  if (target !== exportFormat) setExportFormat(target);
  renderResultPreview();
  updateBackgroundUi();
  applyFormatUi();
  // A background change is a result-stage edit: keep the current tab.
  studioView = reduceStudio(studioView, { type: 'show-background' });
  renderStudioView();
  log(`Background: ${describeChoice(background)}`);
}

bgTransparentBtn.addEventListener('click', () =>
  setBackground({ kind: 'transparent', hex: background.hex, alpha: 100 }),
);
/** Alpha for a newly picked colour: keep the current colour's alpha, else 100. */
function colourPickAlpha(): number {
  return background.kind === 'color' ? Number(bgAlphaInput.value) : 100;
}
bgColorPicker.addEventListener('input', () =>
  setBackground({ kind: 'color', hex: bgColorPicker.value, alpha: colourPickAlpha() }),
);
bgAlphaInput.addEventListener('input', () => {
  if (background.kind !== 'color') return;
  setBackground({ kind: 'color', hex: background.hex, alpha: Number(bgAlphaInput.value) });
});
// Screen eyedropper: sample any pixel on the display. The button is disabled
// when the browser has no EyeDropper API, so it never looks broken.
if (!supportsScreenPicker()) {
  bgEyeDropperBtn.disabled = true;
  bgEyeDropperBtn.title = 'Screen colour picking is not supported by this browser';
}
bgEyeDropperBtn.addEventListener('click', async () => {
  const picked = await pickColorFromScreen();
  if (!picked) return;
  setBackground({ kind: 'color', hex: picked, alpha: colourPickAlpha() });
});

// Restore consistency after a reload: an alpha-capable persisted format means
// the cut-out should load transparent, so a persisted opaque colour must not
// flatten it. This is the same rule the format radio applies in-session. An
// explicit ?bg= is the user's ask, so it is left alone.
if (!urlParams.has('bg')) dropOpaqueBackgroundForAlpha(exportFormat);

updateBackgroundUi();

// ——— Manual retouch (Result tab only) ———
// Edits the alpha mask already produced by inference. It never runs the worker,
// never modifies the photo's RGB pixels, and never leaves the device. The
// background & export block is replaced in place by a compact brush panel while
// the session is open; closing it restores the block exactly.

function canvasAlphaFloat(canvas: HTMLCanvasElement): Float32Array {
  const { width, height } = canvas;
  const data = canvas
    .getContext('2d', { willReadFrequently: true })!
    .getImageData(0, 0, width, height).data;
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3] / 255;
  return out;
}

function canvasAlphaBytes(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const { width, height } = canvas;
  const data = canvas
    .getContext('2d', { willReadFrequently: true })!
    .getImageData(0, 0, width, height).data;
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3];
  return out;
}

/** The original RGB at the preview resolution, used for the live brush canvas. */
function scaledImageData(source: ImageData, width: number, height: number): ImageData {
  if (source.width === width && source.height === height) return source;
  const src = document.createElement('canvas');
  src.width = source.width;
  src.height = source.height;
  src.getContext('2d')!.putImageData(source, 0, 0);
  const dst = document.createElement('canvas');
  dst.width = width;
  dst.height = height;
  const ctx = dst.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

function updateRetouchHistoryUi(): void {
  if (retouchUndoBtn) {
    retouchUndoBtn.disabled = !retouchSession || !canUndoBrush(retouchSession.history);
  }
  if (retouchRedoBtn) {
    retouchRedoBtn.disabled = !retouchSession || !canRedoBrush(retouchSession.history);
  }
}

/** Shows the edit icon only on the Result tab, and the panel only while open. */
function updateRetouchUi(): void {
  // The interim Stage-1 preview is replaced by the refined final moments later;
  // editing it would leave the session on a stale base, so wait for the settle.
  const canEdit =
    studioView.tab === 'step' && studioView.hasResult && !studioView.refining && !!lastResultAlpha;
  if (resultEditToggleBtn) resultEditToggleBtn.hidden = !canEdit || retouchModeOpen;
  if (retouchPanelEl) retouchPanelEl.hidden = !retouchModeOpen;
  // The before/after slider cannot be used while the brush canvas covers the
  // stage, so its toggle is hidden for the duration of the session.
  if (resultCompareToggleBtn) {
    resultCompareToggleBtn.hidden = retouchModeOpen || !resultCompareFigure;
  }
  updateRetouchHistoryUi();
}

function setRetouchMode(open: boolean): void {
  retouchModeOpen = open;
  if (!open) {
    retouchOverlay?.remove();
    retouchOverlay = null;
    resultCompareFigure?.classList.remove('retouchOn');
  }
  updateExportBarVisibility();
  updateRetouchUi();
}

/** Drops the session without a log; used when a new photo replaces the result. */
function discardRetouchSession(): void {
  retouchSession = null;
  retouchModeOpen = false;
  retouchOverlay?.remove();
  retouchOverlay = null;
  resultCompareFigure?.classList.remove('retouchOn');
  if (retouchPanelEl) retouchPanelEl.hidden = true;
}

function cancelRetouchMode(silent = false): void {
  if (!retouchSession) {
    setRetouchMode(false);
    return;
  }
  retouchSession = null;
  setRetouchMode(false);
  if (!silent) log('Retouch cancelled — the cut-out is unchanged.');
}

function applyRetouchControls(): void {
  const s = retouchSession;
  if (!s) return;
  for (const tool of ['restore', 'erase'] as const) {
    retouchToolButtons[tool]?.setAttribute('aria-pressed', String(s.tool === tool));
  }
  if (retouchSizeInput) retouchSizeInput.value = String(Math.round(s.size));
  if (retouchSizeValueEl) retouchSizeValueEl.textContent = `${Math.round(s.size)}px`;
  if (retouchFeatherInput) retouchFeatherInput.value = String(Math.round(s.feather * 100));
  if (retouchFeatherValueEl) {
    retouchFeatherValueEl.textContent = `${Math.round(s.feather * 100)}%`;
  }
  if (retouchAutoCleanupBtn) {
    retouchAutoCleanupBtn.disabled = false;
    retouchAutoCleanupBtn.textContent = 'Auto color contour cleanup';
  }
  updateRetouchHistoryUi();
}

function setRetouchBusy(busy: boolean): void {
  if (retouchSaveBtn) {
    retouchSaveBtn.disabled = busy;
    retouchSaveBtn.textContent = busy ? 'Saving…' : 'Save';
  }
  if (retouchCancelBtn) retouchCancelBtn.disabled = busy;
  if (retouchAutoCleanupBtn) retouchAutoCleanupBtn.disabled = busy;
  if (busy) {
    if (retouchUndoBtn) retouchUndoBtn.disabled = true;
    if (retouchRedoBtn) retouchRedoBtn.disabled = true;
  } else {
    updateRetouchHistoryUi();
  }
}

function retouchPointerPoint(
  e: PointerEvent,
  canvas: HTMLCanvasElement,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / Math.max(1, rect.width)),
    y: (e.clientY - rect.top) * (canvas.height / Math.max(1, rect.height)),
  };
}

function onRetouchPointerDown(e: PointerEvent): void {
  const s = retouchSession;
  if (!s || !retouchOverlay) return;
  e.preventDefault();
  // Synthetic pointer events (tests) have no active pointer to capture.
  try {
    retouchOverlay.setPointerCapture(e.pointerId);
  } catch {
    /* no active pointer */
  }
  s.drawing = {
    tool: s.tool,
    points: [retouchPointerPoint(e, retouchOverlay)],
    size: s.size,
    feather: s.feather,
  };
  renderRetouchPreview();
}

function onRetouchPointerMove(e: PointerEvent): void {
  const s = retouchSession;
  if (!s || !s.drawing || !retouchOverlay) return;
  const p = retouchPointerPoint(e, retouchOverlay);
  const points = s.drawing.points;
  const last = points[points.length - 1];
  if (Math.hypot(p.x - last.x, p.y - last.y) < 1.5) return;
  points.push(p);
  renderRetouchPreview();
}

function onRetouchPointerUp(e: PointerEvent): void {
  const s = retouchSession;
  if (!s || !s.drawing) return;
  const stroke = s.drawing;
  s.drawing = null;
  try {
    retouchOverlay?.releasePointerCapture(e.pointerId);
  } catch {
    /* no capture */
  }
  s.history = pushBrushStroke(s.history, stroke);
  renderRetouchPreview();
  updateRetouchHistoryUi();
}

/** Paints the current working alpha over the stage's checkerboard. */
function paintRetouchOverlay(s: RetouchSession, alpha: Float32Array): void {
  const canvas = retouchOverlay;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const out = ctx.createImageData(s.previewWidth, s.previewHeight);
  const rgb = s.previewImage.data;
  for (let i = 0; i < alpha.length; i++) {
    const o = i * 4;
    out.data[o] = rgb[o];
    out.data[o + 1] = rgb[o + 1];
    out.data[o + 2] = rgb[o + 2];
    const a = alpha[i];
    out.data[o + 3] = Math.round((a < 0 ? 0 : a > 1 ? 1 : a) * 255);
  }
  ctx.putImageData(out, 0, 0);
}

function renderRetouchPreview(): void {
  const s = retouchSession;
  if (!s) return;
  const base = s.cleanupApplied && s.previewCleanupAlpha ? s.previewCleanupAlpha : s.previewBaseAlpha;
  const strokes = s.drawing ? [...s.history.strokes, s.drawing] : s.history.strokes;
  const alpha = replayBrushStrokes(
    base,
    s.previewWidth,
    s.previewHeight,
    strokes,
    s.previewWidth,
    s.previewHeight,
  );
  paintRetouchOverlay(s, alpha);
}

function buildRetouchOverlay(s: RetouchSession): void {
  retouchOverlay?.remove();
  const stage = resultCompareFigure?.querySelector<HTMLElement>('.compareStage');
  if (!stage) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'retouchCanvas';
  canvas.className = 'retouchCanvas';
  canvas.width = s.previewWidth;
  canvas.height = s.previewHeight;
  canvas.setAttribute('aria-label', 'Retouch canvas: paint to restore or erase the cut-out');
  stage.appendChild(canvas);
  retouchOverlay = canvas;
  resultCompareFigure?.classList.add('retouchOn');
  canvas.addEventListener('pointerdown', onRetouchPointerDown);
  canvas.addEventListener('pointermove', onRetouchPointerMove);
  canvas.addEventListener('pointerup', onRetouchPointerUp);
  canvas.addEventListener('pointercancel', onRetouchPointerUp);
}

function enterRetouchMode(): void {
  if (retouchModeOpen) return;
  if (studioView.tab !== 'step' || !studioView.hasResult || studioView.refining) return;
  if (!lastResultAlpha || !lastPreviewCanvas || !currentImageData) return;
  // Make sure the compare figure exists before we attach the overlay to it.
  renderResultPreview();
  const previewWidth = lastPreviewCanvas.width;
  const previewHeight = lastPreviewCanvas.height;
  const session: RetouchSession = {
    fullImage: currentImageData,
    fullWidth: currentImageData.width,
    fullHeight: currentImageData.height,
    fullBaseAlpha: bytesToAlpha(lastResultAlpha),
    previewImage: scaledImageData(currentImageData, previewWidth, previewHeight),
    previewWidth,
    previewHeight,
    previewBaseAlpha: canvasAlphaFloat(lastPreviewCanvas),
    previewCleanupAlpha: null,
    history: initialBrushHistory(),
    tool: 'restore',
    size: RETOUCH_DEFAULT_SIZE,
    feather: RETOUCH_DEFAULT_FEATHER / 100,
    cleanupApplied: false,
    drawing: null,
    saving: false,
  };
  retouchSession = session;
  applyRetouchControls();
  buildRetouchOverlay(session);
  setRetouchMode(true);
  renderRetouchPreview();
  log('Retouch: paint to restore or erase the mask, then Save or Cancel.');
}

async function runRetouchCleanup(): Promise<void> {
  const s = retouchSession;
  if (!s || s.saving) return;
  if (retouchAutoCleanupBtn) {
    retouchAutoCleanupBtn.disabled = true;
    retouchAutoCleanupBtn.textContent = 'Cleaning…';
  }
  try {
    const cleaned = await autoContourCleanup(s.previewImage, s.previewBaseAlpha);
    if (retouchSession !== s) return;
    s.previewCleanupAlpha = cleaned;
    s.cleanupApplied = true;
    renderRetouchPreview();
    log('Retouch: automatic colour contour cleanup applied.');
  } catch (e) {
    if (retouchSession === s) {
      log(
        `WARNING: contour cleanup failed (${e instanceof Error ? e.message : String(e)}).`,
      );
    }
  } finally {
    if (retouchSession === s && retouchAutoCleanupBtn) {
      retouchAutoCleanupBtn.disabled = false;
      retouchAutoCleanupBtn.textContent = 'Auto color contour cleanup';
    }
  }
}

async function saveRetouch(): Promise<void> {
  const s = retouchSession;
  if (!s || s.saving) return;
  const jobId = activeJobId;
  s.saving = true;
  setRetouchBusy(true);
  try {
    let base = s.fullBaseAlpha;
    if (s.cleanupApplied) {
      base = await autoContourCleanup(s.fullImage, s.fullBaseAlpha);
    }
    // A new upload/re-process while the cleanup ran discards the session.
    if (retouchSession !== s || jobId !== activeJobId) return;
    const alpha = replayBrushStrokes(
      base,
      s.fullWidth,
      s.fullHeight,
      s.history.strokes,
      s.previewWidth,
      s.previewHeight,
    );
    const bytes = alphaToBytes(alpha);
    const { canvas, preview } = await composeResult(s.fullImage, bytes);
    if (retouchSession !== s || jobId !== activeJobId) return;

    lastResultCanvas = canvas;
    lastPreviewCanvas = preview;
    lastResultAlpha = bytes;
    resultRevision += 1;
    outputSection.hidden = false;
    renderResultPreview();
    applyFormatUi();
    updateExportBarVisibility();
    updateReprocessButton();
    storeLibraryResult(canvas);
    log(
      `Manual retouch saved: ${s.history.strokes.length} stroke${s.history.strokes.length === 1 ? '' : 's'}, ` +
        `cleanup ${s.cleanupApplied ? 'applied' : 'not applied'}.`,
    );
  } catch (e) {
    if (retouchSession === s) {
      log(
        `WARNING: could not save the retouch (${e instanceof Error ? e.message : String(e)}).`,
      );
      return;
    }
  } finally {
    s.saving = false;
    if (retouchSession === s) setRetouchBusy(false);
  }
  retouchSession = null;
  setRetouchMode(false);
}

resultEditToggleBtn?.addEventListener('click', () => enterRetouchMode());
retouchCancelBtn?.addEventListener('click', () => cancelRetouchMode());
retouchSaveBtn?.addEventListener('click', () => void saveRetouch());
retouchAutoCleanupBtn?.addEventListener('click', () => void runRetouchCleanup());
retouchUndoBtn?.addEventListener('click', () => {
  const s = retouchSession;
  if (!s) return;
  s.history = undoBrushStroke(s.history);
  renderRetouchPreview();
  updateRetouchHistoryUi();
});
retouchRedoBtn?.addEventListener('click', () => {
  const s = retouchSession;
  if (!s) return;
  s.history = redoBrushStroke(s.history);
  renderRetouchPreview();
  updateRetouchHistoryUi();
});
for (const tool of ['restore', 'erase'] as const) {
  retouchToolButtons[tool]?.addEventListener('click', () => {
    const s = retouchSession;
    if (!s) return;
    s.tool = tool;
    applyRetouchControls();
  });
}
retouchSizeInput?.addEventListener('input', () => {
  const s = retouchSession;
  if (!s) return;
  s.size = Math.max(2, Number(retouchSizeInput.value));
  if (retouchSizeValueEl) retouchSizeValueEl.textContent = `${Math.round(s.size)}px`;
});
retouchFeatherInput?.addEventListener('input', () => {
  const s = retouchSession;
  if (!s) return;
  const percent = Math.max(0, Math.min(100, Number(retouchFeatherInput.value)));
  s.feather = percent / 100;
  if (retouchFeatherValueEl) retouchFeatherValueEl.textContent = `${Math.round(percent)}%`;
});

function log(msg: string): void {
  // The log is rendered in the user-facing Console, so scrub internal commands
  // and private URLs before they reach the DOM (see studio-view.ts).
  appendConsoleLine(msg);
}

// ——— Console: flat terminal output ———
// Every log line is printed in arrival order as one monospace row, prefixed with
// a prompt glyph, newest at the bottom. There are no categories, threads, or
// collapsible groups.
const CONSOLE_PROMPT = '❯';

function appendConsoleLine(line: string): void {
  const classified = classifyLogLine(scrubConsoleLine(line));
  const row = document.createElement('div');
  row.className = classified.level === 'info' ? 'consoleLine' : `consoleLine ${classified.level}`;
  const prompt = document.createElement('span');
  prompt.className = 'consoleLinePrompt';
  prompt.setAttribute('aria-hidden', 'true');
  prompt.textContent = CONSOLE_PROMPT;
  const text = document.createElement('span');
  text.className = 'consoleLineText';
  text.textContent = classified.text;
  row.append(prompt, text);
  consoleOutputEl.appendChild(row);
  scrollConsoleToBottom();
}

// A terminal shows its newest line, so every print pins the view to the bottom.
function scrollConsoleToBottom(): void {
  consoleScrollEl.scrollTop = consoleScrollEl.scrollHeight;
}

// Build the copyable diagnostic report and copy it to the clipboard. This is
// the one-tap capture a real-device tester uses when a cut-out looks wrong: it
// carries the actual GPU adapter facts, the execution path (adapter detected vs
// session built vs inference actually run), the model, the timings AND the raw
// mask's min/mean/max and tail fractions, so a "washed-out / ghost" result is
// diagnosable without a debug build. Nothing here leaves the device.
function diagnosticReport() {
  const model = selectedModel;
  const adapter = lastAdapterDetails;
  // The adapter the provider gate enumerated (independent of which provider ran).
  const adapterDetected = gpuState?.adapterPresent === true;
  const adapterUsable = gpuState?.available === true;
  return buildDiagnosticReport({
    userAgent: navigator.userAgent,
    platform: navigator.platform ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGb:
      typeof (navigator as Navigator & { deviceMemory?: number }).deviceMemory === 'number'
        ? ((navigator as Navigator & { deviceMemory?: number }).deviceMemory as number)
        : null,
    crossOriginIsolated: window.crossOriginIsolated === true,
    webgpuAvailable: gpuState?.adapterPresent === true,
    webgpuRuntimeBundle: runtimeHasWebGpuBundle,
    webgpuSessionInitialized,
    inferenceRan,
    selectedProvider,
    actualProvider,
    fallbackReason,
    adapterDetected,
    adapterUsable,
    adapter: adapter
      ? {
          vendor: adapter.vendor,
          architecture: adapter.architecture,
          device: adapter.device,
          description: adapter.description,
          features: adapter.features,
          maxStorageBufferBindingSize: adapter.maxStorageBufferBindingSize,
          maxBufferSize: adapter.maxBufferSize,
        }
      : null,
    model: {
      id: model?.id ?? null,
      filename: model?.file?.split('/').pop() ?? null,
      revision: model?.sha256 ?? null,
      inputSize: model?.inputSize ?? null,
      imageWidth: currentImageData?.width ?? null,
      imageHeight: currentImageData?.height ?? null,
    },
    inference: {
      downloadMs,
      sessionInitMs,
      coldMs: timings.length ? timings[0] : null,
      warmMs: timings.length > 1 ? timings.slice(1) : [],
      averageMs: timings.length ? timings.reduce((a, b) => a + b, 0) / timings.length : null,
      postprocessingMs,
    },
    rawMask: lastRawMaskStats ?? emptyRawMaskStats(),
    postprocessing: {
      maskRecoveryTriggered,
      refinementEnabled: refineConfig.enabled,
      refinementSucceeded,
    },
    errors: diagnosticErrors,
  });
}

function diagnosticReportText(): string {
  return formatDiagnosticReport(diagnosticReport());
}

// Records a processing error so a report taken after a failure still carries it
// (bounded, and deduplicated so a retry storm does not fill the report).
function recordDiagnosticError(message: string): void {
  const line = message.split('\n')[0].trim();
  if (!line || diagnosticErrors.includes(line)) return;
  diagnosticErrors.push(line);
  if (diagnosticErrors.length > 8) diagnosticErrors.shift();
}

// Copies text to the clipboard, falling back to a hidden textarea + execCommand
// for browsers without the async Clipboard API (or when it is denied). Returns
// whether the copy succeeded; never throws.
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copyReport(): Promise<void> {
  const text = diagnosticReportText();
  // Always log it so the report is visible (and selectable) even when the
  // clipboard API is unavailable or denied.
  log(text.replace(/\n/g, ' | '));
  const copied = await copyToClipboard(text);
  showToast(copied ? 'Diagnostic report copied to the clipboard.' : 'Diagnostic report written to the Console log.', {
    kind: 'info',
    title: 'Diagnostic report',
  });
}

deviceReportBtn.addEventListener('click', () => void copyReport());

// The Zero-Upload statement is hidden behind a clickable shield icon.
privacyToggle.addEventListener('click', () => {
  const show = privacyStatement.hidden;
  privacyStatement.hidden = !show;
  privacyToggle.setAttribute('aria-expanded', String(show));
  privacyToggle.setAttribute('aria-label', show ? 'Hide privacy statement' : 'Show privacy statement');
});

// The live status is the terminal's last line — a pinned footer row that stays
// visible while the scroll area above it scrolls. Every stage, progress reading,
// and error is written here, so the current step (e.g. download progress) is
// always the newest visible line without a separate status bar in the head.
function setConsoleStatus(text: string, working: boolean): void {
  processingLabel.textContent = text;
  processingLabel.classList.toggle('working', working);
  processingLabel.classList.remove('is-error');
}

function setStage(s: string): void {
  // A stage line shows the animated "working" treatment while a model load or a
  // run is in flight, so the ticker that keeps the elapsed time climbing does not
  // have to manage that class itself.
  setConsoleStatus(s, modelLoadInFlight || studioView.running);
}

function showError(msg: string): void {
  log(`ERROR: ${msg}`);
  // Keep the error for the diagnostic report so a copy taken after a failure
  // still carries the failure context.
  recordDiagnosticError(msg);
  processingLabel.textContent = `Error: ${msg}`;
  processingLabel.classList.remove('working');
  processingLabel.classList.add('is-error');
  // Also surface the failure as a floating error notification (top-right), so it
  // is seen even when the studio console is scrolled out of view.
  showToast(msg.split('\n')[0], { kind: 'error', title: 'Something went wrong' });
}

function error(msg: string, kind: ErrorKind = 'generic'): void {
  const described = describeError(msg);
  showError(described);
  // A failure only counts against a run that actually started; the client
  // ignores it otherwise, so an upload rejection (no run) never skews the rate.
  trackProcessingFailed(analyticsFailureReason(kind));
  if (kind === 'upload') {
    // A rejected file is a normal input mistake, not a broken app: explain it on
    // the stage line and let the user pick another photo. No recovery panel.
    hideRecovery();
    return;
  }
  showRecovery(kind, described);
}

/** Coarse, non-identifying reason code for a failed run. */
function analyticsFailureReason(kind: ErrorKind): FailureReason {
  switch (kind) {
    case 'upload':
      return 'upload_rejected';
    case 'download':
      return 'model_download';
    case 'memory':
      return 'out_of_memory';
    case 'worker':
      return 'worker_error';
    default:
      return 'processing_error';
  }
}

// ——— Error recovery ———
// Every failure surfaces the concrete next step instead of a dead end. `kind`
// picks the guidance; the panel always offers a reliable escape (reload).
type ErrorKind = 'upload' | 'download' | 'memory' | 'worker' | 'generic';

function retryModelOrRun(): void {
  hideRecovery();
  if (!modelReady) void ensureModelLoaded();
  else if (currentImageData) void runSmoke();
}

function showRecovery(kind: ErrorKind, message: string): void {
  recoveryEl.innerHTML = '';
  const guidance = document.createElement('p');
  const actions = document.createElement('div');
  actions.className = 'actions';

  let text: string;
  let primaryLabel = 'Try again';
  let primaryRun: () => void = retryModelOrRun;

  switch (kind) {
    case 'download':
      text =
        'The model download did not finish. Check your connection and try again — ' +
        'the model is kept on this device once it succeeds.';
      primaryLabel = 'Retry download';
      primaryRun = () => {
        hideRecovery();
        void ensureModelLoaded();
      };
      break;
    case 'memory':
      text =
        'This device ran out of memory. Close other tabs or apps to free memory, then ' +
        'try again. A smaller photo also needs less memory.';
      primaryLabel = 'Try again';
      primaryRun = () => {
        hideRecovery();
        if (!modelReady) void ensureModelLoaded();
        else if (currentImageData) void runSmoke();
      };
      break;
    case 'worker':
      text =
        'The background-removal engine could not start. Reload the page; if it keeps ' +
        'failing, use Copy report in the Console for the exact error.';
      primaryLabel = 'Reload page';
      primaryRun = () => location.reload();
      break;
    default:
      text = 'Something went wrong. Try again, or reload the page.';
  }

  guidance.textContent = text;
  recoveryEl.appendChild(guidance);

  const detail = document.createElement('p');
  detail.className = 'hint';
  detail.textContent = scrubConsoleLine(message);
  recoveryEl.appendChild(detail);

  const primary = document.createElement('button');
  primary.className = 'primary';
  primary.textContent = primaryLabel;
  primary.addEventListener('click', primaryRun);
  actions.appendChild(primary);

  if (kind !== 'worker') {
    const reload = document.createElement('button');
    reload.className = 'secondary';
    reload.textContent = 'Reload page';
    reload.addEventListener('click', () => location.reload());
    actions.appendChild(reload);
  }
  if (kind === 'upload' || kind === 'generic' || kind === 'memory') {
    const pick = document.createElement('button');
    pick.className = 'secondary';
    pick.textContent = 'Choose another photo';
    pick.addEventListener('click', () => chooseFile());
    actions.appendChild(pick);
  }

  recoveryEl.appendChild(actions);
  recoveryEl.hidden = false;
}

function hideRecovery(): void {
  recoveryEl.hidden = true;
  recoveryEl.innerHTML = '';
}

// ——— Processing panel ———
// The live status label for the current process, plus the model identity and the
// raw log, so the phases are distinguishable at a glance.

const OOM_PATTERN = /bad_alloc|out of memory|outofmemory|allocation failed|allocation error/i;
const DOWNLOAD_PATTERN =
  /fetch|network|failed to load|download|load failed|404|403|timeout|timed out|abort|sha|checksum|integrity|offline/i;

// Maps a raw error message to the recovery guidance to show. The worker tags a
// set-model failure as fatal, but not why; the message is the only signal.
function classifyError(msg: string): ErrorKind {
  if (OOM_PATTERN.test(msg)) return 'memory';
  if (DOWNLOAD_PATTERN.test(msg)) return 'download';
  return 'generic';
}

const MEMORY_NOTE =
  `BiRefNet_lite at its fixed ${MODEL_SIZE}x${MODEL_SIZE} input needs ~1 GB of transient ` +
  'memory for its intermediate tensors.';

// ORT surfaces provider-level allocation failures as bare C++ messages such as
// "failed to call OrtRun(). ... std::bad_alloc". Give the user the actual next
// step, which depends on which provider just failed: on CPU there is nothing
// left to fall back to.
function describeError(msg: string): string {
  if (!OOM_PATTERN.test(msg)) return msg;
  if (window.smokeProvider === 'wasm') {
    return (
      `${msg}\n` +
      `The CPU (WASM) backend could not allocate this model. ${MEMORY_NOTE} ` +
      'That exceeds what the browser\'s WASM heap can allocate, and there is no ' +
      'further fallback from CPU. Retry without ?provider=wasm, or close other tabs ' +
      'to free memory.'
    );
  }
  return (
    `${msg}\n` +
    `The browser ran out of memory while allocating this model. ${MEMORY_NOTE} ` +
    'Close other tabs/apps and retry. The GPU could not fit it and the CPU ' +
    'fallback failed as well, so this device cannot run this model.'
  );
}

function showInputImage(img: HTMLImageElement): void {
  // The chosen photo is shown on the input tab so the user can see what they
  // picked; the drop zone stays below it as the "choose another photo" target.
  // The object URL keeps the decoded image available for inference too.
  inputPreviewImg.src = img.src;
  inputPreviewEl.hidden = false;
  stepInputEl.classList.add('has-preview');
}

// ——— Session library (render + entry points) ———
// `applySession` runs a reducer event, revokes the URLs it reports as dropped,
// and repaints the grid. A blob is kept per entry so an entry can be re-opened
// (the current photo's object URL is revoked when the next one is chosen).
function applySession(ev: Parameters<typeof reduceSession>[1]): void {
  const { state, revoked } = reduceSession(session, ev);
  session = state;
  for (const url of revoked) URL.revokeObjectURL(url);
  if (ev.type === 'remove') {
    libraryBlobs.delete(ev.id);
    libraryResultBlobs.delete(ev.id);
  }
  // Eviction drops entries without naming them; reconcile the blob maps.
  const live = new Set(session.entries.map((e) => e.id));
  for (const id of [...libraryBlobs.keys()]) if (!live.has(id)) libraryBlobs.delete(id);
  for (const id of [...libraryResultBlobs.keys()]) if (!live.has(id)) libraryResultBlobs.delete(id);
  for (const id of [...libraryChecked]) if (!live.has(id)) libraryChecked.delete(id);
  renderLibrary();
}

function formatDims(w: number, h: number): string {
  return `${w}×${h}`;
}

function libraryUsageItems(): { bytes: number; type: string }[] {
  return session.entries.map((entry) => {
    const original = libraryBlobs.get(entry.id);
    const result = libraryResultBlobs.get(entry.id);
    return {
      bytes: (original?.size ?? 0) + (result?.size ?? 0),
      type: original?.type || result?.type || '',
    };
  });
}

function updateLibraryStats(): void {
  if (!libraryStatsEl) return;
  const usage = summarizeLibrary(libraryUsageItems());
  const images = usage.count === 1 ? '1 image' : `${usage.count} images`;
  libraryStatsEl.textContent =
    `${images} · Total ${formatBytes(usage.budgetBytes)} · Used ${formatBytes(usage.usedBytes)} · ` +
    `Left ${formatBytes(usage.leftBytes)} · Types PNG ${usage.types.PNG} / JPG ${usage.types.JPG} / ` +
    `WebP ${usage.types.WebP}`;
}

function visibleLibraryEntries(): SessionEntry[] {
  const query = libraryFilterQuery.trim().toLowerCase();
  return query
    ? session.entries.filter((entry) => entry.name.toLowerCase().includes(query))
    : session.entries;
}

function updateLibrarySelectionUi(visible: SessionEntry[]): void {
  const checkedVisible = visible.filter((entry) => libraryChecked.has(entry.id)).length;
  if (librarySelectAllEl) {
    librarySelectAllEl.disabled = visible.length === 0;
    librarySelectAllEl.checked = visible.length > 0 && checkedVisible === visible.length;
    librarySelectAllEl.indeterminate = checkedVisible > 0 && checkedVisible < visible.length;
  }
  if (librarySelectionCountEl) librarySelectionCountEl.textContent = `${libraryChecked.size} selected`;
  const exportable = session.entries.filter(
    (entry) => libraryChecked.has(entry.id) && entry.resultUrl && libraryResultBlobs.has(entry.id),
  ).length;
  if (libraryExportSelectedBtn) {
    libraryExportSelectedBtn.disabled = exportable === 0;
    libraryExportSelectedBtn.textContent =
      exportable > 0 ? `Export selected (${exportable})` : 'Export selected';
  }
}

function renderLibrary(): void {
  if (!libraryGridEl) return;
  const visible = visibleLibraryEntries();
  libraryGridEl.innerHTML = '';
  if (libraryEmptyEl) {
    libraryEmptyEl.hidden = visible.length > 0;
    libraryEmptyEl.textContent =
      session.entries.length === 0
        ? 'Nothing here yet — process a photo to keep its cut-out in this session.'
        : 'No images match that name.';
  }
  for (const entry of visible) {
    const checked = libraryChecked.has(entry.id);
    const card = document.createElement('div');
    card.className = 'libraryCard';
    card.dataset.active = String(entry.id === session.activeId);
    card.dataset.checked = String(checked);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open ${entry.name}`);

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'libraryCheck';
    check.checked = checked;
    check.setAttribute('aria-label', `Select ${entry.name} for export`);
    check.addEventListener('click', (e) => e.stopPropagation());
    check.addEventListener('change', () => {
      if (check.checked) libraryChecked.add(entry.id);
      else libraryChecked.delete(entry.id);
      renderLibrary();
    });
    card.appendChild(check);

    const thumb = document.createElement('img');
    thumb.className = 'libraryThumb';
    thumb.alt = '';
    thumb.src = entry.resultUrl ?? entry.originalUrl;
    card.appendChild(thumb);

    const meta = document.createElement('div');
    meta.className = 'libraryMeta';
    const name = document.createElement('span');
    name.className = 'libraryName';
    name.textContent = entry.name;
    const dims = document.createElement('span');
    dims.className = 'libraryDims';
    dims.textContent = formatDims(entry.width, entry.height);
    meta.appendChild(name);
    meta.appendChild(dims);
    card.appendChild(meta);

    // A completed cut-out is a re-openable, downloadable version. Mark it so
    // several versions of the same photo are distinguishable.
    if (entry.resultUrl) {
      const badge = document.createElement('span');
      badge.className = 'libraryBadge';
      badge.textContent = 'Cut-out';
      card.appendChild(badge);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'libraryRemove';
    remove.setAttribute('aria-label', `Remove ${entry.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      applySession({ type: 'remove', id: entry.id });
    });
    card.appendChild(remove);

    const open = (): void => void reopenEntry(entry.id);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    libraryGridEl.appendChild(card);
  }
  updateLibraryStats();
  updateLibrarySelectionUi(visible);
}

function libraryDownloadName(entry: SessionEntry, extension: string): string {
  const base = entry.name.replace(/\.[^.]+$/, '') || `photo-${entry.id}`;
  return `${base}-background-removed-${entry.width}x${entry.height}.${extension}`;
}

async function exportSelectedLibrary(): Promise<void> {
  const selected = session.entries.filter((entry) => libraryChecked.has(entry.id));
  const exportable = selected.filter((entry) => entry.resultUrl && libraryResultBlobs.has(entry.id));
  if (!exportable.length) {
    showToast('Select at least one finished cut-out to export.', { kind: 'warn' });
    return;
  }
  const used = new Set<string>();
  const entries: { name: string; data: Uint8Array }[] = [];
  for (const entry of exportable) {
    if (!entry.resultUrl) continue;
    const img = await loadImageElement(entry.resultUrl);
    const canvas = canvasFromImage(img);
    const dataUrl = canvasToDataUrl(canvas, exportFormat, background);
    const extension = dataUrlExtension(dataUrl, exportFormatInfo(exportFormat).extension);
    entries.push({
      name: uniqueZipName(libraryDownloadName(entry, extension), used),
      data: dataUrlToBytes(dataUrl),
    });
  }
  if (!entries.length) return;
  log(`Downloading ${entries.length} library cut-out(s) as a ZIP archive.`);
  const url = URL.createObjectURL(createZipBlob(entries));
  const link = document.createElement('a');
  link.href = url;
  link.download = `library-${entries.length}-photos.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  trackDownloadInitiated();
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode image'));
    img.src = src;
  });
}

function canvasFromImage(img: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d', { willReadFrequently: true })!.drawImage(img, 0, 0);
  return canvas;
}

function previewFromCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const { width, height } = previewSize(source.width, source.height);
  if (width === source.width && height === source.height) return source;
  const preview = document.createElement('canvas');
  preview.width = width;
  preview.height = height;
  const ctx = preview.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return preview;
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// Re-open a stored cut-out exactly as it was produced: the full-resolution PNG
// becomes the editable/exportable result, and the original photo is restored so
// the background can be changed and a re-process can still run. No inference is
// performed, so a version is always the pixels the user saw.
async function openLibraryResult(entry: SessionEntry): Promise<void> {
  const resultBlob = libraryResultBlobs.get(entry.id);
  if (!resultBlob || !entry.resultUrl) return;

  // Restore the source photo (needed by the before/after slider and re-process).
  const originalBlob = libraryBlobs.get(entry.id);
  if (originalBlob) {
    const url = URL.createObjectURL(originalBlob);
    try {
      const img = await loadImageElement(url);
      currentImage = img;
      currentImageData = canvasFromImage(img).getContext('2d', { willReadFrequently: true })!
        .getImageData(0, 0, img.naturalWidth, img.naturalHeight);
      if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = url;
      showInputImage(img);
    } catch {
      URL.revokeObjectURL(url);
    }
  }

  const resultImg = await loadImageElement(entry.resultUrl);
  const canvas = canvasFromImage(resultImg);
  const preview = previewFromCanvas(canvas);

  invalidateActiveJob();
  hideRecovery();
  clearOutput();
  currentImageName = entry.name;
  lastResultCanvas = canvas;
  lastPreviewCanvas = preview;
  lastResultAlpha = canvasAlphaBytes(canvas);
  resultRevision += 1;
  resultSettingsKey = engineSettingsKey();
  applySession({ type: 'activate', id: entry.id });
  outputSection.hidden = false;
  renderResultPreview();
  applyFormatUi();
  studioResult();
  log(`Reopened library cut-out (${entry.width}x${entry.height}).`);
}

// Re-open an earlier entry. A completed cut-out opens its stored result; an
// unprocessed photo is re-run from its original blob.
async function reopenEntry(id: number): Promise<void> {
  const entry = session.entries.find((e) => e.id === id);
  if (!entry) return;
  if (entry.resultUrl && libraryResultBlobs.has(id)) {
    await openLibraryResult(entry);
    return;
  }
  const blob = libraryBlobs.get(id);
  if (!blob) return;
  applySession({ type: 'activate', id });
  const file = new File([blob], entry.name, { type: blob.type });
  await loadImageFromFile(file, false);
}

// Mark the start of a new run: its preview and refined final update one entry,
// while a later re-process adds a new library version.
function beginLibraryRun(): void {
  currentRunStoredEntryId = null;
  libraryRunToken += 1;
}

// PNG encodes are serialised so the preview's result cannot land after the
// refined final's and overwrite it.
let libraryWriteQueue: Promise<void> = Promise.resolve();

function storeLibraryResult(canvas: HTMLCanvasElement): void {
  const token = libraryRunToken;
  libraryWriteQueue = libraryWriteQueue
    .then(() => storeLibraryResultNow(canvas, token))
    .catch((e) =>
      log(`WARNING: could not add the cut-out to the library (${e instanceof Error ? e.message : String(e)}).`),
    );
}

async function storeLibraryResultNow(canvas: HTMLCanvasElement, token: number): Promise<void> {
  if (!librarySavingEnabled || token !== libraryRunToken) return;
  const blob = await canvasToPngBlob(canvas);
  if (!blob || !librarySavingEnabled || token !== libraryRunToken) return;
  const url = URL.createObjectURL(blob);

  // The refined final replaces this run's interim preview in the same entry.
  if (currentRunStoredEntryId != null) {
    libraryResultBlobs.set(currentRunStoredEntryId, blob);
    applySession({ type: 'set-result', id: currentRunStoredEntryId, resultUrl: url });
    return;
  }

  const active = activeEntry(session);
  if (!active) {
    URL.revokeObjectURL(url);
    return;
  }

  // First result for this photo: fill in its placeholder entry.
  if (!active.resultUrl) {
    currentRunStoredEntryId = active.id;
    libraryResultBlobs.set(active.id, blob);
    applySession({ type: 'set-result', id: active.id, resultUrl: url });
    return;
  }

  // A re-process: keep the previous cut-out and add this one as a new version.
  const originalBlob = libraryBlobs.get(active.id);
  if (!originalBlob) {
    currentRunStoredEntryId = active.id;
    libraryResultBlobs.set(active.id, blob);
    applySession({ type: 'set-result', id: active.id, resultUrl: url });
    return;
  }
  const newOriginalUrl = URL.createObjectURL(originalBlob);
  const newId = session.nextId;
  libraryBlobs.set(newId, originalBlob);
  libraryResultBlobs.set(newId, blob);
  currentRunStoredEntryId = newId;
  applySession({
    type: 'add-version',
    name: active.name,
    width: active.width,
    height: active.height,
    originalUrl: newOriginalUrl,
    resultUrl: url,
    createdAt: Date.now(),
  });
}

function applyLibrarySaveUi(): void {
  if (librarySaveToggleEl) {
    librarySaveToggleEl.setAttribute('aria-pressed', String(librarySavingEnabled));
    librarySaveToggleEl.textContent = librarySavingEnabled ? 'Saving on' : 'Saving off';
    librarySaveToggleEl.dataset.off = String(!librarySavingEnabled);
    librarySaveToggleEl.title = librarySavingEnabled
      ? 'Stop saving new cut-outs to the Library'
      : 'Start saving new cut-outs to the Library';
  }
  if (librarySaveHintEl) {
    librarySaveHintEl.textContent = librarySavingEnabled
      ? 'Photos you process stay on this device, in this tab only. They are gone when you close or reload the page.'
      : 'Saving is off — new cut-outs are not added to this history. Turn saving on to keep them again.';
  }
}

function clearLibrary(): void {
  // Cancel any queued write for the run in flight before dropping its entry.
  libraryRunToken += 1;
  currentRunStoredEntryId = null;
  const { state, revoked } = reduceSession(session, { type: 'clear' });
  session = state;
  for (const url of revoked) URL.revokeObjectURL(url);
  libraryBlobs.clear();
  libraryResultBlobs.clear();
  libraryChecked.clear();
  renderLibrary();
  log('Library history cleared.');
}

libraryClearBtn?.addEventListener('click', clearLibrary);
librarySaveToggleEl?.addEventListener('click', () => {
  librarySavingEnabled = !librarySavingEnabled;
  savePref(LS_LIBRARY_SAVE, librarySavingEnabled);
  applyLibrarySaveUi();
  log(librarySavingEnabled ? 'Library saving enabled.' : 'Library saving disabled.');
});
libraryFilterInput?.addEventListener('input', () => {
  libraryFilterQuery = libraryFilterInput.value;
  renderLibrary();
});
librarySelectAllEl?.addEventListener('change', () => {
  const visible = visibleLibraryEntries();
  if (librarySelectAllEl.checked) {
    for (const entry of visible) libraryChecked.add(entry.id);
  } else {
    for (const entry of visible) libraryChecked.delete(entry.id);
  }
  renderLibrary();
});
libraryExportSelectedBtn?.addEventListener('click', () => void exportSelectedLibrary());
applyLibrarySaveUi();
renderLibrary();

async function loadImageFromFile(file: File, addToLibrary = librarySavingEnabled): Promise<void> {
  // Validate the declared type/size before decoding (never trust the extension),
  // then the decoded dimensions after. Reject with a message the user can act on.
  const typeCheck = validateFileTypeAndSize(file);
  if (!typeCheck.ok) {
    error(typeCheck.reason, 'upload');
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.src = url;
    });
  } catch (e) {
    URL.revokeObjectURL(url);
    error(e instanceof Error ? e.message : String(e), 'upload');
    return;
  }
  // Decide the largest source this device should hold, then draw ONCE at that
  // size. The full-resolution pixels are never read into an ImageData buffer, so
  // a 48 MP phone photo cannot exhaust the renderer's memory before inference.
  const sourceScale = sourceScaleDecision(img.naturalWidth, img.naturalHeight);
  if (sourceScale.downscaled) log(sourceScale.reason);
  const dimCheck = validateDimensions(sourceScale.width, sourceScale.height);
  if (!dimCheck.ok) {
    URL.revokeObjectURL(url);
    error(dimCheck.reason, 'upload');
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = sourceScale.width;
  canvas.height = sourceScale.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  currentImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  currentImage = img;

  // A reduced source is also the geometry the preview, tiled runs and the
  // before/after slider must use. Re-encode the reduced canvas once and drop the
  // full-resolution decode instead of keeping both.
  let displayUrl = url;
  let librarySource: Blob = file;
  if (sourceScale.downscaled) {
    const scaledBlob = await canvasToPngBlob(canvas);
    if (scaledBlob) {
      displayUrl = URL.createObjectURL(scaledBlob);
      librarySource = scaledBlob;
      URL.revokeObjectURL(url);
      currentImage = await loadImageElement(displayUrl);
    } else {
      currentImage = await loadImageElement(canvas.toDataURL('image/png'));
    }
  }

  // Keep the URL alive while the preview is on screen; release the previous one.
  // A bulk batch protects the step photo's URL until it restores it afterwards.
  if (currentObjectUrl && currentObjectUrl !== protectedObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
  }
  currentObjectUrl = displayUrl;
  showInputImage(currentImage);
  // A new photo invalidates the previous job: bump the job id and cancel any
  // refinement still running for the old one, so its late result cannot paint
  // over this new job's preview.
  invalidateActiveJob();
  // A new photo invalidates the previous result and any error panel.
  clearOutput();
  studioSelectImage();
  hideRecovery();
  currentImageName = file.name || 'Photo';
  // Add the photo to the session library (a re-open of an existing entry passes
  // addToLibrary=false so it is not duplicated). The library owns its own blob
  // URL — separate from the preview URL, which is revoked on the next load.
  if (addToLibrary) {
    const libUrl = URL.createObjectURL(librarySource);
    libraryBlobs.set(session.nextId, librarySource);
    applySession({
      type: 'add',
      name: currentImageName,
      width: canvas.width,
      height: canvas.height,
      originalUrl: libUrl,
      createdAt: Date.now(),
    });
  }
  // Clear any previous error text so a successful load after a rejected one does
  // not leave a stale error on the stage line.
  setStage(modelReady ? 'Removing the background…' : 'Photo ready — waiting for the model…');
  // Do not log the filename (MVP §8: no filenames, EXIF, or raw user input).
  log(`Loaded image: ${canvas.width}x${canvas.height}`);
  // Choosing the photo is the action: start removing the background right away.
  autoStartIfReady();
}

async function loadImageFromUrl(url: string): Promise<void> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.crossOrigin = 'anonymous';
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  currentImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  currentImage = img;
  // The result editor's before/after slider needs the source pixels too.
  if (currentObjectUrl && currentObjectUrl !== url) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = url;
  // A new photo invalidates the previous job (same guard as loadImageFromFile).
  invalidateActiveJob();
  showInputImage(img);
  log(`Loaded image from URL: ${url} (${canvas.width}x${canvas.height})`);
}

function waitForModel(): Promise<void> {
  if (modelReady) return Promise.resolve();
  if (modelError) return Promise.reject(new Error(modelError));
  return new Promise<void>((resolve, reject) => modelWaiters.push({ resolve, reject }));
}

function settleModel(error: string | null): void {
  modelLoadInFlight = false;
  if (error) {
    modelError = error;
  } else {
    modelReady = true;
    window.smokeModelReady = true;
  }
  for (const w of modelWaiters.splice(0)) {
    if (error) w.reject(new Error(error));
    else w.resolve();
  }
}

// A model download the worker stopped because the connection became metered. It
// is a pause, not a failure: reject the waiters so a run in flight settles, then
// re-arm the confirmation prompt so the user can resume on mobile data (or wait
// for Wi-Fi, which the periodic loop handles).
function handleModelCancel(): void {
  modelLoadInFlight = false;
  window.smokeModelPaused = true;
  for (const w of modelWaiters.splice(0)) w.reject(new MeteredPauseError());
  setSelectorsDisabled(false);
  endProcPhase();
  log('Model download paused: the connection switched to mobile data.');
  showMeteredPausePrompt();
}

// Distinguishes a deliberate metered pause from a real failure, so the run that
// was awaiting the model returns quietly instead of showing the error panel.
class MeteredPauseError extends Error {
  constructor() {
    super('Model download paused for a metered connection.');
    this.name = 'MeteredPauseError';
  }
}

function pauseModelForMetered(reason: string): void {
  if (!modelLoadInFlight) return;
  log(reason);
  worker?.postMessage({ kind: 'cancel-model', reason });
}

// The inference run started by the last photo load. A bulk batch awaits it so
// each photo is fully settled before the next one is loaded.
let activeRunPromise: Promise<unknown> | null = null;

// The primary action is the upload itself: choosing a photo starts the run
// automatically, so there is no second button to press. A fatal model error is
// the one case where a photo must not silently start a run — the recovery panel
// offers the retry.
function autoStartIfReady(): void {
  if (currentImage && modelError === null) {
    // Remember the run so a bulk batch can await the photo it just loaded.
    activeRunPromise = runSmoke().finally(() => {
      activeRunPromise = null;
    });
  }
}

async function initWorker(): Promise<void> {
  // Persist the model + WASM runtime before the inference worker starts, so the
  // worker's own fetches are served from the cache on every visit after the first.
  const cachedBefore = await cachedAssetCount();
  const cacheStatus = await ensureAssetCache(log);
  if (cacheStatus === 'controlling') {
    log(
      cachedBefore > 0
        ? `Asset cache ready (${cachedBefore} artifact(s) already on this device).`
        : 'Asset cache ready. First visit: the model downloads once and is kept on this device.',
    );
  }
  onAssetCacheMessage((msg) => {
    if (msg.kind === 'asset-cached') log(`Cached for next visit: ${new URL(msg.url).pathname}`);
  });
  if (ASSET_BASE) log('Heavy assets are served from the configured asset host.');

  // Classic worker (plain JS in /public) so onnxruntime-web's wasm loaders are
  // fetched as static files instead of being transformed by Vite. The runtime
  // bundle is chosen here: any selectable GPU adapter means the WebGPU-capable
  // ORT bundle (a ~26.5 MiB jsep wasm that hosts with a per-file cap cannot
  // serve). `ort.all.min.js` only fetches that jsep wasm when a webgpu session is
  // actually created, so the larger bundle costs nothing while the CPU runs; the
  // worker degrades a webgpu request to WASM with a clear message when the bundle
  // is absent. webGpuSelectable (not webGpuUsable) is used because the user can
  // switch to the GPU after boot, so the worker must already carry the backend.
  worker = createInferenceWorker();
}

function createInferenceWorker(): Worker {
  const runtimeQuery = webGpuSelectable() ? '?runtime=webgpu' : '';
  const w = new Worker('/inference-worker.js' + runtimeQuery, { type: 'classic' });
  // Without these a worker that fails to start (404 on the script, a failed
  // importScripts of the ORT runtime) posts nothing at all and the page waits on
  // its initial "Starting…" text forever.
  w.onerror = (e) => {
    workerFailed = true;
    error(`Inference worker failed to start: ${e.message || 'unknown worker error'}`, 'worker');
    settleModel('worker failed to start');
  };
  w.onmessageerror = () => {
    error('Inference worker sent a message that could not be deserialized', 'worker');
  };
  w.onmessage = (e: MessageEvent<WorkerProgressMessage>) => handleWorkerMessage(e.data);
  return w;
}

function handleWorkerMessage(msg: WorkerProgressMessage): void {
  workerResponded = true;
  if (msg.kind === 'loading-progress') {
    updateLoadProgress(msg);
  } else if (msg.kind === 'load-time') {
    const loadedModelId = msg.modelId ?? selectedModel?.id ?? 'unknown';
    log(`Model ready — provider ${msg.provider}`);
    loadTimeMs = msg.ms;
    log(`Model: ${loadedModelId}`);
    log(`Model load time: ${loadTimeMs.toFixed(1)} ms`);
    log(`Execution provider: ${msg.provider}`);
    if (msg.adapter) log(`GPU adapter: ${msg.adapter}`);
    // Structured diagnostics for the report: keep the adapter facts, the split
    // download/session timings, whether a WebGPU session actually built, and
    // why a GPU attempt fell back.
    lastAdapterDetails = msg.adapterDetails ?? null;
    downloadMs = msg.downloadMs ?? null;
    sessionInitMs = msg.sessionInitMs ?? null;
    webgpuSessionInitialized = msg.webgpuSessionInitialized === true;
    fallbackReason = msg.fallbackReason ?? null;
    window.smokeProvider = msg.provider;
    window.smokeModelId = loadedModelId;
    announcedLog.push(msg.provider);
    // Model loading is done.
    hideRecovery();
    setConsoleStatus(
      currentImageData ? 'Removing the background…' : 'Model ready — choose a photo',
      false,
    );
    setSelectorsDisabled(false);
    settleModel(null);
  } else if (msg.kind === 'adapter-warning') {
    log(`WARNING: ${msg.message}`);
  } else if (msg.kind === 'provider-restart') {
    // The worker aborted a GPU run and refused to reuse its own (possibly
    // corrupted) ORT module. Continue on a fresh worker instead of rebuilding
    // inside the old one.
    void restartOnFreshWorker(msg);
  } else if (msg.kind === 'inference-time') {
    const pending = pendingRuns.get(msg.runId);
    pendingRuns.delete(msg.runId);
    // A completed inference means a provider actually executed the model.
    inferenceRan = true;
    if (actualProvider === 'none') {
      actualProvider = window.smokeProvider === 'webgpu' ? 'webgpu' : 'wasm';
    }
    if (!pending) return;
    timings.push(msg.ms);
    log(`Inference ${timings.length}: ${msg.ms.toFixed(1)} ms`);
    pending.resolve(msg.ms);
  } else if (msg.kind === 'result-ready') {
    const tiled = msg.runId !== undefined ? tiledRuns.get(msg.runId) : undefined;
    if (tiled) handleTiledResultReady(msg, tiled.state, tiled.tileIndex);
    else handleResultReady(msg);
  } else if (msg.kind === 'error') {
    if (msg.cancelled) {
      // A deliberate stop (the connection became metered). Not a failure: the
      // page re-arms the download confirmation instead of an error recovery,
      // and a run that was waiting on the model just pauses.
      handleModelCancel();
      return;
    }
    // Errors tied to a run are delivered through that run's promise, so the
    // caller reports them once. Anything else is surfaced here.
    if (msg.runId !== undefined) failPendingRuns(new Error(msg.message));
    else error(msg.message, msg.fatal ? classifyError(msg.message) : 'generic');
    studioError();
    if (msg.fatal) {
      settleModel(msg.message);
      setSelectorsDisabled(false);
    }
    // A run-level failure (e.g. an allocation error) is handled by the worker
    // restarting on a fresh CPU worker, so the app stays usable.
  }
}

// Progressive-refinement state. `activeJobId` identifies the current job; every
// async step checks it before touching the UI, so a stale job (a superseded
// upload, or a refinement reply that arrives after a newer run started) can never
// overwrite a newer job's preview. It is bumped on every new upload.
let activeJobId = 0;
// The run id of the inference currently in flight, so `result-ready` can reject a
// superseded run's late result. Set when the run is posted (runOneInference).
let currentRunId = -1;
const refineConfig: FastRefinementConfig = refinementConfigFromParams(urlParams);
const refinementRunner = new RefinementRunner();

// ——— Tiled inference ———
// The tile grid the *next* run uses: 1 = off (a single full-image pass). Read
// from the sidebar select (and the ?tiles= override). The plan and the stitcher
// are created fresh per run so a grid change never mixes two runs' tiles.
let tileGrid: TileGrid = initTileGrid();
function initTileGrid(): TileGrid {
  const fromUrl = urlParams.get('tiles');
  if (fromUrl !== null && /^[1-4]$/.test(fromUrl)) return Number(fromUrl) as TileGrid;
  const pref = loadPref<number>('remove-bg:tiles', (v): v is number => v === 1 || v === 2 || v === 3 || v === 4);
  return (pref as TileGrid | null) ?? 1;
}
// The tiles of the run in flight, keyed by runId, so a `result-ready` message
// can be routed to the stitcher rather than the single-image path. One shared
// state object covers all tiles of a tiled run; `tileIndex` is the tile this
// particular run id carries.
interface TiledRunState {
  plan: ReturnType<typeof planTiles>;
  stitcher: TileStitcher;
  /** The tile's own pixels, kept so a GPU-abort retry can re-post the same tile. */
  tiles: ImageData[];
  /** Tiles whose result has landed. */
  done: number;
  total: number;
  jobId: number;
  image: ImageData;
  size: string;
  postprocessStart: number;
}
const tiledRuns = new Map<number, { state: TiledRunState; tileIndex: number }>();
// Per-run stage timings, captured for the smoke harness (window.smokeRefineStages).
let smokeRefineStages: Record<string, unknown> | null = null;

// A job is "settled" once it has produced its final preview or failed; the
// Stage-1 preview is only an interim step. The smoke harness waits on this so it
// exports the refined result rather than the interim preview.
const jobSettleWaiters: Array<() => void> = [];
let lastJobSettled = true;
function markJobSettled(): void {
  lastJobSettled = true;
  for (const w of jobSettleWaiters.splice(0)) w();
}
function waitForJobSettled(): Promise<void> {
  if (lastJobSettled) return Promise.resolve();
  return new Promise((resolve) => jobSettleWaiters.push(resolve));
}

// Starts a new job: bump the id (so any in-flight async work for the previous
// job is ignored when it settles) and cancel any refinement still running. A
// superseded job never settles the waiters, so a stale run cannot end a newer
// run's wait early.
function invalidateActiveJob(): void {
  activeJobId += 1;
  refinementRunner.cancel();
  markJobSettled();
}

// A worker `result-ready` message. Progressive refinement splits this into two
// visible beats:
//   Stage 1 (here): reconstruct the soft mask at the original resolution, run the
//     flood-fill recovery, apply the user's threshold/feather, and composite an
//     *initial* preview that is shown immediately and is exportable.
//   Stages 2-4 (refineAndFinalize): refine the soft mask (guided filter + cleanup)
//     off the main thread and atomically swap in the sharper result.
// The refinement is never a prerequisite: a failure or cancellation leaves the
// initial preview on screen.
function handleResultReady(msg: Extract<WorkerProgressMessage, { kind: 'result-ready' }>): void {
  // A late result from a superseded run must not paint over a newer job.
  if (msg.runId !== undefined && msg.runId !== currentRunId) {
    log('Ignoring a superseded run\'s result.');
    return;
  }
  if (!currentImageData) {
    log('WARNING: got a result with no loaded image; ignoring');
    return;
  }
  const image = currentImageData;
  const jobId = activeJobId;
  // Raw-mask statistics for the diagnostic report, computed here from the
  // model's ORIGINAL floating-point output (msg.mask), before probability
  // conversion, cropping, upscaling, recovery, thresholding, feathering, or
  // refinement — so the report reflects what the model produced, not the
  // post-processed image. The mask is read-only and never mutated.
  lastRawMaskStats = rawMaskStats(msg.mask, msg.inputSize ?? MODEL_SIZE, msg.inputSize ?? MODEL_SIZE);
  log(`Raw mask: ${formatRawMaskStats(lastRawMaskStats)}.`);
  if (isSuspectRawMask(lastRawMaskStats)) {
    log(
      'WARNING: the raw mask is not bimodal — the cut-out may look washed out. ' +
        'Use Copy report in the Console header for the details.',
    );
  }
  // The inference is done; the remaining work is mask reconstruction/refinement
  // and compositing, which have no measurable percentage of their own.
  beginProcPhase('finalize', phaseExpectedMs('finalize', 0));
  refreshProcPercent();
  setConsoleStatus('Building your preview…', true);
  const postprocessStart = performance.now();
  // The worker reports the model's actual input size so a per-model input change
  // (e.g. a 384 variant) never mis-scales the mask. The mask covers the
  // letterboxed content rect inside that square (the same geometry the
  // pre-processing used), so crop the padding away before upscaling.
  const inputSize = msg.inputSize ?? MODEL_SIZE;
  const rect = letterboxRect(image.width, image.height, inputSize);
  const maskU8 = cropLetterboxMask(probabilityToMask(msg.mask), inputSize, rect);
  const upscaled = upscaleMask(maskU8, rect.width, rect.height, image.width, image.height);
  // The model occasionally floods the whole frame (keeps the background
  // attached). Detect that and recover a real cut-out from the border-connected
  // background before compositing. See mask-recovery.ts. This runs on the raw
  // model mask so the user's threshold/feather below still applies to the
  // recovered result.
  // Keep the cropped float mask: it is the input to refinement (Stages 2-4).
  const croppedFloat = cropMaskFloat(msg.mask, inputSize, rect);
  const size = `${image.width}x${image.height}`;
  compositeAndRefine(jobId, image, upscaled, croppedFloat, rect, size, postprocessStart);
}

/**
 * Shared Stage-1 → refinement → composite path, used by both the single-image
 * run and the tiled run. `fullResMask` is the soft mask at the *original* image
 * resolution (already upscaled for a single run, stitched for a tiled run);
 * `croppedFloat` is the same mask in the geometry the refinement stage expects
 * (the model-input crop for a single run, the whole image for a tiled run).
 */
function compositeAndRefine(
  jobId: number,
  image: ImageData,
  fullResMask: Uint8ClampedArray,
  croppedFloat: Float32Array,
  rect: { width: number; height: number },
  size: string,
  postprocessStart: number,
): void {
  const { mask: recoveredMask, recovered } = recoverForegroundMask(image, fullResMask, {
    minIslandFraction: islandFraction(refineConfig.cleanup.islandCleanup),
  });
  if (recovered) {
    log('Model kept the whole frame; recovered the subject from the background edges.');
  }
  maskRecoveryTriggered = recovered;
  // Apply the user's mask threshold/feather at full destination resolution (the
  // values are percentages/pixels of the *output* mask).
  const stage1Mask = applyMaskAdjust(recoveredMask, image.width, image.height, maskAdjust);
  const guide = lumaFromRgba(image.data);
  const refineEnabled = refineConfig.enabled;
  // Refinement must operate on the same mask Stage 1 painted, so a flood-fill
  // recovery is not silently discarded when the final result is rebuilt. The
  // recovered mask is at the *original* resolution (whole-image geometry), so
  // feed it as the refine input directly; otherwise keep the letterbox-cropped
  // float mask, which the refinement stage resizes up to the original size.
  const refineInput = recovered
    ? { mask: bytesToAlpha(recoveredMask), width: image.width, height: image.height }
    : { mask: croppedFloat, width: rect.width, height: rect.height };
  composeResult(image, stage1Mask)
    .then(({ canvas, preview }) => {
      if (jobId !== activeJobId) return;
      // Time to the first composited preview (mask reconstruction + composite);
      // refinement time, when enabled, is added by refineAndFinalize.
      postprocessingMs = performance.now() - postprocessStart;
      // Paint the Stage-1 preview immediately (finishResult shows the Result tab
      // and enables export). With refinement enabled this is the interim beat;
      // disabled, it is the settled result.
      finishResult(canvas, preview, size, refineEnabled ? 'preview' : 'final', stage1Mask);
      if (!refineEnabled) return;
      return refineAndFinalize(jobId, image, refineInput.mask, refineInput.width, refineInput.height, guide, size, postprocessStart, recovered);
    })
    .catch((err) => {
      if (jobId !== activeJobId) return;
      endProcPhase();
      markJobSettled();
      error(`Could not compose the cut-out: ${err instanceof Error ? err.message : String(err)}`);
    });
}

// ——— Tiled inference ———
// The grid is a property of the *image*, not the model, so the plan and stitcher
// are rebuilt for every tiled run. The tiles are run one after another (a single
// 512px run at a time, so peak memory stays flat) and each result is stitched in
// as it lands. When every tile is in, the stitched soft mask flows through the
// exact same Stage-1 → refinement → composite path as a single run.

/** The mask at the original image size, for one tile, from the worker's mask. */
function tileMaskToFullRes(
  plan: ReturnType<typeof planTiles>,
  tileIndex: number,
  mask: Float32Array,
  inputSize: number,
): Float32Array {
  const tile = plan.tiles[tileIndex];
  const rect = letterboxRect(tile.width, tile.height, inputSize);
  const cropped = cropMaskFloat(mask, inputSize, rect);
  return resizeMaskFloat(cropped, rect.width, rect.height, tile.width, tile.height, 'bilinear');
}

function handleTiledResultReady(
  msg: Extract<WorkerProgressMessage, { kind: 'result-ready' }>,
  tiled: TiledRunState,
  tileIndex: number,
): void {
  if (msg.runId === undefined) return;
  if (tiled.jobId !== activeJobId) {
    tiledRuns.delete(msg.runId);
    return;
  }
  const inputSize = msg.inputSize ?? MODEL_SIZE;
  const full = tileMaskToFullRes(tiled.plan, tileIndex, msg.mask, inputSize);
  tiled.stitcher.add(tileIndex, full);
  tiled.done += 1;
  tiledRuns.delete(msg.runId);
  if (tiled.done < tiled.total) return;

  // Every tile is in: stitch to the full-resolution soft mask and hand off.
  const stitched = tiled.stitcher.result();
  // The inference is done; the remaining work is mask reconstruction/refinement
  // and compositing, which have no measurable percentage of their own (mirrors
  // the single-run path in handleResultReady).
  beginProcPhase('finalize', phaseExpectedMs('finalize', 0));
  refreshProcPercent();
  setConsoleStatus('Building your preview…', true);
  // There is no single raw model mask for a tiled run, so the report's raw-mask
  // section reflects the stitched soft mask (which is what the model produced,
  // combined). Recorded before recovery/threshold/refinement, like the single run.
  lastRawMaskStats = rawMaskStats(stitched, tiled.image.width, tiled.image.height);
  log(`Stitched mask: ${formatRawMaskStats(lastRawMaskStats)}.`);
  // The refinement stage expects the mask in the guide's geometry. For a tiled
  // run the whole image is the guide, so the stitched mask is already in the
  // right shape (and no letterbox crop applies).
  const rect = { width: tiled.image.width, height: tiled.image.height };
  const stitchedBytes = alphaToBytes(stitched);
  log(`Tiled mask stitched from ${tiled.total} tiles (${tiled.plan.grid}x${tiled.plan.grid}).`);
  compositeAndRefine(
    tiled.jobId,
    tiled.image,
    stitchedBytes,
    stitched,
    rect,
    tiled.size,
    tiled.postprocessStart,
  );
}

// Runs a whole tiled inference: one worker run per tile, awaited in order so the
// worker never holds more than one tile's tensors. The composite happens in
// handleTiledResultReady once the last tile lands.
async function runTiledInference(image: ImageData): Promise<void> {
  const plan = planTiles(image.width, image.height, tileGrid);
  const stitcher = new TileStitcher(image.width, image.height, plan);
  const jobId = activeJobId;
  const postprocessStart = performance.now();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const tiles: ImageData[] = [];
  for (const tile of plan.tiles) {
    canvas.width = tile.width;
    canvas.height = tile.height;
    ctx.drawImage(
      currentImage!,
      tile.x, tile.y, tile.width, tile.height,
      0, 0, tile.width, tile.height,
    );
    tiles.push(ctx.getImageData(0, 0, tile.width, tile.height));
  }
  const state: TiledRunState = {
    plan,
    stitcher,
    tiles,
    done: 0,
    total: plan.tiles.length,
    jobId,
    image,
    size: `${image.width}x${image.height}`,
    postprocessStart,
  };
  log(`Tiled inference: ${plan.grid}x${plan.grid} = ${plan.tiles.length} tiles.`);
  for (let i = 0; i < plan.tiles.length; i++) {
    if (jobId !== activeJobId) return;
    const runId = nextRunId++;
    currentRunId = runId;
    tiledRuns.set(runId, { state, tileIndex: i });
    await new Promise<number>((resolve, reject) => {
      pendingRuns.set(runId, { resolve, reject });
      postRunMessage(runId, state.tiles[i]);
    });
  }
}

// Stages 2-4: refine the soft mask and, on success, swap in the sharper result
// atomically. Any failure or cancellation keeps the initial preview.
async function refineAndFinalize(
  jobId: number,
  image: ImageData,
  refineMaskFloat: Float32Array,
  refineMaskWidth: number,
  refineMaskHeight: number,
  guide: Float32Array,
  size: string,
  postprocessStart: number,
  despeckleAfterRefine: boolean,
): Promise<void> {
  setConsoleStatus('Refining edges…', true);
  const t0 = performance.now();
  try {
    const outcome = await refinementRunner.refine({
      jobId,
      guide,
      mask: refineMaskFloat,
      maskWidth: refineMaskWidth,
      maskHeight: refineMaskHeight,
      width: image.width,
      height: image.height,
      config: refineConfig,
    });
    if (jobId !== activeJobId) return; // superseded: drop silently
    if ('cancelled' in outcome) return; // a newer job owns the UI now
    // The refinement returns a soft float alpha; apply the user's
    // threshold/feather, then composite. The flood-fill recovery guard was
    // already applied to the input mask (see compositeAndRefine), so the refined
    // alpha is derived from the recovered mask and is not re-run here.
    let refinedMask = applyMaskAdjust(alphaToBytes(outcome.alpha), image.width, image.height, maskAdjust);
    // Refinement re-grows small islands from the soft alpha, so the recovery's
    // despeckle has to run again on its output — and only for a recovery, so a
    // model mask is never altered.
    if (despeckleAfterRefine) {
      refinedMask = despeckleRecoveredMask(
        refinedMask,
        image.width,
        image.height,
        islandFraction(refineConfig.cleanup.islandCleanup),
      );
    }
    const { canvas, preview } = await composeResult(image, refinedMask);
    if (jobId !== activeJobId) return;
    refinementSucceeded = true;
    // Full post-processing time: mask reconstruction + Stage-1 composite + refine.
    postprocessingMs = performance.now() - postprocessStart;
    finishResult(canvas, preview, size, 'final', refinedMask);
    const { timings } = outcome;
    smokeRefineStages = { ...timings, finalizeMs: performance.now() - t0 };
    log(
      `Refined edges: mask ${timings.workWidth}x${timings.workHeight} in ` +
        `${timings.totalMs.toFixed(0)} ms (upscale ${timings.upscaleMs.toFixed(0)}, ` +
        `filter ${timings.refineMs.toFixed(0)}, cleanup ${timings.cleanupMs.toFixed(0)}).`,
    );
  } catch (err) {
    if (jobId !== activeJobId) return;
    // Refinement is an enhancement: keep the initial preview and report the
    // failure in the log, without an error recovery panel (the result is usable).
    refinementSucceeded = false;
    endProcPhase();
    log(
      `WARNING: edge refinement failed (${err instanceof Error ? err.message : String(err)}); showing the initial preview.`,
    );
    setConsoleStatus('Done — download your image below.', false);
    studioResult();
    markJobSettled();
  }
}

// Paints a freshly composited result: the compare view, the preview, the download
// link and the step list, then reports how much of the frame stayed opaque so a
// blank or a fully-kept result is called out rather than shown silently.
// `phase` is 'preview' for the interim Stage-1 cut-out (which stays on the Result
// tab but keeps the job marked as running) or 'final' for the settled result.
function finishResult(
  canvas: HTMLCanvasElement,
  preview: HTMLCanvasElement,
  size: string,
  phase: 'preview' | 'final' = 'final',
  mask: Uint8ClampedArray | null = null,
): void {
  lastResultCanvas = canvas;
  lastPreviewCanvas = preview;
  lastResultAlpha = mask ? new Uint8ClampedArray(mask) : null;
  resultRevision += 1;

  const ctx = canvas.getContext('2d')!;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const alpha = outputAlphaStats(data, 4, 3);
  const verdict = classifyOutputAlpha(alpha);

  // The compare view pairs the original photo with the current composite.
  // Preview + compare "after" are painted from the stored cut-out onto the chosen
  // background; the download link follows the chosen format.
  renderResultPreview();
  applyFormatUi();

  outputSection.hidden = false;
  updateExportBarVisibility();
  // The export dimensions are the original dimensions; refinement never
  // downscales the export.
  if (phase === 'final') {
    setConsoleStatus('Done — download your image below.', false);
    endProcPhase();
    studioResult();
    markJobSettled();
  } else {
    // The Stage-1 preview is already exportable; only the label differs.
    setConsoleStatus('Preview ready — refining edges…', true);
    studioPreview();
  }
  // Record the settings this cut-out was produced with; changing them later
  // reveals the re-process button.
  resultSettingsKey = engineSettingsKey();
  updateReprocessButton();
  // Show the transparent cut-out as the entry's library thumbnail.
  storeLibraryResult(canvas);

  const pct = (alpha.opaqueFraction * 100).toFixed(1);
  // A valid, displayable result exists now. The client de-duplicates, so the
  // interim preview and the refined final emit a single success per run.
  trackProcessingSucceeded();
  log(`Rendered cut-out (${size}) as ${exportFormatInfo(exportFormat).label} on a ${describeChoice(background)} background, ${pct}% opaque.`);
  log(`Output alpha: ${formatOutputAlphaStats(alpha)}.`);
  // A faint whole-frame wash (the ghost), a fully transparent frame, or a frame
  // that kept everything are all named here, so a bad result is never shown
  // silently — and the ghost is no longer mislabelled "fully transparent".
  const warning = outputAlphaWarning(verdict);
  if (warning) log(`WARNING: ${warning}`);
  // Advise tiling when it would sharpen THIS image (a wide, soft edge on a photo
  // the model must upscale a lot) and the user has not already enabled it. The
  // advice is shown in the sidebar, never as a toast.
  if (phase === 'final') maybeRecommendTiling(transitionBandFraction(data, 4, 3));
}

// The tiling recommendation for the photo on screen, kept so the sidebar hint can
// show it. Recomputed on every final result; null when tiling is not advised (or
// already on), which is what hides the hint.
let tilingAdvice: { reason: string; grid: TileGrid } | null = null;
// The photo the advice belongs to. A new photo clears the advice, so a stale
// recommendation from the previous image never lingers in the panel.
let tilingAdviceFor: string | null = null;

// Decide whether tiling would sharpen the current photo, and record it for the
// sidebar hint. Deliberately NOT a toast: an interruption on every large photo
// would nag, so the advice lives in the tiling field's own info panel, where a
// user who wants it will look. `softEdgeShare` is the measured soft-edge fraction
// of the first mask — the one signal that separates "this edge is blurry" from
// "this edge is already crisp", so it is what keeps the advice from firing on
// every image.
function maybeRecommendTiling(softEdgeShare: number): void {
  if (!currentImageData || tileGrid > 1) {
    tilingAdvice = null;
    return;
  }
  const rec = recommendTiling({
    imageWidth: currentImageData.width,
    imageHeight: currentImageData.height,
    softEdgeShare,
  });
  tilingAdviceFor = `${currentImageData.width}x${currentImageData.height}`;
  tilingAdvice = rec.recommended ? { reason: rec.reason, grid: rec.suggestedGrid } : null;
  applyTilingUi();
  if (rec.recommended) log(`Tiling suggestion: ${rec.reason}`);
}

function setSelectorsDisabled(disabled: boolean): void {
  // The runtime toggle is usable whenever the GPU path is reachable (an adapter
  // exists AND this host serves the WebGPU bundle), even if the CPU is the better
  // default; the user may still choose the GPU. It stays disabled when no GPU
  // path exists at all, so a locked/unlocked state never exposes a dead control.
  providerToggle.disabled = disabled || (!webGpuSelectable() && !forcedProvider);
}

// What to send as the worker's `forceProvider` for a UI-selected provider.
// A UI 'wasm' choice is explicit (skip the GPU entirely). A UI 'webgpu' choice
// (only offered when a GPU adapter exists) lets the worker try GPU with its safe
// automatic WASM fallback. Only the ?provider= override forces a single
// provider with no fallback.
function providerForce(provider: 'webgpu' | 'wasm'): string | undefined {
  if (forcedProvider) return forcedProvider;
  return provider === 'wasm' ? 'wasm' : undefined;
}

// A GPU run that failed mid-execution forces one retry on a brand-new worker,
// pinned to the CPU. The override is consumed (cleared) by that worker's load, so
// the user's provider choice still governs every later load.
let overrideProvider: 'webgpu' | 'wasm' | null = null;

function providerForceFor(provider: 'webgpu' | 'wasm'): string | undefined {
  if (overrideProvider) return overrideProvider;
  return providerForce(provider);
}

/** Posts a set-model to the worker for the current selection and arms the
 *  no-response watchdog. The model load itself resolves through waitForModel. */
function loadSelectedModel(): void {
  if (!selectedModel || !worker) return;
  // A worker that failed to start is not a model-loading problem: keep its error
  // on screen instead of overwriting it with a load that can never finish.
  if (workerFailed) return;
  if (modelLoadInFlight) return;
  modelLoadInFlight = true;
  modelReady = false;
  modelError = null;
  window.smokeModelReady = false;
  window.smokeModelPaused = false;
  window.smokeModelId = selectedModel.id;
  window.smokeProvider = selectedProvider;
  workerResponded = false;
  resetProgressClock();
  hideRecovery();
  setConsoleStatus(`Loading model ${selectedModel.id}…`, true);
  log(`Loading model: ${selectedModel.id} (${selectedModel.url})`);
  const force = providerForceFor(selectedProvider);
  if (overrideProvider) {
    log(`Provider forced to: ${overrideProvider} (retry after a GPU failure)`);
    overrideProvider = null;
  } else if (forcedProvider) log(`Provider forced to: ${forcedProvider} (from ?provider=)`);
  else if (force === 'wasm') log('Provider: CPU (WASM)');
  setSelectorsDisabled(true);
  worker.postMessage({
    kind: 'set-model',
    modelUrl: selectedModel.url,
    inputSize: selectedModel.inputSize,
    outputIsProbability: selectedModel.outputIsProbability,
    forceProvider: force,
    modelId: selectedModel.id,
    // Lets the worker use a shorter warm-run watchdog on a phone (see
    // MOBILE_WEBGPU_TIMEOUT_MS in public/inference-worker.js).
    mobile: readDeviceMobile(),
  });

  // The worker answers a set-model with a 'queued' progress message immediately,
  // so silence here means it never started. Say so instead of leaving the stage
  // line on "Starting…" with nothing in the log.
  setTimeout(() => {
    if (workerResponded || modelReady || modelError) return;
    setConsoleStatus('No response from the background-removal engine', false);
    log(
      `WARNING: the inference worker has not responded in ${WORKER_START_TIMEOUT_MS / 1000}s. ` +
        'Its script or the ONNX Runtime files may have failed to load; check the browser console.',
    );
    setSelectorsDisabled(false);
    showRecovery(
      'worker',
      'The background-removal engine did not respond. Reload the page, then try again.',
    );
  }, WORKER_START_TIMEOUT_MS);
}

// ——— Model/provider selection UI ———
// Only one model is served (the smallest; the larger variants were the same
// graph with more weight precision and no visible difference), so the UI shows
// its name rather than a dropdown. The runtime is chosen automatically and can
// be overridden in Advanced options.

// Whether the GPU path is the *default*. Both gates matter: exposing an adapter
// means nothing if the worker can't import a runtime that knows the webgpu
// backend, and `gpuState.available` is already false for software/known-slow
// adapters (see provider-gate.ts), so a "fake GPU" never becomes the default.
function webGpuUsable(): boolean {
  return gpuState?.available === true && runtimeHasWebGpuBundle;
}

// Whether the GPU can be *chosen at all*: an adapter exists and this host serves
// the WebGPU-capable bundle. A software/known-slow adapter is still selectable —
// the user is warned of the trade-off (see warnOnGpuChoice) instead of being
// blocked.
function webGpuSelectable(): boolean {
  return gpuState?.adapterPresent === true && runtimeHasWebGpuBundle;
}

function announceModel(): void {
  if (!selectedModel) return;
  const sizeMb = (selectedModel.size / 1048576).toFixed(0);
  log(`Model: ${selectedModel.label} — ${sizeMb} MB download, cached after the first visit`);
}

function applyProviderUi(): void {
  // WebGPU is offered whenever the GPU path is reachable (webGpuSelectable), not
  // only when it is the better default. The CPU remains the default for an
  // inadequate adapter, and choosing the GPU surfaces the reason as a toast.
  const offerWebGpu = webGpuSelectable();
  providerToggle.innerHTML = '';
  if (offerWebGpu) providerToggle.append(new Option('GPU (WebGPU)', 'webgpu'));
  const wasm = new Option('CPU (WASM)', 'wasm');
  providerToggle.append(wasm);
  providerToggle.value = selectedProvider;
  providerToggle.disabled = !offerWebGpu && !forcedProvider;
  // Keep this line a neutral status. The reason a GPU was not chosen by default
  // (software renderer, known-slow adapter, missing capability) is shown as a
  // popup when the user actually switches to the GPU (see warnOnGpuChoice), not
  // as a permanent hint next to the control.
  providerHint.textContent = !gpuState
    ? 'GPU status unknown — using CPU.'
    : !runtimeHasWebGpuBundle
      ? 'This host cannot serve the WebGPU runtime — using CPU.'
      : selectedProvider === 'webgpu'
        ? gpuState.available
          ? `GPU selected (${gpuState.adapter}).`
          : 'GPU selected.'
        : 'CPU selected.';
}

// Explains the CPU-is-better trade-off when the user deliberately picks the GPU
// on an adapter the gate did not endorse (software renderer, known-slow, or one
// missing a capability). Returns null when the choice is the endorsed default.
function gpuChoiceWarning(): string | null {
  if (!gpuState || gpuState.available) return null;
  if (!gpuState.adapterPresent) return null;
  return (
    `${gpuState.reason.replace(/^WebGPU skipped — /, '')}. ` +
    'The CPU path is usually faster and more accurate for this model here, but you ' +
    'asked for the GPU, so it will be used.'
  );
}

function warnOnGpuChoice(): void {
  const warning = gpuChoiceWarning();
  if (warning) showToast(warning, { kind: 'warn', title: 'Using GPU (WebGPU)' });
}

function resolveProvider(): 'webgpu' | 'wasm' {
  if (forcedProvider) {
    if (isProviderChoice(forcedProvider)) return forcedProvider;
    log(`Ignoring unknown ?provider="${forcedProvider}".`);
  }
  const pref = loadPref<unknown>(LS_PROVIDER, isProviderChoice);
  if (pref === 'wasm') return 'wasm';
  if (pref === 'webgpu' && webGpuSelectable()) return 'webgpu';
  // Default: GPU only when the adapter is a modern hardware GPU (webGpuUsable),
  // else CPU. A "fake"/software or known-slow GPU lands on CPU here.
  return webGpuUsable() ? 'webgpu' : 'wasm';
}

function resolveModel(): ModelManifestEntry {
  const byParam = resolveModelParam(models, forcedModel);
  if (byParam) {
    log(`Model forced to: ${byParam.id} (from ?model=)`);
    return byParam;
  }
  if (forcedModel) log(`Unknown model "${forcedModel}" from ?model=; using the only served model.`);
  // One model is served; ?model= still resolves for scripted runs, but there is
  // no preference to honour beyond it.
  return resolveModelParam(models, defaultModelId(models)) ?? models[0];
}

providerToggle.addEventListener('change', () => {
  if (!isProviderChoice(providerToggle.value) || providerToggle.value === selectedProvider) return;
  selectedProvider = providerToggle.value;
  savePref(LS_PROVIDER, selectedProvider);
  log(`Provider selected: ${PROVIDER_LABELS[selectedProvider]}`);
  if (selectedProvider === 'webgpu') warnOnGpuChoice();
  applyProviderUi();
  updateReprocessButton();
  void ensureModelLoaded(true);
});

// ——— Mask adjust controls ———
// The engine settings a result was produced with. The re-process button appears
// whenever the current settings differ, so it is clear the on-screen cut-out is
// stale. `null` means "no result rendered yet".
let resultSettingsKey: string | null = null;
const reprocessBtn = document.getElementById('reprocessBtn') as HTMLButtonElement | null;
const resetEngineBtn = document.getElementById('resetEngineBtn') as HTMLButtonElement | null;

function engineSettingsKey(): string {
  return [
    selectedProvider,
    maskAdjust.threshold,
    maskAdjust.feather,
    tileGrid,
    refineConfig.enabled ? 1 : 0,
    refineConfig.edgeRefinement.strength,
    refineConfig.edgeRefinement.edgeSensitivity,
    refineConfig.cleanup.islandCleanup,
  ].join('|');
}

function updateReprocessButton(): void {
  if (!reprocessBtn) return;
  const stale =
    resultSettingsKey !== null &&
    studioView.hasResult &&
    !studioView.running &&
    engineSettingsKey() !== resultSettingsKey;
  reprocessBtn.hidden = !stale;
}

function setMaskAdjust(adjust: MaskAdjust): void {
  maskAdjust = adjust;
  saveMaskAdjust();
  applyMaskUi();
  updateReprocessButton();
  log(`Mask adjust: threshold ${adjust.threshold || 'off'}, feather ${adjust.feather || 'off'}`);
}

function bindMaskControl(input: HTMLInputElement, valueEl: Element, kind: 'threshold' | 'feather'): void {
  input.addEventListener('input', () => {
    const clamped = Math.min(kind === 'threshold' ? 100 : 64, Math.max(0, Math.round(Number(input.value))));
    if (!Number.isFinite(clamped)) return;
    setMaskAdjust(kind === 'threshold' ? { ...maskAdjust, threshold: clamped } : { ...maskAdjust, feather: clamped });
    const label = clamped > 0 ? (kind === 'threshold' ? clamped + '%' : clamped + 'px') : 'off';
    valueEl.textContent = label;
    log(`Mask ${kind}: ${label}`);
  });
}

bindMaskControl(maskThresholdInput, maskThresholdValue, 'threshold');
bindMaskControl(maskFeatherInput, maskFeatherValue, 'feather');

// ——— Step editor: engine settings sidebar ———
// The advanced engine controls live in a sidebar beside the step editor. It
// hides completely via the header button (or the top-bar show/hide button) and
// drag-resizes up to 50% of the workspace width (the clamp mirrors the
// console's). `null` means the CSS default track width.
const SIDEBAR_MAX_FRACTION = 0.5;
const SIDEBAR_MIN_PX = 200;
let sidebarWidthPx: number | null = null;

// Keep the top-bar show/hide button in sync with the sidebar's collapsed state.
function renderSidebarToggle(): void {
  if (!sidebarToggleBtn) return;
  const collapsed = settingsSidebarEl?.dataset.collapsed === 'true';
  sidebarToggleBtn.setAttribute('aria-pressed', String(!collapsed));
  const label = collapsed ? 'Show settings sidebar' : 'Hide settings sidebar';
  sidebarToggleBtn.setAttribute('aria-label', label);
  sidebarToggleBtn.setAttribute('title', label);
}

function setSidebarCollapsed(collapsed: boolean): void {
  if (!settingsSidebarEl) return;
  if (!collapsed && !tabHasEngineControls(studioView.tab)) return;
  settingsSidebarEl.dataset.collapsed = collapsed ? 'true' : 'false';
  if (sidebarCollapseBtn) {
    sidebarCollapseBtn.setAttribute('aria-pressed', String(!collapsed));
    const label = collapsed ? 'Expand settings sidebar' : 'Collapse settings sidebar';
    sidebarCollapseBtn.setAttribute('aria-label', label);
    sidebarCollapseBtn.setAttribute('title', label);
  }
  renderSidebarToggle();
  if (!collapsed) applySidebarWidth(sidebarWidthPx);
}

// Pins the sidebar to an explicit pixel width (or back to the CSS default), so a
// drag can grow it. The value is always clamped to the 50% cap.
function applySidebarWidth(px: number | null): void {
  if (!settingsSidebarEl || !resultWorkspaceEl) return;
  const wsW = resultWorkspaceEl.getBoundingClientRect().width;
  if (!wsW) return;
  if (px == null) {
    sidebarWidthPx = null;
    settingsSidebarEl.style.removeProperty('--sidebar-w');
    return;
  }
  const max = wsW * SIDEBAR_MAX_FRACTION;
  const width = Math.max(SIDEBAR_MIN_PX, Math.min(px, max));
  sidebarWidthPx = width;
  settingsSidebarEl.style.setProperty('--sidebar-w', `${Math.round(width)}px`);
}

let sidebarResizing = false;
let sidebarStartX = 0;
let sidebarStartW = 0;

sidebarResizeEl?.addEventListener('pointerdown', (e) => {
  const pointer = e as PointerEvent;
  if (!settingsSidebarEl || settingsSidebarEl.dataset.collapsed === 'true') return;
  sidebarResizing = true;
  sidebarStartX = pointer.clientX;
  sidebarStartW = settingsSidebarEl.getBoundingClientRect().width;
  (sidebarResizeEl as HTMLElement).setPointerCapture(pointer.pointerId);
  document.body.classList.add('sidebar-resizing');
});
sidebarResizeEl?.addEventListener('pointermove', (e) => {
  if (!sidebarResizing) return;
  const pointer = e as PointerEvent;
  // The sidebar sits on the left and the handle is on its right edge, so
  // dragging right widens it by the same delta.
  applySidebarWidth(sidebarStartW + (pointer.clientX - sidebarStartX));
});
function endSidebarResize(): void {
  if (!sidebarResizing) return;
  sidebarResizing = false;
  document.body.classList.remove('sidebar-resizing');
}
sidebarResizeEl?.addEventListener('pointerup', endSidebarResize);
sidebarResizeEl?.addEventListener('pointercancel', endSidebarResize);
sidebarResizeEl?.addEventListener('keydown', (e) => {
  const key = (e as KeyboardEvent).key;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
  e.preventDefault();
  const current = settingsSidebarEl?.getBoundingClientRect().width ?? 0;
  applySidebarWidth(current + (key === 'ArrowRight' ? 24 : -24));
});
window.addEventListener('resize', () => {
  if (sidebarWidthPx != null) applySidebarWidth(sidebarWidthPx);
});

// The top-bar button shows/hides the sidebar; the in-sidebar button collapses
// it too. Both drive the same state, so they stay in sync.
sidebarToggleBtn?.addEventListener('click', () => {
  const collapsed = settingsSidebarEl?.dataset.collapsed === 'true';
  setSidebarCollapsed(!collapsed);
});
sidebarCollapseBtn?.addEventListener('click', () => {
  const collapsed = settingsSidebarEl?.dataset.collapsed === 'true';
  setSidebarCollapsed(!collapsed);
});

// ——— Export bar: the step result or the whole Bulk batch ———
// The encoder can fall back to PNG for a format the browser cannot produce
// (WebP), so the archive entry takes its extension from the actual data URL.
function dataUrlExtension(dataUrl: string, fallback: string): string {
  if (dataUrl.startsWith('data:image/png')) return 'png';
  if (dataUrl.startsWith('data:image/jpeg')) return 'jpg';
  if (dataUrl.startsWith('data:image/webp')) return 'webp';
  return fallback;
}

function uniqueZipName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let index = 2;
  let candidate = `${base}-${index}${extension}`;
  while (used.has(candidate)) candidate = `${base}-${++index}${extension}`;
  used.add(candidate);
  return candidate;
}

function bulkExportTargets(): BulkItem[] {
  const done = bulkState.items.filter((item) => item.status === 'done' && bulkResults.has(item.id));
  const checked = done.filter((item) => bulkState.checkedIds.includes(item.id));
  return checked.length ? checked : done;
}

function downloadAllBulk(): void {
  const targets = bulkExportTargets();
  if (!targets.length) return;
  const used = new Set<string>();
  const entries = targets.flatMap((item) => {
    const canvas = bulkResults.get(item.id);
    if (!canvas) return [];
    const dataUrl = canvasToDataUrl(canvas, exportFormat, item.background ?? background);
    const extension = dataUrlExtension(dataUrl, exportFormatInfo(exportFormat).extension);
    return [
      {
        name: uniqueZipName(bulkDownloadName(item, extension), used),
        data: dataUrlToBytes(dataUrl),
      },
    ];
  });
  if (!entries.length) return;
  log(`Downloading ${entries.length} bulk cut-out(s) as a ZIP archive.`);

  const url = URL.createObjectURL(createZipBlob(entries));
  const link = document.createElement('a');
  link.href = url;
  link.download = `background-removed-${entries.length}-photos.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  trackDownloadInitiated();
}
bulkDownloadAllBtn?.addEventListener('click', downloadAllBulk);

// ——— Bulk queue ———
function updateBulkStatus(): void {
  if (!bulkStatusEl) return;
  if (!bulkBatchRunning) {
    bulkStatusEl.hidden = true;
    return;
  }
  const active = bulkActiveCount(bulkState);
  const done = bulkDoneCount(bulkState);
  const pct = studioView.percent;
  bulkStatusEl.hidden = false;
  bulkStatusEl.textContent =
    `Processing — ${done} cut-out(s) ready, ${active} left` + (pct === null ? '…' : ` — ${pct}%`);
}

function bulkStatusLabel(item: BulkItem): string {
  switch (item.status) {
    case 'processing':
      return 'Processing…';
    case 'done':
      return 'Cut-out ready';
    case 'error':
      return item.error ?? 'Failed';
    default:
      return 'Queued';
  }
}

function bulkBackgroundChoice(): BackgroundChoice {
  return {
    kind: 'color',
    hex: bulkBgColorInput?.value ?? '#ffffff',
    alpha: Number(bulkBgAlphaInput?.value ?? 100),
  };
}

function updateBulkToolbar(): void {
  const total = bulkState.items.length;
  const checked = bulkCheckedCount(bulkState);
  const done = bulkDoneCount(bulkState);
  if (bulkSelectAllEl) {
    bulkSelectAllEl.disabled = total === 0;
    bulkSelectAllEl.checked = total > 0 && checked === total;
    bulkSelectAllEl.indeterminate = checked > 0 && checked < total;
  }
  if (bulkSelectionCountEl) bulkSelectionCountEl.textContent = `${checked} selected`;
  if (bulkDeleteSelectedBtn) bulkDeleteSelectedBtn.disabled = bulkBatchRunning || checked === 0;
  if (bulkClearFinishedBtn) bulkClearFinishedBtn.disabled = bulkBatchRunning || done === 0;
  if (bulkBgApplyBtn) bulkBgApplyBtn.disabled = bulkBatchRunning || total === 0;
  if (bulkBgTransparentBtn) bulkBgTransparentBtn.disabled = bulkBatchRunning || total === 0;
}

function renderBulk(): void {
  if (!bulkGridEl) return;
  bulkGridEl.innerHTML = '';
  if (bulkEmptyEl) bulkEmptyEl.hidden = bulkState.items.length > 0;
  const active = bulkActiveCount(bulkState);
  const done = bulkDoneCount(bulkState);
  if (bulkCountEl) {
    bulkCountEl.textContent = `${active} / ${BULK_LIMIT}` + (done ? ` · ${done} done` : '');
  }
  const capacity = bulkCapacity(bulkState);
  if (bulkPickBtn) {
    bulkPickBtn.disabled = bulkBatchRunning || capacity === 0;
    bulkPickBtn.textContent = capacity === 0 ? `Maximum ${BULK_LIMIT} active` : 'Choose images';
  }
  if (bulkProcessBtn) {
    const pending = bulkPendingCount(bulkState);
    bulkProcessBtn.disabled = bulkBatchRunning || pending === 0;
    bulkProcessBtn.textContent = bulkBatchRunning
      ? 'Processing…'
      : pending > 0
        ? `Process ${pending}`
        : 'Process all';
  }

  for (const item of bulkState.items) {
    const checked = bulkState.checkedIds.includes(item.id);
    const card = document.createElement('div');
    card.className = 'bulkCard';
    card.dataset.selected = String(item.id === bulkState.selectedId);
    card.dataset.checked = String(checked);
    card.dataset.status = item.status;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Select ${item.name}`);
    const select = (): void => {
      bulkState = selectBulkItem(bulkState, item.id);
      renderBulk();
    };
    card.addEventListener('click', select);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select();
      }
    });

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'bulkCheck';
    check.checked = checked;
    check.setAttribute('aria-label', `Select ${item.name} for bulk actions`);
    check.addEventListener('click', (e) => e.stopPropagation());
    check.addEventListener('change', () => {
      bulkState = setBulkChecked(bulkState, item.id, check.checked);
      renderBulk();
    });
    card.appendChild(check);

    const thumb = document.createElement('img');
    thumb.className = 'bulkThumb';
    thumb.alt = '';
    thumb.src = item.resultUrl ?? item.originalUrl;
    if (item.resultUrl && item.background && !isTransparent(item.background)) {
      thumb.style.backgroundImage = 'none';
      thumb.style.backgroundColor = toRgba(item.background);
    }
    card.appendChild(thumb);

    const meta = document.createElement('div');
    meta.className = 'bulkMeta';
    const name = document.createElement('span');
    name.className = 'bulkName';
    name.textContent = item.name;
    const dims = document.createElement('span');
    dims.className = 'bulkDims';
    dims.textContent = formatDims(item.width, item.height);
    meta.appendChild(name);
    meta.appendChild(dims);
    card.appendChild(meta);

    const status = document.createElement('span');
    status.className = 'bulkItemStatus';
    status.textContent = bulkStatusLabel(item);
    card.appendChild(status);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'bulkRemove';
    remove.setAttribute('aria-label', `Remove ${item.name}`);
    remove.textContent = '×';
    remove.disabled = bulkBatchRunning;
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      removeBulkFile(item.id);
    });
    card.appendChild(remove);
    bulkGridEl.appendChild(card);
  }
  updateBulkToolbar();
  updateBulkStatus();
  updateExportBarVisibility();
}

function removeBulkFile(id: number): void {
  const { state, revoked } = removeBulkItem(bulkState, id);
  bulkState = state;
  for (const url of revoked) URL.revokeObjectURL(url);
  bulkBlobs.delete(id);
  bulkResults.delete(id);
  renderBulk();
}

function removeSelectedBulkFiles(): void {
  const ids = [...bulkState.checkedIds];
  if (!ids.length) return;
  const { state, revoked } = removeBulkItems(bulkState, ids);
  bulkState = state;
  for (const url of revoked) URL.revokeObjectURL(url);
  for (const id of ids) {
    bulkBlobs.delete(id);
    bulkResults.delete(id);
  }
  renderBulk();
  log(`Bulk: removed ${ids.length} image(s).`);
}

function clearFinishedBulk(): void {
  const { state, revoked } = clearFinishedBulkItems(bulkState);
  const dropped = new Set(bulkState.items.filter((item) => item.status === 'done').map((item) => item.id));
  bulkState = state;
  for (const url of revoked) URL.revokeObjectURL(url);
  for (const id of dropped) {
    bulkBlobs.delete(id);
    bulkResults.delete(id);
  }
  renderBulk();
  if (dropped.size) log(`Bulk: cleared ${dropped.size} finished image(s).`);
}

function applyBulkBackground(choice: BackgroundChoice | null): void {
  const targets = bulkCheckedCount(bulkState) ? bulkState.checkedIds : bulkState.items.map((item) => item.id);
  if (!targets.length) {
    showToast('Add or select an image first.', { kind: 'warn' });
    return;
  }
  bulkState = setBulkBackground(bulkState, targets, choice);
  renderBulk();
  log(
    choice
      ? `Bulk background: ${describeChoice(choice)} for ${targets.length} image(s).`
      : `Bulk background: cleared for ${targets.length} image(s).`,
  );
}

function pickBulkFiles(): void {
  if (bulkCapacity(bulkState) === 0) {
    showToast(
      `Bulk handles up to ${BULK_LIMIT} active images. Wait for the batch to finish or remove one.`,
      { kind: 'warn' },
    );
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp';
  input.multiple = true;
  input.onchange = () => void addBulkFiles(Array.from(input.files ?? []));
  input.click();
}

async function addBulkFiles(files: File[]): Promise<void> {
  const capacity = bulkCapacity(bulkState);
  if (capacity === 0) {
    showToast(
      `Bulk handles up to ${BULK_LIMIT} active images. Wait for the batch to finish or remove one.`,
      { kind: 'warn' },
    );
    return;
  }
  if (files.length > capacity) {
    showToast(`Bulk handles up to ${BULK_LIMIT} active images; adding the first ${capacity}.`, {
      kind: 'warn',
    });
  }
  for (const file of files.slice(0, capacity)) {
    const typeCheck = validateFileTypeAndSize(file);
    if (!typeCheck.ok) {
      error(typeCheck.reason, 'upload');
      continue;
    }
    const url = URL.createObjectURL(file);
    let img: HTMLImageElement;
    try {
      img = await loadImageElement(url);
    } catch {
      URL.revokeObjectURL(url);
      error('Failed to decode image', 'upload');
      continue;
    }
    const sourceScale = sourceScaleDecision(img.naturalWidth, img.naturalHeight);
    if (sourceScale.downscaled) log(sourceScale.reason);
    const dimCheck = validateDimensions(sourceScale.width, sourceScale.height);
    if (!dimCheck.ok) {
      URL.revokeObjectURL(url);
      error(dimCheck.reason, 'upload');
      continue;
    }
    // The card thumbnail must not keep a full-resolution decode alive for every
    // queued photo; a batch of five phone photos is the worst case for memory.
    let displayUrl = url;
    if (sourceScale.downscaled) {
      const canvas = document.createElement('canvas');
      canvas.width = sourceScale.width;
      canvas.height = sourceScale.height;
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const scaledBlob = await canvasToPngBlob(canvas);
      if (scaledBlob) {
        displayUrl = URL.createObjectURL(scaledBlob);
        URL.revokeObjectURL(url);
      }
    }
    const added = addBulkItem(bulkState, {
      name: file.name || `Photo ${bulkState.nextId}`,
      width: sourceScale.width,
      height: sourceScale.height,
      originalUrl: displayUrl,
    });
    bulkState = added.state;
    if (!added.item) {
      URL.revokeObjectURL(displayUrl);
      break;
    }
    bulkBlobs.set(added.item.id, file);
  }
  renderBulk();
  log(`Bulk: ${bulkState.items.length} image(s) in the queue.`);
}

bulkPickBtn?.addEventListener('click', pickBulkFiles);
bulkProcessBtn?.addEventListener('click', () => void processBulkBatch());
bulkSelectAllEl?.addEventListener('change', () => {
  bulkState = setBulkCheckedAll(bulkState, bulkSelectAllEl.checked);
  renderBulk();
});
bulkDeleteSelectedBtn?.addEventListener('click', removeSelectedBulkFiles);
bulkClearFinishedBtn?.addEventListener('click', clearFinishedBulk);
bulkBgAlphaInput?.addEventListener('input', () => {
  if (bulkBgAlphaValueEl) bulkBgAlphaValueEl.textContent = `${bulkBgAlphaInput.value}%`;
});
bulkBgApplyBtn?.addEventListener('click', () => applyBulkBackground(bulkBackgroundChoice()));
bulkBgTransparentBtn?.addEventListener('click', () => applyBulkBackground(TRANSPARENT));
renderBulk();

// A bulk batch drives the same single-image pipeline, so it temporarily takes
// over the step editor. Snapshot the step photo/result and put them back when the
// batch ends; the user's single-image work is never lost.
interface StepSnapshot {
  image: HTMLImageElement | null;
  imageData: ImageData | null;
  objectUrl: string | null;
  imageName: string;
  result: HTMLCanvasElement | null;
  preview: HTMLCanvasElement | null;
  alpha: Uint8ClampedArray | null;
  view: typeof studioView;
  settingsKey: string | null;
}

function snapshotStep(): StepSnapshot {
  return {
    image: currentImage,
    imageData: currentImageData,
    objectUrl: currentObjectUrl,
    imageName: currentImageName,
    result: lastResultCanvas,
    preview: lastPreviewCanvas,
    alpha: lastResultAlpha,
    view: studioView,
    settingsKey: resultSettingsKey,
  };
}

function restoreStep(snapshot: StepSnapshot): void {
  invalidateActiveJob();
  if (currentObjectUrl && currentObjectUrl !== snapshot.objectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
  }
  currentImage = snapshot.image;
  currentImageData = snapshot.imageData;
  currentObjectUrl = snapshot.objectUrl;
  currentImageName = snapshot.imageName;
  lastResultCanvas = snapshot.result;
  lastPreviewCanvas = snapshot.preview;
  lastResultAlpha = snapshot.alpha;
  outputBox.innerHTML = '';
  outputBox.classList.remove('hasResultCompare');
  resultCompareFigure = null;
  if (snapshot.objectUrl) {
    inputPreviewImg.src = snapshot.objectUrl;
    inputPreviewEl.hidden = false;
    stepInputEl.classList.add('has-preview');
  } else {
    inputPreviewImg.removeAttribute('src');
    inputPreviewEl.hidden = true;
    stepInputEl.classList.remove('has-preview');
  }
  outputSection.hidden = !snapshot.result;
  // Keep whatever tab the user is on: the batch normally leaves them on Bulk to
  // download, but a manual tab switch during the run is respected.
  studioView = { ...snapshot.view, tab: studioView.tab };
  resultSettingsKey = snapshot.settingsKey;
  applyStudioView();
  if (snapshot.result) {
    renderResultPreview();
    applyFormatUi();
  }
}

interface EngineSnapshot {
  maskAdjust: MaskAdjust;
  tileGrid: TileGrid;
  refine: FastRefinementConfig;
}

function snapshotEngine(): EngineSnapshot {
  return {
    maskAdjust: { ...maskAdjust },
    tileGrid,
    refine: {
      ...refineConfig,
      maskUpscale: { ...refineConfig.maskUpscale },
      edgeRefinement: { ...refineConfig.edgeRefinement },
      cleanup: { ...refineConfig.cleanup },
      performance: { ...refineConfig.performance },
    },
  };
}

// Bulk runs never inherit the experimental Photo/Result engine controls: the
// batch uses the stock mask adjustment, a single full-image pass, and the
// default refinement config. The user's settings are restored when it ends.
function applyDefaultEngine(): void {
  maskAdjust = { ...DEFAULT_MASK_ADJUST };
  tileGrid = 1;
  Object.assign(refineConfig, resolveRefinementConfig());
  applyMaskUi();
  applyTilingUi();
  applyRefineUi();
  updateReprocessButton();
}

function restoreEngine(snapshot: EngineSnapshot): void {
  maskAdjust = snapshot.maskAdjust;
  tileGrid = snapshot.tileGrid;
  Object.assign(refineConfig, snapshot.refine);
  applyMaskUi();
  applyTilingUi();
  applyRefineUi();
  updateReprocessButton();
}

async function processBulkBatch(): Promise<void> {
  if (bulkBatchRunning) return;
  if (studioView.running) {
    showToast('Wait for the current photo to finish before starting a bulk run.', { kind: 'warn' });
    return;
  }
  if (modelError) {
    showToast(modelError, { kind: 'error' });
    return;
  }
  const pending = bulkState.items.filter((item) => item.status !== 'done');
  if (!pending.length) return;

  const snapshot = snapshotStep();
  const engine = snapshotEngine();
  protectedObjectUrl = currentObjectUrl;
  bulkBatchRunning = true;
  bulkTabPinned = true;
  downloadConsentDeclined = false;
  setStudioTab('bulk', true);
  applyDefaultEngine();
  log('Bulk: using the default engine settings.');
  renderBulk();
  const total = pending.length;
  let index = 0;
  try {
    for (const item of pending) {
      index += 1;
      bulkState = updateBulkItem(bulkState, item.id, { status: 'processing', error: null });
      renderBulk();
      const blob = bulkBlobs.get(item.id);
      if (!blob) {
        bulkState = updateBulkItem(bulkState, item.id, {
          status: 'error',
          error: 'Source photo is no longer available',
        });
        renderBulk();
        continue;
      }
      log(`Bulk ${index}/${total}: processing a ${item.width}x${item.height} photo.`);
      const file = new File([blob], item.name, { type: blob.type || 'image/png' });
      const revisionBefore = resultRevision;
      await loadImageFromFile(file, librarySavingEnabled);
      const run = activeRunPromise;
      if (run) await run;
      if (downloadConsentDeclined) {
        bulkState = updateBulkItem(bulkState, item.id, {
          status: 'error',
          error: 'Model download not confirmed',
        });
        log('Bulk run stopped: the model download was not confirmed.');
        break;
      }
      await waitForJobSettled();
      // The library write is queued behind a PNG encode; let it finish before the
      // next run bumps the run token, or the write would be dropped.
      await libraryWriteQueue;
      // A run that never painted a result must not reuse the previous item's
      // canvas; resultRevision only moves when a fresh result lands.
      const canvas = resultRevision !== revisionBefore ? lastResultCanvas : null;
      if (canvas) {
        bulkResults.set(item.id, canvas);
        const png = await canvasToPngBlob(previewFromCanvas(canvas));
        const resultUrl = png ? URL.createObjectURL(png) : null;
        bulkState = updateBulkItem(bulkState, item.id, { status: 'done', resultUrl });
        log(`Bulk ${index}/${total}: cut-out ready (${canvas.width}x${canvas.height}).`);
      } else {
        bulkState = updateBulkItem(bulkState, item.id, { status: 'error', error: 'No cut-out produced' });
        log(`Bulk ${index}/${total}: no cut-out produced.`);
      }
      renderBulk();
    }
  } finally {
    bulkBatchRunning = false;
    bulkTabPinned = false;
    restoreStep(snapshot);
    restoreEngine(engine);
    protectedObjectUrl = null;
    renderBulk();
    log(`Bulk finished: ${bulkDoneCount(bulkState)} of ${bulkState.items.length} cut-out(s).`);
  }
}

// ——— Info bubbles ———
// Each "?" toggles a floating explanation panel. The panel is positioned in
// viewport coordinates and overlays the page, so opening it never reflows the
// sidebar or moves the controls below it. Only one panel is open at a time.
const infoBubbles = Array.from(document.querySelectorAll<HTMLButtonElement>('.infoBubble'));
let openInfoBubble: HTMLButtonElement | null = null;

function closeInfoPanels(except?: HTMLElement | null): void {
  for (const bubble of infoBubbles) {
    const target = document.getElementById(bubble.dataset.infoTarget ?? '');
    if (target && target !== except) {
      target.hidden = true;
      bubble.setAttribute('aria-expanded', 'false');
    }
  }
  if (!except) openInfoBubble = null;
}

// Place the panel next to its "?", right-aligned and flipped above when there
// is not enough room below. The width is clamped to the viewport.
function positionInfoPanel(panel: HTMLElement, bubble: HTMLButtonElement): void {
  const margin = 8;
  const width = Math.min(320, window.innerWidth - margin * 2);
  panel.style.width = `${width}px`;
  const height = panel.offsetHeight;
  const rect = bubble.getBoundingClientRect();
  const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - height - 6);
  }
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function toggleInfoPanel(bubble: HTMLButtonElement): void {
  const target = document.getElementById(bubble.dataset.infoTarget ?? '');
  if (!target) return;
  const willOpen = target.hidden;
  if (!willOpen) {
    target.hidden = true;
    bubble.setAttribute('aria-expanded', 'false');
    openInfoBubble = null;
    return;
  }
  closeInfoPanels(target);
  target.hidden = false;
  bubble.setAttribute('aria-expanded', 'true');
  openInfoBubble = bubble;
  positionInfoPanel(target, bubble);
}

for (const bubble of infoBubbles) {
  bubble.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleInfoPanel(bubble);
  });
}

// A click outside the open panel/bubble closes it. Clicking the bubble itself is
// left to the click handler so it can toggle shut.
document.addEventListener('pointerdown', (e) => {
  if (!openInfoBubble) return;
  const panel = document.getElementById(openInfoBubble.dataset.infoTarget ?? '');
  const target = e.target as Node | null;
  if (!target) return;
  if (openInfoBubble.contains(target) || panel?.contains(target)) return;
  closeInfoPanels();
});

// Escape closes the explanation before it reaches the studio's close handler.
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || !openInfoBubble) return;
    e.stopPropagation();
    const bubble = openInfoBubble;
    closeInfoPanels();
    bubble.focus();
  },
  true,
);

const repositionOpenInfoPanel = (): void => {
  if (!openInfoBubble) return;
  const panel = document.getElementById(openInfoBubble.dataset.infoTarget ?? '');
  if (panel && !panel.hidden) positionInfoPanel(panel, openInfoBubble);
};
window.addEventListener('resize', repositionOpenInfoPanel);
document
  .querySelector('.settingsSidebarBody')
  ?.addEventListener('scroll', repositionOpenInfoPanel, { passive: true });

// ——— Tiled inference control ———
function tilingLabel(grid: TileGrid): string {
  return grid === 1 ? 'Off' : `${grid} × ${grid}`;
}
function applyTilingUi(): void {
  if (tilingSelect) tilingSelect.value = tileGrid === 1 ? 'off' : String(tileGrid);
  if (tilingValueEl) tilingValueEl.textContent = tilingLabel(tileGrid);
  // Explain why tiling is unavailable for a small photo, so the option never
  // silently does nothing.
  const img = currentImageData;
  if (tilingHintEl) {
    tilingHintEl.hidden = !img;
    if (img) {
      const longSide = Math.max(img.width, img.height);
      tilingHintEl.textContent =
        longSide < TILING_MIN_LONG_SIDE
          ? `This photo is ${longSide}px on its longest side — below the ${TILING_MIN_LONG_SIDE}px minimum, so a single pass is used.`
          : `Runs the model on overlapping tiles and crossfades the masks. ${tileGrid > 1 ? `Currently ${tileGrid} × ${tileGrid} = ${tileGrid * tileGrid} passes.` : 'Best for large photos whose mask is upscaled a lot.'}`;
    }
  }
  // The per-photo recommendation, shown inside the info panel (never a toast).
  // Hidden when tiling is already on or not advised for this photo. A new photo
  // (different size key) clears any advice left over from the previous image.
  if (img && tilingAdvice && tilingAdviceFor !== `${img.width}x${img.height}`) {
    tilingAdvice = null;
  }
  if (tilingAdviceEl) {
    tilingAdviceEl.hidden = !tilingAdvice;
    tilingAdviceEl.textContent = tilingAdvice ? `Recommended for this photo: ${tilingAdvice.reason}` : '';
  }
  if (tilingApplyBtn) {
    tilingApplyBtn.hidden = !tilingAdvice;
    if (tilingAdvice) tilingApplyBtn.textContent = `Run ${tilingAdvice.grid} × ${tilingAdvice.grid} tiles`;
  }
}
tilingSelect?.addEventListener('change', () => {
  const v = Number(tilingSelect.value);
  tileGrid = (v === 2 || v === 3 || v === 4 ? v : 1) as TileGrid;
  savePref('remove-bg:tiles', tileGrid);
  applyTilingUi();
  log(`Tiled inference: ${tileGrid === 1 ? 'off' : `${tileGrid}x${tileGrid}`}`);
  updateReprocessButton();
});
// The recommendation's one-click apply, inside the info panel. Re-runs with the
// suggested grid, like the old toast action did.
tilingApplyBtn?.addEventListener('click', () => {
  if (!tilingAdvice) return;
  tileGrid = tilingAdvice.grid;
  savePref('remove-bg:tiles', tileGrid);
  tilingAdvice = null;
  applyTilingUi();
  if (currentImageData) {
    setStudioTab('step', true);
    void runSmoke();
  }
});

// ——— Edge refinement + island cleanup controls ———
// The product previously exposed refinement only through URL params. The sidebar
// now surfaces the two knobs that matter (on/off and strength/sensitivity), each
// mapping onto the same config the URL params resolve to.
const ISLAND_CLEANUP_LABELS = {
  fine: { short: 'Fine', log: 'fine (2e-5) — keeps small detail' },
  strict: { short: 'Strict', log: 'strict (5e-4) — removes speckle' },
} as const;

function applyRefineUi(): void {
  if (refineToggle) refineToggle.value = refineConfig.enabled ? 'on' : 'off';
  if (refineValueEl) refineValueEl.textContent = refineConfig.enabled ? 'On' : 'Off';
  if (refineStrengthInput) refineStrengthInput.value = String(Math.round(refineConfig.edgeRefinement.strength * 100));
  if (refineStrengthValueEl) refineStrengthValueEl.textContent = refineConfig.edgeRefinement.strength.toFixed(2);
  if (refineEdgeSensitivityInput) {
    refineEdgeSensitivityInput.value = String(Math.round(refineConfig.edgeRefinement.edgeSensitivity * 100));
  }
  if (refineEdgeSensitivityValueEl) {
    refineEdgeSensitivityValueEl.textContent = refineConfig.edgeRefinement.edgeSensitivity.toFixed(2);
  }
  if (islandCleanupSelect) islandCleanupSelect.value = refineConfig.cleanup.islandCleanup;
  if (islandCleanupValueEl) {
    islandCleanupValueEl.textContent = ISLAND_CLEANUP_LABELS[refineConfig.cleanup.islandCleanup].short;
  }
  // The two sliders only matter when the stage is on.
  if (refineFieldEl) refineFieldEl.dataset.disabled = String(!refineConfig.enabled);
}
refineToggle?.addEventListener('change', () => {
  refineConfig.enabled = refineToggle.value !== 'off';
  applyRefineUi();
  log(`Edge refinement: ${refineConfig.enabled ? 'on' : 'off'}`);
  updateReprocessButton();
});
refineStrengthInput?.addEventListener('input', () => {
  const v = Math.max(0, Math.min(100, Number(refineStrengthInput.value))) / 100;
  refineConfig.edgeRefinement.strength = v;
  if (refineStrengthValueEl) refineStrengthValueEl.textContent = v.toFixed(2);
  updateReprocessButton();
});
refineEdgeSensitivityInput?.addEventListener('input', () => {
  const v = Math.max(5, Math.min(400, Number(refineEdgeSensitivityInput.value))) / 100;
  refineConfig.edgeRefinement.edgeSensitivity = v;
  if (refineEdgeSensitivityValueEl) refineEdgeSensitivityValueEl.textContent = v.toFixed(2);
  updateReprocessButton();
});
islandCleanupSelect?.addEventListener('change', () => {
  if (!isIslandCleanup(islandCleanupSelect.value)) return;
  refineConfig.cleanup.islandCleanup = islandCleanupSelect.value;
  applyRefineUi();
  log(`Island cleanup: ${ISLAND_CLEANUP_LABELS[refineConfig.cleanup.islandCleanup].log}`);
  updateReprocessButton();
});
applyTilingUi();
applyRefineUi();

// Re-run inference with the current engine settings, then jump to the Processing
// tab so the user sees the run they asked for.
reprocessBtn?.addEventListener('click', () => {
  if (!currentImageData) return;
  setStudioTab('step', true);
  void runSmoke();
});

// Restore every engine control to its default: the GPU gate's provider, mask
// threshold/feather off, tiling off, and the stock edge-refinement config.
function resetEngineOptions(): void {
  const defaultProvider: 'webgpu' | 'wasm' = webGpuUsable() ? 'webgpu' : 'wasm';
  if (selectedProvider !== defaultProvider) {
    selectedProvider = defaultProvider;
    savePref(LS_PROVIDER, selectedProvider);
    applyProviderUi();
    void ensureModelLoaded(true);
  }

  maskAdjust = { ...DEFAULT_MASK_ADJUST };
  saveMaskAdjust();
  applyMaskUi();

  tileGrid = 1;
  savePref('remove-bg:tiles', tileGrid);
  applyTilingUi();

  Object.assign(refineConfig, resolveRefinementConfig());
  applyRefineUi();

  updateReprocessButton();
  log('Engine options reset to their defaults.');
}
resetEngineBtn?.addEventListener('click', resetEngineOptions);

type PendingRun = { resolve: (ms: number) => void; reject: (err: Error) => void };
const pendingRuns = new Map<number, PendingRun>();
let nextRunId = 1;

function failPendingRuns(err: Error): void {
  for (const [id, p] of pendingRuns) {
    pendingRuns.delete(id);
    p.reject(err);
  }
}

// Posts one run message. The tensor buffer is transferred, so it cannot be
// reused after this call.
function postRunMessage(runId: number, imageData: ImageData): void {
  const tensor = imageDataToTensor(imageData);
  worker!.postMessage(
    { kind: 'run', runId, tensor, width: imageData.width, height: imageData.height },
    [tensor.buffer],
  );
}

// Runs one inference and resolves with its duration. Rejects if the worker
// reports an error, so callers never wait forever on a failed run.
function runOneInference(): Promise<number> {
  if (!currentImageData || !worker) return Promise.reject(new Error('No image loaded'));
  const imageData = currentImageData;
  setConsoleStatus('Removing background…', true);
  if (window.smokeProvider === 'webgpu' && timings.length === 0) {
    log('First GPU run compiles shaders; this can take a minute or two.');
  }
  const runId = nextRunId++;
  currentRunId = runId;
  smokeRefineStages = null;
  return new Promise<number>((resolve, reject) => {
    pendingRuns.set(runId, { resolve, reject });
    // Transfer the tensor buffer instead of structured-cloning it (12.6 MB/run).
    postRunMessage(runId, imageData);
  });
}

// A GPU run failed mid-execution. Rather than let the worker rebuild a WASM
// session inside the same ORT module (which the aborted GPU run may have left
// corrupted — a numerically wrong, flat mask), discard the whole worker and
// continue on a fresh one pinned to the CPU. The failed run's pending promise is
// reused, so the caller (runSmoke) sees one run that eventually succeeds.
async function restartOnFreshWorker(msg: {
  from: string;
  to: string;
  reason: string;
  runId: number;
}): Promise<void> {
  // A run that already settled (superseded or failed) needs no retry.
  if (!pendingRuns.has(msg.runId)) return;
  log(
    `Provider fallback: ${msg.from} → ${msg.to} (${msg.reason})\n` +
      'WARNING: the GPU could not run this model. Retrying on a fresh CPU worker, ' +
      'which can take several minutes per image.',
  );
  setStage(`Running on CPU (${msg.to}) — this is slow, please wait…`);

  // Discard the worker and its ORT module entirely; a fresh module cannot inherit
  // state from the aborted GPU run. The model bytes go with it, but the asset
  // cache serves them locally on the reload.
  worker?.terminate();
  worker = null;
  workerFailed = false;
  // The retry must run on the CPU; this override is consumed by the next load.
  overrideProvider = msg.to === 'webgpu' ? 'webgpu' : 'wasm';

  worker = createInferenceWorker();
  loadSelectedModel();
  try {
    await waitForModel();
  } catch (e) {
    failPendingRuns(e instanceof Error ? e : new Error(String(e)));
    return;
  }
  // The fresh load's `load-time` message reports its own (clean) provider facts,
  // so record the run-time fallback AFTER it, or it would be overwritten with a
  // bare "no fallback" from the retry's load.
  window.smokeProvider = msg.to;
  fallbackReason = msg.reason;
  if (msg.to === 'wasm' || msg.to === 'webgpu') actualProvider = msg.to;
  // The run may have settled (superseded or failed) while the worker was
  // loading; only re-run it if it is still pending, or its caller would hang.
  if (!pendingRuns.has(msg.runId) || !currentImageData) return;
  // Re-run the failed inference on the fresh worker, reusing its run id so its
  // pending promise settles when this run finishes. For a tiled run the failed
  // inference was one tile, so re-post that tile's pixels, not the whole image.
  const tiled = tiledRuns.get(msg.runId);
  setConsoleStatus('Removing background…', true);
  if (tiled) postRunMessage(msg.runId, tiled.state.tiles[tiled.tileIndex]);
  else postRunMessage(msg.runId, currentImageData);
}

function finishedRun(): void {
  const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
  const model = selectedModel ? `${selectedModel.id} (${(selectedModel.size / 1048576).toFixed(1)} MB)` : '<none>';
  log(`--- Summary ---`);
  log(`Warm inference timings (${timings.length} run${timings.length === 1 ? '' : 's'}): ${timings.map((t) => t.toFixed(1)).join(', ')} ms`);
  log(`Average: ${avg.toFixed(1)} ms`);
  log(`Provider: ${window.smokeProvider || '<reported above>'}`);
  log(`Model: ${model}`);
}

function chooseFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (f) await loadImageFromFile(f);
  };
  input.click();
}

// Drag/drop (MVP §6) and keyboard activation of the drop zone (it is a
// role=button with tabindex, so Enter/Space must do what a click does).
dropZone.addEventListener('click', chooseFile);
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    chooseFile();
  }
});
// The selected-photo preview replaces the drop zone once a photo exists, so it
// takes over the "choose another image" job: clicking it re-opens the picker.
inputPreviewEl.addEventListener('click', chooseFile);
newPhotoBtn?.addEventListener('click', chooseFile);
inputPreviewEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    chooseFile();
  }
});
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const f = e.dataTransfer?.files?.[0];
  if (f) await loadImageFromFile(f);
});

// === Programmatic API for automated/headless runs ===
// window.runSmoke(imgUrl?) loads an image (if given), waits for the model, then
// runs WARM_RUNS inferences and reports a summary via a registered callback.
type RunDone = {
  timings: number[];
  avgMs: number;
  provider: string;
  modelId: string;
};

declare global {
  interface Window {
    runSmoke: (imgUrl?: string, runs?: number) => Promise<RunDone | null>;
    onSmokeDone: ((result: RunDone, maskDataUrl: string) => void) | null;
    smokeModelReady: boolean;
    smokeProvider: string;
    /** Manifest id of the currently loaded model, e.g. 'model_512_int8_fp16'. */
    smokeModelId: string;
    /** True while the model download is stopped because the link became metered. */
    smokeModelPaused: boolean;
    /** Per-run refinement stage timings (upscale/filter/cleanup/total), or null. */
    smokeRefineStages: Record<string, unknown> | null;
    /** Resolves once the current job has produced its final (refined) preview. */
    waitForJobSettled: () => Promise<void>;
    crossOriginIsolated: boolean;
    /** Copyable diagnostic report (GPU adapter, model, timings, raw-mask stats). */
    deviceReport: () => string;
    /** The structured diagnostic report object (same data, for scripted tests). */
    diagnosticReport: () => ReturnType<typeof diagnosticReport>;
  }
}

const announcedLog: string[] = [];

async function runSmoke(imgUrl?: string, runs = WARM_RUNS): Promise<RunDone | null> {
  if (imgUrl) {
    try {
      await loadImageFromUrl(imgUrl);
    } catch (e) {
      error(e instanceof Error ? e.message : String(e), 'upload');
      return null;
    }
  }
  if (!currentImageData) {
    error('No image loaded');
    return null;
  }
  // A run needs the model before it can start. On a metered link that is the
  // user's decision, not the photo picker's: ask first and wait for the answer
  // instead of silently spending their data plan. A dismissed prompt cancels
  // the run; Wi-Fi arriving in the meantime resolves it as a confirmation.
  if (!modelReady && !modelError) {
    const canDownload = await ensureModelLoaded();
    if (!canDownload) {
      setStage('Paused — download the model to remove the background.');
      return null;
    }
  }
  hideRecovery();
  clearOutput();
  beginLibraryRun();
  // The panel's progress spans the whole run. A model that still has to be
  // fetched starts in the download band; one already on the device starts at
  // the session-build band, so the bar never sits at a bare 0%.
  if (!modelReady && !modelError) beginProcPhase('download', 0);
  else beginProcPhase('prepare', phaseExpectedMs('prepare', 0));
  studioRunStart();
  // Seed the panel with the phase's starting value immediately, so it never
  // flashes a bare 0% for a model that is already on the device.
  refreshProcPercent();
  try {
    await waitForModel();
  } catch (e) {
    endProcPhase();
    studioError();
    // A metered pause is not a failure: the worker stopped on purpose, the
    // confirmation prompt is already up, and the user can resume it. Only a real
    // download error shows the recovery panel.
    if (!(e instanceof MeteredPauseError)) {
      error(e instanceof Error ? e.message : String(e), 'download');
    }
    return null;
  }
  // The session is built; the only remaining work is the inference itself, whose
  // duration we estimate from earlier runs on this device.
  beginProcPhase('inference', estimateInferenceMs(timings));
  refreshProcPercent();
  // Actual processing begins here (the model is ready and inference is about to
  // run) — not when the file picker opened.
  trackProcessingStarted();
  timings.length = 0;
  lastJobSettled = false;
  // Tiled inference runs one worker pass per tile; below the minimum long side
  // the model already sees the photo at ~1x, so tiling only adds cost.
  const longSide = currentImageData ? Math.max(currentImageData.width, currentImageData.height) : 0;
  const useTiling = tileGrid > 1 && longSide >= TILING_MIN_LONG_SIDE;
  if (tileGrid > 1 && !useTiling) {
    log(`Tiling skipped: ${longSide}px is below the ${TILING_MIN_LONG_SIDE}px minimum; running a single pass.`);
  }
  try {
    if (useTiling) {
      await runTiledInference(currentImageData!);
    } else {
      for (let i = 0; i < runs; i++) {
        await runOneInference();
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    endProcPhase();
    studioError();
    error(message, classifyError(message));
    return null;
  }
  // The inference resolves when the mask is back; the cut-out (and its edge
  // refinement, when enabled) is composited afterwards. Wait for the final
  // preview so an automated run reports the refined result, not the interim one.
  await waitForJobSettled();
  finishedRun();
  const result: RunDone = {
    timings: [...timings],
    avgMs: timings.reduce((a, b) => a + b, 0) / timings.length,
    provider: window.smokeProvider ?? announcedLog.join(','),
    modelId: window.smokeModelId ?? selectedModel?.id ?? 'unknown',
  };
  const maskImg = outputBox.querySelector('img');
  window.onSmokeDone?.(result, maskImg?.src ?? '');
  return result;
}

window.runSmoke = runSmoke;
window.smokeModelReady = false;
window.smokeModelId = '';
window.smokeModelPaused = false;
// A getter so the harness always reads the current run's stage timings.
Object.defineProperty(window, 'smokeRefineStages', { get: () => smokeRefineStages });
window.waitForJobSettled = waitForJobSettled;
window.deviceReport = diagnosticReportText;
window.diagnosticReport = diagnosticReport;

// ——— Progress state ———
// The stage line, the progress ring, and the processing panel all read from the
// same last-checkpoint state, so they never disagree about what is happening.

// The processing panel's percentage is a single monotonic estimate across the
// whole run: the download band maps its real percentage, and the phases with no
// measurable progress (session build, inference, composite) advance by elapsed
// time within their own band. `activeProcPhase` is the phase the running photo
// is in, or null when nothing is running. See processing-progress.ts.
let activeProcPhase: ProcPhase | null = null;
let activePhaseStartedAt = 0;
let activePhaseExpectedMs = 0;

function beginProcPhase(phase: ProcPhase, expectedMs: number): void {
  activeProcPhase = phase;
  activePhaseStartedAt = performance.now();
  activePhaseExpectedMs = expectedMs;
}

function endProcPhase(): void {
  activeProcPhase = null;
}

// The current phase's contribution to the bar, using the elapsed clock for the
// time-estimated phases so the value keeps climbing between progress messages.
function currentProcPercent(downloadPercent = 0): number | null {
  if (!activeProcPhase) return null;
  const fraction =
    activeProcPhase === 'download'
      ? 0
      : timeFraction(performance.now() - activePhaseStartedAt, activePhaseExpectedMs);
  return overallPercent(activeProcPhase, downloadPercent, fraction);
}

function refreshProcPercent(downloadPercent = 0): void {
  studioProgress(currentProcPercent(downloadPercent));
}

let lastLoadStage: LoadStage | null = null;
let lastProgress: {
  stage: LoadStage;
  percent: number;
  bytes?: number;
  totalBytes?: number;
  detail?: string;
} | null = null;
// The worker measures elapsed time from its own start; this offset maps that
// timeline onto the page's clock so the ticker below can keep counting.
let progressClockOffset = 0;

function resetProgressClock(): void {
  lastProgress = null;
  lastLoadStage = null;
  progressClockOffset = 0;
}

// ——— Progress rendering ———
// Renders a checkpoint to the stage line, updates the progress ring and the
// step list, and logs each new stage exactly once, so the log reads as an
// ordered timeline of the load rather than a stream of percentages.
function updateLoadProgress(msg: {
  stage: LoadStage;
  percent: number;
  bytes?: number;
  totalBytes?: number;
  elapsedMs: number;
  detail?: string;
}): void {
  if (!lastProgress) progressClockOffset = performance.now() - msg.elapsedMs;
  lastProgress = msg;
  // The single status line shows the detailed checkpoint (bytes + elapsed) and
  // animates while the load runs.
  setConsoleStatus(describeProgress(msg), true);

  const phase = phaseForStage(msg.stage);
  const pct = Math.max(0, Math.min(100, Math.round(msg.percent)));
  if (phase === 'download') {
    // Only the download has a real, measurable percentage; the panel maps it into
    // its band of the run.
    studioProgress(currentProcPercent(pct));
    procStageLabelEl.textContent = 'Downloading model';
  } else {
    // Everything else (runtime, session creation) is not a measurable
    // percentage, so the panel stays indeterminate rather than lying.
    // A cached model reports its download stage during the run; once it is past
    // that, move the panel from the download band into the prepare band.
    if (activeProcPhase === 'download') beginProcPhase('prepare', phaseExpectedMs('prepare', 0));
    studioProgress(currentProcPercent());
    procStageLabelEl.textContent = PHASE_LABELS[phase];
  }

  if (msg.stage !== lastLoadStage) {
    lastLoadStage = msg.stage;
    const extra = msg.detail ? ` (${msg.detail})` : '';
    log(`Load stage: ${msg.stage}${extra}`);
  }
}

// Re-render the last checkpoint on a timer. Progress messages only arrive when
// something changes, so a stalled download previously froze the whole line at
// "(0.0s)" — indistinguishable from a hang, and the reason a stuck model fetch
// looked like a dead page. With the clock running, a stall is visible: the byte
// count stops while the elapsed time keeps climbing.
setInterval(() => {
  if (!lastProgress || modelReady || modelError) return;
  setStage(
    describeProgress({ ...lastProgress, elapsedMs: performance.now() - progressClockOffset }),
  );
}, 500);

// Keep the processing panel's percentage climbing while a run is in progress.
// The unmeasurable phases have no event stream of their own, so without this
// tick the bar would freeze; it stops the moment the phase ends or the model
// reports an error.
setInterval(() => {
  if (activeProcPhase === null || modelError) return;
  const downloadPercent = lastProgress?.stage === 'downloading' ? lastProgress.percent : 0;
  refreshProcPercent(downloadPercent);
}, 250);

// ——— Boot ———
// Order: build the provider gate (cheap), load the manifest (source of truth
// for models), then start the worker + asset cache, resolve defaults, and
// auto-load the default model. The page needs no manual step for a first run.
// No model binary is committed; npm run fetch-models downloads them and writes
// the manifest.
setStage('Starting…');
log(`Build ${__BUILD_ID__}`);
log('Detecting GPU…');

// The landing page's before/after comparisons are pure DOM and independent of
// the model, so wire them immediately rather than waiting on boot().
initCompareSliders();
initShowcaseGallery();
initSupportCarousel();

async function loadSampleIntoStudio(url: string, filename: string): Promise<void> {
  setStudioTab('step', true);
  openStudio();
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const file = new File([blob], filename, { type: blob.type || 'image/jpeg' });
    await loadImageFromFile(file);
  } catch {
    showToast('Could not load sample image into Studio.', { kind: 'warn', title: 'Sample unavailable' });
  }
}

initLandingWorkspace((url, filename) => {
  void loadSampleIntoStudio(url, filename);
});

initCommandPalette({
  onAction: (action) => {
    switch (action.type) {
      case 'open-studio': {
        openStudio();
        if (action.tab) setStudioTab(action.tab, true);
        break;
      }
      case 'load-sample': {
        void loadSampleIntoStudio(action.url, action.filename);
        break;
      }
      case 'scroll-to': {
        if (studioEl.classList.contains('is-open')) closeStudio();
        const target = document.querySelector(action.selector);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
      case 'set-theme': {
        setThemePreference(action.mode);
        break;
      }
    }
  },
});

// The console and the engine sidebar both start hidden so the first photo gets
// the whole workspace; each stays one tap away in the studio top bar.
setSidebarCollapsed(true);
setConsoleVisible(false);

// ——— Privacy-first analytics ———
// Custom-event endpoint comes from VITE_ANALYTICS_ENDPOINT and the Cloudflare
// Web Analytics beacon token from VITE_CF_WEB_ANALYTICS_TOKEN, both at build
// time. When both are empty (the default) analytics is fully disabled and no UI
// is shown. Every measurement is consent-gated and fire-and-forget, so analytics
// can never delay image processing or downloads. The quality-report form reuses
// the SAME diagnostic structure as the Console's Copy report button
// (diagnosticReport), so there is one report shape and one builder.
let analyticsUi: AnalyticsUi | null = null;
{
  // The build-time endpoint is the real configuration. A same-origin, relative
  // `?analytics=/path` override exists only for automated runs and local testing
  // (e.g. `?analytics=/__analytics`); an absolute URL is ignored so this can
  // never point the browser at a third-party origin.
  const override = urlParams.get('analytics');
  const endpoint = override && override.startsWith('/')
    ? override
    : (import.meta.env.VITE_ANALYTICS_ENDPOINT ?? '').trim();
  const webAnalyticsToken = (import.meta.env.VITE_CF_WEB_ANALYTICS_TOKEN ?? '').trim();
  analyticsUi = initAnalyticsUi({
    endpoint,
    webAnalyticsToken,
    appVersion: __BUILD_ID__,
    diagnostics: diagnosticReport,
    onReportSubmitted: () => {
      // Confirmation is a plain toast; the report itself is already stored.
      showToast('Thanks — your report was sent.', { kind: 'success', title: 'Report sent' });
    },
  });
  if (analyticsUi.enabled) {
    analyticsUi.maybeShowConsent();
    // A session that already granted consent starts counting now.
    analyticsUi.client.sessionStarted();
  }
}

// ——— Analytics lifecycle helpers ———
// Thin wrappers so the pipeline code reads clearly and a missing/disabled
// analytics client is always a safe no-op.
function analyticsProvider(): 'webgpu' | 'wasm' {
  const p = window.smokeProvider || selectedProvider;
  return p === 'webgpu' ? 'webgpu' : 'wasm';
}
function trackProcessingStarted(): void {
  analyticsUi?.client.processingStarted();
}
function trackProcessingSucceeded(): void {
  analyticsUi?.client.processingSucceeded({
    model_id: selectedModel?.id,
    processing_provider: analyticsProvider(),
  });
}
function trackProcessingFailed(reason: FailureReason): void {
  analyticsUi?.client.processingFailed(reason);
}
function trackDownloadInitiated(): void {
  analyticsUi?.client.downloadInitiated({
    model_id: selectedModel?.id,
    processing_provider: analyticsProvider(),
  });
}

// Header: full lockup, full-height bar and the labelled Studio button at the top
// of the page. Scrolling down collapses it (shorter bar, the brand crossfades to
// the figure-only mark, the Studio button drops its label); scrolling back up
// expands it, and at the very top it is always full height. data-collapsed drives
// all three in CSS (src/style.css), so there is no per-scroll class churn.
const brandLink = document.getElementById('brandLink');
// A direction-aware header (the common "hide on scroll down, reveal on scroll
// up" pattern). Collapsing needs a small downward move so a jittery or
// sub-pixel scroll does not collapse on the first pixel; expanding is immediate
// so the full bar returns the moment the user scrolls back up. Near the top the
// header is always expanded, so the top of the page is never left collapsed —
// including after a viewport resize, which the old height-based check got stuck on.
const COLLAPSE_AFTER_PX = 8; // must scroll this far DOWN past the last top before collapsing
const TOP_REVEAL_PX = 4; // at or above this scrollY the header is always expanded
let lastScrollY = window.scrollY;
let headerCollapsed = false;
function updateHeaderCollapse(): void {
  if (!brandLink) return;
  const y = window.scrollY;
  const goingDown = y > lastScrollY + COLLAPSE_AFTER_PX;
  const goingUp = y < lastScrollY - 1;
  if (y <= TOP_REVEAL_PX) headerCollapsed = false;
  else if (goingDown) headerCollapsed = true;
  else if (goingUp) headerCollapsed = false;
  lastScrollY = y;
  brandLink.dataset.collapsed = headerCollapsed ? 'true' : 'false';
  siteHeaderEl.dataset.collapsed = headerCollapsed ? 'true' : 'false';
}
window.addEventListener('scroll', updateHeaderCollapse, { passive: true });
updateHeaderCollapse();

async function boot(): Promise<void> {
  // GPU gate first: it decides which provider is offered and the default. The
  // shared device probe lets an unverified mobile adapter stay off the default
  // (it remains selectable; see provider-gate.ts).
  gpuState = await detectWebGpu({ deviceClass: readDeviceMobile() ? 'mobile' : 'desktop' });
  log(gpuState.reason);
  // Probe whenever an adapter exists — even one the gate did not endorse — so the
  // GPU stays selectable in Advanced options (the user is warned, not blocked).
  if (gpuState.adapterPresent) {
    // Only request the WebGPU-capable ORT bundle when this host can actually
    // serve it (see webGpuRuntimeHosted). Probed before the worker starts so a
    // host without the jsep binary never 404s the worker's importScripts.
    runtimeHasWebGpuBundle = await webGpuRuntimeHosted();
    log(runtimeHasWebGpuBundle ? 'WebGPU runtime files are served by this host.' : 'This host does not serve the WebGPU runtime; CPU (WASM) will be used.');
  }

  try {
    const manifest = await fetchModelsManifest();
    models = manifest.models;
    log(`Model manifest: ${models.length} model(s) — ${models.map((m) => m.id).join(', ')}`);
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    showError('Model manifest could not be loaded. The model files are missing from this deployment; reload once they are available.');
    return;
  }

  // Mask adjustments: from localStorage, with ?maskThreshold= / ?maskFeather=
  // overriding for automated runs. The UI always offers them (defaults off).
  maskAdjust = initMaskAdjust();
  applyMaskUi();
  log(`Mask adjust: threshold ${maskAdjust.threshold || 'off'}, feather ${maskAdjust.feather || 'off'}`);

  // Resolve defaults: provider can come from ?provider=, then localStorage,
  // then the GPU gate (GPU only for a modern hardware adapter, else CPU). The
  // model is the single served artifact (model_512_int8_fp16.onnx), overridable
  // with ?model= for scripted runs.
  selectedProvider = resolveProvider();
  selectedModel = resolveModel();

  announceModel();
  applyProviderUi();
  log(`Provider default: ${selectedProvider}`);
  log(`Model default: ${selectedModel.id}`);

  await initWorker();
  log('Select a photo to download the model and remove its background.');

  // Decide whether to confirm before the (large) first download. Wi-Fi and
  // unknown/desktop connections load straight away; a cellular or data-saver
  // connection asks first, stating the model size — but only when the model is
  // not already on this device, and not once the user has said "remember".
  // Either way the auto-load is one step for the user — there is no manual
  // "Load model" click on a first visit.
  if (await needsDownloadConfirmation()) {
    showNetWarn();
    log('Waiting for confirmation before the model download (metered connection).');
  } else {
    autoLoadModel();
  }

  // Keep checking for an unmetered link: if this visit is waiting on a metered
  // connection (or the download failed), the model still downloads in the
  // background as soon as Wi-Fi is available.
  startModelFetchLoop();
  // React immediately to a mid-session switch: pause an in-flight download the
  // moment the link becomes metered (the periodic loop already handles the
  // reverse, Wi-Fi returning).
  watchConnectionChanges();
}

// The default model is downloaded once and then served from this device, so a
// confirmed download makes every later visit instant.
function autoLoadModel(): void {
  // A worker that failed to start already has its error on screen; loading a
  // model through it would only replace that error with a load that never
  // completes.
  if (workerFailed) return;
  loadSelectedModel();
}

// ——— Live connection guard ———
// The Network Information API fires "change" on every rtt/downlink update, so the
// last class is remembered and the pure decision (connectionChangeAction) only
// acts on a real crossing of the metered boundary.
let lastConnectionClass: ConnectionClass | null = null;

function watchConnectionChanges(): void {
  const conn = (
    navigator as Navigator & {
      connection?: { addEventListener?: (type: string, listener: () => void) => void };
    }
  ).connection;
  lastConnectionClass = currentConnectionClass();
  if (!conn || typeof conn.addEventListener !== 'function') return;
  conn.addEventListener('change', () => {
    const next = currentConnectionClass();
    const action = connectionChangeAction(lastConnectionClass ?? next, next, modelLoadInFlight);
    lastConnectionClass = next;
    if (action === 'pause') {
      // The download was running on Wi-Fi and the link just became metered: stop
      // it rather than spend the user's data plan unasked.
      pauseModelForMetered('Connection switched to mobile data; pausing the model download.');
    }
  });
}

// Besides the one-shot load at boot, the page checks on a timer whether the
// model still needs downloading, so a visit that started on a metered link (or
// whose download failed) warms the on-device cache as soon as an unmetered link
// is available — without waiting for the user to pick a photo. A tick is a no-op
// unless the connection is unmetered and the model is still absent, so a metered
// link, a cached model, or an in-flight download all leave it alone.
const MODEL_FETCH_INTERVAL_MS = 2000;
let modelFetchTimer: number | null = null;

function startModelFetchLoop(): void {
  if (modelFetchTimer !== null) return;
  modelFetchTimer = window.setInterval(() => void modelFetchTick(), MODEL_FETCH_INTERVAL_MS);
  void modelFetchTick();
}

function stopModelFetchLoop(): void {
  if (modelFetchTimer === null) return;
  clearInterval(modelFetchTimer);
  modelFetchTimer = null;
}

async function modelFetchTick(): Promise<void> {
  if (!selectedModel || workerFailed) return;
  const cached = modelReady || (await isUrlCached(selectedModel.url).catch(() => false));
  if (cached) {
    // The model is loaded or already on this device; the loop has nothing left to do.
    stopModelFetchLoop();
    return;
  }
  const connection = currentConnectionClass();
  if (
    !shouldAutoFetchModel({
      connection,
      cached,
      ready: modelReady,
      inFlight: modelLoadInFlight,
    })
  ) {
    return;
  }
  // An unmetered link is available and the model is still absent, so the earlier
  // "may be metered" prompt no longer applies. Resolve any run waiting on that
  // prompt as a confirmation before starting the download.
  settleDownloadPrompt(true);
  log(`Unmetered connection detected and the model is not on this device yet; downloading it now (${connection}).`);
  loadSelectedModel();
}

// The full gate: skip the prompt when consent is already given this session, the
// model is already cached on this device, or the connection does not look
// metered. Consent is per-session; it is never remembered across visits.
async function needsDownloadConfirmation(): Promise<boolean> {
  if (!selectedModel) return false;
  // An explicit ?model=/?provider= override is a deliberate, scripted choice,
  // and an automated (WebDriver) session must never block on a modal — CI's
  // Chromium reports a metered-looking connection, which would otherwise stall
  // the harness. The metered test opts out of the WebDriver flag itself.
  const confirmed =
    sessionStorage.getItem('remove-bg:download-confirmed') === '1' ||
    Boolean(forcedModel || forcedProvider || navigator.webdriver);
  // The model may already be on this device (Cache API), in which case there is
  // nothing to download and no reason to warn about data usage.
  const cached = await isUrlCached(selectedModel.url).catch(() => false);
  if (cached) log('Model already on this device; skipping the download confirmation.');
  return shouldConfirmDownload({
    sizeBytes: selectedModel.size,
    cached,
    confirmed,
  });
}

function showNetWarn(): void {
  if (!selectedModel) return;
  // The model labels already carry their size, so the confirmation states the
  // exact byte size without repeating the label.
  netWarnText.textContent = downloadConfirmationText(selectedModel.size);
  netWarnEl.hidden = false;
  netWarnConfirm.focus();
}

// The prompt shown after the connection switched to metered mid-download. The
// copy is different from the cold-visit one: it explains that the transfer was
// stopped, not that it never began.
function showMeteredPausePrompt(): void {
  if (!selectedModel) return;
  netWarnText.textContent = meteredSwitchNotice(selectedModel.size);
  netWarnEl.hidden = false;
  setStage('Paused — mobile data detected');
  netWarnConfirm.focus();
}

// A run that needs the model waits on this promise while the prompt is up, so
// the transfer starts only after the user answers. Wi-Fi arriving also resolves
// it as a confirmation (the background fetch loop can download for free).
let downloadPromptPromise: Promise<boolean> | null = null;
let downloadPromptResolve: ((confirmed: boolean) => void) | null = null;
// Set when the prompt is dismissed, so a bulk batch stops instead of asking
// again for every remaining photo.
let downloadConsentDeclined = false;

function requestDownloadConfirmation(): Promise<boolean> {
  if (!selectedModel) return Promise.resolve(true);
  if (sessionStorage.getItem('remove-bg:download-confirmed') === '1') {
    return Promise.resolve(true);
  }
  downloadConsentDeclined = false;
  if (!downloadPromptPromise) {
    showNetWarn();
    downloadPromptPromise = new Promise<boolean>((resolve) => {
      downloadPromptResolve = resolve;
    });
  }
  return downloadPromptPromise;
}

function settleDownloadPrompt(confirmed: boolean): void {
  netWarnEl.hidden = true;
  downloadConsentDeclined = !confirmed;
  downloadPromptResolve?.(confirmed);
  downloadPromptResolve = null;
  downloadPromptPromise = null;
}

/**
 * Makes the model available, asking first on a metered link. Resolves false when
 * the user declines the download, so a caller can abandon its run instead of
 * hanging on a model that will never arrive. `force` reloads the model even when
 * one is already ready (a provider change).
 */
async function ensureModelLoaded(force = false): Promise<boolean> {
  if (!force && (modelLoadInFlight || modelReady)) return true;
  if (modelLoadInFlight) return true;
  if (await needsDownloadConfirmation()) {
    const confirmed = await requestDownloadConfirmation();
    // The prompt's confirm button starts the download itself; this covers a
    // consent remembered from earlier in the session, when no prompt appears.
    if (confirmed && !modelLoadInFlight && !modelReady) autoLoadModel();
    return confirmed;
  }
  // No confirmation needed: any stale prompt is answered and the download starts.
  settleDownloadPrompt(true);
  if (force) loadSelectedModel();
  else autoLoadModel();
  return true;
}

function confirmDownload(): void {
  sessionStorage.setItem('remove-bg:download-confirmed', '1');
  log('Download confirmed by the user; starting the model download.');
  settleDownloadPrompt(true);
  autoLoadModel();
}

netWarnConfirm.addEventListener('click', confirmDownload);
netWarnDismiss.addEventListener('click', () => {
  settleDownloadPrompt(false);
  setStage('Paused — choose a photo to download the model and remove its background.');
  // A dismissal is not a dead end: choosing a photo asks again before spending
  // data, and Wi-Fi can still fetch the model in the background.
});

boot().catch((e) => error(e instanceof Error ? e.message : String(e)));