// Session library: the images processed during this browser session, kept in
// memory so the user can revisit a cut-out without re-uploading. Pure state, no
// DOM and no persistence — the library lives only as long as the tab, which is
// deliberate (no photo ever leaves the device, and nothing is written to disk).

export interface SessionEntry {
  /** Stable id (monotonic within the session). */
  id: number;
  /** Display name, e.g. the uploaded file name or "Photo 3". */
  name: string;
  /** Source image dimensions. */
  width: number;
  height: number;
  /** Object URL of the original photo (caller owns revocation). */
  originalUrl: string;
  /** Object URL of the cut-out preview, or null while a run is in flight. */
  resultUrl: string | null;
  /** Epoch ms the entry was created. */
  createdAt: number;
}

/** Newest-first cap; older entries are evicted (their URLs the caller revokes). */
export const SESSION_LIMIT = 12;

export interface SessionState {
  entries: SessionEntry[];
  /** Id of the entry currently shown, or null. */
  activeId: number | null;
  nextId: number;
}

export function initialSession(): SessionState {
  return { entries: [], activeId: null, nextId: 1 };
}

export type SessionEvent =
  | { type: 'add'; name: string; width: number; height: number; originalUrl: string; createdAt: number }
  | { type: 'set-result'; id: number; resultUrl: string }
  | {
      type: 'add-version';
      name: string;
      width: number;
      height: number;
      originalUrl: string;
      resultUrl: string;
      createdAt: number;
    }
  | { type: 'activate'; id: number }
  | { type: 'remove'; id: number }
  | { type: 'clear' };

export interface SessionResult {
  state: SessionState;
  /** URLs whose blobs are no longer referenced and should be revoked. */
  revoked: string[];
}

/**
 * Reduces a session event to the next state. Returns any URLs that fell out of
 * the library (eviction or removal) so the caller can revoke them — a pure
 * reducer cannot free blob URLs itself, and leaking them would pin the image
 * bytes for the tab's lifetime.
 */
export function reduceSession(state: SessionState, ev: SessionEvent): SessionResult {
  switch (ev.type) {
    case 'add':
    case 'add-version': {
      const entry: SessionEntry = {
        id: state.nextId,
        name: ev.name,
        width: ev.width,
        height: ev.height,
        originalUrl: ev.originalUrl,
        resultUrl: ev.type === 'add-version' ? ev.resultUrl : null,
        createdAt: ev.createdAt,
      };
      let entries = [entry, ...state.entries];
      const revoked: string[] = [];
      while (entries.length > SESSION_LIMIT) {
        const dropped = entries[entries.length - 1];
        entries = entries.slice(0, -1);
        revoked.push(dropped.originalUrl);
        if (dropped.resultUrl) revoked.push(dropped.resultUrl);
      }
      return { state: { ...state, entries, activeId: entry.id, nextId: state.nextId + 1 }, revoked };
    }
    case 'set-result': {
      // Replacing a result (the interim preview → the refined final) frees the
      // old URL so a refinement never leaks a blob for the tab's lifetime.
      const revoked: string[] = [];
      const entries = state.entries.map((e) => {
        if (e.id !== ev.id) return e;
        if (e.resultUrl) revoked.push(e.resultUrl);
        return { ...e, resultUrl: ev.resultUrl };
      });
      return { state: { ...state, entries }, revoked };
    }
    case 'activate':
      return { state: { ...state, activeId: ev.id }, revoked: [] };
    case 'remove': {
      const target = state.entries.find((e) => e.id === ev.id);
      const entries = state.entries.filter((e) => e.id !== ev.id);
      const revoked: string[] = [];
      if (target) {
        revoked.push(target.originalUrl);
        if (target.resultUrl) revoked.push(target.resultUrl);
      }
      const activeId = state.activeId === ev.id ? (entries[0]?.id ?? null) : state.activeId;
      return { state: { ...state, entries, activeId }, revoked };
    }
    case 'clear': {
      // Clear history: drop every entry and report all of its URLs for
      // revocation. The id counter is kept so a re-opened version can never
      // collide with a blob still held under an old id.
      const revoked: string[] = [];
      for (const entry of state.entries) {
        revoked.push(entry.originalUrl);
        if (entry.resultUrl) revoked.push(entry.resultUrl);
      }
      return { state: { ...state, entries: [], activeId: null }, revoked };
    }
  }
}

export function activeEntry(state: SessionState): SessionEntry | null {
  return state.entries.find((e) => e.id === state.activeId) ?? null;
}

/** Session-only memory budget shown in the Library stats line. */
export const LIBRARY_STORAGE_BUDGET_BYTES = 256 * 1024 * 1024;

export interface LibraryUsageItem {
  bytes: number;
  /** Source MIME type, e.g. `image/png`. */
  type: string;
}

export interface LibraryUsage {
  count: number;
  usedBytes: number;
  budgetBytes: number;
  leftBytes: number;
  types: { PNG: number; JPG: number; WebP: number; Other: number };
}

/** Human-readable byte size, rounded to one decimal for KB/MB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function typeBucket(type: string): keyof LibraryUsage['types'] {
  switch (type.toLowerCase()) {
    case 'image/png':
      return 'PNG';
    case 'image/jpeg':
      return 'JPG';
    case 'image/webp':
      return 'WebP';
    default:
      return 'Other';
  }
}

/** Summarises the bytes and source types held by the session library. */
export function summarizeLibrary(
  items: readonly LibraryUsageItem[],
  budgetBytes: number = LIBRARY_STORAGE_BUDGET_BYTES,
): LibraryUsage {
  const types: LibraryUsage['types'] = { PNG: 0, JPG: 0, WebP: 0, Other: 0 };
  let usedBytes = 0;
  for (const item of items) {
    usedBytes += Math.max(0, item.bytes);
    types[typeBucket(item.type)] += 1;
  }
  return {
    count: items.length,
    usedBytes,
    budgetBytes,
    leftBytes: Math.max(0, budgetBytes - usedBytes),
    types,
  };
}
