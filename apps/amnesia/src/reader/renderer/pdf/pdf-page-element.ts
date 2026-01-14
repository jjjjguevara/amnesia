/**
 * PDF Page Element
 *
 * Self-contained element for rendering a single PDF page.
 * Includes canvas layer, text layer, and annotation layer.
 * Multiple instances can be created for multi-page display.
 */

import type { PdfTextLayer as TextLayerData, PdfTextLayerData } from '../types';
import type { HighlightColor } from '../types';
import { extractAsMarkdown, extractAsPlainText, prepareCopyData } from './smart-copy';
import { DarkModeRenderer } from './dark-mode-renderer';
import { MobileReflowRenderer, type ReflowConfig } from './mobile-reflow';
import { PdfSvgTextLayer, type SvgTextLayerConfig } from './pdf-svg-text-layer';
import { getCanvasPool } from './pdf-canvas-pool';
import { getTelemetry } from './pdf-telemetry';
import { TILE_SIZE, getTileSize, type TileCoordinate } from './tile-render-engine';
import { getTargetScaleTier } from './progressive-tile-renderer';
import { isFeatureEnabled } from './feature-flags';
import { getCoordinateDebugger } from './coordinate-debugger';

export type ReadingMode = 'device' | 'light' | 'sepia' | 'dark' | 'night';
export type RenderMode = 'page' | 'reflow';

export interface PageRenderData {
  imageBlob: Blob;
  textLayerData?: TextLayerData;
}

export interface PdfPageElementConfig {
  /** Page number (1-indexed) */
  pageNumber: number;
  /** Pixel ratio for HiDPI */
  pixelRatio?: number;
  /** Enable text layer anti-aliasing */
  enableTextAntialiasing?: boolean;
  /** Enable image smoothing */
  enableImageSmoothing?: boolean;
  /** Use SVG text layer for vector-crisp text at any zoom (default: true) */
  useSvgTextLayer?: boolean;
  /** Debug mode for SVG text layer (makes text visible) */
  debugTextLayer?: boolean;
}

export interface PageHighlight {
  id: string;
  annotationId: string;
  color: HighlightColor;
  rects: Array<{ x: number; y: number; width: number; height: number }>;
}

/**
 * Individual PDF page element with all layers
 */
export class PdfPageElement {
  private container: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private textLayerEl: HTMLDivElement;
  private annotationLayerEl: HTMLDivElement;
  private reflowLayerEl: HTMLDivElement;

  // Reusable offscreen canvas for tile compositing (reduces GC pressure)
  // Created lazily and resized as needed instead of new canvas per render
  private offscreenCanvas: HTMLCanvasElement | null = null;
  private offscreenCtx: CanvasRenderingContext2D | null = null;

  private config: Required<PdfPageElementConfig>;
  private currentWidth = 0;
  private currentHeight = 0;
  private isRendered = false;
  private currentReadingMode: ReadingMode = 'light';
  private currentRenderMode: RenderMode = 'page';

  // Text layer data for smart copy
  private textLayerData: PdfTextLayerData | null = null;

  // Current zoom level for tile rendering decisions
  private currentZoom = 1.0;

  // Smart copy enabled (converts to Markdown on copy)
  private smartCopyEnabled = true;

  // Dark mode renderer for smart dark mode (preserves images)
  private darkModeRenderer: DarkModeRenderer | null = null;
  private useSmartDarkMode = false;
  // Track if smart dark mode needs to be reapplied after renders
  private smartDarkModeApplied = false;

  // Use HSL lightness inversion instead of CSS filters (experimental)
  // This preserves anti-aliasing better but is computationally more expensive
  private useHslDarkMode = false;

  // Mobile reflow renderer
  private reflowRenderer: MobileReflowRenderer | null = null;

  // SVG text layer for vector-crisp text rendering at any zoom level
  private svgTextLayer: PdfSvgTextLayer | null = null;
  private useSvgTextLayer = true;

  // CSS stretch tracking for zoom gesture freezing
  // Tracks the current cssStretch applied to this page's transform
  private currentCssStretch: number = 1;

  // UNIFIED COORDINATE SPACE: Final zoomed dimensions
  // In the new architecture, page elements are sized to their final displayed dimensions
  // rather than relying on camera scale transforms. This eliminates cssStretch compensation.
  private finalWidth: number = 0;
  private finalHeight: number = 0;

  // Callbacks
  private onSelectionCallback?: (page: number, text: string, rects: DOMRect[]) => void;
  private onHighlightClickCallback?: (annotationId: string, position: { x: number; y: number }) => void;

  constructor(config: PdfPageElementConfig) {
    // Determine pixelRatio at runtime to handle cases where passed config captured incorrect value
    let pixelRatio = config.pixelRatio ?? window.devicePixelRatio ?? 1;
    if (pixelRatio === 1 && window.devicePixelRatio > 1) {
      pixelRatio = window.devicePixelRatio;
    }

    this.config = {
      pageNumber: config.pageNumber,
      pixelRatio,
      enableTextAntialiasing: config.enableTextAntialiasing ?? true,
      enableImageSmoothing: config.enableImageSmoothing ?? true,
      useSvgTextLayer: config.useSvgTextLayer ?? true,
      debugTextLayer: config.debugTextLayer ?? false,
    };

    // Set SVG text layer preference
    this.useSvgTextLayer = this.config.useSvgTextLayer;

    // Create container
    this.container = document.createElement('div');
    this.container.className = 'pdf-page-element';
    this.container.dataset.page = String(config.pageNumber);
    this.container.style.cssText = `
      position: relative;
      background: transparent;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      overflow: hidden;
      flex-shrink: 0;
    `;

    // Create canvas
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pdf-page-canvas';
    this.canvas.style.cssText = `
      display: block;
      width: 100%;
      height: 100%;
    `;
    this.container.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D context');
    }
    this.ctx = ctx;

    // Create text layer
    this.textLayerEl = document.createElement('div');
    this.textLayerEl.className = 'pdf-page-text-layer';
    this.textLayerEl.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      overflow: hidden;
      opacity: 0.2;
      line-height: 1;
      pointer-events: auto;
      user-select: text;
      -webkit-user-select: text;
    `;
    this.container.appendChild(this.textLayerEl);

    // Create annotation layer
    this.annotationLayerEl = document.createElement('div');
    this.annotationLayerEl.className = 'pdf-page-annotation-layer';
    this.annotationLayerEl.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
    `;
    this.container.appendChild(this.annotationLayerEl);

