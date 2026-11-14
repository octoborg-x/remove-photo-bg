import { describe, it, expect } from 'vitest';
import { AnalyticsClient, hasRecordedFirstSuccess, FIRST_SUCCESS_STORAGE_KEY } from './analytics';
import type { AnalyticsEvent } from './events';
import type { Transport } from './event-client';
import type { StorageLike } from './consent';

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

interface Sent {
  url: string;
  body: AnalyticsEvent;
}

function makeClient(opts: { endpoint?: string; now?: () => number } = {}) {
  const sent: Sent[] = [];
  const transport: Transport = {
    async send(url, body) {
      sent.push({ url, body: body as AnalyticsEvent });
      return true;
    },
  };
  const storage = memoryStorage();
  const sessionStorage = memoryStorage();
  const client = new AnalyticsClient({
    endpoint: opts.endpoint ?? 'https://worker.example.com',
    appVersion: '20260101T000000',
    storage,
    sessionStorage,
    transport,
    now: opts.now ?? (() => 1_000_000),
  });
  return { client, sent, storage, sessionStorage };
}

const names = (sent: Sent[]): string[] => sent.map((s) => s.body.event_name);

describe('AnalyticsClient consent gating', () => {
  it('sends nothing while consent is unset', () => {
    const { client, sent, storage } = makeClient();
    client.sessionStarted();
    client.processingStarted();
    client.processingSucceeded();
    client.downloadInitiated();
    expect(sent).toHaveLength(0);
    // No persistent identifier was created before consent.
    expect(storage.data['remove-bg:analytics-visitor']).toBeUndefined();
  });

  it('sends nothing when consent is denied', () => {
    const { client, sent, storage } = makeClient();
    client.setConsent(false);
    client.processingStarted();
    client.processingSucceeded();
    client.downloadInitiated();
    expect(sent).toHaveLength(0);
    expect(storage.data['remove-bg:analytics-visitor']).toBeUndefined();
  });

  it('emits after an explicit grant, and creates the identifier lazily', () => {
    const { client, sent, storage } = makeClient();
    expect(storage.data['remove-bg:analytics-visitor']).toBeUndefined();
    client.setConsent(true);
    // Granting starts the session immediately.
    expect(names(sent)).toEqual(['app_session_started']);
    expect(storage.data['remove-bg:analytics-visitor']).toBeDefined();
  });

  it('withdrawing consent wipes the identifier and stops all events', () => {
    const { client, sent, storage } = makeClient();
    client.setConsent(true);
    client.processingStarted();
    const before = sent.length;
    client.reset();
    expect(storage.data['remove-bg:analytics-visitor']).toBeUndefined();
    client.processingStarted();
    client.processingSucceeded();
    expect(sent.length).toBe(before);
  });

  it('is a no-op when no endpoint is configured', () => {
    const { client, sent, storage } = makeClient({ endpoint: '' });
    client.setConsent(true);
    client.processingStarted();
    client.processingSucceeded();
    expect(sent).toHaveLength(0);
    expect(storage.data['remove-bg:analytics-visitor']).toBeUndefined();
  });
});

