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
  applyMaskToImage,
  applyMaskAdjust,
  DEFAULT_MASK_ADJUST,
  isMaskAdjust,
  type MaskAdjust,
} from './features/background-removal/mask-postprocess';
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
  shouldConfirmDownload,
  downloadConfirmationText,
  shouldAutoFetchModel,
  currentConnectionClass,
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
import {
  initialStudioView,
  reduceStudio,
  scrubConsoleLine,
  STUDIO_TABS,
  tabEnabled,
  type StudioTab,
} from './features/background-removal/studio-view';
import type {
  LoadStage,
  ModelManifestEntry,
  WorkerProgressMessage,
} from './features/background-removal/types';

// Replaced at build/serve time by the build-stamp plugin in vite.config.ts.
declare const __BUILD_ID__: string;

const stageEl = document.getElementById('stage')!;
const logEl = document.getElementById('log')! as HTMLPreElement;
const outputBox = document.getElementById('outputBox')!;
const outputSection = document.getElementById('outputSection')!;
const modelNameEl = document.getElementById('modelName')!;
const modelSizeEl = document.getElementById('modelSize')!;
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
const modelProgressEl = document.getElementById('modelProgress')!;
const modelProgressValue = modelProgressEl.querySelector('.ringValue') as SVGCircleElement;
const processingLabel = document.getElementById('processingLabel')!;
const stepListEl = document.getElementById('stepList')!;
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
};
const tabPanels: Record<StudioTab, HTMLElement> = {
  input: document.getElementById('panelInput')!,
  processing: document.getElementById('panelProcessing')!,
  result: document.getElementById('panelResult')!,
};
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
}

function setStudioTab(tab: StudioTab): void {
  if (!tabEnabled(studioView, tab)) return;
  studioView = { ...studioView, tab };
  renderStudioView();
}

function studioSelectImage(): void {
  studioView = reduceStudio(studioView, { type: 'select-image' });
  renderStudioView();
}

function studioRunStart(): void {
  studioView = reduceStudio(studioView, { type: 'run-start' });
  renderStudioView();
}

function studioProgress(percent: number | null): void {
  studioView = reduceStudio(studioView, { type: 'progress', percent });
  renderStudioView();
}

function studioResult(): void {
  studioView = reduceStudio(studioView, { type: 'result' });
  renderStudioView();
}

function studioError(): void {
  studioView = reduceStudio(studioView, { type: 'error' });
  renderStudioView();
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
  studioEl.classList.add('is-open');
  studioEl.setAttribute('aria-hidden', 'false');
  document.body.classList.add('studio-open');
  setBackgroundInert(true);
  studioEl.scrollTop = 0;
  renderStudioView();
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
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && studioEl.classList.contains('is-open')) closeStudio();
});
renderStudioView();

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
  lastResultPngDataUrl = null;
  outputSection.hidden = true;
}

// ——— Export format ———
// The composited cut-out is kept so changing the format re-encodes without
// re-running inference; the PNG data URL is cached because it doubles as the
// on-page preview, so it is never encoded twice.
let lastResultCanvas: HTMLCanvasElement | null = null;
let lastResultPngDataUrl: string | null = null;
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
    const href =
      exportFormat === 'png'
        ? (lastResultPngDataUrl ?? canvasToDataUrl(lastResultCanvas, 'png'))
        : canvasToDataUrl(lastResultCanvas, exportFormat);
    downloadImageBtn.href = href;
    downloadImageBtn.download = `background-removed-${width}x${height}.${info.extension}`;
    downloadImageBtn.hidden = false;
  }
  renderFormatOptions();
}

renderFormatOptions();

