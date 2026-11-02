// Types for the CSP/header generator used by vite.config.ts.
export function assetOrigins(assetBase: string): string[];
export function contentSecurityPolicy(assetBase: string): string;
export function withCsp(template: string, csp: string): string;
