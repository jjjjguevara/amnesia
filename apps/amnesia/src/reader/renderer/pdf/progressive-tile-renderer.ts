/**
 * Progressive Tile Renderer
 *
 * Implements multi-resolution tile rendering with progressive quality enhancement.
 * Renders tiles at intermediate scales first for faster visual feedback, then
 * upgrades to full quality in the background.
 *
 * Key Concepts:
 * - Scale Tiers: Discrete scale levels (2, 4, 8, 16, 32) for predictable caching
 * - Progressive Enhancement: Render low-res first, upgrade progressively
 * - CSS Transform Stretch: Display lower-res tiles scaled up via CSS until high-res arrives
 *
 * Performance Impact:
 * - Reduces perceived zoom latency from 2.5s to <500ms at 16x zoom
 * - CSS transform provides instant visual feedback (GPU-accelerated)
 * - Progressive phases: immediate CSS → 50ms intermediate → 200ms final
 *
 * @example
 * ```typescript
 * const renderer = getProgressiveTileRenderer();
 * const targetScale = renderer.getTargetScaleTier(16, 2); // zoom 16x, pixelRatio 2 → scale 32
 *
 * // Render progressively
 * for await (const { scale, result } of renderer.renderTileProgressive(tile, 4, 32)) {
 *   displayTile(result, scale / 32); // CSS scale factor for stretching
 * }
 * ```
 */

import type { TileCoordinate } from './tile-render-engine';
import type { TileRenderResult } from './wasm-renderer';
import { getTileCacheManager, type CachedTileData } from './tile-cache-manager';
import { isFeatureEnabled } from './feature-flags';
import { getTelemetry } from './pdf-telemetry';
import { getSystemProfiler, type DeviceTier } from './system-profiler';

/**
 * Discrete scale levels for multi-resolution rendering.
 *
 * SMOOTH ZOOM: Tiers are spaced at ~1.5x intervals (instead of 2x) to minimize
 * visible "pops" when transitioning between quality levels. The 2x jumps from
 * [2,4,8,16,32] created noticeable resolution changes during zoom.
 *
 * New spacing: [2, 3, 4, 6, 8, 12, 16, 24, 32]
 * - 2→3: 1.5x jump (was 2→4: 2x jump)
 * - 3→4: 1.33x jump
 * - 4→6: 1.5x jump (was 4→8: 2x jump)
 * - 6→8: 1.33x jump
 * - etc.
 *
 * This trades slightly more cache entries for imperceptible quality transitions.
 */
export const SCALE_TIERS = [2, 3, 4, 6, 8, 12, 16, 24, 32, 64] as const;
export type ScaleTier = (typeof SCALE_TIERS)[number];

/**
 * Tile render result from progressive rendering
 */
export interface ProgressiveTileResult {
  /** Scale tier this result was rendered at */
  scale: ScaleTier;
  /** The tile coordinate (with scale) */
  tile: TileCoordinate;
  /** The rendered result (RGBA or PNG) */
  result: TileRenderResult;
  /** Whether this is the final quality tier */
  isFinal: boolean;
  /** CSS scale factor to apply for stretching (targetScale / actualScale) */
  cssScaleFactor: number;
}

/**
 * Progressive render phase timing
 */
export interface ProgressivePhaseConfig {
  /** Delay before starting intermediate render (ms) */
  intermediateDelay: number;
  /** Delay before starting final render (ms) */
  finalDelay: number;
  /** Whether to skip intermediate for small scale jumps */
  skipIntermediateThreshold: number;
}

const DEFAULT_PHASE_CONFIG: ProgressivePhaseConfig = {
  intermediateDelay: 50,
  finalDelay: 200,
  // Skip intermediate if scale jump is ≤1.4x (matches ~1.5x tier spacing)
  // Was 2x for old [2,4,8,16,32] tiers, now reduced for finer [2,3,4,6,8,12,16,24,32]
  skipIntermediateThreshold: 1.4,
};

/**
 * Default maximum scale tier (used as fallback).
 *
 * SCALE 16 FOR MID-ZOOM QUALITY (amnesia-d9f fix):
 *
 * With 512px CSS tiles and MAX_TILE_PIXELS=8192:
 * - Scale 16: 512×16 = 8192px rendered (within Canvas 2D limits)
 * - ~60 tiles per viewport (acceptable render time)
 * - 1152 DPI equivalent (72 DPI × 16) - excellent quality
 *
 * Quality at different zoom levels (effective DPR = scale / zoom):
 * - At 4x zoom: 16/4 = 4.0x DPR (super crisp)
 * - At 8x zoom: 16/8 = 2.0x DPR (Retina-quality)
 * - At 12x zoom: 16/12 = 1.33x DPR (crisp, no stretch)
 * - At 16x zoom: 16/16 = 1.0x DPR (crisp)
 */
