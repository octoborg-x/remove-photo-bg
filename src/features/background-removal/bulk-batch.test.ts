import { describe, it, expect } from 'vitest';
import {
  BULK_LIMIT,
  addBulkItem,
  bulkCapacity,
  bulkDoneCount,
  bulkPendingCount,
  initialBulkState,
  removeBulkItem,
  selectBulkItem,
  selectedBulkItem,
  updateBulkItem,
  type BulkState,
} from './bulk-batch';

function add(state: BulkState, name: string): { state: BulkState; id: number | null } {
  const res = addBulkItem(state, { name, width: 100, height: 80, originalUrl: `blob:${name}` });
  return { state: res.state, id: res.item?.id ?? null };
}

describe('bulk queue', () => {
  it('adds photos in order and selects the newest', () => {
    const a = add(initialBulkState(), 'a.jpg');
    const b = add(a.state, 'b.jpg');
    expect(b.state.items.map((item) => item.name)).toEqual(['a.jpg', 'b.jpg']);
    expect(selectedBulkItem(b.state)?.name).toBe('b.jpg');
    expect(b.state.items[0].status).toBe('queued');
  });

  it('caps the queue at five photos', () => {
    let state = initialBulkState();
    for (let i = 0; i < BULK_LIMIT; i++) state = add(state, `p${i}.jpg`).state;
    expect(state.items).toHaveLength(BULK_LIMIT);
    expect(bulkCapacity(state)).toBe(0);
    const overflow = addBulkItem(state, {
      name: 'sixth.jpg',
      width: 1,
      height: 1,
      originalUrl: 'blob:sixth',
    });
    expect(overflow.item).toBeNull();
    expect(overflow.state.items).toHaveLength(BULK_LIMIT);
  });

  it('removes an item, revokes its URLs and falls back the selection', () => {
    const a = add(initialBulkState(), 'a.jpg');
    const b = add(a.state, 'b.jpg');
    const state = updateBulkItem(b.state, b.id!, { status: 'done', resultUrl: 'blob:b-cut' });
    const res = removeBulkItem(state, b.id!);
    expect(res.state.items.map((item) => item.name)).toEqual(['a.jpg']);
    expect(res.revoked).toEqual(['blob:b.jpg', 'blob:b-cut']);
    expect(res.state.selectedId).toBe(a.id);
  });

  it('tracks done and pending counts', () => {
    const a = add(initialBulkState(), 'a.jpg');
    const b = add(a.state, 'b.jpg');
    let state = updateBulkItem(b.state, a.id!, { status: 'done' });
    state = updateBulkItem(state, b.id!, { status: 'error', error: 'No cut-out produced' });
    expect(bulkDoneCount(state)).toBe(1);
    expect(bulkPendingCount(state)).toBe(1);
  });

  it('ignores a selection for an unknown id', () => {
    const a = add(initialBulkState(), 'a.jpg');
    expect(selectBulkItem(a.state, 999)).toBe(a.state);
  });
});
