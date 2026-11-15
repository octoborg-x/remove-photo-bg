// The Cloudflare Web Analytics beacon must load only when a token is configured
// and only once. It is injected (not shipped as a static tag) so it can be
// gated behind consent. The loader takes a `Document`, so the test supplies a
// minimal fake and stays DOM-free (the unit suite runs in the node environment).
import { describe, it, expect } from 'vitest';
import { CF_BEACON_SRC, hasWebAnalytics, loadWebAnalytics } from './web-analytics';

interface FakeScript {
  type: string;
  src: string;
  attrs: Record<string, string>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
}

function fakeDoc() {
  const scripts: FakeScript[] = [];
  const doc = {
    scripts,
    createElement() {
      const el: FakeScript = {
        type: '',
        src: '',
        attrs: {},
        setAttribute(k, v) {
          el.attrs[k] = v;
        },
        getAttribute(k) {
          return k in el.attrs ? el.attrs[k] : null;
        },
      };
      return el;
    },
    head: {
      appendChild(el: FakeScript) {
        scripts.push(el);
      },
    },
    querySelector(sel: string) {
      if (sel === 'script[data-cf-beacon]') {
        return scripts.find((s) => 'data-cf-beacon' in s.attrs) ?? null;
      }
      return null;
    },
  };
  return doc as unknown as Document & { scripts: FakeScript[] };
}

describe('loadWebAnalytics', () => {
  it('does nothing when the token is empty', () => {
    const doc = fakeDoc();
    expect(loadWebAnalytics('', doc)).toBe(false);
    expect(loadWebAnalytics('   ', doc)).toBe(false);
    expect(hasWebAnalytics(doc)).toBe(false);
    expect(doc.scripts).toHaveLength(0);
  });

  it('injects the beacon with the token and the official src', () => {
    const doc = fakeDoc();
    expect(loadWebAnalytics('abc123', doc)).toBe(true);
    expect(doc.scripts).toHaveLength(1);
    expect(doc.scripts[0].src).toBe(CF_BEACON_SRC);
    expect(doc.scripts[0].type).toBe('module');
    expect(JSON.parse(doc.scripts[0].attrs['data-cf-beacon'])).toEqual({ token: 'abc123' });
  });

  it('does not inject a second beacon', () => {
    const doc = fakeDoc();
    loadWebAnalytics('abc123', doc);
    loadWebAnalytics('abc123', doc);
    expect(doc.scripts).toHaveLength(1);
  });

  it('hasWebAnalytics reflects the document', () => {
    const doc = fakeDoc();
    expect(hasWebAnalytics(doc)).toBe(false);
    loadWebAnalytics('t', doc);
    expect(hasWebAnalytics(doc)).toBe(true);
  });
});
