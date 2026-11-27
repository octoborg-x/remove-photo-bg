// Bulk queue: up to five *active* photos processed one after another. Once a
// batch finishes, the finished items stay available for download while the
// queue accepts another five. Pure state, no DOM and no blobs — the caller owns
// the original blobs, result canvases and object URLs, keyed by the ids
// assigned here.

import type { BackgroundChoice } from './background-color';

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
  /** Per-image background override for previews/exports. `null` uses the
   *  shared Background & Export choice. */
  background: BackgroundChoice | null;
}

export interface BulkState {
  items: BulkItem[];
  nextId: number;
  /** The item shown in the single-image preview/download action. */
  selectedId: number | null;
  /** Ids ticked for bulk actions (delete, background, download selected). */
  checkedIds: number[];
}

export interface BulkAddInput {
  name: string;
  width: number;
  height: number;
  originalUrl: string;
}

export function initialBulkState(): BulkState {
  return { items: [], nextId: 1, selectedId: null, checkedIds: [] };
}

/** Items still waiting for (or in the middle of) a run. */
export function bulkActiveCount(state: BulkState): number {
  return state.items.filter((item) => item.status !== 'done').length;
}

/**
 * Remaining capacity. Finished items do not occupy a slot, so after a batch of
 * five completes the user can add the next five without clearing the results.
 */
export function bulkCapacity(state: BulkState): number {
  return Math.max(0, BULK_LIMIT - bulkActiveCount(state));
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
    background: null,
  };
  return {
    state: { ...state, items: [...state.items, item], nextId: state.nextId + 1, selectedId: item.id },
    item,
  };
}

/** Removes an item and reports the URLs the caller should revoke. */
export function removeBulkItem(state: BulkState, id: number): { state: BulkState; revoked: string[] } {
  return removeBulkItems(state, [id]);
}

/** Removes several items (the bulk delete action). */
export function removeBulkItems(
  state: BulkState,
  ids: readonly number[],
): { state: BulkState; revoked: string[] } {
  const drop = new Set(ids);
  const removed = state.items.filter((item) => drop.has(item.id));
  if (!removed.length) return { state, revoked: [] };
  const revoked = removed.flatMap((item) =>
    item.resultUrl ? [item.originalUrl, item.resultUrl] : [item.originalUrl],
  );
  const items = state.items.filter((item) => !drop.has(item.id));
  const selectedId =
    state.selectedId !== null && drop.has(state.selectedId)
      ? (items[items.length - 1]?.id ?? null)
      : state.selectedId;
  return {
    state: { ...state, items, selectedId, checkedIds: state.checkedIds.filter((id) => !drop.has(id)) },
    revoked,
  };
}

/** Removes every finished item, keeping queued/processing/error items. */
export function clearFinishedBulkItems(state: BulkState): { state: BulkState; revoked: string[] } {
  return removeBulkItems(
    state,
    state.items.filter((item) => item.status === 'done').map((item) => item.id),
  );
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

/** Ticks or unticks one image for the bulk actions. */
export function setBulkChecked(state: BulkState, id: number, checked: boolean): BulkState {
  if (!state.items.some((item) => item.id === id)) return state;
  const already = state.checkedIds.includes(id);
  if (already === checked) return state;
  return {
    ...state,
    checkedIds: checked ? [...state.checkedIds, id] : state.checkedIds.filter((value) => value !== id),
  };
}

/** Ticks or unticks every image (the select-all checkbox). */
export function setBulkCheckedAll(state: BulkState, checked: boolean): BulkState {
  return { ...state, checkedIds: checked ? state.items.map((item) => item.id) : [] };
}

export function bulkCheckedItems(state: BulkState): BulkItem[] {
  return state.items.filter((item) => state.checkedIds.includes(item.id));
}

export function bulkCheckedCount(state: BulkState): number {
  return bulkCheckedItems(state).length;
}

/** Applies a background override to the given images (bulk edit). */
export function setBulkBackground(
  state: BulkState,
  ids: readonly number[],
  background: BackgroundChoice | null,
): BulkState {
  const targets = new Set(ids);
  return {
    ...state,
    items: state.items.map((item) => (targets.has(item.id) ? { ...item, background } : item)),
  };
}

export function bulkDoneCount(state: BulkState): number {
  return state.items.filter((item) => item.status === 'done').length;
}

export function bulkPendingCount(state: BulkState): number {
  return state.items.filter((item) => item.status === 'queued' || item.status === 'error').length;
}
