// Main thread: orchestrates the Phase 2 product workflow.
// - loads a local test image
// - auto-loads the default model on page start (selectable, per-model + per-
//   provider buckets/persistence)
// - sends images to the worker for inference
// - composites the mask and renders/downloads a transparent PNG (and JPG)
// - reports timings and the execution provider
import { imageDataToTensor, MODEL_SIZE } from './features/background-removal/image-preprocess';
import {
  probabilityToMask,
  upscaleMask,
  applyMaskToImage,
  applyMaskAdjust,
  DEFAULT_MASK_ADJUST,
  isMaskAdjust,
  type MaskAdjust,
} from './features/background-removal/mask-postprocess';
import { canvasToPngDataUrl, canvasToJpegDataUrl } from './features/background-removal/export-image';
import {
  ensureAssetCache,
  cachedAssetCount,
  onAssetCacheMessage,
  ASSET_BASE,
} from './features/background-removal/asset-cache';
import { describeProgress } from './features/background-removal/load-progress';
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
import type {
  LoadStage,
  ModelManifestEntry,
  WorkerProgressMessage,
} from './features/background-removal/types';

// Replaced at build/serve time by the build-stamp plugin in vite.config.ts.
declare const __BUILD_ID__: string;

const stageEl = document.getElementById('stage')!;
const logEl = document.getElementById('log')! as HTMLPreElement;
const inputBox = document.getElementById('inputBox')!;
const outputBox = document.getElementById('outputBox')!;
const pickFileBtn = document.getElementById('pickFile')! as HTMLButtonElement;
const runAllBtn = document.getElementById('runAll')! as HTMLButtonElement;
const copyReportBtn = document.getElementById('copyReport')! as HTMLButtonElement;
const modelSelect = document.getElementById('modelSelect')! as HTMLSelectElement;
const providerToggle = document.getElementById('providerToggle')! as HTMLSelectElement;
const loadModelBtn = document.getElementById('loadModel')! as HTMLButtonElement;
const downloadJpgBtn = document.getElementById('downloadJpg')! as HTMLAnchorElement;
const providerHint = document.getElementById('providerHint')!;
const maskThresholdInput = document.getElementById('maskThreshold')! as HTMLInputElement;
const maskThresholdValue = document.getElementById('maskThresholdValue')!;
const maskFeatherInput = document.getElementById('maskFeather')! as HTMLInputElement;
const maskFeatherValue = document.getElementById('maskFeatherValue')!;

// Persisted user preferences: model id, provider, and mask adjustments.
// Scrubbed to safe values on read so stale/corrupt entries are ignored.
const LS_MODEL = 'remove-bg:model';
const LS_PROVIDER = 'remove-bg:provider';
const LS_MASK_ADJUST = 'remove-bg:mask-adjust';

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
// Set as soon as the worker posts anything at all; distinguishes "never started"
// from "working on a long download".
let workerResponded = false;
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

function setOutputStatus(text: string): void {
  outputBox.innerHTML = '';
  if (!text) return;
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = text;
  outputBox.appendChild(p);
}

function log(msg: string): void {
  logEl.textContent += msg + '\n';
}

function setStage(s: string): void {
  stageEl.textContent = s;
}

function showError(msg: string): void {
  log(`ERROR: ${msg}`);
  setStage(`Error: ${msg}`);
}

function error(msg: string): void {
  showError(describeError(msg));
}

const OOM_PATTERN = /bad_alloc|out of memory|outofmemory|allocation failed|allocation error/i;

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
  inputBox.innerHTML = '';
  // Append the already-decoded element itself. Cloning it would create a new
  // element that has to re-fetch the (possibly revoked) blob: URL and renders broken.
  inputBox.appendChild(img);
}

async function loadImageFromFile(file: File): Promise<void> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to decode image'));
    img.src = url;
  });
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
  runAllBtn.disabled = !modelReady;
  log(`Loaded image: ${file.name} (${canvas.width}x${canvas.height})`);
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
  runAllBtn.disabled = !modelReady;
  log(`Loaded image from URL: ${url} (${canvas.width}x${canvas.height})`);
}

