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
import { composeResult } from './features/background-removal/composite';
import { recoverForegroundMask } from './features/background-removal/mask-recovery';
import {
  rawMaskStats,
  formatRawMaskStats,
  isSuspectRawMask,
  emptyRawMaskStats,
  type RawMaskStats,
} from './features/diagnostics/raw-mask-stats';
import {
  buildDiagnosticReport,
  formatDiagnosticReport,
} from './features/diagnostics/diagnostic-report';
import { cropMaskFloat, alphaToBytes, lumaFromRgba } from './features/background-removal/mask-resize';
import { RefinementRunner } from './features/background-removal/refinement-client';
import {
  refinementConfigFromParams,
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
import {
  validateFileTypeAndSize,
  validateDimensions,
  DEFAULT_UPLOAD_LIMITS,
} from './features/background-removal/image-validation';
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
  type BackgroundChoice,
} from './features/background-removal/background-color';
import {
  initialStudioView,
  reduceStudio,
  scrubConsoleLine,
  STUDIO_TABS,
  tabEnabled,
  type StudioTab,
} from './features/background-removal/studio-view';
import { classifyLogLine } from './features/background-removal/console-log';
import {
  pickColorFromScreen,
  supportsScreenPicker,
} from './features/background-removal/screen-picker';
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
const procPctEl = document.getElementById('procPct')!;
const procStageLabelEl = document.getElementById('procStageLabel')!;
const tabButtons: Record<StudioTab, HTMLButtonElement> = {
  input: document.getElementById('tabInput')! as HTMLButtonElement,
  processing: document.getElementById('tabProcessing')! as HTMLButtonElement,
  result: document.getElementById('tabResult')! as HTMLButtonElement,
  compare: document.getElementById('tabCompare')! as HTMLButtonElement,
};
const tabPanels: Record<StudioTab, HTMLElement> = {
  input: document.getElementById('panelInput')!,
  processing: document.getElementById('panelProcessing')!,
  result: document.getElementById('panelResult')!,
  compare: document.getElementById('panelCompare')!,
};
const compareBeforeEl = document.getElementById('compareBefore')! as HTMLImageElement;
const compareAfterEl = document.getElementById('compareAfter')! as HTMLImageElement;
const inputPreviewEl = document.getElementById('inputPreview')!;
const inputPreviewImg = document.getElementById('inputPreviewImg')! as HTMLImageElement;
const panelInputEl = document.getElementById('panelInput')!;
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
const resultWorkspaceEl = document.getElementById('resultWorkspace');
let studioView = initialStudioView();

// Disclose the real limits in the UI (MVP §6) rather than hardcoding them in the
// markup, so a changed limit never leaves stale copy on the page.
limitBytesEl.textContent = `${Math.round(DEFAULT_UPLOAD_LIMITS.maxBytes / 1048576)} MB`;
limitSideEl.textContent = String(DEFAULT_UPLOAD_LIMITS.maxLongestSide);

// ——— Studio layer + editor tabs ———
// The studio opens as a full-page layer (its own top bar + workspace) launched
// from the header. The editor shows exactly one tab: input by default, the
// animated processing wallpaper while running, and the result when finished.
function renderStudioView(): void {
  for (const tab of STUDIO_TABS) {
    const selected = studioView.tab === tab;
    tabButtons[tab].setAttribute('aria-selected', String(selected));
    tabButtons[tab].disabled = !tabEnabled(studioView, tab) && !selected;
    tabPanels[tab].hidden = !selected;
  }
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
  // The settings sidebar only exists in the Result tab, so its top-bar show/hide
  // button appears exactly when that tab is selected.
  if (sidebarToggleBtn) sidebarToggleBtn.hidden = studioView.tab !== 'result';
}

function setStudioTab(tab: StudioTab, force = false): void {
  if (!force && !tabEnabled(studioView, tab)) return;
  studioView = { ...studioView, tab };
  renderStudioView();
}

// The re-process button's visibility depends on the studio's running/result
// state, so it is refreshed alongside every view transition (the helper itself
// is declared below, with the mask controls it also depends on).
function applyStudioView(): void {
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
      if (sibling !== node) (sibling as HTMLElement).inert = on;
    }
    node = node.parentElement;
  }
}

