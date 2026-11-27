// Guards the shared island/speckle area bars (issue #145): the app's Stage-4
// cleanup and the flood-recovery despeckle both take the fraction of the
// selected `IslandCleanup` variant (`island-cleanup.ts`), and the accuracy
// benchmark's speckle gate must count the same `strict` number. The Python side
// asserts the same thing in `accuracy-benchmark.py --self-test`
// (`_selftest_constants`), so a change to one without the other fails CI.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MIN_ISLAND_FRACTION, MIN_ISLAND_FRACTION_STRICT } from './refine-mask';
import { MIN_RECOVERY_ISLAND_FRACTION } from './mask-recovery';
import { ISLAND_CLEANUP_FRACTIONS } from './island-cleanup';

const ROOT = resolve(__dirname, '..', '..', '..');
const QUALITY_METRICS = readFileSync(resolve(ROOT, 'scripts/eval/quality_metrics.py'), 'utf8');
const DOC = readFileSync(resolve(ROOT, 'docs/accuracy-benchmark.md'), 'utf8');

/** Read a `NAME = <number>` module constant out of the Python source. */
function pythonConstant(source: string, name: string): number {
  const m = source.match(new RegExp(`^${name}\\s*=\\s*([0-9.eE+-]+)\\s*$`, 'm'));
  if (!m) throw new Error(`constant ${name} not found in quality_metrics.py`);
  return Number(m[1]);
}

describe('island threshold sync', () => {
  const benchmark = pythonConstant(QUALITY_METRICS, 'SPECKLE_ISLAND_FRACTION');

  it('keeps the two variants distinct and ordered', () => {
    expect(ISLAND_CLEANUP_FRACTIONS.fine).toBe(2e-5);
    expect(ISLAND_CLEANUP_FRACTIONS.strict).toBe(5e-4);
    expect(ISLAND_CLEANUP_FRACTIONS.fine).toBeLessThan(ISLAND_CLEANUP_FRACTIONS.strict);
  });

  it('matches the benchmark speckle fraction with the strict variant', () => {
    expect(benchmark).toBeGreaterThan(0);
    expect(MIN_ISLAND_FRACTION_STRICT).toBe(benchmark);
  });

  it('defaults the app cleanup and the flood-recovery despeckle to fine', () => {
    expect(MIN_ISLAND_FRACTION).toBe(ISLAND_CLEANUP_FRACTIONS.fine);
    expect(MIN_RECOVERY_ISLAND_FRACTION).toBe(MIN_ISLAND_FRACTION);
  });

  it('is the number the benchmark docs state', () => {
    // §3.8 defines speckle as a component below 0.05 % of the frame; §5.1 is
    // the gate, and §5.1.1 documents both variants. A docs-only edit that
    // changes either number must fail here.
    expect(DOC).toMatch(/0\.05\s*%/);
    expect(DOC).toMatch(/2e-5|0\.002\s*%/);
    expect(DOC).toContain('MIN_ISLAND_FRACTION');
  });
});