function waitForModel(): Promise<void> {
  if (modelReady) return Promise.resolve();
  if (modelError) return Promise.reject(new Error(modelError));
  return new Promise<void>((resolve, reject) => modelWaiters.push({ resolve, reject }));
}

function settleModel(error: string | null): void {
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
  if (ASSET_BASE) log(`Assets served from: ${ASSET_BASE}`);

  // Classic worker (plain JS in /public) so onnxruntime-web's wasm loaders are
  // fetched as static files instead of being transformed by Vite. The runtime
  // bundle is chosen here: a usable GPU adapter means the WebGPU-capable ORT
  // bundle (a ~26.5 MiB jsep wasm that hosts with a per-file cap cannot serve);
  // the worker degrades a webgpu request to WASM with a clear message when that
  // bundle is absent.
  const runtimeQuery = webGpuUsable() ? '?runtime=webgpu' : '';
  worker = new Worker('/inference-worker.js' + runtimeQuery, { type: 'classic' });
  // Without these a worker that fails to start (404 on the script, a failed
  // importScripts of the ORT runtime) posts nothing at all and the page waits on
  // its initial "Starting…" text forever.
  worker.onerror = (e) => {
    error(`Inference worker failed to start: ${e.message || 'unknown worker error'}`);
    settleModel('worker failed to start');
  };
  worker.onmessageerror = () => {
    error('Inference worker sent a message that could not be deserialized');
  };
  worker.onmessage = (e: MessageEvent<WorkerProgressMessage>) => {
    const msg = e.data;
    workerResponded = true;
    if (msg.kind === 'loading-progress') {
      updateLoadProgress(msg);
    } else if (msg.kind === 'load-time') {
      const loadedModelId = msg.modelId ?? selectedModel?.id ?? 'unknown';
      setStage(`Model loaded — provider ${msg.provider}`);
      loadTimeMs = msg.ms;
      log(`Model: ${loadedModelId}`);
      log(`Model load time: ${loadTimeMs.toFixed(1)} ms`);
      log(`Execution provider: ${msg.provider}`);
      if (msg.adapter) {
        adapterReport = msg.adapter;
        log(`GPU adapter: ${msg.adapter}`);
      }
      window.smokeProvider = msg.provider;
      window.smokeModelId = loadedModelId;
      announcedLog.push(msg.provider);
      runAllBtn.disabled = !currentImage;
      pickFileBtn.disabled = false;
      loadModelBtn.disabled = false;
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
      // The worker reports the model's actual input size so a per-model input
      // change (e.g. a 384 variant) never mis-scales the mask.
      const inputSize = msg.inputSize ?? MODEL_SIZE;
      const maskU8 = probabilityToMask(mask);
      const upscaled = upscaleMask(maskU8, inputSize, inputSize, currentImageData.width, currentImageData.height);
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
      const png = canvasToPngDataUrl(canvas);

      let opaquePx = 0;
      for (let i = 3; i < out.data.length; i += 4) if (out.data[i] > 127) opaquePx++;

      outputBox.innerHTML = '';
      const img = document.createElement('img');
      img.src = png;
      img.alt = 'Background removed';
      outputBox.appendChild(img);

      const a = document.createElement('a');
      a.href = png;
      a.download = `smoke-${width}x${height}.png`;
      a.textContent = 'Download transparent PNG';
      outputBox.appendChild(a);

      // White-background JPG export (Phase 2 requirement).
      const jpg = canvasToJpegDataUrl(canvas);
      downloadJpgBtn.href = jpg;
      downloadJpgBtn.download = `smoke-${width}x${height}.jpg`;
      downloadJpgBtn.style.display = 'inline-block';

      log(`Rendered transparent PNG (${width}x${height}), ${((opaquePx / (out.width * out.height)) * 100).toFixed(1)}% opaque.`);
      // A uniform mask means the model did not segment anything; say so rather
      // than leaving the user staring at a blank (fully transparent) image.
      if (opaquePx === 0) log('WARNING: the mask is fully transparent, so there is no subject to show.');
    } else if (msg.kind === 'error') {
      // Errors tied to a run are delivered through that run's promise, so the
      // caller reports them once. Anything else is surfaced here.
      if (msg.runId !== undefined) failPendingRuns(new Error(msg.message));
      else error(msg.message);
      if (msg.fatal) {
        settleModel(msg.message);
        runAllBtn.disabled = true;
        loadModelBtn.disabled = false;
        setSelectorsDisabled(false);
      } else if (currentImageData) {
        // A run-level failure (e.g. an allocation error) does not kill the
        // session; the worker retries on CPU, so keep the app usable.
        runAllBtn.disabled = false;
      }
    }
  };
}

