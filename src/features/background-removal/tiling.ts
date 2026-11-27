// Tiled ("patched") inference: split the photo into overlapping tiles, run each
// through the 512px model, then stitch the per-tile probability masks back into
// one full-resolution soft mask.
//
// Why it helps: the model is fixed at 512x512, so a 1280x1920 photo letterboxes
// to a 341x512 mask that must be upscaled ~3.75x to the original size — and a
// bilinear upscale cannot invent edge detail. Running 2x2 tiles makes each tile
// ~3.75/2 ≈ 1.9x, so the mask carries roughly twice the edge resolution. The
// cost is N times the inference time (each tile is a full 512px run), which is
// why it is an opt-in control, not the default.
//
// This module is pure (no DOM, no worker): the caller runs the tiles and hands
// the per-tile masks in. That keeps the tiling geometry, the feather blend and
// the recommendation heuristic unit-testable in Node.

/** Number of tiles per axis. 1 = off (single full-image run). */
export type TileGrid = 1 | 2 | 3 | 4;

export const TILE_GRIDS: readonly TileGrid[] = [1, 2, 3, 4];

/** Fraction of a tile's span that overlaps its neighbour, per axis. 0.25 means
 *  a 25% overlap band, enough for the feather crossfade to hide the seam. */
export const DEFAULT_TILE_OVERLAP = 0.25;

export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TilePlan {
  grid: TileGrid;
  /** Overlap band width in destination pixels (0 when grid === 1). */
  overlapX: number;
  overlapY: number;
  /** Global centre of each interior seam, so the two neighbouring ramps use the
   *  same reference and their weights sum to exactly 1 across the band. */
  seamsX: number[];
  seamsY: number[];
  /** Row-major tiles: index = row * grid + col. */
  tiles: TileRect[];
}

/** A 2x2 tile only sharpens the mask when each tile is still at least the model
 *  input size on its long side; below that the tile is *upscaled* into 512 and
 *  the gain is lost (and border artefacts are averaged in). So tiling is only
 *  worth offering on images at least this many pixels on the long side. */
export const TILING_MIN_LONG_SIDE = 1024;

/** The full-image upscale ratio above which tiling measurably sharpens the edge
 *  (image long side / model input size). ~2.5x is where the transition band
 *  starts to visibly soften. */
export const TILING_UPSCALE_TRIGGER = 2.5;

/** Soft-edge share (fraction of output pixels in the 0.02..0.98 alpha band) above
 *  which an edge is "soft" and tiling is worth offering. Measured on the three
 *  reference cut-outs: a crisp edge reads 0.021–0.029, a blurred one 0.084–0.116,
 *  at every output size — so this sits in the empty middle of that gap. */
export const TILING_SOFT_EDGE_MIN = 0.05;

/**
 * Plans a `grid` x `grid` set of overlapping tiles covering `imageWidth` x
 * `imageHeight`. Each interior seam sits at an even fraction of the image and
 * the two tiles on either side extend half the overlap band past it, so adjacent
 * tiles share a band `overlapX` wide (horizontally) or `overlapY` tall
 * (vertically). A grid of 1 yields a single full-image tile.
 */
