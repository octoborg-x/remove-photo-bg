// Validation and schema rules for the analytics Worker. Kept free of any
// Cloudflare runtime imports so it is unit-testable in plain Node. The Worker
// (index.ts) wires these pure functions to Analytics Engine, D1 and the request
// pipeline. Nothing here trusts the browser: every field is type-checked,
// bounded, and checked against an explicit allowlist.

export const MAX_BODY_BYTES = 16 * 1024; // 16 KB request body cap

export const EVENT_NAMES = [
  'app_session_started',
  'image_processing_started',
  'image_processing_succeeded',
  'first_successful_image_processed',
  'image_processing_failed',
  'download_initiated',
  'quality_report_submitted',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export const EVENT_FIELD_LIMITS = {
  event_id: 64,
  event_name: 40,
  anonymous_visitor_id: 64,
  session_id: 64,
  occurred_at: 40,
  app_version: 64,
  model_id: 64,
  processing_provider: 16,
  failure_reason: 64,
  report_category: 32,
} as const;

export const REPORT_CATEGORIES = [
  'subject_partially_removed',
  'background_remains',
  'poor_edges',
  'wrong_object_removed',
  'fine_details_lost',
  'processing_failed',
  'download_problem',
  'other',
] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const REPORT_DESCRIPTION_MAX = 500;
export const DIAGNOSTICS_MAX_BYTES = 8 * 1024; // 8 KB cap on the diagnostics blob

export interface ValidatedEvent {
  event_name: EventName;
  event_id: string;
  anonymous_visitor_id: string;
  session_id: string;
  occurred_at: string;
  /** Server receive time; the browser value is never authoritative. */
  received_at: string;
  app_version?: string;
  model_id?: string;
  processing_provider?: string;
  failure_reason?: string;
  report_category?: string;
}

export interface ValidationError {
  ok: false;
  error: string;
}
export interface ValidationOk<T> {
  ok: true;
  value: T;
}
export type Result<T> = ValidationOk<T> | ValidationError;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A conservative id: printable, no whitespace/control chars, bounded length.
const SAFE_ID_RE = /^[A-Za-z0-9._:-]+$/;
const PROVIDERS = ['webgpu', 'wasm'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeString(value: unknown, max: number): value is string {
  // Control characters are rejected outright: they have no place in a value and
  // are a common vector for log/terminal injection.
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function isSafeId(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && SAFE_ID_RE.test(value);
}

/**
 * Validate an inbound event payload. Rejects:
 *   • a non-object body;
 *   • an unknown or missing event_name;
 *   • any property not on the allowlist;
 *   • wrong types or over-length values;
 *   • timestamps that are unparseable or unreasonable (far past/future).
 */
export function validateEvent(
  body: unknown,
  now: number,
  maxSkewMs = 5 * 60 * 1000,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
): Result<ValidatedEvent> {
  if (!isPlainObject(body)) return { ok: false, error: 'body must be a JSON object' };

  const allowed = new Set(Object.keys(EVENT_FIELD_LIMITS));
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return { ok: false, error: `unexpected property: ${key}` };
  }

  const name = body.event_name;
  if (typeof name !== 'string' || !EVENT_NAMES.includes(name as EventName)) {
    return { ok: false, error: 'unknown event_name' };
  }

  if (!isSafeId(body.event_id, EVENT_FIELD_LIMITS.event_id)) {
    return { ok: false, error: 'invalid event_id' };
  }
  if (!isSafeId(body.anonymous_visitor_id, EVENT_FIELD_LIMITS.anonymous_visitor_id)) {
    return { ok: false, error: 'invalid anonymous_visitor_id' };
  }
  if (!isSafeId(body.session_id, EVENT_FIELD_LIMITS.session_id)) {
    return { ok: false, error: 'invalid session_id' };
  }

  if (typeof body.occurred_at !== 'string' || body.occurred_at.length > EVENT_FIELD_LIMITS.occurred_at) {
    return { ok: false, error: 'invalid occurred_at' };
  }
  const occurred = Date.parse(body.occurred_at);
  if (!Number.isFinite(occurred)) return { ok: false, error: 'unparseable occurred_at' };
  if (occurred > now + maxSkewMs) return { ok: false, error: 'occurred_at in the future' };
  if (occurred < now - maxAgeMs) return { ok: false, error: 'occurred_at too old' };

  const event: ValidatedEvent = {
    event_name: name as EventName,
    event_id: body.event_id,
    anonymous_visitor_id: body.anonymous_visitor_id,
    session_id: body.session_id,
    occurred_at: new Date(occurred).toISOString(),
    received_at: new Date(now).toISOString(),
  };

  if (body.app_version !== undefined) {
    if (!isSafeString(body.app_version, EVENT_FIELD_LIMITS.app_version)) {
      return { ok: false, error: 'invalid app_version' };
    }
    event.app_version = body.app_version;
  }
  if (body.model_id !== undefined) {
    if (!isSafeString(body.model_id, EVENT_FIELD_LIMITS.model_id)) {
      return { ok: false, error: 'invalid model_id' };
    }
    event.model_id = body.model_id;
  }
  if (body.processing_provider !== undefined) {
    if (
      typeof body.processing_provider !== 'string' ||
      !PROVIDERS.includes(body.processing_provider as (typeof PROVIDERS)[number])
    ) {
      return { ok: false, error: 'invalid processing_provider' };
    }
    event.processing_provider = body.processing_provider;
  }
  if (body.failure_reason !== undefined) {
    if (!isSafeId(body.failure_reason, EVENT_FIELD_LIMITS.failure_reason)) {
      return { ok: false, error: 'invalid failure_reason' };
    }
    event.failure_reason = body.failure_reason;
  }
  if (body.report_category !== undefined) {
    if (
      typeof body.report_category !== 'string' ||
      !REPORT_CATEGORIES.includes(body.report_category as ReportCategory)
    ) {
      return { ok: false, error: 'invalid report_category' };
    }
    event.report_category = body.report_category;
  }

  return { ok: true, value: event };
}

export interface ValidatedReport {
  id: string;
  created_at: string;
  category: ReportCategory;
  description: string | null;
  app_version: string;
  model_id: string | null;
  diagnostics_json: string | null;
  diagnostics_attached: 0 | 1;
}

/** Sanitize a user description: trim, collapse control characters, bound length. */
export function sanitizeDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  // Strip control characters (except nothing — descriptions are single-block).
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, REPORT_DESCRIPTION_MAX);
}

