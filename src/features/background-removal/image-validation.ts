// Upload validation per MVP_OPENHANDS.md §6: accept JPEG/PNG/WebP, enforce a
// file-size cap and a longest-side cap, and never trust the file extension.
// The MIME type is checked here and the decode result is checked by the caller
// (an image that fails to decode is rejected there), so a mislabelled file is
// caught either way.

export const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export interface UploadLimits {
  /** Maximum file size in bytes. */
  maxBytes: number;
  /** Maximum length of the longest side in pixels. */
  maxLongestSide: number;
}

// Initial limits from the spec. Configurable so a host or a later build can
// change them without touching the validation logic.
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxBytes: 20 * 1024 * 1024, // 20 MB
  maxLongestSide: 4096,
};

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export function formatLimitBytes(bytes: number): string {
  return `${Math.round(bytes / 1048576)} MB`;
}

/** Validates the file's declared type and size. Dimensions need a decode first. */
export function validateFileTypeAndSize(
  file: File,
  limits: UploadLimits = DEFAULT_UPLOAD_LIMITS,
): ValidationResult {
  const type = (file.type || '').toLowerCase();
  if (!ACCEPTED_MIME_TYPES.includes(type as (typeof ACCEPTED_MIME_TYPES)[number])) {
    const shown = type || 'unknown';
    return {
      ok: false,
      reason: `Unsupported file type "${shown}". Use a JPEG, PNG, or WebP image.`,
    };
  }
  if (file.size <= 0) {
    return { ok: false, reason: 'The file is empty.' };
  }
  if (file.size > limits.maxBytes) {
    return {
      ok: false,
      reason:
        `The file is ${(file.size / 1048576).toFixed(1)} MB, over the ` +
        `${formatLimitBytes(limits.maxBytes)} limit. Resize it and try again.`,
    };
  }
  return { ok: true };
}

/** Validates decoded pixel dimensions against the longest-side cap. */
export function validateDimensions(
  width: number,
  height: number,
  limits: UploadLimits = DEFAULT_UPLOAD_LIMITS,
): ValidationResult {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, reason: 'The image has no usable pixel dimensions.' };
  }
  const longest = Math.max(width, height);
  if (longest > limits.maxLongestSide) {
    return {
      ok: false,
      reason:
        `The image is ${width}x${height}; the longest side must be at most ` +
        `${limits.maxLongestSide} px. Resize it and try again.`,
    };
  }
  return { ok: true };
}