function setSelectorsDisabled(disabled: boolean): void {
  modelSelect.disabled = disabled;
  providerToggle.disabled = disabled;
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
  modelReady = false;
  modelError = null;
  window.smokeModelReady = false;
  window.smokeModelId = selectedModel.id;
  window.smokeProvider = selectedProvider;
  workerResponded = false;
  resetProgressClock();
  adapterReport = '';
  setStage(`Loading model ${selectedModel.id}…`);
  log(`Loading model: ${selectedModel.id} (${selectedModel.url})`);
  const force = providerForce(selectedProvider);
  if (forcedProvider) log(`Provider forced to: ${forcedProvider} (from ?provider=)`);
  else if (force === 'wasm') log('Provider: CPU (WASM)');
  setSelectorsDisabled(true);
  loadModelBtn.disabled = true;
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
    setStage('No response from the inference worker');
    log(
      `WARNING: the inference worker has not responded in ${WORKER_START_TIMEOUT_MS / 1000}s. ` +
        'Its script or the ONNX Runtime files may have failed to load; check the browser console.',
    );
    setSelectorsDisabled(false);
    loadModelBtn.disabled = false;
  }, WORKER_START_TIMEOUT_MS);
}

// ——— Model/provider selection UI ———
// Pseudo-values in the model dropdown that select a runtime instead of a model.
// The optgroup separates them from the actual model artifacts; picking one keeps
// the current model and switches the provider (persisted). The separate
// provider toggle stays in sync.
const RUNTIME_OPT_PREFIX = 'runtime:';
const RUNTIME_WASM = RUNTIME_OPT_PREFIX + 'wasm';
const RUNTIME_GPU = RUNTIME_OPT_PREFIX + 'webgpu';

// The browser can run WebGPU AND this host serves the WebGPU-capable ORT
// bundle. Both gates matter: exposing an adapter means nothing if the worker
// can't import a runtime that knows the webgpu backend.
function webGpuUsable(): boolean {
  return gpuState?.available === true && runtimeHasWebGpuBundle;
}

function isRuntimeOptionAvailable(v: string): boolean {
  return v === RUNTIME_WASM || (v === RUNTIME_GPU && webGpuUsable());
}

// After a one-shot runtime switch the dropdown returns to showing the current
// model, so the value column always names an actual artifact (the provider has
// its own control + hint).
function snapModelSelectToModel(): void {
  if (selectedModel) modelSelect.value = selectedModel.id;
}

