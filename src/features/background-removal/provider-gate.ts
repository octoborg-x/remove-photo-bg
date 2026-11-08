// Provider availability gate shared by the UI (main.ts) and used at runtime.
//
// WebGPU is offered only when the browser exposes an adapter AND that adapter
// is likely to be *faster and correct* for this model. An adapter that merely
// exists is not enough: this repo measured a Qualcomm Adreno-6xx phone where
// WebGPU was slower than CPU and mis-segmented the subject, and an Intel Gen-9
// integrated GPU that stalls. A software ("fake GPU", e.g. llvmpipe/SwiftShader)
// adapter is worse still. So the default is:
//
//   - no adapter                      -> CPU (WASM)
//   - software / llvmpipe adapter     -> CPU (WASM)
//   - known-bad or slow adapter       -> CPU (WASM)
//   - adapter without shader-f16      -> CPU (WASM)  (model is fp16 internally)
//   - too-small storage binding limit -> CPU (WASM)
//   - otherwise (modern hardware GPU) -> GPU (WebGPU)
//
// A user (or a scripted `?provider=webgpu`) can still force GPU; the worker's
// own WASM fallback stays the safety net when a session fails to build/run.

interface GpuAdapterInfo {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

interface GpuAdapter {
  info?: GpuAdapterInfo;
  /** WebGPU feature names, e.g. 'shader-f16'. */
  features?: Iterable<string>;
  limits?: { maxStorageBufferBindingSize?: number };
}

interface NavigatorWithGpu extends Navigator {
  gpu?: { requestAdapter?: () => Promise<GpuAdapter | null> };
}

export type WebGpuDetect =
  | { available: true; adapter?: string; adapterPresent: true; reason: string }
  | { available: false; adapter?: undefined; adapterPresent: boolean; reason: string };

/** Minimum maxStorageBufferBindingSize (bytes) for the fp16 model's buffers. */
const MIN_STORAGE_BUFFER_BINDING = 1024 * 1024 * 1024; // 1 GiB

// Adapter substrings that must NOT default to GPU: software renderers report a
// real-looking vendor string ("Google Inc." / "Mesa"), so the device/description
// is the only reliable tell. Matching is case-insensitive.
const SOFTWARE_ADAPTER_HINTS = ['llvmpipe', 'swiftshader', 'software', 'basic render', 'microsoft basic'];

// Adapters measured (or widely reported) as slow/incorrect for this model. These
// fall back to CPU by default; a user can still opt into GPU explicitly.
const SLOW_ADAPTER_HINTS = ['adreno-6', 'adreno 6', 'intel gen-9', 'intel gen9', 'hd graphics 500', 'hd graphics 600'];

/**
 * Classifies a WebGPU adapter as usable for this model.
 *
 * Returns `{ usable: true }` for modern hardware GPUs and `{ usable: false,
 * reason }` for software/known-slow adapters or one missing a required
 * capability, so the caller can explain the choice in the log.
 */
export function classifyGpuAdapter(adapter: GpuAdapter | null): { usable: boolean; reason: string } {
  if (!adapter) return { usable: false, reason: 'no adapter' };
  const info = adapter.info ?? {};
  const label = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ') || 'unknown adapter';
  const haystack = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ').toLowerCase();

  if (SOFTWARE_ADAPTER_HINTS.some((h) => haystack.includes(h))) {
    return { usable: false, reason: `${label} is a software renderer (no real GPU acceleration)` };
  }
  if (SLOW_ADAPTER_HINTS.some((h) => haystack.includes(h))) {
    return { usable: false, reason: `${label} is known to be slower or incorrect than the CPU path here` };
  }
  const features = adapter.features ? Array.from(adapter.features) : null;
  if (features && !features.includes('shader-f16')) {
    return { usable: false, reason: `${label} lacks shader-f16, which this fp16 model needs` };
  }
  const limit = adapter.limits?.maxStorageBufferBindingSize;
  if (typeof limit === 'number' && limit > 0 && limit < MIN_STORAGE_BUFFER_BINDING) {
    return { usable: false, reason: `${label} exposes only ${Math.round(limit / 1048576)} MB of storage buffers` };
  }
  return { usable: true, reason: `GPU ready (${label})` };
}

/**
 * Detects whether WebGPU is available AND worth using. Never throws: any failure
 * to enumerate the adapter means "not usable", and the app uses CPU (WASM).
 *
 * `reason` is a short phrase for the log/log-line, e.g. "WebGPU unavailable in
 * this browser" or "GPU ready (…)".
 */
export async function detectWebGpu(): Promise<WebGpuDetect> {
  const nav = navigator as NavigatorWithGpu;
  if (typeof navigator === 'undefined' || !('gpu' in nav) || !nav.gpu?.requestAdapter) {
    return { available: false, adapterPresent: false, reason: 'WebGPU is not available in this browser' };
  }
  try {
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) {
      return { available: false, adapterPresent: false, reason: 'WebGPU is enabled but no adapter was found' };
    }
    const info = adapter.info ?? {};
    const label = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ') || 'unknown adapter';
    const verdict = classifyGpuAdapter(adapter);
    if (!verdict.usable) {
      // An adapter exists but is not a good default (software/known-slow/missing
      // capability). The CPU stays the default, but the GPU remains selectable:
      // the UI offers it with `adapterPresent: true` and explains the trade-off
      // when the user switches.
      return { available: false, adapterPresent: true, reason: `WebGPU skipped — ${verdict.reason}` };
    }
    return {
      available: true,
      adapter: label,
      adapterPresent: true,
      reason: `WebGPU available (${label})`,
    };
  } catch {
    return { available: false, adapterPresent: false, reason: 'WebGPU adapter detection failed' };
  }
}

/**
 * Whether THIS host serves the WebGPU-capable ORT runtime files. The browser
 * may expose WebGPU (navigator.gpu + adapter) while the site's static host
 * cannot serve the ~26.5 MiB `ort-wasm-simd-threaded.jsep.wasm` (the default
 * Cloudflare Pages deployment caps a file at 25 MiB). Loading `ort.all.min.js`
 * without that file would 404 inside the worker's importScripts and kill the
 * whole worker, so the main thread only requests the webgpu bundle when the
 * probe says it is actually served. Hosts that CAN serve it (local preview,
 * larger static hosts) get a working WebGPU path; the rest show the option but
 * fall back to WASM with a clear message.
 */
export async function webGpuRuntimeHosted(): Promise<boolean> {
  try {
    const res = await fetch('/wasm/ort-wasm-simd-threaded.jsep.wasm', { method: 'HEAD', cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

export type ProviderChoice = 'webgpu' | 'wasm';

export const PROVIDER_LABELS: Record<ProviderChoice, string> = {
  webgpu: 'GPU (WebGPU)',
  wasm: 'CPU (WASM)',
};

export function isProviderChoice(v: unknown): v is ProviderChoice {
  return v === 'webgpu' || v === 'wasm';
}