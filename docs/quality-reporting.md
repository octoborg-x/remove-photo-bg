# Quality reporting

_Status: implemented 2026-11-14._

A small **Report a quality problem** action appears in the Studio result area.
It is an explicit user action: nothing is submitted until the user chooses a
category and presses **Send report**.

## What the user sees

1. A button under the download control: **Report a quality problem**.
2. A form with:
   - a **required** problem category (a dropdown);
   - an **optional** description, maximum 500 characters (a live counter);
   - an **optional** "Attach technical diagnostics" checkbox — **unchecked by
     default**;
   - when the checkbox is ticked, a preview of the **exact JSON** that will be
     submitted.
3. **Send report** / **Cancel**.

There is no name, email, or contact field anywhere. The form works whether or not
analytics consent was granted.

## Categories

`subject_partially_removed`, `background_remains`, `poor_edges`,
`wrong_object_removed`, `fine_details_lost`, `processing_failed`,
`download_problem`, `other`.

The list lives in `src/features/analytics/report-categories.ts` and is mirrored
by the Worker allowlist in `cloudflare/analytics-worker/src/schema.ts`. The
Worker re-validates; an unknown category is rejected.

## Diagnostics: opt-in and scrubbed

When the user ticks the box, `buildDiagnostics()` collects only
non-identifying application facts:

```json
{
  "app_version": "20261114T090000",
  "model_id": "model_512_int8_fp16",
  "processing_provider": "wasm",
  "gpu_adapter": "Apple M2",
  "webgpu_available": true,
  "cross_origin_isolated": true,
  "last_inference_ms": 812,
  "generated_at": "2026-11-14T09:30:00.000Z"
}
```

Every string is passed through `scrubDiagnosticText()`, which removes URLs,
absolute/POSIX paths, Windows paths, emails, and IPv4 addresses, then bounds the
length. The structure itself has **no field** for a filename, image, EXIF, URL,
cookie, token, storage dump, or path.

The diagnostics are attached **only** when the box is ticked. Copying anything
else in the app never submits diagnostics.

## Storage (D1)

`cloudflare/analytics-worker/migrations/0001_quality_reports.sql`:

```sql
CREATE TABLE IF NOT EXISTS quality_reports (
  id                   TEXT PRIMARY KEY,
  created_at           TEXT NOT NULL,
  category             TEXT NOT NULL,
  description          TEXT,
  app_version          TEXT NOT NULL,
  model_id             TEXT,
  diagnostics_json     TEXT,
  diagnostics_attached INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_quality_reports_created_at ON quality_reports (created_at);
CREATE INDEX IF NOT EXISTS idx_quality_reports_category ON quality_reports (category);
```

- `id` is a server-generated `crypto.randomUUID()`.
- `created_at` is a server timestamp.
- `description` is trimmed, has control characters replaced with spaces, and is
  bounded to 500 characters; an empty description is stored as `NULL`.
- `diagnostics_json` is `NULL` unless the user opted in; `diagnostics_attached`
  records the choice as `0`/`1`.
- The insert is a **parameterized** statement: user input is bound, never
  interpolated into SQL.

## Inspection

The dashboard query editor is the simplest viewer (D1 → your database → Console),
or use the CLI:

```bash
# Recent reports, newest first.
npx wrangler d1 execute smartcutai-reports --remote \
  --command "SELECT created_at, category, description, app_version, model_id, diagnostics_attached FROM quality_reports ORDER BY created_at DESC LIMIT 50"

# Counts by category.
npx wrangler d1 execute smartcutai-reports --remote \
  --command "SELECT category, COUNT(*) AS n FROM quality_reports GROUP BY category ORDER BY n DESC"

# Only reports with diagnostics attached.
npx wrangler d1 execute smartcutai-reports --remote \
  --command "SELECT id, created_at, category, diagnostics_json FROM quality_reports WHERE diagnostics_attached = 1 ORDER BY created_at DESC"
```

The same queries work in the Cloudflare dashboard **D1 → smartcutai-reports →
Console**.

## Privacy

- No personal data is collected, so there is no account, no email, and no
  notification. Reports are reviewed by reading D1.
- Image bytes, image URLs, screenshots, EXIF, cookies, tokens, IP addresses, and
  filesystem paths are never accepted. The Worker rejects any unexpected
  property, a non-object diagnostics value, or an oversized payload.
- A submission is counted once (`quality_report_submitted`) only when the Worker
  confirms storage (HTTP 201).
