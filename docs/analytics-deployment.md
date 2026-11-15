# Analytics deployment

_Status: implemented 2026-11-14. The Cloudflare resources in this document were
**not** created automatically; the account API token available in this
environment can deploy Workers but cannot create D1 databases or query Analytics
Engine, so those steps are manual. Nothing here claims a deployment succeeded
unless you performed it._

The MVP targets Cloudflare's **free tier** at $0. See "Free-tier limits" below.

## Components to create

| Resource | Binding | Free tier |
|---|---|---|
| Worker `smartcutai-analytics` | — | 100,000 requests/day |
| Workers Analytics Engine dataset `smartcutai_events` | `ANALYTICS` | 100,000 data points/day, 10,000 read queries/day, 3-month retention |
| D1 database `smartcutai-reports` | `DB` | 5 GB storage, 100,000 rows written/day, 5,000,000 rows read/day |
| Rate limiting binding | `EVENTS_RATE_LIMITER` | free |

All are available on the Workers **Free** plan. Workers Analytics Engine does not
require a paid plan for this usage and, per Cloudflare's current documentation,
usage is not billed yet; the limits above are what apply. **Do not** enable a paid
plan or a paid service for this MVP.

## 1. Prerequisites

```bash
npm ci                     # installs wrangler (devDependency)
npx wrangler login         # or: export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
```

The Worker lives at `cloudflare/analytics-worker/` and is deployed with its own
config, `cloudflare/analytics-worker/wrangler.toml`.

## 2. Create the D1 database

Already created for this project:

```toml
[[d1_databases]]
binding = "DB"
database_name = "smartcutai-reports"
database_id = "eeeed6a7-3375-4704-9c75-94486c73dbec"
```

This id is committed in `wrangler.toml` (it is not a secret). To recreate it
elsewhere:

```bash
cd cloudflare/analytics-worker
npx wrangler d1 create smartcutai-reports
```

Wrangler prints a `database_id`; paste it into `wrangler.toml`.

Apply the migration:

```bash
# Local (wrangler dev) database:
npx wrangler d1 migrations apply smartcutai-reports --local
# Remote (production) database:
npx wrangler d1 migrations apply smartcutai-reports --remote
```

Verify:

```bash
npx wrangler d1 execute smartcutai-reports --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table'"
```

## 3. Analytics Engine dataset

No manual step: the `smartcutai_events` dataset is created automatically the
**first time** the Worker writes a data point (it is declared under
`[[analytics_engine_datasets]]` in `wrangler.toml`).

## 4. Configure allowed origins

`ALLOWED_ORIGINS` in `wrangler.toml` lists the real SmartCutAI origins. The
Worker rejects any request whose `Origin` is not listed (HTTP 403), so the
endpoint cannot be called from another site. It is set to the four live Vercel
origins:

```toml
[vars]
ALLOWED_ORIGINS = "https://remove-photo-bg.vercel.app,https://remove-photo-bg-git-main-miloudlafttah849-cells-projects.vercel.app,https://remove-photo-bg-git-staging-miloudlafttah849-cells-projects.vercel.app,https://remove-photo-bg-git-production-miloudlafttah849-cells-projects.vercel.app"
ANALYTICS_DISABLED = "0"
```

The bare `remove-photo-bg.vercel.app` is the production alias; the three
`-git-<branch>-…` URLs are the per-branch deployments. Add the local dev origin
(`http://localhost:3000`) to `.dev.vars` only, not to this list.

## 5. Local development

```bash
cd cloudflare/analytics-worker
cp .dev.vars.example .dev.vars      # add http://localhost:3000 to ALLOWED_ORIGINS
npx wrangler dev                    # runs the Worker with local D1 + AE simulation
```

Then run the frontend against it:

```bash
# In the repo root:
VITE_ANALYTICS_ENDPOINT=http://localhost:8787 npm run dev
```

`.dev.vars` is git-ignored. It holds **no secrets** (the Worker has none); do not
put a Cloudflare API token there.

## 6. Deploy the Worker

```bash
cd cloudflare/analytics-worker
npx wrangler deploy
```

Note the deployed URL (`https://smartcutai-analytics.<account>.workers.dev`).

## 7. Point the frontend at the Worker

Set `VITE_ANALYTICS_ENDPOINT` for the build. On Vercel, add it as an environment
variable (Production + Preview + Development), then redeploy. The build reads it
in two places:

