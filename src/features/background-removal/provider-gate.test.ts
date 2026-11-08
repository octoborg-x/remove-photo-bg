import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyGpuAdapter, detectWebGpu, isProviderChoice, PROVIDER_LABELS } from './provider-gate';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A modern hardware adapter: real device name, shader-f16, large binding limit.
const goodAdapter = () => ({
  info: { vendor: 'apple', architecture: 'm2', device: 'Apple M2', description: '' },
  features: ['shader-f16', 'depth-clip-control'],
  limits: { maxStorageBufferBindingSize: 2 * 1024 * 1024 * 1024 },
});

describe('classifyGpuAdapter', () => {
  it('accepts a modern hardware adapter with shader-f16', () => {
    expect(classifyGpuAdapter(goodAdapter()).usable).toBe(true);
  });

  it('rejects a software renderer (llvmpipe) even with a real-looking vendor', () => {
    const r = classifyGpuAdapter({
      info: { vendor: 'Google Inc.', architecture: 'Mesa', device: 'llvmpipe', description: 'llvmpipe (LLVM 15)' },
      features: ['shader-f16'],
    });
    expect(r.usable).toBe(false);
    expect(r.reason).toMatch(/software/i);
  });

  it('rejects SwiftShader', () => {
    expect(classifyGpuAdapter({ info: { vendor: 'google', device: 'SwiftShader Device' } }).usable).toBe(false);
  });

  it('rejects a known-slow measured adapter (Adreno-6xx)', () => {
    const r = classifyGpuAdapter({
      info: { vendor: 'qualcomm', architecture: 'adreno-6xx', device: 'Qualcomm Adreno 640' },
      features: ['shader-f16'],
      limits: { maxStorageBufferBindingSize: 2 * 1024 * 1024 * 1024 },
    });
    expect(r.usable).toBe(false);
    expect(r.reason).toMatch(/slower|incorrect/i);
  });

  it('rejects an adapter that lacks shader-f16', () => {
    const r = classifyGpuAdapter({
      info: { vendor: 'intel', architecture: 'gen-12', device: 'Intel Iris Xe' },
      features: ['depth-clip-control'],
    });
    expect(r.usable).toBe(false);
    expect(r.reason).toMatch(/shader-f16/);
  });

  it('rejects an adapter with a tiny storage binding limit', () => {
    const r = classifyGpuAdapter({
      info: { vendor: 'nvidia', device: 'NVIDIA GeForce GTX 1050' },
      features: ['shader-f16'],
      limits: { maxStorageBufferBindingSize: 256 * 1024 * 1024 },
    });
    expect(r.usable).toBe(false);
    expect(r.reason).toMatch(/storage buffers/i);
  });

  it('rejects a null adapter', () => {
    expect(classifyGpuAdapter(null).usable).toBe(false);
  });

  it('accepts a modern adapter when capability fields are missing', () => {
    // Browsers that do not expose `features`/`limits` yet must not be rejected.
    expect(classifyGpuAdapter({ info: { vendor: 'apple', architecture: 'm1', device: '' } }).usable).toBe(true);
  });
});

describe('isProviderChoice', () => {
  it('accepts only the two known providers', () => {
    expect(isProviderChoice('webgpu')).toBe(true);
    expect(isProviderChoice('wasm')).toBe(true);
    for (const bad of ['gpu', '', null, undefined, 0, {}]) {
      expect(isProviderChoice(bad)).toBe(false);
    }
  });

  it('has a label for every choice', () => {
    expect(PROVIDER_LABELS.webgpu).toBeTruthy();
    expect(PROVIDER_LABELS.wasm).toBeTruthy();
  });
});

describe('detectWebGpu', () => {
  it('reports unavailable when navigator.gpu is absent', async () => {
    vi.stubGlobal('navigator', {});
    const r = await detectWebGpu();
    expect(r.available).toBe(false);
    expect(r.adapterPresent).toBe(false);
    expect(r.reason).toMatch(/not available/i);
  });

  it('reports unavailable when requestAdapter returns null', async () => {
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => null } });
    const r = await detectWebGpu();
    expect(r.available).toBe(false);
    expect(r.adapterPresent).toBe(false);
    expect(r.reason).toMatch(/no adapter/i);
  });

  it('reports available and names the adapter', async () => {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => ({
          info: { vendor: 'apple', architecture: 'm1', device: '', description: '' },
        }),
      },
    });
    const r = await detectWebGpu();
    expect(r.available).toBe(true);
    expect(r.adapterPresent).toBe(true);
    expect(r.adapter).toContain('apple');
    expect(r.adapter).toContain('m1');
  });

  it('keeps the GPU selectable (adapterPresent) when a slow adapter is not the default', async () => {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => ({
          info: { vendor: 'qualcomm', architecture: 'adreno-6xx', device: 'Qualcomm Adreno 640' },
          features: ['shader-f16'],
          limits: { maxStorageBufferBindingSize: 2 * 1024 * 1024 * 1024 },
        }),
      },
    });
    const r = await detectWebGpu();
    expect(r.available).toBe(false);
    expect(r.adapterPresent).toBe(true);
    expect(r.reason).toMatch(/slower|incorrect/i);
  });

  it('never throws when adapter enumeration rejects', async () => {
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter: async () => { throw new Error('boom'); } },
    });
    const r = await detectWebGpu();
    expect(r.available).toBe(false);
    expect(r.adapterPresent).toBe(false);
    expect(r.reason).toMatch(/failed/i);
  });
});
