import { describe, it, expect, vi, afterEach } from 'vitest';
import { endpointUrl, browserTransport } from './event-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('endpointUrl', () => {
  it('joins a base and a path without doubling slashes', () => {
    expect(endpointUrl('https://w.example.com', '/api/events')).toBe('https://w.example.com/api/events');
    expect(endpointUrl('https://w.example.com/', '/api/events')).toBe('https://w.example.com/api/events');
    expect(endpointUrl('https://w.example.com///', 'api/events')).toBe('https://w.example.com/api/events');
  });
});

describe('browserTransport', () => {
  it('reports failure instead of throwing when fetch rejects', async () => {
    // No sendBeacon; fetch always rejects.
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    const ok = await browserTransport().send('https://w.example.com/api/events', { a: 1 });
    expect(ok).toBe(false);
  });

  it('prefers sendBeacon and does not fall back when it accepts', async () => {
    let beaconCalls = 0;
    let fetchCalls = 0;
    vi.stubGlobal('navigator', {
      sendBeacon: () => {
        beaconCalls += 1;
        return true;
      },
    });
    vi.stubGlobal('fetch', async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    });
    const ok = await browserTransport().send('https://w.example.com/api/events', { a: 1 });
    expect(ok).toBe(true);
    expect(beaconCalls).toBe(1);
    expect(fetchCalls).toBe(0);
  });
});
