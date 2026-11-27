// Shared Chromium launch profile + WebGPU preflight for the browser harnesses.
//
// The sandbox and CI have no GPU, so every harness launches CPU-only: `headless:
// 'shell'` (the old chrome-headless-shell, which has no WebGPU) plus
// `--disable-gpu`/`--disable-webgpu`. That is the right default there.
//
// On a host that really has a GPU (the Google Colab T4 recipe, README "WebGPU on
// a real GPU"), `RUN_GPU=1` switches to the flags Google's own guide requires —
// without them headless Chrome reports WebGPU as disabled or software-only:
//
//   --use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface
//   --enable-unsafe-webgpu
//
// and the new headless mode (`headless: true`), which is the one that supports
// WebGPU. See https://developer.chrome.com/blog/supercharge-web-ai-testing

/** True when the caller asked for the real-GPU path. */
export function gpuRequested(env = process.env) {
  return env.RUN_GPU === '1';
}

/**
 * The Chromium launch arguments for this run. Non-GPU runs get the historical
 * CPU-only set; GPU runs get the Vulkan/WebGPU flags instead of the disable
 * flags. `extra` is appended verbatim (harness-specific flags).
 */
export function browserArgs(env = process.env, extra = []) {
  const base = ['--no-sandbox', '--disable-dev-shm-usage', ...extra];
  if (!gpuRequested(env)) return [...base, '--disable-gpu', '--disable-webgpu'];
  return [
    ...base,
    '--use-angle=vulkan',
    '--enable-features=Vulkan',
    '--disable-vulkan-surface',
    '--enable-unsafe-webgpu',
  ];
}

/**
 * The Puppeteer `headless` value. `'shell'` is resize-able but has no WebGPU, so
 * a GPU run must use the new headless mode (`true`), which does.
 */
export function headlessMode(env = process.env) {
  return gpuRequested(env) ? true : 'shell';
}

// Software-renderer tells. Kept in sync with src/features/background-removal/
// provider-gate.ts: a "fake GPU" (SwiftShader/llvmpipe) reports a real-looking
// vendor, so the device/description is the reliable signal.
const SOFTWARE_HINTS = ['llvmpipe', 'swiftshader', 'software', 'basic render', 'microsoft basic'];

/**
 * Reads the browser's WebGPU adapter state from a page. Never throws: a page
 * without WebGPU returns `{ present: false }`. Used to fail a GPU run loudly
 * when the browser only exposes a software renderer — otherwise a "green" run
 * would be measuring SwiftShader, not the GPU.
 *
 * @returns {Promise<{ present: boolean; fallback: boolean; software: boolean; label: string }>}
 */
export async function readGpuAdapter(page) {
  try {
    return await page.evaluate(() => {
      const gpu = navigator.gpu;
      if (!gpu || typeof gpu.requestAdapter !== 'function') {
        return { present: false, fallback: false, software: false, label: 'WebGPU unavailable' };
      }
      return gpu.requestAdapter().then((adapter) => {
        if (!adapter) {
          return { present: false, fallback: false, software: false, label: 'no adapter' };
        }
        const info = adapter.info ?? {};
        const label =
          [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ') ||
          'unknown adapter';
        return { present: true, fallback: adapter.isFallbackAdapter === true, software: false, label };
      });
    });
  } catch {
    return { present: false, fallback: false, software: false, label: 'adapter probe failed' };
  }
}

/**
 * Verifies that the page's WebGPU adapter is real hardware, not a software
 * renderer. Throws with the driver-fix hint when it is not, so a GPU run can
 * never silently pass on SwiftShader.
 *
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<{ present: boolean; label: string }>}
 */
export async function assertHardwareGpu(page) {
  const a = await readGpuAdapter(page);
  const haystack = a.label.toLowerCase();
  const software = a.software || a.fallback || SOFTWARE_HINTS.some((h) => haystack.includes(h));
  if (!a.present) {
    throw new Error(
      `RUN_GPU=1 but the browser exposed no WebGPU adapter (${a.label}). ` +
        'Check the launch flags and that the GPU is passed through to the container.',
    );
  }
  if (software) {
    throw new Error(
      `RUN_GPU=1 but the WebGPU adapter is a software renderer (${a.label}). ` +
        'Install the matching NVIDIA driver so Vulkan sees the real GPU, e.g. ' +
        '`apt-get install -y vulkan-tools libnvidia-gl-525` then `nvidia-smi && vulkaninfo --summary` ' +
        '(it must name the GPU, not SwiftShader). See README "WebGPU on a real GPU".',
    );
  }
  return { present: true, label: a.label };
}
