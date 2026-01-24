/**
 * Scroll Mode Strategy
 *
 * Rendering strategy for continuous scroll PDF viewing.
 *
 * Key characteristics:
 * - Always uses tiled rendering (256×256)
 * - Viewport-based tile priority (center tiles first)
 * - Momentum-based scroll prediction for prefetching
 * - Dynamic resolution based on scroll velocity (low-res during fast scroll)
 *
 * @example
 * ```typescript
 * const strategy = new ScrollStrategy({ prefetchViewports: 2 });
 *
 * // Get visible tiles
 * const visible = strategy.getVisibleTiles(viewport, pageLayouts, zoom);
 *
 * // Get prefetch tiles based on scroll direction
 * const prefetch = strategy.getPrefetchTiles(viewport, velocity, pageLayouts);
 * ```
 */

import type { TileCoordinate, TileScale, Rect, PageLayout } from './tile-render-engine';
import { getTileSize } from './tile-render-engine';
import { MAX_SCALE_TIER, getTargetScaleTier, getExactTargetScale } from './progressive-tile-renderer';
import { isFeatureEnabled } from './feature-flags';
import { getScaleStateManager } from './scale-state-manager';
import type { RenderPriority } from './render-coordinator';

/** Scroll velocity vector */
export interface ScrollVelocity {
  x: number; // Pixels per second
  y: number;
}

/** Speed zone for adaptive prefetching */
export type SpeedZone = 'stationary' | 'slow' | 'medium' | 'fast' | 'veryFast';

/** Prefetch priority level */
export type PrefetchPriority = 0 | 1 | 2 | 3; // 0 = critical, 3 = background

/**
 * Convert ScaleStateManager's string priority to numeric PrefetchPriority.
 * Maps: 'critical' → 0, 'high' → 1, 'medium' → 2, 'low' → 3
 */
function renderPriorityToNumeric(priority: RenderPriority): PrefetchPriority {
  switch (priority) {
    case 'critical': return 0;
    case 'high': return 1;
    case 'medium': return 2;
    case 'low': return 3;
    default: {
      // Exhaustive check - TypeScript will error if RenderPriority adds new values
      const _exhaustive: never = priority;
      return _exhaustive;
    }
  }
}

/** Tile with priority information */
export interface PrioritizedTile extends TileCoordinate {
  priority: PrefetchPriority;
  distanceFromViewport: number; // In viewport units (0.5 = half viewport away)
}

/** Speed zone thresholds and settings */
export interface SpeedZoneConfig {
  /** Speed threshold in pixels/second to enter this zone */
  minSpeed: number;
  /** Number of viewports to look ahead */
  lookahead: number;
  /** Quality factor (0.5-1.0) for rendering */
  quality: number;
}

/** Scroll strategy configuration */
export interface ScrollStrategyConfig {
  /** Number of viewports ahead to prefetch (user-configurable, used as base) */
  prefetchViewports: number;
  /** Momentum decay factor for velocity prediction */
  momentumDecay: number;
  /** Velocity threshold for switching to low-res tiles */
  fastScrollThreshold: number;
  /** Tile size in pixels */
  tileSize: number;
  /** Enable adaptive velocity-based prefetching */
  adaptivePrefetch: boolean;
  /** Speed zone configurations */
  speedZones: Record<SpeedZone, SpeedZoneConfig>;
  /** Maximum zoom level used to cap scale tier */
  maxZoom?: number;
}

/**
 * Scroll Mode Strategy
 */
/**
 * Default speed zone configurations for adaptive prefetching.
 *
 * AGGRESSIVE PREFETCHING: Lookahead values are tuned for smooth inertia scroll.
 * Higher lookahead = more tiles rendered ahead in scroll direction, reducing
 * placeholder visibility during momentum scroll.
 *
 * Speed zones (px/s):
 * - stationary (0-50): Reading mode - full quality, minimal prefetch
 * - slow (50-200): Browsing - high quality, moderate prefetch
 * - medium (200-500): Scrolling - reduced quality, good prefetch
 * - fast (500-1000): Flicking - lower quality, aggressive prefetch
 * - veryFast (>1000): Aggressive fling - lowest quality, maximum prefetch
 *
 * Quality factor affects render scale (1.0 = full, 0.5 = half resolution).
 * Lookahead is multiplied by viewport size for prefetch area calculation.
 */
