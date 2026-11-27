import { describe, it, expect } from 'vitest';
import {
  buildCases,
  summarize,
  ORIGINAL_EXTS,
  buildPairs,
  summarizeRun,
  verdictFamily,
  mergeGalleries,
  summarizeMerged,
  MERGED_LAYERS,
} from './eval-gallery.mjs';

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

const run = { model: 'qmix-cut-512', rows: [row('a'), row('b'), row('c', { ok: false })] };
const bench = {
  perImage: [
    { id: 'a', verdict: 'PASS', speckle_frac: 0, fg_frac: 0.4 },
    { id: 'b', verdict: 'FAIL(gate)', speckle_frac: 0.5, fg_frac: 0.3 },
  ],
};

describe('buildPairs', () => {
  it('keeps one row per image with its timing and cut-out status', () => {
    const { cases, skipped } = buildPairs(run, bench);
    expect(skipped).toEqual([]);
    expect(cases.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(cases[0].ms).toBe(12000);
    expect(cases[0].ok).toBe(true);
    expect(cases[2].ok).toBe(false);
  });

  it('attaches the benchmark verdict per image and leaves unknown ids null', () => {
    const { cases } = buildPairs(run, bench);
    expect(cases[0].verdict).toBe('PASS');
    expect(cases[1].verdict).toBe('FAIL(gate)');
    expect(cases[1].speckleFrac).toBe(0.5);
    expect(cases[2].verdict).toBeNull();
  });

  it('works without a benchmark (no verdicts to attach)', () => {
    const { cases } = buildPairs(run, null);
    expect(cases.map((c) => c.verdict)).toEqual([null, null, null]);
  });

  it('skips ids missing an original or a cut-out PNG', () => {
    const { cases, skipped } = buildPairs(run, bench, {
      hasOriginal: (id) => id !== 'a',
      hasOutput: (id) => id !== 'b',
    });
    expect(cases.map((c) => c.id)).toEqual(['c']);
    expect(skipped).toEqual(['a', 'b']);
  });

  it('tolerates a report with no rows', () => {
    expect(buildPairs({}, bench).cases).toEqual([]);
  });
});

describe('verdictFamily', () => {
  it('strips the parenthetical detail and passes plain verdicts through', () => {
    expect(verdictFamily('FAIL(gate)')).toBe('FAIL');
    expect(verdictFamily('FAIL(empty)')).toBe('empty');
    expect(verdictFamily('REVIEW')).toBe('REVIEW');
    expect(verdictFamily(null)).toBeNull();
  });
});

describe('summarizeRun', () => {
  it('counts verdict families and rounds the mean inference time', () => {
    const { cases } = buildPairs(run, bench);
    const s = summarizeRun(cases, 'qmix-cut-512');
    expect(s.total).toBe(3);
    expect(s.model).toBe('qmix-cut-512');
    expect(s.categories).toEqual(['accessory']);
    expect(s.meanMs).toBe(12000);
    expect(s.verdicts).toEqual({ PASS: 1, REVIEW: 0, FAIL: 1, empty: 0 });
  });

  it('has zeroed verdict counts when the run has no benchmark', () => {
    const { cases } = buildPairs(run, null);
    expect(summarizeRun(cases, 'm').verdicts).toEqual({ PASS: 0, REVIEW: 0, FAIL: 0, empty: 0 });
  });

  it('does not divide by zero on an empty list', () => {
    expect(summarizeRun([], 'm').meanMs).toBe(0);
  });
});

describe('mergeGalleries', () => {
  const older = (id, extra = {}) => ({
    id,
    category: 'accessory',
    title: `File:${id}.jpg`,
    source: 'https://example.org',
    license: 'Public domain',
    wasmMs: 15000,
    gpuMs: 7000,
    width: 768,
    height: 1024,
    ...extra,
  });
  const newer = (id, extra = {}) => ({
    id,
    category: 'accessory',
    title: `File:${id}.jpg`,
    source: 'https://example.org',
    license: 'Public domain',
    ms: 5000,
    ok: true,
    verdict: 'REVIEW',
    speckleFrac: 0.01,
    fgFrac: 0.4,
    width: 768,
    height: 1024,
    ...extra,
  });

  it('keeps only ids present in both galleries', () => {
    const { cases, skipped } = mergeGalleries(
      { cases: [older('a'), older('only-old')] },
      { cases: [newer('a'), newer('only-new')] },
    );
    expect(cases.map((c) => c.id)).toEqual(['a']);
    expect(skipped).toEqual(['only-old']);
  });

  it('takes the before timing from the older gallery and the after one from the newer', () => {
    const { cases } = mergeGalleries({ cases: [older('a')] }, { cases: [newer('a')] });
    expect(cases[0].beforeMs).toBe(15000);
    expect(cases[0].afterMs).toBe(5000);
    expect(cases[0].verdict).toBe('REVIEW');
    expect(cases[0].speckleFrac).toBe(0.01);
    expect(cases[0].width).toBe(768);
  });

  it('drops cases whose layer files are missing', () => {
    const hasFile = (id, layer) => !(id === 'a' && layer === 'after');
    const { cases, skipped } = mergeGalleries(
      { cases: [older('a'), older('b')] },
      { cases: [newer('a'), newer('b')] },
      { hasFile },
    );
    expect(cases.map((c) => c.id)).toEqual(['b']);
    expect(skipped).toEqual(['a']);
  });

  it('treats a missing ok flag as success and keeps a false one', () => {
    const { cases } = mergeGalleries(
      { cases: [older('a'), older('b')] },
      { cases: [newer('a', { ok: undefined }), newer('b', { ok: false })] },
    );
    expect(cases.map((c) => c.ok)).toEqual([true, false]);
  });

  it('describes exactly three layers, bottom to top', () => {
    expect(MERGED_LAYERS.map((l) => l.key)).toEqual(['before', 'after', 'original']);
    expect(MERGED_LAYERS.map((l) => l.suffix)).toEqual(['-before.webp', '-after.webp', '-original.webp']);
  });
});

describe('summarizeMerged', () => {
  it('averages both runs and counts the verdict families', () => {
    const cases = [
      { beforeMs: 10000, afterMs: 4000, verdict: 'PASS' },
      { beforeMs: 20000, afterMs: 6000, verdict: 'FAIL(gate)' },
      { beforeMs: 15000, afterMs: 8000, verdict: 'FAIL(empty)' },
      { beforeMs: null, afterMs: 8000, verdict: null },
    ];
    const s = summarizeMerged(cases, 'qmix-cut-512');
    expect(s.total).toBe(4);
    expect(s.meanBeforeMs).toBe(15000);
    expect(s.meanAfterMs).toBe(6500);
    expect(s.verdicts).toEqual({ PASS: 1, REVIEW: 0, FAIL: 1, empty: 1 });
  });

  it('does not divide by zero on an empty list', () => {
    const s = summarizeMerged([], 'm');
    expect(s.meanBeforeMs).toBe(0);
    expect(s.meanAfterMs).toBe(0);
    expect(s.total).toBe(0);
  });
});
