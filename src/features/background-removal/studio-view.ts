// Pure presentation state for the Studio editor, kept out of main.ts so the tab
// transitions and the console scrubber are unit-testable without a DOM.

export type StudioTab = 'step' | 'bulk' | 'library';

export const STUDIO_TABS: readonly StudioTab[] = ['step', 'bulk', 'library'];

/** The single step editor shows one of these views at a time. */
export type StepPhase = 'input' | 'processing' | 'result';

/** Which view the step tab is showing: the drop zone, the run, or the cut-out. */
export function stepPhase(state: StudioViewState): StepPhase {
  if (state.hasResult) return 'result';
  return state.running ? 'processing' : 'input';
}

/** The step tab's label follows the current step. */
export function stepTitle(state: StudioViewState): string {
  switch (stepPhase(state)) {
    case 'processing':
      return 'Processing';
    case 'result':
      return 'Result';
    default:
      return 'Photo';
  }
}

/** Floating overlays that stay interactive while the studio inerts the page. */
export const STUDIO_KEEP_INTERACTIVE_IDS: readonly string[] = ['toastHost', 'cmdPalette'];

/** True when a sibling of the studio should be made inert while it is open. */
export function shouldInertSibling(siblingId: string, isActiveSibling: boolean): boolean {
  return !isActiveSibling && !STUDIO_KEEP_INTERACTIVE_IDS.includes(siblingId);
}

export interface StudioViewState {
  tab: StudioTab;
  hasInput: boolean;
  running: boolean;
  hasResult: boolean;
  /** True while the progressive-refinement stage is sharpening an already-shown
   *  preview. The result is visible and exportable in this state; only the final
   *  swap is still pending. */
  refining: boolean;
  /** Download completion 0–100, or null when the current step has no measurable percentage. */
  percent: number | null;
}

export type StudioEvent =
  | { type: 'select-image' }
  | { type: 'run-start' }
  | { type: 'progress'; percent: number | null }
  | { type: 'preview' }
  | { type: 'result' }
  | { type: 'show-background' }
  | { type: 'error' };

export function initialStudioView(): StudioViewState {
  return { tab: 'step', hasInput: false, running: false, hasResult: false, refining: false, percent: null };
}

function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

export function reduceStudio(state: StudioViewState, ev: StudioEvent): StudioViewState {
  switch (ev.type) {
    case 'select-image':
      // A new photo resets the step editor to the drop zone; the previous result
      // is gone.
      return { ...state, tab: 'step', hasInput: true, running: false, hasResult: false, refining: false, percent: null };
    case 'run-start':
      return { ...state, tab: 'step', running: true, hasResult: false, refining: false, percent: 0 };
    case 'progress':
      // Progress only refines the percentage of a run already opened by
      // 'run-start'. It must not move the tab by itself: a boot-time model
      // download emits progress before any photo is chosen, and switching the
      // editor to the processing tab then would hide the drop zone.
      return { ...state, percent: ev.percent === null ? null : clampPercent(ev.percent) };
    case 'preview':
      // Stage 1 finished: a usable cut-out exists now, so the step view shows the
      // result and marks it refining. The result is already exportable in this
      // state; `running` stays true so the console still shows the job as in
      // flight and a later `result` (or `error`) can settle it.
      return { ...state, tab: 'step', hasResult: true, refining: true, percent: null };
    case 'result':
      return { ...state, tab: 'step', running: false, hasResult: true, refining: false, percent: 100 };
    case 'show-background':
      // The user picked a new background colour. It changes the preview, the
      // export and the compare view, all of which belong to the step result, so
      // it must not move the tab.
      return state;
    case 'error':
      // A failed run returns to the last good step view: the result if one
      // exists, otherwise the drop zone so the user can pick another photo. A
      // refinement failure after a preview leaves that preview on screen.
      return { ...state, tab: 'step', running: false, refining: false };
  }
}

export function tabEnabled(state: StudioViewState, tab: StudioTab): boolean {
  if (tab === 'step') return true;
  // The bulk queue can be prepared while idle; a run in flight owns the engine,
  // so switching away then would only hide the progress the user needs.
  if (tab === 'bulk') return !state.running || state.tab === 'bulk';
  // The session library is always available — it is the user's own history.
  return true;
}

/** The console and engine controls belong to the step editor, not the queues. */
export function tabHasEngineControls(tab: StudioTab): boolean {
  return tab === 'step';
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
