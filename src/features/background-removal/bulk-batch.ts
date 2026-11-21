// Bulk queue: up to five photos processed one after another. Pure state, no DOM
// and no blobs — the caller owns the original blobs, result canvases and object
// URLs, keyed by the ids assigned here.

export const BULK_LIMIT = 5;

export type BulkStatus = 'queued' | 'processing' | 'done' | 'error';

export interface BulkItem {
  id: number;
  name: string;
  width: number;
  height: number;
  /** Object URL of the source photo (caller owns revocation). */
  originalUrl: string;
  /** Object URL of the cut-out thumbnail, or null until the run finishes. */
  resultUrl: string | null;
  status: BulkStatus;
  error: string | null;
}

export interface BulkState {
  items: BulkItem[];
  nextId: number;
  selectedId: number | null;
}

export interface BulkAddInput {
  name: string;
  width: number;
  height: number;
  originalUrl: string;
}

export function initialBulkState(): BulkState {
  return { items: [], nextId: 1, selectedId: null };
}

/** Remaining capacity, 0 when the queue is full. */
export function bulkCapacity(state: BulkState): number {
  return Math.max(0, BULK_LIMIT - state.items.length);
}

/** Adds one photo, or returns the unchanged state when the queue is full. */
export function addBulkItem(state: BulkState, input: BulkAddInput): { state: BulkState; item: BulkItem | null } {
  if (bulkCapacity(state) === 0) return { state, item: null };
  const item: BulkItem = {
    id: state.nextId,
    name: input.name,
    width: input.width,
    height: input.height,
    originalUrl: input.originalUrl,
    resultUrl: null,
    status: 'queued',
    error: null,
  };
  return {
    state: { ...state, items: [...state.items, item], nextId: state.nextId + 1, selectedId: item.id },
    item,
  };
}

/** Removes an item and reports the URLs the caller should revoke. */
export function removeBulkItem(state: BulkState, id: number): { state: BulkState; revoked: string[] } {
  const target = state.items.find((item) => item.id === id);
  if (!target) return { state, revoked: [] };
  const revoked = [target.originalUrl];
  if (target.resultUrl) revoked.push(target.resultUrl);
  const items = state.items.filter((item) => item.id !== id);
  const selectedId =
    state.selectedId === id ? (items[items.length - 1]?.id ?? null) : state.selectedId;
  return { state: { ...state, items, selectedId }, revoked };
}

export function updateBulkItem(
  state: BulkState,
  id: number,
  patch: Partial<Pick<BulkItem, 'status' | 'resultUrl' | 'error'>>,
): BulkState {
  return {
    ...state,
    items: state.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  };
}

export function selectBulkItem(state: BulkState, id: number | null): BulkState {
  if (id === null) return { ...state, selectedId: null };
  return state.items.some((item) => item.id === id) ? { ...state, selectedId: id } : state;
}

export function selectedBulkItem(state: BulkState): BulkItem | null {
  return state.items.find((item) => item.id === state.selectedId) ?? null;
}

export function bulkDoneCount(state: BulkState): number {
  return state.items.filter((item) => item.status === 'done').length;
}

export function bulkPendingCount(state: BulkState): number {
  return state.items.filter((item) => item.status === 'queued' || item.status === 'error').length;
}
