// The app's privacy guarantee is that nothing leaves the device — no third-party
// resource loads. Webfonts are the easy way to break that silently: a CDN
// <link> adds an external request that no unit test would otherwise notice. This
// pins the policy: the page shell loads no external resources, fonts are
// self-hosted, and the CSP keeps the font/style origins same-origin.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

describe('self-hosted assets (no third-party resource loads)', () => {
  const html = read('index.html');

  it('index.html loads no external stylesheet, script, or font', () => {
    const externalResource = /<(?:link|script|img)\b[^>]*\b(?:href|src)=["']https?:\/\//i;
    expect(externalResource.test(html)).toBe(false);
    expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  it('self-hosted fonts exist and are wired through src/fonts.css', () => {
    expect(existsSync(resolve(ROOT, 'src/assets/fonts/plus-jakarta-sans-latin.woff2'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'src/assets/fonts/jetbrains-mono-latin.woff2'))).toBe(true);
    const css = read('src/fonts.css');
    expect(css).toMatch(/url\(['"]\.\/assets\/fonts\/plus-jakarta-sans-latin\.woff2['"]\)/);
    expect(css).toMatch(/url\(['"]\.\/assets\/fonts\/jetbrains-mono-latin\.woff2['"]\)/);
    expect(css).not.toMatch(/https?:\/\//);
  });

  it('the CSP keeps font/style/connect origins same-origin', () => {
    const headers = read('scripts/write-headers.mjs');
    expect(headers).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    expect(headers).toMatch(/font-src 'self'/);
    expect(headers).toMatch(/style-src 'self' 'unsafe-inline'"/);

    const vercel = read('vercel.json');
    expect(vercel).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    expect(vercel).toMatch(/font-src 'self'/);
  });
});