describe('AnalyticsClient event accuracy', () => {
  it('emits image_processing_started at most once per run', () => {
    const { client, sent } = makeClient();
    client.setConsent(true);
    client.processingStarted();
    client.processingStarted();
    client.processingStarted();
    expect(names(sent).filter((n) => n === 'image_processing_started')).toHaveLength(1);
  });

  it('emits success once and the first-success marker once per visitor', () => {
    const { client, sent } = makeClient();
    client.setConsent(true);
    client.processingStarted();
    client.processingSucceeded();
    client.processingSucceeded(); // duplicate callback must not double-count
    expect(names(sent).filter((n) => n === 'image_processing_succeeded')).toHaveLength(1);
    expect(names(sent).filter((n) => n === 'first_successful_image_processed')).toHaveLength(1);
  });

  it('does not emit a first-success again on a later run for the same visitor', () => {
    const { client, sent } = makeClient();
    client.setConsent(true);
    client.processingStarted();
    client.processingSucceeded();
    // A second, later run in the same session.
    client.processingStarted();
    client.processingSucceeded();
    expect(names(sent).filter((n) => n === 'image_processing_succeeded')).toHaveLength(2);
    expect(names(sent).filter((n) => n === 'first_successful_image_processed')).toHaveLength(1);
  });

  it('a failed run does not count as a success, but a retry can', () => {
    const { client, sent } = makeClient();
    client.setConsent(true);
    client.processingStarted();
    client.processingFailed('out_of_memory');
    expect(names(sent)).not.toContain('image_processing_succeeded');
    expect(names(sent)).toContain('image_processing_failed');
    // Retry succeeds.
    client.processingStarted();
    client.processingSucceeded();
    expect(names(sent).filter((n) => n === 'image_processing_succeeded')).toHaveLength(1);
    expect(names(sent).filter((n) => n === 'first_successful_image_processed')).toHaveLength(1);
  });

  it('emits download_initiated every time a download is triggered', () => {
    const { client, sent } = makeClient();
    client.setConsent(true);
    client.processingSucceeded();
    client.downloadInitiated();
    client.downloadInitiated();
    expect(names(sent).filter((n) => n === 'download_initiated')).toHaveLength(2);
  });

  it('carries a coarse failure reason, never a raw message', () => {
    const { client, sent } = makeClient();
    client.setConsent(true);
    client.processingStarted();
    client.processingFailed('model_download');
    const ev = sent.find((s) => s.body.event_name === 'image_processing_failed')!;
    expect(ev.body.failure_reason).toBe('model_download');
  });

  it('ignores a failure for a run that never started (keeps the rate coherent)', () => {
    const { client, sent } = makeClient();
    client.setConsent(true);
    // No processingStarted: this is an upload rejection, not a failed run.
    client.processingFailed('upload_rejected');
    expect(names(sent)).not.toContain('image_processing_failed');
  });

  it('does not double-count one failed run from repeated error callbacks', () => {
    const { client, sent } = makeClient();
    client.setConsent(true);
    client.processingStarted();
    client.processingFailed('processing_error');
    client.processingFailed('processing_error');
    expect(names(sent).filter((n) => n === 'image_processing_failed')).toHaveLength(1);
  });
});

describe('AnalyticsClient returning detection', () => {
  it('marks a second session (same storage) as returning', () => {
    const storage = memoryStorage();
    const sessionStorage = memoryStorage();
    const transport: Transport = { send: async () => true };
    const cfg = { endpoint: 'https://w.example.com', appVersion: 'v', storage, sessionStorage, transport };

    const first = new AnalyticsClient({ ...cfg, now: () => 1000 });
    first.setConsent(true);
    expect(first.isReturning).toBe(false);

    // A later visit reuses the same storage.
    const second = new AnalyticsClient({ ...cfg, now: () => 1000 + 24 * 60 * 60 * 1000 });
    second.setConsent(true);
    expect(second.isReturning).toBe(true);
  });

  it('does not treat a fresh visitor as returning', () => {
    const { client } = makeClient();
    client.setConsent(true);
    expect(client.isReturning).toBe(false);
  });
});

describe('first-success storage helper', () => {
  it('matches only the same visitor id', () => {
    expect(hasRecordedFirstSuccess({ visitorId: 'a', at: 1 }, 'a')).toBe(true);
    expect(hasRecordedFirstSuccess({ visitorId: 'a', at: 1 }, 'b')).toBe(false);
    expect(hasRecordedFirstSuccess(null, 'a')).toBe(false);
  });

  it('uses a dedicated storage key', () => {
    expect(FIRST_SUCCESS_STORAGE_KEY).toBe('remove-bg:analytics-first-success');
  });
});
