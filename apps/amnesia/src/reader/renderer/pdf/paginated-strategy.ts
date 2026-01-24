/**
 * Paginated Mode Strategy
 *
 * Rendering strategy for paginated PDF viewing (single page at a time).
 *
 * Key characteristics:
 * - Full page rendering at normal zoom (≤2x)
 * - Tile-based rendering at high zoom (>2x) for memory efficiency
 * - Pre-renders adjacent pages (n-1, n, n+1) for instant navigation
 * - Page turn animations benefit from pre-cached pages
 *
 * @example
 * ```typescript
 * const strategy = new PaginatedStrategy();
 *
 * // Check if we should use tiling
 * if (strategy.shouldUseTiling(currentZoom)) {
 *   // Use tile-based rendering
 * } else {
 *   // Use full-page rendering
 * }
 *
 * // Get prefetch list
 * const prefetch = strategy.getPrefetchList(5, 100);
 * // Returns pages 4, 5, 6 with priorities
 * ```
 */

import type { TileCoordinate } from './tile-render-engine';

/** Page prefetch request with priority */
export interface PrefetchRequest {
  page: number;
  priority: number; // 0-100, higher = more important
}

/** Render mode for a page */
export type PageRenderMode = 'full' | 'tiled';

/**
 * Paginated Mode Strategy
 */
export class PaginatedStrategy {
  /** Zoom threshold for switching to tiled rendering */
  private readonly tilingThreshold: number;

  /** Number of pages to prefetch in each direction */
  private readonly prefetchRadius: number;

  constructor(options?: {
    tilingThreshold?: number;
    prefetchRadius?: number;
  }) {
    // User decision: tile only at high zoom (>2x)
    this.tilingThreshold = options?.tilingThreshold ?? 2.0;
    // Prefetch ±1 page by default
    this.prefetchRadius = options?.prefetchRadius ?? 1;
  }

  /**
   * Determine if tiling should be used based on zoom level
   *
   * User decision: tile only at high zoom
   * - At normal zoom (≤2x), render full pages for quality and simplicity
   * - At high zoom (>2x), use tiles for memory efficiency
   */
  shouldUseTiling(zoom: number): boolean {
    return zoom > this.tilingThreshold;
  }

  /**
   * Get the render mode for a page at a given zoom level
   */
  getPageRenderMode(zoom: number): PageRenderMode {
    return this.shouldUseTiling(zoom) ? 'tiled' : 'full';
  }

  /**
   * Get list of pages to prefetch for instant navigation
   *
   * Returns current page + adjacent pages with priority weighting
   */
  getPrefetchList(currentPage: number, pageCount: number): PrefetchRequest[] {
    const requests: PrefetchRequest[] = [];

    for (let offset = -this.prefetchRadius; offset <= this.prefetchRadius; offset++) {
      const page = currentPage + offset;

      // Skip invalid pages
      if (page < 1 || page > pageCount) continue;

      // Calculate priority based on distance from current
      // Current page = 100, adjacent = 80, further = decreasing
      const distance = Math.abs(offset);
      const priority = distance === 0 ? 100 : Math.max(50, 80 - (distance - 1) * 15);

      requests.push({ page, priority });
    }

    // Sort by priority descending
    return requests.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get visible tiles for a page at high zoom
   *
   * Only called when zoom > tilingThreshold
   */
  getVisibleTiles(
    page: number,
    viewportX: number,
    viewportY: number,
    viewportWidth: number,
    viewportHeight: number,
    pageWidth: number,
    pageHeight: number,
    zoom: number,
    tileSize: number = 256
  ): TileCoordinate[] {
    const tiles: TileCoordinate[] = [];
    const scale: 1 | 2 = zoom >= 4 ? 2 : 1;

    // Convert viewport to page coordinates
    const pageViewportX = viewportX / zoom;
    const pageViewportY = viewportY / zoom;
    const pageViewportWidth = viewportWidth / zoom;
    const pageViewportHeight = viewportHeight / zoom;

    // Tile size in page coordinates
    const pageTileSize = tileSize / scale;

    // Calculate tile range
    const startTileX = Math.max(0, Math.floor(pageViewportX / pageTileSize));
    const startTileY = Math.max(0, Math.floor(pageViewportY / pageTileSize));
    const endTileX = Math.ceil((pageViewportX + pageViewportWidth) / pageTileSize);
    const endTileY = Math.ceil((pageViewportY + pageViewportHeight) / pageTileSize);

    // Max tiles based on page dimensions
    const maxTileX = Math.ceil(pageWidth / pageTileSize);
    const maxTileY = Math.ceil(pageHeight / pageTileSize);

    for (let tileY = startTileY; tileY < Math.min(endTileY, maxTileY); tileY++) {
      for (let tileX = startTileX; tileX < Math.min(endTileX, maxTileX); tileX++) {
        // amnesia-e4i FIX: Include tileSize so render uses matching size
        tiles.push({ page, tileX, tileY, scale, tileSize });
      }
    }

    return tiles;
  }

  /**
   * Get optimal scale for tile rendering based on zoom
   */
  getTileScale(zoom: number): 1 | 2 {
    // Use 2x tiles when zoom > 4x for sharper rendering
    return zoom >= 4 ? 2 : 1;
  }

  /**
   * Calculate page priority for cache eviction decisions
   *
   * Current page and adjacent pages get highest priority
   */
  getPagePriority(page: number, currentPage: number): number {
    const distance = Math.abs(page - currentPage);
    if (distance === 0) return 100;
    if (distance === 1) return 80;
    if (distance === 2) return 60;
    return Math.max(10, 40 - (distance - 3) * 10);
  }

  /**
   * Determine if a page should be kept in cache
   */
  shouldKeepInCache(page: number, currentPage: number, radius: number = 3): boolean {
    return Math.abs(page - currentPage) <= radius;
  }

  /**
   * Get animation duration for page transitions
   * Returns milliseconds
   */
  getTransitionDuration(isQuickNav: boolean): number {
    return isQuickNav ? 150 : 300;
  }
}

// Singleton instance
let paginatedStrategyInstance: PaginatedStrategy | null = null;

/**
 * Get the shared paginated strategy instance
 */
export function getPaginatedStrategy(): PaginatedStrategy {
  if (!paginatedStrategyInstance) {
    paginatedStrategyInstance = new PaginatedStrategy();
  }
  return paginatedStrategyInstance;
}

/**
 * Reset the strategy (for testing or settings changes)
 */
export function resetPaginatedStrategy(options?: {
  tilingThreshold?: number;
  prefetchRadius?: number;
}): void {
  paginatedStrategyInstance = options ? new PaginatedStrategy(options) : null;
}
