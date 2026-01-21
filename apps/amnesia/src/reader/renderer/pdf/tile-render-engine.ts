/**
 * Tile Render Engine
 *
 * CATiledLayer-style tile rendering for PDF pages.
 * Breaks pages into 256x256 tiles for efficient viewport-based rendering.
 *
 * Features:
 * - Multi-resolution tiles (1x low-res, 2x high-res)
 * - Viewport-based tile calculation
 * - Low-res fallback (never show blank)
 * - Async tile rendering via MuPDF worker
 */

import { getTelemetry } from './pdf-telemetry';
import type { TileRenderResult } from './wasm-renderer';
import { isFeatureEnabled } from './feature-flags';
import {
  getAdaptiveTileSize,
  MAX_SCALE_TIER,
  getDynamicMaxScaleTier,
} from './progressive-tile-renderer';

/** Default tile size in pixels (matches CATiledLayer default) */
export const TILE_SIZE = 256;

/**
 * Get tile size based on zoom level and feature flags.
 *
 * Uses adaptive tile sizing when enabled for better performance.
 * Returns 512px fixed size which avoids coordinate mismatch issues.
 *
 * @param zoom Current zoom level (optional)
 * @returns Tile size in CSS pixels
 */
export function getTileSize(zoom?: number): number {
  if (!zoom) {
    return TILE_SIZE;
  }

  // Use adaptive tile sizing for better performance
  if (isFeatureEnabled('useAdaptiveTileSize')) {
    return getAdaptiveTileSize(zoom);
  }

  return TILE_SIZE;
}

/**
 * Tile scale factor for rendering resolution.
 * Scale determines how many pixels are rendered per PDF unit.
 * For crisp display: scale = zoom * pixelRatio
 *
 * Examples:
 * - scale 1: 72 DPI (1 pixel per PDF point)
 * - scale 2: 144 DPI (2 pixels per PDF point, for Retina at 1x zoom)
 * - scale 4: 288 DPI (for 2x zoom on Retina)
 * - scale 32: 2304 DPI (for 16x zoom on Retina)
 */
export type TileScale = number;

/** Tile coordinate within a page */
export interface TileCoordinate {
  /** Page number (1-indexed) */
  page: number;
  /** Tile X index (0-indexed from left) */
  tileX: number;
  /** Tile Y index (0-indexed from top) */
  tileY: number;
  /** Scale factor for rendering resolution. Higher = more detail. */
  scale: TileScale;
}

/** Tile render request with priority */
export interface TileRenderRequest {
  tile: TileCoordinate;
  priority: 'critical' | 'high' | 'medium' | 'low';
  abortSignal?: AbortSignal;
}

/** Page layout information */
export interface PageLayout {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Viewport rectangle */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Tile Render Engine
 */
export class TileRenderEngine {
  private readonly defaultTileSize = TILE_SIZE;

  // Callbacks for tile rendering (injected by provider)
  private renderTileCallback:
    | ((tile: TileCoordinate, docId: string) => Promise<TileRenderResult | Blob>)
    | null = null;

  // Current document info
  private documentId: string | null = null;
  private pageCount = 0;
  public pageDimensions: Map<number, { width: number; height: number }> = new Map();

  /**
   * Get the tile size for a given zoom level.
   *
   * Uses adaptive tile sizing when feature is enabled:
   * - High zoom: smaller tiles (faster individual renders)
   * - Low zoom: larger tiles (fewer total tiles)
   *
   * @param zoom Current zoom level (optional)
   * @returns Tile size in pixels
   */
  getTileSizeForZoom(zoom?: number): number {
    return getTileSize(zoom);
  }

  /**
   * Set the document for tile rendering
   */
  setDocument(
    docId: string,
    pageCount: number,
    pageDimensions: Map<number, { width: number; height: number }>
  ): void {
    this.documentId = docId;
    this.pageCount = pageCount;
    this.pageDimensions = pageDimensions;
  }

  /**
   * Set the tile render callback (provided by hybrid-pdf-provider)
   */
  setRenderCallback(
    callback: (tile: TileCoordinate, docId: string) => Promise<TileRenderResult | Blob>
  ): void {
    this.renderTileCallback = callback;
  }