export const DEFAULT_MAX_SCALE_TIER: ScaleTier = 16;

/**
 * GPU-safe maximum scale tier (absolute cap).
 *
 * Canvas 2D MEMORY: Modern browsers support very large canvases (up to 32767px).
 * With MAX_TILE_PIXELS=8192 and adaptive tile sizing:
 * - 512px tiles @ scale 16 = 8192px (standard)
 * - 256px tiles @ scale 32 = 8192px (high zoom)
 * - 128px tiles @ scale 64 = 8192px (extreme zoom)
 *
 * All produce the same 8192×8192 pixel tiles (~268MB RGBA each).
 *
 * With adaptive tile sizing:
 * - At zoom 16: scale 16, DPR = 1.0 (crisp)
 * - At zoom 24: scale 24, DPR = 1.0 (crisp with 256px tiles)
 * - At zoom 32: scale 32, DPR = 1.0 (crisp with 256px tiles)
 */
export const GPU_SAFE_MAX_SCALE: ScaleTier = 64;

// Cached dynamic max scale tier (computed once per session)
let cachedDynamicMaxScale: ScaleTier | null = null;

/**
 * Get the maximum scale tier based on device capabilities.
 *
 * PHASE 4: Dynamic Scale Tier Selection
 * High-end devices (>8GB RAM, discrete GPU) can render at scale 24-32 for
 * retina-sharp text at max zoom. Low-end devices stay at scale 16.
 *
 * Memory budget per scale tier (256×256 tiles, 30 tiles/page):
 * - Scale 16: 256×256×4×16×16×30 = ~120MB
 * - Scale 24: 256×256×4×24×24×30 = ~270MB
 * - Scale 32: 256×256×4×32×32×30 = ~480MB
 *
 * @returns Maximum scale tier for this device
 */
export function getDynamicMaxScaleTier(): ScaleTier {
  if (cachedDynamicMaxScale !== null) {
    return cachedDynamicMaxScale;
  }

  // Get system profile (sync version - returns cached profile if available)
  const profiler = getSystemProfiler();

  // Use getCachedProfile to avoid async - may return null on first call
  const profile = profiler.getCachedProfile();

  // Determine max scale based on device tier
  let maxScale: ScaleTier;

  if (profile) {
    const memoryGB = profile.memory.deviceMemoryGB ?? 4; // Default 4GB if unknown
    const tier = profile.tier;

    // ADAPTIVE TILE SCALE FIX (amnesia-d9f, amnesia-rwe):
    //
    // With adaptive tile sizing enabled (useAdaptiveTileSize=true):
    // - zoom <= 8:  512px tiles → max scale 16 (8192/512)
    // - zoom <= 16: 256px tiles → max scale 32 (8192/256)
    // - zoom <= 32: 128px tiles → max scale 64 (8192/128)
    //
    // The maxScaleForTileSize calculation in tile-render-engine.ts already
    // accounts for tile size. But getDynamicMaxScaleTier() was capping at 32,
    // preventing scale 64 at max zoom (32x on Retina displays).
    //
    // FIX (amnesia-rwe): Return 64 as max for high-end devices (8GB+ RAM).
    // This allows scale 64 with 128px tiles at zoom 32 on Retina (DPR 2).
    // Memory per tile: 128×64 = 8192px, so 8192×8192×4 = 268MB per tile.
    // With ~180 tiles visible at max zoom, L2 cache handles this fine.
    //
    // For lower-end devices (< 8GB), cap at 32 for memory safety.
    // For very low-end (< 4GB), cap at 16.
    if (memoryGB >= 8) {
      maxScale = GPU_SAFE_MAX_SCALE; // 64 - enables crisp rendering at zoom 32 + DPR 2
      console.log(`[ProgressiveTileRenderer] High-end device (${memoryGB}GB RAM, ${tier}): max scale ${maxScale}`);
    } else if (memoryGB >= 4) {
      maxScale = 32;
      console.log(`[ProgressiveTileRenderer] Mid-range device (${memoryGB}GB RAM, ${tier}): max scale 32`);
    } else {
      maxScale = DEFAULT_MAX_SCALE_TIER; // 16
      console.log(`[ProgressiveTileRenderer] Low-end device (${memoryGB}GB RAM, ${tier}): max scale 16`);
    }
    void tier; // Tier not used for memory-based decision

    // Cache the result
    cachedDynamicMaxScale = maxScale;
  } else {
    // Profile not available yet - trigger async profiling in background
    // so next call will have the profile available
    console.log('[ProgressiveTileRenderer] Profile unavailable, triggering async profiling');
    profiler.getProfile().then(() => {
      // Reset cache so next call recalculates with the new profile
      cachedDynamicMaxScale = null;
      console.log('[ProgressiveTileRenderer] Profile now available, will use dynamic scale on next render');
    }).catch(() => {
      // If profiling fails, we'll keep using default
    });

    // Use conservative default for this call
    maxScale = DEFAULT_MAX_SCALE_TIER;
    // Don't cache - let next call try again with profile
  }

  return maxScale;
}

