// Light/dark theming. The page follows the operating system by default; an
// explicit user choice (stored locally) overrides it. All colour decisions live
// in CSS custom properties (src/style.css), so this module only resolves which
// mode is active and keeps it in sync — it never hardcodes a colour.

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** localStorage key for the user's explicit choice. Absent means "follow system". */
export const THEME_STORAGE_KEY = 'smartcutai:theme';

/** `data-*` attribute set on <html>; drives the `[data-theme]` CSS selectors. */
export const THEME_ATTRIBUTE = 'data-theme';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** The concrete mode to render, given the preference and the OS setting. */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'light' || preference === 'dark') return preference;
  return systemPrefersDark ? 'dark' : 'light';
}

/**
 * The mode the toggle should switch to next. From the resolved mode the user
 * sees, flip to the other one; 'system' resolves first so the first click always
 * produces a visible change.
 */
export function nextTheme(current: ResolvedTheme): ResolvedTheme {
  return current === 'dark' ? 'light' : 'dark';
}
