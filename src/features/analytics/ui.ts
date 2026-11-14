// DOM wiring for the analytics consent banner, the footer settings control, and
// the "Report a quality problem" form. Kept separate from main.ts so the
// analytics feature owns its own elements and the image-processing code only
// calls the small, well-defined API on the returned controller.
//
// Nothing here can block image processing or downloads: every handler is
// best-effort and the report form is an independent, explicit action.

import { AnalyticsClient } from './analytics';
import { buildDiagnostics, formatDiagnostics, type DiagnosticsInput } from './diagnostics';
import { REPORT_CATEGORIES, REPORT_DESCRIPTION_MAX, isReportCategory } from './report-categories';
import { submitReport, normalizeDescription } from './report-client';
import { endpointUrl } from './event-client';

export interface AnalyticsUiOptions {
  /** Base endpoint (empty disables all analytics UI and events). */
  endpoint: string;
  appVersion: string;
  /** Supplies the current, non-identifying diagnostic facts on demand. */
  diagnostics: () => DiagnosticsInput;
  /** Called after a quality report is stored, so the caller can emit an event. */
  onReportSubmitted?: (category: string) => void;
}

export interface AnalyticsUi {
  client: AnalyticsClient;
  /** True when an endpoint is configured. */
  enabled: boolean;
  /** Show the consent banner if no decision has been recorded. */
  maybeShowConsent(): void;
}

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function initAnalyticsUi(opts: AnalyticsUiOptions): AnalyticsUi {
  const endpoint = opts.endpoint.trim();
  const client = new AnalyticsClient({
    endpoint,
    appVersion: opts.appVersion,
    storage: safeStorage(() => localStorage),
    sessionStorage: safeStorage(() => sessionStorage),
  });

  const banner = byId<HTMLElement>('consentBanner');
  const acceptBtn = byId<HTMLButtonElement>('consentAccept');
  const rejectBtn = byId<HTMLButtonElement>('consentReject');
  const settingsBtn = byId<HTMLButtonElement>('analyticsSettingsBtn');

  function showBanner(): void {
    if (banner) banner.hidden = false;
  }
  function hideBanner(): void {
    if (banner) banner.hidden = true;
  }

  acceptBtn?.addEventListener('click', () => {
    client.setConsent(true);
    hideBanner();
  });
  rejectBtn?.addEventListener('click', () => {
    client.setConsent(false);
    hideBanner();
  });
  // The footer control withdraws consent and clears the anonymous identifier,
  // then re-asks so the choice can be made again.
  settingsBtn?.addEventListener('click', () => {
    client.reset();
    showBanner();
  });

  setupReportForm(opts, client);

  return {
    client,
    enabled: client.enabled,
    maybeShowConsent() {
      if (client.shouldAsk) showBanner();
    },
  };
}

// ——— Quality report form ———

function setupReportForm(opts: AnalyticsUiOptions, client: AnalyticsClient): void {
  const openBtn = byId<HTMLButtonElement>('reportProblemBtn');
  const form = byId<HTMLFormElement>('qualityReportForm');
  const categorySel = byId<HTMLSelectElement>('reportCategory');
  const descInput = byId<HTMLTextAreaElement>('reportDescription');
  const descCount = byId<HTMLElement>('reportDescCount');
  const attachBox = byId<HTMLInputElement>('reportAttachDiagnostics');
  const preview = byId<HTMLElement>('reportDiagnosticsPreview');
  const previewJson = byId<HTMLElement>('reportDiagnosticsJson');
  const errorEl = byId<HTMLElement>('reportError');
  const submitBtn = byId<HTMLButtonElement>('reportSubmit');
  const cancelBtn = byId<HTMLButtonElement>('reportCancel');

  if (!openBtn || !form || !categorySel || !descInput) return;

  // Populate the categories from the single source of truth.
  for (const cat of REPORT_CATEGORIES) {
    const option = document.createElement('option');
    option.value = cat.id;
    option.textContent = cat.label;
    categorySel.appendChild(option);
  }

  const reportUrl = endpointUrl(opts.endpoint, '/api/quality-reports');

  const refreshPreview = (): void => {
    if (attachBox?.checked) {
      const report = buildDiagnostics(opts.diagnostics());
      if (previewJson) previewJson.textContent = formatDiagnostics(report);
      if (preview) preview.hidden = false;
    } else if (preview) {
      preview.hidden = true;
    }
  };

  const setError = (msg: string | null): void => {
    if (!errorEl) return;
    errorEl.textContent = msg ?? '';
    errorEl.hidden = msg === null;
  };

  const open = (): void => {
    form.hidden = false;
    openBtn.setAttribute('aria-expanded', 'true');
    setError(null);
    refreshPreview();
    categorySel.focus();
  };
  const close = (): void => {
    form.hidden = true;
    openBtn.setAttribute('aria-expanded', 'false');
    setError(null);
    if (attachBox) attachBox.checked = false;
    if (preview) preview.hidden = true;
  };

  openBtn.addEventListener('click', () => (form.hidden ? open() : close()));
  cancelBtn?.addEventListener('click', close);

  descInput.addEventListener('input', () => {
    if (descCount) descCount.textContent = `${descInput.value.length} / ${REPORT_DESCRIPTION_MAX}`;
  });
  attachBox?.addEventListener('change', refreshPreview);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setError(null);
    const category = categorySel.value;
    if (!isReportCategory(category)) {
      setError('Choose a problem category.');
      return;
    }
    if (submitBtn) submitBtn.disabled = true;
    try {
      const diagnostics = attachBox?.checked ? buildDiagnostics(opts.diagnostics()) : undefined;
      const ok = await submitReport(reportUrl, {
        category,
        description: normalizeDescription(descInput.value),
        app_version: opts.appVersion,
        model_id: opts.diagnostics().model_id,
        diagnostics,
      });
      if (ok) {
        // The report is stored. Emit the analytics event (only if consented) and
        // tell the caller so it can surface a confirmation.
        client.qualityReportSubmitted(category);
        opts.onReportSubmitted?.(category);
        descInput.value = '';
        if (descCount) descCount.textContent = `0 / ${REPORT_DESCRIPTION_MAX}`;
        close();
      } else {
        setError('Could not send the report. Please try again.');
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

/**
 * Resolve a Storage object, tolerating environments where accessing it throws
 * (some privacy modes). Returns null when unavailable; the client then works
 * without persistence.
 */
function safeStorage(get: () => Storage): Storage | null {
  try {
    return get();
  } catch {
    return null;
  }
}
