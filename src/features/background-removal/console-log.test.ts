import { describe, it, expect } from 'vitest';
import { classifyLogLine } from './console-log';

describe('classifyLogLine', () => {
  it('tags errors and warnings, and leaves everything else as info', () => {
    expect(classifyLogLine('ERROR: bad_alloc').level).toBe('error');
    expect(classifyLogLine('WARNING: the mask is empty').level).toBe('warn');
    expect(classifyLogLine('Inference 1: 812.4 ms').level).toBe('info');
  });

  it('keeps the line text unchanged', () => {
    expect(classifyLogLine('Execution provider: wasm').text).toBe('Execution provider: wasm');
  });
});
