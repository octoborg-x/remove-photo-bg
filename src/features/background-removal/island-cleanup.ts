// The two island-area bars the app can use when it drops disconnected
// foreground specks. Both are fractions of the output image area; the same
// variant is applied by the Stage-4 cleanup (refine-mask.ts) and by the
// flood-recovery despeckle (mask-recovery.ts), and the engine-controls sidebar
// exposes the choice.

export const ISLAND_CLEANUP_FRACTIONS = {
  /** 2e-5 of the frame. The original Stage-4 bar: it removes 1-2 px grain but
   *  keeps small deliberate detail (a distant earring, a thin stem, a distant
   *  product part). */
  fine: 2e-5,
  /** 5e-4 of the frame. Everything the accuracy benchmark counts as speckle
   *  (`SPECKLE_ISLAND_FRACTION` in `scripts/eval/quality_metrics.py`), and the
   *  bar the flood-recovery despeckle needs to clear the speckle gate. */
  strict: 5e-4,
} as const;

export type IslandCleanup = keyof typeof ISLAND_CLEANUP_FRACTIONS;

/** Fine is the product default: it keeps the most subject detail. Strict is the
 *  variant to pick (or to benchmark with `?islands=strict`) when speckle matters
 *  more than the smallest disconnected parts. */
export const DEFAULT_ISLAND_CLEANUP: IslandCleanup = 'fine';

export function isIslandCleanup(v: unknown): v is IslandCleanup {
  return v === 'fine' || v === 'strict';
}

/** Fraction of the output area an island must reach to be kept. */
export function islandFraction(cleanup: IslandCleanup = DEFAULT_ISLAND_CLEANUP): number {
  return ISLAND_CLEANUP_FRACTIONS[cleanup];
}
