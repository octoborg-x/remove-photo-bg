import { describe, it, expect } from 'vitest';
import { defaultModelId, resolveModelParam } from './model-manifest';
import type { ModelManifestEntry } from './types';

const entry = (over: Partial<ModelManifestEntry>): ModelManifestEntry => ({
  id: 'model_512_int8_fp16',
  file: 'models/model_512_int8_fp16.onnx',
  url: '/models/model_512_int8_fp16.onnx',
  size: 68491168,
  sha256: 'a'.repeat(64),
  label: 'int8+fp16',
  inputSize: 512,
  outputIsProbability: true,
  ...over,
});

const models: ModelManifestEntry[] = [
  entry({ id: 'model_512_int8_fp16', file: 'models/model_512_int8_fp16.onnx', default: true }),
  entry({ id: 'model_512_int0_fp16', file: 'models/model_512_int0_fp16.onnx' }),
  entry({ id: 'model_512_int0_fp32', file: 'models/model_512_int0_fp32.onnx' }),
];

describe('defaultModelId', () => {
  it('returns the entry flagged default', () => {
    expect(defaultModelId(models)).toBe('model_512_int8_fp16');
  });

  it('falls back to the first entry when none is flagged', () => {
    const noDefault = models.map(({ default: _d, ...m }) => m);
    expect(defaultModelId(noDefault)).toBe('model_512_int8_fp16');
  });

  it('returns undefined for an empty manifest', () => {
    expect(defaultModelId([])).toBeUndefined();
  });
});

describe('resolveModelParam', () => {
  it('returns null for a null/empty param', () => {
    expect(resolveModelParam(models, null)).toBeNull();
    expect(resolveModelParam(models, '')).toBeNull();
  });

  it('resolves by manifest id', () => {
    expect(resolveModelParam(models, 'model_512_int0_fp32')?.id).toBe('model_512_int0_fp32');
  });

  it('resolves by file leaf name', () => {
    expect(resolveModelParam(models, 'model_512_int0_fp16.onnx')?.id).toBe('model_512_int0_fp16');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveModelParam(models, '  model_512_int0_fp16  ')?.id).toBe('model_512_int0_fp16');
  });

  it('returns null for an unknown value', () => {
    expect(resolveModelParam(models, 'nope.onnx')).toBeNull();
  });
});
