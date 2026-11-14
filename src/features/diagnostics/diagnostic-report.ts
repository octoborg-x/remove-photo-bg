// Versioned, local-only diagnostic report.
//
// One tap in the Technical details disclosure copies a readable report a
// real-device tester can paste back into an issue. Everything is gathered in the
// browser from state the app already has: the GPU adapter the provider gate
// already enumerated, the worker's load/inference timings, and the raw-mask
// statistics measured right after inference.
//
// PRIVACY: the report NEVER contains image data, pixels, the image filename,
// EXIF, the user's email, IP address, cookies, tokens, localStorage, or
// filesystem paths. It is generated entirely on the device and copied to the
// clipboard — no network request is made (see the no-upload guard test).

import type { RawMaskStats } from './raw-mask-stats';

/** Schema version of the structured report. Bump on any breaking field change. */
export const DIAGNOSTIC_SCHEMA_VERSION = '1.0';

/** The provider that ACTUALLY executed inference, or 'none' before any run. */
export type ActualProvider = 'webgpu' | 'wasm' | 'none';

export interface GpuReport {
  /** True when navigator.gpu exposed an adapter (an adapter merely existing). */
  adapterDetected: boolean;
  /** True when the provider gate judged the adapter usable for this model. */
  adapterUsable: boolean;
  vendor: string | null;
  architecture: string | null;
  device: string | null;
  description: string | null;
  /** WebGPU feature names the adapter exposes. */
  features: string[];
  /** 'yes' | 'no' | 'unknown' — whether the adapter supports shader-f16. */
  shaderF16: 'yes' | 'no' | 'unknown';
  maxStorageBufferBindingSize: number | null;
  maxBufferSize: number | null;
}

export interface RuntimeReport {
  /** navigator.gpu is present at all. */
  webgpuAvailable: boolean;
  crossOriginIsolated: boolean;
  /** This host serves the WebGPU-capable ORT bundle (else WebGPU cannot run). */
  webgpuRuntimeBundle: boolean;
  /** A WebGPU session was successfully built (not merely that an adapter exists). */
  webgpuSessionInitialized: boolean;
  /** True once a run has actually executed. Until then, "executed inference" is
   *  false for BOTH providers, so a report taken before any run never claims a
   *  provider ran the model. */
  inferenceRan: boolean;
  /** The provider the user/app selected (may differ from what actually ran). */
  selectedProvider: 'webgpu' | 'wasm';
  /** The provider that actually executed inference, or 'none' before any run. */
  actualProvider: ActualProvider;
  webgpuExecutedInference: boolean;
  wasmExecutedInference: boolean;
  /** Why the GPU was not used / why it fell back to WASM, or null. */
  fallbackReason: string | null;
}

export interface ModelReport {
  id: string | null;
  filename: string | null;
  /** sha256 from the manifest, when the model has been resolved. */
  revision: string | null;
  /** The model's square input size in px. */
  inputSize: number | null;
  /** The chosen photo's dimensions in px (dimensions only — never pixels). */
  imageWidth: number | null;
  imageHeight: number | null;
}

export interface InferenceReport {
  /** Model download time, ms (cold only; a cache hit is 0). */
  downloadMs: number | null;
  /** Session build/optimize time, ms. */
  sessionInitMs: number | null;
  /** First (cold) inference, ms. */
  coldMs: number | null;
  /** Warm inference times, ms. */
  warmMs: number[];
  /** Average of the warm runs, ms, or null when none. */
  averageMs: number | null;
  /** Post-processing (compose/refine) time, ms, when measured. */
  postprocessingMs: number | null;
}

export interface PostprocessingReport {
  /** Foreground flood-fill recovery ran (the model kept the whole frame). */
  maskRecoveryTriggered: boolean;
  refinementEnabled: boolean;
  /** null = not attempted / unknown. */
  refinementSucceeded: boolean | null;
}

export interface DiagnosticReport {
  schemaVersion: string;
  generatedAt: string;
  device: {
    hardwareConcurrency: number | null;
    deviceMemoryGb: number | null;
    crossOriginIsolated: boolean;
  };
  browser: {
    userAgent: string;
    platform: string | null;
  };
  gpu: GpuReport;
  runtime: RuntimeReport;
  model: ModelReport;
  inference: InferenceReport;
  rawMask: RawMaskStats;
  postprocessing: PostprocessingReport;
  errors: string[];
}