function log(msg: string): void {
  // The log is rendered in the user-facing Console, so scrub internal commands
  // and private URLs before they reach the DOM (see studio-view.ts).
  logEl.textContent += scrubConsoleLine(msg) + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function setStage(s: string): void {
  stageEl.textContent = s;
}

function showError(msg: string): void {
  log(`ERROR: ${msg}`);
  setStage(`Error: ${msg}`);
}

function error(msg: string, kind: ErrorKind = 'generic'): void {
  const described = describeError(msg);
  showError(described);
  setProcessingLabel('Could not finish', false);
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
        'failing, open Technical details in the Console for the exact error.';
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

// ——— Model progress ring ———
// A small animated circle beside the model name. Determinate while the download
// reports a real percentage; indeterminate for the unmeasurable phases (runtime
// setup, session creation).
function showRing(percent: number | null): void {
  modelProgressEl.hidden = false;
  const determinate = typeof percent === 'number' && Number.isFinite(percent);
  modelProgressEl.classList.toggle('indeterminate', !determinate);
  if (determinate) {
    const clamped = Math.max(0, Math.min(100, percent));
    const circumference = 94.25; // 2 * pi * r, r = 15
    modelProgressValue.style.strokeDashoffset = String(circumference * (1 - clamped / 100));
  } else {
    modelProgressValue.style.strokeDashoffset = '';
  }
}

function hideRing(): void {
  modelProgressEl.hidden = true;
  modelProgressEl.classList.remove('indeterminate');
  modelProgressValue.style.strokeDashoffset = '';
}

// ——— Processing panel ———
// The "Technical details" summary is the live status label for the current
// process. Expanding it lists the steps in the order they ran — downloading,
// preparing, removing the background, creating the image — plus the model
// identity and the raw log, so the phases are distinguishable at a glance.
type StepId = 'download' | 'prepare' | 'inference' | 'export';
type StepState = 'todo' | 'active' | 'done';
interface Step {
  id: StepId;
  label: string;
  state: StepState;
  detail: string;
}
let steps: Step[] = [];

function stepLabel(id: StepId): string {
  switch (id) {
    case 'download':
      return 'Download model';
    case 'prepare':
      return 'Prepare model';
    case 'inference':
      return 'Remove background';
    case 'export':
      return 'Create image';
  }
}

function ensureStep(id: StepId): Step {
  let step = steps.find((s) => s.id === id);
  if (!step) {
    step = { id, label: stepLabel(id), state: 'todo', detail: '' };
    steps.push(step);
  }
  return step;
}

function setStep(id: StepId, state: StepState, detail = ''): void {
  const step = ensureStep(id);
  step.state = state;
  if (detail) step.detail = detail;
  renderSteps();
}

function renderSteps(): void {
  stepListEl.innerHTML = '';
  for (const step of steps) {
    const li = document.createElement('li');
    li.dataset.state = step.state;
    const dot = document.createElement('span');
    dot.className = 'dot';
    li.appendChild(dot);
    const name = document.createElement('span');
    name.textContent = step.label;
    li.appendChild(name);
    if (step.detail) {
      const detail = document.createElement('span');
      detail.className = 'stepDetail';
      detail.textContent = `— ${step.detail}`;
      li.appendChild(detail);
    }
    stepListEl.appendChild(li);
  }
}

function resetSteps(): void {
  steps = [];
  ensureStep('download');
  ensureStep('prepare');
  renderSteps();
}

// Sets the live status label on the technical-details summary. The summary is
// always visible, so there is nothing to show/hide.
function setProcessingLabel(label: string, working: boolean): void {
  processingLabel.textContent = label;
  processingLabel.classList.toggle('working', working);
}

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

function showInputImage(_img: HTMLImageElement): void {
  // The editor does not display the selected image: the input tab keeps the drop
  // zone, and the processing tab shows an animated wallpaper instead. Kept as a
  // no-op hook so the load flow reads the same and the decoded image stays
  // available for inference (see loadImageFromFile).
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
  // A new photo invalidates the previous result and any error panel, but must
  // not wipe the step list while the model is still loading: keep the download
  // step active so the panel keeps showing the load in progress.
  clearOutput();
  studioSelectImage();
  hideRecovery();
  if (!modelLoadInFlight) {
    resetSteps();
    setStep('download', modelReady ? 'done' : 'todo');
    setStep('prepare', modelReady ? 'done' : 'todo');
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
  const runtimeQuery = webGpuSelectable() ? '?runtime=webgpu' : '';
  worker = new Worker('/inference-worker.js' + runtimeQuery, { type: 'classic' });
  // Without these a worker that fails to start (404 on the script, a failed
  // importScripts of the ORT runtime) posts nothing at all and the page waits on
  // its initial "Starting…" text forever.
  worker.onerror = (e) => {
    workerFailed = true;
    error(`Inference worker failed to start: ${e.message || 'unknown worker error'}`, 'worker');
    settleModel('worker failed to start');
  };
  worker.onmessageerror = () => {
    error('Inference worker sent a message that could not be deserialized', 'worker');
  };
  worker.onmessage = (e: MessageEvent<WorkerProgressMessage>) => {
    const msg = e.data;
    workerResponded = true;
    if (msg.kind === 'loading-progress') {
      updateLoadProgress(msg);
    } else if (msg.kind === 'load-time') {
      const loadedModelId = msg.modelId ?? selectedModel?.id ?? 'unknown';
      setStage(`Model ready — provider ${msg.provider}`);
      loadTimeMs = msg.ms;
      log(`Model: ${loadedModelId}`);
      log(`Model load time: ${loadTimeMs.toFixed(1)} ms`);
      log(`Execution provider: ${msg.provider}`);
      if (msg.adapter) log(`GPU adapter: ${msg.adapter}`);
      window.smokeProvider = msg.provider;
      window.smokeModelId = loadedModelId;
      announcedLog.push(msg.provider);
      // Model loading is done: settle the download/prepare steps and the ring.
      setStep('download', 'done', 'on this device');
      setStep('prepare', 'done', `running on ${msg.provider}`);
      hideRing();
      hideRecovery();
      setProcessingLabel(
        currentImageData ? 'Removing the background…' : 'Model ready — choose a photo',
        false,
      );
      setSelectorsDisabled(false);
      settleModel(null);
    } else if (msg.kind === 'adapter-warning') {
      log(`WARNING: ${msg.message}`);
    } else if (msg.kind === 'provider-fallback') {
      log(
        `Provider fallback: ${msg.from} → ${msg.to} (${msg.reason})\n` +
          'WARNING: the GPU could not run this model. Inference is now running on the CPU, ' +
          'which can take several minutes per image.',
      );
      setStage(`Running on CPU (${msg.to}) — this is slow, please wait…`);
      window.smokeProvider = msg.to;
      announcedLog.push(msg.to);
    } else if (msg.kind === 'inference-time') {
      const pending = pendingRuns.get(msg.runId);
      pendingRuns.delete(msg.runId);
      if (!pending) return;
      timings.push(msg.ms);
      log(`Inference ${timings.length}: ${msg.ms.toFixed(1)} ms`);
      pending.resolve(msg.ms);
    } else if (msg.kind === 'result-ready') {
      if (!currentImageData) {
        log('WARNING: got a result with no loaded image; ignoring');
        return;
      }
      const { mask, width, height } = msg;
      setStep('inference', 'done');
      setStep('export', 'active');
      setProcessingLabel('Creating your image…', true);
      // The worker reports the model's actual input size so a per-model input
      // change (e.g. a 384 variant) never mis-scales the mask. The mask covers
      // the letterboxed content rect inside that square (the same geometry the
      // pre-processing used), so crop the padding away before upscaling.
      const inputSize = msg.inputSize ?? MODEL_SIZE;
      const rect = letterboxRect(currentImageData.width, currentImageData.height, inputSize);
      const maskU8 = cropLetterboxMask(probabilityToMask(mask), inputSize, rect);
      const upscaled = upscaleMask(maskU8, rect.width, rect.height, currentImageData.width, currentImageData.height);
      // Apply the user's mask threshold/feather at full destination resolution
      // (the values are percentages/pixels of the *output* mask).
      const adjusted = applyMaskAdjust(
        upscaled,
        currentImageData.width,
        currentImageData.height,
        maskAdjust,
      );
      const out = applyMaskToImage(currentImageData, adjusted);
      const canvas = document.createElement('canvas');
      canvas.width = out.width;
      canvas.height = out.height;
      const ctx = canvas.getContext('2d')!;
      ctx.putImageData(out, 0, 0);
      lastResultCanvas = canvas;
      // The PNG is both the on-page preview and the default download, so encode
      // it once and let applyFormatUi reuse it.
      lastResultPngDataUrl = canvasToDataUrl(canvas, 'png');

      let opaquePx = 0;
      for (let i = 3; i < out.data.length; i += 4) if (out.data[i] > 127) opaquePx++;

      outputBox.innerHTML = '';
      const img = document.createElement('img');
      // The preview is always the transparent PNG so the checkerboard shows the
      // real cut-out; the download link follows the chosen format.
      img.src = lastResultPngDataUrl;
      img.alt = 'Background removed';
      outputBox.appendChild(img);

      // One download link, re-encoded whenever the format radio changes.
      applyFormatUi();

      outputSection.hidden = false;

      setStep('export', 'done');
      setProcessingLabel('Done — your image is ready', false);
      studioResult();
      setStage('Done — download your image below.');

      log(`Rendered cut-out (${width}x${height}) as ${exportFormatInfo(exportFormat).label}, ${((opaquePx / (out.width * out.height)) * 100).toFixed(1)}% opaque.`);
      // A uniform mask means the model did not segment anything; say so rather
      // than leaving the user staring at a blank (fully transparent) image.
      if (opaquePx === 0) log('WARNING: the mask is fully transparent, so there is no subject to show.');
    } else if (msg.kind === 'error') {
      // Errors tied to a run are delivered through that run's promise, so the
      // caller reports them once. Anything else is surfaced here.
      if (msg.runId !== undefined) failPendingRuns(new Error(msg.message));
      else error(msg.message, msg.fatal ? classifyError(msg.message) : 'generic');
      studioError();
      if (msg.fatal) {
        settleModel(msg.message);
        setSelectorsDisabled(false);
        hideRing();
      }
      // A run-level failure (e.g. an allocation error) does not kill the
      // session; the worker retries on CPU, so the app stays usable.
    }
  };
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
  window.smokeModelId = selectedModel.id;
  window.smokeProvider = selectedProvider;
  workerResponded = false;
  resetProgressClock();
  // Model (re)load: reset the step list to download → prepare and show the
  // animated ring next to the model name while the worker reports progress.
  hideRecovery();
  resetSteps();
  setStep('download', 'active');
  setProcessingLabel(`Downloading ${selectedModel.label}…`, true);
  showRing(null);
  setStage(`Loading model ${selectedModel.id}…`);
  log(`Loading model: ${selectedModel.id} (${selectedModel.url})`);
  const force = providerForce(selectedProvider);
  if (forcedProvider) log(`Provider forced to: ${forcedProvider} (from ?provider=)`);
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
    setStage('No response from the background-removal engine');
    log(
      `WARNING: the inference worker has not responded in ${WORKER_START_TIMEOUT_MS / 1000}s. ` +
        'Its script or the ONNX Runtime files may have failed to load; check the browser console.',
    );
    hideRing();
    setProcessingLabel('Could not start', false);
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

function renderModelName(): void {
  if (!selectedModel) return;
  modelNameEl.textContent = selectedModel.label;
  modelSizeEl.textContent = `${(selectedModel.size / 1048576).toFixed(0)} MB download, cached after the first visit`;
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
  loadSelectedModel();
});

// ——— Mask adjust controls ———
function setMaskAdjust(adjust: MaskAdjust): void {
  maskAdjust = adjust;
  saveMaskAdjust();
  applyMaskUi();
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

// Compact advanced options popover menu toggled via gear on top-left of image
const settingsGearBtn = document.getElementById('settingsGearBtn');
const advancedMenu = document.getElementById('advancedMenu');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');

if (settingsGearBtn && advancedMenu) {
  settingsGearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = advancedMenu.hasAttribute('hidden');
    if (isHidden) {
      advancedMenu.removeAttribute('hidden');
    } else {
      advancedMenu.setAttribute('hidden', '');
    }
  });

  closeSettingsBtn?.addEventListener('click', () => {
    advancedMenu.setAttribute('hidden', '');
  });

  document.addEventListener('click', (e) => {
    if (!advancedMenu.hasAttribute('hidden') && !advancedMenu.contains(e.target as Node) && e.target !== settingsGearBtn) {
      advancedMenu.setAttribute('hidden', '');
    }
  });
}

type PendingRun = { resolve: (ms: number) => void; reject: (err: Error) => void };
const pendingRuns = new Map<number, PendingRun>();
let nextRunId = 1;

function failPendingRuns(err: Error): void {
  for (const [id, p] of pendingRuns) {
    pendingRuns.delete(id);
    p.reject(err);
  }
}

// Runs one inference and resolves with its duration. Rejects if the worker
// reports an error, so callers never wait forever on a failed run.
function runOneInference(): Promise<number> {
  if (!currentImageData || !worker) return Promise.reject(new Error('No image loaded'));
  const imageData = currentImageData;
  setStep('inference', 'active');
  setProcessingLabel('Removing background…', true);
  if (window.smokeProvider === 'webgpu' && timings.length === 0) {
    log('First GPU run compiles shaders; this can take a minute or two.');
  }
  const tensor = imageDataToTensor(imageData);
  const runId = nextRunId++;
  return new Promise<number>((resolve, reject) => {
    pendingRuns.set(runId, { resolve, reject });
    // Transfer the tensor buffer instead of structured-cloning it (12.6 MB/run).
    worker!.postMessage(
      { kind: 'run', runId, tensor, width: imageData.width, height: imageData.height },
      [tensor.buffer],
    );
  });
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
    crossOriginIsolated: boolean;
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
  studioRunStart();
  try {
    await waitForModel();
  } catch (e) {
    studioError();
    error(e instanceof Error ? e.message : String(e), 'download');
    return null;
  }
  timings.length = 0;
  for (let i = 0; i < runs; i++) {
    try {
      await runOneInference();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      studioError();
      error(message, classifyError(message));
      return null;
    }
  }
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

// ——— Progress state ———
// The stage line, the progress ring, and the processing panel all read from the
// same last-checkpoint state, so they never disagree about what is happening.
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
  setStage(describeProgress(msg));

  const phase = phaseForStage(msg.stage);
  const pct = Math.max(0, Math.min(100, Math.round(msg.percent)));
  if (phase === 'download') {
    // Only the download has a real, measurable percentage; the ring shows it.
    showRing(msg.stage === 'cache-check' ? null : pct);
    setStep('download', 'active', msg.stage === 'downloading' ? `${pct}%` : '');
    if (msg.stage !== 'downloaded') {
      setProcessingLabel(`Downloading ${selectedModel?.label ?? 'model'} — ${pct}%`, true);
    }
    studioProgress(msg.stage === 'cache-check' ? null : pct);
    procStageLabelEl.textContent = 'Downloading model';
  } else {
    // Everything else (runtime, session creation) is not a measurable
    // percentage, so the ring spins indeterminately rather than lying.
    showRing(null);
    setStep('download', 'done');
    setStep('prepare', 'active', msg.detail ?? '');
    setProcessingLabel(PHASE_LABELS[phase] + '…', true);
    studioProgress(null);
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

// Header brand: full lockup at the top of the page, figure-only mark once the
// page is scrolled OR the browser's system bar (mobile address bar) is showing,
// so the sticky header stays compact. data-collapsed drives the crossfade in
// CSS (src/style.css), so there is no per-scroll class churn on the elements.
const brandLink = document.getElementById('brandLink');
// The system bar hiding/showing changes the visual viewport height (not the
// layout viewport). Remember the tallest height seen; a drop below it means the
// bar is back on screen.
let maxViewportHeight = window.visualViewport?.height ?? window.innerHeight;
function updateBrandCollapse(): void {
  if (!brandLink) return;
  const vv = window.visualViewport;
  const height = vv?.height ?? window.innerHeight;
  maxViewportHeight = Math.max(maxViewportHeight, height);
  const barShowing = height < maxViewportHeight - 24;
  brandLink.dataset.collapsed = window.scrollY > 24 || barShowing ? 'true' : 'false';
}
window.addEventListener('scroll', updateBrandCollapse, { passive: true });
window.visualViewport?.addEventListener('resize', updateBrandCollapse, { passive: true });
window.addEventListener('resize', updateBrandCollapse, { passive: true });
updateBrandCollapse();

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

  renderModelName();
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
  setProcessingLabel('Download paused — your connection may be metered', false);
  // A dismissal is not a dead end: choosing a photo starts the download and the
  // run automatically.
});

boot().catch((e) => error(e instanceof Error ? e.message : String(e)));