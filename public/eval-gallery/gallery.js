// Renders the three-layer evaluation gallery from ./gallery.json (written by
// scripts/merge-eval-galleries.mjs). Static page: no build step.
//
// Layer order, bottom to top: `before` (older pipeline cut-out), `after` (newer
// cut-out, clipped at --x), `original` (source photo, clipped at --y). Two bars:
// a vertical one wipes before -> after, a horizontal one reveals the original
// from the top. Each bar has a grip to drag, and each axis has a range input so
// the comparison works with the keyboard and screen readers.
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
  const timing = [c.beforeMs != null ? `before ${ms(c.beforeMs)}` : null, c.afterMs != null ? `after ${ms(c.afterMs)}` : null]
    .filter(Boolean)
    .join(' · ');
  return `
    <article class="card" data-category="${esc(c.category)}" data-verdict="${esc(fam || '')}">
      <div class="head">
        <span class="id">${esc(c.id)}</span>
        <span class="cat">${esc(c.category)}</span>
        ${badge}
        <span class="title">${esc(timing)}${c.source ? ` · <a href="${esc(c.source)}" target="_blank" rel="noopener">source</a>` : ''}</span>
      </div>
      <figure class="compare" data-compare data-x="50" data-y="50">
        <div class="stage" style="--ar: ${c.width} / ${c.height}">
          <img class="layer before" draggable="false" loading="lazy" src="./${esc(c.id)}-before.webp" alt="Cut-out from the older pipeline — ${esc(c.id)}" />
          <img class="layer after" draggable="false" loading="lazy" src="./${esc(c.id)}-after.webp" alt="Cut-out from the newer pipeline — ${esc(c.id)}" />
          <img class="layer original" draggable="false" loading="lazy" src="./${esc(c.id)}-original.webp" alt="Original photo — ${esc(c.id)}" />
          <div class="divider x" aria-hidden="true"></div>
          <div class="divider y" aria-hidden="true"></div>
          <span class="grip x" aria-hidden="true">↔</span>
          <span class="grip y" aria-hidden="true">↕</span>
        </div>
        <div class="ranges">
          <label class="range-row">
            <span class="name">Before ↔ After</span>
            <input class="range-x" type="range" min="0" max="100" step="1" value="50"
              aria-label="Wipe between the older and the newer cut-out of ${esc(c.id)}: left is before, right is after" />
          </label>
          <label class="range-row y">
            <span class="name">Original ↕ Cut-outs</span>
            <input class="range-y" type="range" min="0" max="100" step="1" value="50"
              aria-label="Reveal the original photo of ${esc(c.id)} from the top over the cut-outs" />
          </label>
        </div>
      </figure>
    </article>`;
}

const clamp = (v) => (Number.isNaN(v) ? 50 : Math.max(0, Math.min(100, v)));

/** Wires both axes of every comparison: grips and stage drag the bars, ranges drive the CSS. */
function initCompare(root) {
  for (const figure of root.querySelectorAll('[data-compare]')) {
    const stage = figure.querySelector('.stage');
    const rangeX = figure.querySelector('.range-x');
    const rangeY = figure.querySelector('.range-y');
    if (!stage || !rangeX || !rangeY) continue;

    const setX = (value) => {
      const pct = clamp(value);
      figure.style.setProperty('--x', `${pct}%`);
      rangeX.value = String(Math.round(pct));
    };
    const setY = (value) => {
      const pct = clamp(value);
      figure.style.setProperty('--y', `${pct}%`);
      rangeY.value = String(Math.round(pct));
    };
    setX(Number(figure.dataset.x));
    setY(Number(figure.dataset.y));

    rangeX.addEventListener('input', () => setX(Number(rangeX.value)));
    rangeY.addEventListener('input', () => setY(Number(rangeY.value)));

    const fromPointer = (axis, event) => {
      const rect = stage.getBoundingClientRect();
      if (axis === 'x') {
        if (rect.width === 0) return;
        setX(((event.clientX - rect.left) / rect.width) * 100);
      } else {
        if (rect.height === 0) return;
        setY(((event.clientY - rect.top) / rect.height) * 100);
      }
    };

    // `dragging` as well as pointer capture: a cancelled gesture (native image
    // drag, a scroll taking over) drops the capture, and a drag must not stop
    // halfway through.
    const bindDrag = (target, axis, { stopPropagation = false } = {}) => {
      if (!target) return;
      let dragging = false;
      target.addEventListener('pointerdown', (e) => {
        if (stopPropagation) e.stopPropagation();
        e.preventDefault();
        dragging = true;
        try {
          target.setPointerCapture(e.pointerId);
        } catch {
          // Capture is an optimisation; `dragging` alone keeps the drag working.
        }
        fromPointer(axis, e);
      });
      target.addEventListener('pointermove', (e) => {
        if (dragging) fromPointer(axis, e);
      });
      const stop = () => {
        dragging = false;
      };
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
    };

    bindDrag(figure.querySelector('.grip.x'), 'x', { stopPropagation: true });
    bindDrag(figure.querySelector('.grip.y'), 'y', { stopPropagation: true });
    // Anywhere else on the stage moves the horizontal bar, the primary comparison.
    bindDrag(stage, 'x');
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
      ` · mean inference before <b>${ms(s.meanBeforeMs)}</b> / after <b>${ms(s.meanAfterMs)}</b>` +
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
    grid.innerHTML = `<p style="color:var(--muted)">Run <code>npm run eval:gallery:merge</code> to generate the images, then serve this directory.</p>`;
  });
