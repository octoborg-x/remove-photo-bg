// Cloudflare Web Analytics beacon loader.
//
// Cloudflare Web Analytics is a *separate* technology from the custom events in
// this folder: it is a cookieless beacon served by Cloudflare that records page
// views, referrers and coarse geography. It is NOT a persistent-identifier
// tracker, but it is still third-party measurement, so this project loads it
// only after the visitor grants analytics consent (the same choice that governs
// the custom events). The script is injected rather than shipped as a static
// <script> tag, so nothing loads before the decision.
//
// The beacon posts to https://cloudflareinsights.com/cdn-cgi/rum and is served
// from https://static.cloudflareinsights.com; both origins must be in the CSP
// (see scripts/write-headers.mjs) or the script is blocked silently.

export const CF_BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';

/** True when a beacon script for any token is already in the document. */
export function hasWebAnalytics(doc: Document = document): boolean {
  return doc.querySelector('script[data-cf-beacon]') !== null;
}

/**
 * Inject the Cloudflare Web Analytics beacon. No-op when the token is empty or
 * the beacon is already present. Returns true when the beacon is (now) present.
 * Never throws: a failure to inject must not affect the app.
 */
export function loadWebAnalytics(token: string, doc: Document = document): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  try {
    if (hasWebAnalytics(doc)) return true;
    const script = doc.createElement('script');
    script.type = 'module';
    script.src = CF_BEACON_SRC;
    script.setAttribute('data-cf-beacon', JSON.stringify({ token: trimmed }));
    doc.head.appendChild(script);
    return true;
  } catch {
    return false;
  }
}