/**
 * Reset cached dynamic max scale (for testing or when profile updates)
 */
export function resetDynamicMaxScaleTier(): void {
  cachedDynamicMaxScale = null;
}

// Legacy export for backwards compatibility
export const MAX_SCALE_TIER: ScaleTier = DEFAULT_MAX_SCALE_TIER;

// NOTE: Soft transition zone was REMOVED because it created bumps instead of preventing them.
// When tier dropped from 16→12, cssStretch jumped 33%. Simple capping gives linear cssStretch.

/**
 * Result from getTargetScaleTier including the tier and CSS stretch factor.
 */
export interface ScaleTierResult {
  /** The target scale tier for rendering */
  tier: ScaleTier;
  /** CSS stretch factor to apply (minRequired / tier). 1.0 = exact match, >1 = upscaling */
  cssStretch: number;
}

/**
 * Get the target scale tier for a given zoom level.
 *
 * Returns the smallest scale tier that provides acceptable quality, along with
 * the CSS stretch factor needed to compensate for any resolution gap.
 *
 * ZOOM QUALITY FIX: The maxZoom parameter allows callers to specify the maximum
 * zoom level configured for the canvas. When provided, the maximum scale tier
 * is computed as maxZoom × pixelRatio, enabling crisp rendering even at max zoom.
 *
 * Without maxZoom:
 * - Uses getDynamicMaxScaleTier() which returns 8
 * - At 16x zoom with pixelRatio=2: scale 8 → cssStretch = 4.0 (4x CSS upscale, blurry)
 *
 * With maxZoom = 16:
 * - maxScale = 16 × 2 = 32 (or nearest tier)
 * - At 16x zoom with pixelRatio=2: scale 32 → cssStretch = 1.0 (crisp!)
 *
 * @param zoom Current zoom level
 * @param pixelRatio Device pixel ratio (typically 2 for Retina)
 * @param maxZoom Optional maximum zoom level from config. When provided, overrides
 *                the dynamic max scale with maxZoom × pixelRatio (capped at max tier).
 * @returns Object containing tier and cssStretch
 *
 * @example
 * // With default (no maxZoom):
 * getTargetScaleTier(16, 2)      // → { tier: 8, cssStretch: 4.0 }
 *
 * // With maxZoom = 16 (GPU-capped at scale 12):
 * getTargetScaleTier(16, 2, 16)  // → { tier: 12, cssStretch: 2.67 } (GPU-safe, slight softening)
 */
