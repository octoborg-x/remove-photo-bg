// Renders the before/after gallery from ./gallery.json (written by
// scripts/build-eval-gallery.mjs --run <dir>). Static page: no build step.
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

function pane(label, file, note, ok) {
  const speed = note ? `<span class="ms">${esc(note)}</span>` : '';
  return `
    <div class="pane ${ok === false ? 'bad' : ok === true ? 'ok' : ''}">
      <div class="tag"><span class="dot"></span>${esc(label)}${speed}</div>
      <div class="frame"><img loading="lazy" src="./${esc(file)}" alt="${esc(label)} — ${esc(file)}" /></div>
    </div>`;
}

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
      <div class="duo">
        ${pane('Original', `${c.id}-original.webp`, null, null)}
        ${pane('Cut-out', `${c.id}-cutout.webp`, note, c.ok)}
      </div>
    </article>`;
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
    document.body.classList.toggle('checker', checkerEl.checked);
    checkerEl.addEventListener('change', () => document.body.classList.toggle('checker', checkerEl.checked));

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
