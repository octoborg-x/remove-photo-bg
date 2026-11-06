import { describe, it, expect } from 'vitest';
import { assetUrl, ASSET_BASE, isUrlCached } from './asset-cache';

// VITE_ASSET_BASE is unset in the unit-test run, so the origin serves assets
// itself and ASSET_BASE must be the empty string (never '/', which would be
// truthy and make the service worker treat local assets as remote).
describe('ASSET_BASE', () => {
  it('is empty when no asset origin is configured', () => {
    expect(ASSET_BASE).toBe('');
  });
});

describe('assetUrl', () => {
  it('serves a same-origin absolute path when no base is set', () => {
    expect(assetUrl('models/model_512_int8_fp16.onnx')).toBe('/models/model_512_int8_fp16.onnx');
  });

  it('strips a leading slash from the path', () => {
    expect(assetUrl('/models/x.onnx')).toBe('/models/x.onnx');
    expect(assetUrl('//models/x.onnx')).toBe('/models/x.onnx');
  });
});

// `caches` is a browser global; the Node unit run has none, so isUrlCached must
// resolve false rather than throw.
describe('isUrlCached', () => {
  it('returns false when the Cache API is unavailable', async () => {
    expect(await isUrlCached('/models/model_512_int8_fp16.onnx')).toBe(false);
  });
});
