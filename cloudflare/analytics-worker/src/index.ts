// SmartCutAI analytics Worker.
//
// Two endpoints, both POST, both JSON-over-text/plain (a CORS "simple request",
// so no preflight is needed and `navigator.sendBeacon` can reach it):
//
//   POST /api/events            -> validate -> Workers Analytics Engine
//   POST /api/quality-reports   -> validate -> Cloudflare D1
//
// Design rules (see docs/analytics-architecture.md):
//   • never trust the browser for timestamps or security-sensitive values;
//   • never echo internal errors or secrets in a response;
//   • reject anything not on an explicit allowlist;
//   • keep the endpoint cheap and non-blocking so it can never be a dependency
//     of image processing.
//
// The pure validation lives in ./schema.ts and is unit-tested without the runtime.

import {
  MAX_BODY_BYTES,
  isAllowedOrigin,
  validateEvent,
  validateReport,
  type Result,
} from './schema';

/** Bindings and vars, declared locally so the Worker builds without extra types. */
export interface Env {
  /** Workers Analytics Engine dataset binding (writes data points). */
  ANALYTICS: AnalyticsEngineDataset;
  /** D1 database binding for quality reports. */
  DB: D1Database;
  /** Optional Cloudflare Rate Limiting binding. */
  EVENTS_RATE_LIMITER?: RateLimit;
  /** Comma-separated allowlist of real SmartCutAI origins. */
  ALLOWED_ORIGINS?: string;
  /** Set to "1" to disable all writes (kill switch), keeping the app working. */
  ANALYTICS_DISABLED?: string;
}

// Minimal structural types for the bindings we use, so this file needs no
// @cloudflare/workers-types at build time (Wrangler supplies the real ones).
interface AnalyticsEngineDataset {
  writeDataPoint(point: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
}
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function corsHeaders(origin: string | null, allowed: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = { vary: 'Origin' };
  if (origin && allowed.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-methods'] = 'POST, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type';
    headers['access-control-max-age'] = '86400';
  }
  return headers;
}

function json(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function parseAllowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Read the body, rejecting anything above the byte cap before parsing. */
async function readBoundedBody(request: Request): Promise<Result<unknown>> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    return { ok: false, error: 'payload too large' };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, error: 'unreadable body' };
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return { ok: false, error: 'payload too large' };
  }
  if (!text.trim()) return { ok: false, error: 'empty body' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
}

async function rateLimited(request: Request, env: Env, route: string): Promise<boolean> {
  const limiter = env.EVENTS_RATE_LIMITER;
  if (!limiter) return false;
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  try {
    const { success } = await limiter.limit({ key: `${route}:${ip}` });
    return !success;
  } catch {
    // A limiter failure must not take the endpoint down; fail open.
    return false;
  }
}

async function handleEvent(request: Request, env: Env, origin: string | null, allowed: string[]): Promise<Response> {
  const cors = corsHeaders(origin, allowed);
  if (await rateLimited(request, env, 'events')) {
    return json(429, { error: 'rate limited' }, cors);
  }
  const body = await readBoundedBody(request);
  if (!body.ok) return json(400, { error: body.error }, cors);

  const validated = validateEvent(body.value, Date.now());
  if (!validated.ok) return json(400, { error: validated.error }, cors);

  // The kill switch keeps the endpoint reachable but writes nothing.
  if (env.ANALYTICS_DISABLED === '1') return new Response(null, { status: 204, headers: cors });

  const e = validated.value;
  try {
    env.ANALYTICS.writeDataPoint({
      // Sampling key: the anonymous visitor id (never an IP).
      indexes: [e.anonymous_visitor_id],
      blobs: [
        e.event_name,
        e.app_version ?? '',
        e.model_id ?? '',
        e.processing_provider ?? '',
        e.failure_reason ?? '',
        e.report_category ?? '',
        e.event_id,
        e.session_id,
      ],
      // double1 = client event time (ms); the implicit `timestamp` is receive time.
      doubles: [Date.parse(e.occurred_at)],
    });
  } catch {
    // A storage failure is not the client's problem; still report success so the
    // browser never retries or blocks. The error is not surfaced.
    return new Response(null, { status: 204, headers: cors });
  }
  return new Response(null, { status: 204, headers: cors });
}

async function handleReport(request: Request, env: Env, origin: string | null, allowed: string[]): Promise<Response> {
  const cors = corsHeaders(origin, allowed);
  if (await rateLimited(request, env, 'reports')) {
    return json(429, { error: 'rate limited' }, cors);
  }
  const body = await readBoundedBody(request);
  if (!body.ok) return json(400, { error: body.error }, cors);

  const validated = validateReport(body.value, Date.now(), () => crypto.randomUUID());
  if (!validated.ok) return json(400, { error: validated.error }, cors);

  if (env.ANALYTICS_DISABLED === '1') return json(503, { error: 'unavailable' }, cors);

  const r = validated.value;
  try {
    // Parameterized statement: user input never becomes SQL text.
    await env.DB.prepare(
      `INSERT INTO quality_reports
         (id, created_at, category, description, app_version, model_id, diagnostics_json, diagnostics_attached)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        r.id,
        r.created_at,
        r.category,
        r.description,
        r.app_version,
        r.model_id,
        r.diagnostics_json,
        r.diagnostics_attached,
      )
      .run();
  } catch {
    // Do not leak the database error; a generic failure is enough.
    return json(500, { error: 'could not store report' }, cors);
  }
  return json(201, { id: r.id }, cors);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowed = parseAllowedOrigins(env);
    const origin = request.headers.get('origin');
    const url = new URL(request.url);

    // Preflight. Only a listed origin is answered with CORS headers; everything
    // else gets a bare response, which the browser blocks.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, allowed) });
    }

    if (request.method !== 'POST') {
      return json(405, { error: 'method not allowed' }, corsHeaders(origin, allowed));
    }

    // Requests without an Origin header (curl, server-to-server) are rejected
    // for the browser-facing endpoints; the real site always sends one.
    if (!isAllowedOrigin(origin, allowed)) {
      return json(403, { error: 'origin not allowed' });
    }

    if (url.pathname === '/api/events') return handleEvent(request, env, origin, allowed);
    if (url.pathname === '/api/quality-reports') return handleReport(request, env, origin, allowed);
    return json(404, { error: 'not found' }, corsHeaders(origin, allowed));
  },
};
