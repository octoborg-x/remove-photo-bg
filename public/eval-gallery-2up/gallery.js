// Renders the before/after gallery from ./gallery.json (written by
// scripts/build-eval-gallery.mjs --run <dir>). Static page: no build step.
//
// Each card is the landing page's comparison slider (src/features/compare-slider.ts
// plus the `.compareStage` rules in src/style.css): both images stacked, the
// cut-out clipped at `--pos`, and a divider the pointer can drag. The range
// input is the single source of truth, so arrow keys and screen readers work
// without a pointer.
const grid = document.getElementById('grid');
const metaEl = document.getElementById('meta');
const filtersEl = document.getElementById('filters');
const verdictEl = document.getElementById('verdicts');
const checkerEl = document.getElementById('checker');

const state = { category: 'all', verdict: 'all' };

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);

// `FAIL(gate)` -> FAIL; `FAIL(empty)` -> empty (the benchmark's own sub-count).
const family = (v) => {
  if (!v) return null;
  const m = String(v).match(/^(\w+)(?:\((\w+)\))?$/);
  return m ? (m[2] === 'empty' ? 'empty' : m[1]) : String(v).trim();
};

function card(c) {
  const fam = family(c.verdict);
  const badge = c.verdict ? `<span class="verdict ${fam ? fam.toLowerCase() : ''}">${esc(c.verdict)}</span>` : '';
  const note = [ms(c.ms), c.fgFrac != null ? `fg ${(c.fgFrac * 100).toFixed(0)} %` : null]
    .filter(Boolean)
    .join(' · ');
  return `
    <article class="card" data-category="${esc(c.category)}" data-verdict="${esc(fam || '')}">
      <div class="head">
        <span class="id">${esc(c.id)}</span>
        <span class="cat">${esc(c.category)}</span>
        ${badge}
        <span class="title">${esc(c.title)}${c.source ? ` · <a href="${esc(c.source)}" target="_blank" rel="noopener">source</a>` : ''}</span>
      </div>
      <figure class="compare" data-compare data-pos="50">
        <div class="compareStage" style="--ar: ${c.width} / ${c.height}">
          <img class="compareImg compareBefore" draggable="false" loading="lazy" src="./${esc(c.id)}-original.webp" alt="Original photo — ${esc(c.id)}" />
          <img class="compareImg compareAfter" draggable="false" loading="lazy" src="./${esc(c.id)}-cutout.webp" alt="Background removed — ${esc(c.id)}" />
          <div class="compareDivider" aria-hidden="true"><span class="compareGrip">↔</span></div>
          <span class="compareTag before">Original</span>
          <span class="compareTag after${c.ok ? '' : ' bad'}">Cut-out · ${esc(note)}</span>
        </div>
        <input
          class="compareRange"
          type="range"
          min="0"
          max="100"
          step="1"
          value="50"
          aria-label="Reveal the cut-out for ${esc(c.id)}: left is the original, right is the background removed"
        />
      </figure>
    </article>`;
}

const clamp = (v) => (Number.isNaN(v) ? 50 : Math.max(0, Math.min(100, v)));

/** Wires every comparison figure: the range drives `--pos`, dragging the stage drives the range. */
function initCompare(root) {
  for (const figure of root.querySelectorAll('[data-compare]')) {
    const range = figure.querySelector('.compareRange');
    const stage = figure.querySelector('.compareStage');
    if (!range || !stage) continue;

    const apply = (value) => figure.style.setProperty('--pos', `${clamp(value)}%`);
    const initial = Number(figure.dataset.pos);
    range.value = String(Number.isFinite(initial) ? initial : 50);
    apply(Number(range.value));

    range.addEventListener('input', () => apply(Number(range.value)));

    const setFromPointer = (clientX) => {
      const rect = stage.getBoundingClientRect();
      if (rect.width === 0) return;
      const pct = clamp(((clientX - rect.left) / rect.width) * 100);
      range.value = String(Math.round(pct));
      apply(pct);
    };
    // `dragging` as well as pointer capture: a cancelled gesture (native image
    // drag, a scroll taking over) drops the capture, and a drag must not silently
    // stop halfway.
    let dragging = false;
    const stop = () => {
      dragging = false;
    };
    stage.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = true;
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        // Capture is an optimisation; `dragging` alone keeps the drag working.
      }
      setFromPointer(e.clientX);
    });
    stage.addEventListener('pointermove', (e) => {
      if (dragging || stage.hasPointerCapture(e.pointerId)) setFromPointer(e.clientX);
    });
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }
}

function visible() {
  return window.__gallery.cases.filter(
    (c) =>
      (state.category === 'all' || c.category === state.category) &&
      (state.verdict === 'all' || family(c.verdict) === state.verdict),
  );
}

function render() {
  grid.innerHTML = visible().map(card).join('');
  initCompare(grid);
}

function chips(el, label, pairs, key) {
  el.innerHTML = `<span class="label">${label}</span>` + pairs
    .map(
      ([value, n]) =>
        `<button class="chip" data-value="${esc(value)}" aria-pressed="${value === state[key]}">${esc(value)}<span class="n">${n}</span></button>`,
    )
    .join('');
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    state[key] = btn.dataset.value;
    for (const b of el.querySelectorAll('.chip')) b.setAttribute('aria-pressed', String(b === btn));
    render();
  });
}

fetch('./gallery.json')
  .then((r) => {
    if (!r.ok) throw new Error(`gallery.json: HTTP ${r.status}`);
    return r.json();
  })
  .then((data) => {
    window.__gallery = data;
    const s = data.summary;
    const v = s.verdicts || {};
    const verdictLine = data.benchmark
      ? ` · verdicts <b>PASS ${v.PASS}</b> · REVIEW ${v.REVIEW} · FAIL ${v.FAIL} · empty ${v.empty}`
      : '';
    metaEl.innerHTML =
      `<b>${s.total}</b> images · model <b>${esc(data.model)}</b>` +
      (data.run ? ` · run <code>${esc(data.run)}</code>` : '') +
      ` · mean inference <b>${ms(s.meanMs)}</b>` +
      verdictLine;

    const syncChecker = () => document.body.classList.toggle('no-checker', !checkerEl.checked);
    syncChecker();
    checkerEl.addEventListener('change', syncChecker);

    const cats = new Map();
    for (const c of data.cases) cats.set(c.category, (cats.get(c.category) || 0) + 1);
    chips(filtersEl, 'Category', [['all', data.cases.length], ...[...cats.keys()].sort().map((c) => [c, cats.get(c)])], 'category');

    if (data.benchmark) {
      const fams = new Map();
      for (const c of data.cases) {
        const f = family(c.verdict);
        if (f) fams.set(f, (fams.get(f) || 0) + 1);
      }
      const order = ['PASS', 'REVIEW', 'FAIL', 'empty'].filter((f) => fams.has(f));
      chips(verdictEl, 'Verdict', [['all', data.cases.length], ...order.map((f) => [f, fams.get(f)])], 'verdict');
    }
    render();
  })
  .catch((err) => {
    metaEl.innerHTML = `<b style="color:var(--warn)">Could not load gallery.json — ${esc(err.message)}</b>`;
    grid.innerHTML = `<p style="color:var(--muted)">Run <code>npm run eval:gallery:2up</code> to generate the images, then serve this directory.</p>`;
  });