function openStudio(): void {
  closeMenu();
  studioEl.classList.add('is-open');
  studioEl.setAttribute('aria-hidden', 'false');
  document.body.classList.add('studio-open');
  setBackgroundInert(true);
  studioEl.scrollTop = 0;
  renderStudioView();
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
// default is the 35% track in CSS. `null` means "use that default"; a number is
// an explicit, clamped pixel height.
const CONSOLE_MAX_FRACTION = 0.5;
const CONSOLE_MIN_FRACTION = 0.2;
const CONSOLE_MIN_PX = 96;
let consoleHeightPx: number | null = null;

function setConsoleVisible(visible: boolean): void {
  studioGridEl.dataset.console = visible ? 'shown' : 'hidden';
  consoleToggleBtn.setAttribute('aria-pressed', String(visible));
  consoleToggleBtn.setAttribute('aria-label', visible ? 'Hide console' : 'Show console');
  if (visible) applyConsoleHeight(consoleHeightPx);
}

// Pins the console to an explicit pixel height (or back to the default) so a
// drag can shrink it. The value is always clamped to the 35% cap.
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
// Top-left, fixed, stacked vertically. Each dismisses itself after 10 s and has a
// close button; several at once stack downward in the order they arrived.
type ToastKind = 'info' | 'warn' | 'error';
const TOAST_DEFAULT_MS = 10000;

function showToast(
  message: string,
  opts: { kind?: ToastKind; title?: string; durationMs?: number } = {},
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
  outputBox.innerHTML = '';
  downloadImageBtn.hidden = true;
  downloadImageBtn.removeAttribute('href');
  lastResultCanvas = null;
  lastPreviewCanvas = null;
  compareBeforeEl.removeAttribute('src');
  compareAfterEl.removeAttribute('src');
  outputSection.hidden = true;
}

// ——— Export format ———
// The composited cut-out is kept so changing the format (or the background)
// re-encodes without re-running inference.
let lastResultCanvas: HTMLCanvasElement | null = null;
// The on-screen preview, at most ≤450 px on its longest side, so switching the
// background or format never re-encodes a full-resolution PNG just to repaint
// the display. Rebuilt whenever a new result is composited.
let lastPreviewCanvas: HTMLCanvasElement | null = null;
let exportFormat: ExportFormat = initExportFormat();

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
      setExportFormat(format.id);
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode(format.label));
    const hint = document.createElement('span');
    hint.className = 'formatHint';
    hint.textContent = `— ${available ? format.description : 'not supported by this browser'}`;
    label.appendChild(hint);
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

// Repoint the single download link at the current format, re-encoding the stored
// result when one exists.
function applyFormatUi(): void {
  const info = exportFormatInfo(exportFormat);
  downloadImageBtn.textContent = `Download ${info.label} (${info.description})`;
  if (lastResultCanvas) {
    const { width, height } = lastResultCanvas;
    const href = canvasToDataUrl(lastResultCanvas, exportFormat, background);
    downloadImageBtn.href = href;
    downloadImageBtn.download = `background-removed-${width}x${height}.${info.extension}`;
    downloadImageBtn.hidden = false;
  }
  renderFormatOptions();
}

renderFormatOptions();

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
  outputBox.innerHTML = '';
  const img = document.createElement('img');
  img.src = canvasToDataUrl(display, 'png', background);
  img.alt = 'Background removed';
  outputBox.appendChild(img);
  // The compare view's right-hand side shows the same composite.
  compareAfterEl.src = img.src;
}