  /**
   * Get tile grid for a page at a given scale.
   * For crisp rendering, scale should be zoom * pixelRatio.
   *
   * @param page Page number
   * @param scale Render scale (zoom × pixelRatio)
   * @param zoom Optional zoom level for adaptive tile sizing
   * @returns Array of tile coordinates covering the page
   */
  getPageTileGrid(page: number, scale: TileScale = 1, zoom?: number): TileCoordinate[] {
    const dims = this.pageDimensions.get(page);
    if (!dims) return [];

    // Use adaptive tile size when zoom is provided
    const tileSize = this.getTileSizeForZoom(zoom);

    const tiles: TileCoordinate[] = [];
    const scaledWidth = dims.width * scale;
    const scaledHeight = dims.height * scale;

    const tilesX = Math.ceil(scaledWidth / tileSize);
    const tilesY = Math.ceil(scaledHeight / tileSize);

    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        tiles.push({ page, tileX: tx, tileY: ty, scale });
      }
    }

    return tiles;
  }

  /**
   * Get tiles visible within a viewport.
   * For crisp rendering, scale should be zoom * pixelRatio.
   *
   * @param viewport Viewport rectangle in world coordinates
   * @param pageLayouts Array of page layout information
   * @param zoom Current zoom level (used for adaptive tile sizing)
   * @param scale Optional render scale (defaults to Math.ceil(zoom))
   */
  getVisibleTiles(
    viewport: Rect,
    pageLayouts: PageLayout[],
    zoom: number,
    scale?: TileScale
  ): TileCoordinate[] {
    const tiles: TileCoordinate[] = [];
    // Use provided scale, or default to zoom for basic HiDPI support
    // DYNAMIC MAX SCALE FIX: Use getDynamicMaxScaleTier() instead of hardcoded MAX_SCALE_TIER.
    // High-end devices (8GB+ RAM) can render at scale 32 for crisp text at 16x zoom.
    // Previously hardcoded to 16, causing blurry rendering even on capable hardware.
    //
    // TILE PIXEL CAP: With 512px fixed tile size (CACHE FIX), high scales produce
    // tiles that exceed GPU limits. Cap scale so tile pixels ≤ 4096.
    // Example: At scale 32 with 512px tiles = 16384px (impossible)
    //          With cap: max scale = 4096/512 = 8 → 4096px tiles (OK)
    const MAX_TILE_PIXELS = 4096;
    const tileSize = this.getTileSizeForZoom(zoom);
    const maxScaleForTileSize = Math.floor(MAX_TILE_PIXELS / tileSize);
    const rawScale = scale ?? Math.max(1, Math.ceil(zoom));
    const dynamicMaxScale = Math.min(getDynamicMaxScaleTier(), maxScaleForTileSize);
    const effectiveScale: TileScale = Math.min(rawScale, dynamicMaxScale);

    for (const layout of pageLayouts) {
      if (!this.rectsOverlap(viewport, layout)) {
        // DIAGNOSTIC LOGGING: Log when overlap check FAILS
        // This helps debug why tiles aren't generated for visible pages
        console.warn(`[TileRenderEngine] NO OVERLAP for page ${layout.page}:`, {
          viewport: `x=${viewport.x.toFixed(1)}, y=${viewport.y.toFixed(1)}, w=${viewport.width.toFixed(1)}, h=${viewport.height.toFixed(1)}`,
          layout: `x=${layout.x.toFixed(1)}, y=${layout.y.toFixed(1)}, w=${layout.width.toFixed(1)}, h=${layout.height.toFixed(1)}`,
          // Show why overlap failed (which edge is outside)
          failReason: viewport.x + viewport.width < layout.x ? 'viewport too far left'
            : layout.x + layout.width < viewport.x ? 'viewport too far right'
            : viewport.y + viewport.height < layout.y ? 'viewport above layout'
            : layout.y + layout.height < viewport.y ? 'viewport below layout'
            : 'unknown',
        });
        continue;
      }

      const intersection = this.intersectRects(viewport, layout);

      // Convert from canvas/world coordinates to PDF page coordinates
      // Canvas uses layout.width (e.g., 400), PDF uses actual dimensions (e.g., 612)
      const pdfScale = this.canvasToPdfScale(layout.page, layout.width);

      const pdfRect: Rect = {
        x: (intersection.x - layout.x) * pdfScale,
        y: (intersection.y - layout.y) * pdfScale,
        width: intersection.width * pdfScale,
        height: intersection.height * pdfScale,
      };

      // DEBUG: Log when pdfRect exceeds page dimensions
      const pageDims = this.pageDimensions.get(layout.page);
      if (pageDims && (pdfRect.y > pageDims.height || pdfRect.y + pdfRect.height > pageDims.height * 1.5)) {
        console.warn(`[TileRenderEngine] DEBUG page ${layout.page}: pdfRect.y=${pdfRect.y.toFixed(1)} exceeds pdfHeight=${pageDims.height}`);
        console.warn(`[TileRenderEngine] DEBUG: viewport=(${viewport.x.toFixed(1)},${viewport.y.toFixed(1)} ${viewport.width.toFixed(1)}x${viewport.height.toFixed(1)})`);
        console.warn(`[TileRenderEngine] DEBUG: layout=(${layout.x},${layout.y} ${layout.width}x${layout.height}), pdfScale=${pdfScale.toFixed(3)}`);
        console.warn(`[TileRenderEngine] DEBUG: intersection=(${intersection.x.toFixed(1)},${intersection.y.toFixed(1)} ${intersection.width.toFixed(1)}x${intersection.height.toFixed(1)})`);
      }

      // Pass zoom for adaptive tile sizing
      const pageTiles = this.getTilesInRect(pdfRect, layout.page, effectiveScale, zoom);

      // DIAGNOSTIC: Log tile calculation at mid-zoom (4-8x) to debug blank area bug
      if (zoom >= 4 && zoom <= 10) {
        let tileRangeStr = '(none)';
        if (pageTiles.length > 0) {
          const tileXs = pageTiles.map(t => t.tileX);
          const tileYs = pageTiles.map(t => t.tileY);
          const minTileX = Math.min(...tileXs);
          const maxTileX = Math.max(...tileXs);
          const minTileY = Math.min(...tileYs);
          const maxTileY = Math.max(...tileYs);
          tileRangeStr = `X=[${minTileX}-${maxTileX}], Y=[${minTileY}-${maxTileY}]`;
        }
        console.log(`[TileCalc] page=${layout.page} zoom=${zoom.toFixed(2)} scale=${effectiveScale}`, {
          viewport: `(${viewport.x.toFixed(0)},${viewport.y.toFixed(0)}) ${viewport.width.toFixed(0)}x${viewport.height.toFixed(0)}`,
          layout: `(${layout.x.toFixed(0)},${layout.y.toFixed(0)}) ${layout.width.toFixed(0)}x${layout.height.toFixed(0)}`,
          intersection: `(${intersection.x.toFixed(0)},${intersection.y.toFixed(0)}) ${intersection.width.toFixed(0)}x${intersection.height.toFixed(0)}`,
          pdfRect: `(${pdfRect.x.toFixed(0)},${pdfRect.y.toFixed(0)}) ${pdfRect.width.toFixed(0)}x${pdfRect.height.toFixed(0)}`,
          pdfScale: pdfScale.toFixed(3),
          tiles: `${pageTiles.length} tiles: ${tileRangeStr}`,
        });
      }

      tiles.push(...pageTiles);
    }

    // Sort by distance from viewport center
    const centerX = viewport.x + viewport.width / 2;
    const centerY = viewport.y + viewport.height / 2;

    tiles.sort((a, b) => {
      const distA = this.tileDistanceFromCenter(a, pageLayouts, centerX, centerY, zoom);
      const distB = this.tileDistanceFromCenter(b, pageLayouts, centerX, centerY, zoom);
      return distA - distB;
    });

    // TILE GAP FIX: Return ALL visible tiles, let priority system handle batching.
    // The previous MAX_VISIBLE_TILES=32 slice caused permanent tile gaps because:
    // 1. Tiles were sorted by distance from center
    // 2. Outer tiles (indices 32+) were dropped completely
    // 3. No progressive rendering existed for dropped tiles
    //
    // Now: Return all tiles sorted by distance. The caller (triggerTilePrefetch)
    // assigns priorities: first ~32 = 'critical', rest = 'medium'/'low'.
    // RenderCoordinator's semaphore (4 permits) naturally limits concurrency,
    // and the priority queue ensures central tiles render first.
    //
    // OOM concerns at high zoom (380+ tiles) are mitigated by:
    // 1. Semaphore limiting concurrent WASM allocations to 4
    // 2. Progressive rendering via priority queue (critical first)
    // 3. Session-based abort clearing stale requests on scroll
    if (tiles.length > 64) {
      console.log(`[TileRenderEngine] ${tiles.length} visible tiles (sorted by distance from center)`);
    }

    return tiles;
  }

  /**
   * Get prefetch tiles based on scroll velocity
   */
  getPrefetchTiles(
    viewport: Rect,
    pageLayouts: PageLayout[],
    velocity: { x: number; y: number },
    viewportsAhead: number = 2
  ): TileCoordinate[] {
    const predictedViewport: Rect = {
      x: viewport.x + velocity.x * viewportsAhead,
      y: viewport.y + velocity.y * viewportsAhead,
      width: viewport.width,
      height: viewport.height,
    };

    const futureTiles = this.getVisibleTiles(predictedViewport, pageLayouts, 1);
    const currentTiles = new Set(
      this.getVisibleTiles(viewport, pageLayouts, 1).map((t) => this.getTileKey(t))
    );

    return futureTiles.filter((t) => !currentTiles.has(this.getTileKey(t)));
  }

  /**
   * Render a single tile
   */
  async renderTile(tile: TileCoordinate): Promise<TileRenderResult | Blob | null> {
    if (!this.renderTileCallback || !this.documentId) {
      console.warn('[TileRenderEngine] No render callback or document set');
      return null;
    }

    const startTime = performance.now();

    try {
      const result = await this.renderTileCallback(tile, this.documentId);
      const duration = performance.now() - startTime;
      getTelemetry().trackRenderTime(duration, 'tile');
      return result;
    } catch (error) {
      console.error('[TileRenderEngine] Tile render failed:', error);
      return null;
    }
  }

  /**
   * Get unique key for a tile (for caching)
   */
  getTileKey(tile: TileCoordinate): string {
    return `p${tile.page}-t${tile.tileX}x${tile.tileY}-s${tile.scale}`;
  }

  /**
   * Get PDF native dimensions for a page
   * Returns null if page dimensions not available
   */
  getPageDimensions(page: number): { width: number; height: number } | null {
    return this.pageDimensions.get(page) ?? null;
  }

  /**
   * Get the bounding box of a tile in page coordinates
   *
   * @param tile Tile coordinate
   * @param zoom Optional zoom level for adaptive tile sizing
   */
  getTileBounds(tile: TileCoordinate, zoom?: number): Rect {
    const tileSize = this.getTileSizeForZoom(zoom);
    const size = tileSize / tile.scale;
    return {
      x: tile.tileX * size,
      y: tile.tileY * size,
      width: size,
      height: size,
    };
  }

  /**
   * Draw a checkerboard placeholder for a missing tile
   */
  drawPlaceholder(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number = this.defaultTileSize,
    height: number = this.defaultTileSize
  ): void {
    const checkSize = 16;
    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(x, y, width, height);

    ctx.fillStyle = '#e8e8e8';
    for (let ty = 0; ty < height / checkSize; ty++) {
      for (let tx = 0; tx < width / checkSize; tx++) {
        if ((tx + ty) % 2 === 0) {
          ctx.fillRect(x + tx * checkSize, y + ty * checkSize, checkSize, checkSize);
        }
      }
    }
  }

  /**
   * Get quality factor for current scroll velocity.
   * Returns a multiplier (0.5 = reduced quality for fast scroll, 1.0 = full quality when stopped)
   */
  getQualityFactorForVelocity(velocity: number): number {
    // Fast scroll: reduce quality by half for faster rendering
    // Stopped/slow: full quality
    return Math.abs(velocity) > 500 ? 0.5 : 1.0;
  }

  /**
   * Check if tiling should be used based on mode and zoom
   */
  shouldUseTiling(mode: 'paginated' | 'scroll' | 'grid', zoom: number): boolean {
    switch (mode) {
      case 'paginated':
        return zoom > 2.0; // User decision: tile only at high zoom
      case 'scroll':
        return true; // Always use tiling for scroll mode
      case 'grid':
        return false; // Grid mode uses thumbnails
    }
  }

  // Private helpers

  /**
   * Get the scale factor to convert from canvas to PDF coordinates.
   * Canvas layout uses a fixed width (e.g., 400 units), but PDF pages
   * have their own dimensions (e.g., 612×792 for US Letter).
   *
   * @param page Page number
   * @param canvasWidth Width of the page in canvas/layout units
   * @returns Scale factor: pdfWidth / canvasWidth
   */
  private canvasToPdfScale(page: number, canvasWidth: number): number {
    const dims = this.pageDimensions.get(page);
    if (!dims || canvasWidth === 0) return 1;
    return dims.width / canvasWidth;
  }

  private rectsOverlap(a: Rect, b: Rect): boolean {
    return !(
      a.x + a.width < b.x ||
      b.x + b.width < a.x ||
      a.y + a.height < b.y ||
      b.y + b.height < a.y
    );
  }

  private intersectRects(a: Rect, b: Rect): Rect {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const width = Math.min(a.x + a.width, b.x + b.width) - x;
    const height = Math.min(a.y + a.height, b.y + b.height) - y;
    return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
  }

  private getTilesInRect(
    rect: Rect,
    page: number,
    scale: TileScale,
    zoom?: number
  ): TileCoordinate[] {
    const tiles: TileCoordinate[] = [];
    const baseTileSize = this.getTileSizeForZoom(zoom);
    const tileSize = baseTileSize / scale;

    // RACE CONDITION FIX: If pageDimensions are not yet available, return empty array.
    // This can happen when tiles are requested before setupTileEngine() completes.
    // Returning empty ensures no invalid tiles are generated; the canvas will retry
    // after dimensions are populated via setupTileEngine().
    const pageDims = this.pageDimensions.get(page);
    if (!pageDims) {
      console.warn(`[TileRenderEngine] getTilesInRect: No dimensions for page ${page}, skipping tile generation`);
      return tiles;  // Empty array
    }

    // BLANK-AREA-FIX (v2): Properly compute rect intersection with page bounds.
    // The previous clamping logic had a bug where rects entirely off the left/top edge
    // (e.g., rect.x=-600, rect.width=200 → spans -600 to -400, entirely before page)
    // would incorrectly get positive width/height. This caused blank areas because
    // tiles were generated for regions that don't overlap the actual page content.
    //
    // The fix uses standard rect intersection: clamp edges then compute size from edges.
    const clampedLeft = Math.max(0, rect.x);
    const clampedTop = Math.max(0, rect.y);
    const clampedRight = Math.min(pageDims.width, rect.x + rect.width);
    const clampedBottom = Math.min(pageDims.height, rect.y + rect.height);

    const clampedRect: Rect = {
      x: clampedLeft,
      y: clampedTop,
      width: Math.max(0, clampedRight - clampedLeft),
      height: Math.max(0, clampedBottom - clampedTop),
    };

    // Early return if clamped rect has zero area (rect is completely outside page bounds)
    if (clampedRect.width <= 0 || clampedRect.height <= 0) {
      console.log(`[TileRenderEngine] getTilesInRect: rect completely outside page bounds for page ${page}, ` +
        `originalRect=(${rect.x.toFixed(1)},${rect.y.toFixed(1)} ${rect.width.toFixed(1)}x${rect.height.toFixed(1)}), ` +
        `pageDims=${pageDims.width.toFixed(1)}x${pageDims.height.toFixed(1)}`);
      return tiles;  // Empty array
    }

    const startX = Math.floor(clampedRect.x / tileSize);
    const startY = Math.floor(clampedRect.y / tileSize);
    const endX = Math.ceil((clampedRect.x + clampedRect.width) / tileSize);
    const endY = Math.ceil((clampedRect.y + clampedRect.height) / tileSize);

    // Calculate max tile indices from page dimensions
    const maxTileX = Math.ceil(pageDims.width / tileSize);
    const maxTileY = Math.ceil(pageDims.height / tileSize);

    for (let ty = startY; ty < endY; ty++) {
      for (let tx = startX; tx < endX; tx++) {
        // Additional bounds check (should be redundant after clamping, but kept for safety)
        if (tx >= 0 && ty >= 0 && tx < maxTileX && ty < maxTileY) {
          tiles.push({ page, tileX: tx, tileY: ty, scale });
        }
      }
    }

    return tiles;
  }

  private tileDistanceFromCenter(
    tile: TileCoordinate,
    pageLayouts: PageLayout[],
    centerX: number,
    centerY: number,
    zoom?: number
  ): number {
    const layout = pageLayouts.find((p) => p.page === tile.page);
    if (!layout) return Infinity;

    const baseTileSize = this.getTileSizeForZoom(zoom);
    const tileSize = baseTileSize / tile.scale;
    const tileCenterX = layout.x + tile.tileX * tileSize + tileSize / 2;
    const tileCenterY = layout.y + tile.tileY * tileSize + tileSize / 2;

    return Math.sqrt(
      Math.pow(tileCenterX - centerX, 2) + Math.pow(tileCenterY - centerY, 2)
    );
  }
}

// Singleton instance
let tileEngineInstance: TileRenderEngine | null = null;

/**
 * Get the shared tile render engine instance
 */
export function getTileEngine(): TileRenderEngine {
  if (!tileEngineInstance) {
    tileEngineInstance = new TileRenderEngine();
  }
  return tileEngineInstance;
}

/**
 * Reset the tile engine (for testing)
 */
export function resetTileEngine(): void {
  tileEngineInstance = null;
}