const DEFAULT_SPEED_ZONES: Record<SpeedZone, SpeedZoneConfig> = {
  stationary: { minSpeed: 0, lookahead: 1.0, quality: 1.0 },
  slow: { minSpeed: 50, lookahead: 2.0, quality: 0.9 },
  medium: { minSpeed: 200, lookahead: 3.0, quality: 0.75 },
  fast: { minSpeed: 500, lookahead: 5.0, quality: 0.5 },
  veryFast: { minSpeed: 1000, lookahead: 8.0, quality: 0.35 },
};

export class ScrollStrategy {
  private config: ScrollStrategyConfig;

  constructor(config: Partial<ScrollStrategyConfig> = {}) {
    this.config = {
      prefetchViewports: config.prefetchViewports ?? 2, // User decision: 2 viewports ahead
      momentumDecay: config.momentumDecay ?? 0.95,
      fastScrollThreshold: config.fastScrollThreshold ?? 500, // px/s
      tileSize: config.tileSize ?? 256,
      adaptivePrefetch: config.adaptivePrefetch ?? true, // Enable by default
      speedZones: config.speedZones ?? DEFAULT_SPEED_ZONES,
    };
  }

  /**
   * Update configuration (e.g., when user changes settings)
   */
  updateConfig(updates: Partial<ScrollStrategyConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Get the prefetch viewports setting
   */
  get prefetchViewports(): number {
    return this.config.prefetchViewports;
  }

  /**
   * Always use tiling in scroll mode
   */
  shouldUseTiling(): boolean {
    return true;
  }

  /**
   * Get tiles visible within the current viewport.
   * For crisp rendering, pass pixelRatio to calculate proper scale.
   *
   * **Focal Point Sorting (amnesia-8bd)**: During zoom gestures, tiles are sorted
   * by distance from the focal point instead of viewport center.
   *
   * @param documentId - Optional document ID for ScaleStateManager lookup (focal point sorting)
   */
  getVisibleTiles(
    viewport: Rect,
    pageLayouts: PageLayout[],
    zoom: number,
    pixelRatio: number = 1,
    documentId: string = 'default'
  ): TileCoordinate[] {
    const tiles: TileCoordinate[] = [];
    const scale = this.getScaleForZoom(zoom, pixelRatio);
    // TILE-SIZE-MISMATCH-FIX: Use adaptive tile size from getTileSize(zoom) to match
    // pdf-page-element.ts which uses the same function. Previously used hardcoded 256,
    // causing mismatch with adaptive 512 elsewhere, leading to out-of-bounds tiles.
    const tileSize = getTileSize(zoom);

    for (const layout of pageLayouts) {
      // Check if page overlaps viewport
      if (!this.rectsOverlap(viewport, layout)) continue;

      // Calculate intersection in page coordinates
      const intersection = this.getIntersection(viewport, layout);
      const pageTiles = this.getTilesInPageRect(
        {
          x: intersection.x - layout.x,
          y: intersection.y - layout.y,
          width: intersection.width,
          height: intersection.height,
        },
        layout.page,
        scale,
        layout.width,
        layout.height,
        zoom  // Pass zoom for adaptive tile sizing
      );

      tiles.push(...pageTiles);
    }

    // Check for focal point (amnesia-8bd)
    const scaleManager = getScaleStateManager(documentId);
    const focalPoint = scaleManager?.getFocalPoint();

    // Sort by distance from focal point (during zoom) or viewport center (normal)
    let sortX: number;
    let sortY: number;
    if (focalPoint) {
      // During zoom gestures: sort by distance from zoom focal point
      sortX = focalPoint.x;
      sortY = focalPoint.y;
    } else {
      // Normal scrolling: sort by distance from viewport center
      sortX = viewport.x + viewport.width / 2;
      sortY = viewport.y + viewport.height / 2;
    }

    tiles.sort((a, b) => {
      const distA = this.getTileDistanceFromPoint(a, pageLayouts, sortX, sortY);
      const distB = this.getTileDistanceFromPoint(b, pageLayouts, sortX, sortY);
      return distA - distB;
    });

    return tiles;
  }

  /**
   * Get tiles to prefetch based on scroll velocity
   *
   * User decision: prefetch N viewports ahead (configurable)
   * Uses velocity-based resolution: lower res during fast scroll for efficiency
   */
  getPrefetchTiles(
    viewport: Rect,
    velocity: ScrollVelocity,
    pageLayouts: PageLayout[],
    zoom: number
  ): TileCoordinate[] {
    // Predict future viewport position based on scroll direction
    const predictedViewport = this.predictViewport(viewport, velocity);

    // Get current visible tile keys to exclude from prefetch
    const currentTiles = new Set(
      this.getVisibleTiles(viewport, pageLayouts, zoom).map(t => this.getTileKey(t))
    );

    // Determine prefetch scale based on zoom and scroll velocity
    // Fast scrolling = reduced quality for faster rendering
    const qualityFactor = this.getQualityFactorForVelocity(velocity);
    const prefetchScale = Math.max(1, Math.ceil(this.getScaleForZoom(zoom) * qualityFactor));

    // Get tiles in predicted viewport that aren't already visible
    const prefetchTiles: TileCoordinate[] = [];

    for (const layout of pageLayouts) {
      if (!this.rectsOverlap(predictedViewport, layout)) continue;

      const intersection = this.getIntersection(predictedViewport, layout);
      const pageTiles = this.getTilesInPageRect(
        {
          x: intersection.x - layout.x,
          y: intersection.y - layout.y,
          width: intersection.width,
          height: intersection.height,
        },
        layout.page,
        prefetchScale, // Use velocity-based scale directly
        layout.width,
        layout.height
      );

      for (const tile of pageTiles) {
        if (!currentTiles.has(this.getTileKey(tile))) {
          prefetchTiles.push(tile);
        }
      }
    }

    return prefetchTiles;
  }

  /**
   * Get quality factor based on scroll velocity.
   * Returns a multiplier (0.5 = reduced for fast scroll, 1.0 = full quality)
   *
   * Now uses adaptive speed zones for graduated quality scaling.
   */
  getQualityFactorForVelocity(velocity: ScrollVelocity): number {
    if (this.config.adaptivePrefetch) {
      const zone = this.getSpeedZone(velocity);
      return this.config.speedZones[zone].quality;
    }
    // Legacy behavior
    const speed = Math.sqrt(velocity.x ** 2 + velocity.y ** 2);
    return speed > this.config.fastScrollThreshold ? 0.5 : 1.0;
  }

  /**
   * Get tile scale based on zoom level and pixel ratio.
   * For crisp rendering: scale = zoom * pixelRatio
   *
   * MEMORY FIX: Capped at MAX_SCALE_TIER (16) to prevent OOM and cache thrashing.
   *
   * TILE PIXEL CAP FIX (amnesia-d9f): Also capped by MAX_TILE_PIXELS / tileSize to prevent
   * tiles exceeding GPU Canvas 2D limits. With 512px tiles and MAX_TILE_PIXELS=8192,
   * max scale is 16. This must match the cap in renderPageTiled to avoid scale mismatch.
   */
  getScaleForZoom(zoom: number, pixelRatio: number = 1): TileScale {
    // SCALE MISMATCH FIX (amnesia-d9f): When useExactScaleRendering is enabled,
    // use exact scale to match the orchestrator's calculations.
    let rawScale: number;
    if (isFeatureEnabled('useExactScaleRendering')) {
      // FIX (amnesia-d9f): Pass maxZoom to ensure proper scale cap
      const { scale } = getExactTargetScale(zoom, pixelRatio, this.config.maxZoom);
      rawScale = scale;
    } else {
      // TILE SCALE FIX: Use getTargetScaleTier to return a VALID scale tier.
      //
      // Before: Math.ceil(zoom * pixelRatio) produced arbitrary scales like 7, 9, 11
      // which don't exist in SCALE_TIERS, causing cache misses.
      //
      // Now: getTargetScaleTier returns the nearest valid tier for cache hits.
      const { tier } = getTargetScaleTier(zoom, pixelRatio, this.config.maxZoom);
      rawScale = tier;
    }

    // TILE PIXEL CAP FIX (amnesia-d9f): Apply same cap as renderPageTiled.
    // With 512px tiles at scale 32, each tile would be 16384px which exceeds GPU limits.
    // Cap scale so tile pixels ≤ MAX_TILE_PIXELS (8192).
    const MAX_TILE_PIXELS = 8192;
    const tileSize = getTileSize(zoom);
    const maxScaleForTileSize = Math.floor(MAX_TILE_PIXELS / tileSize);
    const finalScale = Math.min(rawScale, maxScaleForTileSize);

    return finalScale as TileScale;
  }

  /**
   * @deprecated Use getQualityFactorForVelocity instead
   */
  getResolutionForVelocity(velocity: ScrollVelocity): number {
    return this.getQualityFactorForVelocity(velocity) * 2;
  }

  // ============================================================
  // ADAPTIVE VELOCITY-BASED PREFETCHING
  // ============================================================

  /**
   * Determine the speed zone based on scroll velocity.
   *
   * Speed zones:
   * - stationary: <50 px/s - user is reading/examining
   * - slow: 50-200 px/s - casual browsing
   * - medium: 200-500 px/s - navigation scroll
   * - fast: 500-1000 px/s - rapid scrolling (searching for something)
   * - veryFast: >1000 px/s - aggressive fling (skimming/jumping)
   */
  getSpeedZone(velocity: ScrollVelocity): SpeedZone {
    const speed = Math.sqrt(velocity.x ** 2 + velocity.y ** 2);
    const zones = this.config.speedZones;

    // Check from highest to lowest threshold
    if (speed >= zones.veryFast.minSpeed) return 'veryFast';
    if (speed >= zones.fast.minSpeed) return 'fast';
    if (speed >= zones.medium.minSpeed) return 'medium';
    if (speed >= zones.slow.minSpeed) return 'slow';
    return 'stationary';
  }

  /**
   * Get adaptive lookahead distance based on velocity.
   *
   * Faster scrolling = look further ahead to have tiles ready.
   * Returns number of viewports to prefetch ahead.
   */
  getAdaptiveLookahead(velocity: ScrollVelocity): number {
    if (!this.config.adaptivePrefetch) {
      return this.config.prefetchViewports;
    }
    const zone = this.getSpeedZone(velocity);
    return this.config.speedZones[zone].lookahead;
  }

  /**
   * Get prefetch tiles with priority zones.
   *
   * Priority zones (in viewport units from current viewport edge):
   * - Critical (0-0.5): Priority 0 - must render immediately
   * - High (0.5-1.5): Priority 1 - prefetch soon
   * - Medium (1.5-2.5): Priority 2 - opportunistic
   * - Low (2.5-lookahead): Priority 3 - background
   *
   * **Focal Point Priority (amnesia-8bd)**: During zoom gestures, if a focal point
   * is active, tiles are prioritized by radial distance from the focal point instead
   * of distance from viewport center. This ensures tiles near the zoom cursor render first.
   *
   * @param documentId - Optional document ID for ScaleStateManager lookup (focal point priority)
   * @returns Tiles sorted by priority (lowest number = highest priority)
   */
  getPrefetchTilesWithPriority(
    viewport: Rect,
    velocity: ScrollVelocity,
    pageLayouts: PageLayout[],
    zoom: number,
    pixelRatio: number = 1,
    documentId: string = 'default'
  ): PrioritizedTile[] {
    // Check for focal point priority (amnesia-8bd)
    const scaleManager = getScaleStateManager(documentId);
    const focalPoint = scaleManager?.getFocalPoint();
    const useFocalPointPriority = focalPoint !== null && scaleManager !== null;
    const lookahead = this.getAdaptiveLookahead(velocity);
    const quality = this.getQualityFactorForVelocity(velocity);
    const scale = this.getScaleForZoom(zoom, pixelRatio * quality);

    // Normalize velocity direction
    const speed = Math.sqrt(velocity.x ** 2 + velocity.y ** 2);
    const dirX = speed > 0 ? velocity.x / speed : 0;
    const dirY = speed > 0 ? velocity.y / speed : 0;

    // Expand viewport in scroll direction by lookahead amount
    const expandedViewport = this.expandViewportInDirection(
      viewport,
      dirX,
      dirY,
      lookahead
    );

    // Get current visible tiles to exclude
    const currentTiles = new Set(
      this.getVisibleTiles(viewport, pageLayouts, zoom, pixelRatio)
        .map(t => this.getTileKey(t))
    );

    const prioritizedTiles: PrioritizedTile[] = [];

    for (const layout of pageLayouts) {
      if (!this.rectsOverlap(expandedViewport, layout)) continue;

      const intersection = this.getIntersection(expandedViewport, layout);
      const pageTiles = this.getTilesInPageRect(
        {
          x: intersection.x - layout.x,
          y: intersection.y - layout.y,
          width: intersection.width,
          height: intersection.height,
        },
        layout.page,
        scale,
        layout.width,
        layout.height
      );

      for (const tile of pageTiles) {
        if (currentTiles.has(this.getTileKey(tile))) continue;

        // Calculate distance from viewport in viewport units
        const distance = this.getTileDistanceFromViewport(tile, layout, viewport, dirX, dirY);

        // Assign priority based on distance or focal point (amnesia-8bd)
        let priority: PrefetchPriority;
        if (useFocalPointPriority && scaleManager) {
          // During zoom gestures: prioritize by radial distance from focal point
          const focalPriority = scaleManager.getTilePriority(tile, this.config.tileSize, {
            x: layout.x,
            y: layout.y,
          });
          priority = renderPriorityToNumeric(focalPriority);
        } else {
          // Normal scrolling: prioritize by distance from viewport
          priority = this.getPriorityForDistance(distance);
        }

        prioritizedTiles.push({
          ...tile,
          priority,
          distanceFromViewport: distance,
        });
      }
    }

    // Sort by priority (lower = higher priority), then by distance
    prioritizedTiles.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.distanceFromViewport - b.distanceFromViewport;
    });

