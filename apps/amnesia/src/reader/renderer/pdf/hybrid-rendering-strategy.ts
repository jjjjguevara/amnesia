/**
 * Hybrid Rendering Strategy
 *
 * Dynamically selects between full-page and tiled rendering based on zoom level,
 * page dimensions, and available memory. This optimization reduces render calls
 * at low zoom (40-60% fewer) while maintaining quality at high zoom.
 *
 * Strategy:
 * - zoom < 1.5x: Always full-page (1 render call vs 4+ tiles)
 * - 1.5x <= zoom <= 4x: Adaptive based on page size and memory
 * - zoom > 4x: Always tiled (only renders visible portion)
 *
 * Research Reference: docs/research/2026-01-09/pdf-optimizations/05-extreme-zoom-performance.md
 *
 * @example
 * ```typescript
 * const strategy = getHybridRenderingStrategy();
 *
 * if (strategy.shouldUseTiling(zoom, pageWidth, pageHeight)) {
 *   // Use tile-based rendering
 *   const tileSize = strategy.getOptimalTileSize(zoom);
 * } else {
 *   // Use full-page rendering
 * }
 * ```
 */

// Note: feature-flags and pdf-telemetry imports will be added when
// integration with tile-render-engine is complete (Phase A+.2)

/**
 * Rendering mode for a given zoom/page combination
 */
export type RenderingMode = 'full-page' | 'tiled';

/**
 * Configuration for hybrid rendering thresholds
 */
export interface HybridRenderingConfig {
  /** Zoom threshold below which full-page is always used */
  fullPageThreshold: number;
  /** Zoom threshold above which tiling is always used */
  alwaysTileThreshold: number;
  /** Maximum page pixel area for full-page rendering in adaptive zone */
  maxFullPagePixels: number;
  /** Memory budget for full-page renders (MB) */
  fullPageMemoryBudgetMB: number;
  /** Device pixel ratio */
  pixelRatio: number;
}

/**
 * Decision result from the strategy
 */
export interface RenderingDecision {
  /** Selected rendering mode */
  mode: RenderingMode;
  /** Optimal tile size (CSS pixels, only relevant if mode is 'tiled') */
  tileSize: number;
  /** Reason for the decision (for telemetry/debugging) */
  reason: string;
  /** Estimated render calls for this decision */
  estimatedRenderCalls: number;
}

/**
 * Page context for rendering decisions
 */
export interface PageRenderContext {
  /** Page width in PDF units */
  pageWidth: number;
  /** Page height in PDF units */
  pageHeight: number;
  /** Viewport width in CSS pixels */
  viewportWidth: number;
  /** Viewport height in CSS pixels */
  viewportHeight: number;
  /** Current zoom level */
  zoom: number;
}

const DEFAULT_CONFIG: HybridRenderingConfig = {
  fullPageThreshold: 1.5,
  alwaysTileThreshold: 4.0,
  // Max 4000x6000 at scale 2 = 48MP, ~192MB RGBA
  maxFullPagePixels: 24_000_000,
  fullPageMemoryBudgetMB: 200,
  pixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio || 2 : 2,
};

/**
 * Hybrid Rendering Strategy
 *
 * Determines optimal rendering approach based on zoom level, page size,
 * and system constraints.
 */
export class HybridRenderingStrategy {
  private config: HybridRenderingConfig;

