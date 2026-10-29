// Uploads the model + WASM binaries to a Cloudflare R2 bucket (S3-compatible).
//
// These files are too large for the static host, so they live on R2 and the
// service worker proxies them. Objects are uploaded with the same relative keys
// the app requests (`models/…`, `wasm/…`) and with `Cache-Control: immutable`
// (the filenames are content-pinned, so a change means a new name).
//
// Configure via environment (never commit these):
//   R2_ACCOUNT_ID          Cloudflare account id
//   R2_ACCESS_KEY_ID       R2 API token access key
//   R2_SECRET_ACCESS_KEY   R2 API token secret
//   R2_BUCKET              bucket name (e.g. remove-bg-assets)
//
// Usage: node scripts/upload-assets-r2.mjs
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
const missing = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter(
  (k) => !process.env[k],
);
if (missing.length) {
  console.error(`Missing env: ${missing.join(', ')}`);
  process.exit(1);
}

// The S3 SDK is only needed for uploading, so it is not a runtime dependency.
let S3Client, PutObjectCommand, HeadObjectCommand;
try {
  ({ S3Client, PutObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3'));
} catch {
  console.error('Install the uploader first:  npm i -D @aws-sdk/client-s3');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

// Local file -> object key. Keys mirror the app's request paths.
const FILES = [
  ['public/models/model_512.onnx', 'models/model_512.onnx'],
  ['public/wasm/ort-wasm-simd-threaded.mjs', 'wasm/ort-wasm-simd-threaded.mjs'],
  ['public/wasm/ort-wasm-simd-threaded.wasm', 'wasm/ort-wasm-simd-threaded.wasm'],
  ['public/wasm/ort-wasm-simd-threaded.jsep.mjs', 'wasm/ort-wasm-simd-threaded.jsep.mjs'],
  ['public/wasm/ort-wasm-simd-threaded.jsep.wasm', 'wasm/ort-wasm-simd-threaded.jsep.wasm'],
  ['public/wasm/ort.all.min.js', 'wasm/ort.all.min.js'],
];

// Correct content types matter: `importScripts` refuses a script served as
// octet-stream, and streaming WASM compilation wants application/wasm.
function contentTypeFor(key) {
  if (key.endsWith('.wasm')) return 'application/wasm';
  if (key.endsWith('.mjs') || key.endsWith('.js')) return 'text/javascript';
  return 'application/octet-stream';
}

for (const [rel, key] of FILES) {
  const path = resolve(ROOT, rel);
  if (!existsSync(path)) {
    console.error(`Missing ${rel} — run \`npm run fetch-models\` first.`);
    process.exit(1);
  }
  const body = readFileSync(path);
  const sha256 = createHash('sha256').update(body).digest('hex');

  // Skip objects whose stored checksum already matches: the artifacts are
  // content-pinned and large, so re-uploading them on every deploy would burn
  // Class A operations and time for no change.
  const existing = await s3
    .send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }))
    .catch(() => null);
  if (existing?.Metadata?.sha256 === sha256) {
    console.log(`Unchanged ${key}  sha256=${sha256}`);
    continue;
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentTypeFor(key),
      CacheControl: 'public, max-age=31536000, immutable',
      Metadata: { sha256 },
    }),
  );
  console.log(`Uploaded ${key}  ${body.length} bytes  sha256=${sha256}`);
}
console.log('Done. Set VITE_ASSET_BASE to the bucket public URL when building the site.');