    return prioritizedTiles;
  }

  /**
   * Expand viewport in scroll direction by a factor.
   */
  private expandViewportInDirection(
    viewport: Rect,
    dirX: number,
    dirY: number,
    factor: number
  ): Rect {
    // Expand asymmetrically - more in scroll direction, less behind
    const forwardFactor = factor;
    const backwardFactor = 0.5; // Keep half viewport behind

    const expandX = Math.abs(dirX) * viewport.width;
    const expandY = Math.abs(dirY) * viewport.height;

    return {
      x: viewport.x - (dirX < 0 ? expandX * forwardFactor : expandX * backwardFactor),
      y: viewport.y - (dirY < 0 ? expandY * forwardFactor : expandY * backwardFactor),
      width: viewport.width + expandX * (forwardFactor + backwardFactor),
      height: viewport.height + expandY * (forwardFactor + backwardFactor),
    };
  }

  /**
   * Calculate tile distance from viewport edge in scroll direction.
   * Returns distance in viewport units (1.0 = one viewport away).
   */
  private getTileDistanceFromViewport(
    tile: TileCoordinate,
    layout: PageLayout,
    viewport: Rect,
    dirX: number,
    dirY: number
  ): number {
    const tileSize = this.config.tileSize / tile.scale;
    const tileCenterX = layout.x + tile.tileX * tileSize + tileSize / 2;
    const tileCenterY = layout.y + tile.tileY * tileSize + tileSize / 2;

    const viewportCenterX = viewport.x + viewport.width / 2;
    const viewportCenterY = viewport.y + viewport.height / 2;

    // Project distance onto scroll direction
    const dx = tileCenterX - viewportCenterX;
    const dy = tileCenterY - viewportCenterY;

    // Distance along scroll direction (positive = ahead, negative = behind)
    const projectedDistance = dx * dirX + dy * dirY;

    // Normalize by viewport size in scroll direction
    const viewportSizeInDir = Math.abs(dirX) * viewport.width + Math.abs(dirY) * viewport.height;
    if (viewportSizeInDir === 0) {
      // Stationary - use Euclidean distance
      return Math.sqrt(dx * dx + dy * dy) / Math.max(viewport.width, viewport.height);
    }

    return Math.abs(projectedDistance) / viewportSizeInDir;
  }

  /**
   * Map distance (in viewport units) to priority level.
   *
   * Priority zones:
   * - 0-0.5 viewport: Critical (priority 0)
   * - 0.5-1.5 viewport: High (priority 1)
   * - 1.5-2.5 viewport: Medium (priority 2)
   * - 2.5+: Low (priority 3)
   */
  private getPriorityForDistance(distance: number): PrefetchPriority {
    if (distance < 0.5) return 0;
    if (distance < 1.5) return 1;
    if (distance < 2.5) return 2;
    return 3;
  }

  /**
   * Predict future viewport based on velocity
   *
   * Uses scroll direction and adaptive lookahead to determine prefetch area.
   * Faster scrolling = look further ahead.
   */
  private predictViewport(viewport: Rect, velocity: ScrollVelocity): Rect {
    // Use adaptive lookahead based on velocity
    const lookAheadFactor = this.getAdaptiveLookahead(velocity);

    // Determine direction (-1, 0, or 1) based on velocity sign
    // This handles both forward and backward scrolling
    const directionX = velocity.x > 0 ? 1 : velocity.x < 0 ? -1 : 0;
    const directionY = velocity.y > 0 ? 1 : velocity.y < 0 ? -1 : 0;

    return {
      x: viewport.x + directionX * lookAheadFactor * viewport.width,
      y: viewport.y + directionY * lookAheadFactor * viewport.height,
      width: viewport.width,
      height: viewport.height,
    };
  }

  /**
   * Get scroll buffer extent based on velocity direction
   */
  getScrollBuffer(velocity: ScrollVelocity): Rect {
    const bufferSize = this.config.prefetchViewports;
    const bufferX = Math.sign(velocity.x) * bufferSize;
    const bufferY = Math.sign(velocity.y) * bufferSize;

    return {
      x: bufferX,
      y: bufferY,
      width: bufferSize,
      height: bufferSize,
    };
  }

  /**
   * Get pages that should be rendered based on viewport
   */
  getVisiblePages(viewport: Rect, pageLayouts: PageLayout[]): number[] {
    return pageLayouts
      .filter(layout => this.rectsOverlap(viewport, layout))
      .map(layout => layout.page);
  }

  /**
   * Calculate momentum decay for smooth scroll prediction
   */
  decayVelocity(velocity: ScrollVelocity, deltaTime: number): ScrollVelocity {
    const decay = Math.pow(this.config.momentumDecay, deltaTime / 16); // 60fps baseline
    return {
      x: velocity.x * decay,
      y: velocity.y * decay,
    };
  }

  // Private helpers

  private rectsOverlap(a: Rect, b: Rect): boolean {
    return !(
      a.x + a.width < b.x ||
      b.x + b.width < a.x ||
      a.y + a.height < b.y ||
      b.y + b.height < a.y
    );
  }

  private getIntersection(a: Rect, b: Rect): Rect {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const width = Math.min(a.x + a.width, b.x + b.width) - x;
    const height = Math.min(a.y + a.height, b.y + b.height) - y;
    return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
  }

  private getTilesInPageRect(
    rect: Rect,
    page: number,
    scale: TileScale,
    pageWidth: number,
    pageHeight: number,
    zoom?: number
  ): TileCoordinate[] {
    const tiles: TileCoordinate[] = [];
    // TILE-SIZE-MISMATCH-FIX: Use adaptive tile size when zoom is available.
    // This ensures consistency with pdf-page-element.ts which uses getTileSize(zoom).
    const baseTileSize = zoom !== undefined ? getTileSize(zoom) : this.config.tileSize;
    const tileSize = baseTileSize / scale;

    // BLANK-AREA-FIX (v2): Properly compute rect intersection with page bounds.
    // The previous clamping logic had a bug where rects entirely off the left/top edge
    // would incorrectly get positive width/height, causing blank areas.
    // The fix uses standard rect intersection: clamp edges then compute size from edges.
    const clampedLeft = Math.max(0, rect.x);
    const clampedTop = Math.max(0, rect.y);
    const clampedRight = Math.min(pageWidth, rect.x + rect.width);
    const clampedBottom = Math.min(pageHeight, rect.y + rect.height);

    const clampedRect: Rect = {
      x: clampedLeft,
      y: clampedTop,
      width: Math.max(0, clampedRight - clampedLeft),
      height: Math.max(0, clampedBottom - clampedTop),
    };

    // Early return if clamped rect has zero area (rect is completely outside page bounds)
    if (clampedRect.width <= 0 || clampedRect.height <= 0) {
      return tiles;  // Empty array
    }

    const startX = Math.max(0, Math.floor(clampedRect.x / tileSize));
    const startY = Math.max(0, Math.floor(clampedRect.y / tileSize));
    const endX = Math.ceil((clampedRect.x + clampedRect.width) / tileSize);
    const endY = Math.ceil((clampedRect.y + clampedRect.height) / tileSize);

    const maxTileX = Math.ceil(pageWidth / tileSize);
    const maxTileY = Math.ceil(pageHeight / tileSize);

    for (let tileY = startY; tileY < Math.min(endY, maxTileY); tileY++) {
      for (let tileX = startX; tileX < Math.min(endX, maxTileX); tileX++) {
        // amnesia-e4i FIX: Include baseTileSize so render uses matching size
        tiles.push({ page, tileX, tileY, scale, tileSize: baseTileSize });
      }
    }

    return tiles;
  }

  private getTileDistanceFromPoint(
    tile: TileCoordinate,
    pageLayouts: PageLayout[],
    pointX: number,
    pointY: number
  ): number {
    const layout = pageLayouts.find(p => p.page === tile.page);
    if (!layout) return Infinity;

    const tileSize = this.config.tileSize / tile.scale;
    const tileCenterX = layout.x + tile.tileX * tileSize + tileSize / 2;
    const tileCenterY = layout.y + tile.tileY * tileSize + tileSize / 2;

    return Math.sqrt(
      Math.pow(tileCenterX - pointX, 2) + Math.pow(tileCenterY - pointY, 2)
    );
  }

  private getTileKey(tile: TileCoordinate): string {
    return `p${tile.page}-t${tile.tileX}x${tile.tileY}-s${tile.scale}`;
  }
}

// Singleton instance
let scrollStrategyInstance: ScrollStrategy | null = null;

/**
 * Get the shared scroll strategy instance
 */
export function getScrollStrategy(): ScrollStrategy {
  if (!scrollStrategyInstance) {
    scrollStrategyInstance = new ScrollStrategy();
  }
  return scrollStrategyInstance;
}

/**
 * Reset the strategy (for testing or settings changes)
 */
export function resetScrollStrategy(config?: Partial<ScrollStrategyConfig>): void {
  scrollStrategyInstance = config ? new ScrollStrategy(config) : null;
}

/**
 * Update scroll strategy settings
 */
export function updateScrollStrategyConfig(updates: Partial<ScrollStrategyConfig>): void {
  getScrollStrategy().updateConfig(updates);
}
