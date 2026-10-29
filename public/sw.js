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
// Versioning: bump CACHE_VERSION to invalidate every cached artifact at once
// (e.g. after a model or ORT upgrade). Each artifact is otherwise keyed by its
// full URL, so a changed filename is picked up automatically.

const CACHE_VERSION = 'v2';
const CACHE_NAME = `remove-bg-assets-${CACHE_VERSION}`;

// Only these directories (relative to the app's own scope) are persisted.
// Everything else (HTML, JS bundles, test images) goes straight to the network so
// the app itself is never served stale.
const PERSISTENT_DIRS = ['models/', 'wasm/'];

function isPersistentRequest(url) {
  // Derive the base path from the worker's own scope so a sub-path deployment
  // (vite `base: './'`) still matches, rather than assuming a root deployment.
  const base = new URL(self.registration.scope).pathname;
  const pathname = new URL(url).pathname;
  if (!pathname.startsWith(base)) return false;
  const relative = pathname.slice(base.length);
  return PERSISTENT_DIRS.some((dir) => relative.startsWith(dir));
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
  if (!isPersistentRequest(request.url)) return;

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

      const response = await fetch(request);
      if (response.ok && response.status === 200) {
        // Store a copy with `Vary` removed so the stored response never depends
        // on a request header that varies by call site.
        cache.put(request, withoutVary(response)).catch(() => {
          // A full quota must not break the load; the network response still
          // reaches the caller.
        });
        notifyClient({ kind: 'asset-cached', url: request.url });
      }
      return response;
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

// Returns a storable copy of the response with any `Vary` header removed. Clones
// first, so the caller's copy of the body stays readable.
function withoutVary(response) {
  const clone = response.clone();
  if (!clone.headers.has('Vary')) return clone;
  const headers = new Headers(clone.headers);
  headers.delete('Vary');
  return new Response(clone.body, {
    status: clone.status,
    statusText: clone.statusText,
    headers,
  });
}