    // Create reflow layer (hidden by default)
    this.reflowLayerEl = document.createElement('div');
    this.reflowLayerEl.className = 'pdf-page-reflow-layer';
    this.reflowLayerEl.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      overflow-y: auto;
      display: none;
      background: white;
    `;
    this.container.appendChild(this.reflowLayerEl);

    // Create SVG text layer for vector-crisp text rendering
    // This is above the HTML text layer (z-index 3) for proper selection
    if (this.useSvgTextLayer) {
      this.svgTextLayer = new PdfSvgTextLayer(this.container, {
        debug: this.config.debugTextLayer,
      });
      // Hide HTML text layer when using SVG
      this.textLayerEl.style.display = 'none';
    }

    // Setup selection listener
    this.setupSelectionListener();

    // Setup copy handler for smart copy
    this.setupCopyHandler();
  }

  /**
   * Get the DOM element
   */
  getElement(): HTMLDivElement {
    return this.container;
  }

  /**
   * Get the current cssStretch value applied to this page's transform.
   * Used by PdfInfiniteCanvas to freeze cssStretch during zoom gestures.
   */
  getCurrentCssStretch(): number {
    return this.currentCssStretch;
  }

  /**
   * Reset cssStretch to 1 (exact scale).
   *
   * Called when zoom level changes significantly to prevent stale cssStretch
   * values from persisting. Without this, cssStretch could stay inflated
   * if fallback tiles are never fully replaced with exact tiles.
   */
  resetCssStretch(): void {
    this.currentCssStretch = 1;
  }

  /**
   * Enable or disable CSS transitions on the canvas transform.
   * Used to smoothly animate cssStretch changes when unfreezing after zoom.
   *
   * @param enabled - Whether to enable smooth transitions
   */
  enableTransition(enabled: boolean): void {
    if (enabled) {
      this.canvas.style.transition = 'transform 200ms ease-out';
    } else {
      this.canvas.style.transition = '';
    }
  }

  /**
   * Get page number
   */
  getPageNumber(): number {
    return this.config.pageNumber;
  }

  /**
   * Check if page is rendered
   */
  getIsRendered(): boolean {
    return this.isRendered;
  }

  /**
   * Clear the rendered flag without clearing the canvas.
   * Used for zoom-dependent re-rendering where we want to keep
   * the current content visible while fetching higher resolution.
   */
  clearRendered(): void {
    this.isRendered = false;
  }

  /**
   * Clear canvas content during zoom changes to prevent visual shift.
   *
   * When zoom changes significantly, viewport-only tile offsets (cssOffsetX/Y)
   * become stale because they were calculated for the old viewport. Instead of
   * showing old content at wrong positions, we clear the canvas to show the
   * page background until new tiles render.
   *
   * This is less jarring than showing shifted content because the user sees
   * a brief blank (matching the page background) rather than misaligned content.
   */
  resetTransformForZoomChange(): void {
    // Clear canvas content - the page background will show through
    // This is cleaner than showing old tiles at wrong positions
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Mark as needing re-render
    this.isRendered = false;
  }

  /**
   * Set dimensions and show immediate placeholder
   *
   * This ensures the page NEVER appears blank - as soon as dimensions
   * are set, a styled placeholder is displayed. This eliminates the
   * flash of empty content during scrolling.
   *
   * @deprecated Use setFinalDimensions() in unified coordinate space architecture.
   * This method will be removed once Phase 2 is complete.
   */
  setDimensions(width: number, height: number): void {
    this.currentWidth = width;
    this.currentHeight = height;

    this.container.style.width = `${width}px`;
    this.container.style.height = `${height}px`;

    // Update SVG text layer dimensions for proper scaling
    if (this.svgTextLayer) {
      this.svgTextLayer.setDimensions(width, height);
    }

    // CRITICAL: Show placeholder immediately after dimensions are set
    // This prevents blank pages during scroll/zoom
    if (!this.isRendered) {
      this.showPlaceholder();
    }
  }

  /**
   * Set final zoomed dimensions for unified coordinate space.
   *
   * UNIFIED COORDINATE SPACE ARCHITECTURE:
   * In the new architecture, page elements are sized to their **final displayed dimensions**
   * at the current zoom level. This eliminates the need for camera scale transforms and
   * the cssStretch compensation mechanism that caused visual jumps.
   *
   * Key principle: Page element DOM size = final screen size / camera.z
   * When camera.z = zoom (unified space), DOM size = layout.width * zoom.
   *
   * @param finalWidth - Width in pixels at current zoom (layout.width * zoom)
   * @param finalHeight - Height in pixels at current zoom (layout.height * zoom)
   * @param zoom - Current zoom level (stored for tile rendering calculations)
   */
  setFinalDimensions(finalWidth: number, finalHeight: number, zoom: number): void {
    this.finalWidth = finalWidth;
    this.finalHeight = finalHeight;
    this.currentZoom = zoom;

    // Set DOM element size to final zoomed dimensions
    this.container.style.width = `${finalWidth}px`;
    this.container.style.height = `${finalHeight}px`;

    // Update internal tracking (currentWidth/Height used by rendering)
    this.currentWidth = finalWidth;
    this.currentHeight = finalHeight;

    // Update SVG text layer dimensions for proper scaling
    if (this.svgTextLayer) {
      this.svgTextLayer.setDimensions(finalWidth, finalHeight);
    }

    // Resize canvas buffer to match final dimensions (with DPR scaling for sharpness)
    // This ensures the canvas can hold high-res content for the new zoom level
    // Use window.devicePixelRatio directly to handle DPR changes at runtime (e.g., moving window between displays)
    const dpr = window.devicePixelRatio || this.config.pixelRatio;
    const bufferWidth = Math.ceil(finalWidth * dpr);
    const bufferHeight = Math.ceil(finalHeight * dpr);

    // Only resize and clear if dimensions actually changed (avoid clearing content unnecessarily)
    const needsBufferResize = this.canvas.width !== bufferWidth || this.canvas.height !== bufferHeight;
    if (needsBufferResize) {
      this.canvas.width = bufferWidth;
      this.canvas.height = bufferHeight;
      // Canvas CSS size matches final dimensions (DPR scaling done in buffer)
      this.canvas.style.width = `${finalWidth}px`;
      this.canvas.style.height = `${finalHeight}px`;

      // Clear any existing tile content - only needed when buffer actually resizes
      // This prevents unnecessary clearing during small zoom adjustments
      this.clearTileCanvases();
    }

    // Show placeholder immediately if not yet rendered
    if (!this.isRendered) {
      this.showPlaceholder();
    }

    console.log(`[PdfPageElement] setFinalDimensions: page=${this.config.pageNumber}, finalSize=${finalWidth.toFixed(0)}x${finalHeight.toFixed(0)}, buffer=${bufferWidth}x${bufferHeight}, zoom=${zoom.toFixed(2)}`);
  }

  /**
   * Get the final width (in unified coordinate space).
   */
  getFinalWidth(): number {
    return this.finalWidth;
  }

  /**
   * Get the final height (in unified coordinate space).
   */
  getFinalHeight(): number {
    return this.finalHeight;
  }

  /**
   * Clear all tile canvases.
   * Called when zoom changes in unified coordinate space to remove stale tiles.
   */
  clearTileCanvases(): void {
    // Note: tileCanvases map is used in renderTiles() but currently canvases are
    // created inline within that method. This method provides the interface for
    // future optimization where we track tile canvases separately.
    // For now, clear the main canvas which holds composited tiles.
    if (this.offscreenCanvas) {
      this.offscreenCtx?.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
    }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // NOTE: Don't reset canvas transform here to avoid visual jumps.
    // renderTiles() will set the correct transform when it renders new content.
    // Resetting transform here would cause a brief flash at wrong position/scale
    // before the next render completes.

    // Mark as needing re-render
    this.isRendered = false;
  }

  /**
   * Show placeholder content while loading.
   *
   * PERFORMANCE: Uses CSS-only placeholder instead of canvas drawing.
   * Previous implementation drew 25+ roundRect operations per page, causing
   * 160ms+ main thread blocking during fast scroll with 20+ new pages.
   * CSS background is GPU-accelerated and non-blocking.
   */
  private showPlaceholder(): void {
    if (this.currentWidth <= 0 || this.currentHeight <= 0) return;

    // Transparent placeholder - cleaner loading experience
    // The canvas is transparent, showing the viewport background
    this.canvas.style.background = 'transparent';
    this.canvas.style.backgroundSize = '';
    this.canvas.style.backgroundPosition = '';
    this.canvas.style.backgroundRepeat = '';

    // Set canvas size for proper display (minimal operation)
    this.canvas.style.width = `${this.currentWidth}px`;
    this.canvas.style.height = `${this.currentHeight}px`;
  }

  /**
   * Update for zoom changes
   *
   * Updates dimensions and text layer positioning for the current zoom level.
   * Used in tiled rendering mode where zoom affects tile resolution.
   *
   * @param zoom - Current zoom level
   * @param width - Display width in pixels
   * @param height - Display height in pixels
   *
   * @deprecated Use setFinalDimensions() in unified coordinate space architecture.
   * This method will be removed once Phase 2 is complete.
   */
  updateForZoom(zoom: number, width: number, height: number): void {
    this.currentZoom = zoom;
    this.setDimensions(width, height);

    // Update SVG text layer for zoom changes
    if (this.svgTextLayer) {
      this.svgTextLayer.updateForZoom(zoom, width, height);
    }
  }

  /**
   * Get current zoom level
   */
  getZoom(): number {
    return this.currentZoom;
  }

  /**
   * Clear placeholder styles when real content is rendered
   */
  private clearPlaceholder(): void {
    this.canvas.style.background = '';
    this.canvas.style.backgroundSize = '';
    this.canvas.style.backgroundPosition = '';
    this.canvas.style.backgroundRepeat = '';
  }

  /**
   * Render page content
   */
  async render(data: PageRenderData, scale: number): Promise<void> {
    const startTime = performance.now();
    const telemetry = getTelemetry();

    // Render canvas
    await this.renderCanvas(data.imageBlob);

    // Render text layer if available
    if (data.textLayerData) {
      this.renderTextLayer(data.textLayerData, scale);
    }

    this.isRendered = true;

    // Track render time and scale
    const renderTime = performance.now() - startTime;
    telemetry.trackRenderTime(renderTime, 'page');
    telemetry.trackRenderScale(scale, 'page');

    // Apply reading mode styles now that we have content
    // This enables canvas-based dark mode for better quality
    this.applyReadingModeStyles();
  }

  /**
   * Render page using tile-based rendering (CATiledLayer-style)
   * Used for high-zoom scenarios where tiles provide crisper rendering
   *
   * @param tiles Array of tile coordinates and their rendered bitmaps
   * @param textLayerData Optional text layer data for text selection
   * @param zoom Current zoom level
   * @param pdfDimensions Native PDF page dimensions (tiles are in this coordinate space)
   */
  async renderTiles(
    tiles: Array<{ tile: TileCoordinate; bitmap: ImageBitmap; cssStretch?: number }>,
    textLayerData: TextLayerData | undefined,
    zoom: number,
    pdfDimensions?: { width: number; height: number }
  ): Promise<void> {
    const startTime = performance.now();
    const telemetry = getTelemetry();

    // DEBUG: Log tile rendering call
    console.log(`[PdfPageElement] renderTiles called: ${tiles.length} tiles, zoom=${zoom.toFixed(2)}, pdfDimensions=${JSON.stringify(pdfDimensions)}`);

    // Guard: Return early if no tiles (prevents -Infinity in bounding box calculation)
    if (tiles.length === 0) {
      console.warn(`[PdfPageElement] renderTiles called with 0 tiles, skipping render`);
      return;
    }

    // Clear CSS placeholder before drawing actual content
    this.clearPlaceholder();

    // Get PDF dimensions for coordinate calculations
    const pdfWidth = pdfDimensions?.width ?? this.currentWidth;
    const pdfHeight = pdfDimensions?.height ?? this.currentHeight;

    // Get tile scale from first tile (all tiles in a render have same scale)
    // Fall back to valid tier from getTargetScaleTier if no tiles
    const { tier: fallbackTileScale } = getTargetScaleTier(zoom, this.config.pixelRatio);
    const tileScale = tiles.length > 0 ? tiles[0].tile.scale : fallbackTileScale;

    // Calculate bounding box of tiles being rendered
    // This allows viewport-only rendering: canvas sized to visible tiles, not full page
    // TILE SIZE FIX: Use getTileSize() to match adaptive tile sizing in tile calculations.
    // When useAdaptiveTileSize is enabled, tiles are 512px, not 256px (TILE_SIZE constant).
    const actualTileSize = getTileSize(zoom);
    const pdfTileSize = actualTileSize / tileScale;
    let minTileX = Infinity, minTileY = Infinity, maxTileX = -Infinity, maxTileY = -Infinity;
    for (const { tile } of tiles) {
      minTileX = Math.min(minTileX, tile.tileX);
      minTileY = Math.min(minTileY, tile.tileY);
      maxTileX = Math.max(maxTileX, tile.tileX);
      maxTileY = Math.max(maxTileY, tile.tileY);
    }

    // Calculate tile bounding box in PDF coordinates
    // CRITICAL FIX: Clamp bounds to page dimensions to prevent negative canvas sizes at high zoom.
    // At 16x zoom, tile coordinates can exceed page bounds (e.g., tileBoundsY=1312 > pdfHeight=666),
    // which caused pdfHeight - tileBoundsY to go negative → canvas height -20672 → blank tiles.
    const rawTileBoundsX = minTileX * pdfTileSize;
    const rawTileBoundsY = minTileY * pdfTileSize;
    const tileBoundsX = Math.max(0, Math.min(rawTileBoundsX, pdfWidth));
    const tileBoundsY = Math.max(0, Math.min(rawTileBoundsY, pdfHeight));
    const tileBoundsWidth = Math.max(0, Math.min((maxTileX - minTileX + 1) * pdfTileSize, pdfWidth - tileBoundsX));
    const tileBoundsHeight = Math.max(0, Math.min((maxTileY - minTileY + 1) * pdfTileSize, pdfHeight - tileBoundsY));

    // Guard: Skip if all tiles are outside page bounds (zero-size result)
    if (tileBoundsWidth <= 0 || tileBoundsHeight <= 0) {
      console.warn(`[PdfPageElement] Skipping render: invalid tile bounds ${tileBoundsWidth.toFixed(1)}x${tileBoundsHeight.toFixed(1)} (tiles outside page)`);
      return;
    }

    // Check if we're rendering full page or viewport-only
    const isViewportOnly = minTileX > 0 || minTileY > 0 ||
                           (maxTileX + 1) * pdfTileSize < pdfWidth - pdfTileSize ||
                           (maxTileY + 1) * pdfTileSize < pdfHeight - pdfTileSize;

    // CRITICAL FIX FOR VIEWPORT-ONLY RENDERING:
    // When rendering only visible tiles, size canvas to tile bounds, not full page.
    // This prevents huge canvases with sparse content at high zoom.
    let canvasWidth: number, canvasHeight: number;
    let canvasOffsetX = 0, canvasOffsetY = 0;

    if (isViewportOnly && tiles.length > 0) {
      // Viewport-only: canvas sized to tile bounds
      canvasWidth = Math.ceil(tileBoundsWidth * tileScale);
      canvasHeight = Math.ceil(tileBoundsHeight * tileScale);
      canvasOffsetX = tileBoundsX;  // PDF coordinate offset
      canvasOffsetY = tileBoundsY;
      console.log(`[PdfPageElement] Viewport-only render: bounds=${tileBoundsX.toFixed(1)},${tileBoundsY.toFixed(1)} ${tileBoundsWidth.toFixed(1)}x${tileBoundsHeight.toFixed(1)}, canvas=${canvasWidth}x${canvasHeight}`);
    } else {
      // Full page: canvas sized to full PDF dimensions
      canvasWidth = Math.ceil(pdfWidth * tileScale);
      canvasHeight = Math.ceil(pdfHeight * tileScale);
    }

    // DOUBLE-BUFFERING: Use offscreen canvas to prevent blank flash during resize
    // When canvas dimensions change, resizing clears content. By drawing to an
    // offscreen buffer first, we can update the visible canvas atomically.
    const needsResize = this.canvas.width !== canvasWidth || this.canvas.height !== canvasHeight;

    // REUSABLE OFFSCREEN CANVAS: Create lazily, resize as needed
    // This reduces GC pressure by reusing the same canvas across renders
    // instead of creating a new canvas element on every renderTiles() call.
    // At 16x zoom with scale 32, canvas can be ~20K×25K pixels - avoiding
    // repeated allocation/deallocation of this size buffer is significant.
    const needsOffscreenResize =
      !this.offscreenCanvas ||
      this.offscreenCanvas.width !== canvasWidth ||
      this.offscreenCanvas.height !== canvasHeight;

    if (needsOffscreenResize) {
      // Lazy creation or resize - only allocate when dimensions change
      if (!this.offscreenCanvas) {
        this.offscreenCanvas = document.createElement('canvas');
      }
      this.offscreenCanvas.width = canvasWidth;
      this.offscreenCanvas.height = canvasHeight;
      // Context needs to be recreated after canvas resize
      this.offscreenCtx = this.offscreenCanvas.getContext('2d');
    }

    const offCtx = this.offscreenCtx!;

    // Clear previous content (important when reusing canvas)
    offCtx.clearRect(0, 0, canvasWidth, canvasHeight);

    // Configure offscreen context
    offCtx.imageSmoothingEnabled = true;
    offCtx.imageSmoothingQuality = 'high';

    // Draw each tile at its correct position (1:1 with tile resolution)
    // Each tile covers (TILE_SIZE / tileScale) PDF points and is TILE_SIZE pixels
    // For viewport-only rendering, positions are relative to canvasOffsetX/Y
    for (const { tile, bitmap } of tiles) {
      // Position in PDF coordinates (absolute page position)
      const tilePdfX = tile.tileX * pdfTileSize;
      const tilePdfY = tile.tileY * pdfTileSize;

      // Canvas position: relative to canvas origin (which may be offset for viewport-only)
      const canvasX = Math.round((tilePdfX - canvasOffsetX) * tile.scale);
      const canvasY = Math.round((tilePdfY - canvasOffsetY) * tile.scale);

      // Calculate next tile position to determine exact draw size (eliminates gaps at page edges)
      const nextPdfX = (tile.tileX + 1) * pdfTileSize;
      const nextPdfY = (tile.tileY + 1) * pdfTileSize;
      const nextCanvasX = Math.round((Math.min(nextPdfX, pdfWidth) - canvasOffsetX) * tile.scale);
      const nextCanvasY = Math.round((Math.min(nextPdfY, pdfHeight) - canvasOffsetY) * tile.scale);

      // Draw size: difference between positions (usually 256, smaller at page edges)
      const drawWidth = nextCanvasX - canvasX;
      const drawHeight = nextCanvasY - canvasY;

      // Skip tiles with zero size (can happen at page edges)
      if (drawWidth <= 0 || drawHeight <= 0) {
        bitmap.close();
        continue;
      }

      // Draw bitmap to offscreen canvas at 1:1 scale
      offCtx.drawImage(
        bitmap,
        canvasX,
        canvasY,
        drawWidth,
        drawHeight
      );

      // Close bitmap to free memory - we own it (created fresh from cache)
      bitmap.close();
    }

    // DEBUG: Log tiles drawn
    console.log(`[PdfPageElement] Drew ${tiles.length} tiles to offscreen canvas ${canvasWidth}x${canvasHeight}`);

    // Now atomically update the visible canvas
    // Resize main canvas if needed (this clears it, but we immediately redraw)
    if (needsResize) {
      this.canvas.width = canvasWidth;
      this.canvas.height = canvasHeight;
    }

    // CSS display size and positioning
    // For viewport-only rendering, canvas covers only visible tiles and is positioned at offset
    // For full-page rendering, canvas covers the entire page

    // UNIFIED COORDINATE SPACE: Simplified tile positioning
    // In unified space, page elements are already at their final zoomed size.
    // Tiles are positioned exactly without CSS scale transforms.
    const useUnifiedSpace = isFeatureEnabled('useUnifiedCoordinateSpace');

    if (useUnifiedSpace) {
      // UNIFIED: Direct tile positioning without cssStretch
      // Canvas covers visible tiles and is positioned at exact offset
      const dpr = window.devicePixelRatio || 2;

      // In unified space:
      // - Page is at final size (this.finalWidth × this.finalHeight or currentWidth × currentHeight)
      // - Canvas buffer size = tile bounds in pixels
      // - CSS size = buffer / dpr for sharp rendering
      // - Position = tile bounds offset scaled to page element coordinates

      // Calculate position in page element coordinates
      // Note: In unified space, page element is sized to zoom * PDF dimensions
      // So we scale from PDF coordinates to page element coordinates
      const pageToElementScale = this.currentWidth / pdfWidth;
      const elementOffsetX = canvasOffsetX * pageToElementScale;
      const elementOffsetY = canvasOffsetY * pageToElementScale;

      // CSS size for sharp rendering (buffer / dpr)
      const cssWidth = canvasWidth / dpr;
      const cssHeight = canvasHeight / dpr;

      // The tile bounds in element coordinates
      const elementBoundsWidth = tileBoundsWidth * pageToElementScale;
      const elementBoundsHeight = tileBoundsHeight * pageToElementScale;

      // Scale to fit CSS-sized canvas into element bounds
      // Calculate both X and Y scale to verify aspect ratio preservation
      const scaleX = elementBoundsWidth / cssWidth;
      const scaleY = elementBoundsHeight / cssHeight;

      // Verify aspect ratio matches (within tolerance for floating-point precision)
      if (Math.abs(scaleX - scaleY) > 0.01) {
        console.warn(`[PdfPageElement:UNIFIED] Aspect ratio mismatch: scaleX=${scaleX.toFixed(4)}, scaleY=${scaleY.toFixed(4)}`);
      }

      // Use uniform scale (prefer width-based as it's consistent with legacy path)
      const fitScale = scaleX;

      this.canvas.style.width = `${cssWidth}px`;
      this.canvas.style.height = `${cssHeight}px`;
      this.canvas.style.transform = `translate(${elementOffsetX}px, ${elementOffsetY}px) scale(${fitScale})`;
      this.canvas.style.transformOrigin = '0 0';

      // No cssStretch tracking in unified space
      this.currentCssStretch = 1;

      console.log(`[PdfPageElement:UNIFIED] buffer=${canvasWidth}×${canvasHeight}, css=${cssWidth.toFixed(1)}×${cssHeight.toFixed(1)}, fitScale=${fitScale.toFixed(4)}, offset=${elementOffsetX.toFixed(1)},${elementOffsetY.toFixed(1)}`);
    } else {
      // LEGACY: cssStretch-based positioning
      // Calculate average cssStretch for compensating fallback tile resolution
      // cssStretch > 1 means using a lower-res fallback tile (needs scale-up to match layout)
      // cssStretch < 1 means using a higher-res tile (rare, during scale tier transitions)
      let avgCssStretch = tiles.reduce((sum, t) => sum + (t.cssStretch ?? 1), 0) / tiles.length;

      // Defensive validation: guard against invalid cssStretch values (NaN, Infinity, 0, negative)
      if (!isFinite(avgCssStretch) || avgCssStretch <= 0) {
        console.warn(`[PdfPageElement] Invalid avgCssStretch: ${avgCssStretch}, defaulting to 1`);
        avgCssStretch = 1;
      }

      // Track current cssStretch for render pipeline debugging
      const previousStretch = this.currentCssStretch;
      this.currentCssStretch = avgCssStretch;

      // Record cssStretch change for debugging the zoom bump
      const coordDebugger = getCoordinateDebugger();
      if (coordDebugger.isEnabled() && Math.abs(avgCssStretch - previousStretch) > 0.001) {
        const tileScales = tiles.map(t => t.tile.scale);
        const uniqueScales = [...new Set(tileScales)];
        coordDebugger.recordCssStretchChange({
          page: this.config.pageNumber,
          previousStretch,
          newStretch: avgCssStretch,
          tileScales: uniqueScales,
          requestedScale: tiles[0]?.tile.scale ?? 1,
        });
      }

      if (isViewportOnly) {
      // VIEWPORT-ONLY: Canvas covers only visible tiles, positioned at offset
      //
      // SHARPNESS FIX: Apply same DPR-based sizing as full-page rendering.
      // The canvas buffer (e.g., 1024×768) should map 1:1 to device pixels for crisp rendering.
      // Without this fix, the canvas gets a tiny CSS size (58×43px) causing extreme blur
      // when the buffer is stretched to fit.
      //
      // Strategy:
      // 1. CSS size = buffer / DPR (ensures 1:1 device pixel mapping)
      // 2. Transform: translate to position + scale to fit the layout slot
      // 3. Camera zoom handles final display scaling

      const dpr = window.devicePixelRatio || 2;
      const cssWidth = canvasWidth / dpr;
      const cssHeight = canvasHeight / dpr;

      // Calculate the PDF bounds this canvas covers, in layout coordinates (at zoom=1)
      const pdfToElementScale = this.currentWidth / pdfWidth;
      const layoutBoundsWidth = tileBoundsWidth * pdfToElementScale;
      const layoutBoundsHeight = tileBoundsHeight * pdfToElementScale;

      // Scale factor to fit the DPR-sized CSS canvas into the layout bounds
      const fitScale = layoutBoundsWidth / cssWidth;

      // Position within page element coordinate system
      const cssOffsetX = Math.floor(canvasOffsetX * pdfToElementScale);
      const cssOffsetY = Math.floor(canvasOffsetY * pdfToElementScale);

      this.canvas.style.width = `${cssWidth}px`;
      this.canvas.style.height = `${cssHeight}px`;
      // ZOOM BUMP FIX: Do NOT include cssStretch in the transform.
      // Previously: scale(fitScale × cssStretch) caused visual jumps when cssStretch changed
      // (e.g., 2.0 → 1.0 = 50% size change when exact tiles replace fallback tiles).
      // Now: scale(fitScale) only - fallback tiles appear pixelated but correctly positioned.
      // This eliminates the visual "bump" at the cost of temporary pixelation during zoom.
      const transformStr = `translate(${cssOffsetX}px, ${cssOffsetY}px) scale(${fitScale})`;
      this.canvas.style.transform = transformStr;
      this.canvas.style.transformOrigin = '0 0';

      // Record transform application for debugging the zoom bump
      coordDebugger.recordTransformApply({
        page: this.config.pageNumber,
        transform: transformStr,
        cssStretch: avgCssStretch,
        fitScale,
        offsetX: cssOffsetX,
        offsetY: cssOffsetY,
      });

      console.log(`[PdfPageElement] Viewport-only CSS: buffer=${canvasWidth}×${canvasHeight}, css=${cssWidth.toFixed(1)}×${cssHeight.toFixed(1)}, fitScale=${fitScale.toFixed(4)}, cssStretch=${avgCssStretch.toFixed(3)}, offset=${cssOffsetX},${cssOffsetY}`);
    } else {
      // FULL-PAGE: Canvas uses buffer-proportional CSS size for crisp rendering
      //
      // SHARPNESS FIX: When canvas buffer >> CSS size, browser downscales
      // with interpolation, causing blur. Fix: set CSS size = buffer / DPR,
      // then scale to fit layout slot. This ensures buffer pixels match
      // device pixels (1:1 for crisp rendering), then transform scales
      // without quality loss.
      //
      // Example at 16x zoom with DPR 2:
      //   - Buffer: 19,584px (612 × 32)
      //   - CSS: 9,792px (19,584 / 2) = 1:1 with device pixels
      //   - Transform: scale(0.0408) to fit 400px layout slot
      //   - Camera zoom: 16x scales 400px → 6,400px final display
      //   - Final ratio: 19,584 / 6,400 = 3.06 buffer per screen pixel (crisp!)
      const dpr = window.devicePixelRatio || 2;
      const cssWidth = canvasWidth / dpr;
      const cssHeight = canvasHeight / dpr;

      // Scale factor to fit the high-res CSS size into the layout slot
      const fitScale = this.currentWidth / cssWidth;

      this.canvas.style.width = `${cssWidth}px`;
      this.canvas.style.height = `${cssHeight}px`;
      // ZOOM BUMP FIX: Do NOT include cssStretch in the transform.
      // Previously: scale(fitScale × cssStretch) caused visual jumps when cssStretch changed.
      // Now: scale(fitScale) only - fallback tiles appear pixelated but correctly positioned.
      //
      // TRANSITION FIX: Always use translate(0, 0) even for full-page rendering.
      // This ensures CSS transitions between full-page and viewport-only modes
      // can smoothly interpolate the translate values instead of jumping.
      const transformStr = `translate(0px, 0px) scale(${fitScale})`;
      this.canvas.style.transform = transformStr;
      this.canvas.style.transformOrigin = '0 0';

      // Record transform application for debugging the zoom bump
      coordDebugger.recordTransformApply({
        page: this.config.pageNumber,
        transform: transformStr,
        cssStretch: avgCssStretch,
        fitScale,
        offsetX: 0,
        offsetY: 0,
      });
      }
    } // End of LEGACY else block

    // Copy offscreen buffer to visible canvas in one operation
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(this.offscreenCanvas!, 0, 0);

    // Render text layer if available
    if (textLayerData) {
      this.renderTextLayer(textLayerData, zoom);
    }

    this.isRendered = true;

    // Track render time and scale
    const renderTime = performance.now() - startTime;
    telemetry.trackRenderTime(renderTime, 'tile');

    // Track render scale (use first tile's scale as representative)
    if (tiles.length > 0) {
      telemetry.trackRenderScale(tiles[0].tile.scale, 'tile');
    }

    // Apply reading mode styles now that we have content
    this.applyReadingModeStyles();
  }

  /**
   * Render canvas from image blob
   *
   * Canvas Buffer Strategy:
   * - Canvas is sized to display size × DPR (capped at 2048px for performance)
   * - High-res image from server is drawn scaled to fit canvas buffer
   * - Browser handles high-quality downsampling during drawImage
   * - This prevents massive 20+ megapixel canvases that cause:
   *   - Slow rendering (250ms+ per page)
   *   - GPU memory exhaustion
   *   - Limited page virtualization
   *
   * Performance optimization: Uses worker pool for image decoding when available.
   * This moves createImageBitmap off the main thread for smoother scrolling.
   */
  private async renderCanvas(imageBlob: Blob): Promise<void> {
    // Clear CSS placeholder before drawing actual content
    this.clearPlaceholder();

    const pool = getCanvasPool();

    try {
      // Try to use worker pool for off-main-thread image decoding
      if (pool.isAvailable()) {
        const result = await pool.processImage(
          imageBlob,
          this.currentWidth,
          this.currentHeight,
          this.config.pageNumber
        );

        // Use the actual image dimensions for sharp rendering
        // The request scale cap in pdf-infinite-canvas ensures we don't fetch
        // unnecessarily large images, so use whatever resolution we receive
        this.canvas.width = result.naturalWidth;
        this.canvas.height = result.naturalHeight;

        // SHARPNESS FIX: Set CSS size = buffer / DPR to prevent browser downscaling
        // Then use transform to fit the layout slot
        const dpr = window.devicePixelRatio || 2;
        const cssWidth = result.naturalWidth / dpr;
        const cssHeight = result.naturalHeight / dpr;
        const fitScale = this.currentWidth / cssWidth;

        this.canvas.style.width = `${cssWidth}px`;
        this.canvas.style.height = `${cssHeight}px`;
        this.canvas.style.transform = `scale(${fitScale})`;
        this.canvas.style.transformOrigin = '0 0';

        // Reset transform and draw at native resolution
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';

        this.ctx.clearRect(0, 0, result.naturalWidth, result.naturalHeight);
        this.ctx.drawImage(result.imageBitmap, 0, 0);

        // Close the ImageBitmap to free memory
        result.imageBitmap.close();
        return;
      }
    } catch (error) {
      console.warn('[PdfPageElement] Worker pool failed, falling back:', error);
    }

    // Fallback: main thread rendering
    await this.renderCanvasFallback(imageBlob);
  }

  /**
   * Fallback canvas rendering on main thread
   * Used when worker pool is not available
   */
  private async renderCanvasFallback(imageBlob: Blob): Promise<void> {
    const imageUrl = URL.createObjectURL(imageBlob);
    const image = new Image();

    return new Promise((resolve, reject) => {
      image.onload = () => {
        try {
          // Use actual image dimensions for sharp rendering
          // Request scale capping ensures we don't fetch unnecessarily large images
          this.canvas.width = image.naturalWidth;
          this.canvas.height = image.naturalHeight;

          // SHARPNESS FIX: Set CSS size = buffer / DPR to prevent browser downscaling
          // Then use transform to fit the layout slot
          const dpr = window.devicePixelRatio || 2;
          const cssWidth = image.naturalWidth / dpr;
          const cssHeight = image.naturalHeight / dpr;
          const fitScale = this.currentWidth / cssWidth;

          this.canvas.style.width = `${cssWidth}px`;
          this.canvas.style.height = `${cssHeight}px`;
          this.canvas.style.transform = `scale(${fitScale})`;
          this.canvas.style.transformOrigin = '0 0';

          // Reset transform and draw at native resolution
          this.ctx.setTransform(1, 0, 0, 1, 0, 0);
          this.ctx.imageSmoothingEnabled = true;
          this.ctx.imageSmoothingQuality = 'high';

          this.ctx.clearRect(0, 0, image.naturalWidth, image.naturalHeight);
          this.ctx.drawImage(image, 0, 0);

          URL.revokeObjectURL(imageUrl);
          resolve();
        } catch (error) {
          URL.revokeObjectURL(imageUrl);
          reject(error);
        }
      };

      image.onerror = () => {
        URL.revokeObjectURL(imageUrl);
        reject(new Error('Failed to load page image'));
      };

      image.src = imageUrl;
    });
  }

  /**
   * Render text layer for selection
   * Uses SVG text layer for vector-crisp rendering when available,
   * falls back to HTML text layer otherwise.
   */
  private renderTextLayer(data: TextLayerData, scale: number): void {
    // Store text layer data for smart copy
    this.textLayerData = data;

    if (!data.items || data.items.length === 0) return;

    // Use SVG text layer if available (vector-crisp at any zoom)
    if (this.svgTextLayer) {
      this.svgTextLayer.renderFromTextData(data, this.currentWidth, this.currentHeight, scale);
      return;
    }

    // Fallback: HTML text layer
    this.textLayerEl.innerHTML = '';

    // Use page dimensions from data instead of hardcoded values
    const pageWidth = data.width || 612;  // Fallback to US Letter
    const pageHeight = data.height || 792;

    for (const item of data.items) {
      if (!item.text || item.text.trim() === '') continue;

      const span = document.createElement('span');
      span.textContent = item.text;

      // Position based on text item coordinates
      // Scale from PDF coordinates to display coordinates
      const left = (item.x / pageWidth) * this.currentWidth;
      const top = (item.y / pageHeight) * this.currentHeight;
      const fontSize = Math.max(8, (item.height / pageHeight) * this.currentHeight);

      span.style.cssText = `
        position: absolute;
        left: ${left}px;
        top: ${top}px;
        font-size: ${fontSize}px;
        font-family: sans-serif;
        white-space: pre;
        transform-origin: 0 0;
        color: transparent;
      `;

      this.textLayerEl.appendChild(span);
    }
  }

  /**
   * Setup selection listener
   */
  private setupSelectionListener(): void {
    this.textLayerEl.addEventListener('mouseup', () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;

      const text = selection.toString().trim();
      if (!text) return;

      const rects = this.getSelectionRects();
      if (rects.length > 0 && this.onSelectionCallback) {
        this.onSelectionCallback(this.config.pageNumber, text, rects);
      }
    });
  }

  /**
   * Get selection rects relative to container
   */
  private getSelectionRects(): DOMRect[] {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return [];

    const range = selection.getRangeAt(0);
    const clientRects = range.getClientRects();
    const containerRect = this.container.getBoundingClientRect();

    const rects: DOMRect[] = [];
    for (let i = 0; i < clientRects.length; i++) {
      const rect = clientRects[i];
      rects.push(new DOMRect(
        rect.left - containerRect.left,
        rect.top - containerRect.top,
        rect.width,
        rect.height
      ));
    }

    return rects;
  }

  /**
   * Set selection callback
   */
  setOnSelection(callback: (page: number, text: string, rects: DOMRect[]) => void): void {
    this.onSelectionCallback = callback;
  }

  /**
   * Setup copy handler for smart copy
   * Intercepts Ctrl+C/Cmd+C to provide Markdown-formatted text
   */
  private setupCopyHandler(): void {
    this.container.addEventListener('copy', (event: ClipboardEvent) => {
      if (!this.smartCopyEnabled || !this.textLayerData) return;

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;

      const selectedText = selection.toString().trim();
      if (!selectedText) return;

      // Prevent default copy behavior
      event.preventDefault();

      // For now, use the selected text directly as the primary content
      // The smart copy with formatting detection is available via getTextAsMarkdown()
      // when the selection spans the entire visible text and charPositions are available
      const plainText = selectedText;

      // Try to get markdown if we have the full data with charPositions
      let markdown = selectedText;
      if (this.textLayerData.items.some(item => item.charPositions && item.charPositions.length > 0)) {
        // We have char positions - use full markdown extraction
        // Note: This gives formatted output for the visible items
        markdown = extractAsMarkdown(this.textLayerData);
      }

      // Simple HTML escaping for selected text
      const html = selectedText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');

      // Set clipboard data with multiple formats
      if (event.clipboardData) {
        event.clipboardData.setData('text/plain', plainText);
        event.clipboardData.setData('text/markdown', markdown);
        event.clipboardData.setData('text/html', html);
      }
    });
  }

  /**
   * Enable or disable smart copy
   */
  setSmartCopyEnabled(enabled: boolean): void {
    this.smartCopyEnabled = enabled;
  }

  /**
   * Get the current text layer data as Markdown
   */
  getTextAsMarkdown(): string {
    if (!this.textLayerData) return '';
    return extractAsMarkdown(this.textLayerData);
  }

  /**
   * Get the current text layer data as plain text
   */
  getTextAsPlainText(): string {
    if (!this.textLayerData) return '';
    return extractAsPlainText(this.textLayerData);
  }

  /**
   * Set highlights for this page
   */
  setHighlights(highlights: PageHighlight[]): void {
    this.annotationLayerEl.innerHTML = '';

    for (const highlight of highlights) {
      for (const rect of highlight.rects) {
        const el = document.createElement('div');
        el.className = 'pdf-highlight';
        el.dataset.annotationId = highlight.annotationId;

        // Scale rect from normalized (0-1) to display coordinates
        const left = rect.x * this.currentWidth;
        const top = rect.y * this.currentHeight;
        const width = rect.width * this.currentWidth;
        const height = rect.height * this.currentHeight;

        el.style.cssText = `
          position: absolute;
          left: ${left}px;
          top: ${top}px;
          width: ${width}px;
          height: ${height}px;
          background: ${this.getHighlightColor(highlight.color)};
          pointer-events: auto;
          cursor: pointer;
          mix-blend-mode: multiply;
        `;

        el.addEventListener('click', (e) => {
          if (this.onHighlightClickCallback) {
            this.onHighlightClickCallback(highlight.annotationId, {
              x: e.clientX,
              y: e.clientY,
            });
          }
        });

        this.annotationLayerEl.appendChild(el);
      }
    }
  }

  /**
   * Set highlight click callback
   */
  setOnHighlightClick(callback: (annotationId: string, position: { x: number; y: number }) => void): void {
    this.onHighlightClickCallback = callback;
  }

  /**
   * Get highlight color CSS value
   */
  private getHighlightColor(color: HighlightColor): string {
    const colors: Record<HighlightColor, string> = {
      yellow: 'rgba(255, 235, 59, 0.4)',
      green: 'rgba(76, 175, 80, 0.4)',
      blue: 'rgba(33, 150, 243, 0.4)',
      pink: 'rgba(233, 30, 99, 0.4)',
      purple: 'rgba(156, 39, 176, 0.4)',
      orange: 'rgba(255, 152, 0, 0.4)',
    };
    return colors[color] || colors.yellow;
  }

  /**
   * Set reading mode (applies CSS filters for theme)
   */
  setReadingMode(mode: ReadingMode): void {
    this.currentReadingMode = mode;
    this.applyReadingModeStyles();
  }

  /**
   * Apply reading mode styles to container and canvas
   *
   * Supports two dark mode implementations:
   * 1. CSS filters (default): Fast, slightly degrades sharpness measurements
   * 2. HSL lightness inversion: Preserves anti-aliasing, requires canvas manipulation
   *
   * HSL mode can be enabled with setHslDarkMode(true).
   */
  private applyReadingModeStyles(): void {
    // Handle reflow mode separately
    if (this.currentRenderMode === 'reflow') {
      this.applyReflowReadingMode();
      return;
    }

    // Check if we need dark mode
    const needsDark = this.currentReadingMode === 'dark' ||
                      this.currentReadingMode === 'night' ||
                      (this.currentReadingMode === 'device' && document.body.classList.contains('theme-dark'));

    // Use HSL lightness inversion if enabled and dark mode is needed
    if (this.useHslDarkMode && needsDark && this.isRendered) {
      this.applyHslDarkModeInternal();
      return;
    }

    // Default: CSS filter approach
    switch (this.currentReadingMode) {
      case 'device':
        // Match Obsidian theme - detect from body class
        const isDark = document.body.classList.contains('theme-dark');
        if (isDark) {
          this.canvas.style.filter = 'invert(0.9) hue-rotate(180deg)';
          this.container.style.background = '#1e1e1e';
        } else {
          this.canvas.style.filter = 'none';
          this.container.style.background = 'white';
        }
        break;
      case 'light':
        // Pure light mode - slight brightness boost
        this.canvas.style.filter = 'brightness(1.02)';
        this.container.style.background = 'white';
        break;
      case 'sepia':
        // Warm sepia tone - easy on eyes
        this.canvas.style.filter = 'sepia(0.25) brightness(0.98)';
        this.container.style.background = '#f4ecd8';
        break;
      case 'dark':
        // Inverted colors for dark mode
        this.canvas.style.filter = 'invert(0.9) hue-rotate(180deg)';
        this.container.style.background = '#1e1e1e';
        break;
      case 'night':
        // Dark with warm tint - reduced blue light
        this.canvas.style.filter = 'invert(0.85) hue-rotate(180deg) sepia(0.2)';
        this.container.style.background = '#1a1a1a';
        break;
      default:
        // Fallback to light
        this.canvas.style.filter = 'none';
        this.container.style.background = 'white';
        break;
    }
  }

  /**
   * Apply HSL lightness inversion dark mode to canvas
   * This method preserves anti-aliasing better than CSS filters
   */
  private applyHslDarkModeInternal(): void {
    if (!this.darkModeRenderer) {
      this.darkModeRenderer = new DarkModeRenderer();
    }

    // Remove any CSS filter first
    this.canvas.style.filter = 'none';
    this.container.style.background = this.currentReadingMode === 'night' ? '#1a1a1a' : '#1e1e1e';

    // Apply HSL lightness inversion
    const success = this.darkModeRenderer.applyHslDarkMode(this.canvas);
    if (!success) {
      // Fallback to CSS filter if HSL processing fails
      this.canvas.style.filter = 'invert(0.9) hue-rotate(180deg)';
    }
  }

  /**
   * Enable or disable smart dark mode
   * When enabled, dark/night modes will preserve images from inversion
   */
  setSmartDarkMode(enabled: boolean): void {
    this.useSmartDarkMode = enabled;
    if (enabled && !this.darkModeRenderer) {
      this.darkModeRenderer = new DarkModeRenderer({
        preserveImages: true,
        imageSensitivity: 0.3,
      });
    }
    // Re-apply current reading mode with new setting
    if (this.currentReadingMode === 'dark' || this.currentReadingMode === 'night') {
      this.applyReadingModeStyles();
    }
  }

  /**
   * Enable or disable HSL lightness inversion for dark mode
   *
   * When enabled, uses canvas-based HSL lightness inversion instead of CSS filters.
   * This approach:
   * - Preserves anti-aliasing better (no sharpness degradation from CSS filters)
   * - Maintains hue and saturation (colors stay recognizable)
   * - Is more computationally expensive (processes every pixel)
   *
   * CSS filters are faster but can slightly degrade sharpness measurement.
   * HSL inversion maintains sharpness but requires canvas manipulation.
   */
  setHslDarkMode(enabled: boolean): void {
    this.useHslDarkMode = enabled;
    if (enabled && !this.darkModeRenderer) {
      this.darkModeRenderer = new DarkModeRenderer();
    }
    // Re-apply current reading mode with new setting
    if (this.currentReadingMode === 'dark' || this.currentReadingMode === 'night' ||
        (this.currentReadingMode === 'device' && document.body.classList.contains('theme-dark'))) {
      this.applyReadingModeStyles();
    }
  }

  /**
   * Check if HSL dark mode is enabled
   */
  isHslDarkModeEnabled(): boolean {
    return this.useHslDarkMode;
  }

  /**
   * Apply smart dark mode to the current canvas
   * Returns immediately for CSS mode, or waits for canvas processing
   */
  async applySmartDarkMode(): Promise<void> {
    if (!this.darkModeRenderer || !this.useSmartDarkMode) return;

    // Apply dark mode with image preservation
    const success = this.darkModeRenderer.applyCanvasDarkMode(this.canvas);
    this.container.style.background = '#1e1e1e';

    if (success) {
      this.canvas.style.filter = 'none'; // Remove CSS filter since we processed canvas
      this.smartDarkModeApplied = true;
    } else {
      // CSS fallback was applied by the renderer
      this.smartDarkModeApplied = false;
    }
  }

  /**
   * Remove smart dark mode from the current canvas
   * Note: This doesn't restore the original image; it just clears the flag.
   * A re-render is required to get the original light-mode appearance.
   */
  removeSmartDarkMode(): void {
    this.smartDarkModeApplied = false;
    this.canvas.style.filter = '';
    this.container.style.background = 'white';
  }

  /**
   * Check if the current page likely contains images
   * Useful for deciding between CSS and canvas dark mode
   */
  async hasImages(blob: Blob): Promise<boolean> {
    if (!this.darkModeRenderer) {
      this.darkModeRenderer = new DarkModeRenderer();
    }
    return this.darkModeRenderer.detectImages(blob);
  }

  /**
   * Set render mode (page view or reflow view)
   */
  setRenderMode(mode: RenderMode): void {
    if (this.currentRenderMode === mode) return;

    this.currentRenderMode = mode;

    if (mode === 'reflow') {
      // Show reflow layer, hide canvas layers
      this.canvas.style.display = 'none';
      this.textLayerEl.style.display = 'none';
      this.reflowLayerEl.style.display = 'block';

      // Render reflow content if we have text data
      if (this.textLayerData) {
        this.renderReflow();
      }
    } else {
      // Show canvas layers, hide reflow layer
      this.canvas.style.display = 'block';
      this.textLayerEl.style.display = 'block';
      this.reflowLayerEl.style.display = 'none';
    }

    // Apply reading mode styles to the appropriate layer
    this.applyReadingModeStyles();
  }

  /**
   * Get current render mode
   */
  getRenderMode(): RenderMode {
    return this.currentRenderMode;
  }

  /**
   * Configure reflow renderer settings
   */
  setReflowConfig(config: ReflowConfig): void {
    if (!this.reflowRenderer) {
      this.reflowRenderer = new MobileReflowRenderer(config);
    } else {
      this.reflowRenderer.setConfig(config);
    }

    // Re-render if in reflow mode
    if (this.currentRenderMode === 'reflow' && this.textLayerData) {
      this.renderReflow();
    }
  }

  /**
   * Render content in reflow mode
   */
  private renderReflow(): void {
    if (!this.textLayerData) {
      this.reflowLayerEl.innerHTML = '<div class="reflow-empty">No text content available</div>';
      return;
    }

    // Create renderer if needed
    if (!this.reflowRenderer) {
      this.reflowRenderer = new MobileReflowRenderer();
    }

    // Inject styles if not already present
    this.injectReflowStyles();

    // Render the reflowed content
    this.reflowLayerEl.innerHTML = this.reflowRenderer.renderPage(this.textLayerData);

    // Apply reading mode to reflow content
    this.applyReflowReadingMode();
  }

  /**
   * Inject reflow CSS styles into the container
   */
  private injectReflowStyles(): void {
    const styleId = 'pdf-reflow-styles';
    if (this.container.querySelector(`#${styleId}`)) return;

