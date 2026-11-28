// SEO/GEO artifacts are static files with no runtime code, so nothing else would
// notice if they drifted: a sitemap pointing at a page the build does not copy,
// a canonical host that disagrees with robots.txt, or JSON-LD that stops
// parsing. These assertions keep the crawl surface internally consistent.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const CANONICAL_ORIGIN = 'https://remove-photo-bg.vercel.app';

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

describe('SEO/GEO artifacts', () => {
  const html = read('index.html');
  const robots = read('public/robots.txt');
  const sitemap = read('public/sitemap.xml');
  const llms = read('public/llms.txt');

  it('declares one canonical origin across the page, robots.txt and sitemap', () => {
    expect(html).toContain(`<link rel="canonical" href="${CANONICAL_ORIGIN}/" />`);
    expect(html).toContain(`<meta property="og:url" content="${CANONICAL_ORIGIN}/" />`);
    expect(robots).toContain(`Sitemap: ${CANONICAL_ORIGIN}/sitemap.xml`);
    expect(sitemap).toContain(`<loc>${CANONICAL_ORIGIN}/</loc>`);
  });

  it('welcomes the AI search crawlers named in the GEO brief', () => {
    for (const agent of [
      'OAI-SearchBot',
      'ChatGPT-User',
      'PerplexityBot',
      'ClaudeBot',
      'Google-Extended',
    ]) {
      expect(robots).toMatch(new RegExp(`User-agent: ${agent}\\nAllow: /`));
    }
  });

  it('only lists URLs that the deployment actually serves', () => {
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs.length).toBeGreaterThan(1);
    const copiedDocs = read('scripts/copy-legal-docs.mjs');
    for (const loc of locs) {
      expect(loc.startsWith(`${CANONICAL_ORIGIN}/`)).toBe(true);
      const path = loc.slice(CANONICAL_ORIGIN.length + 1);
      if (!path) continue;
      const servedFromPublic = existsSync(resolve(ROOT, 'public', path));
      const copiedAtBuild = copiedDocs.includes(`'${path}'`);
      expect(servedFromPublic || copiedAtBuild, `${path} is neither in public/ nor copied at build`).toBe(true);
    }
  });

  it('publishes llms.txt with the verifiable model facts', () => {
    expect(llms).toMatch(/^# SmartCutAI/m);
    expect(llms).toContain('birefnet-lite-engine-512-int8-fp16');
    expect(llms).toContain('60,763,193');
    expect(llms).toContain('59/64');
    expect(llms).toMatch(/\/MODEL_CARD\.md/);
    expect(llms).toMatch(/\/PRIVACY\.md/);
  });

  it('emits parseable JSON-LD covering product, FAQ and how-to entities', () => {
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    expect(blocks.length).toBeGreaterThan(0);
    const graph = blocks
      .flatMap((m) => {
        const data = JSON.parse(m[1]) as { '@graph'?: Array<{ '@type': string }>; '@type'?: string };
        return data['@graph'] ?? [data as { '@type': string }];
      })
      .map((node) => node['@type']);
    expect(graph).toEqual(expect.arrayContaining(['SoftwareApplication', 'FAQPage', 'HowTo']));
  });

  it('ships a 1200×630 social preview image and points the cards at it', () => {
    const png = readFileSync(resolve(ROOT, 'public/assets/brand/smartcutai-og.png'));
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    const ogUrl = `${CANONICAL_ORIGIN}/assets/brand/smartcutai-og.png`;
    expect(html).toContain(`<meta property="og:image" content="${ogUrl}" />`);
    expect(html).toContain(`<meta name="twitter:image" content="${ogUrl}" />`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });
});
