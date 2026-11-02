// Copies the legal/privacy documents into dist/ so the app footer's links work
// on the deployed static site (the files live at the repository root, which is
// not part of the build output). They are served as plain Markdown, which is
// readable in the browser and needs no extra tooling.
//
// The source files stay the single copy; this only mirrors them into the build.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');

const DOCS = [
  'PRIVACY.md',
  'THIRD_PARTY_LEGAL_NOTICES.md',
  'LICENSE_AUDIT.md',
  'MODEL_CARD.md',
];

if (!existsSync(DIST)) {
  console.error('copy-legal-docs: dist/ not found — run `vite build` first.');
  process.exit(1);
}

for (const name of DOCS) {
  const src = resolve(ROOT, name);
  if (!existsSync(src)) {
    console.error(`copy-legal-docs: missing ${name}`);
    process.exit(1);
  }
  copyFileSync(src, resolve(DIST, name));
}
console.log(`copy-legal-docs: copied ${DOCS.length} documents into dist/`);