function populateModelSelect(): void {
  const previous = modelSelect.value;
  modelSelect.innerHTML = '';
  const modelGroup = document.createElement('optgroup');
  modelGroup.label = 'Models';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.description) opt.title = m.description;
    modelGroup.appendChild(opt);
  }
  modelSelect.appendChild(modelGroup);
  const runtimeGroup = document.createElement('optgroup');
  runtimeGroup.label = 'Runtime (model stays the same)';
  const wasm = document.createElement('option');
  wasm.value = RUNTIME_WASM;
  wasm.textContent = 'CPU (WASM)';
  runtimeGroup.appendChild(wasm);
  if (webGpuUsable()) {
    const gpu = document.createElement('option');
    gpu.value = RUNTIME_GPU;
    gpu.textContent = 'GPU (WebGPU)';
    runtimeGroup.appendChild(gpu);
  }
  modelSelect.appendChild(runtimeGroup);
  modelSelect.value = previous && (resolveModelParam(models, previous) || previous === RUNTIME_WASM || previous === RUNTIME_GPU)
    ? previous
    : selectedModel ? selectedModel.id : '';
}

function applyProviderUi(): void {
  // WebGPU is offered whenever the browser exposes an adapter AND this host
  // serves the WebGPU-capable bundle (no allowlist).
  const offerWebGpu = webGpuUsable();
  providerToggle.innerHTML = '';
  if (offerWebGpu) providerToggle.append(new Option('GPU (WebGPU)', 'webgpu'));
  const wasm = new Option('CPU (WASM)', 'wasm');
  providerToggle.append(wasm);
  providerToggle.value = selectedProvider;
  providerToggle.disabled = !offerWebGpu && !forcedProvider;
  providerHint.textContent = gpuState
    ? gpuState.reason +
      (gpuState.available && !runtimeHasWebGpuBundle
        ? ' — host cannot serve the WebGPU runtime, using CPU.'
        : selectedProvider === 'webgpu'
          ? ' — GPU selected.'
          : ' — CPU selected.')
    : 'GPU status unknown — using CPU.';
}

function resolveProvider(): 'webgpu' | 'wasm' {
  if (forcedProvider) {
    if (isProviderChoice(forcedProvider)) return forcedProvider;
    log(`Ignoring unknown ?provider="${forcedProvider}".`);
  }
  const pref = loadPref<unknown>(LS_PROVIDER, isProviderChoice);
  if (pref === 'wasm') return 'wasm';
  if (pref === 'webgpu' && webGpuUsable()) return 'webgpu';
  // Default: prefer the GPU when it is usable, else CPU.
  return webGpuUsable() ? 'webgpu' : 'wasm';
}

function resolveModel(): ModelManifestEntry {
  const byParam = resolveModelParam(models, forcedModel);
  if (byParam) {
    log(`Model forced to: ${byParam.id} (from ?model=)`);
    return byParam;
  }
  if (forcedModel) log(`Unknown model "${forcedModel}" from ?model=; using default.`);
  const pref = loadPref<string>(LS_MODEL, (v): v is string => typeof v === 'string');
  const fromPref = pref ? resolveModelParam(models, pref) : null;
  if (fromPref) return fromPref;
  const def = defaultModelId(models);
  return resolveModelParam(models, def) ?? models[0];
}

modelSelect.addEventListener('change', () => {
  const value = modelSelect.value;
  // A runtime pseudo-option: keep the model, switch the runtime.
  if (value === RUNTIME_WASM || value === RUNTIME_GPU) {
    const nextProvider: 'webgpu' | 'wasm' = value === RUNTIME_GPU ? 'webgpu' : 'wasm';
    if (nextProvider === 'webgpu' && !isRuntimeOptionAvailable(value)) {
      log('GPU (WebGPU) is not available on this device; keeping current provider.');
      snapModelSelectToModel();
      return;
    }
    if (nextProvider !== selectedProvider) {
      selectedProvider = nextProvider;
      savePref(LS_PROVIDER, selectedProvider);
      log(`Runtime selected: ${PROVIDER_LABELS[selectedProvider]}`);
      applyProviderUi();
      loadSelectedModel();
    }
    snapModelSelectToModel();
    return;
  }
  const next = resolveModelParam(models, value);
  if (!next || next.id === selectedModel?.id) return;
  selectedModel = next;
  savePref(LS_MODEL, next.id);
  log(`Model selected: ${next.id}`);
  loadSelectedModel();
});