- `src/main.ts` passes it to the analytics client;
- `scripts/write-headers.mjs` adds its origin to the CSP `connect-src`.

With it **empty** (the default), analytics is fully disabled: no banner, no
events, and `connect-src 'self'`.

### Allow the Worker origin in the deployed CSP

The Vercel deployment serves the CSP from `vercel.json` (the `vercel:build`
command does not run `write-headers.mjs`), so when you enable analytics you must
add the Worker origin to `connect-src` there by hand:

```jsonc
// vercel.json  ->  headers[0].headers[]  ->  Content-Security-Policy
// before:
"connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co;"
// after (append the Worker origin):
"connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co https://smartcutai-analytics.<account>.workers.dev;"
```

Other hosts that read a generated `dist/_headers` (e.g. Cloudflare Pages) get the
right `connect-src` automatically from `VITE_ANALYTICS_ENDPOINT` via
`scripts/write-headers.mjs`. **Do not** widen `connect-src` to `*`; add only the
one Worker origin.

## 8. Cloudflare Web Analytics

Landing-page traffic uses Cloudflare's own Web Analytics, separately from the
custom events. It is **consent-gated**: the beacon is injected by the app only
after the visitor allows analytics (see
`src/features/analytics/web-analytics.ts`), not shipped as a static tag.

1. Cloudflare dashboard → **Web Analytics** → **Add a site**.
2. Enter the site hostname; open **Manage site** and copy the **token** value from
   the snippet (the `"token"` field inside `data-cf-beacon`).
3. Set `VITE_CF_WEB_ANALYTICS_TOKEN` to that token (Vercel → Settings →
   Environment Variables, all environments) and redeploy. The build then:
   - injects the beacon after consent at runtime, and
   - adds `https://static.cloudflareinsights.com` to `script-src` and
     `https://cloudflareinsights.com` to `connect-src` in the generated CSP.
4. Data appears within a few minutes. Verify under **Web Analytics → the site**:
   page views, referrers, and geography.

Do **not** paste the raw snippet into `index.html`: that would load the beacon
before consent and be blocked by the CSP. The token-driven injection is the only
supported path.

If the site is proxied through Cloudflare, Web Analytics can be enabled
automatically instead of via the beacon. **Do not** collect full URLs with
query parameters in any page-view tracking.

### Vercel CSP for the beacon

The deployed CSP comes from `vercel.json` (the `vercel:build` command does not run
`write-headers.mjs`), so the beacon origins are already added there. If you deploy
without Web Analytics, remove them to keep the policy minimal.

## Free-tier limits (checked 2026-11-14)

- **Workers Free:** 100,000 requests/day; 10 ms CPU/request; 64 env vars/Worker.
- **Workers Analytics Engine:** 100,000 data points written/day and 10,000 read
  queries/day on Free; data retained **3 months**; sampling may apply under load
  (weight aggregates by `_sample_interval`).
- **D1 Free:** 5 GB storage, 100,000 rows written/day, 5,000,000 rows read/day,
  10 databases, 7-day Time Travel.

The rate limiter caps a single source at 120 requests/60 s per Cloudflare
location, so a burst cannot exhaust the daily quota from one client.

## Observing the metrics

Three places, no custom admin app required.

### A. Cloudflare Web Analytics
Dashboard → **Web Analytics** → site: total page views, unique visitors, traffic
sources/referrers, landing-page traffic over time, and geography.

### B. Workers Analytics Engine
Dashboard → **Workers & Pages** → **Analytics Engine** → `smartcutai_events`
(the dashboard shows simple charts), or use the SQL API. Create a token with
**Account → Account Analytics → Read**, then:

```bash
export CF_ACCOUNT_ID=...        # 32-char account id
export CF_ANALYTICS_TOKEN=...   # the token above
ae() { curl -s "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql" \
         -H "Authorization: Bearer ${CF_ANALYTICS_TOKEN}" --data "$1"; }
```

The SQL API reads your dataset by name (`smartcutai_events`). Every event row has
a `timestamp` (server receive time), `blob1` = event name, `blob2` = app version,
`blob3` = model id, `blob4` = provider, `blob5` = failure reason, `blob6` = report
category, `blob7` = event id, `blob8` = session id, `double1` = client time (ms),
and `_sample_interval` (sampling weight).