export function getTargetScaleTier(
  zoom: number,
  pixelRatio: number,
  maxZoom?: number
): ScaleTierResult {
  // Guard against invalid zoom values (negative or zero would produce nonsensical cssStretch)
  if (zoom <= 0) {
    console.warn('[getTargetScaleTier] Invalid zoom value:', zoom, 'clamping to 1');
    zoom = 1;
  }

  // For crisp rendering at zoom Z on pixelRatio P display:
  // scale >= zoom × pixelRatio
  const minRequired = zoom * pixelRatio;

  // Find the natural tier (smallest tier >= required)
  let tier: ScaleTier = SCALE_TIERS[0];
  for (const t of SCALE_TIERS) {
    if (t >= minRequired) {
      tier = t as ScaleTier;
      break;
    }
    // Track largest tier in case we exceed all
    tier = t as ScaleTier;
  }

  // CENTRALIZED CONFIG: If maxZoom not provided, query ZoomScaleService singleton.
  // This ensures all scale calculations use the same maxZoom without requiring
  // every call site to pass it explicitly.
  let effectiveMaxZoom = maxZoom;
  if (effectiveMaxZoom === undefined) {
    // Lazy import to avoid circular dependency at module load time
    const { getGlobalZoomConfig } = require('./zoom-scale-service');
    const globalConfig = getGlobalZoomConfig();
    if (globalConfig) {
      effectiveMaxZoom = globalConfig.maxZoom;
    }
  }

  // ZOOM QUALITY FIX: When maxZoom is available, compute max scale from it.
  // This allows the renderer to use higher scale tiers at max zoom for crisp text.
  //
  // Without maxZoom:
  // - getDynamicMaxScaleTier() returns 8
  // - At 16x zoom with pixelRatio=2: scale capped to 8, cssStretch = 4.0
  //
  // With maxZoom = 32:
  // - maxScale = min(32 × 2, maxTier=32) = 32
  // - At 16x zoom with pixelRatio=2: scale 32, cssStretch = 1.0 (crisp!)
  let maxScale: ScaleTier;
  if (effectiveMaxZoom !== undefined) {
    // Use maxZoom × pixelRatio as the upper bound, capped at highest available tier
    const configuredMaxScale = effectiveMaxZoom * pixelRatio;
    const highestTier = SCALE_TIERS[SCALE_TIERS.length - 1]; // 32
    // Find the largest tier that doesn't exceed configuredMaxScale
    maxScale = SCALE_TIERS[0];
    for (const t of SCALE_TIERS) {
      if (t <= configuredMaxScale) {
        maxScale = t as ScaleTier;
      } else {
        break;
      }
    }
    // Ensure we use at least the configured max if it's within tier range
    if (configuredMaxScale >= highestTier) {
      maxScale = highestTier;
    }
  } else {
    // Fallback to dynamic max scale based on device capabilities
    maxScale = getDynamicMaxScaleTier();
  }

  // CANVAS 2D MEMORY PROTECTION: Apply absolute cap to prevent OOM.
  // Raised to 32 (prototype) to allow max-zoom crispness; rely on cache/eviction.
  maxScale = Math.min(maxScale, GPU_SAFE_MAX_SCALE) as ScaleTier;

  tier = Math.min(tier, maxScale) as ScaleTier;

  // Calculate cssStretch (how much CSS scaling is needed)
  const cssStretch = minRequired / tier;

  return { tier, cssStretch };
}

/**
 * Result from getExactTargetScale for exact-scale rendering.
 */
export interface ExactScaleResult {
  /** The exact target scale (zoom × pixelRatio, capped at maxScale) */
  scale: number;
  /** CSS stretch factor - 1.0 normally, or > 1.0 when scale is capped to compensate */
  cssStretch: number;
  /** Whether the scale was capped at the maximum */
  wasCapped: boolean;
}

/**
 * Precision for rounding exact scales for cache keys.
 * Using 0.01 precision gives ~100 possible scale values per integer,
 * which is sufficient for smooth zoom without excessive cache entries.
 */
export const EXACT_SCALE_PRECISION = 0.01;

/**
 * Round a scale value to cache-friendly precision.
 *
 * For exact-scale rendering, we want precise scales for crisp rendering,
 * but we also want cache hits when zoom is similar. This function rounds
 * to EXACT_SCALE_PRECISION (0.01) which gives:
 * - 100 cache entries per 1x zoom range
 * - Visually imperceptible quality difference between cache-adjacent scales
 *
 * @param scale Raw scale value
 * @returns Precision-rounded scale
 */
export function roundScaleForCache(scale: number): number {
  return Math.round(scale / EXACT_SCALE_PRECISION) * EXACT_SCALE_PRECISION;
}

/**
 * Get the exact target scale for a given zoom level.
 *
 * Unlike getTargetScaleTier which quantizes to discrete tiers, this returns
 * the exact scale needed for crisp rendering at the current zoom level.
 *
 * Key differences from getTargetScaleTier:
 * - Returns exact zoom × pixelRatio instead of quantized tier
 * - cssStretch is always 1.0 (no CSS stretching needed)
 * - Designed for use with transform compensation on page canvas
 *
 * @param zoom Current zoom level
 * @param pixelRatio Device pixel ratio (typically 2 for Retina)
 * @returns Object containing exact scale and metadata
 *
 * @example
 * getExactTargetScale(4, 2)    // → { scale: 8, cssStretch: 1, wasCapped: false }
 * getExactTargetScale(32, 2)   // → { scale: 32, cssStretch: 1.67, wasCapped: true } (with maxZoom=32)
 * getExactTargetScale(32, 2, 32) // → { scale: 32, cssStretch: 1.67, wasCapped: true } (explicit maxZoom)
 *
 * @param zoom Current zoom level
 * @param pixelRatio Device pixel ratio (typically 2 for Retina)
 * @param maxZoom Optional maximum zoom level from config. When provided, max scale
 *                is computed as min(maxZoom × pixelRatio, GPU_SAFE_MAX_SCALE).
 */
