// The copyable diagnostic report: schema, rendering, and the privacy guard that
// it never carries image data or personal/secret values.
import { describe, it, expect } from 'vitest';
import {
  buildDiagnosticReport,
  formatDiagnosticReport,
  DIAGNOSTIC_SCHEMA_VERSION,
  type DiagnosticReportInput,
} from './diagnostic-report';
import { rawMaskStats } from './raw-mask-stats';

function base(overrides: Partial<DiagnosticReportInput> = {}): DiagnosticReportInput {
  return {
    userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile',
    platform: 'Android',
    hardwareConcurrency: 8,
    deviceMemoryGb: 4,
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
    adapter: {
      vendor: 'arm',
      architecture: 'mali',
      device: 'Mali-G715',
      description: 'Mali-G715',
      features: ['shader-f16'],
      maxStorageBufferBindingSize: 134217728,
      maxBufferSize: 268435456,
    },
    model: {
      id: 'model_512_int8_fp16',
      filename: 'model_512_int8_fp16.onnx',
      revision: 'eaafaa10',
      inputSize: 512,
      imageWidth: 1080,
      imageHeight: 1350,
    },
    inference: {
      downloadMs: 3200,
      sessionInitMs: 410,
      coldMs: 1200,
      warmMs: [900],
      averageMs: 1050,
      postprocessingMs: 260,
    },
    rawMask: rawMaskStats(new Float32Array([0, 0.5, 1]), 3, 1),
    postprocessing: {
      maskRecoveryTriggered: false,
      refinementEnabled: true,
      refinementSucceeded: true,
    },
    errors: [],
    now: new Date('2026-11-14T00:00:00.000Z'),
    ...overrides,
  };
}

describe('buildDiagnosticReport', () => {
  it('stamps the schema version and the (injected) generation time', () => {
    const r = buildDiagnosticReport(base());
    expect(r.schemaVersion).toBe(DIAGNOSTIC_SCHEMA_VERSION);
    expect(r.generatedAt).toBe('2026-11-14T00:00:00.000Z');
  });

  it('derives shader-f16 support from the adapter feature list', () => {
    expect(buildDiagnosticReport(base()).gpu.shaderF16).toBe('yes');
    const noF16 = base({ adapter: { ...base().adapter, features: ['depth-clip-control'] } });
    expect(buildDiagnosticReport(noF16).gpu.shaderF16).toBe('no');
    const unknown = base({ adapter: null });
    expect(buildDiagnosticReport(unknown).gpu.shaderF16).toBe('unknown');
  });

  it('marks the actual executing provider and never claims GPU inference before a run', () => {
    const ran = buildDiagnosticReport(base());
    expect(ran.runtime.webgpuExecutedInference).toBe(true);
    expect(ran.runtime.wasmExecutedInference).toBe(false);

    // A report taken before any run must not claim EITHER provider executed it,
    // even though a WebGPU session exists.
    const beforeRun = buildDiagnosticReport(
      base({ inferenceRan: false, actualProvider: 'none', webgpuSessionInitialized: true }),
    );
    expect(beforeRun.runtime.webgpuSessionInitialized).toBe(true);
    expect(beforeRun.runtime.webgpuExecutedInference).toBe(false);
    expect(beforeRun.runtime.wasmExecutedInference).toBe(false);
    expect(beforeRun.runtime.actualProvider).toBe('none');
  });

  it('records a GPU→WASM fallback with its reason', () => {
    const r = buildDiagnosticReport(
      base({
        selectedProvider: 'webgpu',
        actualProvider: 'wasm',
        fallbackReason: 'webgpu: out of memory',
        webgpuSessionInitialized: false,
      }),
    );
    expect(r.runtime.actualProvider).toBe('wasm');
    expect(r.runtime.wasmExecutedInference).toBe(true);
    expect(r.runtime.webgpuExecutedInference).toBe(false);
    expect(r.runtime.fallbackReason).toBe('webgpu: out of memory');
  });

  it('normalises blank adapter fields to null', () => {
    const r = buildDiagnosticReport(
      base({ adapter: { vendor: '  ', architecture: '', device: null } }),
    );
    expect(r.gpu.vendor).toBeNull();
    expect(r.gpu.architecture).toBeNull();
    expect(r.gpu.device).toBeNull();
  });
});

