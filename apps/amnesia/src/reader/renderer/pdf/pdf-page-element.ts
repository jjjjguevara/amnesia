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
  /**
   * Native PDF page dimensions in points (e.g., 612×792 for letter).
   * Used as fallback for tile coordinate calculations when pdfDimensions
   * is not provided to renderTiles(). This prevents coordinate system
   * mismatch when CSS pixel dimensions are used by mistake.
   */
  pdfDimensions?: { width: number; height: number };
}

export interface PageHighlight {
  id: string;
  annotationId: string;
  color: HighlightColor;
  rects: Array<{ x: number; y: number; width: number; height: number }>;
}

/**
 * Transform snapshot captured at tile REQUEST time.
 * 
 * Tiles take 100-300ms to render in workers. During this time, zoom may change,
 * causing container dimensions to change. If we calculate transforms at DISPLAY
 * time using current dimensions, the result will be wrong for tiles rendered
 * for the previous dimensions.
 * 
 * Solution: Capture all transform-relevant values at REQUEST time and use
 * these snapshot values at DISPLAY time.
 * 
 * @property containerWidth - Container width at request time
 * @property containerHeight - Container height at request time
 * @property pdfToElementScale - Scale from PDF to element coordinates at request time
 * @property epoch - Zoom epoch for validating tile staleness
 */
export interface TransformSnapshot {
  /** Container width at tile request time */
  containerWidth: number;
  /** Container height at tile request time */
  containerHeight: number;
  /** Scale from PDF to element coordinates: containerWidth / pdfWidth */
  pdfToElementScale: number;
  /** Zoom epoch from ZoomStateManager - used to detect stale tiles */
  epoch: number;
}

/**
 * Individual PDF page element with all layers
 */
export class PdfPageElement {
  // DIAGNOSTIC: Global render sequence counter to track render ordering
  private static renderSequence = 0;

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

  // DOUBLE-BUFFERING: Snapshot element for smooth mode transitions
  // During full-page→tiled transitions, we capture the current canvas as an image
  // and display it while new tiles render. This eliminates the "blank flash" that
  // occurs when the canvas is hidden during mode transitions.
  // PERF FIX: Use canvas instead of img for transition snapshot.
  // drawImage() is a fast GPU copy (~1ms) vs toDataURL() which is CPU-bound (~100ms+).
  private transitionSnapshot: HTMLCanvasElement | null = null;

  private config: Required<PdfPageElementConfig>;
  private currentWidth = 0;
  private currentHeight = 0;