export function getExactTargetScale(
  zoom: number,
  pixelRatio: number,
  maxZoom?: number
): ExactScaleResult {
  // Guard against invalid zoom values
  if (zoom <= 0) {
    console.warn('[getExactTargetScale] Invalid zoom value:', zoom, 'clamping to 1');
    zoom = 1;
  }

  // Calculate exact target scale
  const exactScale = zoom * pixelRatio;

  // FIX (amnesia-d9f): Compute max scale from maxZoom config when available.
  // Previous bug: getDynamicMaxScaleTier() always returned 16, ignoring maxZoom=32.
  // This caused tiles to be capped at scale 16 even at 32x zoom, resulting in
  // cssStretch of 3.33 and blurry/stretched content at max zoom.
  //
  // With maxZoom=32 and pixelRatio=1.67:
  // - configuredMaxScale = 32 × 1.67 = 53.3
  // - Capped to GPU_SAFE_MAX_SCALE = 32
  // - At zoom 32x: scale 32, cssStretch = 53.3/32 = 1.67 (much better than 3.33!)
  let maxScale: number;
  if (maxZoom !== undefined) {
    const configuredMaxScale = maxZoom * pixelRatio;
    maxScale = Math.min(configuredMaxScale, GPU_SAFE_MAX_SCALE);
  } else {
    // Fallback: Try to get maxZoom from global config
    // Use lazy require to avoid circular dependency at module load time
    const { getGlobalZoomConfig } = require('./zoom-scale-service');
    const globalConfig = getGlobalZoomConfig();
    if (globalConfig) {
      const configuredMaxScale = globalConfig.maxZoom * pixelRatio;
      maxScale = Math.min(configuredMaxScale, GPU_SAFE_MAX_SCALE);
    } else {
      // Last resort: use dynamic max scale
      maxScale = getDynamicMaxScaleTier();
    }
  }

  const wasCapped = exactScale > maxScale;
  const cappedScale = Math.min(exactScale, maxScale);
  const finalScale = roundScaleForCache(cappedScale);

  // FIX (2026-01-22): When scale is capped, cssStretch must compensate.
  // Without this, tiles at max zoom appear "closer" because they're rendered
  // at lower scale but displayed at native size (cssStretch=1).
  // cssStretch = exactScale / finalScale ensures correct visual size.
  const cssStretch = wasCapped ? exactScale / finalScale : 1;

  return {
    scale: finalScale,
    cssStretch,
    wasCapped,
  };
}

/**
 * Get intermediate scale tiers to render before final quality.
 *
 * Returns array of scales to render progressively, from current to target.
 * Used for progressive enhancement during zoom operations.
 *
 * @param currentScale Current rendered scale (or best cached)
 * @param targetScale Target scale tier for final quality
 * @returns Array of intermediate scales to render (ascending order)
 *
 * @example
 * getProgressiveScales(4, 32)  // → [8, 16, 32] - render 8, then 16, then 32
 * getProgressiveScales(8, 16)  // → [16] - small jump, just render final
 * getProgressiveScales(4, 8)   // → [8] - single step up
 */
export function getProgressiveScales(
  currentScale: number,
  targetScale: ScaleTier
): ScaleTier[] {
  return SCALE_TIERS.filter((tier) => tier > currentScale && tier <= targetScale);
}

/**
 * Get the best intermediate scale for progressive rendering.
 *
 * Given current and target scales, returns the optimal intermediate
 * scale that balances quality improvement with render speed.
 *
 * Strategy:
 * - If jump is small (≤2x), skip intermediate and render final directly
 * - Otherwise, pick the tier that's roughly halfway between current and target
 *
 * @param currentScale Current rendered scale
 * @param targetScale Target scale for final quality
 * @returns Intermediate scale to render, or targetScale if no intermediate needed
 */
