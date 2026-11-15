# Analytics architecture

_Status: implemented 2026-11-14. This document describes the privacy-first
product-analytics and quality-reporting system added to SmartCutAI. It is a
factual description of the code in this repository, not a legal warranty._

## Goals

Measure, without collecting personal data:

1. how visitors reach the site (landing-page traffic);
2. whether image processing succeeds, independently of failures;
3. whether a visitor processes their **first** image successfully;
4. whether a download action is initiated;
5. whether visitors return (anonymous, browser-level);
6. what quality problems users report.

Hard constraints: no image bytes, filenames, EXIF, image URLs, or image metadata
ever leave the device; no accounts; no email; no fingerprinting; no third-party
analytics SDKs; the whole thing must fit Cloudflare's free tier.

## Separation of responsibilities

| Component | Responsibility |
|---|---|
| Cloudflare Web Analytics | Landing-page visits, page views, referrers, geography |
| Cloudflare Worker | Receive, validate, and route custom events and quality reports |
| Workers Analytics Engine | Store and query product-usage metrics |
| Cloudflare D1 | Store submitted quality reports |
| Existing frontend | Emit lifecycle events and provide the report form |

**R2 is deliberately not used.** It would only make sense if we stored images,
which this system never does.

```text
SmartCutAI frontend (Vite SPA, unchanged image pipeline)
       |
       |-- Cloudflare Web Analytics   (JS beacon; landing-page visits)
       |
       |-- src/features/analytics/     (consent-gated, best-effort client)
       |       |
       |       v
       |    POST /api/events  ---->  Cloudflare Worker  ---->  Workers Analytics Engine
       |                                                          |
       |                                                          v
       |                                                    SQL API / dashboard
       |
       |-- Quality-report form  ---->  POST /api/quality-reports  ---->  Worker  ---->  D1
                                                                                          |
                                                                                          v
                                                                                  review reports
```

The Worker is a **separate deployable** under `cloudflare/analytics-worker/`. The
frontend deployment (Vercel) is unchanged except for the small analytics client
and the CSP `connect-src` entry (see below).

## Frontend modules

All under `src/features/analytics/`:

| File | Responsibility |
|---|---|
| `consent.ts` | Consent state machine (`granted` / `denied` / `unset`), storage read/write. |
| `visitor-id.ts` | Anonymous visitor id (crypto UUID), 90-day rotation, session id. |
| `events.ts` | The closed allowlist of event names and field limits. |
| `report-categories.ts` | The eight problem categories (single source of truth). |
| `event-client.ts` | Best-effort transport (`sendBeacon` → `keepalive` fetch). |
| `report-client.ts` | Client-side validation and submission of a quality report. |
| `analytics.ts` | The `AnalyticsClient` facade; enforces the counting rules. |
| `ui.ts` | DOM wiring: consent banner, footer control, report form. |
| `web-analytics.ts` | Loads the Cloudflare Web Analytics beacon after consent. |

The quality-report form does **not** define its own diagnostics shape. It reuses
the SAME structure the Console's **Copy report** button builds —
`src/features/diagnostics/diagnostic-report.ts` (one schema, one
`buildDiagnosticReport()`). The upload view is produced by
`src/features/diagnostics/diagnostic-report-upload.ts`, which clears the
fingerprint fields (`browser.userAgent`, `browser.platform`) and scrubs urls,
paths, emails, and IPs from every remaining string before the report can be
attached. The local Copy report is unaffected (it stays on the device).

`src/main.ts` imports only `initAnalyticsUi` and the thin `track…` helpers, and
calls them at the real lifecycle points. Nothing in the image pipeline depends on
analytics: every call is synchronous and fire-and-forget, and a missing or
disabled client is a no-op.

## Lifecycle → event mapping

| Real moment in the app | Event |
|---|---|
| A consented session begins (`setConsent(true)` or boot with a prior grant) | `app_session_started` |
| Inference is about to run (model ready, `runSmoke` past `waitForModel`) | `image_processing_started` |
| A valid, displayable cut-out exists (`finishResult`, first call per run) | `image_processing_succeeded` |
| The first success for this visitor id (once per id) | `first_successful_image_processed` |
| A run fails (`error()` while a run is in progress) | `image_processing_failed` |
| The user clicks the download link (href present) | `download_initiated` |
| A quality report is stored by the Worker | `quality_report_submitted` |

Counting rules are enforced in `AnalyticsClient` and asserted in
`analytics.test.ts`:

- `image_processing_started` fires **at most once per run** (a `running` latch);
- `image_processing_succeeded` fires **at most once per run**, only after a valid
  result, and **never** for a failed/cancelled run;
