// Manual retouch brush math for the Result editor.
//
// A stroke is a path of points plus a circular brush. The brush is stamped
// along the path with a radial falloff (hard core, soft edge), and the per-stroke
// weights are combined with `max` before they are applied, so overlapping stamps
// inside one stroke cannot build up a darker rim. Restore moves alpha towards 1,
// erase towards 0; the RGB pixels of the photo are never touched.
//
// Everything here is pure and DOM-free: float alpha in, float alpha out. The
// caller owns the committed mask and passes a working copy (or a base alpha that
// is replayed from scratch), which keeps undo/redo deterministic.

export type BrushTool = 'restore' | 'erase';

export interface BrushPoint {
  x: number;
  y: number;
  /** Optional 0..1 pressure multiplier for the brush at this point. */
  pressure?: number;
}

export interface BrushStroke {
  tool: BrushTool;
  points: BrushPoint[];
  /** Brush diameter, in the coordinate space passed to applyStroke. */
  size: number;
  /** Soft-edge fraction of the radius: 0 = hard disc, 1 = fully soft. */
  feather: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

interface Stamp {
  x: number;
  y: number;
  pressure: number;
}

/** Stamps every `spacing` px along the path, in alpha-pixel coordinates. */
function stampCenters(
  points: BrushPoint[],
  scaleX: number,
  scaleY: number,
  radius: number,
): Stamp[] {
  if (!points.length) return [];
  const centers: Stamp[] = [];
  const spacing = Math.max(0.75, radius * 0.5);
  const at = (x: number, y: number, pressure: number): void => {
    centers.push({ x: x * scaleX, y: y * scaleY, pressure: clamp01(pressure) });
  };
  if (points.length === 1) {
    at(points[0].x, points[0].y, points[0].pressure ?? 1);
    return centers;
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const ax = a.x * scaleX;
    const ay = a.y * scaleY;
    const bx = b.x * scaleX;
    const by = b.y * scaleY;
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / spacing));
    const start = i === 1 ? 0 : 1; // the first point is only emitted once
    for (let s = start; s <= steps; s++) {
      const t = s / steps;
      const pa = a.pressure ?? 1;
      const pb = b.pressure ?? 1;
      at(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, pa + (pb - pa) * t);
    }
  }
  return centers;
}

/** Stamps one stroke into `out`, which must already be a working copy. */
function stampStroke(
  out: Float32Array,
  width: number,
  height: number,
  stroke: BrushStroke,
  canvasWidth: number,
  canvasHeight: number,
): void {
  if (!stroke.points.length || width <= 0 || height <= 0) return;
  const scaleX = width / Math.max(1e-6, canvasWidth);
  const scaleY = height / Math.max(1e-6, canvasHeight);
  const radius = Math.max(0.5, (stroke.size / 2) * Math.min(scaleX, scaleY));
  const inner = radius * (1 - clamp01(stroke.feather));
  const centers = stampCenters(stroke.points, scaleX, scaleY, radius);
  if (!centers.length) return;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of centers) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
  }
  const x0 = Math.max(0, Math.floor(minX - radius));
  const y0 = Math.max(0, Math.floor(minY - radius));
  const x1 = Math.min(width - 1, Math.ceil(maxX + radius));
  const y1 = Math.min(height - 1, Math.ceil(maxY + radius));
  if (x1 < x0 || y1 < y0) return;

  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const weights = new Float32Array(bw * bh);

  for (const c of centers) {
    const px0 = Math.max(x0, Math.floor(c.x - radius));
    const px1 = Math.min(x1, Math.ceil(c.x + radius));
    const py0 = Math.max(y0, Math.floor(c.y - radius));
    const py1 = Math.min(y1, Math.ceil(c.y + radius));
    for (let y = py0; y <= py1; y++) {
      const dy = y + 0.5 - c.y;
      const row = (y - y0) * bw;
      for (let x = px0; x <= px1; x++) {
        const dx = x + 0.5 - c.x;
        const d = Math.hypot(dx, dy);
        if (d >= radius) continue;
        const w =
          inner >= radius || d <= inner
            ? 1
            : 1 - smoothstep((d - inner) / (radius - inner));
        const weighted = w * c.pressure;
        const wi = row + (x - x0);
        if (weighted > weights[wi]) weights[wi] = weighted;
      }
    }
  }

  for (let y = y0; y <= y1; y++) {
    const row = (y - y0) * bw;
    for (let x = x0; x <= x1; x++) {
      const w = weights[row + (x - x0)];
      if (w <= 0) continue;
      const i = y * width + x;
      const v = Number.isFinite(out[i]) ? out[i] : 0;
      out[i] = stroke.tool === 'restore' ? v + (1 - v) * w : v * (1 - w);
    }
  }
}

