// Registers the asset service worker that persists the model and WASM runtime
// across page loads (see public/sw.js). The worker must be registered — and the
// page must be under its control — before the inference worker starts, or the
// inference worker's own fetches miss the cache and re-download everything.

const READY_TIMEOUT_MS = 5000;

/**
 * Origin that serves the heavy binaries (model + WASM), or '' when this origin
 * serves them itself. Configured at build time with `VITE_ASSET_BASE` so the
 * static site can stay small while the ~230 MB of artifacts live on R2.
 *
 * A trailing slash is kept so that relative paths resolve against the base as a
 * directory (a slash-less base makes `new URL()` treat the last path segment as
 * a file). When VITE_ASSET_BASE is empty the result must stay '' — never '/',
 * which would be truthy and make the service worker treat same-origin
 * model/WASM requests as remote.
 */
export const ASSET_BASE: string = (() => {
  const base = (import.meta.env.VITE_ASSET_BASE ?? '').trim();
  if (!base) return '';
  return base.replace(/\/+$/, '') + '/';
})();

/** Full URL for a persistent asset path (e.g. 'models/model_512.onnx'). */
export function assetUrl(path: string): string {
  const clean = path.replace(/^\/+/, '');
  return ASSET_BASE ? `${ASSET_BASE}${clean}` : `/${clean}`;
}

export type AssetCacheStatus = 'controlling' | 'unsupported' | 'timeout' | 'failed';

/**
 * Registers the asset service worker and resolves once the page is controlled
 * by it (or once it is clear that control will not happen in time). Never
 * rejects: a cache miss is a performance problem, not a correctness one, so the
 * app must still start.
 */
export async function ensureAssetCache(onLog?: (msg: string) => void): Promise<AssetCacheStatus> {
  if (!('serviceWorker' in navigator)) {
    onLog?.('Service worker unavailable; model will be re-downloaded on each visit.');
    return 'unsupported';
  }

  // Pass the remote asset origin on the registration URL: the worker reads it
  // synchronously at startup, before the first fetch it must handle.
  const swUrl = ASSET_BASE ? `/sw.js?base=${encodeURIComponent(ASSET_BASE)}` : '/sw.js';
  try {
    await navigator.serviceWorker.register(swUrl, { scope: '/' });
  } catch (err) {
    onLog?.(`Asset cache registration failed: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }

  // A first-ever registration activates but does not control the current page
  // until the next navigation; `clients.claim()` in the worker's activate handler
  // closes that gap. If it does not arrive in time, fall back to loading without
  // the cache rather than blocking startup.
  const controlled = navigator.serviceWorker.controller
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const onChange = () => {
          if (navigator.serviceWorker.controller) {
            navigator.serviceWorker.removeEventListener('controllerchange', onChange);
            resolve();
          }
        };
        navigator.serviceWorker.addEventListener('controllerchange', onChange);
      });

  const ready = await Promise.race([
    controlled.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), READY_TIMEOUT_MS)),
  ]);

  if (!ready) {
    onLog?.('Asset cache is still starting; this first load may not be cached.');
    return 'timeout';
  }
  return 'controlling';
}

/** Subscribes to the service worker's cache status messages. Returns an unsubscribe function. */
export function onAssetCacheMessage(
  handler: (msg: { kind: 'asset-cache-hit' | 'asset-cached'; url: string }) => void,
): () => void {
  if (!('serviceWorker' in navigator)) return () => {};
  const listener = (event: MessageEvent) => {
    const data = event.data as { kind?: string; url?: string };
    if (data?.kind === 'asset-cache-hit' || data?.kind === 'asset-cached') {
      handler(data as { kind: 'asset-cache-hit' | 'asset-cached'; url: string });
    }
  };
  navigator.serviceWorker.addEventListener('message', listener);
  return () => navigator.serviceWorker.removeEventListener('message', listener);
}

/**
 * Reports whether the large artifacts are already persisted, so the UI can say
 * "first download" versus "loading from device". Returns the count of cached
 * model/WASM entries.
 */
export async function cachedAssetCount(): Promise<number> {
  if (!('caches' in window)) return 0;
  const names = await caches.keys();
  let count = 0;
  for (const name of names) {
    if (!name.startsWith('remove-bg-assets-')) continue;
    const cache = await caches.open(name);
    count += (await cache.keys()).length;
  }
  return count;
}
