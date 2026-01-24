/**
 * Grid Mode Strategy
 *
 * Rendering strategy for grid/thumbnail PDF viewing.
 *
 * Key characteristics:
 * - Ripple loading from center outward (focused page first)
 * - Low-resolution by default, upgrade on hover/focus
 * - Thumbnail caching for fast re-display
 * - Progressive enhancement (1x → 2x resolution)
 *
 * @example
 * ```typescript
 * const strategy = new GridStrategy({ columns: 3 });
 *
 * // Get ripple prefetch order from center
 * const pages = strategy.getRipplePrefetchList(5, 10);
 * // Returns [5, 4, 6, 3, 7, 2, 8, 1, 9, 10]
 *
 * // Check scale for a page
 * const scale = strategy.getTileScale(5, hoveredPage, focusedPage);
 * ```
 */

import type { TileScale } from './tile-render-engine';

/** Grid strategy configuration */
export interface GridStrategyConfig {
  /** Number of columns in grid */
  columns: number;
  /** Gap between thumbnails in pixels */
  gap: number;
  /** Thumbnail size (width) in pixels */
  thumbnailWidth: number;
  /** Number of rings to prefetch from center */
  prefetchRings: number;
}

/** Page priority for rendering */
export interface PagePriority {
  page: number;
  priority: number; // 0-100, higher = more important
  ring: number; // Distance from center (0 = center)
}

/**
 * Grid Mode Strategy
 */
export class GridStrategy {
  private config: GridStrategyConfig;

