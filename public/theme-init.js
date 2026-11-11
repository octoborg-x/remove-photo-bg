// Theme bootstrap. Runs before the first paint so a stored light/dark override
// is applied with no flash of the wrong mode. With no stored override the page
// follows the operating system (via `color-scheme` in src/style.css).
//
// Loaded as a classic same-origin script so the strict `script-src 'self'`
// policy allows it. The storage key must stay in sync with
// src/features/theme.ts (THEME_STORAGE_KEY); a unit test pins the two together.
(function () {
  try {
    var pref = localStorage.getItem('smartcutai:theme');
    if (pref === 'light' || pref === 'dark') {
      document.documentElement.setAttribute('data-theme', pref);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  } catch (_e) {
    // Storage blocked (private mode / disabled cookies): follow the system.
  }
})();
