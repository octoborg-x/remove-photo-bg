// Downloads CC0 / Pexels-licensed test images used by the Phase 1 smoke test.
// Sources recorded in test-images/SOURCES.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const IMAGES = [
  {
    // Public Domain (U.S. federal government work, DPLA aggregator). Dog (fur/hair).
    url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/5/52/Official_Portrait_of_Buddy_the_Dog_-_DPLA_-_8bb24feae78ce1f060addb5682fc48e6.jpg/960px-Official_Portrait_of_Buddy_the_Dog_-_DPLA_-_8bb24feae78ce1f060addb5682fc48e6.jpg',
    out: 'test-images/animal-buddy-dog.jpg',
    source: 'https://commons.wikimedia.org/wiki/File:Official_Portrait_of_Buddy_the_Dog_-_DPLA_-_8bb24feae78ce1f060addb5682fc48e6.jpg',
  },
  {
    // Public Domain (museum/DAH, CH collections). Product (perfume bottle) on plain background.
    url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/13/Scent_Bottle_%28CH_18157659%29.jpg/960px-Scent_Bottle_%28CH_18157659%29.jpg',
    out: 'test-images/product-scent-bottle.jpg',
    source: 'https://commons.wikimedia.org/wiki/File:Scent_Bottle_(CH_18157659).jpg',
  },
  {
    // Public Domain. Glass/translucency.
    url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/6/67/Glass_wine_white_background.jpg/960px-Glass_wine_white_background.jpg',
    out: 'test-images/glass-wine.jpg',
    source: 'https://commons.wikimedia.org/wiki/File:Glass_wine_white_background.jpg',
  },
];

for (const img of IMAGES) {
  const dest = resolve(ROOT, img.out);
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(img.url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${img.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  console.log(`OK  ${img.out}  ${buf.length} bytes  <- ${img.source}`);
}

writeFileSync(
  resolve(ROOT, 'test-images/SOURCES.md'),
  `# Test image sources (Phase 1)\n\n` +
    IMAGES.map((i) => `- \`${i.out}\` — ${i.source.replace('https://', '')} (source URL preserved)`).join('\n') +
    '\n',
);
console.log('Wrote test-images/SOURCES.md');