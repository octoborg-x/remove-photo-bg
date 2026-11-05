// A page served without Vite's transform (`index.html` opened directly, or
// through an IDE/static file preview) still contains the literal `__BUILD_ID__`
// placeholder and cannot load `/src/main.ts`. Say that plainly instead of showing
// a raw token and a generic "script did not run".
//
// Kept as a separate file (not an inline <script>) so the site can ship a strict
// `script-src 'self'` CSP with no 'unsafe-inline' and no hashes.
(function () {
  // The token is assembled at runtime so the build transform that substitutes it
  // cannot also substitute this copy.
  var placeholder = '__BUILD' + '_ID__';
  var stamp = document.getElementById('buildStamp');
  if (!stamp || stamp.textContent.indexOf(placeholder) === -1) {
    // Transformed by Vite: normal path. Watch for an entry point that never
    // executes (404 on main.ts, or a module that throws while evaluating).
    setTimeout(function () {
      var log = document.getElementById('log');
      if (log && !log.textContent) {
        document.getElementById('stage').textContent =
          'App script did not run — open the browser console and check that /src/main.ts is served';
      }
    }, 8000);
    return;
  }

  stamp.textContent = 'none';
  var stage = document.getElementById('stage');
  var hint = document.getElementById('buildHint');
  stage.textContent = 'This page was opened without the dev server';

  // The sandbox forwards each port to its own hostname: `work-1-<id>` is port
  // 12000, `work-2-<id>` is 12001. Opening any other one (or a preview pane)
  // serves this file raw, so send the reader to the app on 12000.
  var forwarded = location.hostname.match(/^work-\d+-([a-z0-9]+)\.prod-runtime\.all-hands\.dev$/);
  if (forwarded && location.hostname.indexOf('work-1-') !== 0) {
    var appUrl = 'https://work-1-' + forwarded[1] + '.prod-runtime.all-hands.dev/';
    stage.textContent = 'Moving you to the app on port 12000…';
    hint.innerHTML = '';
    var link = document.createElement('a');
    link.href = appUrl;
    link.textContent = appUrl;
    hint.appendChild(document.createTextNode('If nothing happens, open '));
    hint.appendChild(link);
    hint.appendChild(document.createTextNode('.'));
    location.replace(appUrl);
    return;
  }

  hint.innerHTML = '';
  hint.appendChild(
    document.createTextNode(
      'index.html was served as a plain file, so the TypeScript entry point cannot load. ' +
        'Start the dev server and open the URL it prints instead of the file: ',
    ),
  );
  var code = document.createElement('code');
  code.textContent = 'npm run dev';
  hint.appendChild(code);
  hint.appendChild(
    document.createTextNode(
      ' (sets port 12000). On a remote sandbox use the https URL that forwards port 12000, not localhost.',
    ),
  );
})();
