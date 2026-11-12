// Decides whether to warn before the first model download.
//
// The model is tens of megabytes (~58 MB for the single shipped artifact), which is real money
// on a metered cellular link and instant on Wi-Fi. This module is the pure
// decision layer: it reads the (non-standard) Network Information API, decides
// whether the connection looks metered, and produces the exact confirmation copy
// the page shows. Keeping it DOM-free makes the decision unit-testable.
//
// The API is Chromium-only and is often a coarse hint ("4g" means "at least 4G",
// not "currently on 4G"), so on an ambiguous link the app asks before a large
// first download rather than assuming. Consent lasts for the session only; it is
// never remembered across visits.

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
 * Classifies the current connection from the Network Information API plus a
 * coarse mobile-device hint. Absent or ambiguous data resolves to 'unknown' on
 * a desktop, which the caller treats as unmetered — the API is Chromium-only
 * and reports no `type` on most desktops, so "unknown" must not mean "ask".
 *
 * On a phone or tablet, however, a fast link with no Wi-Fi signal is treated as
 * cellular. Chrome on Android caps the reported downlink for cellular and often
 * omits `type` for privacy, so a 4G phone reports only `effectiveType: '4g'` and
 * would otherwise be classified 'unknown' and download silently over mobile
 * data. Erring toward asking on a mobile device is deliberate: the prompt is a
 * confirmation, not a block, and its copy says the link "may be" metered.
 */
export function classifyConnection(
  info: NetworkInformationLike | null,
  deviceMobile = false,
): ConnectionClass {
  if (info) {
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
  }
  // No positive Wi-Fi signal. On a mobile device assume mobile data so the user
  // is asked before a large download (see the note above).
  if (deviceMobile) return 'cellular';
  return 'unknown';
}

function readDeviceMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData && typeof uaData.mobile === 'boolean') return uaData.mobile;
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua);
}

/** Classifies the live connection, e.g. for the periodic model auto-fetch. */
export function currentConnectionClass(deviceMobile?: boolean): ConnectionClass {
  const info = readConnection();
  const mobile = deviceMobile === undefined ? readDeviceMobile() : deviceMobile;
  return classifyConnection(info, mobile);
}

export interface AutoFetchOptions {
  /** Live connection class. Only an unmetered link (Wi-Fi/ethernet, or an
   *  unknown desktop link) may auto-download; cellular and data-saver never do. */
  connection: ConnectionClass;
  /** The model is already on this device (Cache API). */
  cached: boolean;
  /** The model has already loaded in this page. */
  ready: boolean;
  /** A model load is already running, so a second one would be wasted. */
  inFlight: boolean;
}

/** True unless the link looks metered (cellular or data-saver). */
export function isUnmeteredConnection(connection: ConnectionClass): boolean {
  return connection !== 'cellular' && connection !== 'metered';
}

/** True when the link may cost the user data (cellular or data-saver). */
export function isMeteredConnection(connection: ConnectionClass): boolean {
  return !isUnmeteredConnection(connection);
}

export type ConnectionChangeAction = 'none' | 'start' | 'pause';

/**
 * What a change of connection class should do to the model download, decided
 * purely so the live "change" handler is trivial and unit-testable.
 *
 *   - `'pause'`: a download was in flight and the link just became metered, so
 *     stop it rather than spend the user's data plan unasked.
 *   - `'start'`: nothing is downloading and an unmetered link just appeared, so
 *     warm the cache in the background (the periodic loop's job).
 *   - `'none'`: anything else — an already-unmetered link, a metered link with no
 *     download running, or a switch that does not cross the metered boundary.
 *
 * `active` is true while a model download is in flight. A switch between two
 * metered links (cellular → data-saver) is still a pause: both are metered.
 */
export function connectionChangeAction(
  from: ConnectionClass,
  to: ConnectionClass,
  active: boolean,
): ConnectionChangeAction {
  if (active) return isMeteredConnection(to) ? 'pause' : 'none';
  return isMeteredConnection(from) && isUnmeteredConnection(to) ? 'start' : 'none';
}

/**
 * The notice shown when a download is paused because the connection became
 * metered. States that the transfer stopped, and how to continue, so the
 * interruption does not read as a failure.
 */
export function meteredSwitchNotice(sizeBytes: number, label?: string): string {
  const size = sizeBytes > 0 ? formatBytes(sizeBytes) : 'a large file';
  const named = label ? ` (${label})` : '';
  return (
    `You switched to mobile data, so the model download${named} was paused to save your plan. ` +
    `It is about ${size} and is kept on this device once downloaded. ` +
    'Tap Download Model to continue on mobile data, or reconnect to Wi-Fi to finish automatically.'
  );
}

/**
 * The periodic model auto-fetch decision. The page fetches the model in the
 * background on a timer so a first visit warms the on-device cache without the
 * user having to pick a photo. A tick starts a download only when the connection
 * is unmetered (never cellular or data-saver) and the model is not already on
 * this device, not loaded, and not already being fetched. Every other case is a
 * no-op, so the timer is safe to leave running; a load that failed is retried on
 * the next tick because the model is still absent.
 */
export function shouldAutoFetchModel(opts: AutoFetchOptions): boolean {
  return (
    isUnmeteredConnection(opts.connection) &&
    !opts.cached &&
    !opts.ready &&
    !opts.inFlight
  );
}

export interface PreflightOptions {
  /** Model size in bytes; 0/undefined when unknown. */
  sizeBytes?: number;
  /** Below this size a download is never worth interrupting. Default 25 MB. */
  warnThresholdBytes?: number;
  /** Injected for tests; defaults to the real Network Information API. */
  info?: NetworkInformationLike | null;
  /**
   * Whether this looks like a phone/tablet. Injected for tests; defaults to a
   * coarse user-agent check. A mobile device with no Wi-Fi signal is treated as
   * metered (see `classifyConnection`).
   */
  deviceMobile?: boolean;
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
  const deviceMobile = opts.deviceMobile === undefined ? readDeviceMobile() : opts.deviceMobile;
  const connection = classifyConnection(info, deviceMobile);
  const threshold = opts.warnThresholdBytes ?? DEFAULT_WARN_THRESHOLD;
  const size = opts.sizeBytes ?? 0;
  const large = size === 0 || size >= threshold;
  const metered = connection === 'cellular' || connection === 'metered';
  return { connection, warn: metered && large, summary: describeConnection(info, connection) };
}

export interface DownloadGateOptions extends PreflightOptions {
  /** The model is already on this device (Cache API), so there is nothing to download. */
  cached?: boolean;
  /** Consent already given this session, or a deliberate ?model=/?provider= action. */
  confirmed?: boolean;
}

/**
 * The full preflight decision, in one place so it is unit-testable: prompt only
 * when the connection looks metered AND the model is not already cached AND the
 * user has not already confirmed this session. Either of those makes the
 * download proceed straight away.
 */
export function shouldConfirmDownload(opts: DownloadGateOptions = {}): boolean {
  if (opts.confirmed || opts.cached) return false;
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
    'It is kept on this device, so it only happens once. We will ask again next visit.\n\n' +
    'Your photo is never uploaded; everything runs in your browser.'
  );
}
