// DOM wiring for the analytics consent banner, the footer settings control, and
// the "Report a quality problem" form. Kept separate from main.ts so the
// analytics feature owns its own elements and the image-processing code only
// calls the small, well-defined API on the returned controller.
//
// Nothing here can block image processing or downloads: every handler is
// best-effort and the report form is an independent, explicit action.

import { AnalyticsClient } from './analytics';
import { shouldAskForConsent } from './consent';
import { type DiagnosticReport } from '../diagnostics/diagnostic-report';
import { sanitizeDiagnosticsForUpload } from '../diagnostics/diagnostic-report-upload';
import { REPORT_CATEGORIES, REPORT_DESCRIPTION_MAX, isReportCategory } from './report-categories';
import { submitReport, normalizeDescription } from './report-client';
import { endpointUrl } from './event-client';
import { loadWebAnalytics } from './web-analytics';

export interface AnalyticsUiOptions {
  /** Base endpoint (empty disables custom events). */
  endpoint: string;
  /** Cloudflare Web Analytics beacon token (empty disables Web Analytics). */
  webAnalyticsToken?: string;
  appVersion: string;
  /**
   * Supplies the SAME diagnostic report the Console's "Copy report" button
   * builds (src/features/diagnostics/diagnostic-report.ts). One structure, one
   * builder; the form only decides whether to attach it.
   */
  diagnostics: () => DiagnosticReport;
  /** Called after a quality report is stored, so the caller can emit an event. */
  onReportSubmitted?: (category: string) => void;
}

export interface AnalyticsUi {
  client: AnalyticsClient;
  /** True when either custom events or Web Analytics is configured. */
  enabled: boolean;
  /** Show the consent banner if no decision has been recorded. */
  maybeShowConsent(): void;
}

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function initAnalyticsUi(opts: AnalyticsUiOptions): AnalyticsUi {
  const endpoint = opts.endpoint.trim();
  const webAnalyticsToken = (opts.webAnalyticsToken ?? '').trim();
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

  // Load the Cloudflare Web Analytics beacon only once consent allows it. The
  // beacon is a separate, third-party measurement technology; loading it here
  // (rather than as a static tag) keeps it behind the same choice.
  function activateWebAnalytics(): void {
    if (webAnalyticsToken) loadWebAnalytics(webAnalyticsToken);
  }

  acceptBtn?.addEventListener('click', () => {
    client.setConsent(true);
    activateWebAnalytics();
    hideBanner();
  });
  rejectBtn?.addEventListener('click', () => {
    client.setConsent(false);
    hideBanner();
  });
  // The footer control withdraws consent and clears the anonymous identifier,
  // then re-asks so the choice can be made again. The Web Analytics beacon cannot
  // be un-loaded once injected, so a withdrawal re-asks but does not remove it —
  // documented in PRIVACY.md.
  settingsBtn?.addEventListener('click', () => {
    client.reset();
    showBanner();
  });

  // A session that already granted consent on a previous visit loads the beacon
  // immediately.
  if (client.consentState === 'granted') activateWebAnalytics();

  setupReportForm(opts, client);

  // Any analytics at all (custom events or Web Analytics) means there is a
  // decision to ask for and a footer control that matters.
  const anyAnalytics = client.enabled || webAnalyticsToken.length > 0;

  return {
    client,
    enabled: anyAnalytics,
    maybeShowConsent() {
      if (anyAnalytics && shouldAskForConsent(client.consentState)) showBanner();
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
      // The exact JSON that will be sent: the shared diagnostic structure, with
      // the fingerprint fields removed and strings scrubbed.
      const report = sanitizeDiagnosticsForUpload(opts.diagnostics());
      if (previewJson) previewJson.textContent = JSON.stringify(report, null, 2);
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
      const report = opts.diagnostics();
      const diagnostics = attachBox?.checked ? sanitizeDiagnosticsForUpload(report) : undefined;
      const ok = await submitReport(reportUrl, {
        category,
        description: normalizeDescription(descInput.value),
        app_version: opts.appVersion,
        model_id: report.model.id ?? undefined,
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
