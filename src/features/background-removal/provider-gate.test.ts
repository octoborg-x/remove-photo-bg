import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectWebGpu, isProviderChoice, PROVIDER_LABELS } from './provider-gate';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    expect(r.reason).toMatch(/not available/i);
  });

  it('reports unavailable when requestAdapter returns null', async () => {
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => null } });
    const r = await detectWebGpu();
    expect(r.available).toBe(false);
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
    expect(r.adapter).toContain('apple');
    expect(r.adapter).toContain('m1');
  });

  it('never throws when adapter enumeration rejects', async () => {
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter: async () => { throw new Error('boom'); } },
    });
    const r = await detectWebGpu();
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/failed/i);
  });
});
