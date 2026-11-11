// Overall processing-progress model for the Studio's Processing tab.
//
// Only the model download reports a real percentage. The remaining phases
// (building the session, the inference itself, and the final composite) have no
// measurable progress, so the panel used to sit at a bare "0%" for the whole
// run. This module turns the pipeline into a single, monotonic 0–100 estimate:
// each phase owns a band of the bar, the download maps its real percentage into
// its band, and the unmeasurable phases advance by elapsed time within theirs —
// always capped below the next band so the bar never jumps backwards and never
// claims to be finished before the result actually lands.

export type ProcPhase = 'download' | 'prepare' | 'inference' | 'finalize';

/** Half-open percentage band [start, end] each phase occupies on the bar. */
export const PHASE_BANDS: Record<ProcPhase, readonly [number, number]> = {
  download: [0, 40],
  prepare: [40, 58],
  inference: [58, 94],
  finalize: [94, 100],
};

/** Never let a time-estimated phase reach its band end; only a real event does. */
const TIME_FRACTION_CAP = 0.96;

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Maps a within-phase fraction (0–1) onto that phase's band of the bar. */
export function bandPercent(phase: ProcPhase, fraction: number): number {
  const [lo, hi] = PHASE_BANDS[phase];
  return Math.round(lo + (hi - lo) * clamp01(fraction));
}

/**
 * Fraction of a time-estimated phase that has elapsed, capped below 1 so the
 * bar only completes when the phase reports that it finished. A non-positive
 * estimate falls back to the cap (an unknown-length phase shows a slow crawl).
 */
export function timeFraction(elapsedMs: number, expectedMs: number): number {
  if (!Number.isFinite(expectedMs) || expectedMs <= 0) return TIME_FRACTION_CAP;
  return Math.min(TIME_FRACTION_CAP, clamp01(elapsedMs / expectedMs));
}

/**
 * The single progress value to show. `downloadPercent` is the model download's
 * real 0–100 reading; `fraction` is the elapsed-time fraction for the current
 * phase (ignored for `download`). The result is clamped to the phase band so a
 * lagging estimate can never overlap the next phase.
 */
export function overallPercent(
  phase: ProcPhase,
  downloadPercent: number,
  fraction: number,
): number {
  if (phase === 'download') return bandPercent('download', clamp01(downloadPercent / 100));
  return bandPercent(phase, fraction);
}

/** Rounded-down expected inference time, used as the estimate for its band. */
export function estimateInferenceMs(recentMs: readonly number[]): number {
  const valid = recentMs.filter((m) => Number.isFinite(m) && m > 0);
  if (valid.length === 0) return 6000;
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  return Math.max(1500, Math.round(avg));
}

/** Default expected duration of each time-estimated phase, in milliseconds. */
export const PHASE_EXPECTED_MS: Record<ProcPhase, number> = {
  download: 0,
  prepare: 4000,
  inference: 6000,
  finalize: 1500,
};

export function phaseExpectedMs(phase: ProcPhase, inferenceMs: number): number {
  return phase === 'inference' ? inferenceMs : PHASE_EXPECTED_MS[phase];
}
