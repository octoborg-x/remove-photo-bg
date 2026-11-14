// The device report: one copyable text blob a tester on a real phone (or any
// machine) can paste back into an issue. It folds the environment facts that
// are expensive to reconstruct (provider, GPU adapter, timings, model) together
// with the raw-mask sanity statistics measured right after inference, so a
// "washed-out / ghost" report carries the numbers needed to tell a squashed mask
// (alpha bug) from a real-device precision issue — without a debug build.

import { formatMaskStats, type MaskStats } from './mask-stats';

export interface DeviceReportInput {
  buildId: string;
  userAgent: string;
  provider: string;
  modelId: string;
  /** GPU adapter description on the WebGPU path, or '' when running on CPU. */
  adapter: string;
  /** Model load time, ms, or null when not measured. */
  loadMs: number | null;
  /** Warm inference times, ms. */
  timings: readonly number[];
  /** Raw-mask statistics from the most recent run, or null when no run yet. */
  maskStats: MaskStats | null;
  /** Whether the raw mask tripped the "squashed mask" heuristic. */
  maskSuspect: boolean;
  crossOriginIsolated: boolean;
  hardwareConcurrency: number | null;
}

/**
 * Renders the report as plain text. Every line is `key: value` so it stays
 * readable when pasted into a chat or an issue, and the mask line is the exact
 * evidence the ghost-image investigation asks a tester to capture.
 */
export function buildDeviceReport(input: DeviceReportInput): string {
  const warm =
    input.timings.length > 0
      ? `${input.timings.map((t) => t.toFixed(0)).join(', ')} ms ` +
        `(avg ${(input.timings.reduce((a, b) => a + b, 0) / input.timings.length).toFixed(0)} ms)`
      : 'none';
  const lines = [
    'SmartCutAI device report',
    `build: ${input.buildId}`,
    `user agent: ${input.userAgent}`,
    `cross-origin isolated: ${input.crossOriginIsolated ? 'yes' : 'no'}`,
    `hardware concurrency: ${input.hardwareConcurrency ?? 'unknown'}`,
    `provider: ${input.provider || 'unknown'}`,
    `gpu adapter: ${input.adapter || '(none — CPU path)'}`,
    `model: ${input.modelId || 'unknown'}`,
    `model load: ${input.loadMs != null ? `${input.loadMs.toFixed(0)} ms` : 'not measured'}`,
    `warm inference: ${warm}`,
  ];
  if (input.maskStats) {
    lines.push(`raw mask: ${formatMaskStats(input.maskStats)}`);
    lines.push(
      `raw mask check: ${input.maskSuspect ? 'SUSPECT — mean in [0.45, 0.8] and not bimodal' : 'ok (bimodal)'}`,
    );
  } else {
    lines.push('raw mask: not measured yet (run the background removal first)');
  }
  return lines.join('\n');
}
