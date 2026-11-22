export const DEFAULT_LIBVA_DRIVER_NAME = 'iHD';

/**
 * Resolves the VAAPI driver name (`LIBVA_DRIVER_NAME`) from an optional explicit override,
 * `process.env.LIBVA_DRIVER_NAME`, or falls back to `'iHD'`.
 */
export function resolveLibvaDriverName(override?: string): string {
  return override?.trim() || process.env.LIBVA_DRIVER_NAME?.trim() || DEFAULT_LIBVA_DRIVER_NAME;
}
