// Types for the CSP/header generator used by vite.config.ts.
export function assetOrigins(assetBase: string): string[];
export function analyticsOrigins(endpoint: string): string[];
export function webAnalyticsOrigins(beaconToken: string): { script: string[]; connect: string[] };
export function contentSecurityPolicy(
  assetBase: string,
  analyticsEndpoint?: string,
  webAnalyticsToken?: string,
): string;
export function withCsp(template: string, csp: string): string;