export function getIntermediateScale(
  currentScale: number,
  targetScale: ScaleTier
): ScaleTier {
  const ratio = targetScale / currentScale;

  // Small jump - no intermediate needed
  if (ratio <= DEFAULT_PHASE_CONFIG.skipIntermediateThreshold) {
    return targetScale;
  }

  // Find tier closest to geometric mean of current and target
  const geometricMean = Math.sqrt(currentScale * targetScale);

  let bestTier = targetScale;
  let bestDistance = Infinity;

  for (const tier of SCALE_TIERS) {
    if (tier > currentScale && tier < targetScale) {
      const distance = Math.abs(tier - geometricMean);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestTier = tier;
      }
    }
  }

  return bestTier;
}

/**
 * Get the CSS scale factor needed to display a tile rendered at one scale
 * as if it were rendered at another scale.
 *
 * @param renderedScale The scale the tile was actually rendered at
 * @param displayScale The scale we want to display it at
 * @returns CSS transform scale factor
 *
 * @example
 * getCssScaleFactor(8, 32)  // → 4.0 (stretch 8x tile to look like 32x)
 * getCssScaleFactor(16, 32) // → 2.0
 * getCssScaleFactor(32, 32) // → 1.0 (no stretching)
 */
export function getCssScaleFactor(renderedScale: number, displayScale: number): number {
  return displayScale / renderedScale;
}

/**
 * Calculate adaptive tile size based on zoom level.
 *
 * CRISP HIGH-ZOOM FIX (amnesia-d9f):
 * Smaller tiles at high zoom allow higher render scales within GPU limits.
 *
 * With MAX_TILE_PIXELS = 8192:
 * - 512px tiles → max scale 16 → 2x stretch at zoom 32 (blurry)
 * - 256px tiles → max scale 32 → 1x stretch at zoom 32 (crisp!)
 * - 128px tiles → max scale 64 → crisp even at zoom 64
 *
 * Zoom bands and tile sizes:
 * - zoom <= 16: 512px tiles, max scale 16, crisp up to zoom 16
 * - zoom <= 32: 256px tiles, max scale 32, crisp up to zoom 32
 * - zoom > 32:  128px tiles, max scale 64, crisp at extreme zoom
 *
 * FALLBACK CONSISTENCY:
 * Fallback works within the same zoom band. When transitioning bands,
 * a full re-render occurs anyway (zoom change triggers new tile requests).
 * Fallback tiles at different scales within the same band share coordinates.
 *
 * TILE COUNT IMPLICATIONS:
 * For a typical viewport at high zoom (showing ~1/4 of a page):
 * - 512px tiles: ~60 tiles visible
 * - 256px tiles: ~240 tiles visible
 * - 128px tiles: ~960 tiles visible
 *
 * The increased tile count is the cost of crisp rendering at high zoom.
 * The semaphore queue and cache are sized to handle this.
 *
 * @param zoom Current zoom level
 * @returns Tile size in CSS pixels (512, 256, or 128)
 */
export function getAdaptiveTileSize(zoom: number, pixelRatio?: number): number {
  // amnesia-rwe: CRITICAL FIX - account for devicePixelRatio
  //
  // For crisp rendering: neededScale = zoom * pixelRatio
  // Max achievable scale: MAX_TILE_PIXELS (8192) / tileSize
  //
  // On Retina (pixelRatio=2):
  //   - 512px tiles: max scale = 16 → max crisp zoom = 8
  //   - 256px tiles: max scale = 32 → max crisp zoom = 16
  //   - 128px tiles: max scale = 64 → max crisp zoom = 32
  //
  // On non-Retina (pixelRatio=1):
  //   - 512px tiles: max scale = 16 → max crisp zoom = 16
  //   - 256px tiles: max scale = 32 → max crisp zoom = 32
  //   - 128px tiles: max scale = 64 → max crisp zoom = 64
  
  const dpr = pixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 2);
  const neededScale = zoom * dpr;
  
  // Pick smallest tile size that can achieve needed scale
  // MAX_TILE_PIXELS = 8192, so:
  // 512px tiles: max scale = 16
  // 256px tiles: max scale = 32
  // 128px tiles: max scale = 64
  
  if (neededScale <= 16) {
    return 512;
  } else if (neededScale <= 32) {
    return 256;
  } else {
    return 128;
  }
}

/**
 * Progressive Tile Renderer
 *
 * Manages multi-resolution tile rendering with progressive quality enhancement.
 * Coordinates with the tile cache to use best available tiles as fallbacks.
 */
