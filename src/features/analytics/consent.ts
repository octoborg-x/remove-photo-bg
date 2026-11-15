// Analytics consent, kept as a pure state machine so the policy is unit-testable
// without a DOM. Consent is the single gate for every custom analytics behaviour:
// no persistent identifier is created, and no event is sent, unless the state is
// 'granted'. Image processing and downloads never read this value.

export type ConsentState = 'granted' | 'denied' | 'unset';

export const CONSENT_STORAGE_KEY = 'remove-bg:analytics-consent';

/** Minimal storage surface, so tests can pass a plain object. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function parseConsent(raw: string | null | undefined): ConsentState {
  if (raw === 'granted') return 'granted';
  if (raw === 'denied') return 'denied';
  return 'unset';
}

export function readConsent(storage: StorageLike | null | undefined): ConsentState {
  if (!storage) return 'unset';
  try {
    return parseConsent(storage.getItem(CONSENT_STORAGE_KEY));
  } catch {
    // Storage can throw in private mode or when disabled; treat it as unset.
    return 'unset';
  }
}

export function writeConsent(storage: StorageLike | null | undefined, state: 'granted' | 'denied'): void {
  if (!storage) return;
  try {
    storage.setItem(CONSENT_STORAGE_KEY, state);
  } catch {
    // A failed write just means the choice does not persist; the in-memory state
    // still governs this session.
  }
}

export function clearConsent(storage: StorageLike | null | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(CONSENT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Analytics may run only with an explicit grant. */
export function isAnalyticsAllowed(state: ConsentState): boolean {
  return state === 'granted';
}

/** The banner is shown only while no decision has been recorded. */
export function shouldAskForConsent(state: ConsentState): boolean {
  return state === 'unset';
}