- `first_successful_image_processed` fires **once per visitor id** (a persisted
  marker keyed by the id);
- `image_processing_failed` only counts against a run that **actually started**,
  so an upload rejection never skews the failure rate, and repeated error
  callbacks do not double-count;
- `download_initiated` is emitted on each genuine download click, and is labelled
  "Download initiated" everywhere — never "saved".

## Consent model

- The banner appears only while the decision is `unset` **and** an endpoint is
  configured.
- No persistent identifier is created, and no event is sent, before a grant.
- Declining stores `denied`; the client then sends nothing.
- The footer **Analytics settings** control withdraws consent, deletes the
  anonymous id and the first-success marker, and re-opens the choice.
- Image processing, downloads, and quality reports are **never** blocked by the
  consent choice. The report form's diagnostics checkbox is its own opt-in and is
  independent of analytics consent.

### Cloudflare Web Analytics vs custom analytics

These are **two different technologies**, and this project gates both behind the
same in-app consent choice:

- **Cloudflare Web Analytics** is a cookieless beacon served by Cloudflare
  (`static.cloudflareinsights.com`) that reports to `cloudflareinsights.com`. It
  records page views, referrers, and coarse geography without cookies or
  fingerprinting. It is **not** shipped as a static `<script>` tag: the beacon is
  injected by `src/features/analytics/web-analytics.ts` only after the visitor
  allows analytics, so nothing loads before the decision. It is enabled by
  setting `VITE_CF_WEB_ANALYTICS_TOKEN` (empty disables it).
- **Custom analytics** (this system) writes product events to Workers Analytics
  Engine and quality reports to D1. It is gated by the same consent banner.

The beacon cannot be un-loaded once injected, so withdrawing consent stops future
custom events and clears the anonymous id, but the already-loaded page keeps the
beacon for that page view. This is documented in `PRIVACY.md`.

The privacy notice (`PRIVACY.md`) states both, and the in-app banner explains
what is measured.

## Data minimisation

Sent to the Worker (events): event name, a random event id, the anonymous visitor
id, the session id, a client timestamp, the build id, the model id, the provider,
a coarse failure reason, and a report category. **No** IP address is stored: the
Worker uses the visitor id as the Analytics Engine sampling index and never writes
the client IP. The Worker adds its own receive timestamp; the client timestamp is
validated and clamped, never trusted as authoritative.

Sent to the Worker (quality reports): category, optional ≤500-character
description, build id, optional model id, and — only if explicitly ticked — the
diagnostics JSON. **No** name, email, account, contact field, image, image URL,
EXIF, cookie, token, storage dump, or filesystem path.

The diagnostics come from the shared builder
(`src/features/diagnostics/diagnostic-report.ts`). Before upload they pass
through `sanitizeDiagnosticsForUpload()`, which clears the browser fingerprint
fields and **scrubs** URLs, absolute paths, emails, and IP addresses from any
remaining string. The same structure is rendered locally by the Copy report
button; only the sanitized view is ever attached to a server request.

## CSP and network

The app ships a strict CSP generated by `scripts/write-headers.mjs`. The
`connect-src` directive gains the analytics Worker origin **only** when
`VITE_ANALYTICS_ENDPOINT` is set; otherwise it stays `connect-src 'self'`. Event
and report POSTs use a `text/plain` body so they are CORS "simple requests" (no
preflight, and `navigator.sendBeacon` can reach them cross-origin).

A repository guard (`no-upload-path.test.ts`) still forbids any image-bearing
upload anywhere in the shipped source; the analytics module is the single
sanctioned network writer and is separately asserted to contain no canvas /
`ImageData` / data-URL / `File` / image-MIME code.

## Failure isolation

- Event delivery is best-effort: `sendBeacon` first, then a `keepalive` fetch;
  every failure is swallowed. The UI never awaits a send.
- If the Worker is unreachable, or `VITE_ANALYTICS_ENDPOINT` is empty, or the
  user declines, or `ANALYTICS_DISABLED=1`, the app behaves exactly as before.
- A Worker-side storage error still returns success to the browser, so the client
  never retries or blocks.

## How to disable analytics without disabling the app

- **Frontend:** leave `VITE_ANALYTICS_ENDPOINT` empty (the default). No banner,
  no events, no CSP change.
- **Worker:** set `ANALYTICS_DISABLED=1`. The endpoint stays up (so nothing in
  the app breaks) but writes nothing.
- **Consent:** a visitor can decline or withdraw at any time.
