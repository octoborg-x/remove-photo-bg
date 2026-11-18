import { describe, it, expect, afterEach } from 'vitest';
import { browserArgs, headlessMode, gpuRequested, readGpuAdapter, assertHardwareGpu } from './gpu-browser.mjs';

const CPU_ONLY = ['--disable-gpu', '--disable-webgpu'];
const GPU_FLAGS = [
  '--use-angle=vulkan',
  '--enable-features=Vulkan',
  '--disable-vulkan-surface',
  '--enable-unsafe-webgpu',
];

describe('gpuRequested', () => {
  it('is true only for RUN_GPU=1', () => {
    expect(gpuRequested({ RUN_GPU: '1' })).toBe(true);
    expect(gpuRequested({ RUN_GPU: '0' })).toBe(false);
    expect(gpuRequested({ RUN_GPU: 'true' })).toBe(false);
    expect(gpuRequested({})).toBe(false);
  });
});

describe('browserArgs', () => {
  it('CPU-only (default): disables GPU and WebGPU, no Vulkan flags', () => {
    const args = browserArgs({});
    expect(args).toContain('--no-sandbox');
    expect(args).toContain('--disable-dev-shm-usage');
    for (const f of CPU_ONLY) expect(args).toContain(f);
    for (const f of GPU_FLAGS) expect(args).not.toContain(f);
  });

  it('GPU run: drops the disable flags and adds the Vulkan/WebGPU flags', () => {
    const args = browserArgs({ RUN_GPU: '1' });
    for (const f of CPU_ONLY) expect(args).not.toContain(f);
    for (const f of GPU_FLAGS) expect(args).toContain(f);
  });

  it('appends harness-specific extras in both modes', () => {
    expect(browserArgs({}, ['--enable-precise-memory-info'])).toContain('--enable-precise-memory-info');
    expect(browserArgs({ RUN_GPU: '1' }, ['--enable-logging=stderr'])).toContain('--enable-logging=stderr');
  });
});

describe('headlessMode', () => {
  it('uses the WebGPU-capable new headless only for a GPU run', () => {
    expect(headlessMode({ RUN_GPU: '1' })).toBe(true);
    expect(headlessMode({})).toBe('shell');
  });
});

// readGpuAdapter/assertHardwareGpu run their callback through page.evaluate, so
// the fake page just executes the callback against a stubbed `navigator` — the
// same global the real browser provides.
const page = { evaluate: (fn) => Promise.resolve(fn()) };

function stubGpu(adapter) {
  globalThis.navigator = { gpu: { requestAdapter: () => Promise.resolve(adapter) } };
}

afterEach(() => {
  delete globalThis.navigator;
});

describe('readGpuAdapter', () => {
  it('reports no adapter when navigator.gpu is absent', async () => {
    globalThis.navigator = {};
    const r = await readGpuAdapter(page);
    expect(r).toMatchObject({ present: false, software: false });
  });

  it('reports no adapter when requestAdapter resolves null', async () => {
    stubGpu(null);
    const r = await readGpuAdapter(page);
    expect(r.present).toBe(false);
  });

  it('labels a hardware adapter from its info fields', async () => {
    stubGpu({ info: { vendor: 'nvidia', architecture: 'turing', device: 'Tesla T4' } });
    const r = await readGpuAdapter(page);
    expect(r).toMatchObject({ present: true, label: 'nvidia turing Tesla T4' });
  });
});

describe('assertHardwareGpu', () => {
  it('accepts a real hardware adapter (Tesla T4)', async () => {
    stubGpu({ info: { vendor: 'nvidia', architecture: 'turing', device: 'Tesla T4' } });
    await expect(assertHardwareGpu(page)).resolves.toEqual({ present: true, label: 'nvidia turing Tesla T4' });
  });

  it('rejects a SwiftShader software adapter with the driver-fix hint', async () => {
    stubGpu({ info: { vendor: 'google', device: 'SwiftShader Device' } });
    await expect(assertHardwareGpu(page)).rejects.toThrow(/software renderer[\s\S]*libnvidia-gl/);
  });

  it('rejects llvmpipe', async () => {
    stubGpu({ info: { description: 'llvmpipe (LLVM 15.0)' } });
    await expect(assertHardwareGpu(page)).rejects.toThrow(/software renderer/);
  });

  it('rejects the WebGPU fallback adapter', async () => {
    stubGpu({ info: { device: 'Fancy GPU' }, isFallbackAdapter: true });
    await expect(assertHardwareGpu(page)).rejects.toThrow(/software renderer/);
  });

  it('rejects a missing adapter', async () => {
    stubGpu(null);
    await expect(assertHardwareGpu(page)).rejects.toThrow(/no WebGPU adapter/);
  });
});