  constructor(config: Partial<GridStrategyConfig> = {}) {
    this.config = {
      columns: config.columns ?? 3,
      gap: config.gap ?? 20,
      thumbnailWidth: config.thumbnailWidth ?? 200,
      prefetchRings: config.prefetchRings ?? 3,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<GridStrategyConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Grid mode uses full-page thumbnails, not tiles
   */
  shouldUseTiling(): boolean {
    return false;
  }

  /**
   * Get pages to prefetch in ripple order from center
   *
   * Starts at center page and expands outward in rings
   */
  getRipplePrefetchList(
    centerPage: number,
    pageCount: number,
    maxPages: number = 20
  ): PagePriority[] {
    const pages: PagePriority[] = [];
    const visited = new Set<number>();

    // Calculate center position in grid
    const centerRow = Math.floor((centerPage - 1) / this.config.columns);
    const centerCol = (centerPage - 1) % this.config.columns;

    // Expand in rings
    for (let ring = 0; ring <= this.config.prefetchRings && pages.length < maxPages; ring++) {
      const ringPages = this.getPagesInRing(centerRow, centerCol, ring, pageCount);

      for (const page of ringPages) {
        if (!visited.has(page) && pages.length < maxPages) {
          visited.add(page);
          // Priority decreases with ring distance
          const priority = Math.max(20, 100 - ring * 20);
          pages.push({ page, priority, ring });
        }
      }
    }

    // Sort by priority descending
    return pages.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get pages in a specific ring around center
   *
   * Uses Chebyshev distance (chess king moves): ring N includes all cells
   * that are exactly N steps away horizontally, vertically, OR diagonally.
   * This creates a square ripple pattern, not a circular one.
   */
  private getPagesInRing(
    centerRow: number,
    centerCol: number,
    ring: number,
    pageCount: number
  ): number[] {
    const pages: number[] = [];
    const totalCols = this.config.columns;

    if (ring === 0) {
      // Center cell only
      const page = centerRow * totalCols + centerCol + 1;
      if (page >= 1 && page <= pageCount) {
        pages.push(page);
      }
      return pages;
    }

    // Walk the ring perimeter
    // Top edge (left to right)
    for (let col = centerCol - ring; col <= centerCol + ring; col++) {
      this.addPageIfValid(pages, centerRow - ring, col, totalCols, pageCount);
    }

    // Right edge (top to bottom, excluding corners)
    for (let row = centerRow - ring + 1; row <= centerRow + ring - 1; row++) {
      this.addPageIfValid(pages, row, centerCol + ring, totalCols, pageCount);
    }

    // Bottom edge (right to left)
    for (let col = centerCol + ring; col >= centerCol - ring; col--) {
      this.addPageIfValid(pages, centerRow + ring, col, totalCols, pageCount);
    }

    // Left edge (bottom to top, excluding corners)
    for (let row = centerRow + ring - 1; row >= centerRow - ring + 1; row--) {
      this.addPageIfValid(pages, row, centerCol - ring, totalCols, pageCount);
    }

    return pages;
  }

  /**
   * Add page to list if coordinates are valid
   */
  private addPageIfValid(
    pages: number[],
    row: number,
    col: number,
    totalCols: number,
    pageCount: number
  ): void {
    if (row < 0 || col < 0 || col >= totalCols) return;

    const page = row * totalCols + col + 1;
    if (page >= 1 && page <= pageCount) {
      pages.push(page);
    }
  }

  /**
   * Get tile scale based on interaction state.
   *
   * For grid mode (thumbnails), returns a quality factor:
   * - 1 for background pages (low-res)
   * - 2 for hovered/focused pages (higher-res)
   *
   * Note: Grid mode typically uses thumbnails, not tiles. This scale
   * affects the render quality when generating thumbnails.
   */
  getTileScale(
    page: number,
    hoveredPage: number | null,
    focusedPage: number | null
  ): TileScale {
    if (page === focusedPage || page === hoveredPage) {
      return 2; // Higher quality for active page
    }
    return 1; // Lower quality for background pages
  }

  /**
   * Get render scale for thumbnail generation
   *
   * Returns a scale factor to fit the page into the thumbnail width
   */
  getThumbnailScale(pageWidth: number): number {
    return this.config.thumbnailWidth / pageWidth;
  }

  /**
   * Calculate grid position for a page
   */
  getGridPosition(
    page: number
  ): { row: number; col: number; x: number; y: number } {
    const { columns, gap, thumbnailWidth } = this.config;
    const index = page - 1;
    const row = Math.floor(index / columns);
    const col = index % columns;

    return {
      row,
      col,
      x: col * (thumbnailWidth + gap),
      y: row * (thumbnailWidth * 1.4 + gap), // Assuming ~1.4 aspect ratio
    };
  }

  /**
   * Get visible pages based on scroll position
   */
  getVisiblePages(
    scrollY: number,
    viewportHeight: number,
    pageCount: number
  ): number[] {
    const { columns, gap, thumbnailWidth } = this.config;
    const rowHeight = thumbnailWidth * 1.4 + gap; // Assuming ~1.4 aspect ratio

    const startRow = Math.max(0, Math.floor(scrollY / rowHeight) - 1);
    const endRow = Math.ceil((scrollY + viewportHeight) / rowHeight) + 1;

    const pages: number[] = [];
    for (let row = startRow; row <= endRow; row++) {
      for (let col = 0; col < columns; col++) {
        const page = row * columns + col + 1;
        if (page >= 1 && page <= pageCount) {
          pages.push(page);
        }
      }
    }

    return pages;
  }

  /**
   * Calculate optimal column count based on container width
   */
  static calculateOptimalColumns(
    containerWidth: number,
    thumbnailWidth: number = 200,
    gap: number = 20,
    minColumns: number = 2,
    maxColumns: number = 6
  ): number {
    const availableWidth = containerWidth - gap; // Account for outer padding
    const cellWidth = thumbnailWidth + gap;
    const columns = Math.floor(availableWidth / cellWidth);

    return Math.max(minColumns, Math.min(maxColumns, columns));
  }

  /**
   * Get page priority for cache eviction
   */
  getPagePriority(
    page: number,
    centerPage: number,
    hoveredPage: number | null,
    focusedPage: number | null
  ): number {
    // Focused/hovered pages get highest priority
    if (page === focusedPage) return 100;
    if (page === hoveredPage) return 95;

    // Calculate ring distance from center
    const centerRow = Math.floor((centerPage - 1) / this.config.columns);
    const centerCol = (centerPage - 1) % this.config.columns;
    const pageRow = Math.floor((page - 1) / this.config.columns);
    const pageCol = (page - 1) % this.config.columns;

    const distance = Math.max(
      Math.abs(pageRow - centerRow),
      Math.abs(pageCol - centerCol)
    );

    return Math.max(10, 80 - distance * 15);
  }
}

// Singleton instance
let gridStrategyInstance: GridStrategy | null = null;

/**
 * Get the shared grid strategy instance
 */
export function getGridStrategy(): GridStrategy {
  if (!gridStrategyInstance) {
    gridStrategyInstance = new GridStrategy();
  }
  return gridStrategyInstance;
}

/**
 * Reset the strategy (for testing or settings changes)
 */
export function resetGridStrategy(config?: Partial<GridStrategyConfig>): void {
  gridStrategyInstance = config ? new GridStrategy(config) : null;
}

/**
 * Update grid strategy settings
 */
export function updateGridStrategyConfig(updates: Partial<GridStrategyConfig>): void {
  getGridStrategy().updateConfig(updates);
}

/**
 * Priority level for thumbnail generation
 */
export type ThumbnailPriority = 'critical' | 'high' | 'medium' | 'low';

/**
 * Page with priority information for thumbnail generation
 */
export interface ThumbnailPriorityPage {
  page: number;
  priority: ThumbnailPriority;
  numericPriority: number; // 0-100, higher = more important
}

/**
 * Generate ripple order for thumbnail generation.
 *
 * Unlike grid-based ripple which uses 2D grid coordinates,
 * this uses linear page distance from center for simpler thumbnail ordering.
 *
 * Priority bands:
 * - Critical: Center ± 2 pages (visible immediately)
 * - High: Center ± 10 pages (likely to scroll to)
 * - Medium: Center ± 30 pages (probable viewing)
 * - Low: Everything else (background loading)
 *
 * @param centerPage The starting page (1-indexed)
 * @param pageCount Total number of pages
 * @returns Pages ordered by priority (critical first)
 */
export function getThumbnailRippleOrder(
  centerPage: number,
  pageCount: number
): ThumbnailPriorityPage[] {
  const pages: ThumbnailPriorityPage[] = [];
  const visited = new Set<number>();

  // Start from center and expand outward
  let ring = 0;
  while (pages.length < pageCount) {
    // Add pages at this distance from center
    const before = centerPage - ring;
    const after = centerPage + ring;

    if (ring === 0) {
      // Center page
      if (centerPage >= 1 && centerPage <= pageCount) {
        pages.push({
          page: centerPage,
          priority: 'critical',
          numericPriority: 100,
        });
        visited.add(centerPage);
      }
    } else {
      // Add before and after pages
      if (before >= 1 && !visited.has(before)) {
        pages.push({
          page: before,
          ...getPriorityForDistance(ring),
        });
        visited.add(before);
      }
      if (after <= pageCount && !visited.has(after)) {
        pages.push({
          page: after,
          ...getPriorityForDistance(ring),
        });
        visited.add(after);
      }
    }

    ring++;

    // Safety check to prevent infinite loop
    if (ring > pageCount) break;
  }

  return pages;
}

/**
 * Get priority level based on distance from center
 */
function getPriorityForDistance(distance: number): { priority: ThumbnailPriority; numericPriority: number } {
  if (distance <= 2) {
    return { priority: 'critical', numericPriority: 100 - distance * 5 };
  } else if (distance <= 10) {
    return { priority: 'high', numericPriority: 80 - (distance - 2) * 5 };
  } else if (distance <= 30) {
    return { priority: 'medium', numericPriority: 50 - (distance - 10) * 1 };
  } else {
    return { priority: 'low', numericPriority: Math.max(10, 30 - (distance - 30) * 0.5) };
  }
}

/**
 * Group pages by priority level for batch processing
 */
export function groupPagesByPriority(
  pages: ThumbnailPriorityPage[]
): Record<ThumbnailPriority, number[]> {
  const groups: Record<ThumbnailPriority, number[]> = {
    critical: [],
    high: [],
    medium: [],
    low: [],
  };

  for (const { page, priority } of pages) {
    groups[priority].push(page);
  }

  return groups;
}