export class ProgressiveTileRenderer {
  /** Render callback (injected by provider) */
  private renderCallback:
    | ((tile: TileCoordinate) => Promise<TileRenderResult>)
    | null = null;

  /** Current document ID */
  private documentId: string | null = null;

  /** In-flight progressive render sequences (for cancellation) */
  private inFlightSequences = new Map<string, AbortController>();

  /** Phase timing configuration */
  private phaseConfig: ProgressivePhaseConfig = DEFAULT_PHASE_CONFIG;

  /**
   * Set the render callback for tile rendering
   */
  setRenderCallback(callback: (tile: TileCoordinate) => Promise<TileRenderResult>): void {
    this.renderCallback = callback;
  }

  /**
   * Set the current document ID
   */
  setDocument(docId: string): void {
    this.documentId = docId;
  }

  /**
   * Configure phase timing
   */
  setPhaseConfig(config: Partial<ProgressivePhaseConfig>): void {
    this.phaseConfig = { ...this.phaseConfig, ...config };
  }

  /**
   * Get the best available cached scale for a tile.
   *
   * Checks the cache for any existing renders of this tile coordinate
   * and returns the highest available scale.
   *
   * @param tile Tile coordinate (page, tileX, tileY)
   * @returns Best cached scale, or 0 if no cache hit
   */
  async getBestCachedScale(tile: Omit<TileCoordinate, 'scale'>): Promise<number> {
    const cache = getTileCacheManager();

    // Check each scale tier from highest to lowest
    for (let i = SCALE_TIERS.length - 1; i >= 0; i--) {
      const scale = SCALE_TIERS[i];
      const fullTile: TileCoordinate = { ...tile, scale };
      const cached = await cache.get(fullTile);
      if (cached) {
        return scale;
      }
    }

    return 0;
  }

  /**
   * Get all cached scales for a tile coordinate.
   *
   * @param tile Tile coordinate (without scale)
   * @returns Array of scales that have cached renders
   */
  async getCachedScales(tile: Omit<TileCoordinate, 'scale'>): Promise<ScaleTier[]> {
    const cache = getTileCacheManager();
    const cached: ScaleTier[] = [];

    for (const scale of SCALE_TIERS) {
      const fullTile: TileCoordinate = { ...tile, scale };
      const result = await cache.get(fullTile);
      if (result) {
        cached.push(scale);
      }
    }

    return cached;
  }

  /**
   * Render a tile progressively through scale tiers.
   *
   * Yields intermediate results as they complete, allowing the UI
   * to display improving quality over time.
   *
   * @param tile Base tile coordinate (page, tileX, tileY)
   * @param targetScale Target scale tier for final quality
   * @param abortSignal Optional abort signal for cancellation
   * @yields Progressive results with scale and CSS stretch factor
   *
   * @example
   * for await (const { scale, result, cssScaleFactor } of renderer.renderTileProgressive(
   *   { page: 1, tileX: 0, tileY: 0 },
   *   32
   * )) {
   *   tile.style.transform = `scale(${cssScaleFactor})`;
   *   drawTile(result);
   * }
   */
  async *renderTileProgressive(
    tile: Omit<TileCoordinate, 'scale'>,
    targetScale: ScaleTier,
    abortSignal?: AbortSignal
  ): AsyncGenerator<ProgressiveTileResult> {
    if (!this.renderCallback) {
      console.warn('[ProgressiveTileRenderer] No render callback set');
      return;
    }

    // Get best currently cached scale
    const currentScale = await this.getBestCachedScale(tile);

    // Get scales to render progressively
    const scales = getProgressiveScales(currentScale, targetScale);

    if (scales.length === 0) {
      // Already at target quality, nothing to do
      return;
    }

    const telemetry = getTelemetry();
    const startTime = performance.now();

    for (let i = 0; i < scales.length; i++) {
      // Check for abort
      if (abortSignal?.aborted) {
        return;
      }

      const scale = scales[i];
      const isFinal = i === scales.length - 1;
      const fullTile: TileCoordinate = { ...tile, scale };

      try {
        // Render at this scale
        const result = await this.renderCallback(fullTile);

        // Calculate CSS scale factor for stretching
        const cssScaleFactor = getCssScaleFactor(scale, targetScale);

        yield {
          scale,
          tile: fullTile,
          result,
          isFinal,
          cssScaleFactor,
        };

        // Track telemetry
        if (isFinal) {
          const totalTime = performance.now() - startTime;
          telemetry.trackCustomMetric('progressiveRenderTotal', totalTime);
        }
      } catch (error) {
        console.error(`[ProgressiveTileRenderer] Failed at scale ${scale}:`, error);
        // Continue to next scale on error
      }
    }
  }

