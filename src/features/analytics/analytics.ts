// The analytics facade. It ties consent, the anonymous visitor identity, and the
// event transport together, and it enforces the counting rules that the unit
// tests assert:
//
//   • nothing is sent unless consent is granted;
//   • no persistent identifier exists until consent is granted;
//   • image_processing_started is emitted at most once per run;
//   • first_successful_image_processed is emitted at most once per visitor id;
//   • success/failure/download events are emitted exactly when the real action
//     happens, never on a failed or cancelled operation.
//
// Every method is synchronous and fire-and-forget: it never returns a promise the
// UI must await, so analytics can never delay or block image processing.

import {
  isAnalyticsAllowed,
  readConsent,
  writeConsent,
  clearConsent,
  shouldAskForConsent,
  type ConsentState,
  type StorageLike,
} from './consent';
import {
  clearVisitor,
  randomId,
  resolveSessionId,
  resolveSessionStart,
  type VisitorRecord,
} from './visitor-id';
import {
  ANALYTICS_EVENT_NAMES,
  FIELD_LIMITS,
  type AnalyticsEvent,
  type AnalyticsEventName,
  type FailureReason,
} from './events';
import { browserTransport, endpointUrl, type Transport } from './event-client';

export const FIRST_SUCCESS_STORAGE_KEY = 'remove-bg:analytics-first-success';

export interface AnalyticsConfig {
  /** Base endpoint, e.g. https://smartcutai-analytics.<acct>.workers.dev . Empty disables analytics. */
  endpoint: string;
  appVersion: string;
  storage?: StorageLike | null;
  sessionStorage?: StorageLike | null;
  transport?: Transport;
  now?: () => number;
  isoTimestamp?: () => string;
}

interface FirstSuccessRecord {
  visitorId: string;
  at: number;
}

function readFirstSuccess(storage: StorageLike | null | undefined): FirstSuccessRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(FIRST_SUCCESS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FirstSuccessRecord>;
    if (typeof parsed?.visitorId === 'string' && typeof parsed.at === 'number') {
      return { visitorId: parsed.visitorId, at: parsed.at };
    }
  } catch {
    // ignore corrupt record
  }
  return null;
}

/** Pure rule: has this visitor id already recorded a first success? */
export function hasRecordedFirstSuccess(
  record: FirstSuccessRecord | null,
  visitorId: string,
): boolean {
  return record !== null && record.visitorId === visitorId;
}

