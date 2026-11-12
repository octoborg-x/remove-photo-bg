// Configuration for the progressive-refinement stage that runs on the soft
// probability mask *after* the 512px model inference and *before* compositing.
//
// The model, its weights and its ONNX contract are untouched by this stage; it
// only post-processes the mask the model already produced. The whole stage is
// guided by the original image, runs client-side, and is skipped entirely when
// `enabled` is false (so a run can be A/B compared against the unrefined mask).

export type MaskInterpolation = 'bilinear' | 'bicubic';

export interface FastRefinementConfig {
  /** Master switch. When false, Stages 3-4 are bypassed and the unrefined mask
   *  is composited exactly as before this feature existed. */
  enabled: boolean;
  maskUpscale: {
    interpolation: MaskInterpolation;
  };
  edgeRefinement: {
    enabled: boolean;
    algorithm: 'guided-filter';
    /** Filter window radius, in destination pixels. */
    radius: number;
    /** Guided-filter regularization term (guide is in [0,1]). */
    epsilon: number;
    /** Blend between the raw mask and the filtered mask (0 = unfiltered, 1 = fully filtered). */
    strength: number;
    /** How aggressively a boundary is treated as real vs noise. >1 follows image
     *  edges more closely (sharper, less smoothing); <1 smooths more. */
    edgeSensitivity: number;
  };
  cleanup: {
    enabled: boolean;
    /** Kept soft: semi-transparent edge pixels are never forced to 0 or 1. */
    preserveSoftAlpha: true;
    /** Output clamp lower bound. */
    minAlpha: number;
    /** Output clamp upper bound. */
    maxAlpha: number;
    removeTinyIsolatedNoise: boolean;
  };
  performance: {
    useWorker: boolean;
    /** Rows processed per chunk before yielding (also bounds peak memory). */
    chunkRows: number;
    /** Above this pixel count the stage works on a downscaled copy. */
    maxProcessingPixels: number;
  };
}

export const DEFAULT_FAST_REFINEMENT: FastRefinementConfig = {
  enabled: true,
  maskUpscale: { interpolation: 'bilinear' },
  edgeRefinement: {
    enabled: true,
    algorithm: 'guided-filter',
    radius: 3,
    epsilon: 1e-3,
    strength: 0.5,
    edgeSensitivity: 1,
  },
  cleanup: {
    enabled: true,
    preserveSoftAlpha: true,
    minAlpha: 0,
    maxAlpha: 1,
    removeTinyIsolatedNoise: true,
  },
  performance: {
    useWorker: true,
    chunkRows: 64,
    maxProcessingPixels: 4096 * 4096,
  },
};

