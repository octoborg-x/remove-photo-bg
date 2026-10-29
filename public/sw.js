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
// Remote asset origin (R2): the heavy binaries are too large for the static host,
// so they live on a separate origin (Cloudflare R2) and this worker fetches them
// from there, then returns them to the page as if they were same-origin. That is
// what lets a cross-origin asset satisfy the page's COEP policy: the page needs
// `Cross-Origin-Resource-Policy` on the response, which an R2 bucket's CORS rules
// cannot set, but a service worker can. The base URL is passed on the
// registration query string (`/sw.js?base=https://assets.example.com`), so it is
// available before the first fetch is handled.
//
// Versioning: bump CACHE_VERSION to invalidate every cached artifact at once
// (e.g. after a model or ORT upgrade). Each artifact is otherwise keyed by its
// full URL, so a changed filename is picked up automatically.

const CACHE_VERSION = 'v3';
const CACHE_NAME = `remove-bg-assets-${CACHE_VERSION}`;

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
    return new URL(self.location.href).searchParams.get('base') || '';
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
  // Take over as soon as possible; there is no stale app shell to protect
  // because only model/WASM artifacts are cached.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from older versions so an upgrade does not pin ~235 MB of
      // dead artifacts on the device.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('remove-bg-assets-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const relativePath = persistentRelativePath(request.url);
  if (!relativePath) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // `ignoreVary` is required: static hosts (and the Vite dev server) send
      // `Vary: Origin`, and the Origin header differs between the ESM loader
      // fetch and a plain fetch. The artifacts are same-origin and immutable, so
      // Vary must not decide cache membership. The URL is the only cache key.
      const cached = await cache.match(request, { ignoreVary: true });
      if (cached) {
        notifyClient({ kind: 'asset-cache-hit', url: request.url });
        return cached;
      }

      const remote = ASSET_BASE && REMOTE_DIRS.some((dir) => relativePath.startsWith(dir));
      const response = await fetchAsset(request, relativePath);
      if (!response.ok || response.status !== 200) return response;
      // Normalise before returning as well as before caching: on the very first
      // load the page receives this response directly, and a COEP page rejects a
      // cross-origin asset that lacks CORP.
      const normalized = normalizeForStore(response, remote);
      cache.put(request, normalized.clone()).catch(() => {
        // A full quota must not break the load; the response still reaches the caller.
      });
      notifyClient({ kind: 'asset-cached', url: request.url });
      return normalized;
    })(),
  );
});

function notifyClient(message) {
  // Best-effort: the page may already be gone (that is exactly the case this
  // worker is meant to survive).
  self.clients.matchAll({ type: 'window' }).then((clients) => {
    for (const client of clients) client.postMessage(message);
  }).catch(() => {});
}

// Returns a storable copy of the response with any `Vary` header removed and, for
// remote-origin bytes, a `Cross-Origin-Resource-Policy: cross-origin` header so a
// COEP page accepts the response as if it were same-origin. Clones first, so the
// caller's copy of the body stays readable.
function normalizeForStore(response, remote) {
  const clone = response.clone();
  const headers = new Headers(clone.headers);
  headers.delete('Vary');
  if (remote) headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(clone.body, {
    status: clone.status,
    statusText: clone.statusText,
    headers,
  });
}
