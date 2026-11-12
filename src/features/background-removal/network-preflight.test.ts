import { describe, it, expect } from 'vitest';
import {
  classifyConnection,
  assessNetwork,
  shouldConfirmDownload,
  downloadConfirmationText,
  shouldAutoFetchModel,
  isUnmeteredConnection,
  isMeteredConnection,
  connectionChangeAction,
  meteredSwitchNotice,
} from './network-preflight';

describe('classifyConnection', () => {
  it('treats missing data as unknown', () => {
    expect(classifyConnection(null)).toBe('unknown');
    expect(classifyConnection({})).toBe('unknown');
    expect(classifyConnection({ effectiveType: '4g' })).toBe('unknown');
  });

  it('recognises wifi and ethernet', () => {
    expect(classifyConnection({ type: 'wifi' })).toBe('wifi');
    expect(classifyConnection({ type: 'ethernet' })).toBe('wifi');
  });

  it('recognises cellular by type or slow effective type', () => {
    expect(classifyConnection({ type: 'cellular' })).toBe('cellular');
    expect(classifyConnection({ effectiveType: '2g' })).toBe('cellular');
    expect(classifyConnection({ effectiveType: '3g' })).toBe('cellular');
    expect(classifyConnection({ effectiveType: 'slow-2g' })).toBe('cellular');
  });

  it('treats data-saver as metered', () => {
    expect(classifyConnection({ saveData: true })).toBe('metered');
  });

  it('falls back to a slow-downlink heuristic when the type is absent', () => {
    expect(classifyConnection({ effectiveType: '4g', downlink: 0.5 })).toBe('cellular');
    expect(classifyConnection({ effectiveType: '4g', downlink: 10 })).toBe('unknown');
  });

  it('treats a fast link on a mobile device with no wifi signal as cellular', () => {
    // Chrome on Android reports only effectiveType '4g' for LTE and omits `type`.
    expect(classifyConnection({ effectiveType: '4g' }, true)).toBe('cellular');
    expect(classifyConnection(null, true)).toBe('cellular');
    expect(classifyConnection({}, true)).toBe('cellular');
  });

  it('still respects a positive wifi signal on a mobile device', () => {
    expect(classifyConnection({ type: 'wifi', effectiveType: '4g' }, true)).toBe('wifi');
  });

  it('does not treat a desktop with no wifi signal as cellular', () => {
    expect(classifyConnection({ effectiveType: '4g' }, false)).toBe('unknown');
    expect(classifyConnection({ effectiveType: '4g' })).toBe('unknown');
  });
});

describe('assessNetwork', () => {
  const model = 68 * 1024 * 1024;

  it('never warns on wifi', () => {
    const r = assessNetwork({ info: { type: 'wifi' }, sizeBytes: model });
    expect(r.connection).toBe('wifi');
    expect(r.warn).toBe(false);
  });

  it('warns on cellular with a large model', () => {
    const r = assessNetwork({ info: { effectiveType: '3g' }, sizeBytes: model });
    expect(r.warn).toBe(true);
    expect(r.connection).toBe('cellular');
  });

  it('does not warn on an unknown connection (desktop Chromium reports no type)', () => {
    expect(assessNetwork({ info: {}, sizeBytes: model }).warn).toBe(false);
    expect(assessNetwork({ info: { effectiveType: '4g' }, sizeBytes: model }).warn).toBe(false);
  });

  it('warns on a mobile device with a fast link and no wifi signal', () => {
    const r = assessNetwork({ info: { effectiveType: '4g' }, deviceMobile: true, sizeBytes: model });
    expect(r.connection).toBe('cellular');
    expect(r.warn).toBe(true);
  });

  it('does not warn for a small download even on cellular', () => {
    const r = assessNetwork({ info: { effectiveType: '3g' }, sizeBytes: 2 * 1024 * 1024 });
    expect(r.warn).toBe(false);
  });

  it('warns when the size is unknown on a metered link', () => {
    expect(assessNetwork({ info: { saveData: true }, sizeBytes: 0 }).warn).toBe(true);
  });

  it('produces a non-empty summary', () => {
    expect(assessNetwork({ info: { effectiveType: '4g', downlink: 3.2 }, sizeBytes: model }).summary)
      .toContain('4g');
  });
});

