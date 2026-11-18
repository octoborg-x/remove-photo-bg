// Renders the evaluation gallery from ./gallery.json (written by
// scripts/build-eval-gallery.mjs). Static page: no build step, no framework.
const grid = document.getElementById('grid');
const metaEl = document.getElementById('meta');
const filtersEl = document.getElementById('filters');
const checkerEl = document.getElementById('checker');

const state = { category: 'all' };

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);

function pane(kind, label, file, msVal, ok) {
  const speed = msVal != null ? `<span class="ms">${ms(msVal)}</span>` : '';
  return `
    <div class="pane ${ok === false ? 'bad' : ok === true ? 'ok' : ''}">
      <div class="tag"><span class="dot"></span>${label}${speed}</div>
      <div class="frame"><img loading="lazy" src="./${esc(file)}" alt="${esc(label)} — ${esc(kind)}" /></div>
    </div>`;
}

function card(c) {
  return `
    <article class="card" data-category="${esc(c.category)}">
      <div class="head">
        <span class="id">${esc(c.id)}</span>
        <span class="cat">${esc(c.category)}</span>
        <span class="title">${esc(c.title)}${c.source ? ` · <a href="${esc(c.source)}" target="_blank" rel="noopener">source</a>` : ''}</span>
      </div>
      <div class="trio">
        ${pane('original', 'Original', `${c.id}-original.webp`, null, null)}
        ${pane('wasm', 'WASM (CPU)', `${c.id}-wasm.webp`, c.wasmMs, c.wasmOk)}
        ${pane('gpu', 'WebGPU', `${c.id}-gpu.webp`, c.gpuMs, c.gpuOk)}
      </div>
    </article>`;
}

function render() {
  const cases = state.category === 'all'
    ? window.__gallery.cases
    : window.__gallery.cases.filter((c) => c.category === state.category);
  grid.innerHTML = cases.map(card).join('');
}

function buildFilters() {
  const counts = new Map();
  for (const c of window.__gallery.cases) counts.set(c.category, (counts.get(c.category) || 0) + 1);
  const cats = [...counts.keys()].sort();
  const chips = [['all', window.__gallery.cases.length], ...cats.map((c) => [c, counts.get(c)])];
  filtersEl.innerHTML = `<span class="label">Category</span>` + chips
    .map(([c, n]) => `<button class="chip" data-cat="${esc(c)}" aria-pressed="${c === 'all'}">${esc(c)}<span class="n">${n}</span></button>`)
    .join('');
  filtersEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    state.category = btn.dataset.cat;
    for (const b of filtersEl.querySelectorAll('.chip')) b.setAttribute('aria-pressed', String(b === btn));
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
    metaEl.innerHTML =
      `<b>${s.total}</b> images · model <b>${esc(data.model)}</b> · ` +
      `mean inference WASM <b>${ms(s.meanWasmMs)}</b> vs WebGPU <b>${ms(s.meanGpuMs)}</b> ` +
      `(${(s.meanWasmMs / s.meanGpuMs).toFixed(1)}× faster)`;
    document.body.classList.toggle('checker', checkerEl.checked);
    checkerEl.addEventListener('change', () => document.body.classList.toggle('checker', checkerEl.checked));
    buildFilters();
    render();
  })
  .catch((err) => {
    metaEl.innerHTML = `<b style="color:var(--warn)">Could not load gallery.json — ${esc(err.message)}</b>`;
    grid.innerHTML = `<p style="color:var(--muted)">Run <code>npm run eval:gallery</code> to generate the images, then serve this directory.</p>`;
  });
