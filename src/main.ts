// Main thread: orchestrates the Phase 1 smoke test.
// - loads a local test image
// - sends it to the worker for 5 warm inferences
// - composites the mask and renders/downloads a transparent PNG
// - reports timings and the execution provider
import { imageDataToTensor } from './features/background-removal/image-preprocess';
import {
  logitsToMask,
  upscaleMask,
  applyMaskToImage,
} from './features/background-removal/mask-postprocess';
import { canvasToPngDataUrl } from './features/background-removal/export-image';
import type { WorkerProgressMessage } from './features/background-removal/types';

const MODEL_URL = '/models/model_fp16.onnx';

const stageEl = document.getElementById('stage')!;
const logEl = document.getElementById('log')! as HTMLPreElement;
const inputBox = document.getElementById('inputBox')!;
const outputBox = document.getElementById('outputBox')!;
const pickFileBtn = document.getElementById('pickFile')! as HTMLButtonElement;
const runAllBtn = document.getElementById('runAll')! as HTMLButtonElement;

let currentImage: HTMLImageElement | null = null;
let currentImageData: ImageData | null = null;
let worker: Worker | null = null;
let modelReady = false;

const WARM_RUNS = 5;
const timings: number[] = [];
const provider = '';
let loadTimeMs = 0;

function log(msg: string): void {
  logEl.textContent += msg + '\n';
}

function setStage(s: string): void {
  stageEl.textContent = s;
}

function error(msg: string): void {
  log(`ERROR: ${msg}`);
  setStage(`Error: ${msg}`);
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
  URL.revokeObjectURL(url);
  inputBox.innerHTML = '';
  inputBox.appendChild(img.cloneNode() as HTMLImageElement);
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
  inputBox.innerHTML = '';
  inputBox.appendChild(img.cloneNode() as HTMLImageElement);
  runAllBtn.disabled = !modelReady;
  log(`Loaded image from URL: ${url} (${canvas.width}x${canvas.height})`);
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
      window.smokeProvider = msg.provider;
      announcedLog.push(msg.provider);
      modelReady = true;
      window.smokeModelReady = true;
      runAllBtn.disabled = !currentImage;
      pickFileBtn.disabled = false;
    } else if (msg.kind === 'inference-time') {
      timings.push(msg.ms);
      log(`Inference ${timings.length}: ${msg.ms.toFixed(1)} ms`);
      if (timings.length === WARM_RUNS) {
        finishedRun();
      }
    } else if (msg.kind === 'result-ready') {
      if (!currentImageData) return;
      const { mask, width, height } = msg;
      const maskU8 = logitsToMask(mask);
      const upscaled = upscaleMask(maskU8, 1024, 1024, currentImageData.width, currentImageData.height);
      const out = applyMaskToImage(currentImageData, upscaled);
      const canvas = document.createElement('canvas');
      canvas.width = out.width;
      canvas.height = out.height;
      const ctx = canvas.getContext('2d')!;
      ctx.putImageData(out, 0, 0);
      const png = canvasToPngDataUrl(canvas);

      outputBox.innerHTML = '';
      const img = document.createElement('img');
      img.src = png;
      outputBox.appendChild(img);

      // Also offer a download link.
      const a = document.createElement('a');
      a.href = png;
      a.download = `smoke-${width}x${height}.png`;
      a.textContent = 'Download transparent PNG';
      outputBox.appendChild(a);

      log(`Rendered transparent PNG (${width}x${height}), real alpha.`);
    } else if (msg.kind === 'error') {
      error(msg.message);
      modelReady = false;
      runAllBtn.disabled = true;
    }
  };
  worker.postMessage({ kind: 'set-model', modelUrl: MODEL_URL });
}

async function runOneInference(): Promise<void> {
  if (!currentImageData || !worker) return;
  setStage(`Inference ${timings.length + 1}/${WARM_RUNS}…`);
  const tensor = imageDataToTensor(currentImageData);
  worker.postMessage({ kind: 'run', tensor, width: currentImageData.width, height: currentImageData.height });
}

function finishedRun(): void {
  setStage('Done');
  const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
  log(`--- Summary ---`);
  log(`Warm inference timings (${WARM_RUNS} runs): ${timings.map((t) => t.toFixed(1)).join(', ')} ms`);
  log(`Average: ${avg.toFixed(1)} ms`);
  log(`Provider: ${provider || '<reported above>'}`);
  log(`Model download size (fp16): ~109 MB (see report)`);
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
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (modelReady) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });
  timings.length = 0;
  outputBox.innerHTML = '';
  for (let i = 0; i < runs; i++) {
    await runOneInference();
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (timings.length === i + 1) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });
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