function isFiniteInRange(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

function isMaskInterpolation(v: unknown): v is MaskInterpolation {
  return v === 'bilinear' || v === 'bicubic';
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * Structural validation for a fully-specified config. Every numeric field is
 * bounded so no combination can produce an invalid array size or an unbounded
 * loop (a zero/negative radius, a zero chunk size, an inverted alpha range, or a
 * non-finite epsilon are all rejected).
 */
export function isFastRefinementConfig(v: unknown): v is FastRefinementConfig {
  const o = asRecord(v);
  if (!o) return false;
  if (typeof o.enabled !== 'boolean') return false;
  const up = asRecord(o.maskUpscale);
  if (!up || !isMaskInterpolation(up.interpolation)) return false;
  const er = asRecord(o.edgeRefinement);
  if (!er) return false;
  if (er.algorithm !== 'guided-filter') return false;
  if (typeof er.enabled !== 'boolean') return false;
  if (!isFiniteInRange(er.radius, 1, 64)) return false;
  if (!isFiniteInRange(er.epsilon, 1e-8, 1)) return false;
  if (!isFiniteInRange(er.strength, 0, 1)) return false;
  if (!isFiniteInRange(er.edgeSensitivity, 0.05, 8)) return false;
  const cl = asRecord(o.cleanup);
  if (!cl) return false;
  if (typeof cl.enabled !== 'boolean') return false;
  if (cl.preserveSoftAlpha !== true) return false;
  if (!isFiniteInRange(cl.minAlpha, 0, 1)) return false;
  if (!isFiniteInRange(cl.maxAlpha, 0, 1)) return false;
  if ((cl.minAlpha as number) > (cl.maxAlpha as number)) return false;
  if (typeof cl.removeTinyIsolatedNoise !== 'boolean') return false;
  const pf = asRecord(o.performance);
  if (!pf) return false;
  if (typeof pf.useWorker !== 'boolean') return false;
  if (!isFiniteInRange(pf.chunkRows, 1, 1024)) return false;
  if (!isFiniteInRange(pf.maxProcessingPixels, 1, 8192 * 8192)) return false;
  return true;
}

function clampNumber(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Builds a validated config from partial overrides, filling the rest from the
 * defaults. Out-of-range overrides are clamped rather than rejected, so a URL
 * override can never produce an invalid config (the result always passes
 * `isFastRefinementConfig`).
 */
export function resolveRefinementConfig(
  partial?: Partial<FastRefinementConfig> | null,
): FastRefinementConfig {
  const d = DEFAULT_FAST_REFINEMENT;
  const up = partial?.maskUpscale;
  const er = partial?.edgeRefinement;
  const cl = partial?.cleanup;
  const pf = partial?.performance;
  const minAlpha = clampNumber(cl?.minAlpha ?? d.cleanup.minAlpha, 0, 1);
  const maxAlpha = clampNumber(cl?.maxAlpha ?? d.cleanup.maxAlpha, 0, 1);
  return {
    enabled: partial?.enabled ?? d.enabled,
    maskUpscale: {
      interpolation: isMaskInterpolation(up?.interpolation) ? up!.interpolation : d.maskUpscale.interpolation,
    },
    edgeRefinement: {
      enabled: er?.enabled ?? d.edgeRefinement.enabled,
      algorithm: 'guided-filter',
      radius: Math.round(clampNumber(er?.radius ?? d.edgeRefinement.radius, 1, 64)),
      epsilon: clampNumber(er?.epsilon ?? d.edgeRefinement.epsilon, 1e-8, 1),
      strength: clampNumber(er?.strength ?? d.edgeRefinement.strength, 0, 1),
      edgeSensitivity: clampNumber(er?.edgeSensitivity ?? d.edgeRefinement.edgeSensitivity, 0.05, 8),
    },
    cleanup: {
      enabled: cl?.enabled ?? d.cleanup.enabled,
      preserveSoftAlpha: true,
      minAlpha: Math.min(minAlpha, maxAlpha),
      maxAlpha: Math.max(minAlpha, maxAlpha),
      removeTinyIsolatedNoise: cl?.removeTinyIsolatedNoise ?? d.cleanup.removeTinyIsolatedNoise,
    },
    performance: {
      useWorker: pf?.useWorker ?? d.performance.useWorker,
      chunkRows: Math.round(clampNumber(pf?.chunkRows ?? d.performance.chunkRows, 1, 1024)),
      maxProcessingPixels: Math.round(
        clampNumber(pf?.maxProcessingPixels ?? d.performance.maxProcessingPixels, 1, 8192 * 8192),
      ),
    },
  };
}

/**
 * Reads the debug/A-B overrides from a URL query. Only the fields needed to
 * compare refined vs unrefined output are exposed (`?refine=off`, plus a few
 * numeric knobs); the product exposes no tuning UI.
 */
export function refinementConfigFromParams(params: URLSearchParams): FastRefinementConfig {
  const num = (name: string): number | undefined => {
    const raw = params.get(name);
    if (raw === null || raw === '') return undefined;
    const v = Number(raw);
    return Number.isFinite(v) ? v : undefined;
  };
  const partial: Partial<FastRefinementConfig> = {};
  const refine = params.get('refine');
  if (refine !== null) partial.enabled = refine !== 'off' && refine !== '0' && refine !== 'false';

  const er: Partial<FastRefinementConfig['edgeRefinement']> = {};
  if (refine === 'edges-off') er.enabled = false;
  const radius = num('refineRadius');
  const epsilon = num('refineEpsilon');
  const strength = num('refineStrength');
  const edgeSensitivity = num('refineEdgeSensitivity');
  if (radius !== undefined) er.radius = radius;
  if (epsilon !== undefined) er.epsilon = epsilon;
  if (strength !== undefined) er.strength = strength;
  if (edgeSensitivity !== undefined) er.edgeSensitivity = edgeSensitivity;
  if (Object.keys(er).length) partial.edgeRefinement = er as FastRefinementConfig['edgeRefinement'];

  const cl: Partial<FastRefinementConfig['cleanup']> = {};
  const cleanup = num('refineCleanup');
  const minAlpha = num('refineMinAlpha');
  const maxAlpha = num('refineMaxAlpha');
  if (cleanup !== undefined) cl.enabled = cleanup !== 0;
  if (minAlpha !== undefined) cl.minAlpha = minAlpha;
  if (maxAlpha !== undefined) cl.maxAlpha = maxAlpha;
  if (Object.keys(cl).length) partial.cleanup = cl as FastRefinementConfig['cleanup'];

  return resolveRefinementConfig(partial);
}