describe('shouldConfirmDownload', () => {
  const model = 68 * 1024 * 1024;
  const cellular = { effectiveType: '3g' } as const;

  it('asks on a metered link when the model is not cached', () => {
    expect(shouldConfirmDownload({ info: cellular, sizeBytes: model })).toBe(true);
  });

  it('never asks when the model is already on this device', () => {
    expect(
      shouldConfirmDownload({ info: cellular, sizeBytes: model, cached: true }),
    ).toBe(false);
  });

  it('never asks once consent is already given this session', () => {
    expect(
      shouldConfirmDownload({ info: cellular, sizeBytes: model, confirmed: true }),
    ).toBe(false);
  });

  it('asks on a mobile device with no wifi signal even when the link looks fast', () => {
    expect(
      shouldConfirmDownload({ info: { effectiveType: '4g' }, deviceMobile: true, sizeBytes: model }),
    ).toBe(true);
  });

  it('never asks on an unmetered link', () => {
    expect(shouldConfirmDownload({ info: { type: 'wifi' }, sizeBytes: model })).toBe(false);
  });
});

describe('confirmation copy', () => {
  it('states the download size and the privacy guarantee', () => {
    const text = downloadConfirmationText(68 * 1024 * 1024, 'int8+fp16');
    expect(text).toContain('68.0 MB');
    expect(text).toContain('once');
    expect(text).toMatch(/never uploaded/i);
  });

  it('handles an unknown size without printing "0 B"', () => {
    expect(downloadConfirmationText(0)).toContain('large file');
  });
});

describe('isUnmeteredConnection', () => {
  it('accepts wifi, ethernet and unknown, rejects cellular and data-saver', () => {
    expect(isUnmeteredConnection('wifi')).toBe(true);
    expect(isUnmeteredConnection('unknown')).toBe(true);
    expect(isUnmeteredConnection('cellular')).toBe(false);
    expect(isUnmeteredConnection('metered')).toBe(false);
  });
});

describe('isMeteredConnection', () => {
  it('is the complement of isUnmeteredConnection', () => {
    expect(isMeteredConnection('cellular')).toBe(true);
    expect(isMeteredConnection('metered')).toBe(true);
    expect(isMeteredConnection('wifi')).toBe(false);
    expect(isMeteredConnection('unknown')).toBe(false);
  });
});

describe('connectionChangeAction', () => {
  it('pauses an in-flight download the moment the link becomes metered', () => {
    expect(connectionChangeAction('wifi', 'cellular', true)).toBe('pause');
    expect(connectionChangeAction('wifi', 'metered', true)).toBe('pause');
    // A switch between two metered links is still a pause.
    expect(connectionChangeAction('cellular', 'metered', true)).toBe('pause');
  });

  it('leaves an in-flight download alone while the link stays unmetered', () => {
    expect(connectionChangeAction('wifi', 'wifi', true)).toBe('none');
    expect(connectionChangeAction('unknown', 'wifi', true)).toBe('none');
  });

  it('starts the download when an unmetered link appears and nothing is running', () => {
    expect(connectionChangeAction('cellular', 'wifi', false)).toBe('start');
    expect(connectionChangeAction('metered', 'unknown', false)).toBe('start');
  });

  it('does nothing when a metered link persists, or an unmetered link was already up', () => {
    expect(connectionChangeAction('cellular', 'cellular', false)).toBe('none');
    expect(connectionChangeAction('wifi', 'wifi', false)).toBe('none');
    expect(connectionChangeAction('wifi', 'cellular', false)).toBe('none');
  });
});

describe('meteredSwitchNotice', () => {
  it('states the size, that it paused, and how to resume', () => {
    const text = meteredSwitchNotice(60 * 1024 * 1024, 'QMix Cut-512');
    expect(text).toContain('mobile data');
    expect(text).toMatch(/paused/i);
    expect(text).toContain('60.0 MB');
    expect(text).toMatch(/continue/i);
  });

  it('handles an unknown size without printing "0 B"', () => {
    expect(meteredSwitchNotice(0)).toContain('large file');
  });
});

describe('shouldAutoFetchModel', () => {
  const idle = { cached: false, ready: false, inFlight: false };

  it('fetches on an unmetered link when the model is absent and idle', () => {
    expect(shouldAutoFetchModel({ connection: 'wifi', ...idle })).toBe(true);
    expect(shouldAutoFetchModel({ connection: 'unknown', ...idle })).toBe(true);
  });

  it('never fetches on a metered link', () => {
    expect(shouldAutoFetchModel({ connection: 'cellular', ...idle })).toBe(false);
    expect(shouldAutoFetchModel({ connection: 'metered', ...idle })).toBe(false);
  });

  it('does nothing when the model is already cached, ready or in flight', () => {
    expect(shouldAutoFetchModel({ connection: 'wifi', ...idle, cached: true })).toBe(false);
    expect(shouldAutoFetchModel({ connection: 'wifi', ...idle, ready: true })).toBe(false);
    expect(shouldAutoFetchModel({ connection: 'wifi', ...idle, inFlight: true })).toBe(false);
  });
});
