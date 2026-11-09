// Generates the landing-page before/after demo pairs from the repo's own
// Phase-1 test photos and the model's committed cut-outs.
//
// The sources are the three public-domain product photos under test-images/;
// the "after" images are the model's own outputs already committed under
// smoke-results/benchmark-t4/quality-t4/ (*_512_cut.png, RGBA). Everything is
// downscaled and re-encoded to WebP in a headless browser so the page stays
// light. Output: public/demo/<name>-before.webp and <name>-after.webp.
//
// Usage: node scripts/build-demo-assets.mjs
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_BIN || '/usr/bin/chromium';
const OUT = resolve(ROOT, 'public', 'demo');
const MAX_W = 720;

const PAIRS = [
  {
    name: 'glass-wine',
    before: 'test-images/glass-wine.jpg',
    after: 'smoke-results/benchmark-t4/quality-t4/glass-wine_512_cut.png',
  },
  {
    name: 'product-scent-bottle',
    before: 'test-images/product-scent-bottle.jpg',
    after: 'smoke-results/benchmark-t4/quality-t4/product-scent-bottle_512_cut.png',
  },
  {
    name: 'animal-buddy-dog',
    before: 'test-images/animal-buddy-dog.jpg',
    after: 'smoke-results/benchmark-t4/quality-t4/animal-buddy-dog_512_cut.png',
  },
];

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.goto('about:blank');

/** Downscales + re-encodes one image file to a data URL in the browser. */
async function shrink(path, mime) {
  const dataUrl = `data:${mime};base64,${readFileSync(resolve(ROOT, path)).toString('base64')}`;
  return page.evaluate(
    async (src, maxW) => {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('decode failed'));
        i.src = src;
      });
      const scale = Math.min(1, maxW / img.naturalWidth);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      const webp = c.toDataURL('image/webp', 0.86);
      const out = webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/png');
      return { dataUrl: out, w, h };
    },
    dataUrl,
    MAX_W,
  );
}

function writeDataUrl(path, dataUrl) {
  const b64 = dataUrl.split(',')[1];
  writeFileSync(path, Buffer.from(b64, 'base64'));
}

for (const p of PAIRS) {
  for (const [kind, rel, mime] of [
    ['before', p.before, 'image/jpeg'],
    ['after', p.after, 'image/png'],
  ]) {
    if (!existsSync(resolve(ROOT, rel))) {
      console.warn(`skip ${p.name} ${kind}: missing ${rel}`);
      continue;
    }
    const { dataUrl, w, h } = await shrink(rel, mime);
    const dest = resolve(OUT, `${p.name}-${kind}.webp`);
    writeDataUrl(dest, dataUrl);
    const ext = dataUrl.slice(5, dataUrl.indexOf(';'));
    console.log(`OK  public/demo/${p.name}-${kind}.webp  ${w}x${h}  (${ext})`);
  }
}

await browser.close();