**1. Daily successful image processing**

```sql
SELECT toStartOfDay(timestamp) AS day,
       SUM(_sample_interval) AS successes
FROM smartcutai_events
WHERE blob1 = 'image_processing_succeeded'
  AND timestamp >= NOW() - INTERVAL '30' DAY
GROUP BY day
ORDER BY day
```

**2. First successful image processing (total)**

```sql
SELECT SUM(_sample_interval) AS first_successes
FROM smartcutai_events
WHERE blob1 = 'first_successful_image_processed'
```

**3. Download initiations (daily)**

```sql
SELECT toStartOfDay(timestamp) AS day,
       SUM(_sample_interval) AS downloads
FROM smartcutai_events
WHERE blob1 = 'download_initiated'
  AND timestamp >= NOW() - INTERVAL '30' DAY
GROUP BY day
ORDER BY day
```

**4. Processing failure rate (daily)**

```sql
SELECT toStartOfDay(timestamp) AS day,
       SUM(if(blob1 = 'image_processing_failed', _sample_interval, 0)) AS failures,
       SUM(if(blob1 = 'image_processing_started', _sample_interval, 0)) AS starts,
       failures / starts AS failure_rate
FROM smartcutai_events
WHERE blob1 IN ('image_processing_started', 'image_processing_failed')
  AND timestamp >= NOW() - INTERVAL '30' DAY
GROUP BY day
ORDER BY day
```

**5. Daily active anonymous visitors**

```sql
SELECT toStartOfDay(timestamp) AS day,
       count(DISTINCT index1) AS visitors
FROM smartcutai_events
WHERE timestamp >= NOW() - INTERVAL '30' DAY
GROUP BY day
ORDER BY day
```

**6. Returning sessions**

A session that is not the first ever seen for its visitor. Count sessions where
the visitor has an earlier session:

```sql
SELECT count() AS returning_sessions
FROM (
  SELECT blob8 AS session_id,
         min(timestamp) AS first_seen
  FROM smartcutai_events
  WHERE blob1 = 'app_session_started'
  GROUP BY session_id
) AS s
WHERE s.first_seen > (
  SELECT min(timestamp) FROM smartcutai_events WHERE blob1 = 'app_session_started'
)
```

A simpler proxy — sessions started per day minus new visitor ids that day —
is available in the dashboard; the definition used in the product docs is
"an `anonymous_visitor_id` seen in an earlier session".

**7. Quality reports by category**

```sql
SELECT blob6 AS category,
       SUM(_sample_interval) AS reports
FROM smartcutai_events
WHERE blob1 = 'quality_report_submitted'
GROUP BY category
ORDER BY reports DESC
```

**8. Quality reports over time**

```sql
SELECT toStartOfDay(timestamp) AS day,
       SUM(_sample_interval) AS reports
FROM smartcutai_events
WHERE blob1 = 'quality_report_submitted'
  AND timestamp >= NOW() - INTERVAL '30' DAY
GROUP BY day
ORDER BY day
```

**9. Processing-to-download conversion rate**

```sql
SELECT SUM(if(blob1 = 'download_initiated', _sample_interval, 0)) AS downloads,
       SUM(if(blob1 = 'image_processing_succeeded', _sample_interval, 0)) AS successes,
       downloads / successes AS conversion
FROM smartcutai_events
WHERE timestamp >= NOW() - INTERVAL '30' DAY
```

**Provider split / model split** (extra): group any of the above by `blob4`
(provider) or `blob3` (model id).

### C. D1 (quality reports)
Dashboard → **D1** → `smartcutai-reports` → **Console**, or the `wrangler d1
execute` commands in `docs/quality-reporting.md`.

## Disabling analytics

- **Frontend:** clear `VITE_ANALYTICS_ENDPOINT` and redeploy. No banner, no
  events, `connect-src 'self'`.
- **Worker:** set `ANALYTICS_DISABLED = "1"` and redeploy. The endpoint keeps
  answering but writes nothing.
- **A visitor** can decline or withdraw at any time.

Neither affects image processing or downloads.

## Security notes

- The Worker holds no credentials; access is granted by bindings only.
- Never put a Cloudflare API token or D1 credential in frontend code or in
  `.env.example` / `.dev.vars.example`.
- The SQL API token (Account Analytics Read) is a read-only server-side secret;
  keep it out of the repo.
