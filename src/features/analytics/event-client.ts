// Best-effort, non-blocking delivery for analytics events and quality reports.
// Delivery must never affect the image-processing experience: every call is
// fire-and-forget, resolves to a boolean, and swallows all errors. `sendBeacon`
// is preferred (it survives page unload); a `keepalive` fetch is the fallback.

export interface Transport {
  /** Send a JSON body. Resolves true when the request was handed off. */
  send(url: string, body: unknown): Promise<boolean>;
}

/** Default browser transport: sendBeacon first, then a keepalive fetch. */
export function browserTransport(): Transport {
  return {
    async send(url: string, body: unknown): Promise<boolean> {
      const payload = JSON.stringify(body);
      try {
        const beacon = navigator?.sendBeacon;
        if (typeof beacon === 'function') {
          // A `text/plain` blob keeps this a CORS "simple request", so
          // sendBeacon works cross-origin without a preflight it cannot perform.
          const blob = new Blob([payload], { type: 'text/plain' });
          if (beacon.call(navigator, url, blob)) return true;
        }
      } catch {
        // fall through to fetch
      }
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: payload,
          keepalive: true,
        });
        return true;
      } catch {
        // Analytics is best-effort; a failed send is silently ignored.
        return false;
      }
    },
  };
}

/** Join a base endpoint with a path, tolerating a trailing slash on the base. */
export function endpointUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}${path.startsWith('/') ? path : `/${path}`}`;
}
