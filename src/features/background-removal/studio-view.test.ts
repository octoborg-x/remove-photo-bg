import { describe, it, expect } from 'vitest';
import {
  initialStudioView,
  reduceStudio,
  scrubConsoleLine,
  shouldInertSibling,
  stepPhase,
  stepTitle,
  tabEnabled,
  tabHasEngineControls,
  type StudioViewState,
} from './studio-view';

const run = (events: Parameters<typeof reduceStudio>[1][]): StudioViewState =>
  events.reduce(reduceStudio, initialStudioView());

describe('reduceStudio step transitions', () => {
  it('starts on the step tab showing the photo drop zone', () => {
    const s = initialStudioView();
    expect(s.tab).toBe('step');
    expect(stepPhase(s)).toBe('input');
    expect(stepTitle(s)).toBe('Photo');
    expect(tabEnabled(s, 'step')).toBe(true);
    expect(tabEnabled(s, 'library')).toBe(true);
  });

  it('run-start keeps the single tab and shows the processing view', () => {
    const s = run([{ type: 'select-image' }, { type: 'run-start' }]);
    expect(s.tab).toBe('step');
    expect(s.running).toBe(true);
    expect(stepPhase(s)).toBe('processing');
    expect(stepTitle(s)).toBe('Processing');
  });

  it('progress keeps the processing view and clamps the percentage', () => {
    const s = run([{ type: 'select-image' }, { type: 'run-start' }, { type: 'progress', percent: 140 }]);
    expect(stepPhase(s)).toBe('processing');
    expect(s.percent).toBe(100);
  });

  it('progress alone does not leave the photo view (boot-time model download)', () => {
    // The model download reports progress during boot, before any photo is
    // chosen. The editor must stay on the drop zone.
    const s = run([{ type: 'progress', percent: 42 }]);
    expect(stepPhase(s)).toBe('input');
    expect(s.running).toBe(false);
    expect(s.percent).toBe(42);
  });

  it('a null percentage is preserved (indeterminate step)', () => {
    const s = run([{ type: 'run-start' }, { type: 'progress', percent: null }]);
    expect(s.percent).toBeNull();
  });

  it('the result event shows the cut-out and titles the tab Result', () => {
    const s = run([{ type: 'select-image' }, { type: 'run-start' }, { type: 'result' }]);
    expect(s.tab).toBe('step');
    expect(s.hasResult).toBe(true);
    expect(stepPhase(s)).toBe('result');
    expect(stepTitle(s)).toBe('Result');
  });

  it('the preview event shows a usable result while refinement continues', () => {
    const s = run([{ type: 'select-image' }, { type: 'run-start' }, { type: 'preview' }]);
    expect(stepPhase(s)).toBe('result');
    expect(s.hasResult).toBe(true);
    expect(s.refining).toBe(true);
    // Still a running job: the console keeps its in-flight treatment, and the
    // result is already exportable.
    expect(s.running).toBe(true);
  });

  it('a final result settles the refining flag', () => {
    const s = run([{ type: 'run-start' }, { type: 'preview' }, { type: 'result' }]);
    expect(s.refining).toBe(false);
    expect(s.running).toBe(false);
    expect(s.percent).toBe(100);
  });

  it('a refinement error after a preview keeps the preview usable', () => {
    const s = run([{ type: 'run-start' }, { type: 'preview' }, { type: 'error' }]);
    expect(stepPhase(s)).toBe('result');
    expect(s.hasResult).toBe(true);
    expect(s.refining).toBe(false);
    expect(s.running).toBe(false);
  });

  it('the bulk tab is available while idle, but not while a run owns the engine', () => {
    expect(tabEnabled(initialStudioView(), 'bulk')).toBe(true);
    const running = run([{ type: 'select-image' }, { type: 'run-start' }]);
    expect(tabEnabled(running, 'bulk')).toBe(false);
    // A bulk batch forces the tab to bulk, where it stays enabled.
    const onBulk = { ...running, tab: 'bulk' as const };
    expect(tabEnabled(onBulk, 'bulk')).toBe(true);
  });

  it('the library tab is always available, even before a photo is chosen', () => {
    const empty = initialStudioView();
    expect(tabEnabled(empty, 'library')).toBe(true);
    const running = run([{ type: 'select-image' }, { type: 'run-start' }]);
    expect(tabEnabled(running, 'library')).toBe(true);
  });

  it('the console and engine controls belong to the step tab only', () => {
    expect(tabHasEngineControls('step')).toBe(true);
    expect(tabHasEngineControls('bulk')).toBe(false);
    expect(tabHasEngineControls('library')).toBe(false);
  });

  it('show-background keeps the current tab and result', () => {
    const onResult = run([{ type: 'run-start' }, { type: 'result' }, { type: 'show-background' }]);
    expect(onResult.tab).toBe('step');
    expect(onResult.hasResult).toBe(true);
  });

  it('selecting a new image resets the step view and drops the result', () => {
    const s = run([{ type: 'run-start' }, { type: 'result' }, { type: 'select-image' }]);
    expect(stepPhase(s)).toBe('input');
    expect(stepTitle(s)).toBe('Photo');
    expect(s.hasResult).toBe(false);
    expect(s.percent).toBeNull();
  });

  it('an error returns to the result when one exists, else the photo view', () => {
    const withResult = run([{ type: 'run-start' }, { type: 'result' }, { type: 'error' }]);
    expect(stepPhase(withResult)).toBe('result');
    expect(withResult.running).toBe(false);

    const noResult = run([{ type: 'select-image' }, { type: 'run-start' }, { type: 'error' }]);
    expect(stepPhase(noResult)).toBe('input');
    expect(stepTitle(noResult)).toBe('Photo');
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

describe('studio background inerting', () => {
  it('keeps the floating notification host interactive while the studio is open', () => {
    // The host is a body sibling of the studio. Inerting it makes the toast
    // close button hit-test through to the studio controls underneath, so a
    // dismissed error used to close the studio instead.
    expect(shouldInertSibling('toastHost', false)).toBe(false);
    expect(shouldInertSibling('siteHeader', false)).toBe(true);
    expect(shouldInertSibling('studio', true)).toBe(false);
  });
});