  constructor(config?: Partial<HybridRenderingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Determine if tiling should be used for the given context
   *
   * @param zoom Current zoom level
   * @param pageWidth Page width in PDF units
   * @param pageHeight Page height in PDF units
   * @returns true if tiling should be used, false for full-page
   */
  shouldUseTiling(zoom: number, pageWidth: number, pageHeight: number): boolean {
    const decision = this.getDecision({
      zoom,
      pageWidth,
      pageHeight,
      viewportWidth: 0, // Not needed for basic decision
      viewportHeight: 0,
    });
    return decision.mode === 'tiled';
  }

  /**
   * Get the optimal tile size for the given zoom level
   *
   * CACHE FIX: Use consistent 512px tiles for ALL zoom levels.
   * Variable tile sizes cause coordinate mismatch, breaking fallback lookup.
   *
   * Must match progressive-tile-renderer.ts:getAdaptiveTileSize()
   *
   * @param zoom Current zoom level (ignored)
   * @returns Fixed tile size of 512 CSS pixels
   */
  getOptimalTileSize(zoom: number): number {
    // CACHE FIX: Use consistent 512px tiles for all zoom levels.
    void zoom; // Unused
    return 512;
  }

  /**
   * Get a complete rendering decision with reasoning
   *
   * @param context Page and viewport context
   * @returns Decision with mode, tile size, and reasoning
   */
  getDecision(context: PageRenderContext): RenderingDecision {
    const { zoom, pageWidth, pageHeight } = context;

    // Zone 1: Below threshold - always full-page
    if (zoom < this.config.fullPageThreshold) {
      return {
        mode: 'full-page',
        tileSize: 0,
        reason: `zoom ${zoom.toFixed(2)} < threshold ${this.config.fullPageThreshold}`,
        estimatedRenderCalls: 1,
      };
    }

    // Zone 3: Above threshold - always tiled
    if (zoom > this.config.alwaysTileThreshold) {
      const tileSize = this.getOptimalTileSize(zoom);
      const tilesPerPage = this.estimateTileCount(pageWidth, pageHeight, zoom, tileSize);
      return {
        mode: 'tiled',
        tileSize,
        reason: `zoom ${zoom.toFixed(2)} > threshold ${this.config.alwaysTileThreshold}`,
        estimatedRenderCalls: tilesPerPage,
      };
    }

    // Zone 2: Adaptive zone - decide based on page size and memory
    return this.evaluateAdaptiveZone(context);
  }

  /**
   * Evaluate the adaptive zone (1.5x - 4x zoom)
   *
   * Decision factors:
   * 1. Page pixel count at render scale
   * 2. Available memory budget
   * 3. Viewport coverage (how much of page is visible)
   */
  private evaluateAdaptiveZone(context: PageRenderContext): RenderingDecision {
    const { zoom, pageWidth, pageHeight, viewportWidth, viewportHeight } = context;

    // Calculate rendered pixel count for full-page
    const renderScale = zoom * this.config.pixelRatio;
    const renderedWidth = pageWidth * renderScale;
    const renderedHeight = pageHeight * renderScale;
    const pixelCount = renderedWidth * renderedHeight;

    // Check pixel budget
    if (pixelCount > this.config.maxFullPagePixels) {
      const tileSize = this.getOptimalTileSize(zoom);
      return {
        mode: 'tiled',
        tileSize,
        reason: `pixel count ${(pixelCount / 1_000_000).toFixed(1)}MP exceeds budget ${(this.config.maxFullPagePixels / 1_000_000).toFixed(1)}MP`,
        estimatedRenderCalls: this.estimateTileCount(pageWidth, pageHeight, zoom, tileSize),
      };
    }

    // Check memory budget (RGBA = 4 bytes per pixel)
    const memoryMB = (pixelCount * 4) / (1024 * 1024);
    if (memoryMB > this.config.fullPageMemoryBudgetMB) {
      const tileSize = this.getOptimalTileSize(zoom);
      return {
        mode: 'tiled',
        tileSize,
        reason: `memory ${memoryMB.toFixed(1)}MB exceeds budget ${this.config.fullPageMemoryBudgetMB}MB`,
        estimatedRenderCalls: this.estimateTileCount(pageWidth, pageHeight, zoom, tileSize),
      };
    }

    // Check viewport coverage - if page fills less than 50% of viewport,
    // tiling is more efficient (less to render)
    if (viewportWidth > 0 && viewportHeight > 0) {
      const pageVisibleWidth = Math.min(pageWidth * zoom, viewportWidth);
      const pageVisibleHeight = Math.min(pageHeight * zoom, viewportHeight);
      const visibleRatio =
        (pageVisibleWidth * pageVisibleHeight) / (pageWidth * zoom * pageHeight * zoom);

      if (visibleRatio < 0.5) {
        const tileSize = this.getOptimalTileSize(zoom);
        return {
          mode: 'tiled',
          tileSize,
          reason: `only ${(visibleRatio * 100).toFixed(0)}% of page visible`,
          estimatedRenderCalls: this.estimateVisibleTileCount(
            pageWidth,
            pageHeight,
            viewportWidth,
            viewportHeight,
            zoom,
            tileSize
          ),
        };
      }
    }

    // Default: use full-page in adaptive zone
    return {
      mode: 'full-page',
      tileSize: 0,
      reason: `adaptive zone: ${(pixelCount / 1_000_000).toFixed(1)}MP, ${memoryMB.toFixed(1)}MB within budget`,
      estimatedRenderCalls: 1,
    };
  }

  /**
   * Estimate total tile count for a page
   */
  private estimateTileCount(
    pageWidth: number,
    pageHeight: number,
    zoom: number,
    tileSize: number
  ): number {
    const scaledTileSize = tileSize; // Tile size is in CSS pixels
    const tilesX = Math.ceil((pageWidth * zoom) / scaledTileSize);
    const tilesY = Math.ceil((pageHeight * zoom) / scaledTileSize);
    return tilesX * tilesY;
  }

  /**
   * Estimate visible tile count (tiles that intersect viewport)
   */
  private estimateVisibleTileCount(
    pageWidth: number,
    pageHeight: number,
    viewportWidth: number,
    viewportHeight: number,
    zoom: number,
    tileSize: number
  ): number {
    // Visible area in page coordinates
    const visibleWidth = Math.min(viewportWidth / zoom, pageWidth);
    const visibleHeight = Math.min(viewportHeight / zoom, pageHeight);

    // Tiles that cover visible area
    const tilesX = Math.ceil((visibleWidth * zoom) / tileSize) + 1; // +1 for partial tiles
    const tilesY = Math.ceil((visibleHeight * zoom) / tileSize) + 1;

    return tilesX * tilesY;
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<HybridRenderingConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(updates: Partial<HybridRenderingConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Get a summary for debugging/telemetry
   */
  getSummary(context: PageRenderContext): string {
    const decision = this.getDecision(context);
    return [
      `[HybridStrategy]`,
      `  Zoom: ${context.zoom.toFixed(2)}x`,
      `  Page: ${context.pageWidth}x${context.pageHeight}`,
      `  Mode: ${decision.mode}`,
      `  Tile Size: ${decision.tileSize || 'N/A'}`,
      `  Reason: ${decision.reason}`,
      `  Est. Renders: ${decision.estimatedRenderCalls}`,
    ].join('\n');
  }
}

// Singleton instance
let strategyInstance: HybridRenderingStrategy | null = null;

/**
 * Get the shared hybrid rendering strategy instance
 */
export function getHybridRenderingStrategy(): HybridRenderingStrategy {
  if (!strategyInstance) {
    strategyInstance = new HybridRenderingStrategy();
  }
  return strategyInstance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetHybridRenderingStrategy(): void {
  strategyInstance = null;
}

/**
 * Convenience function to check if tiling should be used
 */
export function shouldUseTiling(
  zoom: number,
  pageWidth: number,
  pageHeight: number
): boolean {
  return getHybridRenderingStrategy().shouldUseTiling(zoom, pageWidth, pageHeight);
}

/**
 * Convenience function to get optimal tile size
 */
export function getOptimalTileSize(zoom: number): number {
  return getHybridRenderingStrategy().getOptimalTileSize(zoom);
}
