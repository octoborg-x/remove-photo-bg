# Analytics events

_Status: implemented 2026-11-14._

Every custom event is a single JSON object POSTed to
`POST {VITE_ANALYTICS_ENDPOINT}/api/events` with a `text/plain` content type (a
CORS "simple request"). The Worker validates the body against the allowlist
below, adds a server receive timestamp, and writes one Workers Analytics Engine
data point.

## Event names (closed allowlist)

| Event | Emitted when | Emitted at most |
|---|---|---|
| `app_session_started` | A consented session begins | once per session |
| `image_processing_started` | Inference is about to run for a chosen photo | once per run |
| `image_processing_succeeded` | A valid, displayable cut-out exists | once per run |
| `first_successful_image_processed` | The first success for this visitor id | once per visitor id |
| `image_processing_failed` | A run that started fails | once per started run |
| `download_initiated` | The user clicks the download link | once per download action |
| `quality_report_submitted` | A report is stored by the Worker | once per stored report |

Unknown names are rejected with HTTP 400 and are never written.

## Payload fields

Only these properties are accepted. Any other property causes a 400
(`unexpected property`). The Worker never accepts arbitrary browser properties.

| Field | Type | Required | Max length | Notes |
|---|---|---|---|---|
| `event_id` | string | yes | 64 | Random id; `[A-Za-z0-9._:-]+`. |
| `event_name` | string | yes | 40 | One of the allowlist. |
| `anonymous_visitor_id` | string | yes | 64 | Crypto UUID; Analytics Engine sampling index. |
| `session_id` | string | yes | 64 | Per-session id (session storage). |
| `occurred_at` | string | yes | 40 | ISO-8601. Must parse and be within `[-7d, +5min]`. |
| `app_version` | string | no | 64 | The build id. |
| `model_id` | string | no | 64 | e.g. `model_512_int8_fp16`. |
| `processing_provider` | string | no | 16 | `webgpu` or `wasm`. |
| `failure_reason` | string | no | 64 | Coarse code (see below). |
| `report_category` | string | no | 32 | One of the report categories. |

`failure_reason` is a small enum, never a raw error message:
`upload_rejected`, `model_download`, `out_of_memory`, `worker_error`,
`processing_error`, `unknown`.

### Example

```json
{
  "event_id": "9f2c1e70-6b3a-4f0e-9d2a-1c4b7e5a8f01",
  "event_name": "image_processing_succeeded",
  "anonymous_visitor_id": "1b7f5e2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
  "session_id": "a2b3c4d5-e6f7-4a8b-9c0d-1e2f3a4b5c6d",
  "occurred_at": "2026-11-14T09:30:00.000Z",
  "app_version": "20261114T090000",
  "model_id": "model_512_int8_fp16",
  "processing_provider": "wasm"
}
```

## Where each field lands in Workers Analytics Engine

`writeDataPoint` is called once per accepted event with a fixed field order:

| Position | Value |
|---|---|
| `indexes[0]` | `anonymous_visitor_id` (sampling key) |
| `blobs[0]` | `event_name` |
| `blobs[1]` | `app_version` |
| `blobs[2]` | `model_id` |
| `blobs[3]` | `processing_provider` |
| `blobs[4]` | `failure_reason` |
| `blobs[5]` | `report_category` |
| `blobs[6]` | `event_id` |
| `blobs[7]` | `session_id` |
| `doubles[0]` | client event time (ms since epoch) |

The implicit `timestamp` column holds the **server receive time**. The client
timestamp is stored only in `double1` and is never used as the authoritative
time.

## Counting rules (the exact definitions)

- **Successful processing** = a run that produced a valid, displayable cut-out.
  A failed or cancelled run never emits `image_processing_succeeded`.
- **First successful processing** = the first `image_processing_succeeded` for a
  given `anonymous_visitor_id`, tracked with a persisted marker. Clearing browser
  storage creates a new id, so a "first success" can recur for the same person —
  this measures anonymous browser-level behaviour, not verified individuals.
- **Failure rate** = `image_processing_failed` ÷ `image_processing_started`.
  Both are per-run; a failure is always for a run that started.
- **Download initiated** = a click that started a browser download. It does **not**
  prove the file reached disk.
- **Returning visitor** = an `anonymous_visitor_id` seen in an earlier session
  (see the repeat-usage queries in `analytics-deployment.md`).
- **Returning processor** = an id with `image_processing_succeeded` in more than
  one distinct session.

## Limitations

- The browser id is anonymous and browser-local. Clearing storage, switching
  browsers, private mode, or another device all produce a new id.
- Events are best-effort; a blocked/offline send is silently dropped.
- Workers Analytics Engine stores data for **three months** (free and paid) and
  may sample under high volume; use `_sample_interval` in aggregate queries.
- `first_successful_image_processed` is a client-side decision. A user who
  declines analytics produces no id and no events at all.
