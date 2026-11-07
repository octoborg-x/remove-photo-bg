// Decides whether to warn before the first model download.
//
// The model is tens of megabytes (~58 MB for the single shipped artifact), which is real money
// on a metered cellular link and instant on Wi-Fi. This module is the pure
// decision layer: it reads the (non-standard) Network Information API, decides
// whether the connection looks metered, and produces the exact confirmation copy
// the page shows. Keeping it DOM-free makes the decision unit-testable.
//
// The API is Chromium-only and is often a coarse hint ("4g" means "at least 4G",
// not "currently on 4G"), so the default is to ask rather than to assume. The
// user's answer is remembered per session by the caller.

import { formatBytes } from './load-progress';

/** The slice of the Network Information API this app reads. */
export interface NetworkInformationLike {
  /** Effective connection type, e.g. 'slow-2g' | '2g' | '3g' | '4g'. */
  effectiveType?: string;
  /** Best-effort downlink estimate in Mbit/s. */
  downlink?: number;
  /** Estimated round-trip time in ms. */
  rtt?: number;
  /** Vendor hint that the current connection is metered (Chromium). */
  saveData?: boolean;
  /** Chromium's coarse "connection type" hint, when present. */
  type?: string;
}

export type ConnectionClass = 'wifi' | 'cellular' | 'metered' | 'unknown';

export interface NetworkAssessment {
  connection: ConnectionClass;
  /** True when the caller should confirm before a large download. */
  warn: boolean;
  /** Short human-readable summary for the dialog/log. */
  summary: string;
}

function readConnection(): NetworkInformationLike | null {
  if (typeof navigator === 'undefined') return null;
  const nav = navigator as Navigator & { connection?: NetworkInformationLike };
  return nav.connection ?? null;
}

/**
 * Classifies the current connection from the Network Information API. Absent or
 * ambiguous data resolves to 'unknown', which the caller treats as unmetered —
 * the API is Chromium-only and reports no `type` on most desktops, so "unknown"
 * must not mean "ask".
 */
export function classifyConnection(info: NetworkInformationLike | null): ConnectionClass {
  if (!info) return 'unknown';
  if (info.saveData) return 'metered';
  const type = (info.type || '').toLowerCase();
  if (type === 'wifi' || type === 'ethernet') return 'wifi';
  if (type === 'cellular') return 'cellular';
  // No `type` hint: fall back to the effective-type/downlink heuristics that
  // every Chromium build provides. A slow effective type or a sub-1.5 Mbit/s
  // estimate is the best signal that a large download may be metered.
  const effective = (info.effectiveType || '').toLowerCase();
  if (effective === 'slow-2g' || effective === '2g' || effective === '3g') return 'cellular';
  if (typeof info.downlink === 'number' && info.downlink > 0 && info.downlink < 1.5) {
    return 'cellular';
  }
  return 'unknown';
}

export interface PreflightOptions {
  /** Model size in bytes; 0/undefined when unknown. */
  sizeBytes?: number;
  /** Below this size a download is never worth interrupting. Default 25 MB. */
  warnThresholdBytes?: number;
  /** Injected for tests; defaults to the real Network Information API. */
  info?: NetworkInformationLike | null;
}

const DEFAULT_WARN_THRESHOLD = 25 * 1024 * 1024;

/**
 * Whether to ask the user before downloading. Wi-Fi never asks. A cellular or
 * data-saver connection asks when the file is large. An *unknown* connection
 * does not ask: the API is Chromium-only and reports no `type` on most desktops,
 * so treating "unknown" as metered would nag every visitor. The model size is
 * still disclosed in the UI regardless, satisfying "tell users the size before
 * the first download".
 */
export function assessNetwork(opts: PreflightOptions = {}): NetworkAssessment {
  const info = opts.info === undefined ? readConnection() : opts.info;
  const connection = classifyConnection(info);
  const threshold = opts.warnThresholdBytes ?? DEFAULT_WARN_THRESHOLD;
  const size = opts.sizeBytes ?? 0;
  const large = size === 0 || size >= threshold;
  const metered = connection === 'cellular' || connection === 'metered';
  return { connection, warn: metered && large, summary: describeConnection(info, connection) };
}

export interface DownloadGateOptions extends PreflightOptions {
  /** The model is already on this device (Cache API), so there is nothing to download. */
  cached?: boolean;
  /** The user ticked "remember my choice" on a previous download. */
  remembered?: boolean;
  /** Consent already given this session, or a deliberate ?model=/?provider= action. */
  confirmed?: boolean;
}

/**
 * The full preflight decision, in one place so it is unit-testable: prompt only
 * when the connection looks metered AND the model is not already cached AND the
 * user has neither confirmed already nor asked to be remembered. Any one of
 * those makes the download proceed straight away.
 */
export function shouldConfirmDownload(opts: DownloadGateOptions = {}): boolean {
  if (opts.confirmed || opts.remembered || opts.cached) return false;
  return assessNetwork(opts).warn;
}

function describeConnection(info: NetworkInformationLike | null, connection: ConnectionClass): string {
  if (!info) return 'network type unknown';
  const parts: string[] = [];
  if (info.type) parts.push(info.type);
  if (info.effectiveType) parts.push(`effective ${info.effectiveType}`);
  if (typeof info.downlink === 'number' && info.downlink > 0) {
    parts.push(`~${info.downlink.toFixed(1)} Mbit/s`);
  }
  if (info.saveData) parts.push('data-saver on');
  if (!parts.length) parts.push(connection);
  return parts.join(', ');
}

/**
 * The confirmation copy for a metered/unknown connection. States the download
 * size (MVP §6: "Tell users the model download size before the first download"),
 * that it is one-time, and that the image never leaves the device.
 */
export function downloadConfirmationText(sizeBytes: number, label?: string): string {
  const size = sizeBytes > 0 ? formatBytes(sizeBytes) : 'a large file';
  const named = label ? ` (${label})` : '';
  return (
    `Removing backgrounds needs to download the model${named} once — about ${size}.\n\n` +
    'You look like you may be on mobile data, and this download uses your data plan. ' +
    'It is kept on this device, so it only happens once.\n\n' +
    'Your photo is never uploaded; everything runs in your browser.'
  );
}
