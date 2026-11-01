// Provider availability gate shared by the UI (main.ts) and used at runtime.
// WebGPU is only *offered* when the browser actually exposes it AND the
// adapter string passes the project's validated-provider gate
// (VALIDATED_WEBGPU_SUBSTRINGS). An unvalidated GPU can silently produce a
// wrong mask (BiRefNet on onnxruntime-web is precision/layout sensitive; the
// Adreno-6xx defect returned a coherent-but-wrong alpha with no error), so the
// CPU fallback would never fire. Keep the list empty until an adapter is
// verified end-to-end (correct mask + acceptable latency); re-check
// HARDWARE_TESTING.md before adding entries.
//
// The DOM lib does not include `navigator.gpu`, and the WebGPU lib is only
// pulled in when tsconfig lib adds it; the runtime object is duck-typed here so
// the gate degrades to "no GPU" on any browser that fails to expose it.

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

export const VALIDATED_WEBGPU_SUBSTRINGS: string[] = [
  // e.g. 'radeon 780m', 'apple m2', 'intel iris xe — validated <date>'
];

export type WebGpuDetect =
  | { available: true; validated: boolean; adapter?: string; reason: string }
  | { available: false; validated: false; adapter?: undefined; reason: string };

/**
 * Detects WebGPU and returns whether the discovered adapter is validated.
 * Never throws: any failure to enumerate the adapter means "not available".
 *
 * `reason` is a short phrase for the log/log-line, e.g. "WebGPU unavailable in
 * this browser" or "GPU detected but not yet validated for this model".
 */
export async function detectWebGpu(): Promise<WebGpuDetect> {
  const nav = navigator as NavigatorWithGpu;
  if (typeof navigator === 'undefined' || !('gpu' in nav) || !nav.gpu?.requestAdapter) {
    return { available: false, validated: false, reason: 'WebGPU is not available in this browser' };
  }
  try {
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) {
      return { available: false, validated: false, reason: 'WebGPU is enabled but no adapter was found' };
    }
    const info = adapter.info ?? {};
    const blob = [info.device, info.architecture, info.vendor, info.description]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const validated = VALIDATED_WEBGPU_SUBSTRINGS.some((s) => blob.includes(s));
    const label = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ') || 'unknown adapter';
    return {
      available: true,
      validated,
      adapter: label,
      reason: validated
        ? `WebGPU validated on ${label}`
        : `GPU detected (${label}) but not yet validated for this model — using CPU`,
    };
  } catch {
    return { available: false, validated: false, reason: 'WebGPU adapter detection failed' };
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