function clamp(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

export class AnalyticsClient {
  private readonly cfg: AnalyticsConfig;
  private readonly storage: StorageLike | null;
  private readonly sessionStorage: StorageLike | null;
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly isoTimestamp: () => string;

  private consent: ConsentState;
  private visitor: VisitorRecord | null = null;
  private sessionId: string | null = null;
  private returningThisSession = false;
  /** True between a processing start and its settle (success/failure). */
  private running = false;
  private succeededThisRun = false;

  constructor(cfg: AnalyticsConfig) {
    this.cfg = cfg;
    this.storage = cfg.storage ?? null;
    this.sessionStorage = cfg.sessionStorage ?? null;
    this.transport = cfg.transport ?? browserTransport();
    this.now = cfg.now ?? (() => Date.now());
    this.isoTimestamp = cfg.isoTimestamp ?? (() => new Date().toISOString());
    this.consent = readConsent(this.storage);
  }

  /** True when an endpoint is configured at all (deployment switch). */
  get enabled(): boolean {
    return this.cfg.endpoint.trim().length > 0;
  }

  get consentState(): ConsentState {
    return this.consent;
  }

  get shouldAsk(): boolean {
    return this.enabled && shouldAskForConsent(this.consent);
  }

  private get allowed(): boolean {
    return this.enabled && isAnalyticsAllowed(this.consent);
  }

  private eventsUrl(): string {
    return endpointUrl(this.cfg.endpoint, '/api/events');
  }

  /**
   * Grant or deny analytics. Granting lazily creates the anonymous identity;
   * denying wipes any existing identity so a rejection leaves nothing behind.
   */
  setConsent(granted: boolean): void {
    this.consent = granted ? 'granted' : 'denied';
    writeConsent(this.storage, this.consent);
    if (granted) {
      this.ensureIdentity();
      this.sessionStarted();
    } else {
      this.forgetIdentity();
    }
  }

  /** Withdraw consent and remove the anonymous identifier. */
  reset(): void {
    clearConsent(this.storage);
    this.consent = 'unset';
    this.forgetIdentity();
  }

  private forgetIdentity(): void {
    clearVisitor(this.storage);
    this.visitor = null;
    this.sessionId = null;
    this.returningThisSession = false;
    try {
      this.storage?.removeItem(FIRST_SUCCESS_STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  private ensureIdentity(): void {
    if (!this.allowed) return;
    if (!this.visitor) {
      const { record, returning } = resolveSessionStart(this.storage, this.now());
      this.visitor = record;
      this.returningThisSession = returning;
    }
    if (!this.sessionId) this.sessionId = resolveSessionId(this.sessionStorage);
  }

  /** Emit app_session_started. Called once when a consented session begins. */
  sessionStarted(): void {
    if (!this.allowed) return;
    this.ensureIdentity();
    if (!this.visitor) return;
    this.emit('app_session_started');
  }

  /** Whether the current session reused a previously seen visitor id. */
  get isReturning(): boolean {
    return this.returningThisSession;
  }

  private buildEvent(
    name: AnalyticsEventName,
    extra: Partial<AnalyticsEvent> = {},
  ): AnalyticsEvent | null {
    if (!this.visitor || !this.sessionId) return null;
    const event: AnalyticsEvent = {
      event_id: randomId(),
      event_name: name,
      anonymous_visitor_id: this.visitor.id,
      session_id: this.sessionId,
      occurred_at: this.isoTimestamp(),
    };
    const appVersion = clamp(this.cfg.appVersion, FIELD_LIMITS.app_version);
    if (appVersion) event.app_version = appVersion;
    const modelId = clamp(extra.model_id, FIELD_LIMITS.model_id);
    if (modelId) event.model_id = modelId;
    if (extra.processing_provider === 'webgpu' || extra.processing_provider === 'wasm') {
      event.processing_provider = extra.processing_provider;
    }
    const reason = clamp(extra.failure_reason, FIELD_LIMITS.failure_reason);
    if (reason) event.failure_reason = reason;
    const category = clamp(extra.report_category, FIELD_LIMITS.report_category);
    if (category) event.report_category = category;
    return event;
  }

  private emit(name: AnalyticsEventName, extra: Partial<AnalyticsEvent> = {}): void {
    if (!this.allowed) return;
    if (!ANALYTICS_EVENT_NAMES.includes(name)) return;
    this.ensureIdentity();
    const event = this.buildEvent(name, extra);
    if (!event) return;
    // Fire and forget: the promise is intentionally not awaited.
    void this.transport.send(this.eventsUrl(), event).catch(() => false);
  }

  // ——— Lifecycle events ———

  processingStarted(): void {
    if (!this.allowed || this.running) return;
    this.running = true;
    this.succeededThisRun = false;
    this.emit('image_processing_started');
  }

  /**
   * A run produced a valid, displayable result. Emits image_processing_succeeded
   * once per run and first_successful_image_processed once per visitor id.
   */
  processingSucceeded(extra: { model_id?: string; processing_provider?: 'webgpu' | 'wasm' } = {}): void {
    if (!this.allowed || this.succeededThisRun) return;
    this.succeededThisRun = true;
    this.running = false;
    this.emit('image_processing_succeeded', extra);
    if (this.visitor && !hasRecordedFirstSuccess(readFirstSuccess(this.storage), this.visitor.id)) {
      try {
        this.storage?.setItem(
          FIRST_SUCCESS_STORAGE_KEY,
          JSON.stringify({ visitorId: this.visitor.id, at: this.now() } satisfies FirstSuccessRecord),
        );
      } catch {
        // If we cannot remember, still emit; a duplicate is preferable to silence.
      }
      this.emit('first_successful_image_processed', extra);
    }
  }

  processingFailed(reason: FailureReason): void {
    if (!this.allowed) return;
    // Only a run that actually started can fail: this both keeps the failure
    // rate coherent (failures are a subset of started runs) and prevents a
    // second error callback from double-counting one failed run.
    if (!this.running) return;
    this.running = false;
    this.succeededThisRun = false;
    this.emit('image_processing_failed', { failure_reason: reason });
  }

  downloadInitiated(extra: { model_id?: string; processing_provider?: 'webgpu' | 'wasm' } = {}): void {
    if (!this.allowed) return;
    this.emit('download_initiated', extra);
  }

  qualityReportSubmitted(category: string): void {
    if (!this.allowed) return;
    this.emit('quality_report_submitted', { report_category: category });
  }
}

export type { AnalyticsEvent, FailureReason };
