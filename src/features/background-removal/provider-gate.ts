// Provider availability gate shared by the UI (main.ts) and used at runtime.
// WebGPU is offered whenever the browser actually exposes it AND returns an
// adapter from requestAdapter. There is no allowlist/gate list: the WASM
// fallback at session-creation and run time is the safety mechanism, and it is
// kept. An adapter that fails to build/run the session degrades to CPU with a
// clear on-screen message rather than hanging.

interface GpuAdapterInfo {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

interface GpuAdapter {
  info?: GpuAdapterInfo;
}

interface NavigatorWithGpu extends Navigator {
  gpu?: { requestAdapter?: () => Promise<GpuAdapter | null> };
}

export type WebGpuDetect =
  | { available: true; adapter?: string; reason: string }
  | { available: false; adapter?: undefined; reason: string };

/**
 * Detects WebGPU availability. Never throws: any failure to enumerate the
 * adapter means "not available", and the app falls back to CPU (WASM).
 *
 * `reason` is a short phrase for the log/log-line, e.g. "WebGPU unavailable in
 * this browser" or "GPU ready (…)".
 */
export async function detectWebGpu(): Promise<WebGpuDetect> {
  const nav = navigator as NavigatorWithGpu;
  if (typeof navigator === 'undefined' || !('gpu' in nav) || !nav.gpu?.requestAdapter) {
    return { available: false, reason: 'WebGPU is not available in this browser' };
  }
  try {
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) {
      return { available: false, reason: 'WebGPU is enabled but no adapter was found' };
    }
    const info = adapter.info ?? {};
    const label = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ') || 'unknown adapter';
    return {
      available: true,
      adapter: label,
      reason: `WebGPU available (${label})`,
    };
  } catch {
    return { available: false, reason: 'WebGPU adapter detection failed' };
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