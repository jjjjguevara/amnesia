/**
 * Spatial Prefetcher
 *
 * Calculates 2D ripple prefetch lists for grid layouts.
 * Instead of linear prefetch (page ± N), this considers spatial proximity
 * on the canvas for efficient prefetching in auto-grid and canvas modes.
 *
 * Example (5-column grid, center=15, radius=2):
 *   Grid:  1  2  3  4  5
 *          6  7  8  9 10
 *         11 12 13 14 [15] ← center
 *         16 17 18 19 20
 *
 *   Linear prefetch: [16, 17, 14, 13]  ← Wrong for grid
 *   Spatial prefetch: [10, 14, 16, 20, 9, 11, 19, 21...]  ← Correct ripple
 */

import type { PrefetchPriority } from './adaptive-prefetcher';

export interface SpatialPrefetchConfig {
  /** Center page number (1-indexed) */
  centerPage: number;
  /** Prefetch radius in grid units (1 = immediate neighbors, 2 = 2-step ripple) */
  radius: number;
  /** Number of columns in the grid layout */
  columns: number;
  /** Total page count */
  pageCount: number;
  /** Distance metric to use. Default: 'manhattan' */
  distanceMetric?: 'manhattan' | 'euclidean';
}

export interface SpatialPrefetchResult {
  /** Page number (1-indexed) */
  page: number;
  /** Distance from center page */
  distance: number;
  /** Prefetch priority based on distance */
  priority: PrefetchPriority;
  /** Grid row (0-indexed) */
  row: number;
  /** Grid column (0-indexed) */
  col: number;
}

export interface GridPosition {
  row: number;
  col: number;
}

/**
 * Spatial prefetcher for grid-aware page prefetching
 */
export class SpatialPrefetcher {
  /**
   * Get spatially-ordered prefetch list centered on a page
   *
   * @param config - Spatial prefetch configuration
   * @returns Array of pages sorted by distance from center, closest first
   */
  getSpatialPrefetchList(config: SpatialPrefetchConfig): number[] {
    const results = this.getSpatialPrefetchResults(config);
    return results.map(r => r.page);
  }

  /**
   * Get detailed spatial prefetch results with distance and priority info
   *
   * @param config - Spatial prefetch configuration
   * @returns Array of results sorted by distance from center
   */
  getSpatialPrefetchResults(config: SpatialPrefetchConfig): SpatialPrefetchResult[] {
    const { centerPage, radius, columns, pageCount, distanceMetric = 'manhattan' } = config;

    // Handle edge cases
    if (pageCount === 0 || columns === 0) {
      return [];
    }

    // Clamp center page to valid range
    const clampedCenter = Math.max(1, Math.min(centerPage, pageCount));
    const centerPos = this.getGridPosition(clampedCenter, columns);

    const results: SpatialPrefetchResult[] = [];

    // Iterate all pages and calculate distances
    for (let page = 1; page <= pageCount; page++) {
      if (page === clampedCenter) continue; // Skip center page

      const pagePos = this.getGridPosition(page, columns);
      const distance = this.calculateDistance(centerPos, pagePos, distanceMetric);

      // Only include pages within radius
      if (distance <= radius) {
        results.push({
          page,
          distance,
          priority: this.getPriorityForDistance(distance),
          row: pagePos.row,
          col: pagePos.col,
        });
      }
    }

    // Sort by distance (closest first), then by page number for stability
    results.sort((a, b) => {
      if (a.distance !== b.distance) {
        return a.distance - b.distance;
      }
      return a.page - b.page;
    });

    return results;
  }

  /**
   * Get grid position for a page number
   *
   * @param page - Page number (1-indexed)
   * @param columns - Number of columns in grid
   * @returns Grid position (0-indexed row and column)
   */
  getGridPosition(page: number, columns: number): GridPosition {
    const index = page - 1; // Convert to 0-indexed
    return {
      row: Math.floor(index / columns),
      col: index % columns,
    };
  }

  /**
   * Get page number from grid position
   *
   * @param position - Grid position (0-indexed)
   * @param columns - Number of columns in grid
   * @returns Page number (1-indexed)
   */
  getPageFromPosition(position: GridPosition, columns: number): number {
    return position.row * columns + position.col + 1;
  }

  /**
   * Calculate distance between two grid positions
   *
   * @param from - Source position
   * @param to - Target position
   * @param metric - Distance metric ('manhattan' or 'euclidean')
   * @returns Distance value
   */
  calculateDistance(
    from: GridPosition,
    to: GridPosition,
    metric: 'manhattan' | 'euclidean'
  ): number {
    const rowDelta = Math.abs(to.row - from.row);
    const colDelta = Math.abs(to.col - from.col);

    if (metric === 'manhattan') {
      // Manhattan distance: sum of horizontal and vertical distances
      return rowDelta + colDelta;
    } else {
      // Euclidean distance: straight-line distance
      return Math.sqrt(rowDelta * rowDelta + colDelta * colDelta);
    }
  }

  /**
   * Get prefetch priority based on distance from center
   *
   * @param distance - Distance from center page
   * @returns Priority level
   */
  getPriorityForDistance(distance: number): PrefetchPriority {
    if (distance <= 1) {
      return 'high'; // Immediate neighbors
    } else if (distance <= 3) {
      return 'medium'; // 2-3 steps away
    }
    return 'low'; // 4+ steps away
  }

  /**
   * Get immediate neighbors (distance = 1) for a page
   * Useful for quick prefetch of adjacent pages only
   *
   * @param centerPage - Center page number (1-indexed)
   * @param columns - Number of columns in grid
   * @param pageCount - Total page count
   * @returns Array of neighboring page numbers
   */
  getImmediateNeighbors(centerPage: number, columns: number, pageCount: number): number[] {
    const centerPos = this.getGridPosition(centerPage, columns);
    const neighbors: number[] = [];

    // Check all 4 cardinal directions
    const directions: GridPosition[] = [
      { row: centerPos.row - 1, col: centerPos.col }, // Above
      { row: centerPos.row + 1, col: centerPos.col }, // Below
      { row: centerPos.row, col: centerPos.col - 1 }, // Left
      { row: centerPos.row, col: centerPos.col + 1 }, // Right
    ];

    for (const dir of directions) {
      // Validate position is within grid bounds
      if (dir.row >= 0 && dir.col >= 0 && dir.col < columns) {
        const page = this.getPageFromPosition(dir, columns);
        if (page >= 1 && page <= pageCount) {
          neighbors.push(page);
        }
      }
    }

    return neighbors;
  }

  /**
   * Get all pages within a given radius, organized by distance rings
   * Useful for progressive loading (load ring 1, then ring 2, etc.)
   *
   * @param centerPage - Center page number (1-indexed)
   * @param maxRadius - Maximum radius to include
   * @param columns - Number of columns in grid
   * @param pageCount - Total page count
   * @returns Map of distance to page arrays
   */
  getPagesByDistanceRing(
    centerPage: number,
    maxRadius: number,
    columns: number,
    pageCount: number
  ): Map<number, number[]> {
    const rings = new Map<number, number[]>();

    const results = this.getSpatialPrefetchResults({
      centerPage,
      radius: maxRadius,
      columns,
      pageCount,
      distanceMetric: 'manhattan',
    });

    for (const result of results) {
      const ring = rings.get(result.distance) ?? [];
      ring.push(result.page);
      rings.set(result.distance, ring);
    }

    return rings;
  }
}

/**
 * Singleton instance for convenience
 */
export const spatialPrefetcher = new SpatialPrefetcher();
