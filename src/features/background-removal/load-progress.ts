// Presentation helpers for model-loading progress. Kept separate from the worker
// so the labels live in one place and the worker stays free of UI concerns.
import type { LoadStage } from './types';

export const STAGE_LABELS: Record<LoadStage, string> = {
  queued: 'Queued',
  runtime: 'Preparing runtime',
  'cache-check': 'Checking on-device storage',
  'cache-hit': 'Loading from this device',
  downloading: 'Downloading model',
  downloaded: 'Model downloaded',
  'creating-session': 'Building inference session',
  'session-ready': 'Session ready',
  ready: 'Ready',
};

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / 1048576;
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${mb.toFixed(1)} MB`;
}

export function formatElapsed(ms: number): string {
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${Math.round(secs % 60)}s`;
}

/**
 * One-line status for the stage, e.g.
 *   "Downloading model… 42% (78.1 MB / 185.0 MB, 12.3s)"
 *   "Loading from this device (cached)"
 */
export function describeProgress(msg: {
  stage: LoadStage;
  percent: number;
  bytes?: number;
  totalBytes?: number;
  elapsedMs: number;
  detail?: string;
}): string {
  const elapsed = formatElapsed(msg.elapsedMs);
  const label = STAGE_LABELS[msg.stage] ?? msg.stage;
  const pct = Math.max(0, Math.min(100, Math.round(msg.percent)));
  switch (msg.stage) {
    case 'downloading': {
      const transferred = msg.bytes ? formatBytes(msg.bytes) : '0 B';
      const total = msg.totalBytes ? ` / ${formatBytes(msg.totalBytes)}` : '';
      return `${label}… ${pct}% (${transferred}${total}, ${elapsed})`;
    }
    case 'cache-hit':
      return `${label} (cached, ${elapsed})`;
    case 'creating-session':
    case 'runtime':
    case 'cache-check':
      return `${label}… (${elapsed})`;
    case 'ready':
      return `${label} (${elapsed})`;
    default:
      return msg.detail ? `${label}… ${msg.detail} (${elapsed})` : `${label}… (${elapsed})`;
  }
}
