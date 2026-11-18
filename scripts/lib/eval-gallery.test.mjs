import { describe, it, expect } from 'vitest';
import { buildCases, summarize, ORIGINAL_EXTS } from './eval-gallery.mjs';

const row = (id, extra = {}) => ({
  id,
  category: 'accessory',
  title: `File:${id}.jpg`,
  source: 'https://example.org',
  license: 'Public domain',
  ok: true,
  avgMs: 12000,
  output: { opaqueFrac: 0.5 },
  ...extra,
});

const wasm = { model: 'qmix-cut-512', rows: [row('a'), row('b'), row('c')] };
const gpu = { model: 'qmix-cut-512', rows: [row('a', { avgMs: 6000 }), row('b', { avgMs: 6000 }), row('c', { avgMs: 6000 })] };

describe('buildCases', () => {
  it('pairs wasm and gpu rows by id and keeps both timings', () => {
    const { cases, skipped } = buildCases(wasm, gpu);
    expect(skipped).toEqual([]);
    expect(cases.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(cases[0].wasmMs).toBe(12000);
    expect(cases[0].gpuMs).toBe(6000);
  });

  it('skips an id with no matching gpu row', () => {
    const gpuMissing = { rows: [row('a'), row('c')] };
    const { cases, skipped } = buildCases(wasm, gpuMissing);
    expect(cases.map((c) => c.id)).toEqual(['a', 'c']);
    expect(skipped).toEqual(['b']);
  });

  it('skips an id missing an original or a cut-out PNG', () => {
    const { cases, skipped } = buildCases(wasm, gpu, {
      hasOriginal: (id) => id !== 'b',
      hasOutput: (id) => id !== 'c',
    });
    expect(cases.map((c) => c.id)).toEqual(['a']);
    expect(skipped).toEqual(['b', 'c']);
  });

  it('flags a failed run via wasmOk/gpuOk', () => {
    const bad = { rows: [row('a', { ok: false })] };
    const { cases } = buildCases(bad, { rows: [row('a')] });
    expect(cases[0].wasmOk).toBe(false);
    expect(cases[0].gpuOk).toBe(true);
  });

  it('tolerates a report with no rows', () => {
    expect(buildCases({}, {}).cases).toEqual([]);
  });
});

describe('summarize', () => {
  it('reports totals, sorted categories and rounded means', () => {
    const { cases } = buildCases(wasm, gpu);
    const s = summarize(cases, 'qmix-cut-512');
    expect(s.total).toBe(3);
    expect(s.model).toBe('qmix-cut-512');
    expect(s.categories).toEqual(['accessory']);
    expect(s.meanWasmMs).toBe(12000);
    expect(s.meanGpuMs).toBe(6000);
  });

  it('does not divide by zero on an empty list', () => {
    const s = summarize([], 'm');
    expect(s.total).toBe(0);
    expect(Number.isFinite(s.meanWasmMs)).toBe(true);
  });
});

describe('ORIGINAL_EXTS', () => {
  it('covers both upper- and lower-case jpg (the eval set mixes them)', () => {
    expect(ORIGINAL_EXTS).toContain('jpg');
    expect(ORIGINAL_EXTS).toContain('JPG');
  });
});
