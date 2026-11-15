// The upload view of the shared diagnostic report: same structure, but the
// fingerprint fields are gone and every string is scrubbed. This is what the
// quality-report form attaches when the user opts in.
import { describe, it, expect } from 'vitest';
import { buildDiagnosticReport, type DiagnosticReportInput } from './diagnostic-report';
import {
  sanitizeDiagnosticsForUpload,
  scrubDiagnosticText,
  diagnosticsByteSize,
} from './diagnostic-report-upload';
import { rawMaskStats } from './raw-mask-stats';

function report(overrides: Partial<DiagnosticReportInput> = {}) {
  return buildDiagnosticReport({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120',
    platform: 'Linux x86_64',
    hardwareConcurrency: 8,
    deviceMemoryGb: 8,
    crossOriginIsolated: true,
    webgpuAvailable: true,
    webgpuRuntimeBundle: true,
    webgpuSessionInitialized: true,
    inferenceRan: true,
    selectedProvider: 'webgpu',
    actualProvider: 'webgpu',
    fallbackReason: null,
    adapterDetected: true,
    adapterUsable: true,
    adapter: { vendor: 'apple', architecture: 'm2', device: 'Apple M2', description: 'Apple M2', features: ['shader-f16'] },
    model: { id: 'model_512_int8_fp16', filename: 'model_512_int8_fp16.onnx', revision: 'abc123', inputSize: 512, imageWidth: 1080, imageHeight: 1350 },
    inference: { downloadMs: 3200, sessionInitMs: 410, coldMs: 1200, warmMs: [900], averageMs: 1050, postprocessingMs: 260 },
    rawMask: rawMaskStats(new Float32Array([0, 0.5, 1]), 3, 1),
    postprocessing: { maskRecoveryTriggered: false, refinementEnabled: true, refinementSucceeded: true },
    errors: [],
    now: new Date('2026-11-14T00:00:00.000Z'),
    ...overrides,
  });
}

describe('sanitizeDiagnosticsForUpload', () => {
  it('keeps the shared structure but clears the browser fingerprint fields', () => {
    const out = sanitizeDiagnosticsForUpload(report());
    expect(out.schemaVersion).toBe('1.0');
    expect(out.gpu.device).toBe('Apple M2');
    expect(out.model.id).toBe('model_512_int8_fp16');
    // The near-unique fingerprint pair is removed.
    expect(out.browser.userAgent).toBe('');
    expect(out.browser.platform).toBeNull();
  });

  it('scrubs urls, paths, emails and ips from every string', () => {
    const out = sanitizeDiagnosticsForUpload(
      report({
        fallbackReason: 'failed at https://evil.example.com/x?t=1',
        errors: ['/home/user/secret/model.onnx', 'bob@example.com', '10.0.0.5'],
      }),
    );
    expect(out.runtime.fallbackReason).toBe('failed at [url]');
    expect(out.errors).toEqual(['[path]', '[email]', '[ip]']);
  });

  it('never carries image data or a filename', () => {
    const json = JSON.stringify(sanitizeDiagnosticsForUpload(report()));
    expect(json).not.toMatch(/base64|data:image|\.jpg|\.jpeg|\.webp/i);
  });

  it('stays small', () => {
    expect(diagnosticsByteSize(sanitizeDiagnosticsForUpload(report()))).toBeLessThan(8192);
  });
});

describe('scrubDiagnosticText', () => {
  it('leaves ordinary technical text untouched', () => {
    expect(scrubDiagnosticText('model_512_int8_fp16')).toBe('model_512_int8_fp16');
    expect(scrubDiagnosticText('wasm')).toBe('wasm');
  });
});
