// Technical diagnostics for the quality-report form. The structure is built from
// non-identifying application facts only, and every string is scrubbed before it
// can leave the page. It deliberately excludes filenames, EXIF, image pixels,
// image URLs, storage contents, tokens, cookies, IP addresses, and filesystem
// paths. Diagnostics are attached to a report only when the user explicitly
// opts in, and the exact payload is shown before submission.

/** Raw facts the caller can supply; all optional except the version. */
export interface DiagnosticsInput {
  app_version: string;
  model_id?: string;
  processing_provider?: string;
  gpu_adapter?: string;
  webgpu_available?: boolean;
  cross_origin_isolated?: boolean;
  last_inference_ms?: number;
  last_processing_percent_opaque?: number;
}

export interface DiagnosticReport {
  app_version: string;
  model_id?: string;
  processing_provider?: string;
  gpu_adapter?: string;
  webgpu_available?: boolean;
  cross_origin_isolated?: boolean;
  last_inference_ms?: number;
  last_processing_percent_opaque?: number;
  generated_at: string;
}

// Anything matching these is removed from a diagnostic string: absolute paths,
// home directories, URLs (which can carry tokens/query params), and email-like
// or IP-like tokens. The pattern is intentionally broad; over-scrubbing a
// diagnostic is harmless, leaking an identifier is not.
const SCRUB_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // URLs of any scheme (http, https, blob, data, file)
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`)\]}]+/gi, '[url]'],
  // Windows drive paths and UNC paths
  [/\b[a-z]:\\(?:[^\\\s]+\\?)+/gi, '[path]'],
  // POSIX absolute paths (two or more segments)
  [/(?:\/[\w.@+-]+){2,}/g, '[path]'],
  // email addresses
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]'],
  // IPv4 addresses
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]'],
];

/** Remove anything that could carry an identifier from a diagnostic string. */
export function scrubDiagnosticText(value: string): string {
  let out = value;
  for (const [re, replacement] of SCRUB_PATTERNS) out = out.replace(re, replacement);
  return out;
}

function cleanOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const scrubbed = scrubDiagnosticText(value).slice(0, 200).trim();
  return scrubbed.length ? scrubbed : undefined;
}

/**
 * Build the diagnostic report that would be submitted. Deterministic apart from
 * `generated_at`, so the same facts produce the same payload. `now` is injected
 * for tests.
 */
export function buildDiagnostics(input: DiagnosticsInput, now: Date = new Date()): DiagnosticReport {
  const report: DiagnosticReport = {
    app_version: scrubDiagnosticText(input.app_version).slice(0, 64),
    generated_at: now.toISOString(),
  };
  const modelId = cleanOptional(input.model_id);
  if (modelId) report.model_id = modelId;
  const provider = cleanOptional(input.processing_provider);
  if (provider) report.processing_provider = provider;
  const adapter = cleanOptional(input.gpu_adapter);
  if (adapter) report.gpu_adapter = adapter;
  if (typeof input.webgpu_available === 'boolean') report.webgpu_available = input.webgpu_available;
  if (typeof input.cross_origin_isolated === 'boolean') {
    report.cross_origin_isolated = input.cross_origin_isolated;
  }
  if (typeof input.last_inference_ms === 'number' && Number.isFinite(input.last_inference_ms)) {
    report.last_inference_ms = Math.round(input.last_inference_ms);
  }
  if (
    typeof input.last_processing_percent_opaque === 'number' &&
    Number.isFinite(input.last_processing_percent_opaque)
  ) {
    report.last_processing_percent_opaque = Math.round(input.last_processing_percent_opaque * 10) / 10;
  }
  return report;
}

/** Human-readable rendering of the exact payload, shown in the form preview. */
export function formatDiagnostics(report: DiagnosticReport): string {
  return JSON.stringify(report, null, 2);
}

/** Byte size of the diagnostics as submitted, for a size guard. */
export function diagnosticsByteSize(report: DiagnosticReport): number {
  return new TextEncoder().encode(JSON.stringify(report)).length;
}
