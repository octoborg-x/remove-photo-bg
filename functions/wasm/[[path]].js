// Cloudflare Pages Function: serves the onnxruntime-web WASM runtime from R2.
//
// Why a Function instead of a static file: the threaded ORT build loads
// `ort-wasm-simd-threaded.jsep.wasm` (26.5 MiB) even when WebGPU is disabled, and
// Cloudflare Pages rejects any single static file over 25 MiB. It also must be
// same-origin — ORT's pthread workers fetch their subresources directly, bypassing
// the service worker, so a cross-origin `.wasm` never gets the
// `Cross-Origin-Resource-Policy` header a COEP page requires and session creation
// hangs. A Function runs on the site's own origin, so it satisfies both.
//
// The bytes live in the R2 bucket bound as ASSETS_BUCKET (see wrangler.toml) under
// the `wasm/` prefix. The model is NOT served here: it is large enough that a slow
// client could outlive a Function invocation, so the service worker fetches it
// directly from R2 instead.
//
// Route: functions/wasm/[[path]].js -> /wasm/<path>

const CONTENT_TYPES = {
  wasm: 'application/wasm',
  mjs: 'text/javascript',
  js: 'text/javascript',
};

function contentTypeFor(key) {
  const ext = key.split('.').pop().toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export async function onRequest({ request, params, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const segments = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const key = `wasm/${segments.join('/')}`;

  const object = await env.ASSETS_BUCKET.get(key);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  // Filenames are content-pinned, so the response is immutable. Correct content
  // type is required: importScripts refuses a script served as octet-stream, and
  // streaming WASM compilation wants application/wasm.
  headers.set('Content-Type', contentTypeFor(key));
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', object.httpEtag);

  // HEAD must not carry a body; the object's metadata already set Content-Length.
  const body = request.method === 'HEAD' ? null : object.body;
  return new Response(body, { headers });
}
