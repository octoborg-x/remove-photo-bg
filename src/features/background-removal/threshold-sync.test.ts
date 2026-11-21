// Guards the single source of truth for the island/speckle area bar (issue
// #145): the app's Stage-4 cleanup, the flood-recovery despeckle and the
// accuracy benchmark's speckle gate must all use the same fraction. The Python
// side asserts the same thing in `accuracy-benchmark.py --self-test`
// (`_selftest_constants`), so a change to one without the other fails CI.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MIN_ISLAND_FRACTION } from './refine-mask';
import { MIN_RECOVERY_ISLAND_FRACTION } from './mask-recovery';

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

  it('matches the benchmark speckle fraction', () => {
    expect(benchmark).toBeGreaterThan(0);
    expect(MIN_ISLAND_FRACTION).toBe(benchmark);
  });

  it('matches the flood-recovery despeckle fraction', () => {
    expect(MIN_RECOVERY_ISLAND_FRACTION).toBe(MIN_ISLAND_FRACTION);
  });

  it('is the number the benchmark docs state', () => {
    // §3.8 defines speckle as a component below 0.05 % of the frame; §5.1 is
    // the gate. A docs-only edit that changes the number must fail here.
    expect(DOC).toMatch(/0\.05\s*%/);
    expect(DOC).toContain('MIN_ISLAND_FRACTION');
  });
});