export function planTiles(
  imageWidth: number,
  imageHeight: number,
  grid: TileGrid,
  overlapFraction = DEFAULT_TILE_OVERLAP,
): TilePlan {
  if (!(imageWidth > 0 && imageHeight > 0)) {
    throw new Error(`planTiles: invalid image size ${imageWidth}x${imageHeight}`);
  }
  if (grid === 1) {
    return {
      grid,
      overlapX: 0,
      overlapY: 0,
      seamsX: [],
      seamsY: [],
      tiles: [{ x: 0, y: 0, width: imageWidth, height: imageHeight }],
    };
  }
  const seamsX: number[] = [];
  const seamsY: number[] = [];
  for (let i = 1; i < grid; i++) {
    seamsX.push(Math.round((i / grid) * imageWidth));
    seamsY.push(Math.round((i / grid) * imageHeight));
  }
  const overlapX = Math.max(2, Math.round((imageWidth / grid) * overlapFraction));
  const overlapY = Math.max(2, Math.round((imageHeight / grid) * overlapFraction));
  const halfX = Math.max(1, Math.round(overlapX / 2));
  const halfY = Math.max(1, Math.round(overlapY / 2));
  const tiles: TileRect[] = [];
  for (let row = 0; row < grid; row++) {
    for (let col = 0; col < grid; col++) {
      const x0 = col === 0 ? 0 : seamsX[col - 1] - halfX;
      const x1 = col === grid - 1 ? imageWidth : seamsX[col] + halfX;
      const y0 = row === 0 ? 0 : seamsY[row - 1] - halfY;
      const y1 = row === grid - 1 ? imageHeight : seamsY[row] + halfY;
      tiles.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    }
  }
  return { grid, overlapX: 2 * halfX, overlapY: 2 * halfY, seamsX, seamsY, tiles };
}

/** Complementary ramp pair across one seam: `left` runs 1 -> 0 and `right` runs
 *  0 -> 1 over the band `[seam - half, seam + half]`. They sum to exactly 1
 *  everywhere, so the crossfade of two neighbours is a clean blend. */
function seamRamp(pos: number, seam: number, half: number): { left: number; right: number } {
  const t = Math.max(0, Math.min(1, (pos - (seam - half)) / (2 * half)));
  return { left: 1 - t, right: t };
}

/**
 * Per-pixel blend weight for one tile at destination resolution. The weight is 1
 * in the tile's interior and ramps to 0 across each interior seam it touches, so
 * two neighbours' weights sum to exactly 1 across the overlap band — a crossfade,
 * not a plain average. At the image border the weight stays 1 (no neighbour).
 *
 * The tile's own row/column (from `tileIndex`) decides which side of a seam it
 * is on, not the pixel's global position — a tile's near edge lies on the
 * *far* side of the seam it abuts.
 */
export function tileWeightField(plan: TilePlan, tileIndex: number): Float32Array {
  const tile = plan.tiles[tileIndex];
  if (!tile) throw new Error(`tileWeightField: no tile at index ${tileIndex}`);
  const { width: w, height: h } = tile;
  const out = new Float32Array(w * h);
  if (plan.grid === 1) {
    out.fill(1);
    return out;
  }
  const col = tileIndex % plan.grid;
  const row = Math.floor(tileIndex / plan.grid);
  const halfX = Math.floor(plan.overlapX / 2);
  const halfY = Math.floor(plan.overlapY / 2);
  for (let y = 0; y < h; y++) {
    const gy = tile.y + y;
    let wy = 1;
    plan.seamsY.forEach((seam, k) => {
      if (row === k) wy *= seamRamp(gy, seam, halfY).left;
      else if (row === k + 1) wy *= seamRamp(gy, seam, halfY).right;
    });
    for (let x = 0; x < w; x++) {
      const gx = tile.x + x;
      let wx = 1;
      plan.seamsX.forEach((seam, k) => {
        if (col === k) wx *= seamRamp(gx, seam, halfX).left;
        else if (col === k + 1) wx *= seamRamp(gx, seam, halfX).right;
      });
      out[y * w + x] = wx * wy;
    }
  }
  return out;
}

/**
 * Accumulates weighted per-tile masks into one full-resolution soft mask.
 *
 * Each tile's mask must already be resampled to the tile's pixel size (the
 * caller reuses `resizeMaskFloat` for that). Weights are normalised by their sum,
 * so the result is a crossfade in the overlaps and the tile value itself where a
 * pixel is covered once. `coverage` records how many tiles touched each pixel,
 * which the recommendation/report can surface.
 */
export class TileStitcher {
  private readonly acc: Float32Array;
  private readonly wsum: Float32Array;
  private readonly cover: Uint8Array;

  constructor(
    readonly imageWidth: number,
    readonly imageHeight: number,
    private readonly plan: TilePlan,
  ) {
    this.acc = new Float32Array(imageWidth * imageHeight);
    this.wsum = new Float32Array(imageWidth * imageHeight);
    this.cover = new Uint8Array(imageWidth * imageHeight);
  }

