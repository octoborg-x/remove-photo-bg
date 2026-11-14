import { describe, it, expect } from 'vitest';
import { buildDiagnostics, diagnosticsByteSize, formatDiagnostics, scrubDiagnosticText } from './diagnostics';

describe('scrubDiagnosticText', () => {
  it('removes urls, paths, emails and ip addresses', () => {
    expect(scrubDiagnosticText('https://evil.example.com/track?token=abc')).toBe('[url]');
    expect(scrubDiagnosticText('/home/user/private/model.onnx')).toBe('[path]');
    expect(scrubDiagnosticText('C:\\Users\\bob\\photo.jpg')).toBe('[path]');
    expect(scrubDiagnosticText('bob@example.com')).toBe('[email]');
    expect(scrubDiagnosticText('192.168.1.10')).toBe('[ip]');
  });

  it('leaves ordinary technical text untouched', () => {
    expect(scrubDiagnosticText('model_512_int8_fp16')).toBe('model_512_int8_fp16');
    expect(scrubDiagnosticText('webgpu')).toBe('webgpu');
  });
});

describe('buildDiagnostics', () => {
  it('collects only non-identifying application facts', () => {
    const report = buildDiagnostics(
      {
        app_version: '20260101T000000',
        model_id: 'model_512_int8_fp16',
        processing_provider: 'webgpu',
        gpu_adapter: 'Apple M2',
        webgpu_available: true,
        cross_origin_isolated: true,
        last_inference_ms: 812.4,
      },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(report).toEqual({
      app_version: '20260101T000000',
      model_id: 'model_512_int8_fp16',
      processing_provider: 'webgpu',
      gpu_adapter: 'Apple M2',
      webgpu_available: true,
      cross_origin_isolated: true,
      last_inference_ms: 812,
      generated_at: '2026-01-01T00:00:00.000Z',
    });
    // No filename, url, or image field exists in the structure at all.
    const json = formatDiagnostics(report);
    expect(json).not.toMatch(/filename|image|url|exif/i);
  });

  it('scrubs a poisoned optional value rather than passing it through', () => {
    const report = buildDiagnostics({
      app_version: 'x',
      model_id: 'https://evil.example.com/model.onnx?t=secret',
    });
    expect(report.model_id).toBe('[url]');
  });

  it('stays small', () => {
    const report = buildDiagnostics({ app_version: 'x', model_id: 'model_512_int8_fp16' });
    expect(diagnosticsByteSize(report)).toBeLessThan(1024);
  });
});
