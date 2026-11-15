import { describe, it, expect } from 'vitest';
import {
  VISITOR_RETENTION_DAYS,
  isExpired,
  readVisitorRecord,
  resolveSessionId,
  resolveSessionStart,
  writeVisitorRecord,
  type VisitorRecord,
} from './visitor-id';
import type { StorageLike } from './consent';

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

const DAY = 24 * 60 * 60 * 1000;

describe('visitor identity', () => {
  it('creates a random uuid-shaped id, not derived from anything', () => {
    const s = memoryStorage();
    const { record, returning } = resolveSessionStart(s, 1000);
    expect(returning).toBe(false);
    // UUID v4 shape.
    expect(record.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('reuses a recent id and marks the next session as returning', () => {
    const s = memoryStorage();
    const first = resolveSessionStart(s, 1000);
    const second = resolveSessionStart(s, 1000 + DAY);
    expect(second.record.id).toBe(first.record.id);
    expect(second.returning).toBe(true);
    expect(second.rotated).toBe(false);
  });

  it('rotates an id older than the retention window', () => {
    const s = memoryStorage();
    const first = resolveSessionStart(s, 1000);
    const later = 1000 + (VISITOR_RETENTION_DAYS + 1) * DAY;
    const second = resolveSessionStart(s, later);
    expect(second.record.id).not.toBe(first.record.id);
    expect(second.returning).toBe(false);
    expect(second.rotated).toBe(true);
  });

  it('flags expiry at the retention boundary', () => {
    const record: VisitorRecord = { id: 'x', created: 0, lastSeen: 0 };
    expect(isExpired(record, VISITOR_RETENTION_DAYS * DAY)).toBe(false);
    expect(isExpired(record, VISITOR_RETENTION_DAYS * DAY + 1)).toBe(true);
  });

  it('treats a corrupt record as absent and replaces it', () => {
    const s = memoryStorage({ 'remove-bg:analytics-visitor': '{not json' });
    expect(readVisitorRecord(s)).toBeNull();
    const { record, returning } = resolveSessionStart(s, 1000);
    expect(returning).toBe(false);
    expect(record.id.length).toBeGreaterThan(0);
  });

  it('keeps one session id for the whole session', () => {
    const s = memoryStorage();
    const a = resolveSessionId(s);
    const b = resolveSessionId(s);
    expect(a).toBe(b);
  });

  it('works without storage (returns an ephemeral id)', () => {
    expect(resolveSessionId(null).length).toBeGreaterThan(0);
    const { record } = resolveSessionStart(null, 1000);
    expect(record.id.length).toBeGreaterThan(0);
  });

  it('round-trips a written record', () => {
    const s = memoryStorage();
    const record: VisitorRecord = { id: 'abc', created: 5, lastSeen: 9 };
    writeVisitorRecord(s, record);
    expect(readVisitorRecord(s)).toEqual(record);
  });
});