  // Native PDF dimensions in points (e.g., 612×792 for letter).
  // Used as fallback for tile coordinate calculations when pdfDimensions
  // parameter is not provided to renderTiles().
  private storedPdfDimensions: { width: number; height: number } | null = null;
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
      // Note: pdfDimensions is stored separately in storedPdfDimensions
      pdfDimensions: config.pdfDimensions ?? { width: 0, height: 0 }, // Default empty, real value in storedPdfDimensions
    };

    // Store PDF dimensions for tile coordinate fallback
    if (config.pdfDimensions) {
      this.storedPdfDimensions = { ...config.pdfDimensions };
    }

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
      overflow: visible;
      flex-shrink: 0;
    `;

    // Create canvas
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pdf-page-canvas';
    // GPU COMPOSITING: Add will-change and translateZ(0) for GPU layer promotion.
    // This ensures individual page canvases are composited on the GPU during zoom,
    // preventing expensive software compositing and enabling 60fps performance.
    this.canvas.style.cssText = `
      display: block;
      width: 100%;
      height: 100%;
      will-change: transform;
      transform: translateZ(0);
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
   * Enable or disable CSS transitions on the canvas transform.
   * Used to smoothly animate mode transitions.
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
   * Get current container width.
   * DRIFT FIX: Used to capture snapshot at tile request time.
   */
  getCurrentWidth(): number {
    return this.currentWidth;
  }

  /**
   * Get current container height.
   * DRIFT FIX: Used to capture snapshot at tile request time.
   */
  getCurrentHeight(): number {
    return this.currentHeight;
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
    // H1 FIX: Round dimensions to integers for pixel-perfect alignment.
    // This ensures container and canvas dimensions match exactly.
    const roundedWidth = Math.round(width);
    const roundedHeight = Math.round(height);

    this.currentWidth = roundedWidth;
    this.currentHeight = roundedHeight;

    this.container.style.width = `${roundedWidth}px`;
    this.container.style.height = `${roundedHeight}px`;

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
    // H1 FIX: Round dimensions to integers for pixel-perfect alignment.
    // This ensures container and canvas dimensions match exactly.
    const roundedWidth = Math.round(finalWidth);
    const roundedHeight = Math.round(finalHeight);

    this.finalWidth = roundedWidth;
    this.finalHeight = roundedHeight;
    this.currentZoom = zoom;

    // Set DOM element size to final zoomed dimensions
    this.container.style.width = `${roundedWidth}px`;
    this.container.style.height = `${roundedHeight}px`;

    // Update internal tracking (currentWidth/Height used by rendering)
    this.currentWidth = roundedWidth;
    this.currentHeight = roundedHeight;

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
      // H1 FIX: Use Math.round() for CSS dimensions to match integer canvas buffer dimensions.
      this.canvas.style.width = `${Math.round(finalWidth)}px`;
      this.canvas.style.height = `${Math.round(finalHeight)}px`;

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
   * Set native PDF page dimensions in points.
   * Used as fallback for tile coordinate calculations when pdfDimensions
   * parameter is not provided to renderTiles().
   */
  setPdfDimensions(width: number, height: number): void {
    this.storedPdfDimensions = { width, height };
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
    // H1 FIX: Use Math.round() for CSS dimensions to match integer canvas buffer dimensions.
    this.canvas.style.width = `${Math.round(this.currentWidth)}px`;
    this.canvas.style.height = `${Math.round(this.currentHeight)}px`;
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

    // Show canvas after render (may have been hidden during mode transition)
    this.showCanvas();

    // DOUBLE-BUFFERING: Remove transition snapshot now that new content is displayed.
    // This completes the atomic swap - old content (snapshot) is replaced by new content (canvas).
    this.clearTransitionSnapshot();

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
    pdfDimensions?: { width: number; height: number },
    /**
     * DRIFT FIX: Transform snapshot captured at tile REQUEST time.
     *
     * Tiles take 100-300ms to render in workers. During this time, zoom may change,
     * causing container dimensions to change. Using current dimensions at DISPLAY time
     * (for fitScale, pdfToElementScale calculations) when tiles were rendered for
     * REQUEST time dimensions causes visual drift.
     *
     * Solution: Capture all transform-relevant values at REQUEST time (TransformSnapshot)
     * and use those values at DISPLAY time.
     *
     * The epoch field allows validation: if current epoch !== snapshot.epoch,
     * the zoom has changed since request and tiles may be stale.
     */
    transformSnapshot?: TransformSnapshot,
    /**
     * EPOCH VALIDATION: Current render epoch from the caller (pdf-infinite-canvas.renderVersion).
     *
     * When provided, validates that transformSnapshot.epoch matches currentEpoch.
     * If mismatch detected (zoom changed since tile request), falls back to current
     * dimensions instead of potentially stale snapshot dimensions.
     */
    currentEpoch?: number,
    /**
     * FORCE FULL PAGE FIX: When true, always use full-page canvas sizing regardless
     * of how many tiles were actually received.
     *
     * During mode transition (full-page → tiled), getPageTileGrid() generates ALL
     * tiles for the page. However, continuous zooming causes epoch changes that
     * abort some tile renders. Only partial tiles reach renderTiles(), causing the
     * isViewportOnly check to incorrectly size the canvas smaller than the full page.
     *
     * When forceFullPage=true (set during mode transition), we skip the isViewportOnly
     * check and always use full-page dimensions, preventing blank areas.
     */
    forceFullPage?: boolean
  ): Promise<void> {
    const startTime = performance.now();
    const telemetry = getTelemetry();

    // === TILE-RECEIVE-DEBUG === Log what tiles renderTiles actually receives
    const renderSeq = ++PdfPageElement.renderSequence;
    if (zoom >= 4 && tiles.length > 0) {
      const tileXs = tiles.map(t => t.tile.tileX);
      const tileYs = tiles.map(t => t.tile.tileY);
      const minX = Math.min(...tileXs), maxX = Math.max(...tileXs);
      const minY = Math.min(...tileYs), maxY = Math.max(...tileYs);
      console.error(`[TILE-RECEIVE] seq=${renderSeq} page=${this.config.pageNumber} zoom=${zoom.toFixed(2)} tiles=${tiles.length}: X=[${minX}-${maxX}], Y=[${minY}-${maxY}], forceFullPage=${forceFullPage}`);
    }

    // DRIFT FIX: Use snapshot values (captured at request time) for CSS calculations.
    // The container may have resized during the 100-300ms render window.
    // Using current dimensions would cause position/size mismatch → visual drift.
    const usedSnapshot = transformSnapshot !== undefined;

    // EPOCH VALIDATION: Check if zoom has changed since tile request
    // If snapshot.epoch !== currentEpoch, the zoom level has changed during the
    // 100-300ms render window. In this case, the snapshot dimensions are stale
    // and we should fall back to current dimensions to prevent coordinate drift.
    const snapshotEpoch = transformSnapshot?.epoch ?? -1;
    const epochValid = currentEpoch === undefined ||
                       snapshotEpoch === -1 ||
                       snapshotEpoch === currentEpoch;

    // Use snapshot dimensions only if epoch is valid (no zoom change since request)
    // Fall back to current dimensions if epoch mismatch detected
    let effectiveWidth: number;
    let effectiveHeight: number;

    if (usedSnapshot && epochValid) {
      // Epoch matches - safe to use snapshot dimensions
      effectiveWidth = transformSnapshot!.containerWidth;
      effectiveHeight = transformSnapshot!.containerHeight;
    } else if (usedSnapshot && !epochValid) {
      // GRACEFUL DEGRADATION (amnesia-g8d): Skip stale tiles, keep existing content visible.
      // During rapid zoom gestures, epoch increments on every change, making in-flight
      // tiles stale by the time they complete. Instead of rejecting and showing blank:
      // 1. Close stale tile bitmaps (free memory)
      // 2. Keep existing canvas content visible (user sees something)
      // 3. Fresh tiles will be requested when gesture settles
      //
      // This matches iOS/macOS behavior: show degraded content while rendering,
      // rather than showing nothing.
      console.log(`[PDFPageElement] Skipping stale tiles (graceful degradation): epoch mismatch (snapshot.epoch=${snapshotEpoch}, currentEpoch=${currentEpoch})`);
      // Close all bitmaps to prevent memory leak
      for (const { bitmap } of tiles) {
        bitmap.close();
      }
      return; // Keep existing content visible - NO BLANK SCREENS
    } else {
      // No snapshot provided - use current dimensions
      effectiveWidth = this.currentWidth;
      effectiveHeight = this.currentHeight;
    }

    const dimMismatch = usedSnapshot && Math.abs(transformSnapshot!.containerWidth - this.currentWidth) > 1;
    console.log(`[TransformSnapshot] DISPLAY page=${this.config.pageNumber}: zoom=${zoom.toFixed(2)}, snapshot=${usedSnapshot ? `${transformSnapshot!.containerWidth.toFixed(0)}x${transformSnapshot!.containerHeight.toFixed(0)}, epoch=${snapshotEpoch}` : 'none'}, current=${this.currentWidth.toFixed(0)}x${this.currentHeight.toFixed(0)}, epochValid=${epochValid}, MISMATCH=${dimMismatch}`);

    // Guard: Return early if no tiles (prevents -Infinity in bounding box calculation)
    if (tiles.length === 0) {
      console.warn(`[PdfPageElement] renderTiles called with 0 tiles, skipping render`);
      return;
    }

    // Clear CSS placeholder before drawing actual content
    this.clearPlaceholder();

    // Get PDF dimensions for coordinate calculations.
    // CRITICAL: Use storedPdfDimensions (native PDF points, e.g., 612×792) as fallback,
    // NOT currentWidth/Height (CSS pixels, e.g., 400×518). Using CSS pixels as PDF
    // coordinates breaks tile calculations because tile coordinates are in PDF space.
    const pdfWidth = pdfDimensions?.width ?? this.storedPdfDimensions?.width ?? this.currentWidth;
    const pdfHeight = pdfDimensions?.height ?? this.storedPdfDimensions?.height ?? this.currentHeight;

    // Debug: Log when falling back to stored or CSS dimensions
    if (!pdfDimensions) {
      const source = this.storedPdfDimensions ? 'storedPdfDimensions' : 'currentWidth/Height (WARNING: CSS pixels!)';
      console.warn(`[PdfPageElement] renderTiles page=${this.config.pageNumber}: pdfDimensions not provided, using ${source}: ${pdfWidth}x${pdfHeight}`);
    }

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

    // DEFENSIVE BOUNDS CHECK: Filter out tiles with invalid indices before processing.
    // This catches tiles generated with mismatched tile sizes (e.g., 256px vs 512px grid).
    // Tiles with indices beyond page bounds would cause blank areas and rendering issues.
    const maxValidTileX = Math.ceil(pdfWidth / pdfTileSize);
    const maxValidTileY = Math.ceil(pdfHeight / pdfTileSize);
    const originalTileCount = tiles.length;
    const validTiles = tiles.filter(({ tile }) => {
      const isValid = tile.tileX >= 0 && tile.tileX < maxValidTileX &&
                      tile.tileY >= 0 && tile.tileY < maxValidTileY;
      if (!isValid) {
        console.warn(`[PdfPageElement] FILTERED invalid tile: page=${this.config.pageNumber}, ` +
          `tile=(${tile.tileX},${tile.tileY}), scale=${tile.scale}, ` +
          `maxValid=(${maxValidTileX},${maxValidTileY}), pdfTileSize=${pdfTileSize.toFixed(1)}, ` +
          `pdfSize=${pdfWidth.toFixed(1)}x${pdfHeight.toFixed(1)}`);
      }
      return isValid;
    });

    if (validTiles.length < originalTileCount) {
      console.warn(`[PdfPageElement] Filtered ${originalTileCount - validTiles.length}/${originalTileCount} invalid tiles`);
    }

    // Use filtered tiles for the rest of processing
    tiles = validTiles;

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

    // BLANK-AREA-DEBUG: Only log when there's a potential issue (bounds clamping or zero dimensions)
    const boundsIssue = rawTileBoundsY > pdfHeight || tileBoundsWidth <= 0 || tileBoundsHeight <= 0;
    if (boundsIssue) {
      console.warn(`[BLANK-AREA-DEBUG] page=${this.config.pageNumber}: tiles=${tiles.length}, tileIndices=[${minTileX}-${maxTileX}, ${minTileY}-${maxTileY}], ` +
        `pdfTileSize=${pdfTileSize.toFixed(1)}, scale=${tileScale}, rawBounds=(${rawTileBoundsX.toFixed(1)},${rawTileBoundsY.toFixed(1)}), ` +
        `clampedBounds=(${tileBoundsX.toFixed(1)},${tileBoundsY.toFixed(1)} ${tileBoundsWidth.toFixed(1)}x${tileBoundsHeight.toFixed(1)}), ` +
        `pdfSize=${pdfWidth.toFixed(1)}x${pdfHeight.toFixed(1)}, container=${this.currentWidth.toFixed(1)}x${this.currentHeight.toFixed(1)}`);
    }

    // Guard: If all tiles are outside page bounds (zero-size result), fall back to full page dimensions.
    // This can happen at extreme zoom levels when tile coordinates are calculated for regions
    // completely outside the visible page. Instead of returning (which leaves the page blank),
    // we reset bounds to cover the full page so at least something renders.
    let adjustedTileBoundsX = tileBoundsX;
    let adjustedTileBoundsY = tileBoundsY;
    let adjustedTileBoundsWidth = tileBoundsWidth;
    let adjustedTileBoundsHeight = tileBoundsHeight;
    let useContainerDimensionsDirectly = false;

    if (tileBoundsWidth <= 0 || tileBoundsHeight <= 0) {
      console.warn(`[PdfPageElement] Invalid tile bounds ${tileBoundsWidth.toFixed(1)}x${tileBoundsHeight.toFixed(1)} (tiles outside page), using container dimensions directly`);
      adjustedTileBoundsX = 0;
      adjustedTileBoundsY = 0;
      adjustedTileBoundsWidth = pdfWidth;
      adjustedTileBoundsHeight = pdfHeight;
      // Flag to use container dimensions directly in CSS sizing to avoid 1px rounding mismatch
      useContainerDimensionsDirectly = true;
    }

    // Check if we're rendering full page or viewport-only
    // FORCE FULL PAGE FIX: When forceFullPage=true (during mode transition), always
    // use full-page sizing even if received tiles don't cover the full page.
    // This prevents blank areas when some tiles are aborted during continuous zoom.
    const tilesNotCoveringFullPage = minTileX > 0 || minTileY > 0 ||
                           (maxTileX + 1) * pdfTileSize < pdfWidth - pdfTileSize ||
                           (maxTileY + 1) * pdfTileSize < pdfHeight - pdfTileSize;
    const isViewportOnly = tilesNotCoveringFullPage && !forceFullPage;

    if (forceFullPage && tilesNotCoveringFullPage) {
      console.log(`[PdfPageElement] forceFullPage=true but only got partial tiles (${tiles.length}), using full-page canvas sizing`);
    }

    // CRITICAL FIX FOR VIEWPORT-ONLY RENDERING:
    // When rendering only visible tiles, size canvas to tile bounds, not full page.
    // This prevents huge canvases with sparse content at high zoom.
    let canvasWidth: number, canvasHeight: number;
    let canvasOffsetX = 0, canvasOffsetY = 0;

    if (isViewportOnly && tiles.length > 0 && tileBoundsWidth > 0 && tileBoundsHeight > 0) {
      // Viewport-only: canvas sized to tile bounds (only if bounds are valid)
      canvasWidth = Math.ceil(adjustedTileBoundsWidth * tileScale);
      canvasHeight = Math.ceil(adjustedTileBoundsHeight * tileScale);
      canvasOffsetX = adjustedTileBoundsX;  // PDF coordinate offset
      canvasOffsetY = adjustedTileBoundsY;
      console.log(`[PdfPageElement] Viewport-only render: bounds=${adjustedTileBoundsX.toFixed(1)},${adjustedTileBoundsY.toFixed(1)} ${adjustedTileBoundsWidth.toFixed(1)}x${adjustedTileBoundsHeight.toFixed(1)}, canvas=${canvasWidth}x${canvasHeight}`);
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

    // PROGRESSIVE RENDERING FIX (2026-01-21): Instead of clearing the canvas,
    // PRESERVE existing content and draw tiles on top. This ensures:
    // 1. Base layer (full-page render from lower zoom) remains visible
    // 2. High-res tiles are drawn on top for crisp rendering
    // 3. If some tiles fail, existing content prevents blank areas
    //
    // This mimics iOS CATiledLayer behavior where lower-res content shows
    // while higher-res tiles load progressively.
    if (needsOffscreenResize) {
      // Canvas was just created or resized - start fresh
      offCtx.clearRect(0, 0, canvasWidth, canvasHeight);

      // Copy existing main canvas content if available and dimensions are compatible
      // This preserves the full-page render as a base layer
      if (this.canvas.width > 0 && this.canvas.height > 0 && this.isRendered) {
        try {
          // Scale existing content to fit new canvas dimensions
          offCtx.drawImage(this.canvas, 0, 0, canvasWidth, canvasHeight);
        } catch {
          // Ignore errors (e.g., if canvas is tainted or empty)
        }
      }
    } else {
      // Canvas same size - copy existing content from main canvas to preserve it
      // Then tiles will be drawn on top
      if (this.canvas.width === canvasWidth && this.canvas.height === canvasHeight && this.isRendered) {
        try {
          offCtx.drawImage(this.canvas, 0, 0);
        } catch {
          // Ignore errors - will just render tiles without base layer
          offCtx.clearRect(0, 0, canvasWidth, canvasHeight);
        }
      } else {
        offCtx.clearRect(0, 0, canvasWidth, canvasHeight);
      }
    }

    // Configure offscreen context
    offCtx.imageSmoothingEnabled = true;
    offCtx.imageSmoothingQuality = 'high';

    // Draw each tile at its correct position (1:1 with tile resolution)
    // Each tile covers (TILE_SIZE / tileScale) PDF points and is TILE_SIZE pixels
    // For viewport-only rendering, positions are relative to canvasOffsetX/Y
    let tilesDrawn = 0;
    let tilesSkippedOutOfBounds = 0;

    for (const { tile, bitmap } of tiles) {
      // Position in PDF coordinates (absolute page position)
      const tilePdfX = tile.tileX * pdfTileSize;
      const tilePdfY = tile.tileY * pdfTileSize;

      // Canvas position: relative to canvas origin (which may be offset for viewport-only)
      const canvasX = Math.round((tilePdfX - canvasOffsetX) * tile.scale);
      const canvasY = Math.round((tilePdfY - canvasOffsetY) * tile.scale);

      // OUT-OF-BOUNDS FIX: Skip tiles that would be drawn outside the canvas.
      // This can happen when tiles are calculated for regions outside the page
      // (detected by useContainerDimensionsDirectly=true). Even though we resize
      // the canvas to full page, tiles still have their original coordinates.
      if (canvasX >= canvasWidth || canvasY >= canvasHeight || canvasX < -4096 || canvasY < -4096) {
        // DIAGNOSTIC: Log first out-of-bounds tile to understand coordinate mismatch
        if (tilesSkippedOutOfBounds === 0) {
          console.warn(`[PdfPageElement] OUT-OF-BOUNDS tile: page=${this.config.pageNumber}, tile=(${tile.tileX},${tile.tileY}), scale=${tile.scale}, pdfTileSize=${pdfTileSize.toFixed(2)}, tilePdfX=${tilePdfX.toFixed(1)}, tilePdfY=${tilePdfY.toFixed(1)}, canvasOffset=(${canvasOffsetX.toFixed(1)},${canvasOffsetY.toFixed(1)}), canvasPos=(${canvasX},${canvasY}), canvasSize=${canvasWidth}x${canvasHeight}, pdfSize=${pdfWidth.toFixed(1)}x${pdfHeight.toFixed(1)}`);
        }
        bitmap.close();
        tilesSkippedOutOfBounds++;
        continue;
      }

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

      // COORDINATE DEBUG: Log first 3 tiles to trace positioning
      if (tilesDrawn < 3) {
        console.log(`[TILE-COORD-DEBUG] page=${this.config.pageNumber}, tile(${tile.tileX},${tile.tileY}): pdfPos=(${tilePdfX.toFixed(0)},${tilePdfY.toFixed(0)}), canvasPos=(${canvasX},${canvasY}), size=${drawWidth}x${drawHeight}, offset=(${canvasOffsetX.toFixed(0)},${canvasOffsetY.toFixed(0)})`);
      }

      // Close bitmap to free memory - we own it (created fresh from cache)
      bitmap.close();
      tilesDrawn++;
    }

    // DEBUG: Log tiles drawn with render sequence
    if (tilesSkippedOutOfBounds > 0) {
      console.error(`[TILE-DRAW] seq=${renderSeq} page=${this.config.pageNumber} Drew ${tilesDrawn}/${tiles.length} tiles, canvas=${canvasWidth}x${canvasHeight} (${tilesSkippedOutOfBounds} skipped: out of bounds), forceFullPage=${!isViewportOnly}`);
    } else {
      console.error(`[TILE-DRAW] seq=${renderSeq} page=${this.config.pageNumber} Drew ${tilesDrawn} tiles, canvas=${canvasWidth}x${canvasHeight}, forceFullPage=${!isViewportOnly}`);
    }

    // ALL-TILES-OUT-OF-BOUNDS FIX: If all tiles were skipped, throw an error
    // to trigger fallback to full-page rendering in the caller.
    // This can happen at extreme zoom when tile coordinates are calculated for
    // regions entirely outside the visible page.
    if (tilesDrawn === 0 && tiles.length > 0) {
      throw new Error(`[PdfPageElement] All ${tiles.length} tiles were out of bounds (skipped ${tilesSkippedOutOfBounds}). Need full-page fallback.`);
    }

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
    // NOTE: Unified space is disabled - use legacy mode.
    const useUnifiedSpace: boolean = false;

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
      // TRANSFORM SNAPSHOT FIX: Use pdfToElementScale from snapshot when available.
      const pageToElementScale = transformSnapshot?.pdfToElementScale ?? (effectiveWidth / pdfWidth);
      const elementOffsetX = canvasOffsetX * pageToElementScale;
      const elementOffsetY = canvasOffsetY * pageToElementScale;

      // CSS size for sharp rendering (buffer / dpr)
      const cssWidth = canvasWidth / dpr;
      const cssHeight = canvasHeight / dpr;

      // The tile bounds in element coordinates (use adjusted bounds for invalid tile edge case)
      let elementBoundsWidth = adjustedTileBoundsWidth * pageToElementScale;
      let elementBoundsHeight = adjustedTileBoundsHeight * pageToElementScale;

      // DIMENSION MATCH FIX: When bounds were invalid, use container dimensions directly.
      if (useContainerDimensionsDirectly) {
        elementBoundsWidth = this.currentWidth;
        elementBoundsHeight = this.currentHeight;
      }

      // Scale to fit CSS-sized canvas into element bounds
      // PAGE SCALE STABILITY FIX (Remediation Plan 2026-01-19):
      // UNIFIED mode: Canvas CSS size = tile bounds in element coordinates, NO scale transform.
      // The high-res buffer provides crisp pixels when camera zooms.

      this.canvas.style.width = `${elementBoundsWidth}px`;
      this.canvas.style.height = `${elementBoundsHeight}px`;
      this.canvas.style.transform = `translate(${elementOffsetX}px, ${elementOffsetY}px)`; // NO scale
      this.canvas.style.transformOrigin = '0 0';

      console.log(`[STABILITY-FIX] UNIFIED buffer=${canvasWidth}×${canvasHeight}, css=${elementBoundsWidth.toFixed(1)}×${elementBoundsHeight.toFixed(1)}, offset=${elementOffsetX.toFixed(1)},${elementOffsetY.toFixed(1)} (snapshot: ${usedSnapshot})`);
    } else {
      // LEGACY: Direct tile positioning (cssStretch tracking removed - amnesia-c7w)
      const coordDebugger = getCoordinateDebugger();

      if (isViewportOnly) {
      // VIEWPORT-ONLY: Canvas covers only visible tiles, positioned at offset
      //
      // PAGE SCALE STABILITY FIX (Remediation Plan 2026-01-19):
      // Eliminate fitScale CSS transform entirely. The camera transform is the ONLY zoom mechanism.
      //
      // Strategy:
      // 1. Canvas CSS size = tile bounds in page coordinates (FIXED relative to container)
      // 2. Canvas buffer = high resolution (provides crisp pixels when camera zooms)
      // 3. Transform = translate only (position within container, NO scale)
      // 4. Camera transform handles ALL visual zoom magnification
      //
      // This eliminates the "two transforms fighting" problem that caused focal point drift.

      // Calculate the tile bounds in page element coordinates
      // TRANSFORM SNAPSHOT FIX: Use pdfToElementScale from snapshot when available.
      // The snapshot captures this value at tile REQUEST time.
      // Using current dimensions (which may have changed during render) causes position mismatch.
      // Fall back to calculation from effectiveWidth for backwards compatibility.
      const pdfToElementScale = transformSnapshot?.pdfToElementScale ?? (effectiveWidth / pdfWidth);
      let layoutBoundsWidth = adjustedTileBoundsWidth * pdfToElementScale;
      let layoutBoundsHeight = adjustedTileBoundsHeight * pdfToElementScale;

      // DIMENSION MATCH FIX: When bounds were invalid (useContainerDimensionsDirectly=true),
      // use container dimensions directly to avoid 1px mismatch from PDF aspect ratio calculation.
      if (useContainerDimensionsDirectly) {
        layoutBoundsWidth = this.currentWidth;
        layoutBoundsHeight = this.currentHeight;
      }

      // Position within page element coordinate system
      const cssOffsetX = canvasOffsetX * pdfToElementScale;
      const cssOffsetY = canvasOffsetY * pdfToElementScale;

      // Canvas CSS size = tile bounds in page coordinates (FIXED, no fitScale)
      // The high-res buffer provides oversampling for crisp rendering when camera zooms
      // H1 FIX: Use Math.round() for CSS dimensions to match integer canvas buffer dimensions.
      this.canvas.style.width = `${Math.round(layoutBoundsWidth)}px`;
      this.canvas.style.height = `${Math.round(layoutBoundsHeight)}px`;

      // Transform = translate only (NO scale) - camera handles all zoom
      const transformStr = `translate(${cssOffsetX}px, ${cssOffsetY}px)`;
      this.canvas.style.transform = transformStr;
      this.canvas.style.transformOrigin = '0 0';

      // Record transform application for debugging (cssStretch removed - amnesia-c7w)
      coordDebugger.recordTransformApply({
        page: this.config.pageNumber,
        transform: transformStr,
        cssStretch: 1, // Always 1 in unified coordinate space
        fitScale: 1,
        offsetX: cssOffsetX,
        offsetY: cssOffsetY,
      });

      console.log(`[STABILITY-FIX] VIEWPORT page=${this.config.pageNumber}: cssSize=${layoutBoundsWidth.toFixed(1)}x${layoutBoundsHeight.toFixed(1)}, offset=${cssOffsetX.toFixed(1)},${cssOffsetY.toFixed(1)}, transform="${transformStr}" (NO scale)`);
    } else {
      // FULL-PAGE: Canvas CSS size = container size (FIXED), NO fitScale transform.
      // Canvas CSS size = container size (FIXED, no fitScale)
      // DRIFT FIX: Use effectiveWidth/Height (from snapshot) instead of this.currentWidth/Height
      // H1 FIX: Use Math.round() for CSS dimensions to match integer canvas buffer dimensions.
      // DIMENSION MATCH FIX: When bounds were invalid, use container dimensions directly.
      const finalWidth = useContainerDimensionsDirectly ? this.currentWidth : effectiveWidth;
      const finalHeight = useContainerDimensionsDirectly ? this.currentHeight : effectiveHeight;
      this.canvas.style.width = `${Math.round(finalWidth)}px`;
      this.canvas.style.height = `${Math.round(finalHeight)}px`;

      // Transform = translate only (NO scale) - camera handles all zoom
      const transformStr = `translate(0px, 0px)`;
      this.canvas.style.transform = transformStr;
      this.canvas.style.transformOrigin = '0 0';

      console.log(`[STABILITY-FIX] FULLPAGE page=${this.config.pageNumber}: cssSize=${effectiveWidth.toFixed(1)}x${effectiveHeight.toFixed(1)}, transform="${transformStr}" (snapshot: ${usedSnapshot})`);

      // Record transform application for debugging (cssStretch removed - amnesia-c7w)
      coordDebugger.recordTransformApply({
        page: this.config.pageNumber,
        transform: transformStr,
        cssStretch: 1, // Always 1 in unified coordinate space
        fitScale: 1,
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

    // Show canvas after render (may have been hidden during mode transition)
    this.showCanvas();

    // DOUBLE-BUFFERING: Remove transition snapshot now that new content is displayed.
    // This completes the atomic swap - old content (snapshot) is replaced by new content (canvas).
    this.clearTransitionSnapshot();

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

        // DIMENSION MATCH FIX: Use container dimensions directly for canvas CSS.
        // Previously we derived CSS from buffer aspect ratio, but MuPDF's dimension
        // capping (4096px max) creates slight aspect ratio differences:
        // - PDF aspect: 612/792 = 0.7727
        // - Buffer aspect: 3166/4096 = 0.7729
        //
        // This 0.02% difference causes Math.round to produce different values:
        // - Container: Math.round(400/0.7727) = 518
        // - Canvas: Math.round(400/0.7729) = 517
        //
        // The 1px gap causes visible clipping at the bottom of pages.
        //
        // FIX: Use container dimensions directly. The browser will scale the buffer
        // to fit the CSS dimensions. The <0.2% aspect ratio distortion is imperceptible,
        // but the 1px gap was very visible.
        const cssWidth = Math.round(this.currentWidth);
        const cssHeight = Math.round(this.currentHeight);
        const bufferAspectRatio = result.naturalWidth / result.naturalHeight;

        this.canvas.style.width = `${cssWidth}px`;
        this.canvas.style.height = `${cssHeight}px`;
        this.canvas.style.transform = ''; // NO scale transform - camera handles all zoom
        this.canvas.style.transformOrigin = '0 0';

        console.log(`[DIMENSION-MATCH-FIX] renderCanvas: canvasCss=${cssWidth}x${cssHeight}, containerCss=${this.currentWidth}x${this.currentHeight} (buffer ${result.naturalWidth}x${result.naturalHeight}, aspect=${bufferAspectRatio.toFixed(4)})`);

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

          // DIMENSION MATCH FIX: Use container dimensions directly for canvas CSS.
          // See renderCanvas() for full explanation of why this is needed.
          const cssWidth = Math.round(this.currentWidth);
          const cssHeight = Math.round(this.currentHeight);
          const bufferAspectRatio = image.naturalWidth / image.naturalHeight;

          this.canvas.style.width = `${cssWidth}px`;
          this.canvas.style.height = `${cssHeight}px`;
          this.canvas.style.transform = ''; // NO scale transform - camera handles all zoom
          this.canvas.style.transformOrigin = '0 0';

          console.log(`[DIMENSION-MATCH-FIX] renderCanvasFallback: canvasCss=${cssWidth}x${cssHeight}, containerCss=${this.currentWidth}x${this.currentHeight} (buffer ${image.naturalWidth}x${image.naturalHeight}, aspect=${bufferAspectRatio.toFixed(4)})`);

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
   * Prepare for full-page rendering by resetting canvas CSS to container size.
   *
   * PAGE SCALE STABILITY FIX: During mode transitions (tiled → full-page),
   * the old viewport-only canvas has CSS size = tile bounds and transform = translate(offset).
   * This causes visual jarring when camera zoom changes during the async render wait.
   *
   * By immediately resetting CSS to container size and clearing transform,
   * we ensure the canvas displays at correct proportions while waiting for the new render.
   */
  prepareForFullPageRender(): void {
    // GOLDEN FRAME LOG (Protocol C): Capture all dimension-related values for hypothesis debugging
    // This log is critical for diagnosing dimension mismatches during mode transitions
    const containerRect = this.container.getBoundingClientRect();
    const goldenFrameLog = {
      mode: 'tiled→full-page transition',
      page: this.config.pageNumber,
      camera: { zoom: this.currentZoom },
      // CSS dimensions from state (may be floats, rounded at source since H1 fix)
      cssWidth: this.currentWidth,
      cssHeight: this.currentHeight,
      // Container measurements (Protocol C recommended)
      containerBoundingRect: { w: containerRect.width, h: containerRect.height },
      containerOffset: { w: this.container.offsetWidth, h: this.container.offsetHeight },
      // Canvas buffer dimensions (integers via Math.ceil in renderTiles)
      canvasBuffer: { w: this.canvas.width, h: this.canvas.height },
      // Parsed CSS style dimensions
      canvasCss: {
        w: parseFloat(this.canvas.style.width) || this.currentWidth,
        h: parseFloat(this.canvas.style.height) || this.currentHeight,
      },
      // PDF coordinate system (native PDF points, e.g., 612×792)
      storedPdfDimensions: this.storedPdfDimensions,
      // Snapshot canvas dimensions (if exists)
      snapshotCanvas: this.transitionSnapshot
        ? { w: this.transitionSnapshot.width, h: this.transitionSnapshot.height }
        : null,
      // Delta between buffer and CSS (H1 hypothesis target - should be 0 after fix)
      heightDelta: this.canvas.height - (parseFloat(this.canvas.style.height) || this.currentHeight),
    };
    console.log('[GOLDEN-FRAME]', goldenFrameLog);

    // MODE TRANSITION FIX (amnesia-8jm): Use double-buffering for tiled→full-page transition.
    // The old viewport-only canvas buffer contains a small region of the page.
    // Instead of hiding with opacity:0 (which shows blank), we capture a snapshot
    // at the current CSS size/position, then change the canvas dimensions.
    // The snapshot stays visible until new render completes.

    // DOUBLE-BUFFERING: Capture current canvas content as a snapshot
    // This is the same approach used in prepareForTiledRender() for consistency
    if (this.canvas.width > 0 && this.canvas.height > 0) {
      if (!this.transitionSnapshot) {
        this.transitionSnapshot = document.createElement('canvas');
        this.transitionSnapshot.className = 'pdf-transition-snapshot';
        this.transitionSnapshot.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          pointer-events: none;
          z-index: 5;
        `;
      }

      // MODE TRANSITION STRETCH FIX: Don't copy viewport-only dimensions from tiled mode.
      // In tiled mode, canvas CSS size covers only visible tiles (e.g., 334px instead of 517px).
      // Copying these dimensions causes the snapshot to appear stretched when transitioning
      // to full-page mode where the container expects full page dimensions.
      //
      // Solution: Size the snapshot to match FULL page dimensions (currentWidth × currentHeight).
      // The tiled content (which may be partial) is positioned at its original offset within
      // the full-page-sized snapshot, preserving correct aspect ratio and position.

      // Get the original tiled canvas position (translate transform)
      const tiledTransform = this.canvas.style.transform;
      const tiledWidth = parseFloat(this.canvas.style.width) || this.currentWidth;
      const tiledHeight = parseFloat(this.canvas.style.height) || this.currentHeight;

      // Extract translate offset from tiled transform (if any)
      let offsetX = 0, offsetY = 0;
      const translateMatch = tiledTransform.match(/translate\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\)/);
      if (translateMatch) {
        offsetX = parseFloat(translateMatch[1]);
        offsetY = parseFloat(translateMatch[2]);
      }

      // Size snapshot to FULL page dimensions (not viewport-only)
      // H1 FIX: Use Math.round() for CSS dimensions to match integer canvas buffer dimensions.
      // This eliminates the 0.353px mismatch (e.g., 517.647 → 518) that causes mode transition stretch.
      this.transitionSnapshot.style.width = `${Math.round(this.currentWidth)}px`;
      this.transitionSnapshot.style.height = `${Math.round(this.currentHeight)}px`;
      this.transitionSnapshot.style.transform = '';
      this.transitionSnapshot.style.transformOrigin = '0 0';

      // Copy canvas content to snapshot at the correct position
      // Use full page buffer size to maintain aspect ratio
      const dpr = window.devicePixelRatio || 2;
      this.transitionSnapshot.width = Math.round(this.currentWidth * dpr);
      this.transitionSnapshot.height = Math.round(this.currentHeight * dpr);
      const snapshotCtx = this.transitionSnapshot.getContext('2d');
      if (snapshotCtx) {
        // Clear snapshot (transparent background)
        snapshotCtx.clearRect(0, 0, this.transitionSnapshot.width, this.transitionSnapshot.height);

        // Calculate where to draw the tiled content in the full-page snapshot
        // The tiled canvas covered a region starting at (offsetX, offsetY) in page coordinates
        // We need to draw it at the same relative position in the full-page snapshot
        const scaleX = this.transitionSnapshot.width / this.currentWidth;
        const scaleY = this.transitionSnapshot.height / this.currentHeight;
        const drawX = offsetX * scaleX;
        const drawY = offsetY * scaleY;

        // Calculate destination dimensions using CSS-to-buffer scaling
        // This ensures the tiled content is drawn at the correct size in the snapshot
        const drawWidth = tiledWidth * scaleX;
        const drawHeight = tiledHeight * scaleY;

        // H3 DIAGNOSTIC: Log aspect ratio info during mode transitions
        // The destination aspect should match the source CSS aspect (not buffer aspect)
        // because drawImage scales the source to fit the destination
        const sourceAspect = this.canvas.width / this.canvas.height;
        const destAspect = drawWidth / drawHeight;
        const cssAspect = tiledWidth / tiledHeight;
        console.log(`[H3-DIAG] Mode transition: srcBuf=${this.canvas.width}x${this.canvas.height} (aspect=${sourceAspect.toFixed(4)}), dest=${drawWidth.toFixed(0)}x${drawHeight.toFixed(0)} (aspect=${destAspect.toFixed(4)}), css=${tiledWidth.toFixed(0)}x${tiledHeight.toFixed(0)} (aspect=${cssAspect.toFixed(4)})`);

        // Draw the tiled content at its original position within the full-page snapshot
        snapshotCtx.drawImage(this.canvas, drawX, drawY, drawWidth, drawHeight);

        // Insert snapshot into container
        if (!this.transitionSnapshot.parentElement) {
          this.container.appendChild(this.transitionSnapshot);
        }
        console.log(`[MODE-TRANSITION] Captured snapshot for tiled→full-page transition, page=${this.config.pageNumber}, tiled=${tiledWidth.toFixed(0)}x${tiledHeight.toFixed(0)} at (${offsetX},${offsetY}), fullPage=${this.currentWidth}x${this.currentHeight.toFixed(0)}`);
      }
    }

    // Now hide the canvas and reset its CSS for full-page mode
    // H1 FIX: Use Math.round() for CSS dimensions to match integer canvas buffer dimensions.
    this.canvas.style.opacity = '0';
    this.canvas.style.width = `${Math.round(this.currentWidth)}px`;
    this.canvas.style.height = `${Math.round(this.currentHeight)}px`;
    this.canvas.style.transform = '';
    this.canvas.style.transformOrigin = '0 0';

    // Clear the isRendered flag so the page shows loading state
    this.isRendered = false;

    // Show loading indicator (behind snapshot)
    this.showLoading();

    console.log(`[STABILITY-FIX] prepareForFullPageRender: page=${this.config.pageNumber}, cssSize=${this.currentWidth}x${this.currentHeight} (snapshot visible until render completes)`);
  }

  /**
   * Prepare the canvas for tiled rendering (full-page → tiled transition).
   *
   * When transitioning from full-page to tiled mode, the canvas needs to be
   * reset so that incoming tiles can set their own viewport-only transforms.
   * Without this, the canvas CSS remains configured for full-page mode while
   * tiles render for viewport-only regions → tile clipping.
   *
   * DOUBLE-BUFFERING: Instead of hiding the canvas (which causes blank transitions),
   * we capture the current content as a snapshot image. This keeps the old content
   * visible while new tiles render, then the snapshot is removed when tiles are ready.
   *
   * This is the symmetric counterpart to prepareForFullPageRender() which
   * handles the tiled→full-page transition.
   */
  prepareForTiledRender(): void {
    // GOLDEN FRAME LOG (Protocol C): Capture dimensions at full-page→tiled transition
    const containerRect = this.container.getBoundingClientRect();
    const goldenFrameLog = {
      mode: 'full-page→tiled transition',
      page: this.config.pageNumber,
      camera: { zoom: this.currentZoom },
      cssWidth: this.currentWidth,
      cssHeight: this.currentHeight,
      containerBoundingRect: { w: containerRect.width, h: containerRect.height },
      containerOffset: { w: this.container.offsetWidth, h: this.container.offsetHeight },
      canvasBuffer: { w: this.canvas.width, h: this.canvas.height },
      canvasCss: {
        w: parseFloat(this.canvas.style.width) || this.currentWidth,
        h: parseFloat(this.canvas.style.height) || this.currentHeight,
      },
      storedPdfDimensions: this.storedPdfDimensions,
      snapshotCanvas: this.transitionSnapshot
        ? { w: this.transitionSnapshot.width, h: this.transitionSnapshot.height }
        : null,
      heightDelta: this.canvas.height - (parseFloat(this.canvas.style.height) || this.currentHeight),
    };
    console.log('[GOLDEN-FRAME]', goldenFrameLog);

    // DOUBLE-BUFFERING: Capture current canvas content as a snapshot canvas.
    // This keeps old content visible while new tiles render, eliminating blank flash.
    // The snapshot will be removed in renderTiles() when new content is ready.
    //
    // PERF FIX: Use drawImage() instead of toDataURL() for 100x speedup.
    // toDataURL() forces synchronous PNG encoding (100ms+), while drawImage()
    // is a fast GPU copy (~1ms). This eliminates jank during mode transitions.
    const startTime = performance.now();
    try {
      // Only create snapshot if canvas has content (removed isRendered check - race condition)
      if (this.canvas.width > 0 && this.canvas.height > 0) {
        // Create or reuse snapshot canvas element
        if (!this.transitionSnapshot) {
          this.transitionSnapshot = document.createElement('canvas');
          this.transitionSnapshot.className = 'pdf-transition-snapshot';
          this.transitionSnapshot.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            pointer-events: none;
            z-index: 5;
          `;
        }

        // FAST SNAPSHOT: Use drawImage for GPU-accelerated copy
        // This is ~100x faster than toDataURL() which does CPU PNG encoding
        this.transitionSnapshot.width = this.canvas.width;
        this.transitionSnapshot.height = this.canvas.height;
        const ctx = this.transitionSnapshot.getContext('2d');
        if (ctx) {
          ctx.drawImage(this.canvas, 0, 0);
        }

        // Match canvas CSS dimensions and transform
        this.transitionSnapshot.style.width = this.canvas.style.width;
        this.transitionSnapshot.style.height = this.canvas.style.height;
        this.transitionSnapshot.style.transform = this.canvas.style.transform || '';
        this.transitionSnapshot.style.transformOrigin = this.canvas.style.transformOrigin || '0 0';

        // Add to container if not already present
        if (!this.transitionSnapshot.parentElement) {
          this.container.appendChild(this.transitionSnapshot);
        }

        const elapsed = performance.now() - startTime;
        console.log(`[DOUBLE-BUFFER] Created transition snapshot: page=${this.config.pageNumber}, size=${this.canvas.width}x${this.canvas.height}, time=${elapsed.toFixed(1)}ms`);
      }
    } catch (e) {
      // Snapshot creation failed (e.g., tainted canvas) - fall back to hiding
      console.warn(`[DOUBLE-BUFFER] Snapshot creation failed: ${e}, falling back to hide`);
      this.canvas.style.opacity = '0';
    }

    // Reset transform to base state (tiles will set their own transforms)
    this.canvas.style.transform = '';
    this.canvas.style.transformOrigin = '0 0';

    // Mark as needing re-render
    this.isRendered = false;

    // Note: We don't hide the canvas anymore - the snapshot covers it
    // We also don't show loading indicator since snapshot provides visual continuity

    console.log(`[STABILITY-FIX] prepareForTiledRender: page=${this.config.pageNumber} (snapshot preserves old content)`);
  }

  /**
   * Remove the transition snapshot after new content is rendered.
   * Called by renderTiles() when tiles are successfully composited.
   */
  private clearTransitionSnapshot(): void {
    if (this.transitionSnapshot) {
      // Fade out for smoother transition (optional, can remove for instant swap)
      this.transitionSnapshot.remove();
      console.log(`[DOUBLE-BUFFER] Removed transition snapshot: page=${this.config.pageNumber}`);
    }
  }

  /**
   * Show the canvas after render completes
   */
  showCanvas(): void {
    this.canvas.style.opacity = '1';
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

    // Clean up transition snapshot
    if (this.transitionSnapshot) {
      this.transitionSnapshot.remove();
      this.transitionSnapshot = null;
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
