import { describe, it, expect } from 'vitest';
import {
  classifyConnection,
  assessNetwork,
  shouldConfirmDownload,
  downloadConfirmationText,
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

  it('never asks once the user ticked "remember my choice"', () => {
    expect(
      shouldConfirmDownload({ info: cellular, sizeBytes: model, remembered: true }),
    ).toBe(false);
  });

  it('never asks once consent is already given this session', () => {
    expect(
      shouldConfirmDownload({ info: cellular, sizeBytes: model, confirmed: true }),
    ).toBe(false);
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
