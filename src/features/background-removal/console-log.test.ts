import { describe, it, expect } from 'vitest';
import {
  CONSOLE_CATEGORIES,
  appendLogLine,
  classifyLogLine,
  emptyConsoleLogState,
} from './console-log';

describe('classifyLogLine', () => {
  it('files download and cache lines under "download"', () => {
    expect(classifyLogLine('Model manifest: 1 model(s)').category).toBe('download');
    expect(classifyLogLine('Cached for next visit: /models/model.onnx').category).toBe('download');
  });

  it('files model/runtime/provider lines under "model"', () => {
    expect(classifyLogLine('Execution provider: wasm').category).toBe('model');
    expect(classifyLogLine('Model load time: 120.0 ms').category).toBe('model');
    expect(classifyLogLine('GPU adapter: Apple M1').category).toBe('model');
  });

  it('files mask/removal lines under "processing"', () => {
    expect(classifyLogLine('Rendered cut-out (512x512) as PNG').category).toBe('processing');
    expect(classifyLogLine('Model kept the whole frame; recovered the subject').category).toBe('processing');
  });

  it('files export/format lines under "export"', () => {
    expect(classifyLogLine('Background: #ffffff at 100%').category).toBe('processing');
    expect(classifyLogLine('Export format: jpeg').category).toBe('export');
  });

  it('tags errors and warnings', () => {
    expect(classifyLogLine('ERROR: bad_alloc').level).toBe('error');
    expect(classifyLogLine('WARNING: the mask is empty').level).toBe('warn');
    expect(classifyLogLine('Inference 1: 812.4 ms').level).toBe('info');
  });

  it('routes failures to "general" even when the text mentions a model', () => {
    expect(classifyLogLine('WARNING: the GPU could not run this model').category).toBe('general');
  });

  it('falls back to "general" for unclassified lines', () => {
    expect(classifyLogLine('Select a photo to begin').category).toBe('general');
  });
});

describe('console log state', () => {
  it('starts with every category empty and no active dots', () => {
    const state = emptyConsoleLogState();
    for (const category of CONSOLE_CATEGORIES) {
      expect(state.byCategory[category]).toEqual([]);
    }
    expect(state.active.size).toBe(0);
  });

  it('appends a line under its category and marks the dot active', () => {
    const state = emptyConsoleLogState();
    const category = appendLogLine(state, 'Execution provider: wasm');
    expect(category).toBe('model');
    expect(state.byCategory.model).toHaveLength(1);
    expect(state.byCategory.model[0].text).toBe('Execution provider: wasm');
    expect(state.active.has('model')).toBe(true);
  });

  it('keeps arrival order within a category', () => {
    const state = emptyConsoleLogState();
    appendLogLine(state, 'Model: a');
    appendLogLine(state, 'Model: b');
    expect(state.byCategory.model.map((l) => l.text)).toEqual(['Model: a', 'Model: b']);
  });
});
