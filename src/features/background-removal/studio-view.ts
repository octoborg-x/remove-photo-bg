// Pure presentation state for the Studio editor, kept out of main.ts so the tab
// transitions and the console scrubber are unit-testable without a DOM.

export type StudioTab = 'input' | 'processing' | 'result' | 'compare';

export const STUDIO_TABS: readonly StudioTab[] = ['input', 'processing', 'result', 'compare'];

export interface StudioViewState {
  tab: StudioTab;
  hasInput: boolean;
  running: boolean;
  hasResult: boolean;
  /** Download completion 0–100, or null when the current step has no measurable percentage. */
  percent: number | null;
}

export type StudioEvent =
  | { type: 'select-image' }
  | { type: 'run-start' }
  | { type: 'progress'; percent: number | null }
  | { type: 'result' }
  | { type: 'show-background' }
  | { type: 'error' };

export function initialStudioView(): StudioViewState {
  return { tab: 'input', hasInput: false, running: false, hasResult: false, percent: null };
}

function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

export function reduceStudio(state: StudioViewState, ev: StudioEvent): StudioViewState {
  switch (ev.type) {
    case 'select-image':
      // A new photo resets the editor to the input tab; the previous result is gone.
      return { ...state, tab: 'input', hasInput: true, running: false, hasResult: false, percent: null };
    case 'run-start':
      return { ...state, tab: 'processing', running: true, percent: 0 };
    case 'progress':
      // Progress only refines the percentage of a run already opened by
      // 'run-start'. It must not move the tab by itself: a boot-time model
      // download emits progress before any photo is chosen, and switching the
      // editor to the processing tab then would hide the drop zone.
      return { ...state, percent: ev.percent === null ? null : clampPercent(ev.percent) };
    case 'result':
      return { ...state, tab: 'result', running: false, hasResult: true, percent: 100 };
    case 'show-background':
      // The user picked a new background colour. It changes the preview, the
      // export and the compare view — all of which are result-stage views — so
      // it must not move the tab. (Result and Compare both stay available.)
      return state;
    case 'error':
      // A failed run returns to the last good view: the result if one exists,
      // otherwise the input tab so the user can pick another photo.
      return { ...state, tab: state.hasResult ? 'result' : 'input', running: false };
  }
}

export function tabEnabled(state: StudioViewState, tab: StudioTab): boolean {
  if (tab === 'input') return true;
  if (tab === 'processing') return state.running;
  // Both 'result' and 'compare' need a finished cut-out.
  return state.hasResult;
}

// The console is user-visible, so it must not leak the private repository, the
// model host, or internal build commands. Raw log lines are filtered through
// this before they are rendered.
const CONSOLE_REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\bnpm run [\w:.-]+/gi, 'the setup script'],
  [/\bVITE_ASSET_BASE\b/g, 'the asset-host setting'],
  [/https?:\/\/github\.com\/[^\s"'`)\]]+/gi, '[repository]'],
  [/https?:\/\/(?:www\.)?huggingface\.co\/[^\s"'`)\]]+/gi, '[model host]'],
  [/\bgit (?:clone|push|pull|checkout|commit|remote|fetch)\b[^\n]*/gi, '[internal command]'],
];

export function scrubConsoleLine(line: string): string {
  let out = line;
  for (const [re, replacement] of CONSOLE_REDACTIONS) out = out.replace(re, replacement);
  return out;
}
