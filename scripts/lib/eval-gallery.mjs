// Pure helpers for the evaluation gallery. Kept free of I/O and the browser so
// they can be unit-tested (see eval-gallery.test.mjs); scripts/build-eval-gallery.mjs
// supplies the file lookups and does the WebP conversion.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Original-image extensions to probe, in order (the set mixes .jpg and .JPG). */
export const ORIGINAL_EXTS = ['jpg', 'JPG', 'jpeg', 'JPEG', 'png', 'PNG'];

/** Resolves an eval image id to its original file under <root>/eval/images, or null. */
export function findOriginal(root, id) {
  for (const ext of ORIGINAL_EXTS) {
    const p = resolve(root, 'eval', 'images', `${id}.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Pairs the WASM and WebGPU reports by image id and produces the gallery case
 * list. `hasOutput(id, backend)` reports whether that run's cut-out PNG exists.
 * Returns { cases, skipped } — skipped ids are missing an original or a cut-out.
 */
export function buildCases(wasmReport, gpuReport, { hasOutput, hasOriginal } = {}) {
  const gpuById = new Map((gpuReport.rows || []).map((r) => [r.id, r]));
  const cases = [];
  const skipped = [];

  for (const row of wasmReport.rows || []) {
    const { id } = row;
    const gpu = gpuById.get(id);
    const ready =
      gpu &&
      (!hasOriginal || hasOriginal(id)) &&
      (!hasOutput || (hasOutput(id, 'wasm') && hasOutput(id, 'gpu')));
    if (!ready) {
      skipped.push(id);
      continue;
    }
    cases.push({
      id,
      category: row.category,
      title: row.title,
      source: row.source,
      license: row.license,
      wasmMs: Math.round(row.avgMs),
      gpuMs: Math.round(gpu.avgMs),
      wasmOpaqueFrac: row.output?.opaqueFrac ?? null,
      gpuOpaqueFrac: gpu.output?.opaqueFrac ?? null,
      wasmOk: row.ok === true,
      gpuOk: gpu.ok === true,
    });
  }
  return { cases, skipped };
}

/** Aggregate header stats for the gallery manifest. */
export function summarize(cases, model) {
  const n = cases.length || 1;
  return {
    model,
    total: cases.length,
    categories: [...new Set(cases.map((c) => c.category))].sort(),
    meanWasmMs: Math.round(cases.reduce((s, c) => s + c.wasmMs, 0) / n),
    meanGpuMs: Math.round(cases.reduce((s, c) => s + c.gpuMs, 0) / n),
  };
}

/**
 * Benchmark verdict families. `empty` is a *subset* of `FAIL` — the benchmark
 * counts an empty output in its FAIL total and again in its empty count.
 */
export const VERDICT_FAMILIES = ['PASS', 'REVIEW', 'FAIL', 'empty'];

/** `FAIL(gate)` -> `FAIL`, `FAIL(empty)` -> `empty`, `PASS` -> `PASS`. */
export function verdictFamily(verdict) {
  if (!verdict) return null;
  const m = String(verdict).match(/^(\w+)(?:\((\w+)\))?$/);
  if (!m) return String(verdict).trim();
  return m[2] === 'empty' ? 'empty' : m[1];
}

/**
 * Builds the two-up (original | cut-out) case list for a single eval run.
 * `benchmark` is the run's `benchmark.json` (optional): its per-image verdicts
 * are attached so the gallery can badge the same images the gate flags.
 * Returns { cases, skipped } — skipped ids are missing an original or a cut-out.
 */
export function buildPairs(report, benchmark, { hasOutput, hasOriginal } = {}) {
  const bench = new Map((benchmark?.perImage || []).map((r) => [r.id, r]));
  const cases = [];
  const skipped = [];

  for (const row of report.rows || []) {
    const { id } = row;
    if ((hasOriginal && !hasOriginal(id)) || (hasOutput && !hasOutput(id))) {
      skipped.push(id);
      continue;
    }
    const b = bench.get(id);
    cases.push({
      id,
      category: row.category,
      title: row.title,
      source: row.source,
      license: row.license,
      ms: Math.round(row.avgMs),
      ok: row.ok === true,
      opaqueFrac: row.output?.opaqueFrac ?? null,
      verdict: b?.verdict ?? null,
      speckleFrac: b?.speckle_frac ?? null,
      fgFrac: b?.fg_frac ?? null,
    });
  }
  return { cases, skipped };
}

/** Aggregate header stats for the two-up manifest (timing + verdict counts). */
export function summarizeRun(cases, model) {
  const n = cases.length || 1;
  const verdicts = Object.fromEntries(VERDICT_FAMILIES.map((f) => [f, 0]));
  for (const c of cases) {
    const family = verdictFamily(c.verdict);
    if (family && family in verdicts) verdicts[family] += 1;
  }
  return {
    model,
    total: cases.length,
    categories: [...new Set(cases.map((c) => c.category))].sort(),
    meanMs: Math.round(cases.reduce((s, c) => s + c.ms, 0) / n),
    verdicts,
  };
}

/**
 * The three stacked layers of the merged gallery, bottom to top. `before` is the
 * first gallery's cut-out, `after` the second gallery's (revealed by the
 * horizontal slider), `original` the source photo (revealed by the vertical one).
 */
export const MERGED_LAYERS = [
  { key: 'before', suffix: '-before.webp', label: 'Before' },
  { key: 'after', suffix: '-after.webp', label: 'After' },
  { key: 'original', suffix: '-original.webp', label: 'Original' },
];

/**
 * Merges two gallery manifests (first = the older run, second = the newer one)
 * into one case list keyed by image id. Timings, verdicts and dimensions come
 * from whichever manifest has them; ids present in only one manifest are
 * skipped, as are ids whose layer files are missing (`hasFile`).
 */
export function mergeGalleries(first, second, { hasFile } = {}) {
  const newer = new Map((second?.cases || []).map((c) => [c.id, c]));
  const cases = [];
  const skipped = [];

  for (const older of first?.cases || []) {
    const after = newer.get(older.id);
    if (!after) {
      skipped.push(older.id);
      continue;
    }
    if (hasFile && !MERGED_LAYERS.every((layer) => hasFile(older.id, layer.key))) {
      skipped.push(older.id);
      continue;
    }
    cases.push({
      id: older.id,
      category: after.category ?? older.category,
      title: after.title ?? older.title,
      source: after.source ?? older.source,
      license: after.license ?? older.license,
      width: older.width ?? after.width,
      height: older.height ?? after.height,
      beforeMs: older.wasmMs ?? null,
      afterMs: after.ms ?? null,
      ok: after.ok !== false,
      verdict: after.verdict ?? null,
      speckleFrac: after.speckleFrac ?? null,
      fgFrac: after.fgFrac ?? null,
    });
  }
  return { cases, skipped };
}

/** Header stats for the merged manifest: both means plus the verdict families. */
export function summarizeMerged(cases, model) {
  const mean = (pick) => {
    const values = cases.map(pick).filter((v) => Number.isFinite(v));
    return values.length ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : 0;
  };
  const verdicts = Object.fromEntries(VERDICT_FAMILIES.map((f) => [f, 0]));
  for (const c of cases) {
    const family = verdictFamily(c.verdict);
    if (family && family in verdicts) verdicts[family] += 1;
  }
  return {
    model,
    total: cases.length,
    categories: [...new Set(cases.map((c) => c.category))].sort(),
    meanBeforeMs: mean((c) => c.beforeMs),
    meanAfterMs: mean((c) => c.afterMs),
    verdicts,
  };
}
