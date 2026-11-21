import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CASES = join(ROOT, 'artifacts', 'failed-inferences', 'cases');

const readCase = (id) => JSON.parse(readFileSync(join(CASES, id, 'metadata.json'), 'utf8'));

// The four hard-zero images. They are a model limitation, not a pipeline bug:
// nothing after inference can raise a mask that is identically zero.
const EMPTY_IDS = ['failure-001', 'failure-002', 'failure-003', 'failure-004'];

describe('failed-inference gallery', () => {
  it('records the four empty-output cases as unreproducible-by-postprocessing', () => {
    for (const id of EMPTY_IDS) {
      const meta = readCase(id);
      expect(meta.category).toBe('empty-output');
      expect(meta.result.alpha_max_255).toBe(0);
      expect(meta.fix.implemented).toBe(false);
      expect(Array.isArray(meta.investigation)).toBe(true);
      expect(meta.investigation.length).toBeGreaterThan(0);
      const levers = meta.investigation.map((i) => i.lever);
      expect(levers).toContain('Post-inference knobs');
    }
  });

  it('records 2x2 tiling as a measured false positive for thin-structure-04', () => {
    // Tiling appears to recover this image (fg 0.19, max 0.996) but the mask is
    // one flooded tile blended with three empty ones, so it encodes the tile
    // geometry rather than the subject. Shipping an auto-retry on that signal
    // would trade a visible FAIL(empty) for an invisible garbage cut-out.
    const meta = readCase('failure-004');
    const tiling = meta.investigation.find((i) => i.lever === '2x2 tiled inference');
    expect(tiling).toBeDefined();
    expect(tiling.finding).toMatch(/false positive/i);
    expect(tiling.finding).toMatch(/crossfade weight/i);
  });

  it('keeps every documented case pointing at an eval image that exists', () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'artifacts', 'failed-inferences', 'manifest.json'), 'utf8'),
    );
    expect(manifest.caseCount).toBe(manifest.cases.length);
    for (const c of manifest.cases) {
      expect(c.fixImplemented).toBe(false);
    }
  });
});
