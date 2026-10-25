// Downloads the pinned BiRefNet_lite ONNX artifact and verifies its SHA-256.
//
// The model is the official BiRefNet_lite backbone exported at a 512x512 fixed
// input. The 1024x1024 export peaks at ~1.5 GB of transient activation memory,
// which no browser WASM heap or mobile GPU could satisfy (std::bad_alloc on
// OrtRun). At 512 the peak is ~1.1 GB and the same model runs everywhere.
//
// Provenance: every backbone tensor in this file is bit-identical to
// ZhengPeng7/BiRefNet_lite (model.safetensors), and the decoder convolutions
// are that checkpoint with BatchNorm folded in (float32 rounding only).
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
    url: 'https://huggingface.co/Phoenix-ActuallyFree/BiRefNet_lite_512-ONNX/resolve/main/onnx/model.onnx',
    out: 'public/models/model_512.onnx',
    sha256: 'eaafaa10f19c63b77e2bae77bf4b2f59054c208ea08b8c6648f95ef36a3b6b87',
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