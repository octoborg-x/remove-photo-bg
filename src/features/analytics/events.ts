// The custom product events this client may emit. The set is a closed allowlist
// and the field names/length limits mirror the Worker's validation
// (cloudflare/analytics-worker/src/schema.ts). Keeping the client side minimal
// means an accidental extra property never leaves the browser.

export type AnalyticsEventName =
  | 'app_session_started'
  | 'image_processing_started'
  | 'image_processing_succeeded'
  | 'first_successful_image_processed'
  | 'image_processing_failed'
  | 'download_initiated'
  | 'quality_report_submitted';

export const ANALYTICS_EVENT_NAMES: readonly AnalyticsEventName[] = [
  'app_session_started',
  'image_processing_started',
  'image_processing_succeeded',
  'first_successful_image_processed',
  'image_processing_failed',
  'download_initiated',
  'quality_report_submitted',
];

/** Fields the client is allowed to send, with the same caps the Worker enforces. */
export const FIELD_LIMITS = {
  event_id: 64,
  anonymous_visitor_id: 64,
  session_id: 64,
  app_version: 64,
  model_id: 64,
  processing_provider: 16,
  /** Short, non-identifying reason code for a failure (never a raw message). */
  failure_reason: 64,
  /** Category id for a submitted quality report (mirrors the D1 category). */
  report_category: 32,
} as const;

export type AnalyticsField = keyof typeof FIELD_LIMITS;

export interface AnalyticsEvent {
  event_id: string;
  event_name: AnalyticsEventName;
  anonymous_visitor_id: string;
  session_id: string;
  occurred_at: string;
  app_version?: string;
  model_id?: string;
  processing_provider?: 'webgpu' | 'wasm';
  failure_reason?: string;
  report_category?: string;
}

/** A coarse, non-identifying reason code for a failed run. */
export type FailureReason =
  | 'upload_rejected'
  | 'model_download'
  | 'out_of_memory'
  | 'worker_error'
  | 'processing_error'
  | 'unknown';