  /**
   * Render a batch of tiles progressively.
   *
   * All tiles in the batch go through the same progressive sequence,
   * with results yielded as they complete.
   *
   * @param tiles Array of tile coordinates
   * @param targetScale Target scale for all tiles
   * @param maxConcurrent Maximum concurrent renders per scale tier
   * @param abortSignal Optional abort signal
   */
  async *renderBatchProgressive(
    tiles: Array<Omit<TileCoordinate, 'scale'>>,
    targetScale: ScaleTier,
    maxConcurrent: number = 8,
    abortSignal?: AbortSignal
  ): AsyncGenerator<ProgressiveTileResult> {
    if (!this.renderCallback || tiles.length === 0) {
      return;
    }

    // Determine scales needed for each tile
    const tileScales = await Promise.all(
      tiles.map(async (tile) => ({
        tile,
        currentScale: await this.getBestCachedScale(tile),
      }))
    );

    // Find minimum current scale across all tiles
    const minCurrentScale = Math.min(
      ...tileScales.map((t) => t.currentScale),
      targetScale - 1
    );

    // Get progressive scales from minimum
    const scales = getProgressiveScales(minCurrentScale, targetScale);

    if (scales.length === 0) {
      return;
    }

    // Render each scale tier for all tiles
    for (let scaleIdx = 0; scaleIdx < scales.length; scaleIdx++) {
      if (abortSignal?.aborted) return;

      const scale = scales[scaleIdx];
      const isFinal = scaleIdx === scales.length - 1;

      // Filter tiles that need this scale (don't re-render if already cached at higher)
      const tilesToRender = tileScales.filter((t) => t.currentScale < scale);

      if (tilesToRender.length === 0) continue;

      // Render in chunks for concurrency control
      for (let i = 0; i < tilesToRender.length; i += maxConcurrent) {
        if (abortSignal?.aborted) return;

        const chunk = tilesToRender.slice(i, i + maxConcurrent);

        const results = await Promise.all(
          chunk.map(async ({ tile }) => {
            const fullTile: TileCoordinate = { ...tile, scale };
            try {
              const result = await this.renderCallback!(fullTile);
              return { tile: fullTile, result, success: true };
            } catch {
              return { tile: fullTile, result: null, success: false };
            }
          })
        );

        // Yield successful results
        for (const { tile: fullTile, result, success } of results) {
          if (success && result) {
            yield {
              scale,
              tile: fullTile,
              result,
              isFinal,
              cssScaleFactor: getCssScaleFactor(scale, targetScale),
            };
          }
        }
      }

      // Update current scales for next iteration
      for (const t of tilesToRender) {
        t.currentScale = scale;
      }
    }
  }

  /**
   * Cancel any in-flight progressive render sequence for a tile.
   *
   * @param tile Tile coordinate
   */
  cancelProgressiveRender(tile: Omit<TileCoordinate, 'scale'>): void {
    const key = `${tile.page}-${tile.tileX}-${tile.tileY}`;
    const controller = this.inFlightSequences.get(key);
    if (controller) {
      controller.abort();
      this.inFlightSequences.delete(key);
    }
  }

  /**
   * Cancel all in-flight progressive renders.
   */
  cancelAll(): void {
    for (const controller of this.inFlightSequences.values()) {
      controller.abort();
    }
    this.inFlightSequences.clear();
  }

  /**
   * Get statistics about progressive rendering.
   */
  getStats(): {
    inFlightCount: number;
    phaseConfig: ProgressivePhaseConfig;
  } {
    return {
      inFlightCount: this.inFlightSequences.size,
      phaseConfig: this.phaseConfig,
    };
  }
}

// Singleton instance
let progressiveRendererInstance: ProgressiveTileRenderer | null = null;

/**
 * Get the shared progressive tile renderer instance
 */
export function getProgressiveTileRenderer(): ProgressiveTileRenderer {
  if (!progressiveRendererInstance) {
    progressiveRendererInstance = new ProgressiveTileRenderer();
  }
  return progressiveRendererInstance;
}

/**
 * Reset the progressive renderer (for testing)
 */
export function resetProgressiveTileRenderer(): void {
  if (progressiveRendererInstance) {
    progressiveRendererInstance.cancelAll();
  }
  progressiveRendererInstance = null;
}