providerToggle.addEventListener('change', () => {
  if (!isProviderChoice(providerToggle.value) || providerToggle.value === selectedProvider) return;
  selectedProvider = providerToggle.value;
  savePref(LS_PROVIDER, selectedProvider);
  log(`Provider selected: ${PROVIDER_LABELS[selectedProvider]}`);
  applyProviderUi();
  loadSelectedModel();
});

loadModelBtn.addEventListener('click', () => {
  if (selectedModel) loadSelectedModel();
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
  setStage(`Inference ${timings.length + 1}/${WARM_RUNS}…`);
  setOutputStatus(`Running inference ${timings.length + 1}/${WARM_RUNS}…`);
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
  setStage('Done');
  const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
  const model = selectedModel ? `${selectedModel.id} (${(selectedModel.size / 1048576).toFixed(1)} MB)` : '<none>';
  log(`--- Summary ---`);
  log(`Warm inference timings (${timings.length} run${timings.length === 1 ? '' : 's'}): ${timings.map((t) => t.toFixed(1)).join(', ')} ms`);
  log(`Average: ${avg.toFixed(1)} ms`);
  log(`Provider: ${window.smokeProvider || '<reported above>'}`);
  log(`Model: ${model}`);
  runAllBtn.disabled = false;
}

pickFileBtn.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (f) await loadImageFromFile(f);
  };
  input.click();
});

