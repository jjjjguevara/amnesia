/**
 * Centralized Device Pixel Ratio (DPR) utilities.
 *
 * amnesia-4a8: H7 fix - Ensures consistent DPR handling across the PDF renderer.
 *
 * Key decisions:
 * 1. Default fallback is 2 (Retina) - safer to waste memory on 1x than render blurry on 2x
 * 2. Always read fresh from window.devicePixelRatio (handles display switching)
 * 3. Single source of truth for DPR access
 *
 * @module dpr-utils
 */

/**
 * Default DPR fallback when window is unavailable (SSR, workers, tests).
 * We use 2 (Retina) as the fallback because:
 * - On 1x displays: Wastes some memory but renders correctly
 * - On 2x displays: Renders crisp instead of blurry
 */
export const DEFAULT_DPR = 2;

/**
 * Get the current device pixel ratio.
 *
 * Always reads fresh from window.devicePixelRatio to handle:
 * - Window moving between displays with different DPR
 * - Browser zoom changes
 * - Dynamic DPR changes
 *
 * @returns Current device pixel ratio, or DEFAULT_DPR (2) if unavailable
 */
export function getDevicePixelRatio(): number {
  if (typeof window !== 'undefined' && window.devicePixelRatio) {
    return window.devicePixelRatio;
  }
  return DEFAULT_DPR;
}

/**
 * Check if we're on a high-DPI (Retina) display.
 *
 * @returns true if DPR >= 2
 */
export function isHighDPI(): boolean {
  return getDevicePixelRatio() >= 2;
}

/**
 * Convert CSS pixels to physical (device) pixels.
 *
 * @param cssPixels - Size in CSS pixels
 * @param dpr - Optional DPR override (uses current DPR if not provided)
 * @returns Size in physical pixels (rounded up to ensure full coverage)
 */
export function cssToPhysical(cssPixels: number, dpr?: number): number {
  const ratio = dpr ?? getDevicePixelRatio();
  return Math.ceil(cssPixels * ratio);
}

/**
 * Convert physical (device) pixels to CSS pixels.
 *
 * @param physicalPixels - Size in physical pixels
 * @param dpr - Optional DPR override (uses current DPR if not provided)
 * @returns Size in CSS pixels
 */
export function physicalToCss(physicalPixels: number, dpr?: number): number {
  const ratio = dpr ?? getDevicePixelRatio();
  return physicalPixels / ratio;
}
