// Main thread: orchestrates the Phase 1 smoke test.
// - loads a local test image
// - sends it to the worker for 5 warm inferences
// - composites the mask and renders/downloads a transparent PNG
// - reports timings and the execution provider
import { imageDataToTensor, MODEL_SIZE } from './features/background-removal/image-preprocess';
import {
  probabilityToMask,
  upscaleMask,
  applyMaskToImage,
} from './features/background-removal/mask-postprocess';
import { canvasToPngDataUrl } from './features/background-removal/export-image';
import type { WorkerProgressMessage } from './features/background-removal/types';

const MODEL_URL = '/models/model_512.onnx';
// This export applies sigmoid internally, so its output is already [0,1].
const MODEL_OUTPUT_IS_PROBABILITY = true;

const stageEl = document.getElementById('stage')!;
const logEl = document.getElementById('log')! as HTMLPreElement;
const inputBox = document.getElementById('inputBox')!;
const outputBox = document.getElementById('outputBox')!;
const pickFileBtn = document.getElementById('pickFile')! as HTMLButtonElement;
const runAllBtn = document.getElementById('runAll')! as HTMLButtonElement;

let currentImage: HTMLImageElement | null = null;
let currentImageData: ImageData | null = null;
let currentObjectUrl: string | null = null;
let worker: Worker | null = null;
let modelReady = false;
let modelError: string | null = null;
const modelWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

const WARM_RUNS = 5;
const timings: number[] = [];
let loadTimeMs = 0;

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
  // Classic worker (plain JS in /public) so onnxruntime-web's wasm loaders are
  // fetched as static files instead of being transformed by Vite.
  worker = new Worker('/inference-worker.js', { type: 'classic' });
  worker.onmessage = (e: MessageEvent<WorkerProgressMessage>) => {
    const msg = e.data;
    if (msg.kind === 'loading-model') {
      setStage(`Loading model… ${msg.at}%`);
    } else if (msg.kind === 'load-time') {
      setStage(`Model loaded — provider ${msg.provider}`);
      loadTimeMs = msg.ms;
      log(`Model load time: ${loadTimeMs.toFixed(1)} ms`);
      log(`Execution provider: ${msg.provider}`);
      if (msg.adapter) log(`GPU adapter: ${msg.adapter}`);
      window.smokeProvider = msg.provider;
      announcedLog.push(msg.provider);
      runAllBtn.disabled = !currentImage;
      pickFileBtn.disabled = false;
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
      const maskU8 = probabilityToMask(mask);
      const upscaled = upscaleMask(maskU8, MODEL_SIZE, MODEL_SIZE, currentImageData.width, currentImageData.height);
      const out = applyMaskToImage(currentImageData, upscaled);
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
      } else if (currentImageData) {
        // A run-level failure (e.g. an allocation error) does not kill the
        // session; the worker retries on CPU, so keep the app usable.
        runAllBtn.disabled = false;
      }
    }
  };
  const forced = new URLSearchParams(location.search).get('provider');
  if (forced) log(`Provider forced to: ${forced} (from ?provider=)`);
  worker.postMessage({
    kind: 'set-model',
    modelUrl: MODEL_URL,
    inputSize: MODEL_SIZE,
    outputIsProbability: MODEL_OUTPUT_IS_PROBABILITY,
    forceProvider: forced || undefined,
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
  log(`--- Summary ---`);
  log(`Warm inference timings (${timings.length} runs): ${timings.map((t) => t.toFixed(1)).join(', ')} ms`);
  log(`Average: ${avg.toFixed(1)} ms`);
  log(`Provider: ${window.smokeProvider || '<reported above>'}`);
  log(`Model download size: ~185 MB (model_512.onnx)`);
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
type RunDone = { timings: number[]; avgMs: number; provider: string };

declare global {
  interface Window {
    runSmoke: (imgUrl?: string, runs?: number) => Promise<RunDone | null>;
    onSmokeDone: ((result: RunDone, maskDataUrl: string) => void) | null;
    smokeModelReady: boolean;
    smokeProvider: string;
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
  };
  const maskImg = outputBox.querySelector('img');
  window.onSmokeDone?.(result, maskImg?.src ?? '');
  return result;
}

window.runSmoke = runSmoke;
window.smokeModelReady = false;

// Start: init the worker. No model binary is committed; the user must run the
// fetch script first.
setStage('Starting worker…');
log('Worker initializing…');
initWorker().catch((e) => error(e.message));
log('If the model is not downloaded, run: npm run fetch-models');