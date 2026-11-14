// Anonymous visitor identity for repeat-usage measurement. The identifier is a
// random UUID from the browser's cryptographic RNG — never derived from an IP
// address, fingerprint, hardware id, or anything else identifying. It lives in
// first-party local storage, is written only when analytics consent is granted,
// and rotates after a documented retention window. All logic is pure so the
// rotation and "returning" rules can be unit-tested without a DOM.

import type { StorageLike } from './consent';

export const VISITOR_STORAGE_KEY = 'remove-bg:analytics-visitor';
export const SESSION_STORAGE_KEY = 'remove-bg:analytics-session';

/** Retention/rotation window. A visitor id older than this is replaced. */
export const VISITOR_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface VisitorRecord {
  id: string;
  /** Epoch ms when this id was first created. */
  created: number;
  /** Epoch ms of the most recent session start observed for this id. */
  lastSeen: number;
}

/** Random UUID via the crypto API, with a non-crypto fallback for old runtimes. */
export function randomId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Last resort; still random enough to avoid collision, but flagged by callers.
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function parseRecord(raw: string | null | undefined): VisitorRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<VisitorRecord>;
    if (
      typeof parsed?.id === 'string' &&
      parsed.id.length > 0 &&
      typeof parsed.created === 'number' &&
      typeof parsed.lastSeen === 'number'
    ) {
      return { id: parsed.id, created: parsed.created, lastSeen: parsed.lastSeen };
    }
  } catch {
    // A corrupt record is treated as absent and replaced.
  }
  return null;
}

export function readVisitorRecord(storage: StorageLike | null | undefined): VisitorRecord | null {
  if (!storage) return null;
  try {
    return parseRecord(storage.getItem(VISITOR_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeVisitorRecord(storage: StorageLike | null | undefined, record: VisitorRecord): void {
  if (!storage) return;
  try {
    storage.setItem(VISITOR_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // ignore: the in-memory value still works for this session
  }
}

export function clearVisitor(storage: StorageLike | null | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(VISITOR_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function isExpired(record: VisitorRecord, now: number, retentionDays = VISITOR_RETENTION_DAYS): boolean {
  return now - record.created > retentionDays * DAY_MS;
}

export interface SessionStart {
  record: VisitorRecord;
  /** True when a prior (non-expired) visitor id existed before this session. */
  returning: boolean;
  /** True when a stale id was rotated out and replaced. */
  rotated: boolean;
}

/**
 * Resolve the visitor id for a session that is starting now.
 *
 * - No prior record → new id, not returning.
 * - Prior record within the retention window → reuse it, `returning: true`.
 * - Prior record past the window → rotate to a fresh id, not returning.
 */
export function resolveSessionStart(
  storage: StorageLike | null | undefined,
  now: number,
): SessionStart {
  const existing = readVisitorRecord(storage);
  if (existing && !isExpired(existing, now)) {
    const record: VisitorRecord = { id: existing.id, created: existing.created, lastSeen: now };
    writeVisitorRecord(storage, record);
    return { record, returning: true, rotated: false };
  }
  const record: VisitorRecord = { id: randomId(), created: now, lastSeen: now };
  writeVisitorRecord(storage, record);
  return { record, returning: false, rotated: Boolean(existing) };
}

/** Session identifier: per-tab/session only, never persisted beyond the session. */
export function resolveSessionId(storage: StorageLike | null | undefined): string {
  if (storage) {
    try {
      const existing = storage.getItem(SESSION_STORAGE_KEY);
      if (existing) return existing;
      const id = randomId();
      storage.setItem(SESSION_STORAGE_KEY, id);
      return id;
    } catch {
      // fall through to an ephemeral id
    }
  }
  return randomId();
}
