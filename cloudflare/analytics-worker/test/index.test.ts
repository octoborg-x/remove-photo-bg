import { describe, it, expect } from 'vitest';
import worker, { type Env } from '../src/index';

// Fake bindings that record what the Worker would write. These stand in for the
// Cloudflare runtime boundary (Analytics Engine / D1), which is exactly where a
// unit test must stop: the validation logic under test is real, only the storage
// syscall is simulated.
function makeEnv(overrides: Partial<Env> = {}) {
  const points: Array<Record<string, unknown>> = [];
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const env = {
    ANALYTICS: {
      writeDataPoint: (p: Record<string, unknown>) => {
        points.push(p);
      },
    },
    DB: {
      prepare(sql: string) {
        const stmt = {
          sql,
          params: [] as unknown[],
          bind(...params: unknown[]) {
            stmt.params = params;
            return stmt;
          },
          async run() {
            statements.push({ sql, params: stmt.params });
            return { success: true };
          },
        };
        return stmt;
      },
    },
    ALLOWED_ORIGINS: 'https://remove-photo-bg.vercel.app',
    ...overrides,
  } as unknown as Env;
  return { env, points, statements };
}

const ORIGIN = 'https://remove-photo-bg.vercel.app';

function req(path: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(`https://worker.example.com${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'text/plain', ...(init.headers as Record<string, string>) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    event_name: 'image_processing_succeeded',
    anonymous_visitor_id: 'visitor-uuid-1234',
    session_id: 'session-uuid-5678',
    occurred_at: new Date().toISOString(),
    app_version: '20260101T000000',
    ...overrides,
  };
}

describe('POST /api/events', () => {
  it('accepts a valid event and writes one Analytics Engine data point', async () => {
    const { env, points } = makeEnv();
    const res = await worker.fetch(req('/api/events', validEvent()), env);
    expect(res.status).toBe(204);
    expect(points).toHaveLength(1);
    const blob = points[0].blobs as string[];
    expect(blob[0]).toBe('image_processing_succeeded');
    expect(blob[6]).toBe('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    // The sampling index is the anonymous visitor id, never an IP.
    expect(points[0].indexes).toEqual(['visitor-uuid-1234']);
  });

  it('rejects an unknown event name', async () => {
    const { env, points } = makeEnv();
    const res = await worker.fetch(req('/api/events', validEvent({ event_name: 'exfiltrate' })), env);
    expect(res.status).toBe(400);
    expect(points).toHaveLength(0);
  });

  it('rejects an invalid payload (wrong field type)', async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req('/api/events', validEvent({ anonymous_visitor_id: 42 })), env);
    expect(res.status).toBe(400);
  });

  it('rejects unexpected properties', async () => {
    const { env, points } = makeEnv();
    const res = await worker.fetch(req('/api/events', validEvent({ image: 'data:image/png;base64,AAAA' })), env);
    expect(res.status).toBe(400);
    expect(points).toHaveLength(0);
  });

  it('rejects an oversized payload', async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req('/api/events', validEvent({ app_version: 'x'.repeat(20000) })), env);
    expect(res.status).toBe(400);
  });

  it('rejects an invalid timestamp (in the future)', async () => {
    const { env } = makeEnv();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await worker.fetch(req('/api/events', validEvent({ occurred_at: future })), env);
    expect(res.status).toBe(400);
  });

  it('rejects a non-parseable timestamp', async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req('/api/events', validEvent({ occurred_at: 'yesterday' })), env);
    expect(res.status).toBe(400);
  });

  it('rejects an unsupported HTTP method', async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      new Request('https://worker.example.com/api/events', { method: 'GET', headers: { origin: ORIGIN } }),
      env,
    );
    expect(res.status).toBe(405);
  });

  it('rejects an unexpected origin', async () => {
    const { env, points } = makeEnv();
    const res = await worker.fetch(
      req('/api/events', validEvent(), { headers: { origin: 'https://evil.example.com' } }),
      env,
    );
    expect(res.status).toBe(403);
    expect(points).toHaveLength(0);
  });

  it('rejects a request with no origin', async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      new Request('https://worker.example.com/api/events', {
        method: 'POST',
        body: JSON.stringify(validEvent()),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('returns 429 when the rate limiter denies the request', async () => {
    const { env } = makeEnv({
      EVENTS_RATE_LIMITER: { limit: async () => ({ success: false }) } as unknown as Env['EVENTS_RATE_LIMITER'],
    });
    const res = await worker.fetch(req('/api/events', validEvent()), env);
    expect(res.status).toBe(429);
  });

  it('does not fail the client when Analytics Engine throws', async () => {
    const { env } = makeEnv({
      ANALYTICS: {
        writeDataPoint: () => {
          throw new Error('AE unavailable');
        },
      } as unknown as Env['ANALYTICS'],
    });
    const res = await worker.fetch(req('/api/events', validEvent()), env);
    expect(res.status).toBe(204);
  });

  it('writes nothing when disabled, but still accepts the request', async () => {
    const { env, points } = makeEnv({ ANALYTICS_DISABLED: '1' });
    const res = await worker.fetch(req('/api/events', validEvent()), env);
    expect(res.status).toBe(204);
    expect(points).toHaveLength(0);
  });
});

describe('POST /api/quality-reports', () => {
  const report = { category: 'poor_edges', app_version: '20260101T000000' };

  it('stores a valid report in D1 with parameterized SQL', async () => {
    const { env, statements } = makeEnv();
    const res = await worker.fetch(req('/api/quality-reports', report), env);
    expect(res.status).toBe(201);
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('INSERT INTO quality_reports');
    // Values are bound, never interpolated into the SQL text.
    expect(statements[0].params[2]).toBe('poor_edges');
    // Diagnostics omitted by default -> null and flag 0.
    expect(statements[0].params[6]).toBeNull();
    expect(statements[0].params[7]).toBe(0);
  });

  it('rejects an invalid category', async () => {
    const { env, statements } = makeEnv();
    const res = await worker.fetch(req('/api/quality-reports', { ...report, category: 'nonsense' }), env);
    expect(res.status).toBe(400);
    expect(statements).toHaveLength(0);
  });

  it('rejects an oversized description', async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      req('/api/quality-reports', { ...report, description: 'x'.repeat(501) }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('handles a SQL-injection attempt safely (bound as data)', async () => {
    const { env, statements } = makeEnv();
    const evil = "poor_edges'; DROP TABLE quality_reports;--";
    // The category is validated against the allowlist, so this is rejected…
    const res = await worker.fetch(req('/api/quality-reports', { ...report, category: evil }), env);
    expect(res.status).toBe(400);
    expect(statements).toHaveLength(0);

    // …and an injection attempt in the free-text description is stored as a
    // bound parameter, never executed.
    const res2 = await worker.fetch(
      req('/api/quality-reports', { ...report, description: "'; DELETE FROM quality_reports;--" }),
      env,
    );
    expect(res2.status).toBe(201);
    expect(statements[0].params[3]).toBe("'; DELETE FROM quality_reports;--");
    expect(statements[0].sql).not.toContain('DELETE');
  });

  it('stores diagnostics only when explicitly attached', async () => {
    const { env, statements } = makeEnv();
    await worker.fetch(
      req('/api/quality-reports', {
        ...report,
        diagnostics: { app_version: 'x', model_id: 'model_512_int8_fp16' },
      }),
      env,
    );
    expect(statements[0].params[6]).toBe(JSON.stringify({ app_version: 'x', model_id: 'model_512_int8_fp16' }));
    expect(statements[0].params[7]).toBe(1);
  });

  it('rejects diagnostics that are not a plain object', async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      req('/api/quality-reports', { ...report, diagnostics: 'data:image/png;base64,AAAA' }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns a generic 500 without leaking the database error', async () => {
    const { env } = makeEnv({
      DB: {
        prepare() {
          return {
            bind() {
              return this;
            },
            async run() {
              throw new Error('D1_ERROR: no such table: quality_reports at /path/to/db');
            },
          };
        },
      } as unknown as Env['DB'],
    });
    const res = await worker.fetch(req('/api/quality-reports', report), env);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('no such table');
    expect(text).not.toContain('/path/to/db');
  });

  it('rejects an unknown path', async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req('/api/whatever', report), env);
    expect(res.status).toBe(404);
  });
});
