// MVP §9: "Ensure no app-level image upload path exists." The app must never
// POST image data anywhere. This scans the shipped source (and the page markup)
// for the constructs that would create one, so a future change that adds a
// fetch/XHR/beacon/form upload of image data fails the build instead of silently
// shipping.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function shippedSources(): string[] {
  const files = [
    ...walk(join(ROOT, 'src')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')),
    join(ROOT, 'index.html'),
    join(ROOT, 'public', 'no-dev-server.js'),
  ];
  return files;
}

// Patterns that would mean image bytes are sent off-device. `fetch`/`XHR` are
// only flagged when paired with an upload verb or an image-bearing body.
const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: 'XMLHttpRequest', re: /XMLHttpRequest/ },
  { name: 'navigator.sendBeacon', re: /sendBeacon/ },
  { name: 'POST/PUT/PATCH upload', re: /method\s*:\s*['"](POST|PUT|PATCH)['"]/i },
  { name: 'FormData', re: /new\s+FormData\b/ },
  { name: 'fetch with body', re: /fetch\([^)]*\bbody\s*:/s },
];

describe('no app-level image upload path (MVP §9)', () => {
  const sources = shippedSources();

  it('finds the source files it expects to scan', () => {
    expect(sources.length).toBeGreaterThan(5);
    expect(sources.some((f) => f.endsWith('main.ts'))).toBe(true);
  });

  for (const { name, re } of FORBIDDEN) {
    it(`does not use ${name}`, () => {
      const offenders = sources.filter((f) => re.test(readFileSync(f, 'utf8')));
      expect(offenders, `found ${name} in: ${offenders.join(', ')}`).toEqual([]);
    });
  }

  it('does not reference a remote API endpoint', () => {
    const offenders = sources.filter((f) => /https?:\/\/[^\s'"]*\/api\//.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
