// Adaptive source-image downscaling.
//
// The model input is fixed at 512x512, so the pixels that matter for inference
// are always small. What is NOT small is the decoded source: a 12 MP phone photo
// is ~48 MB as RGBA ImageData, and the pipeline holds that buffer (plus a
// canvas backing store) before inference even starts. On a phone that is the
// most likely place to hit the browser's memory budget.
//
// This module is the pure decision layer: given the decoded dimensions and a
// few coarse device hints, decide the largest source side this device should
// process. The caller draws the image once at that size and every later step
// (validation, tensor build, tiling, compositing, export) sees the reduced
// dimensions. It never upscales.
//
// The cap is deliberately at or below `DEFAULT_UPLOAD_LIMITS.maxLongestSide`
// (4096), so a phone photo over the upload cap is fixed here instead of being
// rejected. Desktop keeps the full 4096 cap, so existing desktop behaviour is
// unchanged.

import { DEFAULT_UPLOAD_LIMITS } from './image-validation';

export type DeviceClass = 'mobile' | 'desktop' | 'unknown';

export interface SourceScaleInput {
  width: number;
  height: number;
  /** Coarse device class from the shared UA/UA-CH probe. */
  deviceClass?: DeviceClass;
  /** `navigator.deviceMemory` (GiB), Chromium-only; null/undefined when absent. */
  deviceMemoryGb?: number | null;
  /** `navigator.hardwareConcurrency`; used only when memory is unknown. */
  hardwareConcurrency?: number | null;
  /** Explicit `?maxSourceSide=` override, clamped to the upload cap. */
  maxSourceSide?: number | null;
}

export interface SourceScaleDecision {
  /** Target width after the decision (never larger than the input). */
  width: number;
  /** Target height after the decision (never larger than the input). */
  height: number;
  /** Multiplier applied to the source; 1 means untouched. */
  scale: number;
  downscaled: boolean;
  /** The longest-side cap the decision applied. */
  maxSide: number;
  /** Which rule chose `maxSide`, for the log/report. */
  capSource: 'override' | 'mobile-low-memory' | 'mobile' | 'desktop';
  /** One-line, user-facing sentence (the console log line). */
  reason: string;
}

/** Desktop keeps the documented upload cap; this is the outer hard bound. */
export const DESKTOP_MAX_SOURCE_SIDE = DEFAULT_UPLOAD_LIMITS.maxLongestSide;
/** Mobile GPUs/memory budgets are the constraint; 3072 is 75% of 4096. */
export const MOBILE_MAX_SOURCE_SIDE = 3072;
/** Low-memory phones (<= 2 GB) get a smaller buffer still. */
export const MOBILE_LOW_MEMORY_MAX_SOURCE_SIDE = 2048;
/** `navigator.deviceMemory` is capped at 8 by the spec; 2 means "2 GB or less". */
export const LOW_MEMORY_GB = 2;
/** A `?maxSourceSide=` below this would throw away usable detail. */
export const MIN_SOURCE_SIDE = 512;

function isLowMemory(input: SourceScaleInput): boolean {
  if (typeof input.deviceMemoryGb === 'number' && input.deviceMemoryGb > 0) {
    return input.deviceMemoryGb <= LOW_MEMORY_GB;
  }
  // No memory hint: a 1-2 core device is the same low-end class in practice.
  return typeof input.hardwareConcurrency === 'number' && input.hardwareConcurrency > 0
    ? input.hardwareConcurrency <= 2
    : false;
}

function clampOverride(value: number): number {
  return Math.max(MIN_SOURCE_SIDE, Math.min(DESKTOP_MAX_SOURCE_SIDE, Math.round(value)));
}

/**
 * Chooses the source size to process. Pure: no DOM, no globals, no logging.
 *
 * - an explicit `?maxSourceSide=` wins (clamped to 512..4096);
 * - otherwise a low-memory mobile device caps at 2048, any other mobile at 3072;
 * - desktop and unknown devices keep the 4096 upload cap;
 * - an image already within the cap is returned untouched (never upscaled).
 */
export function recommendSourceScale(input: SourceScaleInput): SourceScaleDecision {
  const width = Number.isFinite(input.width) ? Math.floor(input.width) : 0;
  const height = Number.isFinite(input.height) ? Math.floor(input.height) : 0;
  const longest = Math.max(width, height);

  let maxSide = DESKTOP_MAX_SOURCE_SIDE;
  let capSource: SourceScaleDecision['capSource'] = 'desktop';
  if (typeof input.maxSourceSide === 'number' && Number.isFinite(input.maxSourceSide) && input.maxSourceSide > 0) {
    maxSide = clampOverride(input.maxSourceSide);
    capSource = 'override';
  } else if (input.deviceClass === 'mobile') {
    if (isLowMemory(input)) {
      maxSide = MOBILE_LOW_MEMORY_MAX_SOURCE_SIDE;
      capSource = 'mobile-low-memory';
    } else {
      maxSide = MOBILE_MAX_SOURCE_SIDE;
      capSource = 'mobile';
    }
  }

  if (!(width > 0 && height > 0) || longest <= maxSide) {
    return {
      width: width > 0 ? width : input.width,
      height: height > 0 ? height : input.height,
      scale: 1,
      downscaled: false,
      maxSide,
      capSource,
      reason:
        longest > 0
          ? `Keeping the full ${width}×${height} source (within this device's ${maxSide}px limit).`
          : 'The image has no usable pixel dimensions.',
    };
  }

  const scale = maxSide / longest;
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  return {
    width: targetWidth,
    height: targetHeight,
    scale,
    downscaled: true,
    maxSide,
    capSource,
    reason:
      `Reduced from ${width}×${height} to ${targetWidth}×${targetHeight} ` +
      'so this device can process it reliably.',
  };
}
