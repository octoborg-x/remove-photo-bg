import { describe, it, expect } from 'vitest';
import { formatBytes, formatElapsed, describeProgress, STAGE_LABELS } from './load-progress';

describe('formatBytes', () => {
  it('renders bytes, KB and MB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1048576)).toBe('5.0 MB');
  });

  it('treats non-finite input as zero', () => {
    expect(formatBytes(NaN)).toBe('0 B');
    expect(formatBytes(Infinity)).toBe('0 B');
  });
});

describe('formatElapsed', () => {
  it('renders seconds under a minute and minutes above', () => {
    expect(formatElapsed(1500)).toBe('1.5s');
    expect(formatElapsed(60000)).toBe('1m 0s');
    expect(formatElapsed(125000)).toBe('2m 5s');
  });
});

describe('describeProgress', () => {
  it('has a label for every stage', () => {
    for (const stage of Object.keys(STAGE_LABELS)) {
      expect(describeProgress({ stage: stage as keyof typeof STAGE_LABELS, percent: 0, elapsedMs: 0 })).toBeTruthy();
    }
  });

  it('shows percent and transferred bytes while downloading', () => {
    const line = describeProgress({
      stage: 'downloading',
      percent: 42,
      bytes: 5 * 1048576,
      totalBytes: 68 * 1048576,
      elapsedMs: 12300,
    });
    expect(line).toContain('42%');
    expect(line).toContain('5.0 MB');
    expect(line).toContain('68.0 MB');
    expect(line).toContain('12.3s');
  });

  it('clamps out-of-range percentages', () => {
    expect(describeProgress({ stage: 'downloading', percent: 150, elapsedMs: 0 })).toContain('100%');
    expect(describeProgress({ stage: 'downloading', percent: -10, elapsedMs: 0 })).toContain('0%');
  });

  it('marks a cache hit and omits a percent', () => {
    const line = describeProgress({ stage: 'cache-hit', percent: 100, elapsedMs: 800 });
    expect(line).toContain('cached');
    expect(line).not.toContain('%');
  });

  it('falls back to detail text for stages without special handling', () => {
    const line = describeProgress({
      stage: 'runtime',
      percent: 0,
      elapsedMs: 1000,
      detail: 'wasm',
    });
    expect(line).toContain('1.0s');
  });
});
