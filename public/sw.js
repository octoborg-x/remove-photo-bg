// Service worker: keeps the model and WASM runtime on the device so a page
// reload does not re-download ~235 MB.
//
// Why this exists: the inference worker fetches /models/model_512.onnx (~185 MB)
// and onnxruntime-web fetches the /wasm/* binaries (~42 MB). Static hosts serve
// them with `Cache-Control: no-cache`, and the HTTP disk cache is unreliable for
// files this large, so without an explicit store every visit started from zero.
//
// Strategy: cache-first for these two path prefixes, backed by the Cache API.
// The Cache API persists across navigations and browser restarts (subject to the
// browser's storage eviction policy), unlike a page-scoped HTTP cache.
//
// Remote asset origin (Hugging Face): the model is too large for the static
// host (Cloudflare Pages caps a file at 25 MiB), so it lives on a separate
// origin (Hugging Face) and this worker fetches it from there, then returns it
// to the page as if it were same-origin. That is what lets a cross-origin asset
// satisfy the page's COEP policy: the page needs `Cross-Origin-Resource-Policy`
// on the response, which a plain CDN cannot set, but a service worker can. The
// base URL is passed on the registration query string
// (`/sw.js?base=https://huggingface.co/.../resolve/main/`), so it is available
// before the first fetch is handled.
//
// Versioning: the WASM runtime cache is one shared bucket keyed by CACHE_VERSION;
// bump it to invalidate all wasm artifacts at once (e.g. after an ORT upgrade).
// Models are instead bucketed PER MODEL by manifest identity + content hash
// (`remove-bg-model-<id>-<sha8>`), so switching or upgrading a model never
// touches another model's cached bytes and a working model stays cached while a
// new one downloads. A changed model revision is picked up automatically: new
// sha256 -> new bucket, and the stale bucket is pruned on the next activate.

const CACHE_VERSION = 'v8';
const CACHE_NAME = `remove-bg-assets-${CACHE_VERSION}`;
const MODEL_BUCKET_PREFIX = 'remove-bg-model-';

// leaf name (e.g. 'c5_best.onnx') -> { id, sha256, file } read from
// /models-manifest.json (the generated source of truth; see
// scripts/fetch-models.mjs). Loaded on activate and lazily on demand, so a
// first-ever load with a slow manifest still works.
let modelsByLeaf = null;

async function loadModelManifest() {
  if (modelsByLeaf) return modelsByLeaf;
  const map = {};
  try {
    // Bound the fetch so a stalled manifest can never block install/activate;
    // unknown models fall back to the shared asset bucket until the next load.
    const res = await Promise.race([
      fetch('/models-manifest.json', { cache: 'no-store' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('manifest timeout')), 3000)),
    ]);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const manifest = await res.json();
    for (const m of manifest.models || []) {
      const leaf = (m.file || '').split('/').pop();
      if (leaf && typeof m.sha256 === 'string') {
        map[leaf] = { id: m.id, sha256: m.sha256, file: m.file };
      }
    }
  } catch {
    // Manifest unreachable (offline first load, stale preview): fall through
    // with an empty map; unknown models cache under the shared asset bucket.
  }
  modelsByLeaf = map;
  return map;
}

function modelBucketName(relativePath) {
  const leaf = relativePath.split('/').pop();
  const info = modelsByLeaf?.[leaf];
  const tag = info ? `${info.id}-${info.sha256.slice(0, 8)}` : `unknown-${leaf}`;
  return MODEL_BUCKET_PREFIX + tag;
}

function isKnownModelBucket(name, known) {
  return known.has(name);
}

// Where the heavy binaries actually live. Empty means "same origin" (local dev,
// or a host that can serve the files itself).
//
// Only the model is ever fetched from a remote origin. The WASM runtime must stay
// same-origin: onnxruntime-web's threaded build spawns pthread workers whose
// subresource fetches bypass the service worker, so a cross-origin `.wasm` never
// receives the `Cross-Origin-Resource-Policy` header the COEP page demands and
// session creation hangs forever (verified). The model fetch, by contrast, runs
// inside the worker this service worker controls, so it proxies cleanly.
const ASSET_BASE = (() => {
  try {
    const base = new URL(self.location.href).searchParams.get('base') || '';
    // A bare '/' means "no remote origin" (the page build had no
    // VITE_ASSET_BASE): keep model/WASM requests same-origin rather than
    // resolving them against a pathless base.
    return base.trim() && base !== '/' ? base : '';
  } catch {
    return '';
  }
})();

// Only these directories (relative to the app's own scope) are persisted.
// Everything else (HTML, JS bundles, test images) goes straight to the network so
// the app itself is never served stale.
const PERSISTENT_DIRS = ['models/', 'wasm/'];

// Paths served from the remote origin. The WASM runtime is deliberately excluded
// (see ASSET_BASE above).
const REMOTE_DIRS = ['models/'];

// Relative path under the app scope for a persistent request, or null if the
// request is not one we persist (e.g. `models/` -> `model_512.onnx`).
function persistentRelativePath(url) {
  // Derive the base path from the worker's own scope so a sub-path deployment
  // (vite `base: './'`) still matches, rather than assuming a root deployment.
  const base = new URL(self.registration.scope).pathname;
  const pathname = new URL(url).pathname;
  if (!pathname.startsWith(base)) return null;
  const relative = pathname.slice(base.length);
  return PERSISTENT_DIRS.some((dir) => relative.startsWith(dir)) ? relative : null;
}