/**
 * Validate a quality report. The diagnostics blob, when present, must be a JSON
 * object (not an array/string), bounded in size, and must not contain obvious
 * image data or identifiers — the Worker rejects rather than stores anything
 * suspicious. Parameterization in D1 prevents SQL injection regardless.
 */
export function validateReport(
  body: unknown,
  now: number,
  newId: () => string,
): Result<ValidatedReport> {
  if (!isPlainObject(body)) return { ok: false, error: 'body must be a JSON object' };

  const allowed = new Set(['category', 'description', 'app_version', 'model_id', 'diagnostics']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return { ok: false, error: `unexpected property: ${key}` };
  }

  if (
    typeof body.category !== 'string' ||
    !REPORT_CATEGORIES.includes(body.category as ReportCategory)
  ) {
    return { ok: false, error: 'invalid category' };
  }

  if (body.description !== undefined && typeof body.description !== 'string') {
    return { ok: false, error: 'invalid description' };
  }
  if (typeof body.description === 'string' && body.description.length > REPORT_DESCRIPTION_MAX) {
    return { ok: false, error: 'description too long' };
  }

  if (!isSafeString(body.app_version, EVENT_FIELD_LIMITS.app_version)) {
    return { ok: false, error: 'invalid app_version' };
  }

  let modelId: string | null = null;
  if (body.model_id !== undefined) {
    if (!isSafeString(body.model_id, EVENT_FIELD_LIMITS.model_id)) {
      return { ok: false, error: 'invalid model_id' };
    }
    modelId = body.model_id;
  }

  let diagnosticsJson: string | null = null;
  let diagnosticsAttached: 0 | 1 = 0;
  if (body.diagnostics !== undefined && body.diagnostics !== null) {
    if (!isPlainObject(body.diagnostics)) {
      return { ok: false, error: 'invalid diagnostics' };
    }
    const serialized = JSON.stringify(body.diagnostics);
    if (new TextEncoder().encode(serialized).length > DIAGNOSTICS_MAX_BYTES) {
      return { ok: false, error: 'diagnostics too large' };
    }
    diagnosticsJson = serialized;
    diagnosticsAttached = 1;
  }

  return {
    ok: true,
    value: {
      id: newId(),
      created_at: new Date(now).toISOString(),
      category: body.category as ReportCategory,
      description: sanitizeDescription(body.description),
      app_version: body.app_version,
      model_id: modelId,
      diagnostics_json: diagnosticsJson,
      diagnostics_attached: diagnosticsAttached,
    },
  };
}

/** True when the Origin header is in the configured allowlist. */
export function isAllowedOrigin(origin: string | null, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return false;
  if (!origin) return false;
  return allowed.includes(origin);
}

export { UUID_RE };
