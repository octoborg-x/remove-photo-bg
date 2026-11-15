// Quality-report submission. Validation is done client-side first so an obvious
// mistake is caught before the network round trip, but the Worker re-validates
// everything — the browser is never trusted. No personal data is collected: the
// only fields are a category, an optional description, application facts, and an
// optional, explicitly-approved diagnostics payload.

import { REPORT_DESCRIPTION_MAX, isReportCategory, type ReportCategory } from './report-categories';
// The quality report reuses the SAME diagnostic structure as the Console's
// "Copy report" button (src/features/diagnostics/diagnostic-report.ts). There is
// one structure and one builder; the analytics form only chooses whether to
// attach it.
import type { DiagnosticReport } from '../diagnostics/diagnostic-report';

export interface QualityReportInput {
  category: ReportCategory;
  description?: string;
  app_version: string;
  model_id?: string;
  diagnostics?: DiagnosticReport;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/** Trim and bound a description to the maximum length. */
export function normalizeDescription(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  const trimmed = description.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, REPORT_DESCRIPTION_MAX);
}

export function validateReport(input: QualityReportInput): ValidationResult {
  if (!isReportCategory(input.category)) return { ok: false, error: 'Choose a problem category.' };
  const desc = input.description ?? '';
  if (desc.length > REPORT_DESCRIPTION_MAX) {
    return { ok: false, error: `Keep the description under ${REPORT_DESCRIPTION_MAX} characters.` };
  }
  if (!input.app_version || input.app_version.length > 64) {
    return { ok: false, error: 'Missing application version.' };
  }
  return { ok: true };
}

/** The exact JSON body that will be POSTed, so the UI can preview it. */
export function reportBody(input: QualityReportInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    category: input.category,
    app_version: input.app_version,
  };
  const description = normalizeDescription(input.description);
  if (description) body.description = description;
  if (input.model_id) body.model_id = input.model_id;
  if (input.diagnostics) body.diagnostics = input.diagnostics;
  return body;
}

/**
 * Submit a report. Returns true only on a 2xx response. Any failure (validation,
 * network, server) resolves false; the caller decides how to tell the user. The
 * user's own report is never blocked by analytics consent — it is an explicit
 * action with its own consent checkbox for diagnostics.
 */
export async function submitReport(
  endpoint: string,
  input: QualityReportInput,
): Promise<boolean> {
  const check = validateReport(input);
  if (!check.ok) return false;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      // A CORS "simple request" (no preflight): the Worker reads the JSON body
      // regardless of this content type.
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(reportBody(input)),
    });
    return res.ok;
  } catch {
    return false;
  }
}