/**
 * Applies one stroke to a **copy** of `alpha` and returns the copy. `alpha` is
 * never mutated, so the committed mask stays untouched until the caller commits
 * the result. `canvasWidth`/`canvasHeight` describe the coordinate space the
 * stroke's points and size use (the on-screen preview); they are scaled onto the
 * alpha grid, so the same stroke replays correctly at preview and full
 * resolution.
 */
export function applyStroke(
  alpha: Float32Array,
  width: number,
  height: number,
  stroke: BrushStroke,
  canvasWidth: number = width,
  canvasHeight: number = height,
): Float32Array {
  if (alpha.length !== width * height) {
    throw new Error(
      `applyStroke: expected ${width * height} alpha values, got ${alpha.length}`,
    );
  }
  const out = new Float32Array(alpha);
  stampStroke(out, width, height, stroke, canvasWidth, canvasHeight);
  return out;
}

/**
 * Replays a whole stroke list from `baseAlpha`, in order, into one new array.
 * Deterministic: the same base and strokes always produce the same alpha, with
 * no drift from repeated partial updates. This is the undo/redo rendering path.
 */
export function replayBrushStrokes(
  baseAlpha: Float32Array,
  width: number,
  height: number,
  strokes: readonly BrushStroke[],
  canvasWidth: number = width,
  canvasHeight: number = height,
): Float32Array {
  if (baseAlpha.length !== width * height) {
    throw new Error(
      `replayBrushStrokes: expected ${width * height} alpha values, got ${baseAlpha.length}`,
    );
  }
  const out = new Float32Array(baseAlpha);
  for (const stroke of strokes) stampStroke(out, width, height, stroke, canvasWidth, canvasHeight);
  return out;
}

// ——— Stroke-level undo/redo ———
// Plain immutable state so the reducer stays trivial to test and the UI can keep
// the history in a local variable.

export interface BrushHistory {
  strokes: BrushStroke[];
  redo: BrushStroke[];
}

export function initialBrushHistory(): BrushHistory {
  return { strokes: [], redo: [] };
}

export function canUndoBrush(history: BrushHistory): boolean {
  return history.strokes.length > 0;
}

export function canRedoBrush(history: BrushHistory): boolean {
  return history.redo.length > 0;
}

/** Adds a finished stroke; a new stroke always clears the redo stack. */
export function pushBrushStroke(history: BrushHistory, stroke: BrushStroke): BrushHistory {
  return { strokes: [...history.strokes, stroke], redo: [] };
}

export function undoBrushStroke(history: BrushHistory): BrushHistory {
  if (!history.strokes.length) return history;
  const last = history.strokes[history.strokes.length - 1];
  return {
    strokes: history.strokes.slice(0, -1),
    redo: [...history.redo, last],
  };
}

export function redoBrushStroke(history: BrushHistory): BrushHistory {
  if (!history.redo.length) return history;
  const stroke = history.redo[history.redo.length - 1];
  return {
    strokes: [...history.strokes, stroke],
    redo: history.redo.slice(0, -1),
  };
}
