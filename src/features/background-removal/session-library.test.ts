import { describe, it, expect } from 'vitest';
import {
  reduceSession,
  initialSession,
  activeEntry,
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
});