function updateBackgroundUi(): void {
  const color = background.kind === 'color';
  bgTransparentBtn.setAttribute('aria-pressed', String(isTransparent(background)));
  bgCurrentEl.textContent = describeChoice(background);
  if (color) {
    bgColorPicker.value = background.hex;
    bgColorSwatch.style.background = background.hex;
    bgAlphaInput.value = String(background.alpha);
    bgAlphaValue.textContent = `${background.alpha}%`;
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
bgColorPicker.addEventListener('input', () =>
  setBackground({ kind: 'color', hex: bgColorPicker.value, alpha: Number(bgAlphaInput.value) }),
);
bgAlphaInput.addEventListener('input', () => {
  // The alpha slider only refines the current colour (it has no meaning for a
  // fully transparent background).
  const hex = background.kind === 'color' ? background.hex : bgColorPicker.value;
  setBackground({ kind: 'color', hex, alpha: Number(bgAlphaInput.value) });
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
  setBackground({ kind: 'color', hex: picked, alpha: Number(bgAlphaInput.value) });
});

updateBackgroundUi();

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
  if (kind === 'upload') {
    // A rejected file is a normal input mistake, not a broken app: explain it on
    // the stage line and let the user pick another photo. No recovery panel.
    hideRecovery();
    return;
  }
  showRecovery(kind, described);
}

// ——— Error recovery ———
// Every failure surfaces the concrete next step instead of a dead end. `kind`
// picks the guidance; the panel always offers a reliable escape (reload).
type ErrorKind = 'upload' | 'download' | 'memory' | 'worker' | 'generic';

function retryModelOrRun(): void {
  hideRecovery();
  if (!modelReady) loadSelectedModel();
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
        'the model is kept on this device once it succeeds, so you only download it once.';
      primaryLabel = 'Retry download';
      primaryRun = () => {
        hideRecovery();
        loadSelectedModel();
      };
      break;
    case 'memory':
      text =
        'This device ran out of memory. Close other tabs or apps to free memory, then ' +
        'try again. A smaller photo also needs less memory.';
      primaryLabel = 'Try again';
      primaryRun = () => {
        hideRecovery();
        if (!modelReady) loadSelectedModel();
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
  panelInputEl.classList.add('has-preview');
}

async function loadImageFromFile(file: File): Promise<void> {
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
  const dimCheck = validateDimensions(img.naturalWidth, img.naturalHeight);
  if (!dimCheck.ok) {
    URL.revokeObjectURL(url);
    error(dimCheck.reason, 'upload');
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  currentImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  currentImage = img;
  // Keep the URL alive while the preview is on screen; release the previous one.
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = url;
  showInputImage(img);
  // A new photo invalidates the previous job: bump the job id and cancel any
  // refinement still running for the old one, so its late result cannot paint
  // over this new job's preview.
  invalidateActiveJob();
  // A new photo invalidates the previous result and any error panel.
  clearOutput();
  studioSelectImage();
  hideRecovery();
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

// The primary action is the upload itself: choosing a photo starts the run
// automatically, so there is no second button to press. A fatal model error is
// the one case where a photo must not silently start a run — the recovery panel
// offers the retry.
function autoStartIfReady(): void {
  if (currentImage && modelError === null) void runSmoke();
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
    handleResultReady(msg);
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
  const { mask: recoveredMask, recovered } = recoverForegroundMask(image, upscaled);
  if (recovered) {
    log('Model kept the whole frame; recovered the subject from the background edges.');
  }
  maskRecoveryTriggered = recovered;
  // Apply the user's mask threshold/feather at full destination resolution (the
  // values are percentages/pixels of the *output* mask).
  const stage1Mask = applyMaskAdjust(recoveredMask, image.width, image.height, maskAdjust);
  const size = `${image.width}x${image.height}`;

  // Keep the cropped float mask + the recovered 8-bit mask: the float mask is
  // the input to refinement (Stages 2-4), the 8-bit mask is the fallback when
  // refinement is disabled or fails.
  const croppedFloat = cropMaskFloat(msg.mask, inputSize, rect);
  const guide = lumaFromRgba(image.data);

  const refineEnabled = refineConfig.enabled;
  composeResult(image, stage1Mask)
    .then(({ canvas, preview }) => {
      if (jobId !== activeJobId) return;
      // Time to the first composited preview (mask reconstruction + composite);
      // refinement time, when enabled, is added by refineAndFinalize.
      postprocessingMs = performance.now() - postprocessStart;
      // Paint the Stage-1 preview immediately (finishResult shows the Result tab
      // and enables export). With refinement enabled this is the interim beat;
      // disabled, it is the settled result.
      finishResult(canvas, preview, size, refineEnabled ? 'preview' : 'final');
      if (!refineEnabled) return;
      return refineAndFinalize(jobId, image, croppedFloat, rect, guide, size, postprocessStart);
    })
    .catch((err) => {
      if (jobId !== activeJobId) return;
      endProcPhase();
      markJobSettled();
      error(`Could not compose the cut-out: ${err instanceof Error ? err.message : String(err)}`);
    });
}

// Stages 2-4: refine the soft mask and, on success, swap in the sharper result
// atomically. Any failure or cancellation keeps the initial preview.
async function refineAndFinalize(
  jobId: number,
  image: ImageData,
  croppedFloat: Float32Array,
  rect: { width: number; height: number },
  guide: Float32Array,
  size: string,
  postprocessStart: number,
): Promise<void> {
  setConsoleStatus('Refining edges…', true);
  const t0 = performance.now();
  try {
    const outcome = await refinementRunner.refine({
      jobId,
      guide,
      mask: croppedFloat,
      maskWidth: rect.width,
      maskHeight: rect.height,
      width: image.width,
      height: image.height,
      config: refineConfig,
    });
    if (jobId !== activeJobId) return; // superseded: drop silently
    if ('cancelled' in outcome) return; // a newer job owns the UI now
    // The refinement returns a soft float alpha; apply the user's
    // threshold/feather, then composite. The flood-fill recovery guard was
    // already applied to the Stage-1 mask and the refined alpha is derived from
    // the same soft mask, so it is not re-run here.
    const refinedMask = applyMaskAdjust(alphaToBytes(outcome.alpha), image.width, image.height, maskAdjust);
    const { canvas, preview } = await composeResult(image, refinedMask);
    if (jobId !== activeJobId) return;
    refinementSucceeded = true;
    // Full post-processing time: mask reconstruction + Stage-1 composite + refine.
    postprocessingMs = performance.now() - postprocessStart;
    finishResult(canvas, preview, size, 'final');
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
): void {
  lastResultCanvas = canvas;
  lastPreviewCanvas = preview;

  let opaquePx = 0;
  const ctx = canvas.getContext('2d')!;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] > 127) opaquePx++;

  // The compare view pairs the original photo with the current composite.
  compareBeforeEl.src = currentObjectUrl ?? '';
  // Preview + compare "after" are painted from the stored cut-out onto the chosen
  // background; the download link follows the chosen format.
  renderResultPreview();
  applyFormatUi();

  outputSection.hidden = false;
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

  const pct = ((opaquePx / (canvas.width * canvas.height)) * 100).toFixed(1);
  log(`Rendered cut-out (${size}) as ${exportFormatInfo(exportFormat).label} on a ${describeChoice(background)} background, ${pct}% opaque.`);
  // A uniform mask means the model did not segment anything; say so rather than
  // leaving the user staring at a blank (fully transparent) image.
  if (opaquePx === 0) {
    log('WARNING: the mask is fully transparent, so there is no subject to show.');
  } else if (opaquePx >= canvas.width * canvas.height * 0.995) {
    // Essentially nothing was removed even after the flood-fill recovery — the
    // image has no background separable from its edges (a busy scene, or a
    // full-frame subject). Tell the user rather than showing the original
    // silently.
    log('WARNING: no background was found, so nothing was removed.');
  }
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
  loadSelectedModel();
});

// ——— Mask adjust controls ———
// The engine settings a result was produced with. The re-process button appears
// whenever the current settings differ, so it is clear the on-screen cut-out is
// stale. `null` means "no result rendered yet".
let resultSettingsKey: string | null = null;
const reprocessBtn = document.getElementById('reprocessBtn') as HTMLButtonElement | null;

function engineSettingsKey(): string {
  return `${selectedProvider}|${maskAdjust.threshold}|${maskAdjust.feather}`;
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

// ——— Result tab: engine settings sidebar ———
// The advanced engine controls live in a sidebar in the result workspace. It
// collapses via the chevron in its header (or the top-bar show/hide button) and
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
  settingsSidebarEl.dataset.collapsed = collapsed ? 'true' : 'false';
  sidebarCollapseBtn?.setAttribute('aria-pressed', String(!collapsed));
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

// The top-bar button shows/hides the sidebar; the in-sidebar chevron collapses
// it. Both drive the same state, so they stay in sync.
sidebarToggleBtn?.addEventListener('click', () => {
  const collapsed = settingsSidebarEl?.dataset.collapsed === 'true';
  setSidebarCollapsed(!collapsed);
});
sidebarCollapseBtn?.addEventListener('click', () => {
  const collapsed = settingsSidebarEl?.dataset.collapsed === 'true';
  setSidebarCollapsed(!collapsed);
});

// Re-run inference with the current engine settings, then jump to the Processing
// tab so the user sees the run they asked for.
reprocessBtn?.addEventListener('click', () => {
  if (!currentImageData) return;
  setStudioTab('processing', true);
  void runSmoke();
});

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
  // pending promise settles when this run finishes.
  setConsoleStatus('Removing background…', true);
  postRunMessage(msg.runId, currentImageData);
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
  // A model download that was paused at the metered-connection prompt resumes
  // here: running is an explicit request to use the model.
  if (!modelReady && !modelError) {
    sessionStorage.setItem('remove-bg:download-confirmed', '1');
    netWarnEl.hidden = true;
    if (!modelLoadInFlight) loadSelectedModel();
  }
  hideRecovery();
  clearOutput();
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
  timings.length = 0;
  lastJobSettled = false;
  for (let i = 0; i < runs; i++) {
    try {
      await runOneInference();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      endProcPhase();
      studioError();
      error(message, classifyError(message));
      return null;
    }
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
  // GPU gate first: it decides which provider is offered and the default.
  gpuState = await detectWebGpu();
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
  // "may be metered" prompt no longer applies.
  netWarnEl.hidden = true;
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

function confirmDownload(): void {
  sessionStorage.setItem('remove-bg:download-confirmed', '1');
  netWarnEl.hidden = true;
  log('Download confirmed by the user; starting the model download.');
  autoLoadModel();
}

netWarnConfirm.addEventListener('click', confirmDownload);
netWarnDismiss.addEventListener('click', () => {
  netWarnEl.hidden = true;
  setStage('Paused — choose a photo to download the model and remove its background.');
  // A dismissal is not a dead end: choosing a photo starts the download and the
  // run automatically.
});

boot().catch((e) => error(e instanceof Error ? e.message : String(e)));