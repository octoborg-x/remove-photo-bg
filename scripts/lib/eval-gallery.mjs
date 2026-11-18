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
