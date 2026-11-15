// The CSP must allow the browser to POST analytics events/reports to the
// configured Worker origin, and nothing more. When analytics is not configured
// the policy must stay `connect-src 'self'` so the default deployment has no new
// network origin at all.
import { describe, it, expect } from 'vitest';
import {
  analyticsOrigins,
  contentSecurityPolicy,
  webAnalyticsOrigins,
} from '../../../scripts/write-headers.mjs';

describe('analytics CSP origins', () => {
  it('adds nothing when no endpoint is configured', () => {
    expect(analyticsOrigins('')).toEqual([]);
    const csp = contentSecurityPolicy('');
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/workers\.dev/);
  });

  it('adds exactly the endpoint origin when configured', () => {
    expect(analyticsOrigins('https://smartcutai-analytics.acct.workers.dev')).toEqual([
      'https://smartcutai-analytics.acct.workers.dev',
    ]);
    const csp = contentSecurityPolicy('', 'https://smartcutai-analytics.acct.workers.dev');
    expect(csp).toContain("connect-src 'self' https://smartcutai-analytics.acct.workers.dev");
  });

  it('ignores a malformed endpoint rather than widening the policy', () => {
    expect(analyticsOrigins('not-a-url')).toEqual([]);
  });
});

describe('Cloudflare Web Analytics CSP origins', () => {
  it('adds nothing when no beacon token is configured', () => {
    expect(webAnalyticsOrigins('')).toEqual({ script: [], connect: [] });
    const csp = contentSecurityPolicy('');
    expect(csp).not.toMatch(/cloudflareinsights/);
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  });

  it('allows the beacon script and collector when a token is set', () => {
    const csp = contentSecurityPolicy('', '', 'token123');
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com");
    expect(csp).toContain('https://cloudflareinsights.com');
  });
});
