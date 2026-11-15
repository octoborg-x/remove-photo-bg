-- 0001_quality_reports.sql
--
-- Quality reports submitted from the "Report a quality problem" form. Only the
-- minimal, non-identifying fields are stored. No names, emails, accounts,
-- image bytes, image URLs, EXIF, cookies, tokens, or IP addresses are accepted.
--
-- Apply with:  npx wrangler d1 migrations apply smartcutai-reports --remote

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

-- Queries filter and sort by time and group by category; index both.
CREATE INDEX IF NOT EXISTS idx_quality_reports_created_at ON quality_reports (created_at);
CREATE INDEX IF NOT EXISTS idx_quality_reports_category ON quality_reports (category);
