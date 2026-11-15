// Upload sanitizer for the shared diagnostic report.
//
// The Console's "Copy report" button uses the full report from
// ./diagnostic-report.ts, which is LOCAL-ONLY (copied to the clipboard, never
// sent). The quality-report form can attach the SAME structure to a server
// request, so this module produces the upload-safe view of it: same shape, but
// the fingerprint-adjacent fields are removed and free text is scrubbed.
//
// Removed before upload:
//   - browser.userAgent  (a near-unique fingerprint)
//   - browser.platform
// Scrubbed in every remaining string: urls, absolute paths, emails, ipv4.
// The structure itself still has no field for an image, its pixels, its
// filename, EXIF, cookies, tokens, storage, or a filesystem path.

import type { DiagnosticReport } from './diagnostic-report';

// Broad on purpose: over-scrubbing a diagnostic is harmless, leaking an
// identifier is not.
const SCRUB_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`)\]}]+/gi, '[url]'],
  [/\b[a-z]:\\(?:[^\\\s]+\\?)+/gi, '[path]'],
  [/(?:\/[\w.@+-]+){2,}/g, '[path]'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]'],
];

export function scrubDiagnosticText(value: string): string {
  let out = value;
  for (const [re, replacement] of SCRUB_PATTERNS) out = out.replace(re, replacement);
  return out;
}

function scrubOrNull(value: string | null): string | null {
  return value === null ? null : scrubDiagnosticText(value);
}

/**
 * Return the upload-safe view of a diagnostic report: identical structure, with
 * the browser fingerprint fields cleared and all strings scrubbed. Pure; the
 * caller decides whether to attach the result.
 */
export function sanitizeDiagnosticsForUpload(report: DiagnosticReport): DiagnosticReport {
  return {
    ...report,
    browser: {
      // Deliberately emptied: a UA/platform pair is a weak fingerprint and is
      // not needed to diagnose a quality problem.
      userAgent: '',
      platform: null,
    },
    gpu: {
      ...report.gpu,
      vendor: scrubOrNull(report.gpu.vendor),
      architecture: scrubOrNull(report.gpu.architecture),
      device: scrubOrNull(report.gpu.device),
      description: scrubOrNull(report.gpu.description),
    },
    model: {
      ...report.model,
      // The model filename is a public artifact name, not a user filename, but
      // scrub it anyway so nothing path-like can slip through.
      filename: scrubOrNull(report.model.filename),
      revision: scrubOrNull(report.model.revision),
    },
    runtime: {
      ...report.runtime,
      fallbackReason: scrubOrNull(report.runtime.fallbackReason),
    },
    errors: report.errors.map(scrubDiagnosticText),
  };
}

/** Byte size of the sanitized report as it will be sent, for a size guard. */
export function diagnosticsByteSize(report: DiagnosticReport): number {
  return new TextEncoder().encode(JSON.stringify(report)).length;
}
