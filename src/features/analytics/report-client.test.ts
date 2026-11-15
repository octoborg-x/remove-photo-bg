import { describe, it, expect } from 'vitest';
import {
  normalizeDescription,
  reportBody,
  submitReport,
  validateReport,
  type QualityReportInput,
} from './report-client';
import { REPORT_DESCRIPTION_MAX, isReportCategory } from './report-categories';

const base: QualityReportInput = { category: 'poor_edges', app_version: '20260101T000000' };

describe('validateReport', () => {
  it('accepts a minimal valid report', () => {
    expect(validateReport(base).ok).toBe(true);
  });

  it('rejects an unknown category', () => {
    expect(validateReport({ ...base, category: 'bogus' as never }).ok).toBe(false);
    expect(isReportCategory('bogus')).toBe(false);
  });

  it('rejects an over-length description', () => {
    const long = 'x'.repeat(REPORT_DESCRIPTION_MAX + 1);
    expect(validateReport({ ...base, description: long }).ok).toBe(false);
  });

  it('rejects a missing app version', () => {
    expect(validateReport({ ...base, app_version: '' }).ok).toBe(false);
  });
});

describe('normalizeDescription', () => {
  it('trims and drops an empty description', () => {
    expect(normalizeDescription('   ')).toBeUndefined();
    expect(normalizeDescription('  halo edges  ')).toBe('halo edges');
    expect(normalizeDescription(undefined)).toBeUndefined();
  });

  it('bounds the length', () => {
    expect(normalizeDescription('x'.repeat(1000))!.length).toBe(REPORT_DESCRIPTION_MAX);
  });
});

describe('reportBody', () => {
  it('omits diagnostics unless explicitly provided', () => {
    const body = reportBody(base);
    expect(body.diagnostics).toBeUndefined();
    expect(body.category).toBe('poor_edges');
  });

  it('includes diagnostics only when passed', () => {
    const report = { schemaVersion: '1.0', generatedAt: '2026-01-01T00:00:00.000Z' } as never;
    const body = reportBody({ ...base, diagnostics: report });
    expect(body.diagnostics).toEqual(report);
  });

  it('never includes an email or contact field', () => {
    const body = reportBody({ ...base, description: 'bad edges' });
    expect(Object.keys(body)).not.toContain('email');
    expect(Object.keys(body)).not.toContain('contact');
  });
});

describe('submitReport', () => {
  it('returns false on validation failure without a network call', async () => {
    const originalFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    try {
      const ok = await submitReport('https://w.example.com/api/quality-reports', {
        ...base,
        category: 'bogus' as never,
      });
      expect(ok).toBe(false);
      expect(called).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns true on a 2xx response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'x' }), { status: 201 })) as typeof fetch;
    try {
      expect(await submitReport('https://w.example.com/api/quality-reports', base)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns false when the network fails (never throws)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    try {
      expect(await submitReport('https://w.example.com/api/quality-reports', base)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