    if (!this.reflowRenderer) {
      this.reflowRenderer = new MobileReflowRenderer();
    }

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = this.reflowRenderer.getStyles();
    this.container.appendChild(style);
  }

  /**
   * Apply reading mode to reflow layer
   */
  private applyReflowReadingMode(): void {
    switch (this.currentReadingMode) {
      case 'device':
        const isDark = document.body.classList.contains('theme-dark');
        if (isDark) {
          this.reflowLayerEl.style.background = '#1e1e1e';
          this.reflowLayerEl.style.color = '#e0e0e0';
        } else {
          this.reflowLayerEl.style.background = 'white';
          this.reflowLayerEl.style.color = '#333';
        }
        break;
      case 'light':
        this.reflowLayerEl.style.background = 'white';
        this.reflowLayerEl.style.color = '#333';
        break;
      case 'sepia':
        this.reflowLayerEl.style.background = '#f4ecd8';
        this.reflowLayerEl.style.color = '#5b4636';
        break;
      case 'dark':
        this.reflowLayerEl.style.background = '#1e1e1e';
        this.reflowLayerEl.style.color = '#e0e0e0';
        break;
      case 'night':
        this.reflowLayerEl.style.background = '#1a1a1a';
        this.reflowLayerEl.style.color = '#c9b99a';
        break;
      default:
        this.reflowLayerEl.style.background = 'white';
        this.reflowLayerEl.style.color = '#333';
        break;
    }
  }

  /**
   * Get the reflowed HTML content (for external use)
   */
  getReflowedHtml(): string {
    if (!this.textLayerData) return '';

    if (!this.reflowRenderer) {
      this.reflowRenderer = new MobileReflowRenderer();
    }

    return this.reflowRenderer.renderPage(this.textLayerData);
  }

  /**
   * Show loading state
   * Note: Placeholder is already shown by setDimensions(), so we just add
   * the loading class for CSS-based loading indicators (e.g., spinner overlay)
   */
  showLoading(): void {
    this.container.classList.add('pdf-page-loading');
    // The placeholder is already drawn by setDimensions() - no need to redraw
    // This prevents flickering during the render cycle
  }

  /**
   * Hide loading state
   */
  hideLoading(): void {
    this.container.classList.remove('pdf-page-loading');
  }

  /**
   * Clear rendered content
   */
  clear(): void {
    this.ctx.clearRect(0, 0, this.currentWidth, this.currentHeight);
    this.textLayerEl.innerHTML = '';
    this.annotationLayerEl.innerHTML = '';
    this.reflowLayerEl.innerHTML = '';
    this.isRendered = false;
    this.smartDarkModeApplied = false;

    // Clear SVG text layer
    if (this.svgTextLayer) {
      this.svgTextLayer.clear();
    }
  }

  /**
   * Destroy element
   */
  destroy(): void {
    this.clear();

    // Destroy SVG text layer
    if (this.svgTextLayer) {
      this.svgTextLayer.destroy();
      this.svgTextLayer = null;
    }

    // Release offscreen canvas to free GPU memory
    if (this.offscreenCanvas) {
      // Set dimensions to 0 to release GPU resources
      this.offscreenCanvas.width = 0;
      this.offscreenCanvas.height = 0;
      this.offscreenCanvas = null;
      this.offscreenCtx = null;
    }

    this.container.remove();
  }

  /**
   * Get selection from SVG text layer (if using SVG)
   */
  getSvgSelection(): { text: string; page: number; rects: DOMRect[] } | null {
    return this.svgTextLayer?.getSelection() ?? null;
  }

  /**
   * Toggle SVG text layer debug mode
   */
  setTextLayerDebug(debug: boolean): void {
    if (this.svgTextLayer) {
      this.svgTextLayer.setDebug(debug);
    }
  }
}