// Fetches a persistent artifact, from the remote origin when one is configured
// and the path is remote-eligible, otherwise from this origin.
async function fetchAsset(request, relativePath) {
  const remote = ASSET_BASE && REMOTE_DIRS.some((dir) => relativePath.startsWith(dir));
  if (!remote) return fetch(request);
  const target = new URL(relativePath, ASSET_BASE).toString();
  // `cors` mode is required so the worker can read the body (to cache it) and so
  // the response is not opaque. The bucket must allow this origin via CORS.
  return fetch(target, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
}

self.addEventListener('install', () => {
  event.waitUntil(loadModelManifest());
  // Take over as soon as possible; there is no stale app shell to protect
  // because only model/WASM artifacts are cached.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Compute which model buckets are still current so the prune below keeps
      // only the live revision of each shipped model.
      const byLeaf = await loadModelManifest();
      const manifestLoaded = Object.keys(byLeaf).length > 0;
      const current = new Set();
      for (const info of Object.values(byLeaf)) {
        current.add(MODEL_BUCKET_PREFIX + `${info.id}-${info.sha256.slice(0, 8)}`);
      }
      // Drop caches from older versions so an upgrade does not pin hundreds of
      // MB of dead artifacts on the device: stale wasm buckets (old
      // CACHE_VERSION) and stale model buckets (old/replaced revisions).
      // Model buckets are only pruned when the manifest actually loaded: with
      // an empty map every bucket would look stale, and re-downloading 200 MB
      // because of a transient manifest failure is worse than keeping a valid
      // cached model.
      const names = await caches.keys();
      const stale = names.filter((name) => {
        if (name === CACHE_NAME) return false;
        if (name.startsWith(MODEL_BUCKET_PREFIX)) return manifestLoaded && !isKnownModelBucket(name, current);
        return name.startsWith('remove-bg-assets-');
      });
      await Promise.all(stale.map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const relativePath = persistentRelativePath(request.url);
  if (!relativePath) return;

  const isModel = relativePath.startsWith('models/');
  const cacheName = isModel ? modelBucketName(relativePath) : CACHE_NAME;

  const cacheWrite = (async () => {
    const cache = await caches.open(cacheName);
    // `ignoreVary` is required: static hosts (and the Vite dev server) send
    // `Vary: Origin`, and the Origin header differs between the ESM loader
    // fetch and a plain fetch. The artifacts are same-origin and immutable, so
    // Vary must not decide cache membership. The URL is the only cache key.
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) {
      notifyClient({ kind: 'asset-cache-hit', url: request.url });
      return { response: cached };
    }

    const remote = ASSET_BASE && REMOTE_DIRS.some((dir) => relativePath.startsWith(dir));
    const response = await fetchAsset(request, relativePath);
    if (!response.ok || response.status !== 200) return { response };
    // A missing artifact often comes back as the host's index.html with HTTP
    // 200 (SPA fallback), not a 404. Caching that would pin a few KB of HTML
    // under the model's cache key and quietly break every later visit.
    if (isFallbackPage(response)) return { response };
    // Normalise before returning as well as before caching: on the very first
    // load the page receives this response directly, and a COEP page rejects a
    // cross-origin asset that lacks CORP.
    const normalized = normalizeForStore(response, remote);
    // Report the artifact as cached only once it is actually stored: the write
    // takes far longer than the response for a 185 MB file, and claiming success
    // up front made a stalled/abandoned download look successful.
    const store = cache
      .put(request, normalized.clone())
      .then(() => notifyClient({ kind: 'asset-cached', url: request.url }))
      .catch(() => {});
    return { response: normalized, store };
  })();

  event.respondWith(cacheWrite.then((r) => r.response));
  // Writing a 185 MB body outlives the response; without waitUntil the worker can
  // be terminated mid-write and the cache entry never appears.
  event.waitUntil(cacheWrite.then((r) => r.store).catch(() => {}));
});

// True when the host answered a missing artifact with its app shell instead of
// the artifact itself (dev-server and SPA fallbacks serve index.html).
function isFallbackPage(response) {
  const type = (response.headers.get('content-type') || '').toLowerCase();
  return type.includes('text/html');
}

function notifyClient(message) {
  // Best-effort: the page may already be gone (that is exactly the case this
  // worker is meant to survive).
  self.clients.matchAll({ type: 'window' }).then((clients) => {
    for (const client of clients) client.postMessage(message);
  }).catch(() => {});
}

// Returns a storable copy of the response with any `Vary` header removed and, for
// remote-origin bytes, a `Cross-Origin-Resource-Policy: cross-origin` header so a
// COEP page accepts the response as if it were same-origin.
//
// The original body is transferred into the new Response rather than cloned: a
// clone here would leave a third, never-read branch of a 185 MB stream tee'd off,
// and that branch buffers the whole file in memory.
function normalizeForStore(response, remote) {
  const headers = new Headers(response.headers);
  headers.delete('Vary');
  if (remote) headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
