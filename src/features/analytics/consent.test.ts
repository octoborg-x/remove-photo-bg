import { describe, it, expect } from 'vitest';
import {
  clearConsent,
  isAnalyticsAllowed,
  parseConsent,
  readConsent,
  shouldAskForConsent,
  writeConsent,
  type StorageLike,
} from './consent';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

describe('consent', () => {
  it('parses only explicit granted/denied values', () => {
    expect(parseConsent('granted')).toBe('granted');
    expect(parseConsent('denied')).toBe('denied');
    expect(parseConsent(null)).toBe('unset');
    expect(parseConsent('yes')).toBe('unset');
  });

  it('round-trips a decision through storage', () => {
    const s = memoryStorage();
    writeConsent(s, 'granted');
    expect(readConsent(s)).toBe('granted');
    clearConsent(s);
    expect(readConsent(s)).toBe('unset');
  });

  it('treats missing storage as unset and never throws', () => {
    expect(readConsent(null)).toBe('unset');
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readConsent(throwing)).toBe('unset');
    expect(() => writeConsent(throwing, 'granted')).not.toThrow();
  });

  it('gates analytics on an explicit grant only', () => {
    expect(isAnalyticsAllowed('granted')).toBe(true);
    expect(isAnalyticsAllowed('denied')).toBe(false);
    expect(isAnalyticsAllowed('unset')).toBe(false);
  });

  it('asks for consent only while the decision is unset', () => {
    expect(shouldAskForConsent('unset')).toBe(true);
    expect(shouldAskForConsent('granted')).toBe(false);
    expect(shouldAskForConsent('denied')).toBe(false);
  });
});
