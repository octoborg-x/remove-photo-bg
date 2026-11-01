// Downloads the pinned ground-truth/background-removal ONNX artifacts and
// verifies their SHA-256 before writing the model manifest.
//
// Both models are served from the Octoborg/remove-photo-bg Hugging Face space
// (free hosting, CORS-enabled), which is exactly what the deployed service
// worker proxies (VITE_ASSET_BASE). The shipped Phase-2 default is
// `c5_best.onnx` — a weight-only-fp16 distilled student (~94 MiB download while
// keeping fp32 compute); `model_512.onnx` is the Phase-1 fp32 export and stays
// selectable. Every artifact is pinned by URL and SHA-256; the generated
// `public/models-manifest.json` is the single source of truth the UI, the
// service worker, and the smoke harness read.
//
// Also copies the onnxruntime-web WASM files we need into public/wasm.
//
// Usage: node scripts/fetch-models.mjs [--webgpu]
//   --webgpu additionally copies the WebGPU-capable ORT runtime (37+ MiB of
//   files) into public/wasm for hosts that can serve it same-origin.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// All model files live under `models/` in the HF space so the deployed service
// worker (which only proxies `models/` and `wasm/`) serves them the same way
// the local build does.
const HF_SPACE = 'https://huggingface.co/spaces/Octoborg/remove-photo-bg/resolve/main';

const MODELS = [
  {
    id: 'c5_best',
    file: 'models/c5_best.onnx',
    url: `${HF_SPACE}/models/c5_best.onnx`,
    size: 98799684,
    sha256: '099c89de1d9a3da27af3d5329460f543e5d9390fc45e7ba7d0e7360b378d5f97',
    label: 'c5_best (fast, ~94 MB)',
    description:
      'Newer distilled student, weight-only fp16 (~94 MB download). Default model when no other criterion applies.',
    inputSize: 512,
    outputIsProbability: true,
    default: true,
  },
  {
    id: 'model_512',
    file: 'models/model_512.onnx',
    url: `${HF_SPACE}/models/model_512.onnx`,
    size: 193514682,
    sha256: 'eaafaa10f19c63b77e2bae77bf4b2f59054c208ea08b8c6648f95ef36a3b6b87',
    label: 'model_512 (full, ~184 MB)',
    description:
      'Phase-1 fp32 export of BiRefNet_lite at 512x512 (earlier generation, larger download).',
    inputSize: 512,
    outputIsProbability: true,
    default: false,
  },
];

// WASM files from onnxruntime-web that must be self-hosted.
//
// CPU-only bundle (`ort.wasm.min.js`), not the full `ort.all.min.js`: the full
// bundle pulls `ort-wasm-simd-threaded.jsep.wasm` (26.5 MiB) for the WebGPU
// backend, which is too large for a typical static host's per-file cap (e.g.
// Cloudflare Pages' 25 MiB). (A cross-origin
// copy wouldn't work anyway — ORT's pthread workers bypass the service worker, so
// they never get the `Cross-Origin-Resource-Policy` header a COEP page needs.)
// The CPU bundle loads `ort-wasm-simd-threaded.wasm` (13.3 MiB), small enough to
// deploy as a same-origin static file.
//
// A host that CAN serve the jsep binary (no 25 MiB cap, same-origin — e.g. a
// local Vite preview, a self-hosted server, or a bigger static host) can enable
// the WebGPU path with `node scripts/fetch-models.mjs --webgpu`, which also
// copies the full bundle + jsep wasm into public/wasm. The app probes for the
// jsep file and only requests the webgpu bundle when it is actually served.
const SOURCE_WASM_DIR = resolve(ROOT, 'node_modules/onnxruntime-web/dist');
const WASM_FILES = [
  'ort.wasm.min.js',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];
const WEBGPU_WASM_FILES = ['ort.all.min.js', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
const WITH_WEBGPU = process.argv.includes('--webgpu');

// The manifest is the runtime source of truth: the UI builds the model
// selector from it, the service worker seeds one cache bucket per model from
// it, and the smoke harness reads it to know which models exist. It is written
// by this script so pinning (file, url, sha256, size, contract) and
// distribution stay in one place. The URL stored here is the relative path the
// app fetches through the asset service worker; the absolute `url` in the table
// above is only used to download at build time.
const manifest = MODELS.map(({ url: _downloadUrl, ...entry }) => ({
  ...entry,
  url: `/${entry.file}`,
}));

for (const m of MODELS) {
  // Artifacts land in public/ so `vite build` copies them into dist/ the same
  // way the deployed SW expects them (`/models/<leaf>`). The absolute URL in
  // the table above is only the download source.
  const dest = resolve(ROOT, 'public', m.file);
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${m.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const h = createHash('sha256').update(buf).digest('hex');
  if (h !== m.sha256) {
    throw new Error(`SHA-256 mismatch for ${m.file}: expected ${m.sha256}, got ${h}`);
  }
  writeFileSync(dest, buf);
  console.log(`OK  ${m.file}  ${buf.length} bytes  sha256=${h}`);
}

const manifestPath = resolve(ROOT, 'public/models-manifest.json');
writeFileSync(manifestPath, JSON.stringify({ version: 1, models: manifest }, null, 2) + '\n');
console.log(`OK  public/models-manifest.json  (${manifest.length} model(s))`);

mkdirSync(resolve(ROOT, 'public/wasm'), { recursive: true });
const allWasmFiles = WITH_WEBGPU ? WASM_FILES.concat(WEBGPU_WASM_FILES) : WASM_FILES;
for (const f of allWasmFiles) {
  const src = resolve(SOURCE_WASM_DIR, f);
  const dest = resolve(ROOT, 'public/wasm', f);
  const data = await import('node:fs/promises').then(({ readFile }) => readFile(src));
  await import('node:fs/promises').then(({ writeFile }) => writeFile(dest, data));
  const h = createHash('sha256').update(data).digest('hex');
  console.log(`OK  public/wasm/${f}  ${data.length} bytes  sha256=${h}`);
}
console.log('All artifacts downloaded and verified.');