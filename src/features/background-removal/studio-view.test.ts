import { describe, it, expect } from 'vitest';
import {
  initialStudioView,
  reduceStudio,
  scrubConsoleLine,
  tabEnabled,
  type StudioViewState,
} from './studio-view';

const run = (events: Parameters<typeof reduceStudio>[1][]): StudioViewState =>
  events.reduce(reduceStudio, initialStudioView());

describe('reduceStudio tab transitions', () => {
  it('starts on the input tab with nothing selected', () => {
    const s = initialStudioView();
    expect(s.tab).toBe('input');
    expect(tabEnabled(s, 'input')).toBe(true);
    expect(tabEnabled(s, 'processing')).toBe(false);
    expect(tabEnabled(s, 'result')).toBe(false);
  });

  it('moving from input to processing enables the processing tab', () => {
    const s = run([{ type: 'select-image' }, { type: 'run-start' }]);
    expect(s.tab).toBe('processing');
    expect(s.running).toBe(true);
    expect(tabEnabled(s, 'processing')).toBe(true);
    expect(tabEnabled(s, 'result')).toBe(false);
  });

  it('progress keeps the processing tab active and clamps the percentage', () => {
    const s = run([{ type: 'select-image' }, { type: 'run-start' }, { type: 'progress', percent: 140 }]);
    expect(s.tab).toBe('processing');
    expect(s.percent).toBe(100);
  });

  it('progress alone does not leave the input tab (boot-time model download)', () => {
    // The model download reports progress during boot, before any photo is
    // chosen. The editor must stay on the input tab so the drop zone is visible.
    const s = run([{ type: 'progress', percent: 42 }]);
    expect(s.tab).toBe('input');
    expect(s.running).toBe(false);
    expect(s.percent).toBe(42);
  });

  it('a null percentage is preserved (indeterminate step)', () => {
    const s = run([{ type: 'run-start' }, { type: 'progress', percent: null }]);
    expect(s.percent).toBeNull();
  });

  it('the result event lands on the result tab and enables it', () => {
    const s = run([{ type: 'select-image' }, { type: 'run-start' }, { type: 'result' }]);
    expect(s.tab).toBe('result');
    expect(s.hasResult).toBe(true);
    expect(tabEnabled(s, 'result')).toBe(true);
  });

  it('selecting a new image resets to the input tab and drops the result', () => {
    const s = run([{ type: 'run-start' }, { type: 'result' }, { type: 'select-image' }]);
    expect(s.tab).toBe('input');
    expect(s.hasResult).toBe(false);
    expect(s.percent).toBeNull();
  });

  it('an error returns to the result when one exists, else the input tab', () => {
    const withResult = run([{ type: 'run-start' }, { type: 'result' }, { type: 'error' }]);
    expect(withResult.tab).toBe('result');
    expect(withResult.running).toBe(false);

    const noResult = run([{ type: 'select-image' }, { type: 'run-start' }, { type: 'error' }]);
    expect(noResult.tab).toBe('input');
  });
});

describe('scrubConsoleLine', () => {
  it('removes internal npm build commands', () => {
    expect(scrubConsoleLine('If the model is not downloaded, run: npm run fetch-models')).not.toMatch(
      /npm run fetch-models/,
    );
  });

  it('redacts the private repository URL', () => {
    expect(scrubConsoleLine('see https://github.com/octoborg-x/remove-photo-bg for details')).not.toMatch(
      /github\.com\/octoborg-x/,
    );
  });

  it('redacts the model host', () => {
    expect(
      scrubConsoleLine('Assets served from: https://huggingface.co/spaces/Octoborg/remove-photo-bg/resolve/main/'),
    ).not.toMatch(/huggingface\.co/);
  });

  it('leaves ordinary diagnostics untouched', () => {
    const line = 'Inference 1: 812.4 ms';
    expect(scrubConsoleLine(line)).toBe(line);
  });
});