runAllBtn.addEventListener('click', () => {
  runSmoke();
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
    /** Manifest id of the currently loaded model, e.g. 'c5_best'. */
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
      error(e instanceof Error ? e.message : String(e));
      return null;
    }
  }
  if (!currentImageData) {
    error('No image loaded');
    return null;
  }
  try {
    await waitForModel();
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return null;
  }
  timings.length = 0;
  setOutputStatus('Preparing inference…');
  for (let i = 0; i < runs; i++) {
    try {
      await runOneInference();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      error(message);
      setOutputStatus(`No output: ${message}`);
      if (currentImageData) runAllBtn.disabled = false;
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

// ——— Device report ———
// One-copy summary of what the browser/device actually did, so real-device
// testers can paste the result back into the tracker without photographing a
// screen. No pixels are uploaded: the image never leaves the device; this text
// is produced and copied locally.
let adapterReport = '';
let modelDownloadBytes = 0;
let modelTotalBytes = 0;
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
const downloadStart = performance.now();

function resetProgressClock(): void {
  lastProgress = null;
  lastLoadStage = null;
  progressClockOffset = 0;
  modelDownloadBytes = 0;
  modelTotalBytes = 0;
}

// ——— Progress rendering ———
// Renders a checkpoint to the stage line and logs each new stage exactly once,
// so the log reads as an ordered timeline of the load rather than a stream of
// percentages.
function updateLoadProgress(msg: {
  stage: LoadStage;
  percent: number;
  bytes?: number;
  totalBytes?: number;
  elapsedMs: number;
  detail?: string;
}): void {
  if (msg.bytes !== undefined) modelDownloadBytes = msg.bytes;
  if (msg.totalBytes) modelTotalBytes = msg.totalBytes;
  if (!lastProgress) progressClockOffset = performance.now() - msg.elapsedMs;
  lastProgress = msg;
  setStage(describeProgress(msg));
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

copyReportBtn.addEventListener('click', () => {
  const isolation = window.crossOriginIsolated
    ? `yes (COOP/COEP headers served)`
    : `NO — threaded WASM may not engage`;
  const n = timings.length;
  const avg = n ? timings.reduce((a, b) => a + b, 0) / n : NaN;
  const mb = (modelDownloadBytes / 1048576).toFixed(1);
  const totalMb = modelTotalBytes ? (modelTotalBytes / 1048576).toFixed(1) + ' MB' : 'unknown';
  const dlSecs = modelDownloadBytes ? ((performance.now() - downloadStart) / 1000).toFixed(1) : 'n/a';
  const gpuGate = gpuState
    ? `${gpuState.available ? 'available' : 'unavailable'}${gpuState.adapter ? ` (${gpuState.adapter})` : ''}`
    : 'not checked';
  const lines = [
    '== BiRefNet_lite Phase 2 device report ==',
    `Build: ${__BUILD_ID__}`,
    `Page: ${location.origin}${location.pathname}`,
    `Model: ${window.smokeModelId || 'not loaded'}`,
    `Provider: ${window.smokeProvider || 'not loaded'}`,
    `GPU gate: ${gpuGate}`,
    `GPU runtime served by host: ${runtimeHasWebGpuBundle ? 'yes' : gpuState?.available === false ? 'n/a (no GPU)' : 'no (CPU only)'}`,
    `Adapter: ${adapterReport || 'n/a (not webgpu)'}`,
    `Cross-origin isolated: ${isolation}`,
    `Adapter f16: ${/shader-f16=yes/.test(adapterReport) ? 'yes' : adapterReport ? 'no' : 'n/a'}`,
    `Warm inferences: ${n}`,
    n ? `Timings (ms): ${timings.map((t) => t.toFixed(1)).join(', ')}` : 'Timings: n/a',
    n ? `Average (ms): ${avg.toFixed(1)}` : 'Average: n/a',
    `Model bytes: ${modelDownloadBytes ? mb + ' MB' : 'n/a'}${modelTotalBytes ? ' of ' + totalMb : ''}`,
    `Model load total: ${loadTimeMs ? loadTimeMs.toFixed(0) + ' ms' : 'n/a'}`,
    `Model download: ${dlSecs} s`,
    `First-cold-start shader compile: see first-inference note in log`,
    `UA: ${navigator.userAgent}`,
  ].join('\n');
  navigator.clipboard?.writeText(lines).then(
    () => log('Device report copied to clipboard.'),
    () => log('Could not copy automatically — select the report text from below.'),
  );
  log(`\n${lines}`);
  setStage('Device report copied');
});

// ——— Boot ———
// Order: build the provider gate (cheap), load the manifest (source of truth
// for models), then start the worker + asset cache, resolve defaults, and
// auto-load the default model. The page needs no manual step for a first run.
// No model binary is committed; npm run fetch-models downloads them and writes
// the manifest.
setStage('Starting…');
log(`Build ${__BUILD_ID__}`);
log('Detecting GPU…');

async function boot(): Promise<void> {
  // GPU gate first: it decides which provider is offered and the default.
  gpuState = await detectWebGpu();
  log(gpuState.reason + (gpuState.adapter ? ` (${gpuState.adapter})` : ''));
  if (gpuState.available) {
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
    showError('Model manifest could not be loaded. Run "npm run fetch-models" and reload.');
    return;
  }

  // Mask adjustments: from localStorage, with ?maskThreshold= / ?maskFeather=
  // overriding for automated runs. The UI always offers them (defaults off).
  maskAdjust = initMaskAdjust();
  applyMaskUi();
  log(`Mask adjust: threshold ${maskAdjust.threshold || 'off'}, feather ${maskAdjust.feather || 'off'}`);

  // Resolve defaults: provider can come from ?provider=, then localStorage,
  // then the GPU gate; model likewise from ?model=, then localStorage, then the
  // manifest default (newest = c5_best.onnx).
  selectedProvider = resolveProvider();
  selectedModel = resolveModel();

  populateModelSelect();
  applyProviderUi();
  log(`Provider default: ${selectedProvider}`);
  log(`Model default: ${selectedModel.id}`);

  await initWorker();
  log('If the model is not downloaded, run: npm run fetch-models');

  // Auto-load the default selection so a first visit needs no manual pick. The
  // smoke harness waits on window.smokeModelReady; this resolves it on success.
  loadSelectedModel();
}

boot().catch((e) => error(e instanceof Error ? e.message : String(e)));