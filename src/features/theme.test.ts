import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isThemePreference, nextTheme, resolveTheme, THEME_STORAGE_KEY } from './theme';

describe('resolveTheme', () => {
  it('follows the system setting when the preference is "system"', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('lets an explicit preference override the system setting', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('nextTheme', () => {
  it('flips the resolved mode', () => {
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('light');
  });
});

describe('isThemePreference', () => {
  it('accepts the three known preferences', () => {
    for (const value of ['system', 'light', 'dark']) {
      expect(isThemePreference(value)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isThemePreference('sepia')).toBe(false);
    expect(isThemePreference(null)).toBe(false);
    expect(isThemePreference(1)).toBe(false);
  });
});

describe('THEME_STORAGE_KEY', () => {
  it('is a stable namespaced key', () => {
    expect(THEME_STORAGE_KEY).toBe('smartcutai:theme');
  });

  it('matches the key the pre-paint bootstrap reads (public/theme-init.js)', () => {
    const bootstrap = readFileSync(resolve(__dirname, '..', '..', 'public', 'theme-init.js'), 'utf8');
    expect(bootstrap).toContain(`'${THEME_STORAGE_KEY}'`);
  });
});
