// Background options for the Studio result: a small palette of solid colours, a
// transparent option, and a custom picker with an alpha channel. Kept pure (no
// DOM) so the format/alpha rules are unit-testable; main.ts maps a choice onto
// the result preview, the compare view and the export encoder.

import type { ExportFormat } from './export-image';

export interface SwatchColor {
  id: string;
  label: string;
  /** CSS colour used for the swatch chip. */
  hex: string;
}

/** Solid colours offered as one-tap swatches. */
export const PALETTE: readonly SwatchColor[] = [
  { id: 'white', label: 'White', hex: '#ffffff' },
  { id: 'light', label: 'Light grey', hex: '#f1f5f9' },
  { id: 'grey', label: 'Grey', hex: '#94a3b8' },
  { id: 'black', label: 'Black', hex: '#0f172a' },
  { id: 'blue', label: 'Blue', hex: '#2563eb' },
  { id: 'green', label: 'Green', hex: '#16a34a' },
  { id: 'amber', label: 'Amber', hex: '#f59e0b' },
  { id: 'red', label: 'Red', hex: '#dc2626' },
];

export interface BackgroundChoice {
  /** 'transparent' keeps the alpha channel; 'color' paints a solid/alpha colour. */
  kind: 'transparent' | 'color';
  /** '#rrggbb' — only meaningful when kind is 'color'. */
  hex: string;
  /** 0–100 (percent). 100 is fully opaque; lower values keep some see-through. */
  alpha: number;
}

export const TRANSPARENT: BackgroundChoice = { kind: 'transparent', hex: '#ffffff', alpha: 100 };
export const DEFAULT_BACKGROUND: BackgroundChoice = TRANSPARENT;

const HEX_RE = /^#[0-9a-f]{6}$/i;

export function isBackgroundChoice(value: unknown): value is BackgroundChoice {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<BackgroundChoice>;
  return (
    (v.kind === 'transparent' || v.kind === 'color') &&
    typeof v.hex === 'string' &&
    HEX_RE.test(v.hex) &&
    typeof v.alpha === 'number' &&
    Number.isFinite(v.alpha)
  );
}

export function isTransparent(choice: BackgroundChoice): boolean {
  // A zero-alpha colour is transparent in effect, so treat it as such.
  return choice.kind === 'transparent' || choice.alpha <= 0;
}

function clampAlpha(alpha: number): number {
  if (!Number.isFinite(alpha)) return 100;
  return Math.max(0, Math.min(100, Math.round(alpha)));
}

/**
 * `#rrggbb` plus an alpha percentage as an `rgba()` string. The paint and the
 * export share this so the preview and the encoded file can never disagree.
 */
export function toRgba(choice: BackgroundChoice): string {
  const hex = HEX_RE.test(choice.hex) ? choice.hex : '#ffffff';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${clampAlpha(choice.alpha) / 100})`;
}

/**
 * The opaque colour an alpha-less format (JPG) must flatten onto. A see-through
 * choice is flattened onto its colour at full opacity (a JPEG cannot carry alpha,
 * and this matches what the user picked); a fully transparent choice — including
 * a colour set to 0% alpha — falls back to white.
 */
export function opaqueFallback(choice: BackgroundChoice): string {
  if (isTransparent(choice)) return '#ffffff';
  return choice.hex;
}

/**
 * The export format to switch to when the user picks a background. A transparent
 * background keeps its alpha, so it needs PNG; a solid colour has no alpha to
 * carry, so it exports as JPG; a see-through colour (custom alpha < 100) still
 * needs PNG to preserve the transparency.
 */
export function formatForChoice(choice: BackgroundChoice): ExportFormat {
  if (isTransparent(choice)) return 'png';
  return choice.alpha >= 100 ? 'jpeg' : 'png';
}

/** Human-readable summary for the download button and the console. */
export function describeChoice(choice: BackgroundChoice): string {
  if (isTransparent(choice)) return 'transparent';
  return `${choice.hex} at ${clampAlpha(choice.alpha)}%`;
}
