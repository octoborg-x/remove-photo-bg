import { describe, it, expect } from 'vitest';
import {
  BULK_LIMIT,
  addBulkItem,
  bulkActiveCount,
  bulkCapacity,
  bulkCheckedCount,
  bulkCheckedItems,
  bulkDoneCount,
  bulkPendingCount,
  clearFinishedBulkItems,
  initialBulkState,
  removeBulkItem,
  removeBulkItems,
  selectBulkItem,
  selectedBulkItem,
  setBulkBackground,
  setBulkChecked,
  setBulkCheckedAll,
  updateBulkItem,
  type BulkState,
} from './bulk-batch';
import { TRANSPARENT } from './background-color';

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

  it('frees capacity once a batch has finished', () => {
    let state = initialBulkState();
    const ids: number[] = [];
    for (let i = 0; i < BULK_LIMIT; i++) {
      const res = add(state, `p${i}.jpg`);
      state = res.state;
      ids.push(res.id!);
    }
    expect(bulkActiveCount(state)).toBe(BULK_LIMIT);
    expect(bulkCapacity(state)).toBe(0);

    for (const id of ids) state = updateBulkItem(state, id, { status: 'done' });
    expect(bulkActiveCount(state)).toBe(0);
    expect(bulkCapacity(state)).toBe(BULK_LIMIT);

    // A second batch of five can be queued without removing the finished items.
    for (let i = 0; i < BULK_LIMIT; i++) state = add(state, `next-${i}.jpg`).state;
    expect(state.items).toHaveLength(BULK_LIMIT * 2);
    expect(bulkCapacity(state)).toBe(0);
  });

  it('keeps done items from blocking a new batch even with errors queued', () => {
    let state = initialBulkState();
    const a = add(state, 'a.jpg');
    state = updateBulkItem(a.state, a.id!, { status: 'done' });
    const b = add(state, 'b.jpg');
    state = updateBulkItem(b.state, b.id!, { status: 'error', error: 'failed' });
    expect(bulkActiveCount(state)).toBe(1);
    expect(bulkCapacity(state)).toBe(BULK_LIMIT - 1);
  });

  it('ticks individual images and all images', () => {
    let state = initialBulkState();
    const a = add(state, 'a.jpg');
    state = add(a.state, 'b.jpg').state;
    state = setBulkChecked(state, a.id!, true);
    expect(bulkCheckedCount(state)).toBe(1);
    expect(bulkCheckedItems(state).map((item) => item.name)).toEqual(['a.jpg']);
    state = setBulkChecked(state, a.id!, false);
    expect(bulkCheckedCount(state)).toBe(0);

    state = setBulkCheckedAll(state, true);
    expect(bulkCheckedCount(state)).toBe(2);
    state = setBulkCheckedAll(state, false);
    expect(bulkCheckedCount(state)).toBe(0);
  });

  it('removes several images and revokes both their URLs', () => {
    let state = initialBulkState();
    const a = add(state, 'a.jpg');
    const b = add(a.state, 'b.jpg');
    state = updateBulkItem(b.state, b.id!, { status: 'done', resultUrl: 'blob:b-cut' });
    state = setBulkChecked(state, b.id!, true);
    const res = removeBulkItems(state, [a.id!, b.id!]);
    expect(res.state.items).toHaveLength(0);
    expect(res.state.checkedIds).toEqual([]);
    expect(res.revoked).toEqual(expect.arrayContaining(['blob:a.jpg', 'blob:b.jpg', 'blob:b-cut']));
  });

  it('clears finished items only', () => {
    let state = initialBulkState();
    const a = add(state, 'a.jpg');
    const b = add(a.state, 'b.jpg');
    state = updateBulkItem(b.state, a.id!, { status: 'done', resultUrl: 'blob:a-cut' });
    const res = clearFinishedBulkItems(state);
    expect(res.state.items.map((item) => item.name)).toEqual(['b.jpg']);
    expect(res.revoked).toEqual(expect.arrayContaining(['blob:a.jpg', 'blob:a-cut']));
  });

  it('applies a background override only to the targeted images', () => {
    let state = initialBulkState();
    const a = add(state, 'a.jpg');
    const b = add(a.state, 'b.jpg');
    state = setBulkBackground(b.state, [a.id!], TRANSPARENT);
    expect(state.items[0].background).toEqual(TRANSPARENT);
    expect(state.items[1].background).toBeNull();
    state = setBulkBackground(state, [a.id!, b.id!], null);
    expect(state.items.every((item) => item.background === null)).toBe(true);
  });
});