  add(tileIndex: number, mask: Float32Array): void {
    const tile = this.plan.tiles[tileIndex];
    if (!tile) throw new Error(`TileStitcher.add: no tile at index ${tileIndex}`);
    const { width: tw, height: th } = tile;
    if (mask.length !== tw * th) {
      throw new Error(
        `TileStitcher.add: mask length ${mask.length} does not match tile ${tw}x${th}`,
      );
    }
    const weights = tileWeightField(this.plan, tileIndex);
    for (let y = 0; y < th; y++) {
      const dstRow = (tile.y + y) * this.imageWidth + tile.x;
      const srcRow = y * tw;
      for (let x = 0; x < tw; x++) {
        const v = mask[srcRow + x];
        const value = Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
        const wt = weights[srcRow + x];
        this.acc[dstRow + x] += value * wt;
        this.wsum[dstRow + x] += wt;
        this.cover[dstRow + x] += 1;
      }
    }
  }

  /** The stitched soft mask in [0,1]. */
  result(): Float32Array {
    const out = new Float32Array(this.acc.length);
    for (let i = 0; i < out.length; i++) {
      const w = this.wsum[i];
      out[i] = w > 0 ? this.acc[i] / w : 0;
    }
    return out;
  }

  /** How many tiles covered each pixel (>=1 everywhere for a full plan). */
  coverage(): Uint8Array {
    return this.cover;
  }
}

export interface TilingRecommendationInput {
  imageWidth: number;
  imageHeight: number;
  /** Share of mask pixels in the 0.02..0.98 transition band (0..1), if a first
   *  result already exists. Omit before the first run. */
  softEdgeShare?: number;
  /** Foreground components from the diagnostic report, if known. Many small
   *  components (speckle) also benefit from the sharper tile mask. */
  componentCount?: number;
}

export interface TilingRecommendation {
  recommended: boolean;
  /** The grid to suggest (2 when recommended, otherwise 1 = off). */
  suggestedGrid: TileGrid;
  /** One-line, user-facing reason (shown in the sidebar info panel). */
  reason: string;
}

/**
 * Decides whether tiling is worth recommending for an image. Deliberately
 * conservative: it only fires when the upscale ratio is high enough that the
 * gain is real and the tiles stay above the model input size, and (when a first
 * mask exists) when the edge is actually soft. It never suggests more than 2x2,
 * because beyond that the tiles fall below 512px and measured sharpness regresses.
 */
export function recommendTiling(input: TilingRecommendationInput): TilingRecommendation {
  const longSide = Math.max(input.imageWidth, input.imageHeight);
  const upscale = longSide / 512;
  if (longSide < TILING_MIN_LONG_SIDE) {
    return {
      recommended: false,
      suggestedGrid: 1,
      reason: `This photo is ${longSide}px on its longest side — the 512px model already sees it at about 1x, so tiling would add no detail.`,
    };
  }
  if (upscale < TILING_UPSCALE_TRIGGER) {
    return {
      recommended: false,
      suggestedGrid: 1,
      reason: `The mask is only upscaled ${upscale.toFixed(1)}x here, so tiling would cost extra time for little gain.`,
    };
  }
  if (input.softEdgeShare !== undefined && input.softEdgeShare < TILING_SOFT_EDGE_MIN) {
    return {
      recommended: false,
      suggestedGrid: 1,
      reason: 'The cut-out edges are already crisp, so tiling would not help this photo.',
    };
  }
  const soft =
    input.softEdgeShare !== undefined
      ? ` and a wide soft edge (${(input.softEdgeShare * 100).toFixed(1)}% of pixels)`
      : '';
  return {
    recommended: true,
    suggestedGrid: 2,
    reason: `This photo is upscaled ${upscale.toFixed(1)}x from the model's 512px mask${soft}. Running 2x2 tiles sharpens fine edges, at about 4x the processing time.`,
  };
}
