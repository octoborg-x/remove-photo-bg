// The Studio console used to be a single scrolling <pre> plus a fixed "Pipeline"
// step list. It is now a compact, categorised view: the progress pipeline is
// shown as one row of status dots, and every log line is filed under a category
// so the matching dot can flash and its category can be expanded on demand.
// Kept pure (no DOM) so the classification rules are unit-testable.

export type ConsoleCategory =
  | 'model'
  | 'download'
  | 'processing'
  | 'export'
  | 'privacy'
  | 'general';

/** Display order of the categories, both for the dots and the log groups. */
export const CONSOLE_CATEGORIES: readonly ConsoleCategory[] = [
  'model',
  'download',
  'processing',
  'export',
  'privacy',
  'general',
];

export interface ConsoleCategoryMeta {
  id: ConsoleCategory;
  label: string;
  /** One-line explanation shown in the collapsed group header. */
  hint: string;
}

export const CONSOLE_CATEGORY_META: Record<ConsoleCategory, ConsoleCategoryMeta> = {
  model: { id: 'model', label: 'Model', hint: 'On-device engine and runtime' },
  download: { id: 'download', label: 'Download', hint: 'One-time model download' },
  processing: { id: 'processing', label: 'Processing', hint: 'Background removal run' },
  export: { id: 'export', label: 'Export', hint: 'Format and file output' },
  privacy: { id: 'privacy', label: 'Privacy', hint: 'Stays on this device' },
  general: { id: 'general', label: 'General', hint: 'Other activity' },
};

export interface ClassifiedLogLine {
  category: ConsoleCategory;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export function classifyLogLine(line: string): ClassifiedLogLine {
  const level: ClassifiedLogLine['level'] = /\bERROR\b/i.test(line)
    ? 'error'
    : /\bWARNING\b/i.test(line)
      ? 'warn'
      : 'info';

  const t = line.toLowerCase();
  let category: ConsoleCategory;
  if (/error|warning|failed|abort|out of memory|bad_alloc|timeout|timed out/.test(t)) category = 'general';
  else if (/download|fetch|cache|asset|on this device|manifest/.test(t)) category = 'download';
  // Processing before model: a removal line may mention the model but belongs to
  // the run, not to the engine's setup.
  else if (/mask|cut-out|cutout|recover|background|feather|threshold|rendered|remov|inference/.test(t)) category = 'processing';
  else if (/model|provider|runtime|webgpu|wasm|engine|gpu|adapter|segment/.test(t)) category = 'model';
  else if (/export|download link|format|png|jpe?g|webp|creating your image|encode/.test(t)) category = 'export';
  else if (/privacy|local|never leaves|nothing leaves|upload/.test(t)) category = 'privacy';
  else category = 'general';

  return { category, level, text: line };
}

export interface ConsoleLogState {
  /** Every line filed under its category, in arrival order. */
  byCategory: Record<ConsoleCategory, ClassifiedLogLine[]>;
  /** Categories that have received at least one line (dot is "live"). */
  active: Set<ConsoleCategory>;
}

export function emptyConsoleLogState(): ConsoleLogState {
  return {
    byCategory: {
      model: [],
      download: [],
      processing: [],
      export: [],
      privacy: [],
      general: [],
    },
    active: new Set(),
  };
}

/** Append a line; returns the line's category so the caller can flash its dot. */
export function appendLogLine(state: ConsoleLogState, line: string): ConsoleCategory {
  const classified = classifyLogLine(line);
  state.byCategory[classified.category].push(classified);
  state.active.add(classified.category);
  return classified.category;
}
