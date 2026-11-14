// Quality-problem categories. The ids are stable and mirror the Worker's D1
// allowlist (cloudflare/analytics-worker/src/schema.ts). Labels are user-facing.

export type ReportCategory =
  | 'subject_partially_removed'
  | 'background_remains'
  | 'poor_edges'
  | 'wrong_object_removed'
  | 'fine_details_lost'
  | 'processing_failed'
  | 'download_problem'
  | 'other';

export interface ReportCategoryInfo {
  id: ReportCategory;
  label: string;
}

export const REPORT_CATEGORIES: readonly ReportCategoryInfo[] = [
  { id: 'subject_partially_removed', label: 'Subject or object partially removed' },
  { id: 'background_remains', label: 'Background remains visible' },
  { id: 'poor_edges', label: 'Poor edges or halo artifacts' },
  { id: 'wrong_object_removed', label: 'Wrong object removed' },
  { id: 'fine_details_lost', label: 'Hair or fine details not preserved' },
  { id: 'processing_failed', label: 'Image processing failed' },
  { id: 'download_problem', label: 'Download problem' },
  { id: 'other', label: 'Other' },
];

export const REPORT_DESCRIPTION_MAX = 500;

export function isReportCategory(value: unknown): value is ReportCategory {
  return typeof value === 'string' && REPORT_CATEGORIES.some((c) => c.id === value);
}

export function categoryLabel(id: ReportCategory): string {
  return REPORT_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}