export interface DiagnosticReportInput {
  userAgent: string;
  platform: string | null;
  hardwareConcurrency: number | null;
  deviceMemoryGb: number | null;
  crossOriginIsolated: boolean;
  webgpuAvailable: boolean;
  webgpuRuntimeBundle: boolean;
  webgpuSessionInitialized: boolean;
  /** True once a run has actually executed (so we never claim GPU inference
   *  merely because a GPU adapter or session exists). */
  inferenceRan: boolean;
  selectedProvider: 'webgpu' | 'wasm';
  actualProvider: ActualProvider;
  fallbackReason: string | null;
  adapterDetected: boolean;
  adapterUsable: boolean;
  adapter: {
    vendor?: string | null;
    architecture?: string | null;
    device?: string | null;
    description?: string | null;
    features?: readonly string[];
    maxStorageBufferBindingSize?: number | null;
    maxBufferSize?: number | null;
  } | null;
  model: ModelReport;
  inference: InferenceReport;
  rawMask: RawMaskStats;
  postprocessing: PostprocessingReport;
  errors: readonly string[];
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

function cleanText(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t ? t : null;
}

/** Builds the structured report. Never throws; missing data becomes null. */
export function buildDiagnosticReport(input: DiagnosticReportInput): DiagnosticReport {
  const features = input.adapter?.features ? Array.from(input.adapter.features) : [];
  const shaderF16: 'yes' | 'no' | 'unknown' =
    features.length === 0 ? 'unknown' : features.includes('shader-f16') ? 'yes' : 'no';

  const gpu: GpuReport = {
    adapterDetected: input.adapterDetected,
    adapterUsable: input.adapterUsable,
    vendor: cleanText(input.adapter?.vendor),
    architecture: cleanText(input.adapter?.architecture),
    device: cleanText(input.adapter?.device),
    description: cleanText(input.adapter?.description),
    features,
    shaderF16,
    maxStorageBufferBindingSize: input.adapter?.maxStorageBufferBindingSize ?? null,
    maxBufferSize: input.adapter?.maxBufferSize ?? null,
  };

  const runtime: RuntimeReport = {
    webgpuAvailable: input.webgpuAvailable,
    crossOriginIsolated: input.crossOriginIsolated,
    webgpuRuntimeBundle: input.webgpuRuntimeBundle,
    webgpuSessionInitialized: input.webgpuSessionInitialized,
    inferenceRan: input.inferenceRan,
    selectedProvider: input.selectedProvider,
    actualProvider: input.actualProvider,
    webgpuExecutedInference: input.inferenceRan && input.actualProvider === 'webgpu',
    wasmExecutedInference: input.inferenceRan && input.actualProvider === 'wasm',
    fallbackReason: cleanText(input.fallbackReason),
  };

  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    generatedAt: (input.now ?? new Date()).toISOString(),
    device: {
      hardwareConcurrency: input.hardwareConcurrency,
      deviceMemoryGb: input.deviceMemoryGb,
      crossOriginIsolated: input.crossOriginIsolated,
    },
    browser: {
      userAgent: input.userAgent,
      platform: cleanText(input.platform),
    },
    gpu,
    runtime,
    model: input.model,
    inference: input.inference,
    rawMask: input.rawMask,
    postprocessing: input.postprocessing,
    errors: [...input.errors],
  };
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

function ms(v: number | null): string {
  return v != null ? `${v.toFixed(0)} ms` : 'unknown';
}

function bytes(v: number | null): string {
  return v != null ? `${v.toLocaleString('en-US')} bytes (${(v / 1048576).toFixed(0)} MB)` : 'unknown';
}

function yesNo(v: boolean): string {
  return v ? 'yes' : 'no';
}

function orUnknown(v: string | null | undefined): string {
  return v && v.length ? v : 'unknown';
}

function joinList(v: readonly number[]): string {
  return v.length ? v.map((n) => n.toFixed(0)).join(', ') : 'none';
}

/**
 * Renders the structured report as readable, sectioned plain text. Tail
 * fractions are shown as percentages here while the structured data keeps the
 * raw numeric fractions. No example or fabricated values are ever inserted —
 * unavailable fields read "unknown".
 */
export function formatDiagnosticReport(report: DiagnosticReport): string {
  const { gpu, runtime, model, inference, rawMask, postprocessing } = report;
  const adapterName =
    [gpu.vendor, gpu.architecture, gpu.device, gpu.description].filter(Boolean).join(' ') || null;

  const lines: string[] = [];
  lines.push('SMARTCUTAI — DIAGNOSTIC REPORT');
  lines.push(`schema: ${report.schemaVersion}`);
  lines.push(`generated: ${report.generatedAt}`);
  lines.push('');
  lines.push('Environment');
  lines.push(`Browser: ${orUnknown(report.browser.userAgent)}`);
  lines.push(`Platform: ${orUnknown(report.browser.platform)}`);
  lines.push(`Hardware concurrency: ${report.device.hardwareConcurrency ?? 'unknown'}`);
  lines.push(`Device memory: ${report.device.deviceMemoryGb != null ? `${report.device.deviceMemoryGb} GB` : 'unknown'}`);
  lines.push(`Cross-origin isolated: ${yesNo(report.device.crossOriginIsolated)}`);
  lines.push('');
  lines.push('GPU');
  lines.push(`Adapter detected: ${yesNo(gpu.adapterDetected)}`);
  lines.push(`Adapter usable: ${yesNo(gpu.adapterUsable)}`);
  lines.push(`Adapter: ${orUnknown(adapterName)}`);
  lines.push(`Vendor: ${orUnknown(gpu.vendor)}`);
  lines.push(`Architecture: ${orUnknown(gpu.architecture)}`);
  lines.push(`Device: ${orUnknown(gpu.device)}`);
  lines.push(`Description: ${orUnknown(gpu.description)}`);
  lines.push(`Features: ${gpu.features.length ? gpu.features.join(', ') : 'unknown'}`);
  lines.push(`shader-f16: ${gpu.shaderF16}`);
  lines.push(`maxStorageBufferBindingSize: ${bytes(gpu.maxStorageBufferBindingSize)}`);
  lines.push(`maxBufferSize: ${bytes(gpu.maxBufferSize)}`);
  lines.push('');
  lines.push('Runtime');
  lines.push(`WebGPU available: ${yesNo(runtime.webgpuAvailable)}`);
  lines.push(`WebGPU runtime bundle served: ${yesNo(runtime.webgpuRuntimeBundle)}`);
  lines.push(`WebGPU session: ${runtime.webgpuSessionInitialized ? 'initialized' : 'not initialized'}`);
  lines.push(`Selected provider: ${runtime.selectedProvider}`);
  lines.push(`Actual inference provider: ${runtime.actualProvider}`);
  lines.push(`Inference executed: ${yesNo(runtime.inferenceRan)}`);
  lines.push(`WebGPU executed inference: ${yesNo(runtime.webgpuExecutedInference)}`);
  lines.push(`WASM executed inference: ${yesNo(runtime.wasmExecutedInference)}`);
  lines.push(`Fallback reason: ${orUnknown(runtime.fallbackReason)}`);
  lines.push('');
  lines.push('Model');
  lines.push(`Model ID: ${orUnknown(model.id)}`);
  lines.push(`Model filename: ${orUnknown(model.filename)}`);
  lines.push(`Model revision: ${orUnknown(model.revision)}`);
  lines.push(`Input dimensions: ${model.inputSize != null ? `${model.inputSize}x${model.inputSize}` : 'unknown'}`);
  lines.push(
    `Image dimensions: ${
      model.imageWidth != null && model.imageHeight != null
        ? `${model.imageWidth}x${model.imageHeight}`
        : 'unknown'
    }`,
  );
  lines.push('');
  lines.push('Inference');
  lines.push(`Download: ${ms(inference.downloadMs)}`);
  lines.push(`Initialization: ${ms(inference.sessionInitMs)}`);
  lines.push(`Cold inference: ${ms(inference.coldMs)}`);
  lines.push(`Warm inference: ${joinList(inference.warmMs)}${inference.warmMs.length ? ' ms' : ''}`);
  lines.push(`Average inference: ${ms(inference.averageMs)}`);
  lines.push(`Postprocessing: ${ms(inference.postprocessingMs)}`);
  lines.push('');
  lines.push('RAW MASK STATISTICS');
  lines.push(`Dimensions: ${rawMask.width}x${rawMask.height}`);
  lines.push(`Minimum: ${rawMask.min.toFixed(4)}`);
  lines.push(`Mean: ${rawMask.mean.toFixed(4)}`);
  lines.push(`Maximum: ${rawMask.max.toFixed(4)}`);
  lines.push(`Below 0.01: ${pct(rawMask.below_001_fraction)}`);
  lines.push(`Below 0.1: ${pct(rawMask.below_01_fraction)}`);
  lines.push(`Below 0.5: ${pct(rawMask.below_05_fraction)}`);
  lines.push(`Above 0.95: ${pct(rawMask.above_095_fraction)}`);
  lines.push(`Above 0.99: ${pct(rawMask.above_099_fraction)}`);
  lines.push(`Non-finite values: ${rawMask.non_finite_count}`);
  lines.push('');
  lines.push('Postprocessing');
  lines.push(`Mask recovery: ${postprocessing.maskRecoveryTriggered ? 'triggered' : 'not triggered'}`);
  lines.push(
    `Refinement: ${
      postprocessing.refinementEnabled
        ? postprocessing.refinementSucceeded === false
          ? 'enabled (failed)'
          : postprocessing.refinementSucceeded === true
            ? 'enabled (succeeded)'
            : 'enabled'
        : 'disabled'
    }`,
  );
  lines.push(`Errors: ${report.errors.length ? report.errors.join('; ') : 'none'}`);
  return lines.join('\n');
}
