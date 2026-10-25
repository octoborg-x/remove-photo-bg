// Downloads the pinned BiRefNet_lite ONNX artifacts and verifies their SHA-256.
// Phase 1 (model feasibility): fetch exactly the fp16 ONNX export from
// onnx-community/BiRefNet_lite-ONNX at revision de15b22ba131738a16dff04aab8bdf8dc32e3ac1.
// Also copies the onnxruntime-web WASM files we need into public/wasm.
//
// Usage: node scripts/fetch-models.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const MODELS = [
  {
    url: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/de15b22ba131738a16dff04aab8bdf8dc32e3ac1/onnx/model_fp16.onnx',
    out: 'public/models/model_fp16.onnx',
    sha256: 'd39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402',
  },
];

// WASM files from onnxruntime-web that must be self-hosted.
const SOURCE_WASM_DIR = resolve(ROOT, 'node_modules/onnxruntime-web/dist');
const WASM_FILES = [
  // WASM (CPU) backend loader + binary
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  // WebGPU (JSEP) backend loader + binary (used when WebGPU is available)
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
];

for (const m of MODELS) {
  const dest = resolve(ROOT, m.out);
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${m.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const h = createHash('sha256').update(buf).digest('hex');
  if (h !== m.sha256) {
    throw new Error(`SHA-256 mismatch for ${m.out}: expected ${m.sha256}, got ${h}`);
  }
  writeFileSync(dest, buf);
  console.log(`OK  ${m.out}  ${buf.length} bytes  sha256=${h}`);
}

mkdirSync(resolve(ROOT, 'public/wasm'), { recursive: true });
for (const f of WASM_FILES) {
  const src = resolve(SOURCE_WASM_DIR, f);
  const dest = resolve(ROOT, 'public/wasm', f);
  const data = await import('node:fs/promises').then(({ readFile }) => readFile(src));
  await import('node:fs/promises').then(({ writeFile }) => writeFile(dest, data));
  const h = createHash('sha256').update(data).digest('hex');
  console.log(`OK  public/wasm/${f}  ${data.length} bytes  sha256=${h}`);
}
console.log('All artifacts downloaded and verified.');