describe('formatDiagnosticReport', () => {
  it('renders every section with real values', () => {
    const text = formatDiagnosticReport(buildDiagnosticReport(base()));
    for (const section of [
      'Environment',
      'GPU',
      'Runtime',
      'Model',
      'Inference',
      'RAW MASK STATISTICS',
      'Postprocessing',
    ]) {
      expect(text).toContain(section);
    }
    expect(text).toContain('Mali-G715');
    expect(text).toContain('shader-f16: yes');
    expect(text).toContain('model_512_int8_fp16.onnx');
    expect(text).toContain('1080x1350');
    expect(text).toContain('Download: 3200 ms');
    expect(text).toContain('Mean: 0.5000');
  });

  it('shows tail fractions as percentages in the raw-mask block', () => {
    const text = formatDiagnosticReport(buildDiagnosticReport(base()));
    // 1 of 3 elements is below 0.01 and 1 of 3 is above 0.99.
    expect(text).toContain('Below 0.01: 33.33%');
    expect(text).toContain('Above 0.99: 33.33%');
  });

  it('prints a self-diagnosing verdict: SUSPECT for a flat mask, ok for a bimodal one', () => {
    const flat = formatDiagnosticReport(
      buildDiagnosticReport(base({ rawMask: rawMaskStats(new Float32Array(512 * 512).fill(0.3), 512, 512) })),
    );
    expect(flat).toContain('Verdict: SUSPECT — not bimodal');

    const ok = formatDiagnosticReport(
      buildDiagnosticReport(base({ rawMask: rawMaskStats(new Float32Array(512 * 512).fill(1), 512, 512) })),
    );
    expect(ok).toContain('Verdict: ok (bimodal');

    const none = formatDiagnosticReport(buildDiagnosticReport(base({ rawMask: rawMaskStats(new Float32Array(0)) })));
    expect(none).toContain('Verdict: no mask measured');
  });

  it('reads "unknown" for missing data rather than inventing values', () => {
    const text = formatDiagnosticReport(
      buildDiagnosticReport(
        base({
          platform: null,
          hardwareConcurrency: null,
          deviceMemoryGb: null,
          adapter: null,
          model: {
            id: null,
            filename: null,
            revision: null,
            inputSize: null,
            imageWidth: null,
            imageHeight: null,
          },
          inference: {
            downloadMs: null,
            sessionInitMs: null,
            coldMs: null,
            warmMs: [],
            averageMs: null,
            postprocessingMs: null,
          },
        }),
      ),
    );
    expect(text).toContain('Platform: unknown');
    expect(text).toContain('Adapter: unknown');
    expect(text).toContain('Model ID: unknown');
    expect(text).toContain('Image dimensions: unknown');
    expect(text).toContain('Average inference: unknown');
  });

  it('lists processing errors, or "none" when there are none', () => {
    expect(formatDiagnosticReport(buildDiagnosticReport(base()))).toContain('Errors: none');
    const withErrors = formatDiagnosticReport(
      buildDiagnosticReport(base({ errors: ['Model download failed', 'GPU lost'] })),
    );
    expect(withErrors).toContain('Errors: Model download failed; GPU lost');
  });
});

describe('privacy guard — the report carries no image or personal data', () => {
  const text = formatDiagnosticReport(buildDiagnosticReport(base()));

  it('contains no image data URLs, base64 blobs, or filesystem paths', () => {
    expect(text).not.toMatch(/data:image/);
    expect(text).not.toMatch(/base64,/);
    expect(text).not.toMatch(/[A-Za-z]:\\\\|\/Users\/|\/home\//);
  });

  it('contains no secrets or credentials', () => {
    expect(text).not.toMatch(/token|secret|password|api[_-]?key/i);
  });

  it('records image DIMENSIONS but never a filename or pixel data', () => {
    // The source image is described by size only; no name, no bytes.
    expect(text).toContain('1080x1350');
    expect(text).not.toMatch(/\.jpe?g|\.png|\.webp/i);
  });
});
