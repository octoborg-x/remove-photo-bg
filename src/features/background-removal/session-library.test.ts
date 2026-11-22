import { describe, it, expect } from 'vitest';
import {
  reduceSession,
  initialSession,
  activeEntry,
  formatBytes,
  summarizeLibrary,
  SESSION_LIMIT,
  type SessionState,
} from './session-library';

function add(state: SessionState, name: string, createdAt = 0): SessionState {
  return reduceSession(state, {
    type: 'add',
    name,
    width: 100,
    height: 100,
    originalUrl: `blob:${name}`,
    createdAt,
  }).state;
}

describe('reduceSession', () => {
  it('adds an entry and makes it active', () => {
    const state = add(initialSession(), 'a.jpg');
    expect(state.entries).toHaveLength(1);
    expect(activeEntry(state)?.name).toBe('a.jpg');
  });

  it('keeps newest first', () => {
    let state = add(initialSession(), 'a.jpg');
    state = add(state, 'b.jpg');
    expect(state.entries.map((e) => e.name)).toEqual(['b.jpg', 'a.jpg']);
  });

  it('evicts past the cap and reports the dropped URLs', () => {
    let state = initialSession();
    for (let i = 0; i < SESSION_LIMIT; i++) state = add(state, `p${i}.jpg`);
    expect(state.entries).toHaveLength(SESSION_LIMIT);
    const oldest = state.entries[state.entries.length - 1];
    const res = reduceSession(state, {
      type: 'add',
      name: 'newest.jpg',
      width: 1,
      height: 1,
      originalUrl: 'blob:newest',
      createdAt: 0,
    });
    expect(res.revoked).toContain(oldest.originalUrl);
    expect(res.state.entries).toHaveLength(SESSION_LIMIT);
    expect(res.state.entries.some((e) => e.id === oldest.id)).toBe(false);
  });

  it('attaches a result URL to the right entry', () => {
    let state = add(initialSession(), 'a.jpg');
    const id = state.entries[0].id;
    state = reduceSession(state, { type: 'set-result', id, resultUrl: 'blob:a-cut' }).state;
    expect(state.entries[0].resultUrl).toBe('blob:a-cut');
  });

  it('replaces a result and revokes the superseded URL', () => {
    let state = add(initialSession(), 'a.jpg');
    const id = state.entries[0].id;
    state = reduceSession(state, { type: 'set-result', id, resultUrl: 'blob:preview' }).state;
    const res = reduceSession(state, { type: 'set-result', id, resultUrl: 'blob:final' });
    expect(res.revoked).toEqual(['blob:preview']);
    expect(res.state.entries[0].resultUrl).toBe('blob:final');
  });

  it('adds a re-processed result as a new, active version', () => {
    let state = add(initialSession(), 'a.jpg');
    const sourceId = state.entries[0].id;
    state = reduceSession(state, { type: 'set-result', id: sourceId, resultUrl: 'blob:cut-1' }).state;
    state = reduceSession(state, {
      type: 'add-version',
      name: 'a.jpg',
      width: 100,
      height: 100,
      originalUrl: 'blob:a-copy',
      resultUrl: 'blob:cut-2',
      createdAt: 1,
    }).state;
    expect(state.entries).toHaveLength(2);
    expect(state.entries[0].resultUrl).toBe('blob:cut-2');
    expect(state.entries[1].resultUrl).toBe('blob:cut-1');
    expect(activeEntry(state)?.id).toBe(state.entries[0].id);
  });

  it('removes an entry and revokes its URLs, falling back the active id', () => {
    let state = add(initialSession(), 'a.jpg');
    state = add(state, 'b.jpg');
    state = reduceSession(state, { type: 'set-result', id: state.entries[0].id, resultUrl: 'blob:b-cut' }).state;
    const res = reduceSession(state, { type: 'remove', id: state.entries[0].id });
    expect(res.revoked).toContain('blob:b.jpg');
    expect(res.revoked).toContain('blob:b-cut');
    expect(res.state.entries.map((e) => e.name)).toEqual(['a.jpg']);
    expect(activeEntry(res.state)?.name).toBe('a.jpg');
  });

  it('activating an unknown id leaves the active entry null', () => {
    let state = add(initialSession(), 'a.jpg');
    state = reduceSession(state, { type: 'activate', id: 999 }).state;
    expect(activeEntry(state)).toBeNull();
  });

  it('clears history and revokes every original and result URL', () => {
    let state = add(initialSession(), 'a.jpg');
    state = reduceSession(state, { type: 'set-result', id: state.entries[0].id, resultUrl: 'blob:a-cut' }).state;
    state = add(state, 'b.jpg');
    const res = reduceSession(state, { type: 'clear' });
    expect(res.state.entries).toHaveLength(0);
    expect(res.state.activeId).toBeNull();
    expect(res.revoked).toEqual(expect.arrayContaining(['blob:a.jpg', 'blob:a-cut', 'blob:b.jpg']));
    // The id counter is kept so a later entry can never reuse an old id.
    expect(res.state.nextId).toBe(state.nextId);
  });
});

describe('library usage summary', () => {
  it('counts bytes, remaining budget and source types', () => {
    const usage = summarizeLibrary(
      [
        { bytes: 1024, type: 'image/png' },
        { bytes: 2048, type: 'image/jpeg' },
        { bytes: 4096, type: 'image/webp' },
        { bytes: 512, type: 'image/gif' },
      ],
      10_000,
    );
    expect(usage.count).toBe(4);
    expect(usage.usedBytes).toBe(7680);
    expect(usage.budgetBytes).toBe(10_000);
    expect(usage.leftBytes).toBe(2320);
    expect(usage.types).toEqual({ PNG: 1, JPG: 1, WebP: 1, Other: 1 });
  });

  it('never reports negative remaining space', () => {
    const usage = summarizeLibrary([{ bytes: 900, type: 'image/png' }], 500);
    expect(usage.leftBytes).toBe(0);
  });

  it('formats byte counts for the stats line', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});
